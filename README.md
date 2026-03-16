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

## Examples

The [`examples/`](./examples) directory contains ready-to-run integrations:

| Example                                     | Description                                                          |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [`eslint-parser`](./examples/eslint-parser) | Custom ESLint parser that understands `<template>`                   |
| [`zmod`](./examples/zmod)                   | Codemod toolkit using [zmod](https://github.com/nicolo-ribaudo/zmod) |

## Caveats

### Synthetic AST nodes

The Glimmer AST produced by `@glimmer/syntax` is transformed to be ESTree-compatible. Most of this is mechanical (type prefixing, range/loc fixing), but a few **synthetic nodes** are created that do not exist in the original Glimmer AST:

- **`GlimmerElementNodePart`** — Added to `GlimmerElementNode.parts[]`. Represents the tag name with its own `range`/`loc` pointing to just the name in the source (e.g. `MyComponent` inside `<MyComponent ...>`). This exists so that tools like ESLint can point error messages at the tag name rather than the entire element including its children and closing tag.

- **`GlimmerBlockParam`** — Added to `blockParamNodes[]` (and aliased as `params[]`) on nodes that have `blockParams`. These are virtual nodes created from the `blockParams` string array since the Glimmer AST does not provide individual location info for block parameter names.

## License

MIT
