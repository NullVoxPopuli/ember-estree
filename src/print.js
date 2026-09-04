/**
 * Prints a comment as it appeared in source.
 * @param {object} comment - `{ type: "Line" | "Block", value }`
 * @return {string}
 */
function printComment(comment) {
  return comment.type === "Block" ? `/*${comment.value}*/` : `//${comment.value}`;
}

// Comment-weaving state for `print(File)`. `print` is synchronous and
// single-threaded, so module-level state is safe; `printFile` saves and
// restores it so nested calls stay well-behaved.
let fileComments = null;
let commentCursor = 0;

/**
 * Prints and consumes any not-yet-emitted comments that start before
 * `position` in the original source.
 *
 * `fileComments` is sorted and `commentCursor` only ever advances, so the
 * total flushing work across an entire `print(File)` is O(comments) — each
 * comment is visited exactly once, no matter how many nodes are printed.
 *
 * @param {number} position
 * @return {string}
 */
function flushCommentsBefore(position) {
  let out = "";
  while (commentCursor < fileComments.length && fileComments[commentCursor].start < position) {
    out += `${printComment(fileComments[commentCursor])}\n`;
    commentCursor += 1;
  }
  return out;
}

/**
 * Prints a File node: its program, with `file.comments` woven back in
 * before the nearest printed node that follows them in the original
 * source (and any remaining comments appended at the end of the file).
 *
 * Placement is approximate -- a same-line trailing comment becomes a
 * leading comment of the next node -- so pair the output with a formatter
 * (e.g. prettier) when exact layout matters.
 *
 * @param {object} file
 * @return {string}
 */
function printFile(file) {
  const previousComments = fileComments;
  const previousCursor = commentCursor;

  // `filter` already yields a fresh array, so sorting in place is safe and
  // the caller's `file.comments` is never mutated. (oxc emits comments
  // pre-sorted, making the sort a cheap single pass.)
  const comments = file.comments?.length
    ? file.comments
        .filter((comment) => typeof comment.start === "number")
        .sort((a, b) => a.start - b.start)
    : null;

  fileComments = comments?.length ? comments : null;
  commentCursor = 0;

  try {
    let output = print(file.program);
    const trailing = fileComments ? flushCommentsBefore(Infinity) : "";

    if (trailing) {
      output = output ? `${output}\n${trailing}` : trailing;
    }

    return output;
  } finally {
    fileComments = previousComments;
    commentCursor = previousCursor;
  }
}

/**
 * Recursive AST printer that handles ESTree, TypeScript, and
 * Glimmer template node types.
 *
 * JSX nodes are not supported — Ember uses Glimmer templates instead.
 *
 * Tools like zmod use span-based patching (preserving the original source
 * for unchanged regions), so this printer is typically only invoked for
 * newly-created AST nodes (via builders) — with one exception: a `File`
 * node (as returned by `toTree`) is printed in full, with its `comments`
 * woven back into the output.
 *
 * @param {object} node - The AST node to print
 * @return {string}
 */
