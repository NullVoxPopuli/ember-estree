import { describe, expect, it } from "vitest";
import { statement, statements, toTree, print } from "../src/index.js";
import { findNode } from "./helpers.js";

describe("statement", () => {
  it("builds a single statement", () => {
    const node = statement`import setup from "some-package/entry";`;

    expect(node.type).toBe("ImportDeclaration");
    expect(print(node)).toBe(`import setup from "some-package/entry";`);
  });

  it("interpolates strings verbatim", () => {
    const local = "setupInspector";
    const node = statement`import ${local} from "some-package";`;

    expect(print(node)).toBe(`import setupInspector from "some-package";`);
  });

  it("interpolates AST nodes by printing them", () => {
    const callee = { type: "Identifier", name: "setup" };
    const node = statement`let x = ${callee}(this);`;

    expect(print(node)).toBe("let x = setup(this);");
  });

  it("interpolates arrays comma-separated", () => {
    const args = [
      { type: "Identifier", name: "a" },
      { type: "Identifier", name: "b" },
    ];
    const node = statement`call(${args});`;

    expect(print(node)).toBe("call(a, b);");
  });

  it("understands TypeScript syntax", () => {
    const node = statement`const x: number = 1;`;

    expect(print(node)).toBe("const x: number = 1;");
  });

  it("builds Glimmer nodes from <template>", () => {
    const node = statement`<template>Hello, {{@name}}!</template>`;

    expect(node.type).toBe("GlimmerTemplate");
    expect(print(node)).toBe("<template>Hello, {{@name}}!</template>");
  });

  it("supports plucking class members", () => {
    const klass = statement`class _ { inspector = setup(this); }`;
    const member = klass.body.body[0];

    expect(member.type).toBe("PropertyDefinition");
    expect(print(member)).toBe("inspector = setup(this);");
  });

  it("throws when the template contains more than one statement", () => {
    expect(() => statement`let a = 1; let b = 2;`).toThrowErrorMatchingInlineSnapshot(
      `[SyntaxError: expected exactly one statement, got 2]`,
    );
  });

  it("throws when the template contains no statements", () => {
    expect(() => statement``).toThrowErrorMatchingInlineSnapshot(
      `[SyntaxError: expected exactly one statement, got 0]`,
    );
  });

  it("throws on invalid source instead of returning a partial tree", () => {
    expect(() => statement`let let let`).toThrowError();
    // accepted by content-tag's scan, rejected by the JS parse
    expect(() => statement`return 5;`).toThrowError(/could not build AST/);
  });

  it("throws on null and undefined interpolations", () => {
    expect(() => statement`let x = ${null};`).toThrowError(TypeError);
    expect(() => statement`let x = ${undefined};`).toThrowError(TypeError);
  });
});

describe("statements", () => {
  it("builds every statement in the template", () => {
    const body = statements`
      import Component from "@glimmer/component";
      export default class extends Component {}
    `;

    expect(body.map((node) => node.type)).toEqual([
      "ImportDeclaration",
      "ExportDefaultDeclaration",
    ]);
  });

  it("returns an empty array for an empty template", () => {
    expect(statements``).toEqual([]);
  });
});

describe("built nodes carry no source positions", () => {
  function collectSourceKeys(node, found = new Set(), seen = new Set()) {
    if (!node || typeof node !== "object" || seen.has(node)) return found;
    seen.add(node);
    for (const key of Object.keys(node)) {
      if (["start", "end", "range", "loc", "parent"].includes(key)) {
        found.add(key);
      }
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) collectSourceKeys(item, found, seen);
      } else if (value && typeof value === "object") {
        collectSourceKeys(value, found, seen);
      }
    }
    return found;
  }

  it("scrubs positions recursively, including Glimmer subtrees", () => {
    const body = statements`
      const greeting = "hello";
      <template>{{greeting}}</template>
    `;

    for (const node of body) {
      expect([...collectSourceKeys(node)]).toEqual([]);
    }
  });

  it("does not disturb comment weaving when spliced into a parsed file", () => {
    const tree = toTree(
      [
        `// the application`,
        `import Application from "ember-strict-application-resolver";`,
        ``,
        `// the app class`,
        `export default class App extends Application {}`,
      ].join("\n"),
    );

    tree.program.body.splice(1, 0, statement`import setup from "some-package";`);

    const klass = findNode(tree, "ClassDeclaration");
    klass.body.body.push(statement`class _ { inspector = setup(this); }`.body.body[0]);

    expect(print(tree)).toMatchInlineSnapshot(`
      "// the application
      import Application from "ember-strict-application-resolver";
      import setup from "some-package";
      // the app class
      export default class App extends Application {
        inspector = setup(this);
      }"
    `);
  });
});
