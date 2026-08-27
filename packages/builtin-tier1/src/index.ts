import type { MutationOperator } from "@lethal/operator-sdk";
import { conditionalBoundary } from "./conditional-boundary";
import { emptyBlock } from "./empty-block";
import { flipBooleanLiteral } from "./flip-boolean-literal";
import { loopSkip } from "./loop-skip";
import { loopTruncate } from "./loop-truncate";
import { negateConditional } from "./negate-conditional";
import { negateGuard } from "./negate-guard";
import { removeAssignment } from "./remove-assignment";
import { removeNot } from "./remove-not";
import { returnValue } from "./return-value";
import { shiftInteger } from "./shift-integer";
import { swapAdditive } from "./swap-additive";
import { swapCallArguments } from "./swap-call-arguments";
import { toggleBlankString } from "./toggle-blank-string";
import { voidMethodCall } from "./void-method-call";

export { conditionalBoundary } from "./conditional-boundary";
export { emptyBlock } from "./empty-block";
export { flipBooleanLiteral } from "./flip-boolean-literal";
export { negateConditional } from "./negate-conditional";
export { loopSkip } from "./loop-skip";
export { loopTruncate } from "./loop-truncate";
export { negateGuard } from "./negate-guard";
export { removeAssignment } from "./remove-assignment";
export { removeNot } from "./remove-not";
export { returnValue } from "./return-value";
export { shiftInteger } from "./shift-integer";
export { swapAdditive } from "./swap-additive";
export { swapCallArguments } from "./swap-call-arguments";
export { toggleBlankString } from "./toggle-blank-string";
export { voidMethodCall } from "./void-method-call";
export { synthesizeAfter } from "./mutate-helpers";

/** Convenience bundle for registering all Tier 1 operators at once. */
export const tier1Operators: readonly MutationOperator[] = [
  conditionalBoundary,
  flipBooleanLiteral,
  negateConditional,
  negateGuard,
  toggleBlankString,
  voidMethodCall,
  returnValue,
  emptyBlock,
  swapCallArguments,
  // R163: `not` on a bare call, identifier or member access, which `negate-conditional` cannot
  // reach because it targets comparisons and logical expressions only. 1,051 claimable sites on
  // `do-rel2/Cloud`, none of them claimed by anything before this.
  removeAssignment,
  removeNot,
  // R159: `+` <-> `-` where BOTH operands are provably numeric. The type guard is the operator:
  // 1,006 of 1,121 arithmetic tokens on `do-rel2/Cloud` are `+`, and most of those are string
  // concatenation, which does not compile as a subtraction. The multiplicative half is deliberately
  // a separate future operator — division by zero is a false kill needing its own screen.
  swapAdditive,
  // R159: an integer literal `n` -> `n + 1`, the off-by-one probe. 677 claimable sites on
  // `do-rel2/Cloud` after two cessions that had to be measured rather than assumed: loop-exit
  // conditions go to R164's non-termination hazard, and ordering comparisons to
  // `conditional-boundary`, which already shifts the same boundary from the operator side.
  shiftInteger,
  // R164: a `repeat` loop's exit condition -> `true`, so the body runs exactly once. 334 sites on
  // `do-rel2/Cloud`. It ships WITH a cession: `negate-conditional` refuses the same position,
  // because its mutant there does not terminate on a one-row set and §3.2 dedup cannot displace it
  // (dedup keys on replacement TEXT, so `<> 0` and `true` are two identities and both would ship).
  loopTruncate,
  // R179: a `while` loop's condition -> `false`, so the body never runs. A HAZARD candidate: on
  // coverage it fails R13's bar (33 sites, 28 already carrying an `empty-block` body mutant), and on
  // hazard it passes, because at 19 of those 28 the existing mutant cannot terminate. `empty-block`
  // cedes a `while` body to it.
  loopSkip,
];
