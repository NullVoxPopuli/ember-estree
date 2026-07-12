import { describe, expect, it } from "vitest";
import { toTree, print } from "../src/index.js";

describe("print(File)", () => {
  it("prints the program of a File node", () => {
    const tree = toTree(`const a = 1;\nconst b = 2;`, { filePath: "m.js" });

    expect(print(tree)).toBe(`const a = 1;\nconst b = 2;`);
  });

  it("prints an empty File", () => {
    const tree = toTree(``, { filePath: "m.js" });

    expect(print(tree)).toBe(``);
  });

  it("weaves leading comments back in", () => {
    const tree = toTree(`// top comment\nconst a = 1;`, { filePath: "m.js" });

    expect(print(tree)).toBe(`// top comment\nconst a = 1;`);
  });

  it("weaves block and doc comments back in", () => {
    const source = [
      `/* setup */`,
      `const a = 1;`,
      `/**`,
      ` * doc comment`,
      ` */`,
      `function f() {}`,
    ].join("\n");
    const tree = toTree(source, { filePath: "m.js" });
    const output = print(tree);

    expect(output).toContain(`/* setup */`);
    expect(output).toContain(`/**\n * doc comment\n */`);
    expect(output.indexOf(`/* setup */`)).toBeLessThan(output.indexOf(`const a = 1;`));
    expect(output.indexOf(`doc comment`)).toBeLessThan(output.indexOf(`function f()`));
  });

  it("weaves comments nested inside functions and classes, with indentation", () => {
    const source = [`function f() {`, `  // inner comment`, `  return 2;`, `}`].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    expect(print(tree)).toBe(
      [`function f() {`, `  // inner comment`, `  return 2;`, `}`].join("\n"),
    );
  });

  it("appends comments trailing the last statement", () => {
    const tree = toTree(`const a = 1;\n// trailing`, { filePath: "m.js" });

    expect(print(tree)).toBe(`const a = 1;\n// trailing\n`);
  });

  it("keeps comments in gjs files alongside templates", () => {
    const source = [
      `// gjs comment`,
      `import Component from "@glimmer/component";`,
      `export default class D extends Component {`,
      `  /** field doc */`,
      `  name = "x";`,
      `  <template>Hi {{this.name}}</template>`,
      `}`,
    ].join("\n");
    const tree = toTree(source, { filePath: "m.gjs" });
    const output = print(tree);

    expect(output).toContain(`// gjs comment`);
    expect(output).toContain(`/** field doc */`);
    expect(output).toContain(`<template>Hi {{this.name}}</template>`);
    expect(output.indexOf(`// gjs comment`)).toBeLessThan(output.indexOf(`import Component`));
    expect(output.indexOf(`/** field doc */`)).toBeLessThan(output.indexOf(`name = "x"`));
  });

  it("does not leak comment state into later print calls", () => {
    const tree = toTree(`// only comment\nconst a = 1;`, { filePath: "m.js" });

    print(tree);

    // a later, unrelated print must not emit this file's comments
    expect(print({ type: "Identifier", name: "foo" })).toBe("foo");
  });

  it("prints a File with no comments property", () => {
    const tree = toTree(`const a = 1;`, { filePath: "m.js" });

    delete tree.comments;

    expect(print(tree)).toBe(`const a = 1;`);
  });
});
