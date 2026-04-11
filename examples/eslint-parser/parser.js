/**
 * Example ESLint custom parser for .gjs/.gts files using ember-estree.
 *
 * @see https://eslint.org/docs/latest/extend/custom-parsers
 */
import { toTree, glimmerVisitorKeys, DocumentLines } from "ember-estree";
import { analyze } from "eslint-scope";
import { registerGlimmerScopes } from "ember-estree/eslint-scope";

const EXCLUDED_KEYS = ["parent", "loc", "range", "tokens", "comments"];

/**
 * Add `range` and `loc` to every AST node. ESLint requires both.
 */
function addRangesAndLocs(node, docLines, visited = new Set()) {
  if (!node || typeof node !== "object" || visited.has(node)) return;
  visited.add(node);

  if (node.type && typeof node.start === "number" && typeof node.end === "number") {
    if (!node.range) node.range = [node.start, node.end];
    if (!node.loc) {
      node.loc = {
        start: docLines.offsetToPosition(node.start),
        end: docLines.offsetToPosition(node.end),
      };
    }
  }

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "parent" || key === "tokens" || key === "comments") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) addRangesAndLocs(item, docLines, visited);
    } else if (val && typeof val === "object") {
      addRangesAndLocs(val, docLines, visited);
    }
  }
}

/**
 * Implements the ESLint `parseForESLint()` API.
 */
export function parseForESLint(code, options = {}) {
  const result = toTree(code, options);
  const program = result.program || result;
  const visitorKeys = result.visitorKeys || glimmerVisitorKeys;

  const docLines = new DocumentLines(code);
  addRangesAndLocs(program, docLines);

  program.tokens = (program.tokens || []).map((t) => ({
    ...t,
    range: t.range || [t.start, t.end],
    type: typeof t.type === "string" ? t.type : t.type?.label || "Punctuator",
  }));
  program.comments = (program.comments || []).map((c) => ({
    ...c,
    range: c.range || [c.start, c.end],
  }));
  program.range = program.range || [program.start, program.end];
  program.loc = program.loc || {
    start: { line: 1, column: 0 },
    end: docLines.offsetToPosition(code.length),
  };

  const scopeManager = analyze(program, {
    ecmaVersion: 2024,
    sourceType: "module",
    childVisitorKeys: visitorKeys,
    fallback: (node) => Object.keys(node).filter((k) => !EXCLUDED_KEYS.includes(k)),
  });

  registerGlimmerScopes(scopeManager);

  return { ast: program, visitorKeys, scopeManager };
}

export default {
  meta: { name: "ember-estree-eslint-parser-example", version: "0.0.0" },
  parseForESLint,
};
