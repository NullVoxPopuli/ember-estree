/**
 * Shared Glimmer scope walking logic.
 *
 * Used by both the standalone scope analyzer (scope.js) and the
 * eslint-scope augmentation (eslint-scope.js). Each caller provides
 * callbacks that create the right scope/variable/reference objects
 * for their respective class systems.
 */

import { isKeyword } from "@glimmer/syntax";

/**
 * Walk an AST and invoke callbacks for Glimmer scope-relevant nodes.
 *
 * @param {object} program  The Program (or root) AST node
 * @param {object} visitorKeys  Merged visitor keys for the full AST
 * @param {object} callbacks
 * @param {(path: object) => object|null} callbacks.findScope
 *   Return the enclosing scope for a path, or null.
 * @param {(path: object, name: string) => { scope: object|null, variable?: object }} callbacks.findVariable
 *   Look up a variable by name walking parent scopes from path.
 * @param {(node: object, scope: object, variable?: object) => void} callbacks.addReference
 *   Register a read reference for node in scope, optionally resolved to variable.
 * @param {(node: object, upperScope: object, params: object[]) => void} callbacks.addBlockScope
 *   Create a new block scope on node with the given block param nodes.
 */
export function walkGlimmerScopes(program, visitorKeys, callbacks) {
  traverseAST(visitorKeys, program, (path) => {
    const node = path.node;
    if (!node) return;

    // GlimmerPathExpression with VarHead → variable reference
    if (node.type === "GlimmerPathExpression" && node.head?.type === "VarHead") {
      if (isKeyword(node.head.name)) return;
      const { scope, variable } = callbacks.findVariable(path, node.head.name);
      if (scope) {
        // Ensure parent is set — ESLint rules (e.g. no-undef) access identifier.parent
        node.head.parent = node;
        callbacks.addReference(node.head, scope, variable);
      }
    }

    // GlimmerElementNode with uppercase first part → component reference
    if (node.type === "GlimmerElementNode" && node.parts?.[0]) {
      const part = node.parts[0];
      const name = part.name;
      const skip =
        !name ||
        name === "this" ||
        name.startsWith(":") ||
        name.startsWith("@") ||
        name.includes("-") ||
        !/^[A-Z]/.test(name);
      if (!skip) {
        const { scope, variable } = callbacks.findVariable(path, name);
        if (scope) {
          callbacks.addReference(part, scope, variable);
        }
      }
    }

    // blockParamNodes → new scope with variable definitions
    if (node.blockParamNodes?.length > 0) {
      const upperScope = callbacks.findScope(path);
      if (upperScope) {
        callbacks.addBlockScope(node, upperScope, node.blockParamNodes);
      }
    }
  });
}

/**
 * DFS traversal of an AST using visitor keys.
 * Callers must pass a complete visitorKeys map covering every node type
 * the walk will encounter — unknown types are silently skipped.
 */
function traverseAST(visitorKeys, node, visitor) {
  const queue = [{ node, parent: null, parentKey: null, parentPath: null }];
  while (queue.length > 0) {
    const currentPath = queue.pop();
    visitor(currentPath);
    const keys = visitorKeys[currentPath.node?.type];
    if (!keys) continue;
    for (const key of keys) {
      const child = currentPath.node[key];
      if (!child) continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item?.type) {
            queue.push({
              node: item,
              parent: currentPath.node,
              parentKey: key,
              parentPath: currentPath,
            });
          }
        }
      } else if (child.type) {
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
