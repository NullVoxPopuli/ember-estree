/**
 * Example ESLint custom parser for .gjs/.gts files using ember-estree.
 *
 * This demonstrates how to implement an ESLint parser plugin using
 * ember-estree's parse() and the Glimmer visitor keys, following the
 * pattern from ember-eslint-parser.
 *
 * Includes a lightweight scope manager that registers GlimmerPathExpression
 * references and block param scopes, enabling no-undef to detect undefined
 * variables inside templates.
 *
 * @see https://eslint.org/docs/latest/extend/custom-parsers
 * @see https://github.com/ember-tooling/ember-eslint-parser
 */
import { parse, buildGlimmerVisitorKeys } from "ember-estree";
import { analyze, Reference, Scope, Variable, Definition } from "eslint-scope";
import { isKeyword } from "@glimmer/syntax";

/**
 * Merge the Glimmer-prefixed visitor keys with a base set.
 */
function mergeVisitorKeys() {
  return {
    ...buildGlimmerVisitorKeys(),
  };
}

// ── Lightweight scope tracking for Glimmer templates ──

const EXCLUDED_KEYS = ["parent", "loc", "range", "tokens", "comments"];

/**
 * Traverse an AST using the given visitor keys, calling visitor for each path.
 * Falls back to iterating object keys for node types not in the visitor keys map.
 */
function traverseAST(visitorKeys, node, visitor) {
  const queue = [{ node, parent: null, parentKey: null, parentPath: null }];

  while (queue.length > 0) {
    const currentPath = queue.pop();

    visitor(currentPath);

    if (!currentPath.node || typeof currentPath.node !== "object") continue;
    if (!currentPath.node.type) continue;

    // Use visitor keys if available, otherwise fall back to object keys
    let keys = visitorKeys[currentPath.node.type];
    if (!keys) {
      keys = Object.keys(currentPath.node).filter((k) => !EXCLUDED_KEYS.includes(k));
    }

    for (const key of keys) {
      const child = currentPath.node[key];
      if (!child) continue;

      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && item.type) {
            queue.push({
              node: item,
              parent: currentPath.node,
              parentKey: key,
              parentPath: currentPath,
            });
          }
        }
      } else if (typeof child === "object" && child.type) {
        queue.push({
          node: child,
          parent: currentPath.node,
          parentKey: key,
          parentPath: currentPath,
        });
      }
    }
  }
}

/**
 * Find the nearest scope by walking up the path's parents.
 */
function findParentScope(scopeManager, path) {
  let p = path;
  while (p) {
    const scope = scopeManager.acquire(p.node, true);
    if (scope) return scope;
    p = p.parentPath;
  }
  return null;
}

/**
 * Find a variable by name in any ancestor scope, returning both
 * the nearest scope and the variable (if found).
 */
function findVarInParentScopes(scopeManager, path, name) {
  let defScope = null;
  let currentScope = null;
  let p = path;
  while (p) {
    const s = scopeManager.acquire(p.node, true);
    if (s) {
      if (!currentScope) currentScope = s;
      if (s.set.has(name)) {
        defScope = s;
        break;
      }
    }
    p = p.parentPath;
  }
  if (!defScope) return { scope: currentScope };
  return { scope: currentScope, variable: defScope.set.get(name) };
}

/**
 * Register a node as a variable reference in the given scope.
 * If the variable exists, the reference is resolved to it.
 * Otherwise, the reference is pushed to the global scope's `through` list
 * so that no-undef can flag it.
 */
function registerNodeInScope(node, scope, variable) {
  const ref = new Reference(node, scope, Reference.READ);
  if (variable) {
    variable.references.push(ref);
    ref.resolved = variable;
  } else {
    let s = scope;
    while (s.upper) s = s.upper;
    s.through.push(ref);
  }
  scope.references.push(ref);
}

/**
 * Walk the AST to register Glimmer template references in the scope manager.
 *
 * This enables ESLint's no-undef rule to detect undefined variables inside
 * templates. It handles:
 *  - GlimmerPathExpression (VarHead) → registered as variable references
 *  - GlimmerElementNode → uppercase tag names registered as references
 *  - blockParams → creates block scopes with variables for each param
 */
function registerGlimmerScopes(program, scopeManager, visitorKeys) {
  traverseAST(visitorKeys, program, (path) => {
    const node = path.node;
    if (!node) return;

    // Register GlimmerPathExpression VarHead references
    if (node.type === "GlimmerPathExpression" && node.head?.type === "VarHead") {
      const name = node.head.name;
      if (isKeyword(name)) return;

      const { scope, variable } = findVarInParentScopes(scopeManager, path, name);
      if (scope) {
        node.head.parent = node;
        registerNodeInScope(node.head, scope, variable);
      }
    }

    // Register GlimmerElementNode tag names as references when they
    // start with uppercase (components that should be in scope)
    if (node.type === "GlimmerElementNode" && node.parts?.[0]) {
      const part = node.parts[0];
      const name = part.name;

      const ignore =
        name === "this" || name.startsWith(":") || name.startsWith("@") || name.includes("-");

      if (!ignore && name[0] === name[0].toUpperCase() && /[A-Z]/.test(name[0])) {
        const { scope, variable } = findVarInParentScopes(scopeManager, path, name);
        if (scope) {
          registerNodeInScope(part, scope, variable);
        }
      }
    }

    // Create block scopes for nodes with blockParamNodes
    if (node.blockParamNodes?.length > 0) {
      const upperScope = findParentScope(scopeManager, path);
      if (!upperScope) return;

      const scope = new Scope(scopeManager, "block", upperScope, node, false);

      for (const [paramIndex, param] of node.blockParamNodes.entries()) {
        const v = new Variable(param.name, scope);
        v.identifiers.push(param);
        scope.variables.push(v);
        scope.set.set(param.name, v);
        v.defs.push(new Definition("Parameter", param, node, node, paramIndex, "Block Param"));
      }
    }
  });
}

/**
 * Implements the ESLint `parseForESLint()` API.
 *
 * @param {string} code - The source code to parse
 * @param {object} options - ESLint parser options
 * @returns {{ ast: object, visitorKeys: object, scopeManager: object }}
 */
export function parseForESLint(code, options = {}) {
  const ast = parse(code, options);

  // The AST from ember-estree is a File-like node.
  // ESLint expects a Program node as the root.
  const program = ast.program;

  // Ensure required ESLint properties exist on tokens and comments
  program.tokens = (program.tokens || ast.tokens || []).map((t) => ({
    ...t,
    range: t.range || [t.start, t.end],
    type: typeof t.type === "string" ? t.type : t.type?.label || "Punctuator",
  }));
  program.comments = (program.comments || ast.comments || []).map((c) => ({
    ...c,
    range: c.range || [c.start, c.end],
  }));

  const visitorKeys = mergeVisitorKeys();

  // Build scope manager from the JS portion of the AST, then register
  // Glimmer template references so no-undef can detect undefined variables.
  const scopeManager = analyze(program, {
    ecmaVersion: 2024,
    sourceType: "module",
    childVisitorKeys: visitorKeys,
    fallback: (node) => Object.keys(node).filter((k) => !EXCLUDED_KEYS.includes(k)),
  });

  registerGlimmerScopes(program, scopeManager, visitorKeys);

  return {
    ast: program,
    visitorKeys,
    scopeManager,
  };
}

export default {
  meta: {
    name: "ember-estree-eslint-parser-example",
    version: "0.0.0",
  },
  parseForESLint,
};
