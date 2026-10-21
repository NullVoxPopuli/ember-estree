import { expect, it } from "vitest";

import { parse } from "ember-estree";
import { stripKeys, keyOrderSerializer } from "./post-process.js";

expect.addSnapshotSerializer(keyOrderSerializer);

function min(ast) {
  return stripKeys(ast, [
    "start",
    "end",
    "loc",
    "range",
    "visitorKeys",
    "definite",
    "declare",
    "data",
  ]);
}

it("const declaration", () => {
  let ast = parse(`const x = <template>hi</template>;`);

  expect(min(ast.program.body)).toMatchInlineSnapshot(`
    [
      {
        "type": "VariableDeclaration",
        "kind": "const",
        "declarations": [
          {
            "type": "VariableDeclarator",
            "id": {
              "type": "Identifier",
              "decorators": [],
              "name": "x",
              "optional": false,
              "typeAnnotation": null,
            },
            "init": {
              "type": "GlimmerTemplate",
              "body": [
                {
                  "type": "GlimmerTextNode",
                  "chars": "hi",
                  "value": "hi",
                },
              ],
              "blockParams": [],
              "blockParamNodes": [],
              "contents": "hi",
            },
          },
        ],
      },
    ]
  `);
});

it("class", () => {
  let ast = parse(
    `class X {
  <template>
    hello there
  </template>
}`,
  );

  expect(min(ast.program.body)).toMatchInlineSnapshot(`
    [
      {
        "type": "ClassDeclaration",
        "decorators": [],
        "id": {
          "type": "Identifier",
          "decorators": [],
          "name": "X",
          "optional": false,
          "typeAnnotation": null,
        },
        "typeParameters": null,
        "superClass": null,
        "superTypeArguments": null,
        "implements": [],
        "body": {
          "type": "ClassBody",
          "body": [
            {
              "type": "GlimmerTemplate",
              "body": [
                {
                  "type": "GlimmerTextNode",
                  "chars": "
        hello there
      ",
                  "value": "
        hello there
      ",
                },
              ],
              "blockParams": [],
              "blockParamNodes": [],
              "contents": "
        hello there
      ",
            },
          ],
        },
        "abstract": false,
      },
    ]
  `);
});

it("gives a merged AST", () => {
  let ast = parse(
    `const x = <template>hi</template>;

<template>
  <x />
</template>
`,
  );

  expect(min(ast.program.body)).toMatchInlineSnapshot(`
    [
      {
        "type": "VariableDeclaration",
        "kind": "const",
        "declarations": [
          {
            "type": "VariableDeclarator",
            "id": {
              "type": "Identifier",
              "decorators": [],
              "name": "x",
              "optional": false,
              "typeAnnotation": null,
            },
            "init": {
              "type": "GlimmerTemplate",
              "body": [
                {
                  "type": "GlimmerTextNode",
                  "chars": "hi",
                  "value": "hi",
                },
              ],
              "blockParams": [],
              "blockParamNodes": [],
              "contents": "hi",
            },
          },
        ],
      },
      {
        "type": "GlimmerTemplate",
        "body": [
          {
            "type": "GlimmerElementNode",
            "path": {
              "type": "PathExpression",
              "head": {
                "type": "VarHead",
                "name": "x",
                "original": "x",
              },
              "tail": [],
              "original": "x",
            },
            "attributes": [],
            "modifiers": [],
            "params": [],
            "comments": [],
            "children": [],
            "openTag": {
              "isInvisible": false,
            },
            "closeTag": null,
            "tag": "x",
            "blockParams": [],
            "selfClosing": true,
            "name": "x",
            "parts": [
              {
                "type": "GlimmerElementNodePart",
                "original": "x",
                "name": "x",
              },
            ],
            "blockParamNodes": [],
          },
        ],
        "blockParams": [],
        "blockParamNodes": [],
        "contents": "
      <x />
    ",
      },
    ]
  `);
});
