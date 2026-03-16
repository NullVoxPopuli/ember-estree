/**
 * Options accepted by `parse` and `toTree`.
 */
export interface ParseOptions {
  /** Path to the file being parsed, used to determine the language (js/ts). */
  filePath?: string;
}

/**
 * A 1-based line / 0-based column position, matching ESTree and Glimmer
 * conventions.
 */
export interface Position {
  line: number;
  column: number;
}

/**
 * Minimal shape shared by every AST node (ESTree, TypeScript, and Glimmer).
 */
export interface ASTNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

/**
 * The `File`-like wrapper returned by `toTree` and `parse`.
 *
 * Mirrors the shape produced internally:
 * ```
 * { type: "File", program: Program, comments: Comment[], start, end }
 * ```
 */
export interface FileNode extends ASTNode {
  type: "File";
  program: ASTNode;
  comments: ASTNode[];
}

/**
 * Converts between character offsets and line/column positions within a
 * source string.
 */
export class DocumentLines {
  constructor(source: string);

  /** Converts a `{ line, column }` position to a character offset. */
  positionToOffset(pos: Position): number;

  /** Converts a character offset to a `{ line, column }` position. */
  offsetToPosition(offset: number): Position;
}

/**
 * Parse Ember .gjs/.gts source code and return a File-like ESTree-compatible
 * AST with embedded Glimmer template nodes.
 *
 * @param source  The raw source code of the file.
 * @param options Optional parse options.
 * @returns A `File`-shaped object with a `.program` property.
 */
export function toTree(source: string, options?: ParseOptions): FileNode;

/**
 * Parse Ember .gjs/.gts source code into an ESTree-compatible AST with
 * embedded Glimmer template nodes.
 *
 * @param source  The source code to parse.
 * @param options Optional parse options.
 * @returns The ESTree-compatible AST.
 */
export function parse(source: string, options?: ParseOptions): FileNode;

/**
 * Recursively print an AST node back to source code.
 *
 * Handles ESTree, TypeScript, and Glimmer template node types.
 * JSX nodes are not supported — Ember uses Glimmer templates instead.
 *
 * @param node The AST node to print.
 * @returns The printed source string.
 */
export function print(node: ASTNode): string;

/**
 * Build and return the Glimmer visitor keys map with a `"Glimmer"` prefix on
 * every key (e.g. `"GlimmerElementNode"`).
 *
 * The result is cached after the first call.
 *
 * @returns A map of Glimmer node type names to arrays of child-property names.
 */
export function buildGlimmerVisitorKeys(): Record<string, string[]>;

/**
 * Recursively remove all `parent` references from an AST.
 * Useful when you need to serialize the tree to JSON,
 * since parent back-references create circular structures.
 *
 * Mutates the tree in place and returns it.
 */
export function removeParentReferences(ast: ASTNode): ASTNode;

/**
 * Options for processGlimmerTemplateFromSource.
 */
export interface ProcessGlimmerTemplateOptions {
  /** Byte offset where the template content begins in the full source. */
  contentOffset: number;
  /** [start, end] byte range of the full template block (including tags if present). */
  templateRange: [number, number];
  /** The full source code of the file. */
  source: string;
  /** Byte offset where content ends. Defaults to templateRange[1] - "</template>".length. */
  contentEnd?: number;
}

/**
 * Parse a raw template content string and process it into an ESTree-compatible
 * Glimmer AST with range/loc fixing, type prefixing, and tokenization.
 *
 * This is the main entry point for consumers that need to process standalone
 * template content (e.g. .hbs files or template regions extracted by content-tag).
 *
 * @param content The raw template content (inner content, without <template> tags).
 * @param opts Processing options including offsets and source.
 * @returns The transformed AST with .tokens and .comments attached.
 */
export function processGlimmerTemplateFromSource(
  content: string,
  opts: ProcessGlimmerTemplateOptions,
): ASTNode;
