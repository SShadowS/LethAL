import type { MutationOperator } from "@lethal/operator-sdk";

/**
 * Tier 2 operator registry.
 *
 * Empty for now: the four Phase-1 Tier-2 operators (RemoveTestField, RemoveSetRange,
 * RemoveCalcFields, SwapModifyFlag — docs/superpowers/plans/2026-07-26-tier2-phase1.md) land in
 * later tasks of that plan. Exported now, rather than deferred to whichever task adds the first
 * operator, so every pipeline site that needs to know about Tier 2 (the operator generation walk
 * and the `operatorTiers` map in `packages/runner/src/orchestrator.ts` that
 * `dedupeSpecs`/`TierResolver` in `@lethal/schemata` reads) can be wired against this array while
 * it is still empty — an empty array contributes nothing, so wiring it early is a no-op for every
 * existing run, and no site needs a second wiring pass the day an operator actually lands here.
 */
export const tier2Operators: readonly MutationOperator[] = [];
