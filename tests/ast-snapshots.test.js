import { describe, expect, it } from "vitest";
import { parse } from "../src/index.js";

/**
 * Recursively strip `loc`, `start`, `end`, `range`, `parent`, and `errors` from an AST
 * to make snapshots more readable.
 */
function stripPositions(node, visited = new Set()) {
  if (!node || typeof node !== "object" || visited.has(node)) return node;
  visited.add(node);

  if (Array.isArray(node)) {
    return node.map((item) => stripPositions(item, visited));
  }

  const result = {};
  for (const [key, val] of Object.entries(node)) {
    if (
      [
        "loc",
        "start",
        "end",
        "range",
        "parent",
        "errors",
        "leadingComments",
        "trailingComments",
        "innerComments",
        "tokens",
        "contents",
      ].includes(key)
    )
      continue;
    if (val && typeof val === "object") {
      result[key] = stripPositions(val, visited);
    } else {
      result[key] = val;
    }
  }
  return result;
}

describe("AST snapshots — individual Glimmer nodes", () => {
  it("GlimmerTemplate root", () => {
    const ast = parse(`const x = <template>hello</template>;`);
    const program = ast.program;
    const decl = program.body[0];
    const template = decl.declarations[0].init;

    expect(template.type).toBe("GlimmerTemplate");
    expect(stripPositions(template)).toMatchInlineSnapshot(`
      {
        "blockParamNodes": [],
        "blockParams": [],
        "body": [
          {
            "chars": "hello",
            "type": "GlimmerTextNode",
            "value": "hello",
          },
        ],
        "comments": [],
        "type": "GlimmerTemplate",
      }
    `);
  });

  it("GlimmerElementNode with text child", () => {
    const ast = parse(`const x = <template><h1>Hello</h1></template>;`);
    const template = ast.program.body[0].declarations[0].init;
    const element = template.body[0];

    expect(element.type).toBe("GlimmerElementNode");
    expect(stripPositions(element)).toMatchInlineSnapshot(`
      {
        "attributes": [],
        "blockParamNodes": [],
        "blockParams": [],
        "children": [
          {
            "chars": "Hello",
            "type": "GlimmerTextNode",
            "value": "Hello",
          },
        ],
        "comments": [],
        "modifiers": [],
        "name": "h1",
        "parts": [
          {
            "name": "h1",
            "original": "h1",
            "type": "GlimmerElementNodePart",
          },
        ],
        "selfClosing": false,
        "tag": "h1",
        "type": "GlimmerElementNode",
      }
    `);
  });

  it("GlimmerElementNode self-closing", () => {
    const ast = parse(`const x = <template><br /></template>;`);
    const template = ast.program.body[0].declarations[0].init;
    const br = template.body[0];

    expect(br.type).toBe("GlimmerElementNode");
    expect(br.selfClosing).toBe(true);
    expect(br.tag).toBe("br");
    expect(br.children).toEqual([]);
  });

  it("GlimmerMustacheStatement", () => {
    const ast = parse(`const x = <template>{{@name}}</template>;`);
    const template = ast.program.body[0].declarations[0].init;
    const mustache = template.body[0];

    expect(mustache.type).toBe("GlimmerMustacheStatement");
    expect(stripPositions(mustache)).toMatchInlineSnapshot(`
      {
        "escaped": true,
        "hash": null,
        "params": [],
        "path": {
          "_head": {
            "name": "@name",
            "type": "AtHead",
          },
          "data": true,
          "original": "@name",
          "parts": [
            "name",
          ],
          "this": false,
          "type": "GlimmerPathExpression",
        },
        "strip": {
          "close": false,
          "open": false,
        },
        "trusting": false,
        "type": "GlimmerMustacheStatement",
      }
    `);
  });

  it("GlimmerAttrNode", () => {
    const ast = parse(`const x = <template><div class="main"></div></template>;`);
    const template = ast.program.body[0].declarations[0].init;
    const element = template.body[0];
    const attr = element.attributes[0];

    expect(attr.type).toBe("GlimmerAttrNode");
    expect(stripPositions(attr)).toMatchInlineSnapshot(`
      {
        "isValueless": false,
        "name": "class",
        "quoteType": """,
        "type": "GlimmerAttrNode",
        "value": {
          "chars": "main",
          "type": "GlimmerTextNode",
          "value": "main",
        },
      }
    `);
  });

  it("GlimmerBlockStatement (each)", () => {
    const ast = parse(
      `const x = <template>{{#each @items as |item|}}{{item}}{{/each}}</template>;`,
    );
    const template = ast.program.body[0].declarations[0].init;
    const block = template.body[0];

    expect(block.type).toBe("GlimmerBlockStatement");
    expect(block.path.type).toBe("GlimmerPathExpression");
    expect(block.path.original).toBe("each");
    expect(block.params[0].type).toBe("GlimmerPathExpression");
    expect(block.params[0].original).toBe("@items");
  });
});

