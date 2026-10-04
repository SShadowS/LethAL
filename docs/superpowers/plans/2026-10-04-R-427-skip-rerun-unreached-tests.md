# R-427: verify skips the stability rerun of a new test the reach filter sends to no survivor (plan r1)

Evidence with file:line is in `survey.md` beside this file. To be committed by the orchestrator as
`docs/superpowers/plans/2026-10-04-R-427-skip-rerun-unreached-tests.md`. Checked against
`lethal/r427` at master 733fa7bd.

## Problem

Every new test runs twice unmutated: a baseline before the mutants and a rerun after them
(orchestrator.ts:6475-6494). R-384's filter decides per survivor which new tests to send. A test
it sends to no survivor still pays the rerun, and cap check 2 counts that rerun.

## Phase order: nothing moves

The filter (`narrow`, called in `select`, orchestrator.ts:6463-6474) already runs after the
baseline and BEFORE the first mutant; the rerun runs AFTER the last mutant. So the decision
precedes the rerun today. The only change is that `narrow`'s answer may remove keys from the
rerun list. Leases, sessions, the rerun freshness rule (a session no earlier call used) and
`invalidBaselineReason` are untouched.

## The rule

After the baseline and the filter, a new test that is in NO survivor's final method list is not
rerun. Its state is the new value **`not-rerun`**: "passed its one baseline run fresh; not rerun
because no survivor was sent it; stability unknown". It never reads as `stable`.

When can it happen? Only when ALL hold, so everything else is rerun as today (fail-closed):
- the filter is on (`reachStateOf` = on; off → `narrow` is not given, nothing is skipped);
- `narrow` was called (a session that latched before `select` reruns nothing today, and keeps
  doing so: every rerun is `not-run`, state `flaky-unknown`, unchanged);
- the test is filterable: its baseline is a valid green row AND its coverage has ≥1 entry
  (`failClosedWhy`, verify-reach.ts:136-142). A red, infra-failed, non-fresh, coverage-less or
  empty-coverage test is fail-closed: it joins EVERY survivor, so it is sent, so it is rerun;
- no survivor's final list holds it: not a covering test of any survivor (covering tests are
  never removed), not reached by any survivor's coverage, no fail-closed survivor (those take
  every new test).

**A test that fails its baseline:** today it is `red` (first match, verify.ts:1327-1329), it
joins every survivor (fail-closed), each of those survivors is `error` (decision 13), and it is
rerun. Unchanged: it is never filterable, so never skipped.

Where the decision lives:
- `verify-reach.ts`: `ReachResult.unsent: ReadonlySet<string>` = new-test keys in no survivor's
  final `methods` (always empty with the filter off).
- `orchestrator.ts`: `narrow`'s return gains optional `notRerun?: ReadonlySet<string>` (test keys).
  `applyNarrow` refuses (NamedMutantError) a key not in `rerunOnUnmutated`, or one that is in any
  kept mutant's method list: a test sent to a survivor can never skip its rerun. The rerun loop
  skips those keys. `NamedMutantsResult.notRerun?: readonly string[]` lists them (plan order);
  `rerun` then holds one entry per rerun method that is NOT in `notRerun`.
