export interface Position {
  line: number;
  column: number;
}

export interface ASTNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

export interface ParseError {
  message: string;
  severity?: string;
  [key: string]: unknown;
}

export interface FileNode extends ASTNode {
  type: "File";
  program: ASTNode;
  comments: ASTNode[];
  /**
   * Diagnostics from the JS/TS parser (oxc-parser on the default path). On an
   * unrecoverable script error oxc returns an empty `program.body`; check
   * this to tell that apart from an empty file.
   */
  errors: ParseError[];
}

export interface TemplateResult {
  ast: ASTNode;
  comments: ASTNode[];
}

export interface VisitorPath {
  node: ASTNode;
  parent: ASTNode | null;
  parentPath: VisitorPath | null;
}

export interface ParseOptions {
  filePath?: string;
  templateOnly?: boolean;
  /**
   * Custom JS/TS parser. Called with the placeholder JS string
   * (templates replaced with `void `...`` expressions, or `static{`...`}`
   * blocks for class members, of equal length).
   * Must return at least `{ ast }`.
   */
  parser?: (placeholderJS: string) => { ast: ASTNode; [key: string]: unknown };
  /**
   * Callbacks fired on each node during traversal — outer JS/TS nodes AND
   * spliced Glimmer subtrees — so callers can gather information or mutate
   * the tree in a single pass.
   *
   * Pass either a plain handler map, or a factory `(outerAst) => handlers`
   * that's called once after parsing (before template splicing) when you
   * need a view of the raw JS/TS tree up front.
   *
   * The pseudo-type `GlimmerBlockParams` fires on any node that carries
   * a `blockParams` array.
   */
  visitors?: VisitorMap | ((outerAst: ASTNode) => VisitorMap | null | undefined);
}

export type VisitorMap = {
  [nodeType: string]: (node: ASTNode, path: VisitorPath) => void;
};

export class DocumentLines {
  constructor(source: string);
  positionToOffset(pos: Position): number;
  offsetToPosition(offset: number): Position;
}

export function toTree(source: string, options?: ParseOptions): FileNode | TemplateResult;
export function parse(source: string, options?: ParseOptions): FileNode | TemplateResult;
export function print(node: ASTNode): string;

/**
 * Values a builder template can interpolate: AST nodes are printed,
 * arrays are comma-separated, strings and other primitives are inserted
 * verbatim.
 */
export type BuilderValue = string | number | boolean | ASTNode | BuilderValue[];

export function statement(strings: TemplateStringsArray, ...values: BuilderValue[]): ASTNode;
export function statements(strings: TemplateStringsArray, ...values: BuilderValue[]): ASTNode[];

export const glimmerVisitorKeys: Record<string, string[]>;
