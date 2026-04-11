/**
 * Augment an eslint-scope ScopeManager with Glimmer scope bindings.
 *
 * @example
 * ```js
 * import { analyze } from "eslint-scope";
 * import { registerGlimmerScopes } from "ember-estree/eslint-scope";
 *
 * const scopeManager = analyze(program, { ... });
 * registerGlimmerScopes(scopeManager);
 * ```
 */

import { Scope, Variable, Reference, Definition } from "eslint-scope";
import { visitorKeys as oxcVisitorKeys } from "oxc-parser";
import { glimmerVisitorKeys } from "./transforms.js";
import { walkGlimmerScopes } from "./scope-shared.js";

/**
 * Register Glimmer template scopes (path expressions, component references,
 * block params) into an existing eslint-scope ScopeManager.
 *
 * @param {import("eslint-scope").ScopeManager} scopeManager
 */
export function registerGlimmerScopes(scopeManager) {
  const program = scopeManager.globalScope.block;
  const visitorKeys = {
    ...oxcVisitorKeys,
    ...glimmerVisitorKeys,
    ...program.visitorKeys,
  };

  walkGlimmerScopes(program, visitorKeys, {
    findScope(path) {
      let p = path;
      while (p) {
        const scope = scopeManager.acquire(p.node, true);
        if (scope) return scope;
        p = p.parentPath;
      }
      return null;
    },

    findVariable(path, name) {
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
    },

    addReference(node, scope, variable) {
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
    },

    addBlockScope(node, upperScope, params) {
      const scope = new Scope(scopeManager, "block", upperScope, node, false);
      for (const [i, param] of params.entries()) {
        const v = new Variable(param.name, scope);
        v.identifiers.push(param);
        scope.variables.push(v);
        scope.set.set(param.name, v);
        v.defs.push(new Definition("Parameter", param, node, node, i, "Block Param"));
      }
    },
  });
}
