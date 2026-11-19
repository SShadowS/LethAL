# PR-247 pre-commitment: the `costlyTests` report section

Coord PR-247, lethal-code. It builds the section proposed in PR-243's spec-light
(`docs/superpowers/specs/2026-11-19-pr243-costly-tests.md`, section 3).

**Orchestrator rulings (2026-11-20):**
- the field is OPTIONAL in the schema (R157: an added optional field is free), so no committed report is regenerated;
- one schemas test that a report WITH the section validates;
- one session-end `test-costs` event, folded with `mutant-scored`;
- on `--resume`, the scope is stated in a field the banner prints, never silently whole.

## 1. The event `test-costs` (new, `events.ts`)
- **When:** emitted once per session, after the mutant phase and before `session-finished`. Not emitted if the session
  ran no mutant test.
- **Shape:** `{ type: "test-costs", tests: { test, runs, ownMs, msUnderSurvivors }[] }`.
  - `test` is the qualified test name (`<Codeunit name>.<method>`, as `coveringTests` names it);
  - one entry per test that ran under at least one mutant THIS session.
- **What counts:**
  - `runs`: the mutant-phase test rows recorded for that test.
  - `ownMs`: the sum of each row's own time, the value the store writes as `own_duration_ms`, else its `duration_ms`.
    These are exactly the rows the store records against a mutant: not the baseline, not the withheld-kill recheck.
  - `msUnderSurvivors`: the part of `ownMs` whose mutant was scored `survived`.
- **Order:** by `test`, compared by code unit, so the event is deterministic.

## 2. The section `costlyTests` (`report.ts`; optional in the schema)
- **The shape:**
  `{ scope: "whole-run" | "this-session", carriedMutants, totalOwnMs, top: Row[] }`, where each Row is
  `{ test, coveredMutants, runs, ownMs, share, meanMs, baselineMs?, kills, killRate, msUnderSurvivors }`.
- **The rows:**
  - `top`: the 20 tests with the most `ownMs`. Ties go by `test`, compared by code unit.
  - `share` = `ownMs / totalOwnMs`; `totalOwnMs` is summed over every test, not just the top 20.
  - `meanMs` = `ownMs / runs`.
  - `baselineMs`: the test's baseline duration from `testMethods` (`baselineDurationMs`), when present.
  - `coveredMutants`: the `mutant-scored` events in the stream whose `coveringTests` name the test.
  - `kills`: the `mutant-scored` events with a kill verdict whose `killingTest` names the test, matched as
    `<covering test>.endsWith("." + killingTest)` among that mutant's covering tests.
  - `killRate` = `kills / coveredMutants`, or 0 when no mutant is covered.
- **The scope:**
  - Every `test-costs` event in the stream is summed. A stream that holds earlier sessions' events (`--resume` appending
    to the same progress file) folds them all.
  - `carriedMutants` is the number of `mutant-carried` events whose session has no `test-costs` event in the stream.
  - `scope` is `"whole-run"` when `carriedMutants` is 0, else `"this-session"`.
- **Absent** when the stream has no `test-costs` event (older streams, or a session with no mutant test).
- **Built by the fold** (`report-fold.ts`), so a report rebuilt from events equals the written one (report-equality).

## 3. The banner (one line)
`costly tests: the top 10 take <p>% of the mutation test time; the top one, <test>, <q>%, killed <r>% of the
<covered> mutants it covers`.
- When `scope` is `"this-session"`, it adds `(this session only: <carriedMutants> carried mutants' tests not counted)`.
- **It never says "remove":** a rarely-killing test can be a mutant's only killer.

## 4. Checks (red both ways)
- **The fold:** a stream with two mutants and three tests gives the exact rows: covered, kills, rates, shares, and the
  survivor split.
- **Order:** ties by name; exactly 20 rows over 25 tests.
- **Scope:**
  - no carried mutants → `whole-run`;
  - carried mutants without their `test-costs` → `this-session`, and the banner says so;
  - an appended stream holding the earlier session's `test-costs` → `whole-run`.
- **No event → no section.**
- **The orchestrator emits `test-costs`** with the right sums for a fake backend (a survivor and a kill), and nothing for a
  session with no mutant run.
- **Schemas:** a report with the section validates (new); the gift-card report without it still validates; the root
  required list is unchanged.
- **report-equality:** the snapshots updated on purpose (`--update-snapshots` on that file only).
- **Gates:**
  - the full v3 gate (`taskset -c 12-21` while PERF-10 runs): its per-mutant comparisons and warning sets do not read the
    section, so nothing moves;
  - `itest:bcdev` once on a leased BC server, to confirm the bcdev report gains the section with no per-mutant change.

## 5. Not in this change
- `reachRate` (the share of covered survivors whose statement a test reached) waits for R1148 / PR-235's in-run reach.
- No test is reordered or skipped.
