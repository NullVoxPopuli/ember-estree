export interface ASTNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

export class Definition {
  type: string;
  name: ASTNode;
  node: ASTNode;
  parent: ASTNode;
  index: number | null;
  constructor(type: string, name: ASTNode, node: ASTNode, parent: ASTNode, index?: number | null);
}

export class Variable {
  name: string;
  scope: Scope;
  defs: Definition[];
  references: Reference[];
  identifiers: ASTNode[];
  constructor(name: string, scope: Scope);
}

export class Reference {
  identifier: ASTNode;
  from: Scope;
  resolved: Variable | null;
  flag: number;
  readonly scope: Scope;
  static readonly READ: number;
  static readonly WRITE: number;
  static readonly RW: number;
  constructor(identifier: ASTNode, scope: Scope, flag?: number);
  isRead(): boolean;
  isWrite(): boolean;
  isReadWrite(): boolean;
}

export class Scope {
  type: string;
  block: ASTNode;
  upper: Scope | null;
  childScopes: Scope[];
  variables: Variable[];
  references: Reference[];
  through: Reference[];
  set: Map<string, Variable>;
  isStrict: boolean;
  constructor(type: string, block: ASTNode, upper: Scope | null, isStrict?: boolean);
}

export class ScopeManager {
  scopes: Scope[];
  globalScope: Scope;
  constructor();
  acquire(node: ASTNode, inner?: boolean): Scope | null;
  getDeclaredVariables(node: ASTNode): Variable[];
}

export interface AnalyzeOptions {
  sourceType?: "module" | "script";
}

export function analyze(ast: ASTNode, options?: AnalyzeOptions): ScopeManager;
