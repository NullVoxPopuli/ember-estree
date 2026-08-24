import { describe, expect, it } from "vitest";
import { parse } from "../src/index.js";
import { findNode, findAllNodes } from "./helpers.js";

describe("parse", () => {
  it("returns an AST with type File", () => {
    const source = `const x = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);
    expect(ast.type).toBe("File");
  });

  it("parses plain JS without templates", () => {
    const source = `const x = 1; export default x;`;
    const ast = parse(source);
    expect(ast.type).toBe("File");
  });

  it("returns an AST with a program body", () => {
    const source = `const x = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);
    expect(ast.program).toBeDefined();
    expect(ast.program.body.length).toBeGreaterThan(0);
  });

  it("ensures JS nodes have start/end properties", () => {
    const source = `const x = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);

    function checkStartEnd(node, visited = new Set()) {
      if (!node || typeof node !== "object" || visited.has(node)) return;
      visited.add(node);
      // Only check JS/TS nodes (those with numeric start/end from babel)
      if (node.type && typeof node.start === "number" && typeof node.end === "number") {
        expect(node.start).toBeLessThanOrEqual(node.end);
      }
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "parent") continue;
        const val = node[key];
        if (Array.isArray(val)) {
          for (const item of val) {
            checkStartEnd(item, visited);
          }
        } else if (val && typeof val === "object" && val.type) {
          checkStartEnd(val, visited);
        }
      }
    }
    checkStartEnd(ast);
  });

  it("parent links are present on Glimmer nodes but non-enumerable", () => {
    const source = `const x = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);
    const h1 = findNode(ast, "GlimmerElementNode");
    expect(h1.parent).toBeDefined();
    // Non-enumerable so JSON, Object.keys, and snapshots skip the cycle.
    expect(Object.prototype.propertyIsEnumerable.call(h1, "parent")).toBe(false);
    expect(() => JSON.stringify(ast)).not.toThrow();
  });

  it("parses Glimmer template nodes into the AST", () => {
    const source = `const Greeting = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);

    const template = findNode(ast, "GlimmerTemplate");
    expect(template).toBeTruthy();

    const element = findNode(ast, "GlimmerElementNode");
    expect(element).toBeTruthy();

    const elements = findAllNodes(ast, "GlimmerElementNode");
    const h1 = elements.find((e) => e.tag === "h1");
    expect(h1).toBeTruthy();
    expect(h1.tag).toBe("h1");
  });

  it("parses Glimmer mustache statements", () => {
    const source = `const x = <template><div>{{@name}}</div></template>;`;
    const ast = parse(source);

    const mustache = findNode(ast, "GlimmerMustacheStatement");
    expect(mustache).toBeTruthy();
  });

  it("resolves class body templates into GlimmerTemplate nodes", () => {
    const source = `export default class MyComponent extends Component {
  <template><h1>Hello</h1></template>
}`;
    const ast = parse(source);

    const classDecl = findNode(ast, "ClassDeclaration");
    expect(classDecl).toBeTruthy();

    const template = findNode(ast, "GlimmerTemplate");
    expect(template).toBeTruthy();
    expect(template.type).toBe("GlimmerTemplate");

    // Template should be in the class body
    expect(classDecl.body.body[0]).toBe(template);

    // Template should contain the element
    const h1 = findNode(template, "GlimmerElementNode");
    expect(h1).toBeTruthy();
    expect(h1.tag).toBe("h1");
  });

  it("class body templates have correct byte offsets", () => {
    const source = `export default class MyComponent extends Component {
  <template><h1>Hello</h1></template>
}`;
    const ast = parse(source);

    const template = findNode(ast, "GlimmerTemplate");
    expect(template).toBeTruthy();

    // Byte offsets should correspond to the <template>...</template> in the source
    expect(source.substring(template.start, template.end)).toBe(
      "<template><h1>Hello</h1></template>",
    );
    expect(template.range[0]).toBe(template.start);
    expect(template.range[1]).toBe(template.end);
  });

  it("class body templates coexist with class methods", () => {
    const source = `class Greeting extends Component {
  get name() { return this.args.name; }
  <template><h1>Hello {{@name}}</h1></template>
}`;
    const ast = parse(source);

    const classDecl = findNode(ast, "ClassDeclaration");
    expect(classDecl.body.body.length).toBe(2);
    expect(classDecl.body.body[0].type).toBe("MethodDefinition");
    expect(classDecl.body.body[1].type).toBe("GlimmerTemplate");

    const mustache = findNode(ast, "GlimmerMustacheStatement");
    expect(mustache).toBeTruthy();
  });

  it("handles a template in a heritage clause before the class body template", () => {
    // content-tag reports these two templates in the opposite order from
    // their position in the source.
    const source = [
      "const mixin = (base, t) => base;",
      "export class Both extends mixin(Object, <template>heritage</template>) {",
      "  <template>own</template>",
      "}",
      "const after = 1;",
    ].join("\n");
    const ast = parse(source);

    expect(ast.program.body.map((node) => node.type)).toEqual([
      "VariableDeclaration",
      "ExportNamedDeclaration",
      "VariableDeclaration",
    ]);
    const templates = findAllNodes(ast, "GlimmerTemplate");
    expect(templates.map((t) => source.slice(t.start, t.end))).toEqual([
      "<template>heritage</template>",
      "<template>own</template>",
    ]);
  });

  it("handles multiple classes with templates", () => {
    const source = `class A extends Component {
  <template><div>A</div></template>
}
class B extends Component {
  <template><div>B</div></template>
}`;
    const ast = parse(source);

    const templates = findAllNodes(ast, "GlimmerTemplate");
    expect(templates.length).toBe(2);
  });

  // ember-tooling/ember-eslint-parser#230: backticks/dollars in template
  // content used to be backslash-escaped in the placeholder JS, growing it
  // past the original region once the escapes exceeded the padding slack
  // (11 chars for class members, 19 for expressions). The end-range check
  // in matchPlaceholder then failed and the raw placeholder StaticBlock/
  // TemplateLiteral leaked into the AST with every later offset shifted.
  describe("placeholder-hostile template content (` and $)", () => {
    function expectSingleTemplate(source, expected) {
      const ast = parse(source);
      const template = findNode(ast, "GlimmerTemplate");
      expect(template).toBeTruthy();
      expect(source.substring(template.start, template.end)).toBe(expected);
      expect(findNode(ast, "StaticBlock")).toBeNull();
      expect(findNode(ast, "TemplateLiteral")).toBeNull();
    }

    it("class body template with many backticks in a comment", () => {
      const tpl = `<template>
    {{!  \`asd\` \`qwe\` \`zxc\` \`undefined\` \`asd\` }}
    {{! \`@foo\` }}
    123
  </template>`;
      const source = `export default class MyComponent extends Component {
  ${tpl}
}`;
      const ast = parse(source);

      const classDecl = findNode(ast, "ClassDeclaration");
      expect(classDecl.body.body.length).toBe(1);
      expect(classDecl.body.body[0].type).toBe("GlimmerTemplate");
      expect(source.substring(classDecl.body.body[0].start, classDecl.body.body[0].end)).toBe(tpl);
    });

    it("class body template with many dollar signs", () => {
      const tpl = `<template>{{! ${"$".repeat(30)} }}</template>`;
      const source = `export default class MyComponent extends Component {
  ${tpl}
}`;
      expectSingleTemplate(source, tpl);
    });

    it("expression template with many backticks", () => {
      const tpl = `<template>{{! ${"`x` ".repeat(10)}}}</template>`;
      const source = `const x = ${tpl};`;
      expectSingleTemplate(source, tpl);
    });

    it("keeps offsets accurate for code after a backtick-heavy template", () => {
      const tpl = `<template>{{! ${"`".repeat(30)} }}</template>`;
      const source = `export default class MyComponent extends Component {
  ${tpl}
}
const after = 1;`;
      const ast = parse(source);

      const decl = findNode(ast, "VariableDeclaration");
      expect(decl).toBeTruthy();
      expect(source.substring(decl.start, decl.end)).toBe("const after = 1;");
    });
  });
});
