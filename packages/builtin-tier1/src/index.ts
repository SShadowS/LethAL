import type { MutationOperator } from "@lethal/operator-sdk";
import { conditionalBoundary } from "./conditional-boundary";
import { emptyBlock } from "./empty-block";
import { flipBooleanLiteral } from "./flip-boolean-literal";
import { negateConditional } from "./negate-conditional";
import { negateGuard } from "./negate-guard";
import { removeNot } from "./remove-not";
import { returnValue } from "./return-value";
import { swapAdditive } from "./swap-additive";
import { swapCallArguments } from "./swap-call-arguments";
import { voidMethodCall } from "./void-method-call";

export { conditionalBoundary } from "./conditional-boundary";
export { emptyBlock } from "./empty-block";
export { flipBooleanLiteral } from "./flip-boolean-literal";
export { negateConditional } from "./negate-conditional";
export { negateGuard } from "./negate-guard";
export { removeNot } from "./remove-not";
export { returnValue } from "./return-value";
export { swapAdditive } from "./swap-additive";
export { swapCallArguments } from "./swap-call-arguments";
export { voidMethodCall } from "./void-method-call";
export { synthesizeAfter } from "./mutate-helpers";

/** Convenience bundle for registering all Tier 1 operators at once. */
export const tier1Operators: readonly MutationOperator[] = [
  conditionalBoundary,
  flipBooleanLiteral,
  negateConditional,
  negateGuard,
  voidMethodCall,
  returnValue,
  emptyBlock,
  swapCallArguments,
  // R163: `not` on a bare call, identifier or member access, which `negate-conditional` cannot
  // reach because it targets comparisons and logical expressions only. 1,051 claimable sites on
  // `do-rel2/Cloud`, none of them claimed by anything before this.
  removeNot,
  // R159: `+` <-> `-` where BOTH operands are provably numeric. The type guard is the operator:
  // 1,006 of 1,121 arithmetic tokens on `do-rel2/Cloud` are `+`, and most of those are string
  // concatenation, which does not compile as a subtraction. The multiplicative half is deliberately
  // a separate future operator — division by zero is a false kill needing its own screen.
  swapAdditive,
];
