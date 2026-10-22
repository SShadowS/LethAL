/**
 * R-307 O5. Re-exports only, no function bodies: kept so `index.ts` and existing tests resolve.
 * PLAN lives in `dispatch-plan.ts`, EMIT in `dispatch-emit.ts`. No PLAN, EMIT or composition
 * module may import this file; each imports the half it needs directly.
 */
export { REACH_MARKER, emitDispatch } from "./dispatch-emit";
export {
  type Placement,
  type PlannedComponent,
  type PlannedMember,
  type ReachGrain,
  type SpliceParts,
  describeSplice,
  leadingBeginEnd,
  planComponent,
  planMember,
  planPlacement,
  planReachGrains,
  preambleArmHeaderEnds,
  reachGrainOf,
  reachLatchRefusedOwner,
  splitVarHoistAnchor,
  varSectionUnparsed,
} from "./dispatch-plan";
export { REACH_LATCH } from "./reach-latch";
