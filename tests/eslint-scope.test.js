import { describe, expect, it } from "vitest";
import { toTree, glimmerVisitorKeys } from "../src/index.js";
import { analyze } from "eslint-scope";
import { registerGlimmerScopes } from "../src/eslint-scope.js";

const EXCLUDED_KEYS = ["parent", "loc", "range", "tokens", "comments"];

function parseAndAnalyze(source) {
  const ast = toTree(source, { filePath: "test.gjs" });
  const program = ast.program ?? ast;
  const visitorKeys = { ...ast.visitorKeys, ...glimmerVisitorKeys };

  const scopeManager = analyze(program, {
    ecmaVersion: 2024,
    sourceType: "module",
    childVisitorKeys: visitorKeys,
    fallback: (node) => Object.keys(node).filter((k) => !EXCLUDED_KEYS.includes(k)),
  });

  registerGlimmerScopes(scopeManager);
  return { scopeManager, program };
}

describe("registerGlimmerScopes", () => {
  it("registers GlimmerPathExpression references", () => {
    const { scopeManager } = parseAndAnalyze(`
      import { myHelper } from 'my-lib';
      <template>{{myHelper}}</template>
    `);

    const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
    const v = moduleScope.set.get("myHelper");
    expect(v).toBeDefined();

    // Should have at least one reference from the template
    expect(v.references.length).toBeGreaterThanOrEqual(1);
    const ref = v.references.find((r) => r.resolved === v);
    expect(ref).toBeDefined();
  });

  it("registers GlimmerElementNode component references", () => {
    const { scopeManager } = parseAndAnalyze(`
      import MyComponent from 'my-lib';
      <template><MyComponent /></template>
    `);

    const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
    const v = moduleScope.set.get("MyComponent");
    expect(v).toBeDefined();
    expect(v.references.length).toBeGreaterThanOrEqual(1);
  });

  it("skips Glimmer keywords", () => {
    const { scopeManager } = parseAndAnalyze(`
      <template>{{#if true}}yes{{/if}}</template>
    `);

    const globalScope = scopeManager.globalScope;
    const ifRef = globalScope.through.find(
      (r) => r.identifier?.name === "if" || r.identifier?.original === "if",
    );
    expect(ifRef).toBeUndefined();
  });

  it("skips lowercase and dashed elements", () => {
    const { scopeManager } = parseAndAnalyze(`
      <template><div>hello</div><my-comp /></template>
    `);

    const globalScope = scopeManager.globalScope;
    expect(globalScope.through.find((r) => r.identifier?.name === "div")).toBeUndefined();
  });

  it("creates block scopes for blockParamNodes", () => {
    const { scopeManager } = parseAndAnalyze(`
      import { items } from 'data';
      <template>{{#each items as |item|}}{{item}}{{/each}}</template>
    `);

    // Should have created a block scope with "item" variable
    const blockScope = scopeManager.scopes.find((s) => s.type === "block" && s.set.has("item"));
    expect(blockScope).toBeDefined();

    const itemVar = blockScope.set.get("item");
    expect(itemVar).toBeDefined();
    expect(itemVar.defs[0].type).toBe("Parameter");
  });

  it("resolves block param references", () => {
    const { scopeManager } = parseAndAnalyze(`
      import { items } from 'data';
      <template>{{#each items as |item|}}{{item}}{{/each}}</template>
    `);

    const blockScope = scopeManager.scopes.find((s) => s.type === "block" && s.set.has("item"));
    const itemVar = blockScope.set.get("item");

    // item should have references from inside the block
    expect(itemVar.references.length).toBeGreaterThanOrEqual(1);
    expect(itemVar.references[0].resolved).toBe(itemVar);
  });

  it("puts unresolved Glimmer refs in global through", () => {
    const { scopeManager } = parseAndAnalyze(`
      <template>{{unknownHelper}}</template>
    `);

    let globalScope = scopeManager.globalScope;
    const ref = globalScope.through.find(
      (r) => r.identifier?.name === "unknownHelper" || r.identifier?.original === "unknownHelper",
    );
    expect(ref).toBeDefined();
    expect(ref.resolved).toBeNull();
  });

  it("works with multiple templates", () => {
    const { scopeManager } = parseAndAnalyze(`
      import { A, B } from 'lib';
      const x = <template><A /></template>;
      const y = <template><B /></template>;
    `);

    const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
    expect(moduleScope.set.get("A").references.length).toBeGreaterThanOrEqual(1);
    expect(moduleScope.set.get("B").references.length).toBeGreaterThanOrEqual(1);
  });
});
