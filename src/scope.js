/**
 * Standalone scope analysis for Ember ESTree ASTs.
 *
 * Provides eslint-scope–compatible scope tracking that understands both
 * standard ESTree (JS/TS) nodes and Glimmer template nodes. Tracks
 * variable definitions, references, and resolution across the JS ↔ Glimmer
 * boundary.
 *
 * @example
 * ```js
 * import { toTree } from "ember-estree";
 * import { analyze } from "ember-estree/scope";
 *
 * const ast = toTree(source);
 * const scopeManager = analyze(ast);
 * const imported = scopeManager.globalScope.set.get("MyComponent");
 * ```
 */

import { visitorKeys as oxcVisitorKeys } from "oxc-parser";
import { glimmerVisitorKeys } from "./transforms.js";
import { walkGlimmerScopes } from "./scope-shared.js";

// ── Constants ────────────────────────────────────────────────────────────

const READ = 0x1;
const WRITE = 0x2;
const RW = READ | WRITE;

// ── Core Classes ─────────────────────────────────────────────────────────

export class Definition {
  /**
   * @param {string} type
   * @param {object} name  The identifier node
   * @param {object} node  The declaration node
   * @param {object} parent  The parent declaration
   * @param {number|null} [index]
   */
  constructor(type, name, node, parent, index = null) {
    this.type = type;
    this.name = name;
    this.node = node;
    this.parent = parent;
    this.index = index;
  }
}

export class Variable {
  /**
   * @param {string} name
   * @param {Scope} scope
   */
  constructor(name, scope) {
    this.name = name;
    this.scope = scope;
    /** @type {Definition[]} */
    this.defs = [];
    /** @type {Reference[]} */
    this.references = [];
    /** @type {object[]} */
    this.identifiers = [];
  }
}

export class Reference {
  /**
   * @param {object} identifier
   * @param {Scope} scope
   * @param {number} [flag]
   */
  constructor(identifier, scope, flag = READ) {
    this.identifier = identifier;
    this.from = scope;
    /** @type {Variable|null} */
    this.resolved = null;
    this.flag = flag;
  }

  get scope() {
    return this.from;
  }

  isRead() {
    return (this.flag & READ) !== 0;
  }

  isWrite() {
    return (this.flag & WRITE) !== 0;
  }

  isReadWrite() {
    return this.flag === RW;
  }
}

Reference.READ = READ;
Reference.WRITE = WRITE;
Reference.RW = RW;

export class Scope {
  /**
   * @param {string} type
   * @param {object} block
   * @param {Scope|null} upper
   * @param {boolean} [isStrict]
   */
  constructor(type, block, upper, isStrict = false) {
    this.type = type;
    this.block = block;
    this.upper = upper;
    this.isStrict = isStrict || (upper?.isStrict ?? false);
    /** @type {Scope[]} */
    this.childScopes = [];
    /** @type {Variable[]} */
    this.variables = [];
    /** @type {Reference[]} */
    this.references = [];
    /** @type {Reference[]} */
    this.through = [];
    /** @type {Map<string, Variable>} */
    this.set = new Map();
    if (upper) {
      upper.childScopes.push(this);
    }
  }
}

export class ScopeManager {
  constructor() {
    /** @type {Scope[]} */
    this.scopes = [];
    /** @type {Scope} */
    this.globalScope = null;
    /** @private */
    this._nodeToScope = new WeakMap();
    /** @private */
    this._innerNodeToScope = new WeakMap();
    /** @private */
    this._declaredVars = new WeakMap();
  }

  /**
   * @param {object} node
   * @param {boolean} [inner]
   * @returns {Scope|null}
   */
  acquire(node, inner) {
    if (inner) {
      return this._innerNodeToScope.get(node) ?? this._nodeToScope.get(node) ?? null;
    }
    return this._nodeToScope.get(node) ?? null;
  }

  /**
   * @param {object} node
   * @returns {Variable[]}
   */
  getDeclaredVariables(node) {
    return this._declaredVars.get(node) ?? [];
  }
}

// ── Analyze ──────────────────────────────────────────────────────────────

