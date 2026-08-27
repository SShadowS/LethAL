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
 * `"run-trigger-skipped-insert"` — rewriting `Insert(true)` to `Insert(false)` skips `OnInsert`. On
 * a table whose `OnInsert` assigns the primary key that leaves the key blank: the first blank-key
 * insert succeeds, because blank is a legal `Code[20]`, and a second raises a duplicate primary key.
 * The single-row variant is a later `Get`/`Modify` on the expected key raising "the record does not
 * exist". Either way the test dies on the platform before evaluating any assertion. R138, measured
 * live on the table fixture's arm K, whose covering test asserts nothing at all.
 *
 * THE TWO ARE NOT EQUALLY PROVEN, and the report must not present them as if they were. The
 * write-transaction tag is emitted only where a detector found the exact measured shape.
 * `run-trigger-skipped-insert` is emitted on EVERY `Insert` mutant, because whether the target
 * table's `OnInsert` touches the primary key is not visible at the call site and, for a base-app
 * record, is not visible at all — the semantic layer is source-derived and cannot see base-app
 * triggers. So it means "a kill here CAN be the platform; read it", never "this kill is false".
 * See `PLATFORM_KILL_MECHANISM_EXPLANATIONS` (runner), where each mechanism states its own evidence.
 *
 * `Delete` and `Modify` get NO mechanism, ruled 2026-08-14 and recorded on R138: skipping `OnDelete`
 * or `OnModify` writes LESS than the unmutated program, never more, and the row is still located by
 * the same key — there is no error the mutation can add.
 *
 * Deliberately keyed on SYNTAX and never on BC's failure text. The refusal's message is BC's
 * generic "An error occurred and the transaction is stopped", which names neither `Codeunit.Run`
 * nor the rule (so a text rule would fire on any platform-stopped transaction) and which localises
 * (R66), making a text rule English-only. A syntactic marker has neither ceiling.
 */
export type PlatformKillMechanism =
  | "write-txn-codeunit-run"
  | "run-trigger-skipped-insert"
  /**
   * R165 — the MIRROR of the one above. `Rec.Modify()` means `RunTrigger = false`, so rewriting it
   * to `Rec.Modify(true)` makes the table's `OnModify` run where it did not. Forcing a trigger
   * writes MORE than the unmutated program, so unlike SKIPPING one it can add an error: an `Error`,
   * a `TestField`, a `FieldError`, or a write to another table that hits a duplicate key.
   *
   * Emitted only where the trigger body PROVABLY contains a raise-capable statement, which is
   * possible here and not for the skip direction because the forward operator is scoped to tables
   * this project declares and that declare the trigger. See `forcedTriggerCanRaise`.
   */
  | "run-trigger-forced";

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

/**
 * R172: this operator's survivors are LIKELIER than average to be equivalent mutants, and why.
 *
 * An equivalent mutant is a survivor that no test could ever kill, because the mutated program
 * behaves identically. It is reported exactly like a survivor that IS a lead, so a reader chases it
 * and loses the time the tool exists to save. Deciding equivalence in general is undecidable and the
 * tractable cases need dataflow the AST layer does not have, so this does NOT claim any particular
 * mutant is equivalent. It says which operators' survivors are worth reading with that in mind.
 *
 * Only declared where a spike MEASURED an equivalent survivor, not wherever one seems plausible.
 * Over-declaring makes the hint useless the same way R175's first detector did: a flag that fires on
 * most survivors retires the word "survivor" without replacing it.
 *
 * Nothing about a verdict or the score moves. See `SessionReport.likelyEquivalentSurvivors`.
 */
export type EquivalenceRisk =
  /** The operator rewrites a WRITTEN or COMPARED value. If nothing downstream reads it, the mutant
   *  is equivalent and no source-derived layer can see that. */
  | "value-rewrite"
  /** The operator bounds a LOOP. Where the covering test drives exactly one iteration, truncating to
   *  one iteration changes nothing. */
  | "loop-truncation";

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
  /** R172 — see `EquivalenceRisk`. Absent means no elevated risk is claimed. */
  readonly equivalenceRisk?: EquivalenceRisk;
  readonly conformanceTests: readonly ConformanceCase[];
}
