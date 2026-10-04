# R-425: the verify report records R-384's reach filter (plan r1)

Evidence with file:line is in `survey.md` beside this file. To be committed by the orchestrator as
`docs/superpowers/plans/2026-10-04-R-425-verify-report-filter-state.md`. Checked against
`lethal/r425` at master `cfb6a7ea`.

## Problem

R-384 prints the filter state on stderr only, and a v4 verify report cannot say whether a
survivor's `testsRun` was narrowed. The R-384 gate's own step-3 JSON
(`/coord/handoff/R-384/r384-verify-2.log:19-125`) shows it: LogAudit's `testsRun` lacks the new
test, and nothing in the JSON says why.

## Field shapes

**Run level, `VerifyOutput.reachFilter?: VerifyReachFilter`:**

```ts
export const REACH_FILTER_STATES = ["on", "off"] as const;            // verify-reach.ts
export const REACH_FILTER_OFF_REASONS = [
  "no-reach-filter", "coverage-mode-none", "coverage-mode-procedure",
  "coverage-mode-line", "coverage-mode-al-runner",
] as const;
export interface VerifyReachFilter {                                     // verify.ts
  readonly state: ReachFilterState;
  /** Present exactly when `state` is "off". */
  readonly reason?: ReachFilterOffReason;
}
```

- One reason per R-384 `why` text, 1:1 (`reachStateOf`, verify-reach.ts:29-34). `ReachState`
  gains `reason`: `{ on: false; reason; why }`, with `why` built from `reason` by one table, so
  every stderr line stays byte-identical (pinned today with `toBe`). The flag wins over every mode,
  as today. `coverage-mode-al-runner` cannot happen (verify is bcdev-only) but `reachStateOf` is
  total over `CoverageMode`, so the domain says what the function can return.
- Flat interface, not a TS union: the schema leaf walk does not follow `anyOf`
  (schemas.test.ts:109-120), and the test validator has no `oneOf`. "reason iff off" is pinned by
  a unit test (Task 3).
- **Present** whenever `runVerify` got past the `coverage-mode-changed` check, including later
  refusals (`source-changed`, `too-many-new-tests` from either cap check, ...). **Absent** when
  verify stopped before deciding (`malformed-request`, `unknown-artifact`, `not-a-survivor`,
  `unknown-gap`, `gap-has-no-survivor`, `coverage-mode-changed`, ...). To do this, `runVerify`
  computes `reachState` once, right after that check, and `header()` adds the field.

**Per survivor, `VerifyResult.reachNarrowed?: boolean`:** true when the filter left at least one
new test out of this survivor's request.
- `false` on every planned row when the filter is off (it cannot narrow).
- With the filter on, set from `narrowVerifyRequests`' answer, for measured and unreached rows.
- **Absent** when the filter never decided for that row: `skipped` (marked equivalent), every test
  TestPage-refused (never planned), and the filter on but `narrow` never called because the session
  latched unsafe before `select` (orchestrator.ts:6463-6472; those rows are `error` and keep the
  unfiltered `testsRun`).
- Computed in the pure module: `ReachResult.narrowed: ReadonlySet<string>` = survivors whose final
  `methods` lack at least one new test (verify-reach.ts:177-196). Off: empty set.

## Dropped tests: NOT recorded, because they are already in the report

Each unfiltered request is the covering tests plus EVERY new test (verify.ts:940-960), and
`narrowVerifyRequests` drops only new tests. So for a narrowed row, the dropped list is exactly
`newTests[].test` minus `testsRun`. Both are already in the JSON. A stored list would only repeat
them, and its size has no bound from the cap: check 1 admits N <= 25(S+2) at the default 50, and
check 2 bounds the KEPT joins only. Dropped names <= S·N: 3,000 at S = 10, 255,000 (~11 MB) at
S = 100. `testsRun`'s new-test part stays <= 50(S+2). Instead, the reader helper derives the list
(`droppedNewTestsOf`) and a unit test pins that derivation equals `request minus sent` on every
reach fixture. Why each test was dropped is always the same: its fenced coverage did not hit the
survivor's member (fail-closed tests are never dropped), so there is no per-test reason to store.

## Back-compat: missing is UNKNOWN, never "off"

New module `packages/runner/src/verify-read.ts` (pure, no runtime imports, takes parsed JSON):
- `reachFilterOf(doc)` -> `{ state: "on" } | { state: "off"; reason } | { state: "unknown";
  why: "predates-v5" | "not-decided" }`. `verifySchemaVersion < 5` -> `predates-v5` (even if a
  field happens to be there); v5+ without the field -> `not-decided`.
