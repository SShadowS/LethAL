import type { HangCapableReason } from "@lethal/engine";

/**
 * R196: what each hang-capable reason means, in one sentence a report reader can act on.
 *
 * The wording is bound by the design's section 3.3. Each sentence says what was OBSERVED about the
 * code, never that the mutation prevents progress and never that an untagged site is safe.
 */
export const HANG_CAPABLE_EXPLANATIONS: Record<HangCapableReason, string> = {
  "loop-condition-target":
    "an enclosing loop's condition reads the variable this site writes, so a mutation here can leave that condition unchanged and the loop running",
};
