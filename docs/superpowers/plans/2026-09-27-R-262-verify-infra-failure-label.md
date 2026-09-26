# R262: verify labels a new test's infrastructure failure as its own state. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a new test's unmutated run comes back as an infrastructure failure (the CALL failed, not the test), `lethal verify` says so with a distinct state, instead of calling the test `red` or `flaky`, and it still never exits 0.

**Architecture:** One mapping in `packages/runner/src/verify.ts` is the whole bug: `unmutatedRunOf` folds every non-pass outcome into `"fail"`, and `newTestResultOf` then reads that `"fail"` as the test's own. The fix stops folding (each unmutated run reports the backend's own outcome) and adds one state rule. That grows two published value sets, so the verify schema, `schemas.test.ts`, the agent reference and its contract test move together. A small docs task splits R258.

**Tech Stack:** Bun + TypeScript, `bun test`, hand-written JSON Schema.

**Spec:** `docs/roadmap/R262.md`; decision 11 of `docs/superpowers/plans/2026-09-26-C02-06-lethal-verify.md` (the new-test states); `schemas/README.md` §Versioning.

## What the code does today (read at master `5f34f04`)

- `verify.ts` `unmutatedRunOf`: `outcome: r.outcome === "pass" || r.outcome === "not-run" ? r.outcome : "fail"`. The backend's `TestOutcome` is `"pass" | "fail" | "skip" | "timeout" | "deadline-exceeded" | "error"` (`backend.ts` line 27), so `skip`, `timeout`, `deadline-exceeded` and `error` all become `"fail"`.
- `verify.ts` `newTestResultOf`: `red` = fresh baseline `fail`; `stable` = both fresh `pass`; `flaky` = fresh baseline `pass` and fresh rerun `fail`; else `flaky-unknown`. So a FRESH `error` answer is `red` at baseline or `flaky` on the rerun (R262).
- What the outcomes mean, from the code, not from R262's wording:
  - `error`: the call went wrong. bcdev: connect failed (`pre-dispatch-rejected`), the MCP tool answered `isError`, no result row for the method, or the call was rejected mid-flight (`in-flight-unknown`). The transport: `RunMutantMany` HTTP failure, or a stop that raced a completion (R204). A test's own raised error is NOT `error`: the wire maps `failed` to `fail` (`WIRE_STATUS_TO_OUTCOME`).
  - `deadline-exceeded`: "OUR client timer fired and we know nothing about what the server did, infrastructure noise" (`backend.ts` doc comment).
  - `timeout`: "the TEST RUNNER confirmed the test did not terminate, real evidence" (`backend.ts`, design.md §6.7); the transport sets it when the server stopped the method over its budget. On an UNMUTATED build that is evidence about the test itself.
- So R262's "error or timeout" does not match the project's own split. This plan treats `error` and `deadline-exceeded` as infrastructure, and a runner-confirmed `timeout` as the test's (open question 2).
- `verifyExitCode` blocks exit 0 for any state other than `stable`, with precedence 3, 6, 4, 5, 0. It needs no change.
- Every new test joins every survivor's request, and verify always passes `requireEveryMethodGreen: true`, so a new test whose BASELINE is not a fresh pass makes every mutant `error` with `invalidBaseline` naming it (C02-06 decision 13). That part is already right for an infra failure; only the state label is wrong.
- `NamedFake` in `orchestrator.test.ts` attaches the `session` callback's keys to every unmutated verdict, including an `error` one, so the fixture can express a FRESH infra answer (the case R262 names). Whether a real BC `error` answer ever carries `testRunsBefore: 0` plus a session id has not been measured; the fix does not depend on it (the new rule ignores freshness).

## Decisions