- `verify.ts`: the `narrow` closure returns `notRerun: r.unsent`. Building `newTests`, each new
  test is in exactly one of `rerun` / `notRerun` (else throw, as today's missing-answer throw).
  For a `notRerun` key: assert the baseline was a fresh `pass` (else throw: a bug, since only a
  filterable test can be unsent), state `not-rerun`, `runs: [baseline]` (ONE entry; no synthetic
  `not-run` rerun, which would collide with the latch meaning of `not-run`), no `failure`.
- No stderr change: both gates pin the reach log exactly (survey §5); the JSON is the record.

## Flakiness (acceptance 5)

A test run once cannot be called flaky or stable, and the report does not: it says `not-rerun`,
with its single baseline run. It is safe because no verdict depends on it: it was sent to no
survivor, so it is in no row's `testsRun`, it killed nothing and its baseline gated nothing
(decision 13 reads only the methods sent). What is lost: today a flaky test that reaches nothing
is caught (`flaky`, exit 5); after R-427 its flakiness is unobserved in this verify. It is caught
when a later verify sends it to a survivor, because then it is rerun.

**Exit code (needs a ruling, Q2):** `verifyExitCode` (verify.ts:1287-1292) blocks exit 0 on any
state but `stable`. This plan treats `not-rerun` like `stable` for the exit code
(`state !== "stable" && state !== "not-rerun"`). Otherwise an edit whose new tests reach nothing
would exit 5 where it exits 0 today, and itest:agreement's step 3 (exit 0) would go red.

## Budget (acceptance 4)

Let R = new tests sent to ≥1 survivor (R ≤ N). Runs actually planned with the filter on:
N baselines + R reruns + P joins.
- **Filter off:** unchanged (every test is rerun; `S·N + 2N > B`; same text).
- **Check 2** (inside `narrow`, after the baseline): `E = N + R + P`, refuse iff `E > B`. Since
  `E ≤ 2N + P` (today's E), it refuses only when today's check 2 also refuses. With R = N the text
  is byte-identical to today's. With R < N the parenthesis is, exactly:
  `(${N + R} unmutated: ${N} baseline, ${R} rerun, ${N - R} test(s) sent to no survivor are not rerun; ${P} against ${S} survivor(s); ${F} test(s) joined every survivor because their coverage could not be used)`.
  The rest of the text is unchanged, including `--max-new-tests ${ceil(E/(S+2))}`.
- **Check 1** (before the lease; reach unknown, so R is unknown). Two choices (Q3):
  - (a) **recommended:** refuse iff `N > B`, the one count no filter can lower (the baseline).
    It refuses a strict subset of today's `2N > B`. Exact text:
    `${N} tests are new or edited since run ${runId}. Each runs at least once unmutated, ${N} extra test runs, and the coverage filter cannot lower that; without the filter they would need ${S·N + 2N}. ${budget} Edit classes: ${classes}.${helpers} To run them all, pass --max-new-tests ${N}; or run lethal run again so this source is the recorded one`.
    Cost: a run with `N ≤ B < 2N` now takes the lease and pays N baselines before check 2 may
    still refuse it (check 2 already behaves this way for P).
  - (b) keep `2N > B` and today's text. Refuses nothing new, but its sentence "the coverage filter
    cannot lower that" becomes false, and it refuses runs whose planned E would fit.
- Both choices change R-384's unit pins at verify.test.ts:1036-1060 only under (a) (C2's numbers
  move to `N = B` passes / `N = B + 1` refuses). No gate exercises check 1.
- Check 2's sentence "The unmutated runs had already run when this was found" was already loose
  (the reruns run after the mutants). This plan leaves it byte-identical (Q4).

## Schema: v6 needed, REQUIRES THE ORCHESTRATOR'S RULING before bumping (Q1)

`newTests[].state` is a closed enum in verify-v5 (:104-107), and the schema's own rule bumps "when
a value domain changes in either direction". So `not-rerun` needs `VERIFY_SCHEMA_VERSION = 6`.
Without the bump, a v5 document could carry a value v5 validation rejects, and a v5 consumer
destructuring `[b, r] = runs` would read `r` as undefined. With v6, no v5 document ever carries it,
and verify-read.ts (keys on `version < 5`) reads v6 exactly as v5; `FIRST_REACH_RECORDING_VERSION`
stays 5. Ripple, if ruled:

| File | Change |
|---|---|
| `src/verify-reach.ts` | `ReachResult.unsent` |
| `src/orchestrator.ts` | `narrow` return `notRerun?`; `applyNarrow` checks; rerun loop skips; result `notRerun?` |
| `src/verify.ts` | `NEW_TEST_STATES` += `not-rerun`; version 6 + history comment; `runs` doc; `narrow` returns `notRerun`; `newTests` build + one-run result; exit code; cap check 1/2 numbers and texts |
| `src/cli.ts` | help text :1126-1128 (exit 0 also with `not-rerun` tests) |
| `schemas/verify-v6.schema.json` (new) | copy of v5; const 6, `$id` v6; enum += `not-rerun`; `runs` description "[baseline, rerun]; [baseline] alone when state is not-rerun" |
| `schemas/verify-v5.schema.json` | unchanged, frozen |
| `schemas/README.md` | v6 row; v5 row "kept ... (v6 added the newTests[].state value not-rerun)"; file counts; "verify v6 pinned, v5..v1 frozen" |
| `tests/schemas.test.ts` | "v5 kept as published" test (const 5, enum lacks `not-rerun`); root-required map += v6 (same 7 keys); NEW_TEST_STATES literal pin |
| `tests/agent-contract.test.ts` | none in code: the docs table must list `not-rerun` (pinned through NEW_TEST_STATES) |
| `docs/using-lethal-from-an-agent.md` | version + v6 link (:448); state row (:453); a `not-rerun` paragraph by :470-476; exit rows :482/:486; :600 "Every new test still runs twice unmutated" → once when sent to no survivor; the check-1/check-2 text in the refusal table |
| `README.md`, `CHANGELOG.md` | one clause; [Unreleased] entry (R427, schema v6) |
| `itest/verify-agreement.itest.ts` | K5 exception (below) |
| Snapshots / committed verify reports | none contain verify JSON (as R-425 found); nothing to regenerate |

**Unchanged, checked:** SessionReport and its schemas, events/stream, explain, campaign, store
schema, identity keys, digests, verify-read.ts, R-425's `reachFilter`/`reachNarrowed` and
`droppedNewTestsOf` (derived from `newTests[].test`, which still lists K5).

## Gates

- **itest:verify:** step 3's new test reaches ClampPercent → rerun, `stable`, two runs:
  unchanged. Steps 4/4b: N = 0. Steps 5a-5d refuse before the lease, none on the cap. No value
  moves; the gate does not exercise the new path.
- **itest:agreement: it DOES exercise it, and NOT by addition only.** K5
  `BonusForTwiceOnOneInstance` reaches only `BonusFor`, whose survivor S5 is skipped (R-384
  pre-commitment :104, :116), and it is filterable (:122). Predicted for step 3: K1-K4 `stable`,
  two fresh pass runs in different sessions (unchanged); **K5 `not-rerun`, `runs` = one fresh
  `pass`**; exit 0 (only under Q2's ruling); verdicts, `testsRun`, reach line, R-425 pins
  unchanged. The loop at verify-agreement.itest.ts:471-486 must exempt K5 and assert its new
  shape: an AMENDMENT to an existing assertion, so acceptance 6's "addition only" cannot hold
  literally (Q5). Step 6 (verify faster than B) still holds, by one run more.
- **itest:verify-scale** (not gated): no-op tests have empty target coverage → fail-closed →
  rerun; "all stable" holds (inferred).
- **Blind pre-commitment needed:** yes, K5's state and run count are predicted gate values.
  Task 6 writes `docs/superpowers/specs/2026-10-04-r427-not-rerun-precommitment.md` before any
  live run. The R-384 and R-425 pre-commitments are not edited.

## Tasks (TDD; red-check each: revert the named clause, see the named test go red, restore)

1. **`unsent` (verify-reach.test.ts).** Sibling-only filterable test → in `unsent`; a test
   reaching one survivor → not; fail-closed test (red baseline; empty coverage) → not; a
   fail-closed survivor → nothing unsent; filter off → empty; a new test that is also a covering
   test → not. Red-check: compute `unsent` from `filterable` minus `reachedBy` ignoring fail-closed
   survivors → the fail-closed-survivor case goes red.
2. **Orchestrator (orchestrator.test.ts), stateful fake backend with a dispatch counter.** A
   `notRerun` key is dispatched exactly once (baseline only); a sent test twice; `notRerun` lists
   it; `rerun` omits it. `applyNarrow` refuses a `notRerun` key in a kept list and one not in
   `rerunOnUnmutated`. Red-check: drop the skip in the rerun loop → the once-count test goes red;
   drop the kept-list check → the refusal test goes red.
3. **Verify (verify.test.ts).** Update `reachRunNamed` to honour `notRerun`. Pin acceptance 1:
   N1 reaching M0001, N2 reaching nothing → N1 `stable` two runs, N2 `not-rerun` one run, exit 0.
   Fail-closed pins: same world with `--no-reach-filter`, with hub mode, with N2 red, with N2
   empty coverage → N2 rerun, never `not-rerun`. A fake answering both rerun and notRerun → throw;
   a `notRerun` test with a non-fresh baseline → throw. Red-checks: return `notRerun: undefined`
   → the once pin goes red; map `not-rerun` to `stable` → the state pin goes red.
4. **Exit code + budget.** `verifyExitCode` with `not-rerun` → 0 (per Q2). Check 2: `E = N+R+P`
   at the boundary (`E = B` passes where today's `2N + P = B + 1` refused; exact R < N text;
   R = N text byte-identical to the R-384 pin). Check 1 per Q3. Red-check: count `2N` again → the
   new boundary test goes red, the old ones stay green.
5. **Schema v6** (after the ruling): file, README, schemas.test.ts, docs, cli help, CHANGELOG.
   Red-check: delete `not-rerun` from the v6 enum → the enum==runtime test goes red.
6. **Pre-commitment addendum** (above), committed by the orchestrator before the live run.
7. **Itests under a Cronus28 lease** (tell the orchestrator first; no AL change, no publish):
   amend agreement's K5 assertion, then `LETHAL_ITEST_VERIFY=1 bun run itest:verify` and
   `LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement`, both green. Live red-check (agreement):
   an uncommitted edit putting K5 back in `rerunOnUnmutated` → step 3 fails on K5's run count;
   restore with Edit; re-run green. Logs under `/coord/handoff/R-427/`.
8. **Finish.** `bun run typecheck`; `rm -rf packages/*/dist`; `bun scripts/verify.ts`;
   `bunx biome check <touched files>`; `docs/roadmap/R427.md` status `done (<commit>)`;
   `bun scripts/roadmap-index.ts`; regenerate `ROADMAP.md` again after any master merge.

## Open questions for the orchestrator

1. Rule v6 (this plan says required by the schema's own rule), or another shape?
2. Exit code: may `not-rerun` give exit 0 (recommended), or must it block like other states?
3. Check 1: relax to `N > B` (recommended) or keep `2N > B` and today's text?
4. Check 2's "The unmutated runs had already run" sentence: keep (this plan) or correct to
   "The baseline runs had already run" (changes R-384's pinned text)?
5. itest:agreement's K5 assertion must be amended, not added to: accept that, with the
   pre-commitment addendum, as meeting acceptance 6?
6. The name `not-rerun` (beside outcome `not-run`): keep, or prefer e.g. `ran-once`?

## Orchestrator rulings and review additions (at adoption, 2026-10-04)

Rulings: (1) v6, yes; v5 kept as published. (2) `not-rerun` exits 0, documented. (3) Check 1 becomes
`N > B`. (4) Check 2's text stays byte-identical. (5) The K5 amendment is accepted; the lane writes
the pre-commitment addendum BEFORE any live run of the new code, the orchestrator commits it to
master before the lease is taken, and every other itest assertion stays addition-only. (6) Keep
`not-rerun`.

Review additions (Claude spec-adversary, approve):
- REQUIRED: in verify.ts, assert that `ran.notRerun` equals `reach?.unsent ?? ∅`, the same way
  `ran.unreached` is cross-checked today (verify.ts:1655-1659), so a backend or fake that ignores
  `notRerun` cannot quietly report `stable`. Red-check it with a fake that ignores `notRerun`.
- INCLUDED: `applyNarrow` also refuses a `notRerun` key whose baseline is invalid
  (`invalidBaselineReason`), so that case fails before any mutant run rather than after.
- STATE IN THE DOCS: runs with N <= B < 2N now pass check 1. With S >= 1 they take the lease and may
  refuse at check 2; with S = 0 they finish with nothing run and `newTests: []` (verify.ts:1594).
  No verdict is wrong; say so in the CHANGELOG.
