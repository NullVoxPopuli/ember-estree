import { describe, expect, it } from "vitest";
import { toTree, print } from "../src/index.js";

describe("print(File)", () => {
  it("prints the program of a File node", () => {
    const tree = toTree(`const a = 1;\nconst b = 2;`, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "const a = 1;
      const b = 2;"
    `);
  });

  it("prints an empty File", () => {
    const tree = toTree(``, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`""`);
  });

  it("weaves leading comments back in", () => {
    const tree = toTree(`// top comment\nconst a = 1;`, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "// top comment
      const a = 1;"
    `);
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

    expect(print(tree)).toMatchInlineSnapshot(`
      "/* setup */
      const a = 1;

      /**
       * doc comment
       */
      function f() {}"
    `);
  });

  it("weaves comments nested inside functions and classes, with indentation", () => {
    const source = [`function f() {`, `  // inner comment`, `  return 2;`, `}`].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "function f() {
        // inner comment
        return 2;
      }"
    `);
  });

  it("appends comments trailing the last statement", () => {
    const tree = toTree(`const a = 1;\n// trailing`, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "const a = 1;
      // trailing
      "
    `);
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

    expect(print(tree)).toMatchInlineSnapshot(`
      "// gjs comment
      import Component from "@glimmer/component";
      export default class D extends Component {
        /** field doc */
        name = "x";
        <template>Hi {{this.name}}</template>
      }"
    `);
  });

  it("does not leak comment state into later print calls", () => {
    const tree = toTree(`// only comment\nconst a = 1;`, { filePath: "m.js" });

    print(tree);

    // a later, unrelated print must not emit this file's comments
    expect(print({ type: "Identifier", name: "foo" })).toMatchInlineSnapshot(`"foo"`);
  });

  it("prints a File with no comments property", () => {
    const tree = toTree(`const a = 1;`, { filePath: "m.js" });

    delete tree.comments;

    expect(print(tree)).toMatchInlineSnapshot(`"const a = 1;"`);
  });
});

describe("print(File) blank-line preservation", () => {
  it("keeps blank lines between top-level statements", () => {
    const source = [`const a = 1;`, ``, `const b = 2;`, `const c = 3;`].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "const a = 1;

      const b = 2;
      const c = 3;"
    `);
  });

  it("keeps blank lines between import groups", () => {
    const source = [
      `import { getOwner } from "@ember/owner";`,
      `import * as QUnit from "qunit";`,
      ``,
      `import Application from "#app/app.js";`,
      `import config from "#config";`,
      ``,
      `export function start() {`,
      `  QUnit.start();`,
      `}`,
    ].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "import { getOwner } from "@ember/owner";
      import * as QUnit from "qunit";

      import Application from "#app/app.js";
      import config from "#config";

      export function start() {
        QUnit.start();
      }"
    `);
  });

  it("keeps blank lines inside function bodies and class bodies", () => {
    const source = [
      `class Foo {`,
      `  a = 1;`,
      ``,
      `  method() {`,
      `    const x = 1;`,
      ``,
      `    return x;`,
      `  }`,
      `}`,
    ].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "class Foo {
        a = 1;

        method() {
          const x = 1;

          return x;
        }
      }"
    `);
  });

  it("keeps a blank line that precedes a comment", () => {
    const source = [`const a = 1;`, ``, `// setup`, `const b = 2;`].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "const a = 1;

      // setup
      const b = 2;"
    `);
  });

  it("collapses runs of blank lines to a single blank line", () => {
    const source = [`const a = 1;`, ``, ``, ``, `const b = 2;`].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    expect(print(tree)).toMatchInlineSnapshot(`
      "const a = 1;

      const b = 2;"
    `);
  });

  it("does not affect standalone printing (no File in flight)", () => {
    const source = [`const a = 1;`, ``, `const b = 2;`].join("\n");
    const tree = toTree(source, { filePath: "m.js" });

    // printing the bare Program has no source attached, so statements
    // join with single newlines exactly as before
    expect(print(tree.program)).toMatchInlineSnapshot(`
      "const a = 1;
      const b = 2;"
    `);
  });
});