/**
 * Analyze an AST and return a ScopeManager with full scope information.
 *
 * @param {object} ast
 * @param {{ sourceType?: "module" | "script" }} [options]
 * @returns {ScopeManager}
 */
export function analyze(ast, options = {}) {
  const manager = new ScopeManager();
  const sourceType = options.sourceType ?? "module";

  const visitorKeys = {
    ...oxcVisitorKeys,
    File: ["program"],
    ...glimmerVisitorKeys,
    ...ast.visitorKeys,
  };

  let currentScope;
  const pendingRefs = [];

  // ── Scope helpers ──

  function registerScope(scope, node) {
    manager.scopes.push(scope);
    manager._nodeToScope.set(node, scope);
  }

  function pushScope(type, node) {
    const scope = new Scope(type, node, currentScope, currentScope?.isStrict);
    registerScope(scope, node);
    currentScope = scope;
    return scope;
  }

  function popScope() {
    currentScope = currentScope.upper;
  }

  function defineVariable(
    name,
    identifierNode,
    defType,
    declarationNode,
    parentNode,
    scope,
    index,
  ) {
    let variable = scope.set.get(name);
    if (!variable) {
      variable = new Variable(name, scope);
      scope.variables.push(variable);
      scope.set.set(name, variable);
    }
    const def = new Definition(defType, identifierNode, declarationNode, parentNode, index ?? null);
    variable.defs.push(def);
    variable.identifiers.push(identifierNode);
    const existing = manager._declaredVars.get(declarationNode);
    if (existing) {
      existing.push(variable);
    } else {
      manager._declaredVars.set(declarationNode, [variable]);
    }
    return variable;
  }

  function addReference(identifierNode, scope, flag) {
    const ref = new Reference(identifierNode, scope, flag ?? READ);
    scope.references.push(ref);
    pendingRefs.push({ ref, scope });
    return ref;
  }

  function findFunctionScope(scope) {
    let s = scope;
    while (s) {
      if (s.type === "function" || s.type === "module" || s.type === "global") return s;
      s = s.upper;
    }
    return scope;
  }

  function findModuleScope() {
    let s = currentScope;
    while (s) {
      if (s.type === "module" || s.type === "global") return s;
      s = s.upper;
    }
    return currentScope;
  }

  // ── Pattern destructuring ──

  function collectPatternIds(pattern, defType, declarationNode, parentNode, scope, startIndex) {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        defineVariable(
          pattern.name,
          pattern,
          defType,
          declarationNode,
          parentNode,
          scope,
          startIndex,
        );
        break;
      case "ObjectPattern":
        for (const prop of pattern.properties ?? []) {
          if (prop.type === "RestElement") {
            collectPatternIds(
              prop.argument,
              defType,
              declarationNode,
              parentNode,
              scope,
              startIndex,
            );
          } else {
            collectPatternIds(
              prop.value ?? prop,
              defType,
              declarationNode,
              parentNode,
              scope,
              startIndex,
            );
          }
        }
        break;
      case "ArrayPattern":
        for (let i = 0; i < (pattern.elements?.length ?? 0); i++) {
          const el = pattern.elements[i];
          if (el) {
            collectPatternIds(el, defType, declarationNode, parentNode, scope, startIndex + i);
          }
        }
        break;
      case "RestElement":
        collectPatternIds(
          pattern.argument,
          defType,
          declarationNode,
          parentNode,
          scope,
          startIndex,
        );
        break;
      case "AssignmentPattern":
        collectPatternIds(pattern.left, defType, declarationNode, parentNode, scope, startIndex);
        break;
    }
  }

  // ── Identifier role ──

  function shouldSkipIdentifier(node, parent, parentKey) {
    if (!parent || !parentKey) return false;
    if (parent.type === "MemberExpression" && parentKey === "property" && !parent.computed)
      return true;
    if (parent.type === "Property" && parentKey === "key" && !parent.computed && !parent.shorthand)
      return true;
    if (
      (parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
      parentKey === "key" &&
      !parent.computed
    )
      return true;
    if (parent.type === "ImportSpecifier" && parentKey === "imported") return true;
    if (parent.type === "ExportSpecifier" && parentKey === "exported") return true;
    if (
      (parent.type === "LabeledStatement" ||
        parent.type === "BreakStatement" ||
        parent.type === "ContinueStatement") &&
      parentKey === "label"
    )
      return true;
    if (
      (parent.type === "FunctionDeclaration" ||
        parent.type === "FunctionExpression" ||
        parent.type === "ClassDeclaration" ||
        parent.type === "ClassExpression") &&
      parentKey === "id"
    )
      return true;
    if (parent.type === "VariableDeclarator" && parentKey === "id") return true;
    if (parent.type === "CatchClause" && parentKey === "param") return true;
    if (
      (parent.type === "FunctionDeclaration" ||
        parent.type === "FunctionExpression" ||
        parent.type === "ArrowFunctionExpression") &&
      parentKey === "params"
    )
      return true;
    if (
      (parent.type === "ImportSpecifier" ||
        parent.type === "ImportDefaultSpecifier" ||
        parent.type === "ImportNamespaceSpecifier") &&
      parentKey === "local"
    )
      return true;
    if (parent.type?.startsWith("TS") && parentKey !== "init") return true;
    return false;
  }

  function getIdentifierFlag(parent, parentKey) {
    if (!parent) return READ;
    if (parent.type === "AssignmentExpression" && parentKey === "left") return WRITE;
    if (parent.type === "UpdateExpression" && parentKey === "argument") return RW;
    if (
      (parent.type === "ForInStatement" || parent.type === "ForOfStatement") &&
      parentKey === "left"
    )
      return WRITE;
    return READ;
  }

  // ── Node type sets ──

  const FUNCTION_TYPES = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);

  const BLOCK_SCOPE_PARENTS = new Set([
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "SwitchStatement",
  ]);

  // ── Main JS walk ──

  function visit(node, parent, parentKey) {
    if (!node || typeof node !== "object" || !node.type) return;

    let scopePushed = false;
    const nodeType = node.type;

    // File wraps Program
    if (nodeType === "File") {
      if (node.program) {
        visit(node.program, node, "program");
      }
      return;
    }

    // Program → module or global scope
    if (nodeType === "Program") {
      const scopeType = sourceType === "module" ? "module" : "global";
      const scope = new Scope(scopeType, node, null, sourceType === "module");
      registerScope(scope, node);
      manager.globalScope = scope;
      currentScope = scope;
      scopePushed = true;
    }

    // Functions
    else if (FUNCTION_TYPES.has(nodeType)) {
      if (nodeType === "FunctionDeclaration" && node.id?.name) {
        defineVariable(node.id.name, node.id, "FunctionName", node, parent, currentScope);
      }
      const funcScope = pushScope("function", node);
      manager._innerNodeToScope.set(node, funcScope);
      scopePushed = true;

      if (nodeType === "FunctionExpression" && node.id?.name) {
        defineVariable(node.id.name, node.id, "FunctionName", node, node, funcScope);
      }
      for (let i = 0; i < (node.params?.length ?? 0); i++) {
        collectPatternIds(node.params[i], "Parameter", node, node, funcScope, i);
      }
    }

    // Classes
    else if (nodeType === "ClassDeclaration" || nodeType === "ClassExpression") {
      if (nodeType === "ClassDeclaration" && node.id?.name) {
        defineVariable(node.id.name, node.id, "ClassName", node, parent, currentScope);
      }
      const classScope = pushScope("class", node);
      manager._innerNodeToScope.set(node, classScope);
      scopePushed = true;

      if (nodeType === "ClassExpression" && node.id?.name) {
        defineVariable(node.id.name, node.id, "ClassName", node, node, classScope);
      }
    }

    // Block scope (non-function parent)
    else if (nodeType === "BlockStatement" && parent && !FUNCTION_TYPES.has(parent.type)) {
      pushScope("block", node);
      scopePushed = true;
    }

    // For loops, switch
    else if (BLOCK_SCOPE_PARENTS.has(nodeType)) {
      pushScope("block", node);
      scopePushed = true;
    }

    // Catch clause
    else if (nodeType === "CatchClause") {
      pushScope("block", node);
      scopePushed = true;
      if (node.param) {
        collectPatternIds(node.param, "Parameter", node, node, currentScope, 0);
      }
    }

    // Variable declarations
    else if (nodeType === "VariableDeclaration") {
      const targetScope = node.kind === "var" ? findFunctionScope(currentScope) : currentScope;
      for (const decl of node.declarations ?? []) {
        if (decl.type === "VariableDeclarator" && decl.id) {
          collectPatternIds(decl.id, "Variable", decl, node, targetScope, 0);
        }
      }
    }

    // Import declarations
    else if (nodeType === "ImportDeclaration") {
      const moduleScope = findModuleScope();
      for (const spec of node.specifiers ?? []) {
        if (spec.local?.name) {
          defineVariable(spec.local.name, spec.local, "ImportBinding", spec, node, moduleScope);
        }
      }
    }

    // Identifiers (references)
    else if (nodeType === "Identifier") {
      if (!shouldSkipIdentifier(node, parent, parentKey)) {
        addReference(node, currentScope, getIdentifierFlag(parent, parentKey));
      }
    }

    // Glimmer nodes with blockParamNodes → scope (using plain `if`, not `else if`)
    if (
      node.blockParamNodes?.length > 0 &&
      nodeType.startsWith("Glimmer") &&
      !scopePushed // don't double-push if somehow already pushed
    ) {
      const glimmerScope = pushScope("glimmer-block", node);
      manager._innerNodeToScope.set(node, glimmerScope);
      scopePushed = true;
      for (let i = 0; i < node.blockParamNodes.length; i++) {
        const bp = node.blockParamNodes[i];
        defineVariable(bp.name, bp, "BlockParam", node, node, glimmerScope, i);
      }
    }

    // Recurse into children
    const keys = visitorKeys[nodeType];
    if (keys) {
      for (const key of keys) {
        const child = node[key];
        if (!child) continue;
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === "object" && item.type) {
              visit(item, node, key);
            }
          }
        } else if (typeof child === "object" && child.type) {
          visit(child, node, key);
        }
      }
    }

    if (scopePushed) {
      popScope();
    }
  }

  // Run JS walk
  visit(ast, null, null);

  // Run Glimmer walk (path expressions + component refs that aren't block-param-creating)
  walkGlimmerScopes(ast.program ?? ast, visitorKeys, {
    findScope(path) {
      let p = path;
      while (p) {
        const s = manager.acquire(p.node, true);
        if (s) return s;
        p = p.parentPath;
      }
      return null;
    },
    findVariable(path, name) {
      let currentScopeForPath = null;
      let p = path;
      while (p) {
        const s = manager.acquire(p.node, true);
        if (s) {
          if (!currentScopeForPath) currentScopeForPath = s;
          if (s.set.has(name)) {
            return { scope: currentScopeForPath, variable: s.set.get(name) };
          }
        }
        p = p.parentPath;
      }
      // Not found in any acquired scope, walk the scope chain from the nearest scope
      if (currentScopeForPath) {
        let s = currentScopeForPath.upper;
        while (s) {
          if (s.set.has(name)) {
            return { scope: currentScopeForPath, variable: s.set.get(name) };
          }
          s = s.upper;
        }
      }
      return { scope: currentScopeForPath };
    },
    addReference(node, scope, variable) {
      const ref = new Reference(node, scope, READ);
      if (variable) {
        ref.resolved = variable;
        variable.references.push(ref);
      } else {
        // Unresolved — push through to global
        let s = scope;
        while (s.upper) s = s.upper;
        s.through.push(ref);
      }
      scope.references.push(ref);
    },
    addBlockScope(_node, _upperScope, _params) {
      // Block scopes were already created during the JS walk above
      // (the visit() function handles blockParamNodes directly)
    },
  });

  // Resolve JS references
  for (const { ref, scope } of pendingRefs) {
    let s = scope;
    while (s) {
      const name = ref.identifier.name ?? ref.identifier.original;
      const variable = s.set.get(name);
      if (variable) {
        ref.resolved = variable;
        variable.references.push(ref);
        break;
      }
      s = s.upper;
    }
    if (!ref.resolved) {
      // Propagate through to the global scope
      let target = scope;
      while (target.upper) target = target.upper;
      target.through.push(ref);
    }
  }

  return manager;
}