export function print(node) {
  if (!node) return "";
  if (typeof node === "string") return node;

  // Comment weaving — active only while a comment-carrying `print(File)`
  // is in flight. When any comments start before this node in the original
  // source, emit them first, then re-enter (the cursor has advanced past
  // them, so the recursion falls straight through to the switch). Outside
  // of `print(File)` the guard short-circuits on its first check, so
  // standalone printing pays a single null test.
  if (
    fileComments !== null &&
    commentCursor < fileComments.length &&
    typeof node.start === "number" &&
    fileComments[commentCursor].start < node.start
  ) {
    return flushCommentsBefore(node.start) + print(node);
  }

  switch (node.type) {
    // ── File (root of `toTree`) ───────────────────────────────────
    case "File":
      return printFile(node);

    // ── Identifiers & Literals ────────────────────────────────────
    case "Identifier":
      return printTypeAnnotated(node.name, node);

    case "PrivateIdentifier":
      return `#${node.name}`;

    case "Literal":
    case "StringLiteral":
      if (typeof node.value === "string") {
        // Prefer the original source: it preserves escape sequences
        // (`\n`, `\t`, `\uXXXX`, escaped quotes) and the original quote
        // style exactly. Emitting the cooked `value` turns escapes into raw
        // characters and corrupts the string (e.g. `'\n'` -> a real newline,
        // which breaks a single-quoted literal).
        const raw = node.extra?.raw ?? node.raw;
        if (raw != null) return raw;
        // Synthesized node with no source — quote and escape the value.
        return JSON.stringify(node.value);
      }
      if (node.raw != null) return node.raw;
      return String(node.value);

    case "NumericLiteral":
      return String(node.value);

    case "BooleanLiteral":
      return String(node.value);

    case "NullLiteral":
      return "null";

    case "RegExpLiteral":
      return `/${node.pattern}/${node.flags ?? ""}`;

    case "TemplateLiteral": {
      const quasis = node.quasis ?? [];
      const exprs = node.expressions ?? [];
      let result = "`";
      for (let i = 0; i < quasis.length; i++) {
        result += quasis[i].value?.raw ?? quasis[i].value?.cooked ?? "";
        if (i < exprs.length) {
          result += "${" + print(exprs[i]) + "}";
        }
      }
      return result + "`";
    }

    case "TemplateElement":
      return node.value?.raw ?? "";

    // ── Expressions ────────────────────────────────────────────────
    case "CallExpression":
    case "OptionalCallExpression": {
      const callee = print(node.callee);
      const typeArgs = printTypeArguments(node);
      const args = (node.arguments ?? []).map(print).join(", ");
      const opt = node.optional ? "?." : "";
      return `${callee}${opt}${typeArgs}(${args})`;
    }

    case "MemberExpression":
    case "OptionalMemberExpression": {
      const obj = print(node.object);
      const prop = print(node.property);
      if (node.computed) return `${obj}[${prop}]`;
      const opt = node.optional ? "?." : ".";
      return `${obj}${opt}${prop}`;
    }

    case "ChainExpression":
      return print(node.expression);

    case "V8IntrinsicExpression": {
      const name = typeof node.name === "string" ? node.name : print(node.name);
      const args = (node.arguments ?? []).map(print).join(", ");
      return `%${name}(${args})`;
    }

    case "ParenthesizedExpression":
      return `(${print(node.expression)})`;

    case "ArrowFunctionExpression": {
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const params = (node.params ?? []).map(print).join(", ");
      const returnType = node.returnType ? print(node.returnType) : "";
      const body = print(node.body);
      const async = node.async ? "async " : "";
      return `${async}${typeParams}(${params})${returnType} => ${body}`;
    }

    case "FunctionExpression": {
      const id = node.id ? " " + print(node.id) : "";
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const params = (node.params ?? []).map(print).join(", ");
      const returnType = node.returnType ? print(node.returnType) : "";
      const body = print(node.body);
      const async = node.async ? "async " : "";
      const gen = node.generator ? "*" : "";
      return `${async}function${gen}${id}${typeParams}(${params})${returnType} ${body}`;
    }

    case "AssignmentExpression":
      return `${print(node.left)} ${node.operator} ${print(node.right)}`;

    case "BinaryExpression":
    case "LogicalExpression":
      return `${print(node.left)} ${node.operator} ${print(node.right)}`;

    case "UnaryExpression":
      if (node.prefix) {
        const space = node.operator.length > 1 ? " " : "";
        return `${node.operator}${space}${print(node.argument)}`;
      }
      return `${print(node.argument)}${node.operator}`;

    case "UpdateExpression":
      return node.prefix
        ? `${node.operator}${print(node.argument)}`
        : `${print(node.argument)}${node.operator}`;

    case "ConditionalExpression":
      return `${print(node.test)} ? ${print(node.consequent)} : ${print(node.alternate)}`;

    case "SequenceExpression":
      return (node.expressions ?? []).map(print).join(", ");

    case "SpreadElement":
    case "ExperimentalSpreadProperty":
      return `...${print(node.argument)}`;

    case "YieldExpression":
      return node.delegate ? `yield* ${print(node.argument)}` : `yield ${print(node.argument)}`;

    case "AwaitExpression":
      return `await ${print(node.argument)}`;

    case "TaggedTemplateExpression":
      return `${print(node.tag)}${printTypeArguments(node)}${print(node.quasi)}`;

    case "NewExpression": {
      const callee = print(node.callee);
      const typeArgs = printTypeArguments(node);
      const args = (node.arguments ?? []).map(print).join(", ");
      return `new ${callee}${typeArgs}(${args})`;
    }

    case "ThisExpression":
      return "this";

    case "Super":
      return "super";

    case "MetaProperty":
      return `${print(node.meta)}.${print(node.property)}`;

    case "ImportExpression": {
      const source = print(node.source);
      return `import(${source})`;
    }

    // ── Patterns ───────────────────────────────────────────────────
    case "ArrayExpression":
    case "ArrayPattern": {
      const elems = (node.elements ?? []).map((e) => (e ? print(e) : "")).join(", ");
      return `[${elems}]`;
    }

    case "ObjectExpression":
    case "ObjectPattern": {
      const props = (node.properties ?? []).map(print).join(", ");
      return `{ ${props} }`;
    }

    case "Property": {
      const key = print(node.key);
      if (node.shorthand) return key;
      if (node.method) {
        const params = (node.value?.params ?? []).map(print).join(", ");
        const body = print(node.value?.body);
        return `${key}(${params}) ${body}`;
      }
      return `${key}: ${print(node.value)}`;
    }

    case "RestElement":
    case "ExperimentalRestProperty":
      return `...${print(node.argument)}`;

    case "AssignmentPattern":
      return `${print(node.left)} = ${print(node.right)}`;

    // ── Statements ─────────────────────────────────────────────────
    case "ExpressionStatement":
      return print(node.expression) + ";";

    case "BlockStatement":
    case "StaticBlock": {
      const body = (node.body ?? []).map(print).join("\n");
      return braceBlock(body);
    }

    case "EmptyStatement":
      return ";";

    case "DebuggerStatement":
      return "debugger;";

    case "ReturnStatement":
      return node.argument ? `return ${print(node.argument)};` : "return;";

    case "BreakStatement":
      return node.label ? `break ${print(node.label)};` : "break;";

    case "ContinueStatement":
      return node.label ? `continue ${print(node.label)};` : "continue;";

    case "LabeledStatement":
      return `${print(node.label)}: ${print(node.body)}`;

    case "VariableDeclaration": {
      const decls = (node.declarations ?? []).map(print).join(", ");
      const declare = node.declare ? "declare " : "";
      return `${declare}${node.kind} ${decls};`;
    }

    case "VariableDeclarator": {
      const id = print(node.id);
      return node.init ? `${id} = ${print(node.init)}` : id;
    }

    case "IfStatement": {
      let result = `if (${print(node.test)}) ${print(node.consequent)}`;
      if (node.alternate) result += ` else ${print(node.alternate)}`;
      return result;
    }

    case "SwitchStatement": {
      const disc = print(node.discriminant);
      const cases = (node.cases ?? []).map(print).join("\n");
      return `switch (${disc}) ${braceBlock(cases)}`;
    }

    case "SwitchCase": {
      const test = node.test ? `case ${print(node.test)}:` : "default:";
      const body = (node.consequent ?? []).map(print).join("\n");
      return body ? `${test}\n${indent(body)}` : test;
    }

    case "ThrowStatement":
      return `throw ${print(node.argument)};`;

    case "TryStatement": {
      let result = `try ${print(node.block)}`;
      if (node.handler) result += ` ${print(node.handler)}`;
      if (node.finalizer) result += ` finally ${print(node.finalizer)}`;
      return result;
    }

    case "CatchClause": {
      const param = node.param ? `(${print(node.param)})` : "";
      return `catch${param ? " " + param : ""} ${print(node.body)}`;
    }

    case "WhileStatement":
      return `while (${print(node.test)}) ${print(node.body)}`;

    case "DoWhileStatement":
      return `do ${print(node.body)} while (${print(node.test)});`;

    case "ForStatement": {
      const init = node.init ? print(node.init).replace(/;$/, "") : "";
      const test = node.test ? print(node.test) : "";
      const update = node.update ? print(node.update) : "";
      return `for (${init}; ${test}; ${update}) ${print(node.body)}`;
    }

    case "ForInStatement":
      return `for (${print(node.left)} in ${print(node.right)}) ${print(node.body)}`;

    case "ForOfStatement": {
      const aw = node.await ? "await " : "";
      return `for ${aw}(${print(node.left)} of ${print(node.right)}) ${print(node.body)}`;
    }

    case "WithStatement":
      return `with (${print(node.object)}) ${print(node.body)}`;

    // ── Declarations ───────────────────────────────────────────────
    case "FunctionDeclaration":
    case "TSDeclareFunction": {
      const id = node.id ? print(node.id) : "";
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const params = (node.params ?? []).map(print).join(", ");
      const returnType = node.returnType ? print(node.returnType) : "";
      const body = node.body ? " " + print(node.body) : ";";
      const async = node.async ? "async " : "";
      const gen = node.generator ? "*" : "";
      const declare = node.declare ? "declare " : "";
      return `${declare}${async}function${gen} ${id}${typeParams}(${params})${returnType}${body}`;
    }

    case "ClassDeclaration":
    case "ClassExpression": {
      const decorators = (node.decorators ?? []).map(print).join("\n");
      const prefix = decorators ? decorators + "\n" : "";
      const declare = node.declare ? "declare " : "";
      const abstract = node.abstract ? "abstract " : "";
      const id = node.id ? ` ${print(node.id)}` : "";
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const superClass = node.superClass ? ` extends ${print(node.superClass)}` : "";
      const superTypeArgs = node.superTypeArguments ?? node.superTypeParameters;
      const superTypeParams = superTypeArgs ? print(superTypeArgs) : "";
      const impls = (node.implements ?? []).map(print);
      const implStr = impls.length ? ` implements ${impls.join(", ")}` : "";
      const body = print(node.body);
      return `${prefix}${declare}${abstract}class${id}${typeParams}${superClass}${superTypeParams}${implStr} ${body}`;
    }

    case "ClassBody": {
      const body = (node.body ?? []).map(print).join("\n");
      return braceBlock(body);
    }

    case "MethodDefinition":
    case "TSAbstractMethodDefinition": {
      const decorators = (node.decorators ?? []).map(print).join("\n");
      const prefix = decorators ? decorators + "\n" : "";
      const key = print(node.key);
      const value = node.value;
      const typeParams = value?.typeParameters ? print(value.typeParameters) : "";
      const params = (value?.params ?? []).map(print).join(", ");
      const returnType = value?.returnType ? print(value.returnType) : "";
      const body = value?.body ? " " + print(value.body) : ";";
      const staticKw = node.static ? "static " : "";
      const kind = node.kind === "get" ? "get " : node.kind === "set" ? "set " : "";
      const accessibility = node.accessibility ? node.accessibility + " " : "";
      const override = node.override ? "override " : "";
      const abstract = node.type === "TSAbstractMethodDefinition" ? "abstract " : "";
      return `${prefix}${accessibility}${abstract}${override}${staticKw}${kind}${key}${typeParams}(${params})${returnType}${body}`;
    }

    case "PropertyDefinition":
    case "AccessorProperty":
    case "TSAbstractPropertyDefinition":
    case "TSAbstractAccessorProperty": {
      const decorators = (node.decorators ?? []).map(print).join("\n");
      const prefix = decorators ? decorators + "\n" : "";
      const key = print(node.key);
      const staticKw = node.static ? "static " : "";
      const accessibility = node.accessibility ? node.accessibility + " " : "";
      const override = node.override ? "override " : "";
      const readonly = node.readonly ? "readonly " : "";
      const abstract = node.type.startsWith("TSAbstract") ? "abstract " : "";
      const accessor = node.type.includes("Accessor") ? "accessor " : "";
      const typeAnnotation = node.typeAnnotation ? print(node.typeAnnotation) : "";
      const init = node.value ? ` = ${print(node.value)}` : "";
      return `${prefix}${accessibility}${abstract}${override}${staticKw}${readonly}${accessor}${key}${typeAnnotation}${init};`;
    }

    case "Decorator":
      return `@${print(node.expression)}`;

    // ── Imports/Exports ────────────────────────────────────────────
    case "ImportDeclaration": {
      const specs = (node.specifiers ?? []).map(print);
      const source = print(node.source);
      const attrs = (node.attributes ?? []).map(print);
      const attrStr = attrs.length ? ` with { ${attrs.join(", ")} }` : "";
      if (specs.length === 0) return `import ${source}${attrStr};`;
      // `import type { ... }` — a type-only import declaration.
      const typeKind = node.importKind === "type" ? "type " : "";
      const defaultSpec = specs.find(
        (_, i) => node.specifiers[i].type === "ImportDefaultSpecifier",
      );
      const nsSpec = node.specifiers.find((s) => s.type === "ImportNamespaceSpecifier");
      const namedSpecs = node.specifiers.filter((s) => s.type === "ImportSpecifier").map(print);
      const parts = [];
      if (defaultSpec) parts.push(defaultSpec);
      if (nsSpec) parts.push(print(nsSpec));
      if (namedSpecs.length) parts.push(`{ ${namedSpecs.join(", ")} }`);
      return `import ${typeKind}${parts.join(", ")} from ${source}${attrStr};`;
    }

    case "ImportDefaultSpecifier":
      return print(node.local);

    case "ImportSpecifier": {
      const imported = print(node.imported);
      const local = print(node.local);
      const spec = imported === local ? imported : `${imported} as ${local}`;
      // Inline `import { type Foo }` modifier.
      return node.importKind === "type" ? `type ${spec}` : spec;
    }

    case "ImportNamespaceSpecifier":
      return `* as ${print(node.local)}`;

    case "ImportAttribute":
      return `${print(node.key)}: ${print(node.value)}`;

    case "ExportDefaultDeclaration": {
      const declaration = print(node.declaration);
      // Function and class declarations end themselves. Anything else is an
      // expression, and `export default x\n(y)` would otherwise parse as a call.
      const semi = node.declaration?.type?.endsWith("Declaration") ? "" : ";";
      return `export default ${declaration}${semi}`;
    }

    case "ExportNamedDeclaration":
      if (node.declaration) return `export ${print(node.declaration)}`;
      if (node.specifiers?.length) {
        const specs = node.specifiers.map(print).join(", ");
        const from = node.source ? ` from ${print(node.source)}` : "";
        // `export type { ... }` — a type-only export declaration.
        const typeKind = node.exportKind === "type" ? "type " : "";
        return `export ${typeKind}{ ${specs} }${from};`;
      }
      return "";

    case "ExportAllDeclaration": {
      const exported = node.exported ? ` as ${print(node.exported)}` : "";
      const typeKind = node.exportKind === "type" ? "type " : "";
      return `export ${typeKind}*${exported} from ${print(node.source)};`;
    }

    case "ExportSpecifier": {
      const local = print(node.local);
      const exported = print(node.exported);
      const spec = local === exported ? local : `${local} as ${exported}`;
      // Inline `export { type Foo }` modifier.
      return node.exportKind === "type" ? `type ${spec}` : spec;
    }

    // ── JSX (unsupported — Ember uses Glimmer templates) ─────────
    case "JSXElement":
    case "JSXOpeningElement":
    case "JSXClosingElement":
    case "JSXOpeningFragment":
    case "JSXClosingFragment":
    case "JSXIdentifier":
    case "JSXNamespacedName":
    case "JSXMemberExpression":
    case "JSXAttribute":
    case "JSXExpressionContainer":
    case "JSXEmptyExpression":
    case "JSXText":
    case "JSXSpreadAttribute":
    case "JSXSpreadChild":
    case "JSXFragment":
      throw new Error(
        `ember-estree print: unsupported JSX node type '${node.type}' (use Glimmer template nodes instead)`,
      );

    // ── TypeScript: type keywords ──────────────────────────────────
    case "TSAnyKeyword":
      return "any";
    case "TSBigIntKeyword":
      return "bigint";
    case "TSBooleanKeyword":
      return "boolean";
    case "TSIntrinsicKeyword":
      return "intrinsic";
    case "TSNeverKeyword":
      return "never";
    case "TSNullKeyword":
      return "null";
    case "TSNumberKeyword":
      return "number";
    case "TSObjectKeyword":
      return "object";
    case "TSStringKeyword":
      return "string";
    case "TSSymbolKeyword":
      return "symbol";
    case "TSUndefinedKeyword":
      return "undefined";
    case "TSUnknownKeyword":
      return "unknown";
    case "TSVoidKeyword":
      return "void";
    case "TSThisType":
      return "this";

    // ── TypeScript: modifier keywords ──────────────────────────────
    case "TSAbstractKeyword":
      return "abstract";
    case "TSAsyncKeyword":
      return "async";
    case "TSDeclareKeyword":
      return "declare";
    case "TSExportKeyword":
      return "export";
    case "TSPrivateKeyword":
      return "private";
    case "TSProtectedKeyword":
      return "protected";
    case "TSPublicKeyword":
      return "public";
    case "TSReadonlyKeyword":
      return "readonly";
    case "TSStaticKeyword":
      return "static";

    // ── TypeScript: type annotations & references ──────────────────
    case "TSTypeAnnotation":
      return `: ${print(node.typeAnnotation)}`;

    case "TSTypeReference": {
      const name = print(node.typeName);
      return `${name}${printTypeArguments(node)}`;
    }

    case "TSQualifiedName":
      return `${print(node.left)}.${print(node.right)}`;

    case "TSTypeParameterDeclaration":
    case "TSTypeParameterInstantiation": {
      const params = (node.params ?? []).map(print).join(", ");
      return `<${params}>`;
    }

    case "TSTypeParameter": {
      const name = typeof node.name === "string" ? node.name : print(node.name);
      const constraint = node.constraint ? ` extends ${print(node.constraint)}` : "";
      const def = node.default ? ` = ${print(node.default)}` : "";
      const inKw = node.in ? "in " : "";
      const outKw = node.out ? "out " : "";
      const constKw = node.const ? "const " : "";
      return `${constKw}${inKw}${outKw}${name}${constraint}${def}`;
    }

    // ── TypeScript: type operators & combinators ───────────────────
    case "TSUnionType":
      return (node.types ?? []).map(print).join(" | ");

    case "TSIntersectionType":
      return (node.types ?? []).map(print).join(" & ");

    case "TSArrayType":
      return `${print(node.elementType)}[]`;

    case "TSParenthesizedType":
      return `(${print(node.typeAnnotation)})`;

    // JSDoc type syntax (`?Foo`, `!Foo`, `?`) — `postfix` flips prefix/suffix.
    case "TSJSDocNullableType":
      return node.postfix ? `${print(node.typeAnnotation)}?` : `?${print(node.typeAnnotation)}`;

    case "TSJSDocNonNullableType":
      return node.postfix ? `${print(node.typeAnnotation)}!` : `!${print(node.typeAnnotation)}`;

    case "TSJSDocUnknownType":
      return "?";

    case "TSTupleType": {
      const elems = (node.elementTypes ?? []).map(print).join(", ");
      return `[${elems}]`;
    }

    case "TSNamedTupleMember": {
      const label = print(node.label);
      const optional = node.optional ? "?" : "";
      return `${label}${optional}: ${print(node.elementType)}`;
    }

    case "TSOptionalType":
      return `${print(node.typeAnnotation)}?`;

    case "TSRestType":
      return `...${print(node.typeAnnotation)}`;

    case "TSTypeOperator": {
      const op = node.operator ?? "";
      return `${op} ${print(node.typeAnnotation)}`;
    }

    case "TSIndexedAccessType":
      return `${print(node.objectType)}[${print(node.indexType)}]`;

    case "TSConditionalType":
      return `${print(node.checkType)} extends ${print(node.extendsType)} ? ${print(node.trueType)} : ${print(node.falseType)}`;

    case "TSInferType":
      return `infer ${print(node.typeParameter)}`;

    case "TSLiteralType":
      return print(node.literal);

    case "TSTemplateLiteralType": {
      const quasis = node.quasis ?? [];
      const types = node.types ?? [];
      let result = "`";
      for (let i = 0; i < quasis.length; i++) {
        result += quasis[i].value?.raw ?? quasis[i].value?.cooked ?? "";
        if (i < types.length) {
          result += "${" + print(types[i]) + "}";
        }
      }
      return result + "`";
    }

    // ── TypeScript: function & constructor types ───────────────────
    case "TSFunctionType":
    case "TSConstructorType": {
      const newKw = node.type === "TSConstructorType" ? "new " : "";
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const params = (node.params ?? []).map(print).join(", ");
      const returnType = node.returnType ? print(node.returnType) : "";
      return `${newKw}${typeParams}(${params}) => ${returnType.replace(/^: /, "")}`;
    }

    case "TSCallSignatureDeclaration":
    case "TSConstructSignatureDeclaration": {
      const newKw = node.type === "TSConstructSignatureDeclaration" ? "new " : "";
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const params = (node.params ?? []).map(print).join(", ");
      const returnType = node.returnType ? print(node.returnType) : "";
      return `${newKw}${typeParams}(${params})${returnType};`;
    }

    // ── TypeScript: object types & signatures ──────────────────────
    case "TSTypeLiteral": {
      const members = (node.members ?? []).map(print).join("\n");
      return `{\n${members}\n}`;
    }

    case "TSPropertySignature": {
      const readonly = node.readonly ? "readonly " : "";
      const computed = node.computed ? `[${print(node.key)}]` : print(node.key);
      const optional = node.optional ? "?" : "";
      const typeAnnotation = node.typeAnnotation ? print(node.typeAnnotation) : "";
      return `${readonly}${computed}${optional}${typeAnnotation};`;
    }

    case "TSMethodSignature": {
      const computed = node.computed ? `[${print(node.key)}]` : print(node.key);
      const optional = node.optional ? "?" : "";
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const params = (node.params ?? []).map(print).join(", ");
      const returnType = node.returnType ? print(node.returnType) : "";
      return `${computed}${optional}${typeParams}(${params})${returnType};`;
    }

    case "TSIndexSignature": {
      const params = (node.parameters ?? []).map(print).join(", ");
      const typeAnnotation = node.typeAnnotation ? print(node.typeAnnotation) : "";
      const readonly = node.readonly ? "readonly " : "";
      return `${readonly}[${params}]${typeAnnotation};`;
    }

    case "TSMappedType": {
      const readonly = printMappedModifier(node.readonly, "readonly ");
      const param = print(node.typeParameter);
      const nameType = node.nameType ? ` as ${print(node.nameType)}` : "";
      const optional = printMappedModifier(node.optional, "?");
      const typeAnnotation = node.typeAnnotation ? `: ${print(node.typeAnnotation)}` : "";
      return `{ ${readonly}[${param}${nameType}]${optional}${typeAnnotation} }`;
    }

    // ── TypeScript: declarations ───────────────────────────────────
    case "TSInterfaceDeclaration": {
      const declare = node.declare ? "declare " : "";
      const id = print(node.id);
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const ext = (node.extends ?? []).map(print);
      const extStr = ext.length ? ` extends ${ext.join(", ")}` : "";
      const body = print(node.body);
      return `${declare}interface ${id}${typeParams}${extStr} ${body}`;
    }

    case "TSInterfaceBody": {
      const body = (node.body ?? []).map(print).join("\n");
      return braceBlock(body);
    }

    case "TSInterfaceHeritage":
    case "TSClassImplements": {
      const expr = print(node.expression);
      return `${expr}${printTypeArguments(node)}`;
    }

    case "TSTypeAliasDeclaration": {
      const declare = node.declare ? "declare " : "";
      const id = print(node.id);
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      return `${declare}type ${id}${typeParams} = ${print(node.typeAnnotation)};`;
    }

    case "TSEnumDeclaration": {
      const declare = node.declare ? "declare " : "";
      const constKw = node.const ? "const " : "";
      const id = print(node.id);
      // Newer oxc nests members in a TSEnumBody child; older versions put
      // `members` directly on the declaration.
      const members = (node.body?.members ?? node.members ?? []).map(print).join(",\n");
      return `${declare}${constKw}enum ${id} ${braceBlock(members)}`;
    }

    case "TSEnumBody": {
      const members = (node.members ?? []).map(print).join(",\n");
      return braceBlock(members);
    }

    case "TSEnumMember": {
      const id = print(node.id);
      return node.initializer ? `${id} = ${print(node.initializer)}` : id;
    }

    case "TSModuleDeclaration": {
      const declare = node.declare ? "declare " : "";
      const kind = node.kind === "global" ? "global" : `${node.kind ?? "module"} ${print(node.id)}`;
      const body = node.body ? ` ${print(node.body)}` : "";
      return `${declare}${kind}${body}`;
    }

    case "TSModuleBlock": {
      const body = (node.body ?? []).map(print).join("\n");
      return braceBlock(body);
    }

    case "TSNamespaceExportDeclaration":
      return `export as namespace ${print(node.id)};`;

    // ── TypeScript: expressions & assertions ───────────────────────
    case "TSAsExpression":
      return `${print(node.expression)} as ${print(node.typeAnnotation)}`;

    case "TSSatisfiesExpression":
      return `${print(node.expression)} satisfies ${print(node.typeAnnotation)}`;

    case "TSTypeAssertion":
      return `<${print(node.typeAnnotation)}>${print(node.expression)}`;

    case "TSNonNullExpression":
      return `${print(node.expression)}!`;

    case "TSInstantiationExpression": {
      const expr = print(node.expression);
      return `${expr}${printTypeArguments(node)}`;
    }

    // ── TypeScript: imports & exports ──────────────────────────────
    case "TSImportEqualsDeclaration": {
      const id = print(node.id);
      const ref = print(node.moduleReference);
      return `import ${id} = ${ref};`;
    }

    case "TSExternalModuleReference":
      return `require(${print(node.expression)})`;

    case "TSExportAssignment":
      return `export = ${print(node.expression)};`;

    case "TSImportType": {
      const arg = print(node.source ?? node.parameter ?? node.argument);
      const qualifier = node.qualifier ? `.${print(node.qualifier)}` : "";
      return `import(${arg})${qualifier}${printTypeArguments(node)}`;
    }

    // ── TypeScript: parameter & type modifiers ─────────────────────
    case "TSParameterProperty": {
      const accessibility = node.accessibility ? node.accessibility + " " : "";
      const readonly = node.readonly ? "readonly " : "";
      const override = node.override ? "override " : "";
      return `${accessibility}${override}${readonly}${print(node.parameter)}`;
    }

    case "TSTypePredicate": {
      const asserts = node.asserts ? "asserts " : "";
      const name = print(node.parameterName);
      const type = node.typeAnnotation
        ? ` is ${print(node.typeAnnotation).replace(/^: /, "")}`
        : "";
      return `${asserts}${name}${type}`;
    }

    case "TSTypeQuery": {
      const name = print(node.exprName);
      return `typeof ${name}${printTypeArguments(node)}`;
    }

    case "TSEmptyBodyFunctionExpression": {
      const typeParams = node.typeParameters ? print(node.typeParameters) : "";
      const params = (node.params ?? []).map(print).join(", ");
      const returnType = node.returnType ? print(node.returnType) : "";
      return `${typeParams}(${params})${returnType}`;
    }

    // ── Glimmer nodes (Ember templates) ────────────────────────────
    case "GlimmerTemplate": {
      const children = (node.body ?? node.children ?? []).map(print).join("");
      return `<template>${children}</template>`;
    }

    case "GlimmerElementNode": {
      const tag = node.tag ?? "";
      const attrs = (node.attributes ?? []).map(print).join(" ");
      const modifiers = (node.modifiers ?? []).map(print).join(" ");
      const children = (node.children ?? []).map(print).join("");
      const blockParams = node.blockParams ?? [];
      const asParams = blockParams.length ? ` as |${blockParams.join(" ")}|` : "";
      const parts = [tag];
      if (attrs) parts.push(attrs);
      if (modifiers) parts.push(modifiers);
      if (node.selfClosing) return `<${parts.join(" ")} />`;
      return `<${parts.join(" ")}${asParams}>${children}</${tag}>`;
    }

    case "GlimmerElementNodePart":
      return node.original ?? node.name ?? "";

    case "GlimmerTextNode":
      return node.chars ?? "";

    case "GlimmerMustacheStatement": {
      const path = print(node.path);
      const params = (node.params ?? []).map(print).join(" ");
      const hash = node.hash ? print(node.hash) : "";
      const parts = [path];
      if (params) parts.push(params);
      if (hash) parts.push(hash);
      return `{{${parts.join(" ")}}}`;
    }

    case "GlimmerBlockStatement": {
      const path = print(node.path);
      const params = (node.params ?? []).map(print).join(" ");
      const hash = node.hash ? print(node.hash) : "";
      const blockParams = node.program?.blockParams ?? [];
      const asParams = blockParams.length ? ` as |${blockParams.join(" ")}|` : "";
      const body = (node.body ?? node.program?.body ?? []).map(print).join("");
      const inverse = node.inverse
        ? `{{else}}${(node.inverse.body ?? []).map(print).join("")}`
        : "";
      const parts = [path];
      if (params) parts.push(params);
      if (hash) parts.push(hash);
      return `{{#${parts.join(" ")}${asParams}}}${body}${inverse}{{/${print(node.path)}}}`;
    }

    case "GlimmerPathExpression":
      return node.original ?? (node.parts ?? []).join(".");

    case "GlimmerSubExpression": {
      const path = print(node.path);
      const params = (node.params ?? []).map(print).join(" ");
      const hash = node.hash ? print(node.hash) : "";
      const parts = [path];
      if (params) parts.push(params);
      if (hash) parts.push(hash);
      return `(${parts.join(" ")})`;
    }

    case "GlimmerAttrNode": {
      const name = node.name ?? "";
      const value = node.value;
      // A plain text value carries no quote style in the AST, so quote it
      // (always valid) — printing it raw drops the quotes and corrupts any
      // value with whitespace, e.g. `data-x="a b"` -> `data-x=a b`. An empty
      // text value is a valueless attribute (`<input disabled>`).
      if (value?.type === "GlimmerTextNode") {
        const chars = value.chars ?? "";
        if (chars === "") return name;
        const quote = chars.includes('"') ? "'" : '"';
        return `${name}=${quote}${chars}${quote}`;
      }
      // Mustache (`{{x}}`) and concat (`"a {{b}}"`) values print themselves.
      return `${name}=${print(value)}`;
    }

    case "GlimmerConcatStatement": {
      const parts = (node.parts ?? []).map(print).join("");
      return `"${parts}"`;
    }

    case "GlimmerHash": {
      const pairs = (node.pairs ?? []).map(print).join(" ");
      return pairs;
    }

    case "GlimmerHashPair":
      return `${node.key}=${print(node.value)}`;

    case "GlimmerStringLiteral":
      return `"${node.value ?? ""}"`;

    case "GlimmerBooleanLiteral":
      return String(node.value);

    case "GlimmerNumberLiteral":
      return String(node.value);

    case "GlimmerNullLiteral":
      return "null";

    case "GlimmerUndefinedLiteral":
      return "undefined";

    case "GlimmerCommentStatement":
      return `<!--${node.value ?? ""}-->`;

    case "GlimmerMustacheCommentStatement":
      return node.longForm ? `{{!-- ${node.value ?? ""} --}}` : `{{! ${node.value ?? ""} }}`;

    case "GlimmerElementModifierStatement": {
      const path = print(node.path);
      const params = (node.params ?? []).map(print).join(" ");
      const hash = node.hash ? print(node.hash) : "";
      const parts = [path];
      if (params) parts.push(params);
      if (hash) parts.push(hash);
      return `{{${parts.join(" ")}}}`;
    }

    case "GlimmerBlock":
    case "GlimmerProgram": {
      return (node.body ?? []).map(print).join("");
    }

    // ── Program (root) ─────────────────────────────────────────────
    case "Program":
      return (node.body ?? []).map(print).join("\n");

    default:
      throw new Error(`ember-estree print: unsupported node type '${node.type}'`);
  }
}

