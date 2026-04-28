/**
 * Glimmer AST → ESTree transform utilities.
 */

import {
  visitorKeys as rawGlimmerVisitorKeys,
  preprocess as glimmerPreprocess,
} from "@glimmer/syntax";

import { tokenize, buildTokenStream } from "./tokens.js";

/**
 * Converts between character offsets and line/column positions.
 * Lines are 1-based, columns are 0-based (matching ESTree & Glimmer conventions).
 */
export class DocumentLines {
  constructor(source) {
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") {
        this.lineStarts.push(i + 1);
      }
    }
  }

  positionToOffset(pos) {
    return this.lineStarts[pos.line - 1] + pos.column;
  }

  offsetToPosition(offset) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.lineStarts[lo] };
  }
}

/**
 * Glimmer visitor keys map with "Glimmer" prefix.
 * Computed once at module load.
 */
export const glimmerVisitorKeys = (() => {
  const keys = {};
  for (const [k, v] of Object.entries(rawGlimmerVisitorKeys)) {
    keys[`Glimmer${k}`] = v;
  }
  keys.GlimmerElementNode = [...keys.GlimmerElementNode, "blockParamNodes", "parts"];
  keys.GlimmerProgram = ["body", "blockParamNodes"];
  keys.GlimmerTemplate = ["body"];
  return keys;
})();

// ── Internal helpers ──────────────────────────────────────────────────

// @glimmer/syntax nodes use prototype getters that form circular chains,
// crashing traversers like esrecurse. We snapshot configurable getters:
//   ElementNode: tag, blockParams, selfClosing
//   PathExpression: original
//   VarHead: name, original
//   Block: blockParams
const _desc = { value: undefined, configurable: true, enumerable: true, writable: true };
const _parentDesc = { value: null, configurable: true, enumerable: false, writable: true };
export function setParent(node, parent) {
  _parentDesc.value = parent;
  Object.defineProperty(node, "parent", _parentDesc);
}
function defOwn(obj, key) {
  _desc.value = obj[key];
  Object.defineProperty(obj, key, _desc);
}

function removeFromParent(nodes) {
  for (const node of nodes) {
    const children =
      (node.parent && (node.parent.children || node.parent.body || node.parent.parts)) || [];
    const idx = children.indexOf(node);
    if (idx >= 0) {
      children.splice(idx, 1);
    }
  }
}

/**
 * Parse and transform a Glimmer template into an ESTree-compatible AST.
 * Internal — consumed by toTree.
 *
 * Single recursive pass: collect, categorize, snapshot getters, fix
 * positions, create parts/blockParamNodes, nullify empty hashes, and
 * prefix types. No separate collect-then-transform loop.
 */