1. **A dedicated state value, `infra-error`, not a reuse of `flaky-unknown`.** `flaky-unknown` is defined (decision 11) as "a run that was not fresh, or `not-run`": a session-attribution problem. Using it for a failed call widens its meaning, and `schemas/README.md` says a meaning change bumps the version exactly as a new value does; C02-09's plan (Q4) rejected a reuse on that same rule. So both options move the version, and only the dedicated value tells an agent the right next step ("run verify again, or run `lethal doctor`", not "your test is flaky"). If the orchestrator prefers the reuse, Tasks 1 to 3 change only in the state name and the docs wording; the version still moves.
2. **`newTests[].runs[].outcome` reports the backend's outcome unchanged**: `pass`, `fail`, `skip`, `timeout`, `deadline-exceeded`, `error`, `not-run`. No lossy mapping means no second place to get the mapping wrong, and the agent sees why the state is what it is. Named as a runtime constant, `UNMUTATED_OUTCOMES`, so `schemas.test.ts` and the contract test pin it by name (today it is an inline union pinned against a literal list).
3. **State rules, in this order** (first match wins):
   1. baseline fresh and `fail`, `timeout` or `skip`: `red` (today's behaviour for all three; `skip` and `timeout` see open questions 2 and 3);
   2. both fresh `pass`: `stable`;
   3. baseline fresh `pass`, rerun fresh `fail`, `timeout` or `skip`: `flaky`;
   4. either run `error` or `deadline-exceeded`, fresh or not: `infra-error`;
   5. anything else: `flaky-unknown`.
   Rule 4 ignoring freshness means a non-fresh `error` run moves from `flaky-unknown` to `infra-error`. That is deliberate: "the call failed" is the more specific, more actionable fact.
4. **Exit codes.** `infra-error` is not `stable`, so exit 0 stays blocked with no change to `verifyExitCode`. Under precedence 3, 6, 4, 5, 0: an infra failure on the new test's BASELINE makes every mutant `error` (decision 13), so the exit is **4** ("measured nothing"); an infra failure on the RERUN only is exit **5**; an `error` whose `operation` latches the session (`in-flight-unknown`) quarantines it and exit **3** wins, as today.

## Ordering against C02-09 (must be settled before Task 1)

`VERIFY_SCHEMA_VERSION` is `1` on master and `schemas/verify-v1.schema.json` is the only verify schema. C02-09 (`docs/superpowers/plans/2026-09-26-C02-09-gap-ids.md`, Q4 and Task at its lines about 435 to 475, in progress on `lethal/lane-code`, which at `05837ca` still has version 1) moves it to **2**, creates `schemas/verify-v2.schema.json`, and freezes v1. This plan also moves the value domain. Two tasks cannot both create `verify-v2.schema.json`, so:

- **R262 lands AFTER C02-09.** It starts only once `grep -n "VERIFY_SCHEMA_VERSION =" packages/runner/src/verify.ts` on master prints `2` and `schemas/verify-v2.schema.json` exists.
- **Path A (v2 not yet released):** extend `verify-v2.schema.json` in place and keep version 2. One version then carries both changes, and no consumer ever saw a v2 without them.
- **Path B (v2 released, or the orchestrator rules that master is "published"):** version 3, a new `schemas/verify-v3.schema.json` copied from v2 and edited, v2 frozen as published (the explain-v4 and C02-09 precedent).
- Fact for the ruling: no git tag contains verify at all (`git tag --contains ece3c7f`, the commit that added `verify-v1.schema.json`, prints nothing; the newest tag is `v0.1.0-alpha.3`, 2026-08-27, and `CHANGELOG.md` does not mention verify). But the repo is public, and C02-09 bumped v1 to v2 anyway, which treats master as published. This is **open question 1**; the plan is written so each task names the one step that differs between A and B.

## Global Constraints

- No `!` non-null assertions; optional props via `...(v !== undefined ? { k: v } : {})`.
- Build/test order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`.
- Biome only on touched files: `bunx biome check <paths>`.
- TDD, and red-check every rule: revert that rule, show the named test go red, restore, show green; report both outputs (`mutation-red-checker` subagent).
- Fail loudly: an unmutated run with an outcome outside `UNMUTATED_OUTCOMES` is a bug and must throw, never fall into a default state.
- Plain English, no em dashes, in code comments and docs.
- Roadmap: re-check the next free id with `ls docs/roadmap/` immediately before writing a new item; regenerate `ROADMAP.md` with `bun scripts/roadmap-index.ts`; never hand-edit it.

## Review Focus

1. **Baseline passes fresh, rerun answers `error`.** Expected `infra-error` and exit 5, not `flaky`. Task 1 test.
2. **Baseline answers `error` with a FRESH session.** Expected `infra-error`, the mutant `error` with `invalidBaseline`, exit 4. This is R262's exact case. Task 1 test.
3. **Baseline answers `fail` fresh, rerun answers `error`.** Expected `red` (rule 1 wins; the test did fail on its own). Task 1 test.
4. **A runner-confirmed `timeout` at baseline.** Expected `red`, and `runs[0].outcome` `timeout`, not `fail`. Task 1 test (flips if open question 2 is ruled the other way).
5. **An agent reading the reference** finds `infra-error` in the value table AND a sentence saying what to do. Task 3 pins the value set both ways; the sentence is guidance.

---

### Task 0: Preconditions

**Files:** none changed.

- [ ] **Step 1:** Confirm C02-09 is on master: `grep -n "VERIFY_SCHEMA_VERSION =" packages/runner/src/verify.ts` prints `2`, and `ls schemas/verify-v*.schema.json` lists v1 and v2. If not, STOP and report "blocked on C02-09".
- [ ] **Step 2:** Get the orchestrator's answer to open question 1 (path A or path B) and write it at the top of the task report.
- [ ] **Step 3:** Re-read `unmutatedRunOf`, `newTestResultOf`, `NEW_TEST_STATES`, `verifyExitCode` in `verify.ts` and the verify section of `docs/using-lethal-from-an-agent.md`. If C02-09 changed any of them, use master's text and note the difference.
- [ ] **Step 4:** Full loop green on master (`bun run typecheck && rm -rf packages/*/dist && bun test`). If R264 is still open, its known timeouts are the only allowed failures; list them.

### Task 1: Keep the outcome, add `infra-error`

**Files:**
- Modify: `packages/runner/src/verify.ts` (`NEW_TEST_STATES`, new `UNMUTATED_OUTCOMES`, `UnmutatedRun`, `unmutatedRunOf`, `newTestResultOf`)
- Test: `packages/runner/tests/orchestrator.test.ts` (the verify describe that holds `verifyFixture`, beside "a new test that passes the baseline and fails a fresh rerun is flaky and forces exit 5", about line 11620)
- Test: `packages/runner/tests/verify.test.ts` (the `verifyExitCode` test, about line 769)

**Interfaces:**
- Produces: `export const UNMUTATED_OUTCOMES = ["pass", "fail", "skip", "timeout", "deadline-exceeded", "error", "not-run"] as const; export type UnmutatedOutcome = (typeof UNMUTATED_OUTCOMES)[number];` and `NEW_TEST_STATES = ["stable", "flaky", "red", "flaky-unknown", "infra-error"] as const`. `UnmutatedRun.outcome: UnmutatedOutcome`.

- [ ] **Step 1: Write the failing tests** (orchestrator.test.ts, same fixture style as the existing flaky test):

```ts
test("a new test whose fresh baseline answers error is infra-error, not red, and its mutant is error (R262)", async () => {
  const fx = await verifyFixture({
    withNewTest: true,
    unmutated: ({ ref }) =>
      ref.codeunitId === NEWT.codeunitId
        ? { ref, outcome: "error", durationMs: 5, failureMessage: "tool answered isError" }
        : ALL_GREEN({ ref }),
  });
  const out = await fx.verify(["0/M0001"]);
  expect(out.results[0]?.verdict).toBe("error");
  expect(out.results[0]?.invalidBaseline).toEqual(["New Tests.OverBudgetDetected"]);
  expect(out.newTests.map((t) => [t.state, t.runs[0]?.outcome, t.runs[0]?.fresh])).toEqual([
    ["infra-error", "error", true],
  ]);
  expect(out.exitCode).toBe(4);
});

test("a fresh rerun that answers deadline-exceeded is infra-error, not flaky, and forces exit 5 (R262)", async () => {
  const fx = await verifyFixture({
    withNewTest: true,
    killerRef: OVER,
    unmutated: ({ ref, nth }) =>
      ref.codeunitId === NEWT.codeunitId && nth === 2
        ? { ref, outcome: "deadline-exceeded", durationMs: 5, failureMessage: "client timer" }
        : ALL_GREEN({ ref }),
  });
  const out = await fx.verify(["0/M0001"]);
  expect(out.results[0]?.verdict).toBe("killed");
  expect(out.newTests.map((t) => [t.state, t.runs.map((r) => r.outcome)])).toEqual([
    ["infra-error", ["pass", "deadline-exceeded"]],
  ]);
  expect(out.exitCode).toBe(5);
});

test("a fresh baseline fail stays red even when the rerun answers error (R262)", async () => {
  const fx = await verifyFixture({
    withNewTest: true,
    unmutated: ({ ref, nth }) =>
      ref.codeunitId !== NEWT.codeunitId
        ? ALL_GREEN({ ref })
        : nth === 1
          ? { ref, outcome: "fail", durationMs: 5, failureMessage: "new-red" }
          : { ref, outcome: "error", durationMs: 5, failureMessage: "call failed" },
  });
  const out = await fx.verify(["0/M0001"]);
  expect(out.newTests.map((t) => t.state)).toEqual(["red"]);
});

test("a runner-confirmed timeout at baseline is red, and its run says timeout, not fail (R262)", async () => {
  const fx = await verifyFixture({
    withNewTest: true,
    unmutated: ({ ref }) =>
      ref.codeunitId === NEWT.codeunitId
        ? { ref, outcome: "timeout", durationMs: 5, failureMessage: "stopped server-side" }
        : ALL_GREEN({ ref }),
  });
  const out = await fx.verify(["0/M0001"]);
  expect(out.newTests.map((t) => [t.state, t.runs[0]?.outcome])).toEqual([["red", "timeout"]]);
});
```

Note: the third test's rerun may not happen (a red baseline may stop the rerun path); if `runs[1]` is `not-run`, the assertion on `state` alone still holds. Read the result, do not guess.

In `verify.test.ts`'s exit-code test add: `expect(verifyExitCode({ results: [killed], newTests: [{ state: "infra-error" }] })).toBe(5);`

- [ ] **Step 2: Run, expect FAIL.** `bun run typecheck` fails first on the `"infra-error"` literal and on `runs[0]?.outcome` compared with `"error"`/`"timeout"`. After a temporary widening, the first test reads `red`, the second `flaky`, the fourth `["red", "fail"]`. Record which.

- [ ] **Step 3: Implement** in `verify.ts`:

```ts
export const NEW_TEST_STATES = ["stable", "flaky", "red", "flaky-unknown", "infra-error"] as const;
/** R262: an unmutated run's outcome exactly as the backend answered it, plus `not-run`. */
export const UNMUTATED_OUTCOMES = [
  "pass", "fail", "skip", "timeout", "deadline-exceeded", "error", "not-run",
] as const;
export type UnmutatedOutcome = (typeof UNMUTATED_OUTCOMES)[number];

/** One unmutated run of one new test (decision 11). The outcome is the backend's own (R262). */
export interface UnmutatedRun {
  readonly outcome: UnmutatedOutcome;
  // fresh, sessionId, testRunsBefore unchanged
}

function unmutatedRunOf(r: NamedUnmutatedRun): UnmutatedRun {
  if (!(UNMUTATED_OUTCOMES as readonly string[]).includes(r.outcome)) {
    throw new Error(`verify.ts: unmutated run of ${testKeyOf(r.ref)} has unknown outcome ${r.outcome}`);
  }
  return {
    outcome: r.outcome,
    fresh: r.fresh,
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.testRunsBefore !== undefined ? { testRunsBefore: r.testRunsBefore } : {}),
  };
}

