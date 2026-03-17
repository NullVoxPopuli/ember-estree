/**
 * The Strategy:
 *
 * 1. parse out the <template>...</template> regions
 *    - we haven't shipped "content-tag" through TC39, so for now, gjs and gts are invalid JavaScript
 *
 * 2. create a new string/contents of the file with a placeholder for the template regions
 *    - this will be used later to splice in the Template AST Nodes
 *    - the placeholder should be the same dimensions as the template region
 *
 * 3. parse the string/contents as js/ts to generate an ESTree (pluggable JS parser)
 *
 * 4. parse each template region to generate an AST from that
 *
 * 5. convert the AST from `@glimmer/syntax` to ESTree
 *    - NOTE: it may already be ESTree
 *
 * 6. splice in the template ESTrees into the JS/TS ESTree
 *
 * 7. Done
 */

/**
 * Docs for dependencies:
 * - https://github.com/embroider-build/content-tag/
 */

import { parseSync } from "oxc-parser";
import { Preprocessor } from "content-tag";

import {
  DocumentLines,
  buildGlimmerVisitorKeys,
  preprocessTemplates,
  processGlimmerTemplateFromSource,
} from "./transforms.js";

const preprocessor = new Preprocessor();

/**
 * @param {string} source
 * @param {object} options
 * @param {string} [options.filePath] - Path to the file being parsed
 * @param {Function} [options.jsParser] - Custom JS parser: (placeholderJS, filename) => { ast, tokens?, comments?, ... }
 * @param {Function} [options.visitor] - Called for each node during the merge walk: (path) => void
 * @return {object} A File-like AST with a `.program` property (plus any extra properties from jsParser)
 */
export function toTree(source, options = {}) {
  let parseResults = preprocessor.parse(source);
  let js = toPlaceholderJS(source, parseResults);
  let filename = options.filePath || "input.ts";

  // Pluggable JS parser — default to oxc-parser
  let jsResult;
  if (options.jsParser) {
    jsResult = options.jsParser(js, filename);
  } else {
    let oxcResult = parseSync(filename, js);
    jsResult = {
      ast: oxcResult.program,
      comments: oxcResult.comments || [],
    };
  }

  // Normalize: jsResult.ast is the Program node
  const program = jsResult.ast;



  // Wrap in a File-like node to match the expected structure
  let outerAST = {
    type: "File",
    program,
    comments: program.comments || jsResult.comments || [],
    start: program.start,
    end: program.end,
  };

  // Process all Glimmer templates in one pass
  const { templateInfos } = preprocessTemplates(parseResults, source);
  const templateByStart = new Map(templateInfos.map((t) => [t.utf16Range[0], t]));

  // Splice processed Glimmer templates into the JS AST, normalize positions,
  // splice tokens/comments, and call visitor.
  // Uses a BFS walk with explicit key tracking to avoid circular references
  // that some parsers (TS-ESLint) set on nodes.
  const docLines = new DocumentLines(source);
  const visitor = options.visitor;
  const skipKeys = new Set(["parent", "loc", "range", "tokens", "comments", "leadingComments", "trailingComments", "innerComments"]);
  const visited = new Set();
  const queue = [{ node: outerAST, parentPath: null }];

  while (queue.length > 0) {
    const { node, parentPath } = queue.shift();
    if (!node || typeof node !== "object" || !node.type || visited.has(node)) continue;
    visited.add(node);

    const currentPath = { node, parent: parentPath?.node || null, parentKey: null, parentPath };

    // Normalize start/end/range/loc
    if (node.range && typeof node.start !== "number") {
      node.start = node.range[0];
      node.end = node.range[1];
    }
    if (typeof node.start === "number" && typeof node.end === "number") {
      if (!node.range) node.range = [node.start, node.end];
      if (!node.loc) {
        node.loc = {
          start: docLines.offsetToPosition(node.start),
          end: docLines.offsetToPosition(node.end),
        };
      }
    }

    // Check if this is a template placeholder and splice it
    if (isTemplatePlaceholder(node, templateByStart)) {
      const nodeStart = node.start ?? node.range?.[0];
      const tpl = templateByStart.get(nodeStart);
      const ast = tpl.ast;

      // Replace the placeholder node in its parent
      if (parentPath) {
        for (const key of Object.keys(parentPath.node)) {
          if (skipKeys.has(key)) continue;
          const val = parentPath.node[key];
          if (val === node) {
            parentPath.node[key] = ast;
          } else if (Array.isArray(val)) {
            const idx = val.indexOf(node);
            if (idx >= 0) val[idx] = ast;
          }
        }
      }

      // Splice Glimmer tokens into the JS token stream
      if (program.tokens && ast.tokens) {
        const firstIdx = program.tokens.findIndex((t) => t.range[0] === tpl.utf16Range[0]);
        const lastIdx = program.tokens.findIndex((t) => t.range[1] === tpl.utf16Range[1]);
        if (firstIdx >= 0 && lastIdx >= 0) {
          program.tokens.splice(firstIdx, lastIdx - firstIdx + 1, ...ast.tokens);
        }
      }

      // Merge Glimmer comments
      if (ast.comments?.length) {
        (program.comments || outerAST.comments || []).push(...ast.comments);
      }

      // Call visitor for Glimmer subtree with JS parent context
      if (visitor) {
        walkGlimmerNodes(ast, visitor, parentPath);
      }

      continue; // Don't traverse into the old placeholder children
    }

    // Traverse children
    for (const key of Object.keys(node)) {
      if (skipKeys.has(key)) continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === "object" && item.type) {
            queue.push({ node: item, parentPath: currentPath });
          }
        }
      } else if (val && typeof val === "object" && val.type) {
        queue.push({ node: val, parentPath: currentPath });
      }
    }
  }

  // Build result — preserve all jsParser properties (scopeManager, services, visitorKeys, etc.)
  const result = { ...jsResult, ...outerAST };
  // Don't double-nest ast
  delete result.ast;
  return result;
}

