import type { MutationOperator } from "@lethal/operator-sdk";
import { conditionalBoundary } from "./conditional-boundary";
import { emptyBlock } from "./empty-block";
import { negateConditional } from "./negate-conditional";
import { returnValue } from "./return-value";
import { swapCallArguments } from "./swap-call-arguments";
import { voidMethodCall } from "./void-method-call";

export { conditionalBoundary } from "./conditional-boundary";
export { emptyBlock } from "./empty-block";
export { negateConditional } from "./negate-conditional";
export { returnValue } from "./return-value";
export { swapCallArguments } from "./swap-call-arguments";
export { voidMethodCall } from "./void-method-call";
export { synthesizeAfter } from "./mutate-helpers";

/** Convenience bundle for registering all Tier 1 operators at once. */
export const tier1Operators: readonly MutationOperator[] = [
  conditionalBoundary,
  negateConditional,
  voidMethodCall,
  returnValue,
  emptyBlock,
  swapCallArguments,
];
