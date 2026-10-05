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
 * `run-trigger-skipped-insert` is a REFUSAL detector (R143, `insertSkipCanRaise`): it is dropped
 * only where the target table resolves and its `OnInsert` provably does not assign the primary key,
 * and KEPT wherever that cannot be shown, which includes every base-app record — the semantic layer
 * is source-derived and cannot see base-app triggers. So it means "a kill here CAN be the platform;
 * read it", never "this kill is false". See `PLATFORM_KILL_MECHANISM_EXPLANATIONS` (runner), where
 * each mechanism states its own evidence.
 *
 * `"run-trigger-skipped-delete"` — R281, the same kind of refusal detector for `Delete(true)` to
 * `Delete(false)`. R138 ruled (2026-08-14) that skipping `OnDelete` only writes less and so cannot
 * add an error. That is wrong for an `OnDelete` that deletes or writes OTHER rows: they are left
 * behind, and a later insert of one hits a duplicate key no test asserted. Dropped only where
 * skipping the table's delete code is proven harmless (`deleteSkipCanRaise`). The duplicate-key
 * route itself is NOT measured live for `Delete`.
 *
 * `"run-trigger-skipped-modify"` — R-452, the same refusal detector for `Modify(true)` to
 * `Modify(false)` and for `ModifyAll(F, V, true)` to `..., false)` (`modifySkipCanRaise`). R138's
 * "skipping `OnModify` writes less" holds for the row itself and not for an `OnModify` that writes
 * OTHER rows. `DeleteAll(true)` to `DeleteAll(false)` carries `run-trigger-skipped-delete`.
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
   * R-457: also on `flip-boolean-literal`'s `false` -> `true` RunTrigger flips (`Modify(false)`,
   * `Insert(false)`, `Delete(false)`, `ModifyAll(F, V, false)`, `DeleteAll(false)`). Kept unless
   * `forceCanRaise` proves the table has no such trigger and no observer of it in this project; no
   * trigger body is read, so a table it cannot read keeps the tag.
   */
  | "run-trigger-forced"
  /** R281 — see the type's comment above. */
  | "run-trigger-skipped-delete"
  /** R-452 — see the type's comment above. */
  | "run-trigger-skipped-modify";

/**
 * R196: which rule decided this site can make a loop run forever.
 *
 * A named union rather than a boolean so the report can say WHICH rule fired. v1 has one value.
 * The design's section 3.2 widenings would add `"loop-body-target"`, `"loop-preheader"` and
 * `"callee-global"`, each carrying a different confidence that a boolean would flatten into one
 * undifferentiated flag.
 */
export type HangCapableReason = "loop-condition-target";

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
  /**
   * R196: set when an enclosing loop's condition reads the variable this site writes.
   *
   * This claims exactly that relationship and nothing more. It does NOT claim the mutation
   * prevents progress, and an absent tag does NOT mean the site is safe: the design's section 3.2
   * lists shapes that are unclassified rather than cleared. See section 3.3.
   */
  readonly hangCapable?: HangCapableReason;
}

export interface ConformanceCase {
  readonly name: string;
  readonly sourceAL: string;
  readonly expectedSpecs: ReadonlyArray<{
    readonly parentContext: ParentContextHint;
    readonly beforeText: string;
    readonly afterText: string;
    /**
     * R196: `undefined` asserts nothing, a reason asserts the spec carries exactly it, and `null`
     * asserts the spec carries NO tag.
     *
     * The `null` arm is the load-bearing one. Without it an operator that quietly stopped emitting
     * the tag would keep every conformance case green, which is the failure this field exists to
     * prevent, and the third appearance in this harness of the shape R137 and R142 closed.
     */
    readonly hangCapable?: HangCapableReason | null;
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
  /**
   * R447: true where every check of this operator admits `node` EXCEPT R196's hang check, which
   * refused it (the mutation could make an enclosing loop never end). The generator counts these
   * per file as an `excludedSites` row with reason `hang-refused`, which narrows `reliability`.
   *
   * An operator that does not implement this is never counted. A plug-in that refuses hang-capable
   * sites without it makes those refusals invisible in `excludedSites`, and the run's
   * `reliability` does not narrow for them.
   */
  refusesHangCapable?(node: ALSyntaxNode, ctx: SemanticContext): boolean;
  isEquivalent?(spec: MutationSpec, ctx: SemanticContext): boolean;
  /** R172 — see `EquivalenceRisk`. Absent means no elevated risk is claimed. */
  readonly equivalenceRisk?: EquivalenceRisk;
  readonly conformanceTests: readonly ConformanceCase[];
}
