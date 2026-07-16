import { parseSync } from "oxc-parser";

import { toTree } from "./parse.js";
import { print } from "./print.js";

/**
 * Turns an interpolated value into source text:
 *
 * - AST nodes (ESTree or Glimmer) are printed
 * - arrays are printed element-by-element, comma-separated (parameter
 *   and argument lists)
 * - strings and other primitives are inserted verbatim
 *
 * @param {unknown} value
 * @return {string}
 */
function toCode(value) {
  if (value === null || value === undefined) {
    throw new TypeError(`cannot interpolate ${value} into a builder template`);
  }
  if (Array.isArray(value)) {
    return value.map(toCode).join(", ");
  }
  if (typeof value === "object") {
    return print(value);
  }
  return String(value);
}

// Everything that ties a node to the source it was parsed from. Freshly
// built nodes must not carry positions: `print(File)` weaves comments in
// by `node.start`, so snippet-relative positions on spliced-in nodes
// would pull the host file's comments to the wrong place. `parent` points
// into the snippet's own (discarded) wrapper File.
const SOURCE_KEYS = ["start", "end", "range", "loc", "parent"];

/**
 * Recursively removes source positions (and parent links) so the node
 * behaves as newly built, wherever it gets spliced.
 *
 * @param {object} node
 * @param {WeakSet} [seen]
 */
function scrub(node, seen = new WeakSet()) {
  if (seen.has(node)) return;
  seen.add(node);

  for (const key of SOURCE_KEYS) {
    delete node[key];
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") scrub(item, seen);
      }
    } else if (value && typeof value === "object") {
      scrub(value, seen);
    }
  }
}

/**
 * oxc-parser is error-tolerant and hands back a partial AST for broken
 * input. Builders build source *you* wrote in the template string, so a
 * parse error is always a bug in the caller — surface it instead of
 * returning the partial tree.
 *
 * @param {string} placeholderJS
 */
function throwingParser(placeholderJS) {
  const result = parseSync("builder.ts", placeholderJS);

  if (result.errors.length > 0) {
    const messages = result.errors.map((error) => error.message).join("\n");
    throw new SyntaxError(`could not build AST from template string:\n${messages}`);
  }

  return {
    ast: {
      type: "File",
      program: result.program,
      comments: result.comments,
    },
  };
}

/**
 * Tagged template that builds the AST for the statements in the template
 * string — like `@babel/template`, but gjs/gts-aware: `<template>` regions
 * become `Glimmer*` nodes and TypeScript syntax is understood.
 *
 * Interpolations may be strings (inserted verbatim), AST nodes (printed),
 * or arrays of either (comma-separated). The returned nodes carry no
 * source positions, so they can be spliced into any tree that later goes
 * through `print` — including a comment-carrying `File`.
 *
 * ```js
 * let [importDecl, klass] = statements`
 *   import Component from "@glimmer/component";
 *   export default class extends Component {}
 * `;
 * ```
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @return {object[]}
 */
export function statements(strings, ...values) {
  let source = strings[0];

  for (const [i, value] of values.entries()) {
    source += toCode(value) + strings[i + 1];
  }

  const result = toTree(source, { filePath: "builder.gts", parser: throwingParser });
  const body = result.ast.program.body;

  for (const node of body) {
    scrub(node);
  }

  return body;
}

/**
 * Tagged template that builds the AST for a single statement — see
 * {@link statements} for the interpolation rules.
 *
 * ```js
 * let node = statement`import ${localName} from "some-package";`;
 * ```
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @return {object}
 */
export function statement(strings, ...values) {
  const body = statements(strings, ...values);

  if (body.length !== 1) {
    throw new SyntaxError(`expected exactly one statement, got ${body.length}`);
  }

  return body[0];
}
