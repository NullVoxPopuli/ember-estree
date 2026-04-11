import { describe, expect, it } from "vitest";
import { toTree } from "../src/index.js";
import { analyze, ScopeManager, Scope, Variable, Reference, Definition } from "../src/scope.js";

function parse(source) {
  return toTree(source, { filePath: "test.gjs" });
}

// ── JS Scope Basics ──────────────────────────────────────────────────────

describe("JS scope basics", () => {
  it("creates a module scope for the program", () => {
    const ast = parse("const x = 1;");
    const mgr = analyze(ast);

    expect(mgr.globalScope).toBeDefined();
    expect(mgr.globalScope.type).toBe("module");
    expect(mgr.scopes.length).toBeGreaterThanOrEqual(1);
  });

  it("creates a global scope when sourceType is script", () => {
    const ast = parse("const x = 1;");
    const mgr = analyze(ast, { sourceType: "script" });

    expect(mgr.globalScope.type).toBe("global");
  });

  it("tracks import bindings in the module scope", () => {
    const ast = parse('import { Foo, Bar } from "my-lib";');
    const mgr = analyze(ast);

    expect(mgr.globalScope.set.has("Foo")).toBe(true);
    expect(mgr.globalScope.set.has("Bar")).toBe(true);
    expect(mgr.globalScope.set.get("Foo").defs[0].type).toBe("ImportBinding");
  });

  it("tracks default and namespace imports", () => {
    const ast = parse('import MyDefault from "a"; import * as ns from "b";');
    const mgr = analyze(ast);

    expect(mgr.globalScope.set.has("MyDefault")).toBe(true);
    expect(mgr.globalScope.set.has("ns")).toBe(true);
  });

  it("tracks const/let/var declarations", () => {
    const ast = parse("const a = 1; let b = 2;");
    const mgr = analyze(ast);

    expect(mgr.globalScope.set.has("a")).toBe(true);
    expect(mgr.globalScope.set.has("b")).toBe(true);
    expect(mgr.globalScope.set.get("a").defs[0].type).toBe("Variable");
  });

  it("tracks var in function scope (not block)", () => {
    const ast = parse("function foo() { var x = 1; }");
    const mgr = analyze(ast);

    expect(mgr.globalScope.set.has("foo")).toBe(true);
    expect(mgr.globalScope.set.has("x")).toBe(false);

    const funcScopes = mgr.scopes.filter((s) => s.type === "function");
    expect(funcScopes[0].set.has("x")).toBe(true);
  });

  it("tracks function and class declarations", () => {
    const ast = parse("function myFunc() {} class MyClass {}");
    const mgr = analyze(ast);

    expect(mgr.globalScope.set.get("myFunc").defs[0].type).toBe("FunctionName");
    expect(mgr.globalScope.set.get("MyClass").defs[0].type).toBe("ClassName");
  });

  it("tracks function parameters including destructuring", () => {
    const ast = parse("function foo(a, { b }, [c]) {}");
    const mgr = analyze(ast);

    const fScope = mgr.scopes.find((s) => s.type === "function");
    expect(fScope.set.has("a")).toBe(true);
    expect(fScope.set.has("b")).toBe(true);
    expect(fScope.set.has("c")).toBe(true);
  });

  it("tracks destructuring variable declarations", () => {
    const ast = parse("const { x, y } = obj; const [a, b] = arr;");
    const mgr = analyze(ast);

    for (const name of ["x", "y", "a", "b"]) {
      expect(mgr.globalScope.set.has(name)).toBe(true);
    }
  });

  it("resolves identifier references", () => {
    const ast = parse("const x = 1; console.log(x);");
    const mgr = analyze(ast);

    const x = mgr.globalScope.set.get("x");
    const readRef = x.references.find((r) => r.isRead());
    expect(readRef).toBeDefined();
    expect(readRef.resolved).toBe(x);
  });

  it("tracks unresolved references in through", () => {
    const ast = parse('console.log("hello");');
    const mgr = analyze(ast);

    const consoleRef = mgr.globalScope.through.find((r) => r.identifier.name === "console");
    expect(consoleRef).toBeDefined();
    expect(consoleRef.resolved).toBeNull();
  });

  it("handles arrow functions, catch, for-of", () => {
    const ast = parse("const fn = (a) => a; try {} catch (e) {} for (const x of []) {}");
    const mgr = analyze(ast);

    expect(mgr.scopes.filter((s) => s.type === "function").length).toBe(1);
    expect(mgr.scopes.some((s) => s.set.has("e"))).toBe(true);
    expect(mgr.scopes.some((s) => s.set.has("x"))).toBe(true);
  });

  it("scope.childScopes forms a tree", () => {
    const ast = parse("function outer() { function inner() {} }");
    const mgr = analyze(ast);

    const outerFunc = mgr.globalScope.childScopes.find((s) => s.type === "function");
    expect(outerFunc).toBeDefined();
    expect(outerFunc.childScopes.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Glimmer Scope ────────────────────────────────────────────────────────

describe("Glimmer scope", () => {
  it("resolves GlimmerPathExpression to an import", () => {
    const ast = parse(`
      import { myHelper } from 'my-lib';
      <template>{{myHelper}}</template>
    `);
    const mgr = analyze(ast);

    const v = mgr.globalScope.set.get("myHelper");
    expect(v).toBeDefined();
    expect(v.references.length).toBeGreaterThanOrEqual(1);
    expect(v.references[0].resolved).toBe(v);
  });

  it("resolves GlimmerElementNode component reference to an import", () => {
    const ast = parse(`
      import MyComponent from 'my-lib';
      <template><MyComponent /></template>
    `);
    const mgr = analyze(ast);

    const v = mgr.globalScope.set.get("MyComponent");
    expect(v).toBeDefined();
    expect(v.references.length).toBeGreaterThanOrEqual(1);
  });

  it("does not create references for lowercase/dashed elements", () => {
    const ast = parse("<template><div>hello</div><my-comp /></template>");
    const mgr = analyze(ast);

    const through = mgr.globalScope.through;
    expect(through.find((r) => r.identifier.name === "div")).toBeUndefined();
    expect(through.find((r) => r.identifier.name === "my-comp")).toBeUndefined();
  });

  it("skips Glimmer keywords", () => {
    const ast = parse("<template>{{#if true}}yes{{/if}}</template>");
    const mgr = analyze(ast);

    expect(mgr.globalScope.through.find((r) => r.identifier.name === "if")).toBeUndefined();
  });

  it("creates glimmer-block scope for block params", () => {
    const ast = parse(`
      import { items } from 'data';
      <template>{{#each items as |item|}}{{item}}{{/each}}</template>
    `);
    const mgr = analyze(ast);

    const glimmerScopes = mgr.scopes.filter((s) => s.type === "glimmer-block");
    expect(glimmerScopes.length).toBeGreaterThanOrEqual(1);

    const blockScope = glimmerScopes.find((s) => s.set.has("item"));
    expect(blockScope).toBeDefined();
    expect(blockScope.set.get("item").defs[0].type).toBe("BlockParam");
  });

  it("resolves references inside block to block params", () => {
    const ast = parse(`
      import { items } from 'data';
      <template>{{#each items as |item|}}{{item}}{{/each}}</template>
    `);
    const mgr = analyze(ast);

    const blockScope = mgr.scopes.find((s) => s.type === "glimmer-block" && s.set.has("item"));
    const itemVar = blockScope.set.get("item");
    expect(itemVar.references.length).toBeGreaterThanOrEqual(1);
    expect(itemVar.references[0].resolved).toBe(itemVar);
  });

  it("does not leak block params to sibling scope", () => {
    const ast = parse(`
      <template>
        {{#each items as |item|}}{{item}}{{/each}}
        {{item}}
      </template>
    `);
    const mgr = analyze(ast);

    // The outer {{item}} should be unresolved
    const unresolvedItem = mgr.globalScope.through.find(
      (r) => (r.identifier.name ?? r.identifier.original) === "item",
    );
    expect(unresolvedItem).toBeDefined();
  });

  it("handles named blocks and @-prefixed elements", () => {
    const ast = parse("<template><:content>hello</:content></template>");
    const mgr = analyze(ast);
    expect(mgr.scopes.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Cross-boundary ───────────────────────────────────────────────────────

describe("cross-boundary scope", () => {
  it("JS variable referenced in Glimmer template", () => {
    const ast = parse(`
      const greeting = "hello";
      <template>{{greeting}}</template>
    `);
    const mgr = analyze(ast);

    const v = mgr.globalScope.set.get("greeting");
    expect(v.references.filter((r) => r.isRead()).length).toBeGreaterThanOrEqual(1);
  });

  it("multiple templates share outer scope", () => {
    const ast = parse(`
      import { A, B } from 'lib';
      const x = <template><A /></template>;
      const y = <template><B /></template>;
    `);
    const mgr = analyze(ast);

    expect(mgr.globalScope.set.get("A").references.length).toBeGreaterThanOrEqual(1);
    expect(mgr.globalScope.set.get("B").references.length).toBeGreaterThanOrEqual(1);
  });
});

// ── API surface ──────────────────────────────────────────────────────────

describe("API surface", () => {
  it("acquire() returns scope for nodes", () => {
    const ast = parse("function foo() { const x = 1; }");
    const mgr = analyze(ast);

    const program = ast.program ?? ast;
    expect(mgr.acquire(program)).toBeDefined();
    expect(mgr.acquire(program).type).toBe("module");
  });

  it("acquire(node, true) returns inner scope", () => {
    const ast = parse("function foo() {}");
    const mgr = analyze(ast);

    const program = ast.program ?? ast;
    const funcNode = program.body.find((n) => n.type === "FunctionDeclaration");
    const inner = mgr.acquire(funcNode, true);
    expect(inner).toBeDefined();
    expect(inner.type).toBe("function");
  });

  it("getDeclaredVariables() works", () => {
    const ast = parse("const x = 1, y = 2;");
    const mgr = analyze(ast);

    const program = ast.program ?? ast;
    for (const decl of program.body[0].declarations) {
      expect(mgr.getDeclaredVariables(decl).length).toBe(1);
    }
  });

  it("Reference.isRead/isWrite/isReadWrite", () => {
    const ast = parse("let x = 1; x = 2; x;");
    const mgr = analyze(ast);

    const xVar = mgr.globalScope.set.get("x");
    expect(xVar.references.some((r) => r.isRead() && !r.isWrite())).toBe(true);
    expect(xVar.references.some((r) => r.isWrite())).toBe(true);
  });

  it("exports all expected classes", () => {
    expect(ScopeManager).toBeDefined();
    expect(Scope).toBeDefined();
    expect(Variable).toBeDefined();
    expect(Reference).toBeDefined();
    expect(Definition).toBeDefined();
    expect(analyze).toBeDefined();
    expect(Reference.READ).toBeDefined();
    expect(Reference.WRITE).toBeDefined();
  });
});