/**
 * Parse Ember .gjs/.gts source code into an ESTree-compatible AST
 * with embedded Glimmer template nodes.
 *
 * @param {string} source - The source code to parse
 * @param {object} [options] - Parse options
 * @return {object} The ESTree-compatible AST
 */
export function parse(source, options = {}) {
  return toTree(source, options);
}

/**
 * Parse a standalone template string (e.g. .hbs file content) into
 * a GlimmerTemplate AST node with tokens and comments.
 *
 * @param {string} source - The raw template content
 * @param {object} [options] - Parse options
 * @returns {object} A GlimmerTemplate AST node with .tokens and .comments
 */
export function parseTemplate(source, options = {}) {
  return processGlimmerTemplateFromSource(source, {
    contentOffset: 0,
    contentEnd: source.length,
    templateRange: [0, source.length],
    source,
  });
}

//////////////////////////////////////////////////
//
// Helpers
//
//////////////////////////////////////////////////


/**
 * Check if a node is a template placeholder by matching its start position
 * against known template ranges. Supports both `start` (oxc-parser) and
 * `range[0]` (TS-ESLint/Babel) styles.
 */
function isTemplatePlaceholder(node, templateByStart) {
  if (node.type !== "TemplateLiteral" && node.type !== "StaticBlock") return false;
  const nodeStart = node.start ?? node.range?.[0];
  return nodeStart != null && templateByStart.has(nodeStart);
}

/**
 * Walk all nodes in a Glimmer AST subtree, calling the visitor for each.
 * Uses the Glimmer visitor keys to properly traverse children.
 * @param {object} root - The Glimmer template AST root
 * @param {Function} visitor - Called for each node with path context
 * @param {object|null} jsParentPath - Parent path from the JS AST for scope chain connectivity
 */
function walkGlimmerNodes(root, visitor, jsParentPath) {
  const keys = buildGlimmerVisitorKeys();
  const queue = [{ node: root, parent: jsParentPath?.node || null, parentKey: null, parentPath: jsParentPath }];

  while (queue.length > 0) {
    const path = queue.pop();
    visitor(path);

    const nodeKeys = keys[path.node.type];
    if (!nodeKeys) continue;

    for (const key of nodeKeys) {
      const child = path.node[key];
      if (!child) continue;

      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && item.type) {
            queue.push({ node: item, parent: path.node, parentKey: key, parentPath: path });
          }
        }
      } else if (typeof child === "object" && child.type) {
        queue.push({ node: child, parent: path.node, parentKey: key, parentPath: path });
      }
    }
  }
}

/**
 * Replaces <template>...</template> regions in source with
 * placeholder expressions of the same character length that
 * are valid JavaScript, so any JS parser can parse them.
 *
 * Expression templates become:  `content + padding`
 * Class member templates become: static{`content + padding`}
 *
 * Padding with spaces maintains exact source length.
 *
 * @param {string} source
 * @param {Array<object>} parseResults
 * @returns {string}
 */
function toPlaceholderJS(source, parseResults) {
  let result = source;

  // Process in reverse order so offsets stay valid
  for (const pr of [...parseResults].reverse()) {
    const start = pr.range.startUtf16Codepoint;
    const end = pr.range.endUtf16Codepoint;
    const content = pr.contents.replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const tplLength = end - start;

    let openTag, closeTag;
    if (pr.type === "class-member") {
      openTag = "static{`";
      closeTag = "`}";
    } else {
      openTag = "`";
      closeTag = "`";
    }

    const padding = " ".repeat(tplLength - content.length - openTag.length - closeTag.length);
    const replacement = openTag + content + padding + closeTag;

    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}
