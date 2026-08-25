import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { toTree, glimmerVisitorKeys } from "../src/index.js";
import { findNode, findAllNodes } from "./helpers.js";

const require = createRequire(import.meta.url);

// Minimal ESTree visitor keys — enough for oxc-parser's output
const ESTREE_KEYS = {
  Program: ["body"],
  ExportDefaultDeclaration: ["declaration"],
  ExportNamedDeclaration: ["declaration", "specifiers", "source"],
  VariableDeclaration: ["declarations"],
  VariableDeclarator: ["id", "init"],
  ClassDeclaration: ["id", "superClass", "body"],
  ClassBody: ["body"],
  PropertyDefinition: ["key", "value"],
  StaticBlock: ["body"],
  MethodDefinition: ["key", "value"],
  FunctionExpression: ["params", "body"],
  ArrowFunctionExpression: ["params", "body"],
  BlockStatement: ["body"],
  ExpressionStatement: ["expression"],
  TemplateLiteral: ["quasis", "expressions"],
  CallExpression: ["callee", "arguments"],
  MemberExpression: ["object", "property"],
  Identifier: [],
  ImportDeclaration: ["specifiers", "source"],
};

function oxcParse(js) {
  const { parseSync } = require("oxc-parser");
  const result = parseSync("test.js", js);
  return { ast: result.program, visitorKeys: ESTREE_KEYS };
}

describe("glimmerVisitorKeys", () => {
  it("is a plain object with Glimmer-prefixed keys", () => {
    expect(typeof glimmerVisitorKeys).toBe("object");
    expect(glimmerVisitorKeys.GlimmerTemplate).toEqual(["body"]);
    expect(glimmerVisitorKeys.GlimmerProgram).toEqual(["body", "blockParamNodes"]);
  });

  it("includes blockParamNodes and parts on GlimmerElementNode", () => {
    const keys = glimmerVisitorKeys.GlimmerElementNode;
    expect(keys).toContain("blockParamNodes");
    expect(keys).toContain("parts");
  });

  it("has keys for all standard Glimmer node types", () => {
    const expected = [
      "GlimmerTemplate",
      "GlimmerBlock",
      "GlimmerElementNode",
      "GlimmerMustacheStatement",
      "GlimmerBlockStatement",
      "GlimmerPathExpression",
      "GlimmerSubExpression",
      "GlimmerAttrNode",
      "GlimmerTextNode",
      "GlimmerConcatStatement",
      "GlimmerHash",
      "GlimmerHashPair",
      "GlimmerStringLiteral",
      "GlimmerNumberLiteral",
      "GlimmerBooleanLiteral",
      "GlimmerNullLiteral",
      "GlimmerUndefinedLiteral",
      "GlimmerCommentStatement",
      "GlimmerMustacheCommentStatement",
      "GlimmerElementModifierStatement",
    ];
    for (const key of expected) {
      expect(glimmerVisitorKeys).toHaveProperty(key);
    }
  });
});

describe("toTree — script errors", () => {
  it("reports oxc diagnostics on ast.errors", () => {
    const ast = toTree("let planets = []);\nconst a = <template>hi</template>;\n");
    expect(ast.errors.length).toBeGreaterThan(0);
    expect(ast.errors[0].message).toMatch(/semicolon/i);
    // oxc gives up on the whole program for this one.
    expect(ast.program.body).toEqual([]);
  });

  it("has no errors for a valid file", () => {
    const ast = toTree("const a = <template>hi</template>;\n");
    expect(ast.errors).toEqual([]);
    expect(ast.program.body).toHaveLength(1);
  });
});

describe("toTree — error handling", () => {
  it("throws on invalid JS with a content-tag parse error", () => {
    expect(() => toTree("console.log('unterminated")).toThrow();
  });

  it("throws on invalid template content", () => {
    expect(() => toTree("<template>{{#if}}</template>")).toThrow();
  });
});