/** The test's own failure on the unmutated build. `timeout` is runner-confirmed (backend.ts). */
const TEST_FAILED: ReadonlySet<UnmutatedOutcome> = new Set(["fail", "timeout", "skip"]);
/** R262: the CALL failed; nothing is known about the test. */
const INFRA_FAILED: ReadonlySet<UnmutatedOutcome> = new Set(["error", "deadline-exceeded"]);

// newTestResultOf's state, decision 11 plus R262 (first match wins):
const state: NewTestState =
  b.fresh && TEST_FAILED.has(b.outcome)
    ? "red"
    : b.fresh && b.outcome === "pass" && r.fresh && r.outcome === "pass"
      ? "stable"
      : b.fresh && b.outcome === "pass" && r.fresh && TEST_FAILED.has(r.outcome)
        ? "flaky"
        : INFRA_FAILED.has(b.outcome) || INFRA_FAILED.has(r.outcome)
          ? "infra-error"
          : "flaky-unknown";
```

If the typecheck says `NamedUnmutatedRun.outcome` is already exactly `TestOutcome | "not-run"`, the runtime `includes` check still stays: it is what fails loudly if the backend's union grows without this list.

- [ ] **Step 4: Run.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/orchestrator.test.ts packages/runner/tests/verify.test.ts`. All pass, including the untouched `flaky`, `flaky-unknown` and `red` tests. `schemas.test.ts` and `agent-contract.test.ts` will now FAIL on the value sets: that is expected and is Tasks 2 and 3. Do not commit until Task 3 is green (or commit Tasks 1 to 3 together).

