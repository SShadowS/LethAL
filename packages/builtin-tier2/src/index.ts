import type { MutationOperator } from "@lethal/operator-sdk";
import { removeTestField } from "./remove-testfield";

export { removeTestField } from "./remove-testfield";
export { claimsRecordMethod } from "./receiver";

/**
 * Tier 2 operator registry.
 *
 * One of the four Phase-1 Tier-2 operators (docs/superpowers/plans/2026-07-26-tier2-phase1.md,
 * Task 3) is registered so far: `RemoveTestField`. `RemoveSetRange`, `RemoveCalcFields` and
 * `SwapModifyFlag` land in later tasks of that plan. Every pipeline site that needs to know about
 * Tier 2 (the operator generation walk and the `operatorTiers` map in
 * `packages/runner/src/orchestrator.ts` that `dedupeSpecs`/`TierResolver` in `@lethal/schemata`
 * reads) is wired against this array — each derives an operator's tier from its own `.tier` field,
 * so appending here is the only edit a new Tier-2 operator needs at those sites.
 */
export const tier2Operators: readonly MutationOperator[] = [removeTestField];
