/**
 * Glimmer AST → ESTree transform utilities.
 *
 * Ported from ember-eslint-parser's transforms.js, adapted for
 * ember-estree's ESM architecture. Handles:
 *
 *  - Type prefixing (all Glimmer types get a "Glimmer" prefix)
 *  - Range / loc fixing (converts template-local positions to file-level)
 *  - ElementNode `parts` and `name` fields
 *  - blockParams → virtual node creation
 *  - Empty hash nullification
 *  - Empty text node removal
 *  - Tokenization for ESLint integration
 */

import { traverse, visitorKeys as glimmerVisitorKeys } from "@glimmer/syntax";
import templateRecast from "ember-template-recast";

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

// ── Tokenization helpers (shared with ember-eslint-parser) ──

function isAlphaNumeric(code) {
  return !(
    !(code > 47 && code < 58) && // numeric (0-9)
    !(code > 64 && code < 91) && // upper alpha (A-Z)
    !(code > 96 && code < 123)
  );
}

function isWhiteSpaceCode(code) {
  return (
    code === 32 /* space */ ||
    code === 9 /* tab */ ||
    code === 13 /* carriageReturn */ ||
    code === 10 /* lineFeed */ ||
    code === 11 /* verticalTab */
  );
}

/**
 * Simple tokenizer for templates — splits into words and punctuators.
 * @param {string} template
 * @param {DocumentLines} doc
 * @param {number} startOffset
 * @return {object[]}
 */
export function tokenize(template, doc, startOffset) {
  const tokens = [];
  let wordStart = -1;
  function pushToken(value, type, range) {
    tokens.push({
      type,
      value,
      range,
      start: range[0],
      end: range[1],
      loc: {
        start: { ...doc.offsetToPosition(range[0]), index: range[0] },
        end: { ...doc.offsetToPosition(range[1]), index: range[1] },
      },
    });
  }
  for (let i = 0; i < template.length; i++) {
    const code = template.charCodeAt(i);
    if (isAlphaNumeric(code)) {
      if (wordStart < 0) {
        wordStart = i;
      }
    } else {
      if (wordStart >= 0) {
        pushToken(template.slice(wordStart, i), "word", [startOffset + wordStart, startOffset + i]);
        wordStart = -1;
      }
      if (!isWhiteSpaceCode(code)) {
        pushToken(template[i], "Punctuator", [startOffset + i, startOffset + i + 1]);
      }
    }
  }
  if (wordStart >= 0) {
    pushToken(template.slice(wordStart), "word", [
      startOffset + wordStart,
      startOffset + template.length,
    ]);
  }
  return tokens;
}

/**
 * Builds the final token stream by filtering out tokens covered by comments
 * or text nodes, then merging text nodes back in sorted order.
 * @param {object[]} rawTokens
 * @param {object[]} comments
 * @param {object[]} textNodes
 * @return {object[]}
 */
