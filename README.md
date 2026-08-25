# ember-estree

ESTree-compatible AST parser for Ember's `.gjs` and `.gts` files.

Parses `<template>` tags into [Glimmer](https://github.com/emberjs/ember.js/) AST nodes that are embedded directly in the ESTree, so tools like linters and codemods can work with both the JavaScript/TypeScript _and_ template portions of a single file.

## Install

```bash
pnpm add ember-estree
```

## Usage

### Parsing

`toTree` returns a `File` node whose `.program` is a standard ESTree `Program`, with any `<template>` regions represented as `Glimmer*` AST nodes.

```js
import { toTree } from "ember-estree";

let ast = toTree(`
  import Component from "@glimmer/component";

  export default class Demo extends Component {
    <template>Hello, {{this.name}}!</template>
  }
`);

console.log(ast.type); // "File"
console.log(ast.program.body.length); // 2 — ImportDeclaration + ClassDeclaration
```

`parse` is a lower-level alternative that returns the `Program` node directly.

```js
import { parse } from "ember-estree";

let program = parse(`const x = <template>hi</template>;`);
console.log(program.type); // "Program"
```

### Printing

`print` converts an AST node (ESTree _or_ Glimmer) back to source code.

```js
import { print } from "ember-estree";

print({ type: "Identifier", name: "foo" });
// => "foo"

print({
  type: "GlimmerTemplate",
  body: [{ type: "GlimmerTextNode", chars: "Hello" }],
});
// => "<template>Hello</template>"
```

`print` also accepts the `File` node returned by `toTree`, printing the whole program with `file.comments` woven back into the output (each comment is emitted before the nearest node that follows it in the original source). Placement is approximate — a trailing same-line comment becomes a leading comment of the next node — so pair the output with a formatter (e.g. prettier) when exact layout matters.

```js
import { toTree, print } from "ember-estree";

let tree = toTree(`// greet the user\nlet greeting = "hello";`);

print(tree);
// => '// greet the user\nlet greeting = "hello";'
```

### Building

`statement` and `statements` are tagged templates that build AST from source text — like [`@babel/template`](https://babeljs.io/docs/babel-template), but gjs/gts-aware: `<template>` regions become `Glimmer*` nodes, and TypeScript syntax is understood.

```js
import { statement, statements } from "ember-estree";

statement`import setup from "some-package";`;
// => ImportDeclaration

statements`
  const greeting = "hello";
  <template>{{greeting}}</template>
`;
// => [VariableDeclaration, GlimmerTemplate]
```

Interpolations may be strings (inserted verbatim), AST nodes (printed), or arrays of either (comma-separated):

```js
let local = "setupInspector";
let callee = { type: "Identifier", name: local };

statement`import ${local} from "some-package";`;
statement`let inspector = ${callee}(this);`;
```

Built nodes carry no source positions, so they can be spliced anywhere into a tree returned by `toTree` and printed — comment weaving in the host file is unaffected:

```js
import { toTree, print, statement } from "ember-estree";

let tree = toTree(source);
tree.program.body.unshift(statement`import "./styles.css";`);
print(tree);
```

For node kinds that are not statements (class members, object properties, ...), build the smallest statement containing one and pluck it out:

```js
let member = statement`class _ { inspector = setup(this); }`.body.body[0];
// => PropertyDefinition
```

## Options

Both `toTree` and `parse` accept an options object as their second argument.

All options are optional.

| Option            | Type                                              | Description                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`        | `string`                                          | Used for language detection.                                                                                                                                                                                 |
| `tokens`          | `boolean`                                         | Generate a flat `ast.tokens` array. Required by ESLint; skipped by default so codemods and type-checkers pay nothing.                                                                                        |
| `templateOnly`    | `boolean`                                         | Parse the source as a raw Glimmer template. Use for `.hbs` files.                                                                                                                                            |
| `parser`          | `(placeholderJS: string) => { ast, ... }`         | Use a custom JS/TS parser instead of the default oxc-parser. See [Custom parser](#custom-parser).                                                                                                            |
| `visitors`        | `VisitorMap` <br /> or `(outerAst) => VisitorMap` | Callbacks fired on every node during traversal — JS/TS and Glimmer — in a single pass. See [Visitors](#visitors).                                                                                            |
| `onTemplateError` | `(error, { range, contentRange, path }) => void`  | Called when a `<template>` fails to parse; `path` is the visitor path its `GlimmerTemplate` would have had. When provided, parsing continues with that template left as its placeholder instead of throwing. |

Handler signature is `(node, path) => void`, where `path = { node, parent, parentPath }` — a linked list that walks all the way back through the JS/TS root, so visitors can locate the enclosing scope or class from within a Glimmer subtree.

### Token stream

Pass `tokens: true` to populate `ast.tokens` with a flat, position-sorted array of lexemes spanning the full file — including Glimmer tokens spliced in place of each `<template>` region. This is what ESLint's `SourceCode` needs; omit it for codemods or type-checkers that don't use the token stream.

```js
import { toTree } from "ember-estree";

const result = toTree(source, {
  tokens: true,
  parser: myTsParser,
});
// result.ast.program.tokens now contains JS + Glimmer tokens in source order
```

For `.hbs` files via `templateOnly`, pass both flags:

```js
toTree(hbsSource, { templateOnly: true, tokens: true });
```

### Custom parser

Pass any JS/TS parser that returns an ESTree-compatible AST. ember-estree handles template splicing and Glimmer traversal on top of it.

```js
import { parseSync } from "oxc-parser";
import { toTree } from "ember-estree";

const result = toTree(source, {
  parser: (js) => ({
    ast: parseSync("input.ts", js).program,
    visitorKeys: {
      /* ...parser's visitor keys... */
    },
  }),
});
```

The parser receives a placeholder-JS string (templates replaced with backtick expressions of equal length) and must return at least `{ ast }`. Additional fields like `scopeManager`, `visitorKeys`, or `services` are preserved on the returned result.

### Visitors

Pass `visitors` to observe or rewrite the tree in a single traversal. Handlers fire on both outer JS/TS nodes and spliced Glimmer subtrees, and a single node is never dispatched twice — safe to relocate nodes mid-walk.

The pseudo-type `GlimmerBlockParams` fires on any node that carries a `blockParams` array.

**Plain-object form** — use when you only need the type → handler map:

```js
import { toTree } from "ember-estree";

const identifiers = [];
toTree(source, {
  visitors: {
    Identifier: (node) => identifiers.push(node.name),
    GlimmerPathExpression: (node) => identifiers.push(node.original),
  },
});
```

**Factory form** — use when you need the outer JS/TS AST up front (for example, to attach state to it before the walk):

```js
import { toTree, print } from "ember-estree";

const ast = toTree(`const world = "🌍"; const X = <template>{{world}}</template>;`, {
  visitors: () => ({
    Identifier: (node) => (node.name = node.name.toUpperCase()),
    GlimmerPathExpression(node) {
      node.original = node.original.toUpperCase();
      if (node.head) node.head.name = node.original;
    },
  }),
});

print(ast.program);
// => 'const WORLD = "🌍";\nconst X = <template>{{WORLD}}</template>;'
```

**Collecting Glimmer comments into `program.comments`** — useful when adapting the AST for ESLint, which reads comments from the Program node:

```js
const ast = toTree(source, {
  visitors: (outerAst) => {
    outerAst.program.comments = [...(outerAst.comments ?? [])];
    const push = (node) => outerAst.program.comments.push(node);
    return {
      GlimmerCommentStatement: push,
      GlimmerMustacheCommentStatement: push,
    };
  },
});
```

**Removing nodes mid-traversal** — siblings are splice-safe:

```js
toTree(source, {
  visitors: () => ({
    GlimmerMustacheCommentStatement(node, path) {
      const siblings = path.parent?.body ?? path.parent?.children;
      const idx = siblings?.indexOf(node) ?? -1;
      if (idx >= 0) siblings.splice(idx, 1);
    },
  }),
});
```

## Examples

The [`examples/`](./examples) directory contains ready-to-run integrations:

| Example                                     | Description                                                          |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [`eslint-parser`](./examples/eslint-parser) | Custom ESLint parser that understands `<template>`                   |
| [`zmod`](./examples/zmod)                   | Codemod toolkit using [zmod](https://github.com/nicolo-ribaudo/zmod) |

<!-- ast-nodes:start -->
<!-- Generated by scripts/generate-ast-node-reference.mjs — do not edit by hand. -->

## AST node reference

<details>
<summary><strong>Every AST node</strong> ember-estree may emit (171 total) — grouped by which files they appear in</summary>

Generated from `oxc-parser`'s and `@glimmer/syntax`'s visitor-key maps. Re-run `node scripts/generate-ast-node-reference.mjs` after bumping either dependency to keep this in sync.

<details>
<summary><strong>Core ESTree</strong> — in <code>.gjs</code> and <code>.gts</code> (76 nodes)</summary>

Standard JavaScript node types. Present in both `.gjs` and `.gts` — TypeScript is a superset of JavaScript, so `.gts` files may contain all of these too.

| Node                       | Child keys                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `AccessorProperty`         | `decorators`, `key`, `typeAnnotation`, `value`                                                 |
| `ArrayExpression`          | `elements`                                                                                     |
| `ArrayPattern`             | `decorators`, `elements`, `typeAnnotation`                                                     |
| `ArrowFunctionExpression`  | `typeParameters`, `params`, `returnType`, `body`                                               |
| `AssignmentExpression`     | `left`, `right`                                                                                |
| `AssignmentPattern`        | `decorators`, `left`, `right`, `typeAnnotation`                                                |
| `AwaitExpression`          | `argument`                                                                                     |
| `BinaryExpression`         | `left`, `right`                                                                                |
| `BlockStatement`           | `body`                                                                                         |
| `BreakStatement`           | `label`                                                                                        |
| `CallExpression`           | `callee`, `typeArguments`, `arguments`                                                         |
| `CatchClause`              | `param`, `body`                                                                                |
| `ChainExpression`          | `expression`                                                                                   |
| `ClassBody`                | `body`                                                                                         |
| `ClassDeclaration`         | `decorators`, `id`, `typeParameters`, `superClass`, `superTypeArguments`, `implements`, `body` |
| `ClassExpression`          | `decorators`, `id`, `typeParameters`, `superClass`, `superTypeArguments`, `implements`, `body` |
| `ConditionalExpression`    | `test`, `consequent`, `alternate`                                                              |
| `ContinueStatement`        | `label`                                                                                        |
| `DebuggerStatement`        | _(leaf)_                                                                                       |
| `Decorator`                | `expression`                                                                                   |
| `DoWhileStatement`         | `body`, `test`                                                                                 |
| `EmptyStatement`           | _(leaf)_                                                                                       |
| `ExportAllDeclaration`     | `exported`, `source`, `attributes`                                                             |
| `ExportDefaultDeclaration` | `declaration`                                                                                  |
| `ExportNamedDeclaration`   | `declaration`, `specifiers`, `source`, `attributes`                                            |
| `ExportSpecifier`          | `local`, `exported`                                                                            |
| `ExpressionStatement`      | `expression`                                                                                   |
| `ForInStatement`           | `left`, `right`, `body`                                                                        |
| `ForOfStatement`           | `left`, `right`, `body`                                                                        |
| `ForStatement`             | `init`, `test`, `update`, `body`                                                               |
| `FunctionDeclaration`      | `id`, `typeParameters`, `params`, `returnType`, `body`                                         |
| `FunctionExpression`       | `id`, `typeParameters`, `params`, `returnType`, `body`                                         |
| `Identifier`               | `decorators`, `typeAnnotation`                                                                 |
| `IfStatement`              | `test`, `consequent`, `alternate`                                                              |
| `ImportAttribute`          | `key`, `value`                                                                                 |
| `ImportDeclaration`        | `specifiers`, `source`, `attributes`                                                           |
| `ImportDefaultSpecifier`   | `local`                                                                                        |
| `ImportExpression`         | `source`, `options`                                                                            |
| `ImportNamespaceSpecifier` | `local`                                                                                        |
| `ImportSpecifier`          | `imported`, `local`                                                                            |
| `LabeledStatement`         | `label`, `body`                                                                                |
| `Literal`                  | _(leaf)_                                                                                       |
| `LogicalExpression`        | `left`, `right`                                                                                |
| `MemberExpression`         | `object`, `property`                                                                           |
| `MetaProperty`             | `meta`, `property`                                                                             |
| `MethodDefinition`         | `decorators`, `key`, `value`                                                                   |
| `NewExpression`            | `callee`, `typeArguments`, `arguments`                                                         |
| `ObjectExpression`         | `properties`                                                                                   |
| `ObjectPattern`            | `decorators`, `properties`, `typeAnnotation`                                                   |
| `ParenthesizedExpression`  | `expression`                                                                                   |
| `PrivateIdentifier`        | _(leaf)_                                                                                       |
| `Program`                  | `body`                                                                                         |
| `Property`                 | `key`, `value`                                                                                 |
| `PropertyDefinition`       | `decorators`, `key`, `typeAnnotation`, `value`                                                 |
| `RestElement`              | `decorators`, `argument`, `typeAnnotation`                                                     |
| `ReturnStatement`          | `argument`                                                                                     |
| `SequenceExpression`       | `expressions`                                                                                  |
| `SpreadElement`            | `argument`                                                                                     |
| `StaticBlock`              | `body`                                                                                         |
| `Super`                    | _(leaf)_                                                                                       |
| `SwitchCase`               | `test`, `consequent`                                                                           |
| `SwitchStatement`          | `discriminant`, `cases`                                                                        |
| `TaggedTemplateExpression` | `tag`, `typeArguments`, `quasi`                                                                |
| `TemplateElement`          | _(leaf)_                                                                                       |
| `TemplateLiteral`          | `quasis`, `expressions`                                                                        |
| `ThisExpression`           | _(leaf)_                                                                                       |
| `ThrowStatement`           | `argument`                                                                                     |
| `TryStatement`             | `block`, `handler`, `finalizer`                                                                |
| `UnaryExpression`          | `argument`                                                                                     |
| `UpdateExpression`         | `argument`                                                                                     |
| `V8IntrinsicExpression`    | `name`, `arguments`                                                                            |
| `VariableDeclaration`      | `declarations`                                                                                 |
| `VariableDeclarator`       | `id`, `init`                                                                                   |
| `WhileStatement`           | `test`, `body`                                                                                 |
| `WithStatement`            | `object`, `body`                                                                               |
| `YieldExpression`          | `argument`                                                                                     |

</details>

<details>
<summary><strong>TypeScript</strong> — <code>.gts</code> only (74 nodes)</summary>

TypeScript-specific nodes. Can only appear in `.gts` files.

| Node                              | Child keys                                             |
| --------------------------------- | ------------------------------------------------------ |
| `TSAbstractAccessorProperty`      | `decorators`, `key`, `typeAnnotation`                  |
| `TSAbstractMethodDefinition`      | `key`, `value`                                         |
| `TSAbstractPropertyDefinition`    | `decorators`, `key`, `typeAnnotation`                  |
| `TSAnyKeyword`                    | _(leaf)_                                               |
| `TSArrayType`                     | `elementType`                                          |
| `TSAsExpression`                  | `expression`, `typeAnnotation`                         |
| `TSBigIntKeyword`                 | _(leaf)_                                               |
| `TSBooleanKeyword`                | _(leaf)_                                               |
| `TSCallSignatureDeclaration`      | `typeParameters`, `params`, `returnType`               |
| `TSClassImplements`               | `expression`, `typeArguments`                          |
| `TSConditionalType`               | `checkType`, `extendsType`, `trueType`, `falseType`    |
| `TSConstructorType`               | `typeParameters`, `params`, `returnType`               |
| `TSConstructSignatureDeclaration` | `typeParameters`, `params`, `returnType`               |
| `TSDeclareFunction`               | `id`, `typeParameters`, `params`, `returnType`, `body` |
| `TSEmptyBodyFunctionExpression`   | `id`, `typeParameters`, `params`, `returnType`         |
| `TSEnumBody`                      | `members`                                              |
| `TSEnumDeclaration`               | `id`, `body`                                           |
| `TSEnumMember`                    | `id`, `initializer`                                    |
| `TSExportAssignment`              | `expression`                                           |
| `TSExternalModuleReference`       | `expression`                                           |
| `TSFunctionType`                  | `typeParameters`, `params`, `returnType`               |
| `TSImportEqualsDeclaration`       | `id`, `moduleReference`                                |
| `TSImportType`                    | `source`, `options`, `qualifier`, `typeArguments`      |
| `TSIndexedAccessType`             | `objectType`, `indexType`                              |
| `TSIndexSignature`                | `parameters`, `typeAnnotation`                         |
| `TSInferType`                     | `typeParameter`                                        |
| `TSInstantiationExpression`       | `expression`, `typeArguments`                          |
| `TSInterfaceBody`                 | `body`                                                 |
| `TSInterfaceDeclaration`          | `id`, `typeParameters`, `extends`, `body`              |
| `TSInterfaceHeritage`             | `expression`, `typeArguments`                          |
| `TSIntersectionType`              | `types`                                                |
| `TSIntrinsicKeyword`              | _(leaf)_                                               |
| `TSJSDocNonNullableType`          | `typeAnnotation`                                       |
| `TSJSDocNullableType`             | `typeAnnotation`                                       |
| `TSJSDocUnknownType`              | _(leaf)_                                               |
| `TSLiteralType`                   | `literal`                                              |
| `TSMappedType`                    | `key`, `constraint`, `nameType`, `typeAnnotation`      |
| `TSMethodSignature`               | `key`, `typeParameters`, `params`, `returnType`        |
| `TSModuleBlock`                   | `body`                                                 |
| `TSModuleDeclaration`             | `id`, `body`                                           |
| `TSNamedTupleMember`              | `label`, `elementType`                                 |
| `TSNamespaceExportDeclaration`    | `id`                                                   |
| `TSNeverKeyword`                  | _(leaf)_                                               |
| `TSNonNullExpression`             | `expression`                                           |
| `TSNullKeyword`                   | _(leaf)_                                               |
| `TSNumberKeyword`                 | _(leaf)_                                               |
| `TSObjectKeyword`                 | _(leaf)_                                               |
| `TSOptionalType`                  | `typeAnnotation`                                       |
| `TSParameterProperty`             | `decorators`, `parameter`                              |
| `TSParenthesizedType`             | `typeAnnotation`                                       |
| `TSPropertySignature`             | `key`, `typeAnnotation`                                |
| `TSQualifiedName`                 | `left`, `right`                                        |
| `TSRestType`                      | `typeAnnotation`                                       |
| `TSSatisfiesExpression`           | `expression`, `typeAnnotation`                         |
| `TSStringKeyword`                 | _(leaf)_                                               |
| `TSSymbolKeyword`                 | _(leaf)_                                               |
| `TSTemplateLiteralType`           | `quasis`, `types`                                      |
| `TSThisType`                      | _(leaf)_                                               |
| `TSTupleType`                     | `elementTypes`                                         |
| `TSTypeAliasDeclaration`          | `id`, `typeParameters`, `typeAnnotation`               |
| `TSTypeAnnotation`                | `typeAnnotation`                                       |
| `TSTypeAssertion`                 | `typeAnnotation`, `expression`                         |
| `TSTypeLiteral`                   | `members`                                              |
| `TSTypeOperator`                  | `typeAnnotation`                                       |
| `TSTypeParameter`                 | `name`, `constraint`, `default`                        |
| `TSTypeParameterDeclaration`      | `params`                                               |
| `TSTypeParameterInstantiation`    | `params`                                               |
| `TSTypePredicate`                 | `parameterName`, `typeAnnotation`                      |
| `TSTypeQuery`                     | `exprName`, `typeArguments`                            |
| `TSTypeReference`                 | `typeName`, `typeArguments`                            |
| `TSUndefinedKeyword`              | _(leaf)_                                               |
| `TSUnionType`                     | `types`                                                |
| `TSUnknownKeyword`                | _(leaf)_                                               |
| `TSVoidKeyword`                   | _(leaf)_                                               |

</details>

<details>
<summary><strong>Glimmer template</strong> — in <code>.gjs</code> and <code>.gts</code> (21 nodes)</summary>

Nodes produced inside `<template>...</template>` regions by `@glimmer/syntax`, prefixed with `Glimmer` when spliced into the ESTree.

| Node                              | Child keys                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `GlimmerAttrNode`                 | `value`                                                                       |
| `GlimmerBlock`                    | `body`                                                                        |
| `GlimmerBlockStatement`           | `path`, `params`, `hash`, `program`, `inverse`                                |
| `GlimmerBooleanLiteral`           | _(leaf)_                                                                      |
| `GlimmerCommentStatement`         | _(leaf)_                                                                      |
| `GlimmerConcatStatement`          | `parts`                                                                       |
| `GlimmerElementModifierStatement` | `path`, `params`, `hash`                                                      |
| `GlimmerElementNode`              | `attributes`, `modifiers`, `children`, `comments`, `blockParamNodes`, `parts` |
| `GlimmerHash`                     | `pairs`                                                                       |
| `GlimmerHashPair`                 | `value`                                                                       |
| `GlimmerMustacheCommentStatement` | _(leaf)_                                                                      |
| `GlimmerMustacheStatement`        | `path`, `params`, `hash`                                                      |
| `GlimmerNullLiteral`              | _(leaf)_                                                                      |
| `GlimmerNumberLiteral`            | _(leaf)_                                                                      |
| `GlimmerPathExpression`           | _(leaf)_                                                                      |
| `GlimmerProgram`                  | `body`, `blockParamNodes`                                                     |
| `GlimmerStringLiteral`            | _(leaf)_                                                                      |
| `GlimmerSubExpression`            | `path`, `params`, `hash`                                                      |
| `GlimmerTemplate`                 | `body`                                                                        |
| `GlimmerTextNode`                 | _(leaf)_                                                                      |
| `GlimmerUndefinedLiteral`         | _(leaf)_                                                                      |

</details>

</details>
<!-- ast-nodes:end -->

## License

MIT
