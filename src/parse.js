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

import { parseSync, visitorKeys as oxcVisitorKeys } from "oxc-parser";
import { Preprocessor } from "content-tag";

import { processTemplate, DocumentLines, glimmerVisitorKeys, setParent } from "./transforms.js";

// Base visitor-keys map for the outer-AST walk: oxc-parser's own keys (covers
// standard ESTree + TS), plus the `File` wrapper we add on the default path,
// plus Glimmer's keys. Used to iterate only declared child slots instead of
// every enumerable property on every node.
//
// When `options.parser` returns `visitorKeys`, callers merge on top — but if
// their parser's AST is oxc-compatible, this base is already sufficient.
const DEFAULT_VISITOR_KEYS = {
  ...oxcVisitorKeys,
  File: ["program"],
  ...glimmerVisitorKeys,
};

// Swap `oldNode` for `newNode` in whichever slot of `parent` currently holds it.
// Used to splice a GlimmerTemplate directly into the outer AST without
// allocating new ancestor objects — keeps WeakMap-keyed data (scope manager,
// esTreeNodeToTSNodeMap) attached to the existing nodes.
function replaceInParent(parent, oldNode, newNode) {
  for (const key of Object.keys(parent)) {
    const v = parent[key];
    if (v === oldNode) {
      parent[key] = newNode;
      return true;
    }
    if (Array.isArray(v)) {
      const idx = v.indexOf(oldNode);
      if (idx !== -1) {
        v[idx] = newNode;
        return true;
      }
    }
  }
  return false;
}

const preprocessor = new Preprocessor();

// Node types that placeholders parse into (backtick/static-block format)
const PLACEHOLDER_TYPES = new Set([
  "ExpressionStatement",
  "StaticBlock",
  "UnaryExpression",
  "ExportDefaultDeclaration",
]);

/**
 * Parse Ember source and return an ESTree-compatible AST.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {string}  [options.filePath] - File path for language detection
 * @param {boolean} [options.tokens] - Generate a flat token stream on the AST (needed by ESLint; skipped by default)
 * @param {boolean} [options.templateOnly] - Parse as raw Glimmer template content (for .hbs)
 * @param {function} [options.parser] - Custom JS/TS parser: (placeholderJS) => { ast, scopeManager?, visitorKeys?, services?, ... }.
 *   Recommended to return `visitorKeys` describing the parser's AST; when omitted, oxc-parser's
 *   keys are used (fine for oxc-compatible ASTs, incomplete for parsers that emit bespoke node types).
 * @param {object|function} [options.visitors] - Either a map of `{ [Type]: (node, path) => void }`
 *   handlers, or a factory `(outerAst) => handlers` invoked once after parsing (before any
 *   template splicing) to give callers a view of the raw JS/TS tree. Handlers fire on every
 *   node during traversal — outer JS/TS nodes AND spliced Glimmer subtrees — in a single pass.
 *   The pseudo-type `GlimmerBlockParams` fires on any node that carries `blockParams`.
 * @return {object}
 */