- [ ] **Step 5: Red-checks.**
  - Restore the fold (`r.outcome === "pass" || r.outcome === "not-run" ? r.outcome : "fail"`): the R262 baseline test goes red on `red`, the deadline test on `flaky`, the timeout test on `"fail"`.
  - Delete rule 4 only: both infra tests go red on `flaky-unknown`.
  - Move rule 4 above rule 1: "a fresh baseline fail stays red even when the rerun answers error" goes red.
  - Remove `timeout` from `TEST_FAILED`: the timeout test goes red.
  - Make `verifyExitCode` ignore `infra-error` (`t.state !== "stable" && t.state !== "infra-error"`): the new exit-code line goes red, and so does the deadline test's exit 5.
  Restore each; record red and green.

### Task 2: The verify schema and `schemas.test.ts`

**Files:**
- Path A: Modify `schemas/verify-v2.schema.json`.
- Path B: Create `schemas/verify-v3.schema.json` (copy of v2, then edit); set `VERIFY_SCHEMA_VERSION = 3` in `verify.ts`; leave `verify-v2.schema.json` untouched; add the v3 row to `schemas/README.md` and describe v2 as kept, like explain v4.
- Modify: `packages/runner/tests/schemas.test.ts`

- [ ] **Step 1: Test first.** In the "every verify enum equals the runtime domain it copies" test, replace the literal outcome list with `expect(enumAt(verifySchema, "$.newTests[].runs[].outcome")).toEqual([...UNMUTATED_OUTCOMES]);` and import `UNMUTATED_OUTCOMES`. The `$.newTests[].state` line already compares with `NEW_TEST_STATES`. Path B only: the root-required map gains a `verify-v3.schema.json` entry (same list as v2), the loaded file becomes `verify-v${VERIFY_SCHEMA_VERSION}`, and v2 keeps only a "still parses, `verifySchemaVersion.const` is 2" test, exactly as C02-09 did for v1.
- [ ] **Step 2: Run** `bun test packages/runner/tests/schemas.test.ts`: red on both enums.
- [ ] **Step 3: Edit the schema.** `newTests[].state` enum gains `"infra-error"` at the end (in `NEW_TEST_STATES` order); `newTests[].runs[].outcome` enum becomes the seven `UNMUTATED_OUTCOMES` values in order. Path B also: `$id` and `verifySchemaVersion.const` to 3.
- [ ] **Step 4: Run** `schemas.test.ts`: green.
- [ ] **Step 5: Red-check.** Drop `"infra-error"` from the schema enum: red. Restore. Path B: leave `VERIFY_SCHEMA_VERSION` at 2 with the v3 file: "the verify schema's version const and $id match" goes red. Restore.

