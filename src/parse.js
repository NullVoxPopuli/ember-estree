/**
 * The Strategy:
 *
 * 1. parse out the <template>...</template> regions (content-tag)
 * 2. create placeholder JS for the template regions (backtick/static-block, same char length)
 * 3. parse as js/ts — default: oxc-parser, or a custom parser via options
 * 4. splice in processed Glimmer ASTs, invoking visitors during traversal
 * 5. Merge Glimmer visitor keys into the result
 * 6. Done
 */

import { parseSync } from "oxc-parser";
import { Preprocessor } from "content-tag";
import { walk } from "zimmerframe";

import { processTemplate, DocumentLines, glimmerVisitorKeys } from "./transforms.js";

const preprocessor = new Preprocessor();

// Node types that placeholders parse into (backtick/static-block format)
const PLACEHOLDER_TYPES = new Set([
  "ExpressionStatement",
  "StaticBlock",
  "TemplateLiteral",
  "ExportDefaultDeclaration",
]);

/**
 * Parse Ember source and return an ESTree-compatible AST.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {string}  [options.filePath] - File path for language detection
 * @param {boolean} [options.templateOnly] - Parse as raw Glimmer template content (for .hbs)
 * @param {function} [options.parser] - Custom JS/TS parser: (placeholderJS) => { ast, scopeManager?, visitorKeys?, services?, ... }
 * @param {object}  [options.visitors] - Callbacks invoked for Glimmer nodes during traversal
 * @return {object}
 */
export function toTree(source, options = {}) {
  const templateOpts = options.includeParentLinks === false ? { includeParentLinks: false } : {};

  if (options.templateOnly) {
    return processTemplate(source, new DocumentLines(source), [0, source.length], templateOpts);
  }

  let parseResults = preprocessor.parse(source);
  let js = toPlaceholderJS(source, parseResults);

  const useCustomParser = !!options.parser;
  const visitors = options.visitors || null;

  // Parse the placeholder JS — use custom parser or default oxc
  let result;
  if (useCustomParser) {
    result = options.parser(js);
    if (!result.ast) {
      result = { ast: result };
    }
  } else {
    let filename = options.filePath || "input.ts";
    let oxcResult = parseSync(filename, js);
    result = {
      ast: {
        type: "File",
        program: oxcResult.program,
        comments: oxcResult.comments || [],
        start: oxcResult.program.start,
        end: oxcResult.program.end,
      },
    };
  }

  // If no templates, return early
  if (!parseResults.length) {
    if (useCustomParser) {
      result.visitorKeys = { ...result.visitorKeys, ...glimmerVisitorKeys };
      return result;
    }
    result.ast.visitorKeys = glimmerVisitorKeys;
    return result.ast;
  }

  const codeLines = new DocumentLines(source);
  const allComments = [];
  const templateInfos = [];

  // Build a map of template ranges for lookup
  const templateRangeByStart = new Map(parseResults.map((r) => [r.range.startUtf16Codepoint, r]));

  // Process a matched placeholder node: create Glimmer AST and tokens
  function processPlaceholder(parseResult) {
    let templateContent = parseResult.contents;
    let contentRange = [
      parseResult.contentRange.startUtf16Codepoint,
      parseResult.contentRange.endUtf16Codepoint,
    ];
    let fullRange = [parseResult.range.startUtf16Codepoint, parseResult.range.endUtf16Codepoint];

    const { ast, comments } = processTemplate(
      templateContent,
      codeLines,
      contentRange,
      templateOpts,
    );

    // Fix the Template root to cover the full <template>...</template> range
    ast.range = fullRange;
    ast.start = fullRange[0];
    ast.end = fullRange[1];
    ast.loc = {
      start: codeLines.offsetToPosition(fullRange[0]),
      end: codeLines.offsetToPosition(fullRange[1]),
    };

    // Add tokens for the <template> and </template> tags
    const openEnd = contentRange[0];
    const closeStart = contentRange[1];
    const openTag = source.slice(fullRange[0], openEnd);
    const closeTag = source.slice(closeStart, fullRange[1]);
    const makeToken = (value, range) => ({
      type: "Punctuator",
      value,
      range,
      start: range[0],
      end: range[1],
      loc: {
        start: codeLines.offsetToPosition(range[0]),
        end: codeLines.offsetToPosition(range[1]),
      },
    });
    ast.tokens = [
      makeToken(openTag, [fullRange[0], openEnd]),
      ...(ast.tokens || []),
      makeToken(closeTag, [closeStart, fullRange[1]]),
    ];

    templateInfos.push({ utf16Range: fullRange, ast });
    return ast;
  }

  // Check if a node matches a template range
  function matchPlaceholder(node) {
    let range = node.range || [node.start, node.end];
    if (node.type === "ExportDefaultDeclaration" && node.declaration) {
      const decl = node.declaration;
      range = decl.range || [decl.start, decl.end];
    }
    const parseResult = templateRangeByStart.get(range[0]);
    if (
      !parseResult ||
      (parseResult.range.endUtf16Codepoint !== range[1] &&
        parseResult.range.endUtf16Codepoint !== range[1] + 1)
    ) {
      return null;
    }
    return parseResult;
  }

  // Walk Glimmer subtree, invoking visitors with full path context
  function walkGlimmerTree(node, parentPath) {
    if (!node || typeof node !== "object" || !node.type) return;
    const path = { node, parent: parentPath?.node ?? null, parentPath };

    if (visitors && node.type.startsWith("Glimmer")) {
      const handler = visitors[node.type];
      if (handler) handler(node, path);
      if ("blockParams" in node && visitors.GlimmerBlockParams) {
        visitors.GlimmerBlockParams(node, path);
      }
    }

    const keys = glimmerVisitorKeys[node.type];
    if (!keys) return;
    for (const key of keys) {
      const child = node[key];
      if (!child) continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          walkGlimmerTree(item, path);
        }
      } else if (typeof child === "object" && child.type) {
        walkGlimmerTree(child, path);
      }
    }
  }

  if (useCustomParser) {
    // Custom parser path: mutate the parser's AST in-place, invoke visitors.
    // Use the parser's visitorKeys to traverse efficiently (avoids Object.keys).
    const parserVisitorKeys = result.visitorKeys || {};

    function visitNode(node, parentPath) {
      if (!node || typeof node !== "object" || !node.type) return;

      const path = { node, parent: parentPath?.node ?? null, parentPath };

      if (PLACEHOLDER_TYPES.has(node.type)) {
        const parseResult = matchPlaceholder(node);
        if (parseResult) {
          const ast = processPlaceholder(parseResult);
          for (const key of Object.keys(node)) {
            if (!(key in ast) && key !== "parent") {
              delete node[key];
            }
          }
          Object.assign(node, ast);
          if (visitors) walkGlimmerTree(node, parentPath);
          return;
        }
      }

      // Use visitorKeys for efficient child traversal
      const keys = parserVisitorKeys[node.type];
      if (!keys) return;
      for (const key of keys) {
        const child = node[key];
        if (!child) continue;
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === "object" && item.type) {
              visitNode(item, path);
            }
          }
        } else if (typeof child === "object" && child.type) {
          visitNode(child, path);
        }
      }
    }

    visitNode(result.ast, null);
  } else {
    // Default oxc path: use zimmerframe walk (returns new tree)
    result.ast = walk(result.ast, null, {
      _(node, { next }) {
        if (PLACEHOLDER_TYPES.has(node.type)) {
          const parseResult = matchPlaceholder(node);
          if (parseResult) {
            return processPlaceholder(parseResult);
          }
        }
        next();
      },
    });

    // Walk Glimmer subtrees for visitors (after zimmerframe splicing)
    if (visitors) {
      for (const ti of templateInfos) {
        walkGlimmerTree(ti.ast, null);
      }
    }
  }

  // Splice template tokens into the AST token stream.
  // Tokens are sorted by range, so use binary search for O(log n) lookup.
  const astRoot = result.ast.program || result.ast;
  if (astRoot.tokens) {
    for (const ti of templateInfos) {
      const [tStart, tEnd] = ti.utf16Range;
      const tokens = astRoot.tokens;
      // Binary search for first token with range[0] >= tStart
      let lo = 0;
      let hi = tokens.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (tokens[mid].range[0] < tStart) lo = mid + 1;
        else hi = mid;
      }
      const firstIdx = lo;
      if (firstIdx >= tokens.length || tokens[firstIdx].range[0] >= tEnd) continue;
      let lastIdx = firstIdx;
      while (lastIdx < tokens.length && tokens[lastIdx].range[1] <= tEnd) {
        lastIdx++;
      }
      tokens.splice(firstIdx, lastIdx - firstIdx, ...ti.ast.tokens);
    }
  }

  // Merge comments
  if (allComments.length) {
    if (!astRoot.comments) astRoot.comments = [];
    astRoot.comments.push(...allComments);
  }

  if (useCustomParser) {
    result.visitorKeys = { ...result.visitorKeys, ...glimmerVisitorKeys };
    result.templateInfos = templateInfos;
    return result;
  }

  // Default path: return bare AST with visitorKeys attached
  result.ast.visitorKeys = glimmerVisitorKeys;
  return result.ast;
}

