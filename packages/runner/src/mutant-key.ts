import type { MutantOutcome } from "./report";

/**
 * The identity key of a report row: `astHash|codeunitName|procedure-or-trigger|operatorName|
 * operatorMajor[|identityOrdinal]`. Never a mutant code or a file:line pair, both of which move
 * when the scope or the source changes.
 *
 * Moved here from `itest/mutant-equality.ts` (PR-171) so `--confirm-from` and `confirm-merge` can
 * use it; the itest re-exports it. The scheme is unchanged, so every committed baseline key is
 * byte-identical.
 */
export function keyOf(m: MutantOutcome): string {
  // `procedureName` joined the identity in R166; R193 added `identityOrdinal`, this mutant's
  // position among byte-identical twins in SOURCE order (not report order, which is what R166
  // rightly refused to key on). Appended only when non-zero, so every key without a twin is
  // unchanged and a baseline with no collisions is byte-identical across the change.
  const scope = m.procedureName || m.triggerName || "";
  const tuple = `${m.astHash}|${m.codeunitName}|${scope}|${m.operatorName}|${m.operatorMajor}`;
  const ordinal = m.identityOrdinal ?? 0;
  return ordinal > 0 ? `${tuple}|${ordinal}` : tuple;
}