### Task 3: The agent reference and its contract test, together

**Files:**
- Modify: `docs/using-lethal-from-an-agent.md` (section "Reading a verify result (checked)", its guidance notes, and "Writing the killing test (guidance)")
- Modify: `packages/runner/tests/agent-contract.test.ts` (the "verify's value sets are exact, per field" test, about line 1077)
- Check: `skills/lethal-mutation-testing/SKILL.md` (its verify paragraph says "a new test is not stable", which stays true; change nothing unless the contract test asks)

- [ ] **Step 1: Test first.** In "verify's value sets are exact, per field" add `expect(valuesOf("newTests[].runs[].outcome")).toEqual(new Set(UNMUTATED_OUTCOMES));` and import it. The existing `newTests[].state` line already compares set-equal with `NEW_TEST_STATES`, so it is red now.
- [ ] **Step 2: Run** `bun test packages/runner/tests/agent-contract.test.ts`: red on `newTests[].state` (doc lacks `infra-error`) and on the missing `runs[].outcome` row.
- [ ] **Step 3: Edit the reference.**
  - Value table: `newTests[].state` row becomes `` `stable`, `flaky`, `red`, `flaky-unknown`, `infra-error` ``; add a row `` `newTests[].runs[].outcome` `` with `` `pass`, `fail`, `skip`, `timeout`, `deadline-exceeded`, `error`, `not-run` ``.
  - Path B only: `verifySchemaVersion: 3` and the link to `verify-v3.schema.json` (the "verifySchemaVersion is this build's" test enforces both).
  - Under "Verify result notes (guidance)", add: "`infra-error` means a call to the server failed during one of the new test's two unmutated runs (`runs[].outcome` is `error` or `deadline-exceeded`), so nothing is known about the test. Do not edit the test for it: run verify again, and run `lethal doctor` if it repeats. It blocks exit `0` like every state other than `stable`."
  - In "Writing the killing test (guidance)", change "or verify reports it `flaky` or `red`" to "or verify reports it `flaky` or `red` (`infra-error` is the server's failure, not the test's)".