describe("toTree — tokens", () => {
  it("no tokens by default", () => {
    const source = `const x = <template>Hello {{name}}</template>;`;
    const ast = toTree(source);
    const tpl = findNode(ast, "GlimmerTemplate");
    expect(tpl.tokens).toBeUndefined();
  });

  it("produces tokens covering the template range when tokens: true", () => {
    const source = `const x = <template>Hello {{name}}</template>;`;
    const ast = toTree(source, { tokens: true });
    const tpl = findNode(ast, "GlimmerTemplate");
    expect(tpl.tokens).toBeDefined();
    expect(tpl.tokens.length).toBeGreaterThan(0);

    // First token should be <template>, last should be </template>
    expect(tpl.tokens[0].value).toBe("<template>");
    expect(tpl.tokens[tpl.tokens.length - 1].value).toBe("</template>");
  });

  it("produces tokens for an empty template", () => {
    const source = `const x = <template></template>;`;
    const ast = toTree(source, { tokens: true });
    const tpl = findNode(ast, "GlimmerTemplate");
    expect(tpl.tokens).toBeDefined();
    // At minimum: <template> and </template>
    expect(tpl.tokens.length).toBeGreaterThanOrEqual(2);
    expect(tpl.tokens[0].value).toBe("<template>");
    expect(tpl.tokens[tpl.tokens.length - 1].value).toBe("</template>");
  });

  it("tokens have range and loc", () => {
    const source = `const x = <template>hi</template>;`;
    const ast = toTree(source, { tokens: true });
    const tpl = findNode(ast, "GlimmerTemplate");
    for (const token of tpl.tokens) {
      expect(token.range).toBeDefined();
      expect(token.range[0]).toBeLessThanOrEqual(token.range[1]);
      expect(token.loc).toBeDefined();
      expect(token.loc.start.line).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("toTree — templateOnly", () => {
  it("parses raw template content", () => {
    const { ast, comments } = toTree("<h1>Hello</h1>", { templateOnly: true });
    expect(ast.type).toBe("GlimmerTemplate");
    expect(comments).toBeDefined();
  });

  it("handles empty template content", () => {
    const { ast } = toTree("", { templateOnly: true });
    expect(ast.type).toBe("GlimmerTemplate");
    expect(ast.body).toEqual([]);
  });

  it("handles template with block params", () => {
    const { ast } = toTree("{{#each items as |item|}}{{item}}{{/each}}", { templateOnly: true });
    const block = findNode(ast, "GlimmerBlockStatement");
    expect(block).toBeTruthy();
  });
});

describe("toTree — custom parser", () => {
  it("accepts a parser callback and returns full result", () => {
    const source = `const x = <template>hi</template>;`;
    const result = toTree(source, {
      parser: (placeholderJS) => {
        // Verify we get valid JS
        expect(placeholderJS).toContain("`hi");
        expect(placeholderJS.length).toBe(source.length);
        // Return a mock parse result
        return oxcParse(placeholderJS);
      },
    });

    expect(result.ast).toBeDefined();
    expect(result.visitorKeys).toBeDefined();
    expect(result.visitorKeys.GlimmerTemplate).toEqual(["body"]);

    // Glimmer nodes should be spliced in
    const tpl = findNode(result.ast, "GlimmerTemplate");
    expect(tpl).toBeTruthy();
  });

  it("cleans stale properties from replaced nodes", () => {
    const source = `const x = <template>hi</template>;`;
    const result = toTree(source, {
      parser: oxcParse,
    });

    const tpl = findNode(result.ast, "GlimmerTemplate");
    // Should not have TemplateLiteral properties
    expect(tpl.quasis).toBeUndefined();
    expect(tpl.expressions).toBeUndefined();
  });
});

describe("toTree — visitors", () => {
  it("invokes GlimmerPathExpression visitor", () => {
    const source = `const x = <template>{{name}}</template>;`;
    const visited = [];
    toTree(source, {
      parser: oxcParse,
      visitors: {
        GlimmerPathExpression(node) {
          visited.push(node.original || node.head?.name);
        },
      },
    });
    expect(visited).toContain("name");
  });

  it("invokes GlimmerElementNode visitor", () => {
    const source = `const x = <template><MyComponent /><div>hi</div></template>;`;
    const tags = [];
    toTree(source, {
      parser: oxcParse,
      visitors: {
        GlimmerElementNode(node) {
          tags.push(node.tag);
        },
      },
    });
    expect(tags).toContain("MyComponent");
    expect(tags).toContain("div");
  });

  it("invokes GlimmerBlockParams visitor with path context", () => {
    const source = `const x = <template>{{#each items as |item|}}{{item}}{{/each}}</template>;`;
    const params = [];
    toTree(source, {
      parser: oxcParse,
      visitors: {
        GlimmerBlockParams(node, path) {
          expect(path.node).toBe(node);
          expect(path.parent).toBeDefined();
          for (const bp of node.blockParamNodes || []) {
            params.push(bp.name);
          }
        },
      },
    });
    expect(params).toContain("item");
  });

  it("visitor path chain reaches JS ancestors — standalone template", () => {
    const source = `const x = <template>{{name}}</template>;`;
    let templatePath = null;
    toTree(source, {
      parser: oxcParse,
      visitors: {
        GlimmerTemplate(node, path) {
          templatePath = path;
        },
      },
    });

    const chain = [];
    let p = templatePath;
    while (p) {
      chain.push(p.node.type);
      p = p.parentPath;
    }

    expect(chain).toMatchInlineSnapshot(`
      [
        "GlimmerTemplate",
        "VariableDeclarator",
        "VariableDeclaration",
        "Program",
      ]
    `);
  });

  it("visitor path chain reaches JS ancestors — class-backed component", () => {
    const source = `export default class MyComponent extends Component {
  <template>{{name}}</template>
}`;
    let templatePath = null;
    toTree(source, {
      parser: oxcParse,
      visitors: {
        GlimmerTemplate(node, path) {
          templatePath = path;
        },
      },
    });

    const chain = [];
    let p = templatePath;
    while (p) {
      chain.push(p.node.type);
      p = p.parentPath;
    }

    expect(chain).toMatchInlineSnapshot(`
      [
        "GlimmerTemplate",
        "ClassBody",
        "ClassDeclaration",
        "ExportDefaultDeclaration",
        "Program",
      ]
    `);
  });

  it("visitors receive DFS order (parent before child)", () => {
    const source = `const x = <template>{{#each items as |item|}}<div>{{item}}</div>{{/each}}</template>;`;
    const order = [];
    toTree(source, {
      parser: oxcParse,
      visitors: {
        GlimmerBlockParams(_node) {
          order.push("blockParams");
        },
        GlimmerElementNode() {
          order.push("element");
        },
        GlimmerPathExpression() {
          order.push("path");
        },
      },
    });
    // Block params should come before any path expressions inside the block
    const bpIdx = order.indexOf("blockParams");
    const lastPathIdx = order.lastIndexOf("path");
    expect(bpIdx).toBeLessThan(lastPathIdx);
  });
});

describe("toTree — edge cases", () => {
  it("handles multiple templates in one file", () => {
    const source = `
const A = <template>a</template>;
const B = <template>b</template>;
const C = <template>c</template>;`;
    const ast = toTree(source);
    const templates = findAllNodes(ast, "GlimmerTemplate");
    expect(templates.length).toBe(3);
  });

  it("handles empty template as arrow body", () => {
    const source = `const Foo = <template></template>;`;
    const ast = toTree(source);
    const tpl = findNode(ast, "GlimmerTemplate");
    expect(tpl).toBeTruthy();
    expect(tpl.body).toEqual([]);
    expect(source.slice(tpl.start, tpl.end)).toBe("<template></template>");
  });

  it("attaches visitorKeys on the returned AST", () => {
    const source = `const x = <template>hi</template>;`;
    const ast = toTree(source);
    expect(ast.visitorKeys).toBeDefined();
    expect(ast.visitorKeys.GlimmerTemplate).toEqual(["body"]);
  });

  it("block param nodes have correct positions (not parent range)", () => {
    const source = `const x = <template>{{#let "x" as |foo bar|}}{{foo}}{{/let}}</template>;`;
    const ast = toTree(source);
    const blocks = findAllNodes(ast, "GlimmerBlockParam");
    expect(blocks.length).toBe(2);
    expect(blocks[0].name).toBe("foo");
    expect(blocks[1].name).toBe("bar");
    // Positions should differ between params (not both at parent range)
    expect(blocks[0].start).not.toBe(blocks[1].start);
  });

  it("Glimmer nodes have no getter-based properties that cause esrecurse issues", () => {
    const source = `const x = <template><MyComponent /><div>{{name}}</div></template>;`;
    const ast = toTree(source);

    const element = findNode(ast, "GlimmerElementNode");
    // tag should be an own property, not a prototype getter
    const desc = Object.getOwnPropertyDescriptor(element, "tag");
    expect(desc.get).toBeUndefined();
    expect(desc.value).toBe("MyComponent");

    const path = findNode(ast, "GlimmerPathExpression");
    const headDesc = Object.getOwnPropertyDescriptor(path.head, "name");
    expect(headDesc.get).toBeUndefined();
  });
});
