import type { ALNodeKind } from "../ast/node-kinds";
import type { ALSyntaxNode } from "../ast/syntax-node";
import type { SemanticContext } from "../semantic/context";

export type SemanticCapability = "symbol-table" | "cfg" | "type-info";
export type ParentContextHint =
  | "statement-position"
  | "expression-position"
  | "short-circuit-operand";
export type EquivalenceHint = "likely-equivalent" | "unknown";
export type AstNodeId = string;

export interface MutationSpec {
  readonly operatorName: string;
  readonly operatorVersion: string;
  readonly astNodeId: AstNodeId;
  readonly before: ALSyntaxNode;
  readonly after: ALSyntaxNode;
  readonly parentContext: ParentContextHint;
  readonly equivalenceHint?: EquivalenceHint;
}

export interface ConformanceCase {
  readonly name: string;
  readonly sourceAL: string;
  readonly expectedSpecs: ReadonlyArray<{
    readonly parentContext: ParentContextHint;
    readonly beforeText: string;
    readonly afterText: string;
  }>;
}

export interface MutationOperator {
  readonly name: string;
  readonly version: string;
  readonly tier: 1 | 2 | 3 | "custom";
  readonly targetNodeKinds: readonly ALNodeKind[];
  readonly producesNodeKinds: readonly ALNodeKind[];
  readonly requiresSemantic: readonly SemanticCapability[];
  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean;
  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[];
  isEquivalent?(spec: MutationSpec, ctx: SemanticContext): boolean;
  readonly conformanceTests: readonly ConformanceCase[];
}