- `reachNarrowingOf(doc, row)` -> `"narrowed" | "not-narrowed" | "unknown"`. Unknown when the run
  state is unknown or the row lacks `reachNarrowed`. It never infers from `testsRun`: a v4 report
  from before R-384 could never narrow, one after could, and the JSON cannot tell them apart.
- `droppedNewTestsOf(doc, row)` -> `string[] | undefined` (undefined unless `"narrowed"`).
- Pinned on a REAL v4 report: commit the step-3 JSON from `r384-verify-2.log:19-113` [orchestrator, at adoption: the JSON ends at line 113; 114-125 are the step-3 PASS line and step-4 phase lines, and 19-125 does not parse] as
  `packages/runner/tests/fixtures/verify-v4-r384-step3.json`, byte for byte (fixture names, a
  container path and a callstack only, no customer source; it is not a SessionReport, so the
  redaction script does not apply). The test asserts it validates against `verify-v4.schema.json`,
  then `reachFilterOf` = unknown/predates-v5 and `reachNarrowingOf` = unknown for BOTH rows, LogAudit
  included, whose `testsRun` lacks the new test.

## Schema v5 and the ripple (verify's own; not SessionReport's)

`VERIFY_SCHEMA_VERSION` 4 -> 5. Why a bump although `schemas/README.md` says adding a field does
not: v4 is `additionalProperties: false` at the root and in `results.items` (verify-v4:7,123), the
new fields carry two new value domains, and the version is the only way a reader can tell "absent:
predates the record" from "absent: not decided". The task rules v5.

| File | Change |
|---|---|
| `packages/runner/src/verify-reach.ts` | enum constants + types; `ReachState.reason`; `narrowed` set |
| `packages/runner/src/verify.ts` | version 5 + comment; `VerifyReachFilter`; two fields; `header()`; rows |
| `packages/runner/src/verify-read.ts` (new) | the three reader helpers |
| `packages/runner/src/cli.ts` | none (generic `JSON.stringify` writer, cli.ts:5240-5243); help text unchanged |
| `schemas/verify-v5.schema.json` (new) | v4 copy; const 5, `$id` v5; `reachFilter` object (`required: ["state"]`, enums, `additionalProperties: false`); `results.items.reachNarrowed` boolean; descriptions say "absent = not decided" |
| `schemas/verify-v4.schema.json` | unchanged, now frozen |
| `schemas/README.md` | v5 row; v4 row "kept ... (v5 added `reachFilter` and `results[].reachNarrowed`)"; seventeen files, thirteen hand-written; "verify v5 pinned, v4..v1 frozen" |
| `scripts/generate-schemas.ts` | none: verify is hand-written |
| `tests/schemas.test.ts` | v4 "kept as published" const test; root-required map gains `verify-v5` (same 7 keys: the field is optional); `expectedLeafTypeNames` += `ReachFilterState`, `ReachFilterOffReason`; enum == runtime + literal-list pins for both; `measured` literal fills `reachFilter` and `reachNarrowed` |
| `tests/agent-contract.test.ts` | value-set table gains `reachFilter.state`, `reachFilter.reason` rows |
| `tests/verify-reach.test.ts` | `reachStateOf` expectations gain `reason` (addition; `why` unchanged) |
| Snapshots | none contain verify JSON: nothing to `--update-snapshots` |
| Committed sample verify reports | none exist; nothing to regenerate. The new v4 fixture is added |
| `docs/using-lethal-from-an-agent.md` | `verifySchemaVersion: 5` + v5 link (:448); two table rows; :599-602 "The JSON is unchanged" -> the two fields and the unknown rule |
| `README.md` | :458 one clause: the JSON records it (`reachFilter`, `reachNarrowed`) |
| `CHANGELOG.md` | new [Unreleased] Added entry (R425, schema v5); R384 entry's "the JSON is unchanged (schema v4)" gains "(R425 records it, v5)" |

**Unchanged, checked:** `SessionReport`, `report-v3`, `events.ts` and the stream (no new event),
explain (reads SessionReport only), identity keys, digests, dependency fingerprint, store schema
(verify writes no output to the store), campaign (reads no verify JSON), `verify-scale` itest
(reads `results`/`timings`). No `src` module reads a verify report today (survey §1).

## R-384 gates: additions only