- [ ] **Step 4: Run** `agent-contract.test.ts`: green. Then the full loop: `bun run typecheck && rm -rf packages/*/dist && bun test`, zero new failures.
- [ ] **Step 5: Red-check, both directions.** Remove `infra-error` from the doc table only: red. Restore. Add a made-up `infra-pending` to the doc table only: red. Restore. Remove `skip` from the doc's outcome row only: red. Restore.
- [ ] **Step 6:** `bunx biome check packages/runner/src/verify.ts packages/runner/tests/orchestrator.test.ts packages/runner/tests/verify.test.ts packages/runner/tests/schemas.test.ts packages/runner/tests/agent-contract.test.ts`.
- [ ] **Step 7: Commit** Tasks 1 to 3 as one commit (they are only green together): `fix(verify): a new test's infrastructure failure is infra-error, not red or flaky; runs keep the backend's outcome (R262)`.

### Task 4: Split R258, close R262

**Files:**
- Modify: `docs/roadmap/R258.md`
- Create: `docs/roadmap/R<next>.md` (run `ls docs/roadmap/` IMMEDIATELY before writing; at 2026-09-27 the highest is R271, so R272 unless another session took it)
- Modify: `docs/roadmap/R262.md`; regenerate `ROADMAP.md`

- [ ] **Step 1: R258 keeps the case its TITLE names:** an edited test that did NOT cover the mutant in the source run is never selected, because verify runs only the source run's covering tests plus tests that are new by identity. Rewrite the body for that case: evidence `planVerify` (`verify.ts`), and the agent reference's "Writing the killing test (guidance)" sentence that already calls it a blind spot. What would close it: verify learns which existing tests changed (a per-test body identity) and runs those too.
- [ ] **Step 2: The new item takes the case R258's BODY describes:** an edited COVERING test is selected, but as an old test, so it never gets the new-test double run (two fresh unmutated passes) or a new-test state. Move R258's current body, evidence and "What would close it" (a per-test hash of the method's source, tolerant the same way source hashing is; `alc` output is not deterministic, C02-05 Task 0 in `docs/measurements/README.md`) into it. `section: "product-gaps"`, `status: "open"`, and a line: "Split from R258 on 2026-09-27, as R262 (Minor 2 of gpt-6-sol's C02-06b review) asked."
- [ ] **Step 3:** In `R262.md`, set `status: "done (<Task 3 commit>)"`, and replace the "Related, same review (Minor 2)" paragraph's last sentence with "Split: R258 (not selected) and R<next> (selected, no double run)."
- [ ] **Step 4:** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`.
- [ ] **Step 5: Commit.** `docs(roadmap): split R258 into its two cases, close R262`.

## Live gate

**Not required.** `itest:verify` (and `itest:agreement`) drive one new test that passes twice on a real server and assert `state: "stable"` with both runs `pass` and fresh. The changed code touches only non-`pass` outcomes, which that path never produces, and the `pass` outcome and the `stable` rule are unchanged. Neither itest asserts `verifySchemaVersion`. No AL, no wire format and no verdict for a mutant changes. The mapping is exercised end to end offline through the REAL `runNamedMutants` in `orchestrator.test.ts`. If the Cronus28 lease is free (owner authorised gates on Cronus28 under a coord lease, 2026-09-25), one `itest:verify` run is a cheap no-regression check and must PASS unchanged; it cannot exercise `infra-error`, and no gate can without injecting a server fault.

## Open questions for the orchestrator

1. **Path A or path B:** is verify-v2 (from C02-09) "released" when R262 lands? No tag contains verify yet, but C02-09 treated public master as published. A: extend v2 in place. B: v3.
2. **Runner-confirmed `timeout`:** R262 groups it with `error`. `backend.ts` and design.md §6.7 call it real evidence about the test, so this plan keeps it `red`/`flaky`. Rule it infra instead and it moves from `TEST_FAILED` to `INFRA_FAILED` (one test flips).
3. **`skip`:** today folded into `fail`, so a skipped new test is `red`. Kept. A skipped test did not run, so `flaky-unknown` or its own state is arguable; out of R262's scope unless ruled in.
4. **The state name** `infra-error`, or a reuse of `flaky-unknown` (decision 1 explains why both move the version).
