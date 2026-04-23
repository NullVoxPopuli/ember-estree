import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { toTree } from "../src/index.js";
import { findNode } from "./helpers.js";

const require = createRequire(import.meta.url);

// @typescript-eslint/parser's parseForESLint returns:
//   { ast, scopeManager, services, visitorKeys }
// scopeManager and services hold WeakMap-keyed data keyed on the AST nodes
// it produced. If toTree replaces those node objects during template splicing,
// the WeakMaps are orphaned and consumers can't look data up.
function tsParseForESLint(js) {
  const { parseForESLint } = require("@typescript-eslint/parser");
  return parseForESLint(js, {
    range: true,
    loc: true,
    ecmaVersion: 2022,
    sourceType: "module",
    // Type-info services require a project; these tests only need the
    // scope manager + esTreeNodeToTSNodeMap, which are always populated.
  });
}

describe("toTree — custom parser (typescript-eslint) — node identity", () => {
  it("preserves outer-AST node identity after a standalone template splice", () => {
    const source = `const Bar = () => <template></template>;`;
    // Snapshot ancestor references before toTree gets a chance to splice,
    // and verify the placeholder is still a TemplateLiteral at that point.
    let origProgram, origDecl, origDtor, origArrow, origPlaceholder;
    const result = toTree(source, {
      parser: (js) => {
        const parsed = tsParseForESLint(js);
        origProgram = parsed.ast;
        origDecl = origProgram.body[0]; // VariableDeclaration
        origDtor = origDecl.declarations[0]; // VariableDeclarator
        origArrow = origDtor.init; // ArrowFunctionExpression
        origPlaceholder = origArrow.body; // TemplateLiteral (placeholder)
        expect(origPlaceholder.type).toBe("TemplateLiteral");
        return parsed;
      },
    });

    // After toTree, every ancestor JS object reference must still point at
    // the SAME object the parser produced — otherwise the parser's scope
    // manager / services WeakMaps are orphaned.
    expect(result.ast).toBe(origProgram);
    expect(result.ast.body[0]).toBe(origDecl);
    expect(result.ast.body[0].declarations[0]).toBe(origDtor);
    expect(result.ast.body[0].declarations[0].init).toBe(origArrow);
    // The arrow's body slot now holds a GlimmerTemplate (placeholder was
    // replaced in place, not by cloning the arrow).
    expect(origArrow.body).not.toBe(origPlaceholder);
    expect(origArrow.body.type).toBe("GlimmerTemplate");
  });

  it("preserves outer-AST node identity in class-backed components", () => {
    const source = `export default class MyComponent extends Component {
  <template>hi</template>
}`;
    let captured;
    const result = toTree(source, {
      parser: (js) => {
        captured = tsParseForESLint(js);
        return captured;
      },
    });

    const origProgram = captured.ast;
    const origExport = origProgram.body[0]; // ExportDefaultDeclaration
    const origClass = origExport.declaration; // ClassDeclaration
    const origBody = origClass.body; // ClassBody

    expect(result.ast).toBe(origProgram);
    expect(result.ast.body[0]).toBe(origExport);
    expect(result.ast.body[0].declaration).toBe(origClass);
    expect(result.ast.body[0].declaration.body).toBe(origBody);
    // The StaticBlock placeholder has been replaced in place with GlimmerTemplate.
    expect(origBody.body[0].type).toBe("GlimmerTemplate");
  });
});

describe("toTree — custom parser (typescript-eslint) — scope manager", () => {
  it("scope.block references still resolve via scopeManager.acquire()", () => {
    const source = `const Bar = () => <template></template>;`;
    const result = toTree(source, { parser: tsParseForESLint });

    const { scopeManager } = result;
    expect(scopeManager).toBeDefined();

    // ESLint's context.getScope() ultimately calls scopeManager.acquire(node).
    // If zimmerframe cloned a function/arrow node, the original scope.block
    // is still the old node, and acquire(scope.block) may return null or the
    // wrong scope. Every scope should round-trip.
    for (const scope of scopeManager.scopes) {
      if (!scope.block) continue;
      const looked = scopeManager.acquire(scope.block);
      expect(looked).toBeTruthy();
    }
  });

  it("scope.block for the arrow function is the same object in the new AST", () => {
    const source = `const Bar = () => <template></template>;`;
    const result = toTree(source, { parser: tsParseForESLint });

    const arrow = result.ast.body[0].declarations[0].init;
    expect(arrow.type).toBe("ArrowFunctionExpression");

    const arrowScope = result.scopeManager.scopes.find(
      (s) => s.block && s.block.type === "ArrowFunctionExpression",
    );
    expect(arrowScope).toBeDefined();
    expect(arrowScope.block).toBe(arrow);
  });
});

describe("toTree — custom parser (typescript-eslint) — services (esTreeNodeToTSNodeMap)", () => {
  it("every outer-AST node resolvable before the walk is still resolvable after", () => {
    const source = `const Bar = () => <template></template>;
export default Bar;`;
    let captured;
    const result = toTree(source, {
      parser: (js) => {
        captured = tsParseForESLint(js);
        return captured;
      },
    });

    const esMap = result.services?.esTreeNodeToTSNodeMap;
    expect(esMap).toBeDefined();

    // Walk the outer AST and assert every ESTree-shaped node is still
    // looked up successfully. Glimmer nodes are skipped — they're new
    // objects without a corresponding TS node.
    const seen = new WeakSet();
    (function check(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      if (Array.isArray(node)) {
        node.forEach(check);
        return;
      }
      if (typeof node.type !== "string") return;
      seen.add(node);
      if (!node.type.startsWith("Glimmer")) {
        // Skip root-level Program and anything that wasn't mapped originally.
        if (captured.services.esTreeNodeToTSNodeMap.has(node)) {
          expect(esMap.get(node)).toBeDefined();
        }
      }
      for (const key of Object.keys(node)) {
        if (key === "parent" || key === "tokens" || key === "comments") continue;
        check(node[key]);
      }
    })(result.ast);
  });
});

describe("toTree — custom parser (typescript-eslint) — visitor paths still work", () => {
  it("visitor path chain reaches TS parent nodes", () => {
    const source = `const Bar = () => <template>{{name}}</template>;`;
    let templatePath = null;
    toTree(source, {
      parser: tsParseForESLint,
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
        "ArrowFunctionExpression",
        "VariableDeclarator",
        "VariableDeclaration",
        "Program",
      ]
    `);
  });

  it("visitor path chain for class-backed components", () => {
    const source = `export default class Foo extends Component {
  <template>hi</template>
}`;
    let templatePath = null;
    toTree(source, {
      parser: tsParseForESLint,
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
});

describe("toTree — custom parser (typescript-eslint) — Glimmer nodes are produced", () => {
  it("produces a GlimmerTemplate inside the arrow body", () => {
    const source = `const Bar = () => <template>{{name}}</template>;`;
    const result = toTree(source, { parser: tsParseForESLint });
    const tpl = findNode(result.ast, "GlimmerTemplate");
    expect(tpl).toBeTruthy();
    const path = findNode(result.ast, "GlimmerPathExpression");
    expect(path).toBeTruthy();
  });

  it("produces a GlimmerTemplate for class-member template", () => {
    const source = `export default class Foo extends Component {
  <template>hi</template>
}`;
    const result = toTree(source, { parser: tsParseForESLint });
    const tpl = findNode(result.ast, "GlimmerTemplate");
    expect(tpl).toBeTruthy();
    expect(tpl.body?.[0]?.type).toBe("GlimmerTextNode");
  });
});