export function toTree(source, options = {}) {
  const generateTokens = !!options.tokens;

  if (options.templateOnly) {
    return processTemplate(source, new DocumentLines(source), {
      templateRange: [0, source.length],
      tokens: generateTokens,
    });
  }

  let parseResults = preprocessor.parse(source);
  // content-tag reports a class's own template before a template that sits
  // earlier in its heritage clause (`class A extends mixin(<template/>) {
  // <template/> }`); `toPlaceholderJS` walks the source forward, so it needs
  // them in source order.
  parseResults.sort((a, b) => a.range.startUtf16Codepoint - b.range.startUtf16Codepoint);
  let js = toPlaceholderJS(source, parseResults);

  const useCustomParser = !!options.parser;

  // Parse the placeholder JS — use custom parser or default oxc
  let result;
  if (useCustomParser) {
    result = options.parser(js);
    if (!result.ast) {
      result = { ast: result };
    }
  } else {
    let filename = options.filePath || "input.ts";
    if (filename.includes(".gts")) {
      filename = filename.replace(/\.gts$/, ".ts");
    }
    let oxcResult = parseSync(filename, js);
    result = {
      ast: {
        type: "File",
        program: oxcResult.program,
        comments: oxcResult.comments || [],
        // oxc's diagnostics for the script. On an unrecoverable error oxc
        // returns an empty `program.body`; this is how callers tell that apart
        // from an empty file.
        errors: oxcResult.errors || [],
        start: oxcResult.program.start,
        end: oxcResult.program.end,
      },
    };
  }

  // Resolve user visitors against the outer AST. A plain object is used
  // as-is; a factory is called once so callers can introspect the raw
  // JS/TS tree before any template splicing. Default to `{}` so downstream
  // dispatch can be a bare `visitors[type]` lookup without null-guards.
  const visitors =
    typeof options.visitors === "function"
      ? (options.visitors(result.ast) ?? {})
      : (options.visitors ?? {});
  const hasVisitors = Object.keys(visitors).length > 0;
  // Guard against dispatching a handler twice on the same node.
  // Visitors that relocate nodes (e.g. moving Glimmer comments into
  // `program.comments`) would otherwise fire a second time when the walk
  // reaches the new location.
  const seen = new WeakSet();
  const hasTemplates = parseResults.length > 0;

  // Nothing to walk — attach visitor keys and return.
  if (!hasTemplates && !hasVisitors) {
    if (useCustomParser) {
      result.visitorKeys = { ...result.visitorKeys, ...glimmerVisitorKeys };
      return result;
    }
    result.ast.visitorKeys = glimmerVisitorKeys;
    return result.ast;
  }

  const codeLines = hasTemplates ? new DocumentLines(source) : null;
  const templateInfos = [];
  const templateRangeByStart = hasTemplates
    ? new Map(parseResults.map((r) => [r.range.startUtf16Codepoint, r]))
    : null;

  // Process a matched placeholder node: create Glimmer AST and tokens.
  // `placeholderNode` is the original JS/TS node being swapped out; we stash
  // it on templateInfos so consumers can forward its parser-services mapping
  // (e.g. esTreeNodeToTSNodeMap) onto the GlimmerTemplate that replaces it.
  function processPlaceholder(parseResult, placeholderNode) {
    let templateContent = parseResult.contents;
    let contentRange = [
      parseResult.contentRange.startUtf16Codepoint,
      parseResult.contentRange.endUtf16Codepoint,
    ];
    let fullRange = [parseResult.range.startUtf16Codepoint, parseResult.range.endUtf16Codepoint];

    const { ast } = processTemplate(templateContent, codeLines, {
      templateRange: contentRange,
      tokens: generateTokens,
    });

    // Fix the Template root to cover the full <template>...</template> range
    ast.range = fullRange;
    ast.start = fullRange[0];
    ast.end = fullRange[1];
    ast.loc = {
      start: codeLines.offsetToPosition(fullRange[0]),
      end: codeLines.offsetToPosition(fullRange[1]),
    };

    if (generateTokens) {
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
    }

    templateInfos.push({ utf16Range: fullRange, ast, placeholder: placeholderNode });
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

  // Walk the outer AST keyed on visitorKeys — iterating only declared child
  // slots instead of every enumerable property on every node. Custom parsers
  // may supply their own keys; those override the defaults for types they
  // recognise, and Glimmer keys stay on top for the spliced subtrees.
  const allVisitorKeys =
    useCustomParser && result.visitorKeys
      ? { ...DEFAULT_VISITOR_KEYS, ...result.visitorKeys, ...glimmerVisitorKeys }
      : DEFAULT_VISITOR_KEYS;

  function walkWithKeys(node, parentPath) {
    if (!node || !node.type) return;

    const path = { node, parent: parentPath?.node ?? null, parentPath };

    if (hasTemplates && PLACEHOLDER_TYPES.has(node.type)) {
      const parseResult = matchPlaceholder(node);
      if (parseResult && node.type === "ExportDefaultDeclaration") {
        // `export default <template>...</template>`: keep the export wrapper
        // and splice its declaration, so the tree (and `print`) still carry
        // the `export default`.
        const ast = processPlaceholder(parseResult, node.declaration);
        node.declaration = ast;
        setParent(ast, node);
        if (hasVisitors && !seen.has(node)) {
          seen.add(node);
          const handler = visitors[node.type];
          if (handler) handler(node, path);
          walkWithKeys(ast, path);
        }
        return;
      } else if (parseResult) {
        // Splice in place: write the GlimmerTemplate directly into the parent's
        // slot instead of allocating new ancestor objects. This preserves node
        // identity for every ancestor, which matters for WeakMap-keyed data
        // held by custom parsers (scope manager, esTreeNodeToTSNodeMap).
        const ast = processPlaceholder(parseResult, node);
        const parent = parentPath?.node ?? null;
        if (parent) replaceInParent(parent, node, ast);
        setParent(ast, parent);
        // Recurse into the Glimmer subtree so visitors fire on its nodes too.
        // The Glimmer root's parentPath reflects its true JS parent — the
        // placeholder (`void` expression / StaticBlock) is an internal artifact.
        if (hasVisitors) walkWithKeys(ast, parentPath);
        return;
      }
    }

    if (hasVisitors && !seen.has(node)) {
      seen.add(node);
      const handler = visitors[node.type];
      if (handler) handler(node, path);
      if ("blockParams" in node && visitors.GlimmerBlockParams) {
        visitors.GlimmerBlockParams(node, path);
      }
    }

    const keys = allVisitorKeys[node.type];
    if (!keys) return;
    for (const key of keys) {
      const child = node[key];
      if (!child) continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && item.type) {
            walkWithKeys(item, path);
          }
        }
      } else if (typeof child === "object" && child.type) {
        walkWithKeys(child, path);
      }
    }
  }

  walkWithKeys(result.ast, null);

  // Splice template tokens into the AST token stream.
  //
  // `tokens` is the flat lexed stream (keywords, punctuators, identifiers,
  // literals) that ESLint, formatters, and source-map tooling consume —
  // `SourceCode.getTokens()` reads it directly.
  //
  // We replaced each <template>...</template> region with a backtick
  // placeholder before handing the source to the JS/TS parser, so the
  // parser's tokens for those ranges describe the placeholder, not the
  // real source. Here we swap them out for the real lexemes:
  //   1. a fabricated `<template>` Punctuator (added in processPlaceholder)
  //   2. the Glimmer AST's own tokens (from transforms.js)
  //   3. a fabricated `</template>` Punctuator
  // so consumers see a position-accurate token stream matching the
  // original source byte-for-byte across JS and Glimmer regions.
  //
  // Tokens are sorted by range, so use binary search for O(log n) lookup.
  // Only splice if the caller asked for tokens — otherwise `ti.ast.tokens`
  // wasn't populated by processPlaceholder, and a custom parser may still
  // have returned its own token stream we shouldn't touch.
  const astRoot = result.ast.program || result.ast;
  if (generateTokens && astRoot.tokens) {
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
 * Expression templates become:  void `content     ` (void + backtick, space-padded)
 * Class member templates become: static{`content  `} (static block, space-padded)
 *
 * The `void` prefix matters at a statement start: a bare backtick literal
 * after an unterminated expression statement continues it as a tagged
 * template (`const y = x\n`...`` reads as `x`...``), whereas `void` cannot
 * continue an expression, so automatic semicolon insertion applies exactly
 * as it does for the real `<template>`. `void` is a keyword, so the
 * placeholder also adds no identifier reference for scope analysis to see.
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

    // Blank out backticks and dollar signs instead of backslash-escaping
    // them: escaping grows the content, and once the growth exceeds the
    // padding slack the placeholder no longer lines up with the original
    // region — matchPlaceholder then rejects it and the raw placeholder
    // leaks into the AST (ember-tooling/ember-eslint-parser#230). The
    // content is discarded when the Glimmer AST is spliced in, so only
    // its length and line structure matter.
    const content = source
      .slice(pr.contentRange.startUtf16Codepoint, pr.contentRange.endUtf16Codepoint)
      .replace(/[`$]/g, " ");

    if (pr.type === "class-member") {
      const spaces = tplLength - content.length - 10; // "static{`" + "`}" = 10
      parts.push(`static{\`${content}${" ".repeat(Math.max(0, spaces))}\`}`);
    } else {
      const spaces = tplLength - content.length - 7; // "void `" + "`" = 7
      parts.push(`void \`${content}${" ".repeat(Math.max(0, spaces))}\``);
    }

    cursor = end;
  }

  parts.push(source.slice(cursor));
  return parts.join("");
}