export const parse = toTree;

// ── Placeholder JS ────────────────────────────────────────────────────

/**
 * Replaces <template>...</template> regions with placeholder expressions
 * of the same character length that are valid JS/TS.
 *
 * Expression templates become:  `content          ` (backtick, space-padded)
 * Class member templates become: static{`content  `} (static block, space-padded)
 *
 * This format is compatible with all JS/TS parsers including
 * oxc-parser, @typescript-eslint/parser, and @babel/eslint-parser.
 */
function toPlaceholderJS(source, parseResults) {
  // Build result in forward order using parts array (avoids intermediate string allocations)
  const parts = [];
  let cursor = 0;

  for (const pr of parseResults) {
    const start = pr.range.startUtf16Codepoint;
    const end = pr.range.endUtf16Codepoint;
    const tplLength = end - start;

    parts.push(source.slice(cursor, start));

    const content = source
      .slice(pr.contentRange.startUtf16Codepoint, pr.contentRange.endUtf16Codepoint)
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");

    if (pr.type === "class-member") {
      const spaces = tplLength - content.length - 10; // "static{`" + "`}" = 10
      parts.push(`static{\`${content}${" ".repeat(Math.max(0, spaces))}\`}`);
    } else {
      const spaces = tplLength - content.length - 2; // "`" + "`" = 2
      parts.push(`\`${content}${" ".repeat(Math.max(0, spaces))}\``);
    }

    cursor = end;
  }

  parts.push(source.slice(cursor));
  return parts.join("");
}
