# PR-144: re-check the withheld kills in isolation after the main pass (spec)

Status: **r2**, committed to master before any build (coord PR-144, lethal-preproc, 2026-11-18).
- r2 answers the opus spec-adversary's review of r1 (706eceac; `/coord/handoff/PR-144/review-r1.md`) and the orchestrator's
  ruling of 2026-11-18: build opt-in and default OFF, with rule (e); the BC differential (P5) gates any default-on.
- Evidence: `/coord/handoff/PR-144/` (`result.md`, `prep.py`, `run-m.sh`, `m.report.json`).

## 0a. Amendment 1 (the opus review of the built change, c7182521; the orchestrator's ruling of 2026-11-18)
- **Rule (e) is codeunit-wide.**
  - The recheck baseline runs the targets' covering tests PLUS every main-baseline test of each covering codeunit.
  - A test of the killer's codeunit that passed in the main baseline and has no recheck result counts as LOST (fail
    closed), as does one that failed or was refused.
  - The built r2 skipped un-run tests, a pass with no evidence (review B1).
  - **The cost:** on arm M's data, 928 tests in place of 410, about 1,690 s of baseline in place of about 750 s. It is
    paid only when the option is on.
- **P1 is restated: 198 recovered, 96 kept by (e).**
  - Joined from x3's main baseline: exactly one test passed in the main baseline and fails alone,
    `CDO Variant Setup UI Tests.U_CopyCriteriaFromLine_TakesTheCriteriaOfThePickedLine`, a covering test of the targets.
  - So (e) keeps the 96 kills whose killer is in that codeunit as `error`, and recovers 198. M18076 stays `error`, as a
    direct refusal.
  - Both forms of (e) give the same answer on arm M.
- **Neither form of (e) tests H1.**
  - In H1, a test v3 REFUSED left state the killer depended on.
  - (e) only judges tests that passed in the main baseline, so it can never judge a refused one. In arm M, the 50 tests of
    the 11 killer codeunits that do not pass alone are all non-covering, and all failed in x3's main baseline too.
  - (e) catches order dependence among tests al-runner runs, nothing more. **Only P5 (the BC differential) answers H1,
    and P5 still gates any default-on.**
- **Rule (d), as built:**
  - It compares the al-runner version, the binary sha256, `sourceSha256` and `dependencySourceSha256`. The recheck's
    artifact must differ (it compiles only the targets), so the artifact and alc proof hashes are not compared.
  - The recheck backends come from the run's pinned `effectiveConfig` (R1018).
  - Any missing hash fails (d).
- **The store, as built:** the recheck never writes the store. The main pass's stored row stays `error`, which is never
  carried, so `--resume` rederives recovered kills by construction. That replaces r2's "stored with a recheck marker".
- **Other review fixes in the build:**
  - the main session's daemons close before the recheck starts (review B3, memory);
  - a reused main baseline (no main baseline rows) skips the recheck with a warning;
  - the recheck baseline is folded strictly ("passed in every batch");
  - the stream doc names `mutant-rechecked` as a verdict-replacing event;
  - `excludeTests` is kept in the recheck's config;
  - tests reach the real nested path (`exactSites`, `keepOnlyTests` refusals, the session hook).
- **The al-runner-v3 gate leg** (§3.7): its figures are pre-committed in amendment 2, before it is built or run.

## 0. The review of r1, finding by finding
- **H1: a recheck kill does not answer why v3 withheld the kill.**
  - Method isolation removes the state an earlier refused test left; it does not restore BC's. BC keeps that test's rows
    and its SingleInstance and language state.
  - So a recheck kill can pass every rule and still be one BC would not make: an earlier test sets state, and without
    it the mutated code is reached.
  - No withheld kill has been run on BC.
  - **Answered:**
    - the recheck is opt-in, default OFF (§3.1);
    - rule (e) keeps `error` wherever the recheck baseline loses a test the main baseline passed (isolation `auto`'s
      lose-nothing rule);
    - the option's help text and the docs say plainly that these kills are not measured against BC and may be false
      where an earlier refused test set state;
    - **P5, a BC differential, gates any default-on (§4).**
