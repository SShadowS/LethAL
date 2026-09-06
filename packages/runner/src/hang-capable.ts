import type { HangCapableReason } from "@lethal/engine";

/**
 * R196: what each hang-capable reason means, in one sentence a report reader can act on.
 *
 * The wording is bound by the design's section 3.3. Each sentence says what was OBSERVED about the
 * code, never that the mutation prevents progress and never that an untagged site is safe.
 *
 * No importer yet, and this is not orphaned code. `MutantOutcome.hangCapable` (report.ts) is this
 * table's first consumer, carrying the raw reason onto each mutant row. The table itself is read by
 * the `hang-capable-auto-stop` caveat the design's section 5.4 specifies, which is later plan work
 * (a forced-stop feature this plan does not build) and will look values up here the way
 * `platformArtifactKills`'s screen already looks up `PLATFORM_KILL_MECHANISM_EXPLANATIONS`.
 */
export const HANG_CAPABLE_EXPLANATIONS: Record<HangCapableReason, string> = {
  "loop-condition-target":
    "an enclosing loop's condition reads the variable this site writes, so a mutation here can leave that condition unchanged and the loop running",
};
