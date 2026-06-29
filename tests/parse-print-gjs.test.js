import { describe, expect, it } from "vitest";
import { parse, print } from "../src/index.js";
import { findAllNodes } from "./helpers.js";

describe("parse + print (.gjs)", () => {
  it("round-trips a simple gjs template", () => {
    const source = `const Greeting = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);
    expect(ast.type).toBe("File");
    expect(ast.program.body.length).toBeGreaterThan(0);
  });

  it("parses and identifies Glimmer nodes in gjs", () => {
    const source = `const x = <template><div class="main">content</div></template>;`;
    const ast = parse(source);

    const templates = findAllNodes(ast, "GlimmerTemplate");
    expect(templates.length).toBeGreaterThan(0);

    const elements = findAllNodes(ast, "GlimmerElementNode");
    const div = elements.find((e) => e.tag === "div");
    expect(div).toBeTruthy();
  });

  it("can print a GlimmerTemplate node", () => {
    const node = {
      type: "GlimmerTemplate",
      body: [
        {
          type: "GlimmerElementNode",
          tag: "br",
          attributes: [],
          modifiers: [],
          children: [],
          selfClosing: true,
        },
      ],
    };
    const printed = print(node);
    expect(printed).toContain("<template>");
    expect(printed).toContain("</template>");
    expect(printed).toContain("<br />");
  });

  it("round-trips block params on a block statement", () => {
    const source = `const A = <template>{{#each this.items as |item index|}}{{item}}{{index}}{{/each}}</template>;`;
    expect(print(parse(source).program)).toBe(source);
  });

  it("round-trips block params on an element", () => {
    const source = `const A = <template><Foo as |bar baz|>{{bar}}</Foo></template>;`;
    expect(print(parse(source).program)).toBe(source);
  });

  it("round-trips a parenthesized JS expression", () => {
    const source = `const x = (a + b) * c;`;
    expect(print(parse(source).program)).toBe(source);
  });

  it("handles multiple templates in a single gjs file", () => {
    const source = `
const A = <template><h1>A</h1></template>;
const B = <template><h2>B</h2></template>;
`;
    const ast = parse(source);

    const templates = findAllNodes(ast, "GlimmerTemplate");
    expect(templates.length).toBe(2);
  });

  it("handles gjs with imports", () => {
    const source = `
import { helper } from 'my-addon';
const Comp = <template>Hello</template>;
`;
    const ast = parse(source);
    expect(ast.type).toBe("File");
    expect(ast.program.body.length).toBeGreaterThan(1);
  });

  it("finds text content inside templates", () => {
    const source = `const x = <template>Hello world</template>;`;
    const ast = parse(source);

    const textNodes = findAllNodes(ast, "GlimmerTextNode");
    const hello = textNodes.find((t) => t.chars && t.chars.includes("Hello"));
    expect(hello).toBeTruthy();
  });

  it("finds element attributes in parsed templates", () => {
    const source = `const x = <template><div class="main"></div></template>;`;
    const ast = parse(source);

    const attrNodes = findAllNodes(ast, "GlimmerAttrNode");
    expect(attrNodes.length).toBeGreaterThan(0);
    expect(attrNodes[0].name).toBe("class");
  });

  it("handles Unicode in import path", () => {
    const source = `import { helper } from 'ünïcödé-addon';
const Comp = <template>Hello</template>;`;
    const ast = parse(source);

    expect(ast.type).toBe("File");
    const importDecl = ast.program.body[0];
    expect(importDecl.type).toBe("ImportDeclaration");
    expect(importDecl.source.value).toBe("ünïcödé-addon");

    // The template node should have correct positional data despite the
    // Unicode characters in the preceding import path.
    const template = ast.program.body[1].declarations[0].init;
    expect(template.type).toBe("GlimmerTemplate");
    expect(source.slice(template.start, template.end)).toBe("<template>Hello</template>");
    expect(template.loc.start.line).toBe(2);
    expect(template.loc.start.column).toBe(13);

    const textNode = template.body[0];
    expect(textNode.type).toBe("GlimmerTextNode");
    expect(source.slice(textNode.start, textNode.end)).toBe("Hello");
  });

  it("handles Unicode in template tag body", () => {
    const source = `const Greeting = <template>こんにちは</template>;`;
    const ast = parse(source);

    expect(ast.type).toBe("File");
    const textNodes = findAllNodes(ast, "GlimmerTextNode");
    const unicodeText = textNodes.find((t) => t.chars === "こんにちは");
    expect(unicodeText).toBeTruthy();
    expect(unicodeText.chars).toBe("こんにちは");

    // Positional data must correctly span the multi-byte Unicode content.
    const template = ast.program.body[0].declarations[0].init;
    expect(template.type).toBe("GlimmerTemplate");
    expect(source.slice(template.start, template.end)).toBe("<template>こんにちは</template>");
    expect(template.loc.start).toEqual({ line: 1, column: 17 });

    expect(source.slice(unicodeText.start, unicodeText.end)).toBe("こんにちは");
    expect(unicodeText.loc.start).toEqual({ line: 1, column: 27 });
  });

  it("handles Unicode in a string literal", () => {
    const source = `const msg = '你好世界';
const Comp = <template>Hello</template>;`;
    const ast = parse(source);

    expect(ast.type).toBe("File");
    const msgDecl = ast.program.body[0];
    expect(msgDecl.type).toBe("VariableDeclaration");
    expect(msgDecl.declarations[0].init.value).toBe("你好世界");

    // The template node must have correct positional data despite the
    // Unicode characters in the preceding string literal.
    const template = ast.program.body[1].declarations[0].init;
    expect(template.type).toBe("GlimmerTemplate");
    expect(source.slice(template.start, template.end)).toBe("<template>Hello</template>");
    expect(template.loc.start.line).toBe(2);
    expect(template.loc.start.column).toBe(13);

    const textNode = template.body[0];
    expect(textNode.type).toBe("GlimmerTextNode");
    expect(source.slice(textNode.start, textNode.end)).toBe("Hello");
  });

  it("handles Unicode in import path, template body, and string all together", () => {
    const source = `import { t } from '🌍-i18n';
const greeting = '¡Héllo Wörld!';
const Comp = <template>مرحبا بالعالم</template>;`;
    const ast = parse(source);

    expect(ast.type).toBe("File");

    const importDecl = ast.program.body[0];
    expect(importDecl.type).toBe("ImportDeclaration");
    expect(importDecl.source.value).toBe("🌍-i18n");

    const varDecl = ast.program.body[1];
    expect(varDecl.type).toBe("VariableDeclaration");
    expect(varDecl.declarations[0].init.value).toBe("¡Héllo Wörld!");

    const textNodes = findAllNodes(ast, "GlimmerTextNode");
    const arabicText = textNodes.find((t) => t.chars === "مرحبا بالعالم");
    expect(arabicText).toBeTruthy();
    expect(arabicText.chars).toBe("مرحبا بالعالم");

    // The template and its text content must have correct positional data
    // despite multi-byte Unicode characters in the preceding lines.
    const template = ast.program.body[2].declarations[0].init;
    expect(template.type).toBe("GlimmerTemplate");
    expect(source.slice(template.start, template.end)).toBe("<template>مرحبا بالعالم</template>");
    expect(template.loc.start.line).toBe(3);
    expect(template.loc.start.column).toBe(13);

    expect(source.slice(arabicText.start, arabicText.end)).toBe("مرحبا بالعالم");
    expect(arabicText.loc.start.line).toBe(3);
    expect(arabicText.loc.start.column).toBe(23);
  });
});