export function buildTokenStream(rawTokens, comments, textNodes) {
  const commentIntervals = comments.map((c) => c.range).sort((a, b) => a[0] - b[0]);
  const textNodeIntervals = textNodes.map((t) => t.range).sort((a, b) => a[0] - b[0]);

  function isCovered(tokenRange, intervals) {
    let lo = 0;
    let hi = intervals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const iv = intervals[mid];
      if (iv[0] <= tokenRange[0] && iv[1] >= tokenRange[1]) {
        return true;
      }
      if (iv[0] > tokenRange[0]) {
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return false;
  }

  const filteredTokens = rawTokens.filter(
    (t) => !isCovered(t.range, commentIntervals) && !isCovered(t.range, textNodeIntervals),
  );

  const sortedTextNodes = [...textNodes].sort((a, b) => a.range[0] - b.range[0]);
  const result = [];
  let ti = 0;
  for (const token of filteredTokens) {
    while (ti < sortedTextNodes.length && sortedTextNodes[ti].range[0] < token.range[0]) {
      result.push(sortedTextNodes[ti++]);
    }
    result.push(token);
  }
  while (ti < sortedTextNodes.length) {
    result.push(sortedTextNodes[ti++]);
  }

  return result;
}

/**
 * Traverse a Glimmer AST, set parent references, and categorize nodes.
 */
function collectNodes(ast) {
  const allNodes = [];
  const comments = [];
  const textNodes = [];
  const emptyTextNodes = [];

  traverse(ast, {
    All(node, path) {
      node.parent = path.parentNode;
      allNodes.push(node);
      if (node.type === "CommentStatement" || node.type === "MustacheCommentStatement") {
        comments.push(node);
      }
      if (node.type === "TextNode") {
        node.value = node.chars;
        if (node.value.trim().length !== 0 || (node.parent && node.parent.type === "AttrNode")) {
          textNodes.push(node);
        } else {
          emptyTextNodes.push(node);
        }
      }
    },
  });

  return { allNodes, comments, textNodes, emptyTextNodes };
}

/**
 * Remove nodes from their parent's children/body/parts arrays.
 */
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
 * Build the Glimmer visitor keys map with "Glimmer" prefix.
 * Uses the visitor keys exported by @glimmer/syntax.
 */
let _cachedGlimmerVisitorKeys = null;
export function buildGlimmerVisitorKeys() {
  if (_cachedGlimmerVisitorKeys) return _cachedGlimmerVisitorKeys;
  const keys = {};
  for (const [k, v] of Object.entries(glimmerVisitorKeys)) {
    keys[`Glimmer${k}`] = [...v];
  }
  if (!keys.GlimmerElementNode.includes("blockParamNodes")) {
    keys.GlimmerElementNode.push("blockParamNodes", "parts");
  }
  keys.GlimmerProgram = ["body", "blockParamNodes"];
  keys.GlimmerTemplate = ["body"];
  _cachedGlimmerVisitorKeys = keys;
  return keys;
}

/**
 * Process a Glimmer AST into an ESTree-compatible form.
 *
 * @param {object} templateAST - The Glimmer AST (from ember-template-recast / @glimmer/syntax)
 * @param {object} opts
 * @param {number} opts.contentOffset - Byte offset where the template content begins in the full source
 * @param {[number, number]} opts.templateRange - [start, end] byte range of the full <template>...</template> block
 * @param {string} opts.source - The full source code
 * @param {number} [opts.contentEnd] - Byte offset where content ends (defaults to templateRange[1] - "</template>".length)
 * @returns {object} The transformed AST with .tokens and .comments attached
 */
export function processGlimmerTemplate(
  templateAST,
  { contentOffset, templateRange, source, contentEnd: contentEndOpt },
) {
  // The Glimmer AST locs are relative to the inner template content only
  const contentEnd = contentEndOpt ?? templateRange[1] - "</template>".length;
  const contentStr = source.substring(contentOffset, contentEnd);
  const contentDoc = new DocumentLines(contentStr);
  const sourceDoc = new DocumentLines(source);

  const toFileRange = (loc) => {
    const locObj = loc.toJSON ? loc.toJSON() : loc;
    return [
      contentOffset + contentDoc.positionToOffset(locObj.start),
      contentOffset + contentDoc.positionToOffset(locObj.end),
    ];
  };

  const toFileLoc = (range) => ({
    start: sourceDoc.offsetToPosition(range[0]),
    end: sourceDoc.offsetToPosition(range[1]),
  });

  const { allNodes, comments, textNodes, emptyTextNodes } = collectNodes(templateAST);

  for (const n of allNodes) {
    const loc = n.loc.toJSON ? n.loc.toJSON() : n.loc;

    // Fix PathExpression head
    if (n.type === "PathExpression") {
      const head = n.head;
      if (head && head.loc) {
        const headLoc = head.loc.toJSON ? head.loc.toJSON() : head.loc;
        if (headLoc && headLoc.start) {
          head.range = toFileRange(headLoc);
          head.start = head.range[0];
          head.end = head.range[1];
          head.loc = toFileLoc(head.range);
        }
      }
    }

    // Set range — Template root gets the full <template>...</template> range
    n.range = n.type === "Template" ? [...templateRange] : toFileRange(loc);
    n.start = n.range[0];
    n.end = n.range[1];
    n.loc = toFileLoc(n.range);

    // Add parts and name to ElementNode
    if (n.type === "ElementNode") {
      n.name = n.tag;
      // Compute the tag name range: starts 1 char after element start (<), length = tag.length
      const tagStart = n.range[0] + 1; // skip "<"
      const tagEnd = tagStart + n.tag.length;
      const tagRange = [tagStart, tagEnd];
      n.parts = [
        {
          original: n.tag,
          name: n.tag,
          type: "GlimmerElementNodePart",
          range: tagRange,
          start: tagRange[0],
          end: tagRange[1],
          loc: toFileLoc(tagRange),
        },
      ];
    }

    // Handle blockParams — create virtual nodes from the blockParams string array
    if ("blockParams" in n && Array.isArray(n.blockParams)) {
      n.blockParamNodes = n.blockParams.map((name) => {
        return {
          type: "GlimmerBlockParam",
          name,
          range: [...n.range],
          start: n.range[0],
          end: n.range[1],
          loc: toFileLoc(n.range),
        };
      });
    }

    // Nullify empty hashes
    if (
      (n.type === "MustacheStatement" ||
        n.type === "BlockStatement" ||
        n.type === "SubExpression") &&
      n.hash &&
      n.hash.pairs &&
      n.hash.pairs.length === 0
    ) {
      n.hash = null;
    }

    // Prefix type with "Glimmer"
    n.type = `Glimmer${n.type}`;
  }

  // Clean up AST structure
  removeFromParent(emptyTextNodes);
  removeFromParent(comments);
  for (const comment of comments) {
    comment.type = "Block";
  }

  // Build token stream from the full <template>...</template> range
  const fullTemplateStr = source.slice(templateRange[0], templateRange[1]);
  templateAST.tokens = buildTokenStream(
    tokenize(fullTemplateStr, sourceDoc, templateRange[0]),
    comments,
    textNodes,
  );
  templateAST.contents = contentStr;
  templateAST.comments = comments;

  return templateAST;
}

/**
 * Higher-level wrapper that parses a raw template content string and processes it.
 * Consumers don't need to depend on ember-template-recast directly.
 *
 * @param {string} content - The raw template content (inner content, without <template> tags)
 * @param {object} opts - Same options as processGlimmerTemplate
 * @returns {object} The transformed AST with .tokens and .comments attached
 */
export function processGlimmerTemplateFromSource(content, opts) {
  const templateAST = templateRecast.parse(content);
  return processGlimmerTemplate(templateAST, opts);
}