No existing assertion changes. R-384's `testsRun`, verdicts, counts and stderr lines are produced
by code this plan does not touch. New assertions, through one helper
`packages/runner/itest/verify-reach-fields.ts` (`assertReachFields(step, out, {filter, rows})`,
which uses `verify-read.ts`) with an offline unit test `verify-reach-fields.test.ts`:

- `itest:verify` step 3: `reachFilter` = `{state:"on"}`; ClampPercent `reachNarrowed` false
  (`droppedNewTestsOf` undefined); LogAudit `reachNarrowed` true, dropped =
  `["Sandbox Tests.ZzC0206ClampRejectsAboveHundred"]`.
- step 4 and step 4b: `{state:"on"}`; both rows `reachNarrowed` false (N = 0, nothing to drop).
- step 5a-5d: `reachFilter` absent (each refuses before the decision); `reachFilterOf` = unknown,
  `not-decided`.
- `itest:agreement` step 3: `{state:"on"}`; S1-S4 `reachNarrowed` true, each dropped = the four
  answer tests other than its own killer (as a set); S5 `reachNarrowed` absent (skipped).

These follow mechanically from the pre-committed `testsRun`. Task 6 writes them, before the run,
as an addendum `docs/superpowers/specs/2026-10-04-r425-reach-fields-precommitment.md`.

## Tasks (TDD; red-check each: revert the named clause, see the named test go red, restore)

1. **Reasons.** `reachStateOf` returns `reason`; the `why` table. Tests: every mode x flag gives
   the reason and the SAME `why` as today; flag + `none` gives `no-reach-filter`. Red-check: map
   `line` to `coverage-mode-procedure` -> red. Existing off-line `toBe` tests stay green.
2. **`narrowed` set.** Tests: filter off -> empty; sibling-only new test -> narrowed; fail-closed
   survivor -> not; N = 0 -> not; unreached with N > 0 -> narrowed. Red-check: always empty -> red.
3. **Run-level field.** verify.test.ts, by addition to the R-384 tests: on -> `{state:"on"}`; each
   off case (verify.test.ts:2410-2443) -> its reason, no other key; `coverage-mode-changed` and
   `malformed-request` -> absent; `too-many-new-tests` (check 1 and check 2) -> present. Red-check:
   drop it from `header()` -> red; emit `reason` when on -> red.
4. **Row field.** Off -> false on every planned row; on -> true/false from the set; skipped and
   all-TestPage-refused rows -> absent; a `runNamed` fake that latches unsafe without calling
   `narrow` -> absent on its `error` rows. Red-check: default to `false` there -> red. Invariant
   test: on every reach fixture, `droppedNewTestsOf` = request methods minus sent.
5. **Reader + schema v5.** `verify-read.ts` tests on the committed v4 fixture and on v5 outputs.
   Red-check A: return `off` for a missing field -> red. Red-check B: infer narrowing from
   `testsRun` -> LogAudit reads `narrowed` -> red. Then the schema file and every schemas.test.ts
   / agent-contract.test.ts change in the table; red-check: delete `reachNarrowed` from the v5
   file -> the leaf test goes red.
6. **Docs + pre-commitment addendum** (above), committed before any live run.
7. **Itest helper + itests.** Offline red-check of `assertReachFields` on a hand-edited output.
   Then, under a **Cronus28 lease** (tell the orchestrator first; no AL changes, so no publish): `LETHAL_ITEST_VERIFY=1 bun run
   itest:verify` and `LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement`, both green with every
   R-384 pin unchanged. **Live red-check (itest:verify only):** an uncommitted edit writing
   `reachNarrowed: false` on every row -> step 3 fails on LogAudit's `reachNarrowed`; restore;
   re-run green. Save logs under `/coord/handoff/R-425/`.
8. **Finish.** `bun run typecheck`; `rm -rf packages/*/dist`; `bun scripts/verify.ts`;
   `bunx biome check <touched files>`; `docs/roadmap/R425.md` status `done (<commit>)`;
   `bun scripts/roadmap-index.ts`. Regenerate `ROADMAP.md` again after any merge from master.

## Open questions

1. Should `reachFilter` stay absent on refusals before the decision, or be required in v5 with a
   third state such as `"undecided"`? This plan picks absent: no new root-required key, and the
   reader reports `not-decided`.
2. Should the run-level object also carry the stderr counts (N, F, P, U)? This plan says no: they
   are derivable or already on stderr, and adding them later is a field, not a bump.
3. Keep the unreachable `coverage-mode-al-runner` value, or make `reachStateOf` throw for it?
4. The README rule "adding a field does not bump": should `schemas/README.md` say that verify bumps
   for a field whose ABSENCE must mean unknown?