/**
 * Prints the `<...>` type arguments of a call, `new`, tagged template, type
 * reference, or heritage clause. oxc-parser and typescript-estree v8 put
 * them on `typeArguments`; older typescript-estree used `typeParameters`.
 * @param {object} node
 * @return {string}
 */
function printTypeArguments(node) {
  const args = node.typeArguments ?? node.typeParameters;
  return args ? print(args) : "";
}

/**
 * Prints an identifier with an optional TS type annotation.
 * @param {string} name
 * @param {object} node
 * @return {string}
 */
/**
 * Indents every non-empty line of a block's inner content by one level.
 * Nesting compounds naturally: each enclosing block re-indents the
 * already-formatted child string.
 * @param {string} text
 * @return {string}
 */
function indent(text) {
  return text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

/**
 * Wraps already-joined statement text in a brace block, indented one level.
 * Empty content collapses to `{}`.
 * @param {string} inner
 * @return {string}
 */
function braceBlock(inner) {
  return inner ? `{\n${indent(inner)}\n}` : "{}";
}

function printTypeAnnotated(name, node) {
  const optional = node.optional ? "?" : "";
  const typeAnnotation = node.typeAnnotation ? print(node.typeAnnotation) : "";
  return `${name}${optional}${typeAnnotation}`;
}

/**
 * Prints a TSMappedType modifier (readonly or optional) which can be
 * `true`, `'+'`, `'-'`, or falsy.
 * @param {boolean|string|undefined} modifier
 * @param {string} token - e.g. 'readonly ' or '?'
 * @return {string}
 */
function printMappedModifier(modifier, token) {
  if (modifier === true) return token;
  if (modifier === "+") return `+${token}`;
  if (modifier === "-") return `-${token}`;
  return "";
}