describe("AST snapshots — full templates (positions stripped)", () => {
  it("simple component with text", () => {
    const source = `const Greeting = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);
    const template = ast.program.body[0].declarations[0].init;

    expect(stripPositions(template)).toMatchInlineSnapshot(`
      {
        "blockParamNodes": [],
        "blockParams": [],
        "body": [
          {
            "attributes": [],
            "blockParamNodes": [],
            "blockParams": [],
            "children": [
              {
                "chars": "Hello",
                "type": "GlimmerTextNode",
                "value": "Hello",
              },
            ],
            "comments": [],
            "modifiers": [],
            "name": "h1",
            "parts": [
              {
                "name": "h1",
                "original": "h1",
                "type": "GlimmerElementNodePart",
              },
            ],
            "selfClosing": false,
            "tag": "h1",
            "type": "GlimmerElementNode",
          },
        ],
        "comments": [],
        "type": "GlimmerTemplate",
      }
    `);
  });

  it("element with attributes and mustache", () => {
    const source = `const x = <template><div class="main">{{@content}}</div></template>;`;
    const ast = parse(source);
    const template = ast.program.body[0].declarations[0].init;

    expect(stripPositions(template)).toMatchInlineSnapshot(`
      {
        "blockParamNodes": [],
        "blockParams": [],
        "body": [
          {
            "attributes": [
              {
                "isValueless": false,
                "name": "class",
                "quoteType": """,
                "type": "GlimmerAttrNode",
                "value": {
                  "chars": "main",
                  "type": "GlimmerTextNode",
                  "value": "main",
                },
              },
            ],
            "blockParamNodes": [],
            "blockParams": [],
            "children": [
              {
                "escaped": true,
                "hash": null,
                "params": [],
                "path": {
                  "_head": {
                    "name": "@content",
                    "type": "AtHead",
                  },
                  "data": true,
                  "original": "@content",
                  "parts": [
                    "content",
                  ],
                  "this": false,
                  "type": "GlimmerPathExpression",
                },
                "strip": {
                  "close": false,
                  "open": false,
                },
                "trusting": false,
                "type": "GlimmerMustacheStatement",
              },
            ],
            "comments": [],
            "modifiers": [],
            "name": "div",
            "parts": [
              {
                "name": "div",
                "original": "div",
                "type": "GlimmerElementNodePart",
              },
            ],
            "selfClosing": false,
            "tag": "div",
            "type": "GlimmerElementNode",
          },
        ],
        "comments": [],
        "type": "GlimmerTemplate",
      }
    `);
  });
});

describe("AST snapshots — ranges and locs", () => {
  it("node ranges are correct byte offsets into the source", () => {
    const source = `const x = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);
    const template = ast.program.body[0].declarations[0].init;

    // GlimmerTemplate range covers the full <template>...</template>
    expect(template.type).toBe("GlimmerTemplate");
    expect(source.slice(template.start, template.end)).toBe("<template><h1>Hello</h1></template>");

    // GlimmerElementNode range covers <h1>Hello</h1>
    const h1 = template.body[0];
    expect(h1.type).toBe("GlimmerElementNode");
    expect(source.slice(h1.start, h1.end)).toBe("<h1>Hello</h1>");

    // GlimmerTextNode range covers "Hello"
    const text = h1.children[0];
    expect(text.type).toBe("GlimmerTextNode");
    expect(source.slice(text.start, text.end)).toBe("Hello");
  });

  it("node locs have correct line/column", () => {
    const source = `const x = <template><h1>Hello</h1></template>;`;
    const ast = parse(source);
    const template = ast.program.body[0].declarations[0].init;

    // Template starts at column 10
    expect(template.loc.start).toEqual({ line: 1, column: 10 });

    // h1 starts at column 20
    const h1 = template.body[0];
    expect(h1.loc.start).toEqual({ line: 1, column: 20 });
  });

  it("multi-line template has correct locs", () => {
    const source = `const x = <template>
  <h1>Hello</h1>
</template>;`;
    const ast = parse(source);
    const template = ast.program.body[0].declarations[0].init;

    // Template starts at line 1, column 10
    expect(template.loc.start).toEqual({ line: 1, column: 10 });
    // Template ends at line 3, column 11
    expect(template.loc.end).toEqual({ line: 3, column: 11 });

    // h1 is on line 2
    const h1 = template.body[0];
    expect(h1.loc.start.line).toBe(2);
  });

  it("multiple templates have correct independent ranges", () => {
    const source = `const A = <template><p>first</p></template>;
const B = <template><p>second</p></template>;`;
    const ast = parse(source);

    const templateA = ast.program.body[0].declarations[0].init;
    const templateB = ast.program.body[1].declarations[0].init;

    expect(source.slice(templateA.start, templateA.end)).toBe("<template><p>first</p></template>");
    expect(source.slice(templateB.start, templateB.end)).toBe("<template><p>second</p></template>");
  });

  it("PathExpression head has correct range", () => {
    const source = `const x = <template>{{@name}}</template>;`;
    const ast = parse(source);
    const template = ast.program.body[0].declarations[0].init;
    const mustache = template.body[0];
    const path = mustache.path;

    expect(path.type).toBe("GlimmerPathExpression");
    expect(source.slice(path.start, path.end)).toBe("@name");
  });

  it("ElementNode parts have correct range", () => {
    const source = `const x = <template><MyComponent /></template>;`;
    const ast = parse(source);
    const template = ast.program.body[0].declarations[0].init;
    const element = template.body[0];

    expect(element.parts.length).toBe(1);
    expect(element.parts[0].type).toBe("GlimmerElementNodePart");
    expect(element.parts[0].name).toBe("MyComponent");
    expect(source.slice(element.parts[0].start, element.parts[0].end)).toBe("MyComponent");
  });
});

describe("AST snapshots — JS/TS wrapper nodes", () => {
  it("full file structure for simple gjs", () => {
    const source = `const x = <template>hello</template>;`;
    const ast = parse(source);

    expect(stripPositions(ast.program.body[0])).toMatchInlineSnapshot(`
      {
        "declarations": [
          {
            "definite": false,
            "id": {
              "decorators": [],
              "name": "x",
              "optional": false,
              "type": "Identifier",
              "typeAnnotation": null,
            },
            "init": {
              "blockParamNodes": [],
              "blockParams": [],
              "body": [
                {
                  "chars": "hello",
                  "type": "GlimmerTextNode",
                  "value": "hello",
                },
              ],
              "comments": [],
              "type": "GlimmerTemplate",
            },
            "type": "VariableDeclarator",
          },
        ],
        "declare": false,
        "kind": "const",
        "type": "VariableDeclaration",
      }
    `);
  });

  it("gts with interface and class", () => {
    const source = `interface Args { name: string; }
export default class Greeting {
  <template><h1>Hello</h1></template>
}`;
    const ast = parse(source);
    const body = ast.program.body;

    // First statement is TSInterfaceDeclaration
    expect(body[0].type).toBe("TSInterfaceDeclaration");

    // Second statement is ExportDefaultDeclaration wrapping a ClassDeclaration
    expect(body[1].type).toBe("ExportDefaultDeclaration");
    expect(body[1].declaration.type).toBe("ClassDeclaration");
  });
});