- **H2: the store and events.** Answered in §3.4: a `mutant-rechecked` event; recheck baseline events that never fold into
  the session's baseline; rechecked rows are not carried by `--resume`.
- **M3: P3 was falsified by arm M** (3,464 s against its bound of about 1,726 s; the alone confirm and reproduce of 294
  kills is outside its terms). Replaced in §4.
- **M4: the time budget.** DO windows spend their budget, so the recheck runs as its own step with its own budget
  (§3.1). Carried rows are not rechecked. "Skipped" counts as P2 not met.
- **M5: the coverage source.** The recheck plans from its own per-test baseline. Its covering set goes on the row, and the
  note says when the killer was not green in the main baseline (§3.3, §3.4).
- **M6: the note's position.** Recheck text goes after `V3_NOT_RUN_SUFFIX`, so a row that stays `error` is still a
  withheld kill. Tested (§3.6).
- **M7: the field.** An optional per-mutant field `isolatedRecheck` (§3.4). An optional field has no root-field ripple, as
  R1108's `withheldKill`.
- **L8, (d)'s mechanism:** the recheck backends are built from the run's pinned `effectiveConfig` and sidecar (R1018), and
  the binary sha256 and the artifact and alc proof hashes are compared.
- **L9, transport:** serve only. Without serve the recheck is skipped and rows stay `error`.
- **L10:**
  - test refs are codeunit-qualified;
  - rule (c)'s red check uses a fake that breaks plan construction;
  - P1 is per mutant;
  - the fixture leg fails loudly at 0 withheld kills.
- **The orchestrator's points:**
  - (1) a recovered kill is countable and nameable: the `isolatedRecheck` field and a caveat;
  - (2) the baseline cost scales with the tests run, so the recheck baselines only the targets' covering tests (§3.2).

## 1. The problem
- A **withheld kill** (R1108, `withheldKillOf`) is an `error` row where a covering test FAILED under the mutant, but al-runner
  v3 did not trust the failure: an earlier test of its codeunit was refused, failed or ran out of time, and the state that
  test left is not BC's. LethAL scores it `error`, outside `mutationScore`.
- On DO it is the largest error class: 295 of x3's 446 errors.
- Isolation `"auto"` recovers them (R1102: 450 of 451) for the whole run, at about 21 min more baseline and about 3x per
  mutant in moved codeunits. It is opt-in, and DO's default stays `"test"`.

## 2. The measurement (arm M, PR-144)
- **Arm M:** x3's 295 withheld-kill sites (`--lines`), baseline narrowed to their 51 covering test FILES (928 tests),
  under `"isolation": "method"`. The build is x3's (edge-4ebfe7913), with `--workers 3`, beside another DO window.
