/**
 * R271: the subleg names a passing receipt must carry, one list per itest. Pure and import-free so
 * `scripts/agentflow/gate-table.ts` (EXPECTED_SUBLEGS) and the itests share one source, as
 * `alrunner-v3-legs.ts` does for the v3 gate. An itest that emits a different list fails its
 * receipt check in the tick ("A partial run is not a pass").
 */

export const HARDEN_SUBLEGS: readonly string[] = ["base-suite", "answer-key"];

export const CHUNKED_SUBLEGS: readonly string[] = ["unbounded", "chunked-2"];

export const HANG_SUBLEGS: readonly string[] = [
  "stop-hung-sessions-on",
  "stop-hung-sessions-single",
  "stop-baseline",
  "stop-hung-sessions-off",
];
