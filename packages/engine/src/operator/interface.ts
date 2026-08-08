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

/**
 * A syntactic property of the mutation SITE which says that if this mutant dies, the platform, and
 * not the test suite, is the likely cause of death. R72.
 *
 * `"write-txn-codeunit-run"` — deleting this `Commit()` can leave a write transaction open across
 * a later `Codeunit.Run` whose RETURN VALUE is consumed, and BC refuses that outright. Measured
 * 2026-08-08 on Cronus281 (`scripts/r72-probe/`): a 2x2x2 over prior `Commit()`, call frame and
 * call form found the return-value form to be the only factor, in both frames and with or without
 * a prior commit; two later arms measured the guard form (`if not Codeunit.Run(X) then ...`) and it
 * aborts identically. The bare statement form `Codeunit.Run(X);` survives in every cell.
 *
 * NEVER a verdict input. A killed mutant carrying this stays killed — the field annotates a kill,
 * it does not re-score one (design §6.7's timeout precedent, and the discipline R121 also obeys).
 * Re-scoring would invalidate every frozen gate figure and every committed campaign baseline.
 *
 * Deliberately keyed on SYNTAX and never on BC's failure text. The refusal's message is BC's
 * generic "An error occurred and the transaction is stopped", which names neither `Codeunit.Run`
 * nor the rule (so a text rule would fire on any platform-stopped transaction) and which localises
 * (R66), making a text rule English-only. A syntactic marker has neither ceiling.
 */
export type PlatformKillMechanism = "write-txn-codeunit-run";

export interface MutationSpec {
  readonly operatorName: string;
  readonly operatorVersion: string;
  readonly astNodeId: AstNodeId;
  readonly before: ALSyntaxNode;
  readonly after: ALSyntaxNode;
  readonly parentContext: ParentContextHint;
  readonly equivalenceHint?: EquivalenceHint;
  /** See `PlatformKillMechanism`. Absent means "no such mechanism was recognised at this site",
   *  which is not a claim that a kill here would be assertion-earned. */
  readonly platformKillMechanism?: PlatformKillMechanism;
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