- **294 of 295 became `killed`, all with `killReproduced`:**
  - 281 with x3's withheld failure;
  - 13 by another test (14 by the reviewer's join). In 10 of those the killer is not in x3's `coveringTests` and failed
    x3's baseline.
- **1 stayed `error`:** M18076, a direct refusal. 0 survived.
- **The cost, 3,464 s:**
  - 1,692 s of baseline: 928 tests at about 1.82 s each;
  - 150 s of mutants;
  - 40 s to generate and deploy;
  - the rest, about 1,580 s, mostly the alone confirm and reproduce of the 294 kills.
- **What the baseline scales with:** the targets need only 410 distinct covering tests. The baseline scales with the tests
  run, not the rows or files. 410 tests would take about 750 s, and a run with few withheld kills pays for its targets'
  covering tests (a median of 5 per target).

## 3. The change
1. **When, and the switch.**
   - The config option is `alRunnerV3.recheckWithheldKills: boolean`, **default false**. Its help text and docs say:
     "kills recovered this way are not measured against BC; they may be false where an earlier test that al-runner
     refused would have set state on BC."
   - When it is true, after the main pass of an `al-runner-v3` session whose isolation is not `"method"`, the recheck
     runs as its own step, with its own budget: `recheckBudgetSeconds`, default 3600. The main pass's `--time-budget`
     does not cover it.
   - It runs only on serve transport.
   - It rechecks only rows this session scored. Carried rows are not rechecked.
2. **What runs:**
   - the withheld-kill rows only (`withheldKillOf`), and not other mutants on their lines;
   - under `"method"` isolation, on fresh serve daemons;
   - backends built from the run's pinned `effectiveConfig` and sidecar;
   - a baseline of exactly the targets' covering tests, codeunit-qualified, one per session.
3. **The verdict rule.** `error` becomes `killed` ONLY when ALL hold:
   - (a) the main-pass row is a withheld kill;
   - (b) the recheck verdict is `killed` with `killReproduced` true;
   - (c) the killing test passed alone at the recheck baseline;
   - (d) the recheck ran the same al-runner binary (sha256) and the same compiled app (artifact and alc proof hashes) as
     the main pass;
   - **(e) no test of the killing test's codeunit that passed in the main baseline failed or was refused in the recheck
     baseline.**
   - **Every other case keeps `error`,** including a recheck `survived`, which is not taken over.
4. **The report and the store:**
   - **The event:** a new `mutant-rechecked` event replaces a row by mutant id only under (a) to (e). The recheck's
     baseline events are `recheck-baseline-*` and never fold into the session's baseline figures.
   - **The row:** a recovered kill carries the recheck's `killingTest`, `killingTestFailure`, `coveringTests` and
     `killReproduced`, plus the optional field `isolatedRecheck: { withheldFailure, afterTest, killerGreenInMainBaseline }`.
   - **The caveat:** a new `isolated-recheck-kills` counts and names the recovered kills, with the H1 warning in its
     meaning. `withheld-kills` counts the rows still withheld.
   - **The note:** a kept-`error` row gets its recheck outcome AFTER `V3_NOT_RUN_SUFFIX`, so it is still a withheld
     kill.
   - **The store:** recovered kills are stored with a recheck marker and are **not carried by `--resume`**. Each session
     rederives them.
5. **Not changed:**
   - no row other than a withheld-kill `error`;
   - no main-pass `killed` or `survived` row;
   - bcdev;
   - the default behaviour (the option is off).
6. **Tests and red checks:**
   - each rule (a) to (e) failing alone keeps `error`, and (c)'s check uses a fake that breaks plan construction;
   - a recheck `survived` keeps `error`;
   - a kept-`error` row still yields `withheldKill`;
   - rows that are not withheld kills are never sent;
   - the option off sends nothing;
   - the budget skip and the serve-only skip;
   - a recovered row is not carried on `--resume`;
   - the recheck baseline does not change the session's baseline figures;
   - red checks both ways for each rule.
7. **The new fixture leg** for the al-runner-v3 gate has one withheld kill, made by an earlier test that refuses. It fails
   loudly if the withheld count is 0.

## 4. Predictions
- **P1 (replay, per mutant):** the recheck over x3's 295 withheld kills, with the option on, gives arm M's verdicts per
  mutant (M18076 stays `error`), minus any rows rule (e) keeps `error`. Each such row is named with the test it lost.
  Arm M used a line-narrowed artifact, so `killingTest` may differ where coverage differs, and each difference is named.
- **P2 (the next DO window with the option on):**
  - at least 95% of that window's withheld kills (net of rule (e)) become `killed`, all with `killReproduced`;
  - no main-pass `killed` or `survived` row changes.
  - A skipped recheck counts as P2 not met.
- **P3 (cost):**
  - the recheck's wall time is at most its baseline (its covering tests x 2.0 s), plus 40 s to deploy, plus the
    recovered kills x 6.0 s (arm M: about 1,580 s for 294);
  - it is at least half that;
  - it is reported per part.
- **P5 (gates any default-on, in any later PR):** a BC differential on a fixture whose earlier test sets state that a
  later test's killing path depends on.
  - Expected: bcdev `survived`, and the recheck `error` (rule (e) or (c) holds it back).
  - If the recheck says `killed` there, the option stays off and the rules are revisited.
  - The orchestrator files it for lethal-code (bc4).
- **The gates:** the al-runner-v3 gate on the final head, with the new leg.