export function processTemplate(templateContent, codeLines, options = {}) {
  const { templateRange, tokens: generateTokens = false } = options;
  const offset = templateRange[0];
  const docLines = offset === 0 ? codeLines : new DocumentLines(templateContent);

  const toFileRange = (loc) => [
    offset + docLines.positionToOffset(loc.start),
    offset + docLines.positionToOffset(loc.end),
  ];
  const toFileLoc = (range) => ({
    start: codeLines.offsetToPosition(range[0]),
    end: codeLines.offsetToPosition(range[1]),
  });

  const ast = glimmerPreprocess(templateContent, { mode: "codemod" });
  const comments = [];
  const textNodes = [];
  const emptyTextNodes = [];

  // Single recursive pass over the glimmer AST. Processes each node
  // fully (getters, positions, parts, blockParams) then recurses into
  // children using raw visitor keys. Type prefixing happens inline
  // AFTER recursing (so children see the original type during lookup).
  function visit(n, parent) {
    setParent(n, parent);

    // Categorize
    if (n.type === "CommentStatement" || n.type === "MustacheCommentStatement") {
      comments.push(n);
    }
    if (n.type === "TextNode") {
      n.value = n.chars;
      if (n.value.trim().length !== 0 || (parent && parent.type === "AttrNode")) {
        textNodes.push(n);
      } else {
        emptyTextNodes.push(n);
      }
    }

    // Snapshot configurable prototype getters
    switch (n.type) {
      case "ElementNode":
        defOwn(n, "tag");
        defOwn(n, "blockParams");
        defOwn(n, "selfClosing");
        if (n.path?.head) {
          defOwn(n.path.head, "name");
          defOwn(n.path.head, "original");
        }
        break;
      case "PathExpression":
        defOwn(n, "original");
        if (n.head) {
          defOwn(n.head, "name");
          defOwn(n.head, "original");
        }
        break;
      case "Block":
        defOwn(n, "blockParams");
        break;
    }

    // Fix positions
    if (n.type === "PathExpression") {
      n.head.range = toFileRange(n.head.loc);
      n.head.start = n.head.range[0];
      n.head.end = n.head.range[1];
      n.head.loc = toFileLoc(n.head.range);
    }
    n.range = n.type === "Template" ? [...templateRange] : toFileRange(n.loc);
    n.start = n.range[0];
    n.end = n.range[1];
    n.loc = toFileLoc(n.range);

    if (n.type === "MustacheCommentStatement") {
      n.longForm = templateContent.slice(n.start - offset, n.start - offset + 4) === "{{!-";
    }

    // Create parts for ElementNode
    if (n.type === "ElementNode") {
      n.name = n.tag;
      const p = n.path.head;
      const partRange = toFileRange(p.loc);
      const part = {
        type: "GlimmerElementNodePart",
        original: p.original,
        name: p.original,
        range: partRange,
        start: partRange[0],
        end: partRange[1],
        loc: toFileLoc(partRange),
      };
      setParent(part, n);
      n.parts = [part];
    }

    // Create blockParamNodes
    if ("blockParams" in n && Array.isArray(n.blockParams)) {
      if (n.params && n.params.length === n.blockParams.length) {
        n.blockParamNodes = n.params.map((p) => {
          const range = toFileRange(p.loc);
          const bp = {
            type: "GlimmerBlockParam",
            name: p.original || p.name,
            original: p.original,
            range,
            start: range[0],
            end: range[1],
            loc: toFileLoc(range),
          };
          setParent(bp, n);
          return bp;
        });
      } else {
        n.blockParamNodes = n.blockParams.map((bpName) => {
          const bp = {
            type: "GlimmerBlockParam",
            name: bpName,
            range: [n.range[0], n.range[1]],
            start: n.range[0],
            end: n.range[1],
            loc: toFileLoc(n.range),
          };
          setParent(bp, n);
          return bp;
        });
      }
    }

    // Nullify empty hashes
    if (
      (n.type === "MustacheStatement" ||
        n.type === "BlockStatement" ||
        n.type === "SubExpression") &&
      n.hash?.pairs?.length === 0
    ) {
      n.hash = null;
    }

    // Recurse into children BEFORE prefixing type (visitor keys use original type)
    const keys = rawGlimmerVisitorKeys[n.type];
    if (keys) {
      for (const key of keys) {
        const child = n[key];
        if (!child) continue;
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === "object" && item.type) visit(item, n);
          }
        } else if (typeof child === "object" && child.type) {
          visit(child, n);
        }
      }
    }

    // Prefix type after children are visited
    n.type = `Glimmer${n.type}`;
  }

  visit(ast, null);

  removeFromParent(emptyTextNodes);

  if (generateTokens) {
    // buildTokenStream walks comments and textNodes as sorted intervals via
    // pointer advancement. AST-traversal order doesn't match source order
    // when an element has both attribute-position and body-position
    // MustacheCommentStatements (e.g. `<li {{! a }}>{{! b }}</li>`), so
    // sort here. Without the sort, raw tokens that fall inside an earlier-
    // source-position comment fail the skip check, the same span ends up
    // tokenized twice (raw punctuators *and* a Block), and downstream
    // ESLint token walks can infinite-loop on the non-monotonic stream.
    comments.sort((a, b) => a.range[0] - b.range[0]);
    ast.tokens = buildTokenStream(
      tokenize(templateContent, codeLines, offset),
      comments,
      textNodes,
      templateContent,
      offset,
    );
  }
  ast.contents = templateContent;

  return { ast, comments };
}
