import type { MutationOperator } from "@lethal/operator-sdk";
import { removeCalcFields } from "./remove-calcfields";
import { removeCommit } from "./remove-commit";
import { removeSetRange } from "./remove-setrange";
import { removeTestField } from "./remove-testfield";
import { swapFindDirection } from "./swap-find-direction";
import { swapModifyFlag } from "./swap-modify-flag";
import { swapRecXRec } from "./swap-rec-xrec";

export { removeTestField } from "./remove-testfield";
export { removeSetRange } from "./remove-setrange";
export { removeCalcFields } from "./remove-calcfields";
export { swapModifyFlag } from "./swap-modify-flag";
export { removeCommit } from "./remove-commit";
export { swapRecXRec } from "./swap-rec-xrec";
export { swapFindDirection } from "./swap-find-direction";
export { claimsRecordMethod, claimsSystemCall, calleeNameNode } from "./receiver";

/**
 * Tier 2 operator registry.
 *
 * Phase 1 (docs/superpowers/plans/2026-07-26-tier2-phase1.md, Tasks 3-6): `RemoveTestField`,
 * `RemoveSetRange`, `RemoveCalcFields`, `SwapModifyFlag`. Phase 2 (R33, spec §5): `RemoveCommit`
 * alone — the other two candidates were both REFUSED, each for a stated reason.
 *
 * **`RemoveSetLoadFields` is not built — a JUDGMENT, not a construction proof.** Two earlier
 * justifications written here were wrong and are recorded as wrong: first "the kill paths are
 * pathological", then "unkillable by construction — omitted fields are fetched JIT, so no error can
 * be raised in either direction". MEASURED 2026-07-31 (`Tier2Phase2Probe.ReportsJitRereadOfDeletedRow`,
 * Cronus281): the JIT fetch REREADS THE ROW, and rereading a row deleted since the partial read
 * RAISES — `JIT loading of field(s): 'Amount' failed for table: 'Rec XRec Probe' identification
 * values: 'No.='JIT1''`. So the mutant IS killable: with the call present that access raises, with
 * it deleted the field was already in memory and does not, and an `asserterror` distinguishes them.
 * It is refused anyway, on cost rather than on impossibility: the kill needs the row to be deleted
 * or changed between the partial read and the field access, which no ordinary suite arranges, so on
 * real code the operator would emit near-universal survivors that say nothing about test quality.
 * Anyone who disagrees now has the measurement rather than an assertion to argue with.
 *
 * **`SwapRecXRec` is DEFERRED, not refused — and the first write-up of it here was wrong.** The
 * spec's go criterion was framed around `Modify(true)`, the probe answered exactly that, and the
 * conclusion written was "the operator is not built" for every `xRec` site. An adversarial review
 * caught the overreach and the follow-up probes settled it. Measured on Cronus281, all through the
 * FENCED path (`fixtures/sandbox-probes/src/RecXRecProbe*.al`, `Tier2Phase2Probe`):
 *
 *   - `OnModify`, driven by a record-variable `Modify(true)`: `rec=250 | xrec=250 | differ=No`
 *     (identical through the hub — not a runner property). No signal, as the spec suspected.
 *   - field `OnValidate`, driven by `Validate(Amount, 250)`: `rec=250 | xrec=100 | differ=YES`.
 *   - `OnRename`, driven by `Rename('R2')`: `rec.No=R2 | xrec.No=R1 | differ=YES`.
 *
 * So `xRec` carries real information headlessly in exactly the trigger kinds where AL code reads
 * it (`if F <> xRec.F then` change detection, old-vs-new key), and a `SwapRecXRec` SCOPED to
 * validate/rename sites has signal. Building it is its own item (R71) — what is settled here is
 * that the blanket no-go was wrong. See ROADMAP R33.
 *
 * Every pipeline site that needs to know about Tier 2 (the operator generation walk and the
 * `operatorTiers` map in `packages/runner/src/orchestrator.ts` that `dedupeSpecs`/`TierResolver` in
 * `@lethal/schemata` reads) is wired against this array — each derives an operator's tier from its
 * own `.tier` field, so appending here is the only edit a new Tier-2 operator needs at those sites.
 */
export const tier2Operators: readonly MutationOperator[] = [
  removeTestField,
  removeSetRange,
  removeCalcFields,
  swapModifyFlag,
  removeCommit,
  // R71: scoped to field `OnValidate` / table `OnRename`, the two trigger kinds where `xRec` was
  // MEASURED to differ from `Rec` headlessly. `OnModify` is excluded by measurement, not by
  // caution — see `swap-rec-xrec.ts`.
  swapRecXRec,
  // R136: FindFirst <-> FindLast, both directions, one mutant per site. See `swap-find-direction.ts`.
  swapFindDirection,
];
