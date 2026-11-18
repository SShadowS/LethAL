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

## 0b. Amendment 2: the gate leg RC, pre-committed before it is built or run
- **The fixture `fixtures/sandbox-recheck`** (an app and a test app, runtime 17, invented code).
  - **App:** codeunit "Recheck Logic", with:
    - `Double(X: Integer): Integer` (`exit(X * 2)`);
    - `Triple(X: Integer): Integer` (`exit(X * 3)`);
    - `Bump()` and `Count(): Integer` over a counter in a `SingleInstance` codeunit "Recheck State".
  - **Test codeunit "Recheck A Tests"**, in declared order:
    - `A0_Refuses`: an `Evaluate` of a 10-NUL text into Decimal, a refusal on edge-4ebfe7913 (PR-139's probe);
    - `A1_Doubles`: asserts `Double(2) = 4`.
  - **Test codeunit "Recheck B Tests"**, in declared order:
    - `B0_Refuses`: the same refusal;
    - `B1_TriplesAndBumps`: calls `Bump()`, then asserts `Triple(2) = 6`;
    - `B2_SeesTheBump`: asserts `Count() = 1`. It passes after B1 in one codeunit session, and fails alone.
- **The leg's session:**
  - backend al-runner-v3 on the gate's pinned build, `"isolation": "test"` (explicit, so `auto` cannot move the
    codeunits), serve transport;
  - `"recheckWithheldKills": true`, `--workers 1`.
- **Pre-committed figures, per mutant at the two sites** (`exit(X * 2)` in `Double` and `exit(X * 3)` in `Triple`):
  - **Main pass:** every mutant at those sites that changes the returned value is `error` with `withheldKill` (afterTest
    `A0_Refuses` or `B0_Refuses`).
  - **After the recheck:**
    - each `Double` mutant whose main row was a withheld kill is `killed` by `A1_Doubles`, with `killReproduced` and
      `isolatedRecheck`;
    - each `Triple` withheld kill stays `error`, its note naming rule (e) and the lost test `B2_SeesTheBump`;
    - mutants elsewhere (`Bump`, `Count`) are recorded in the leg's baseline. They are not part of this prediction.
  - **Caveats:** `isolated-recheck-kills` counts exactly the recovered `Double` mutants, and `withheld-kills` counts
    exactly the `Triple` ones.
- **The leg fails by name:**
  - when the main pass has 0 withheld kills (a fixed refusal would make the leg empty);
  - when no `Double` mutant is recovered;
  - when any `Triple` mutant is recovered.
- **Existing legs:** every other leg's frozen figures stay exactly as they are; RC adds a baseline file of its own. The
  gate page `docs/gates/alrunner-v3.md` gains RC's section with these figures.

## 0c. Amendment 3: leg RC's warning set
- **RC's warning set is `[]`:** `GATE_WARNINGS["al-runner-v3/RC"]` in `gate-expected.ts`.
- RC's first live run (record mode, edge-4ebfe7913, branch head aaa7c4e2) stopped as INFRA-FAIL at the warnings check,
  before the table, because the set was not committed. It observed `[]`.
- No session warning is expected: RC's session is a plain serve session on the pinned build. The recheck's nested
  session reports through the caveat and its own events, not the session's warning set.
- The table (§0b) is unchanged and is judged on the next run.

## 0d. Amendment 4: the fixture redesigned (§0b's design cannot produce a withheld kill)
- **What happened:** RC's second live run (record mode, edge-4ebfe7913, branch head fdd396be) was GATE-FAIL by name: "the
  main pass held 0 withheld kills". The empty-leg guard worked.
- **The cause:** §0b's design is wrong.
  - `A0_Refuses` is refused at BASELINE (measured: `rcprobe/run1.json`), so it is in no mutant's plan and is never sent
    under a mutant.
  - So under a `Double` mutant, `A1_Doubles` is the first test sent, and its failure is a trusted kill (the run shows 8
    kill pairs).
  - A withheld kill needs a test that PASSES at baseline and is refused, or fails, only under the mutant. That is DO's
    own shape: M28736's removed assignment left NUL characters.
- **The fixture, redesigned (replaces §0b's objects):**
  - **App, codeunit "Recheck Logic":**
    - `Sevens(N: Integer) T: Text`, a loop of `C := '7'; T += Format(C);`;
    - `SevensB(N: Integer) T: Text`, the same body in its own procedure;
    - `Bump()` and `Count(): Integer` over the SingleInstance "Recheck State".
  - **"Recheck A Tests":**
    - `A0_ParsesSevens`: `Evaluate` of `Sevens(10)` into Decimal must succeed and give 7777777777;
    - `A1_OneSeven`: `Sevens(1) = '7'`.
  - **"Recheck B Tests":**
    - `B0_ParsesSevens`, as A0 with `SevensB`;
    - `B1_OneSevenAndBump`: `Bump()`, then `SevensB(1) = '7'`;
    - `B2_SeesTheBump`: `Count() = 1`.
- **Pre-committed figures, per mutant, for the `lethal.remove-assignment` mutant of `C := '7'` in each procedure:**
  - **In `Sevens`:**
    - Under the mutant, `Sevens(10)` is 10 NULs: `A0_ParsesSevens` is refused (the NUL text), and `A1_OneSeven` fails
      after it.
    - **Main pass:** `error` with `withheldKill`, afterTest `A0_ParsesSevens`.
    - **After the recheck:** `killed` by `A1_OneSeven`, with `killReproduced` and `isolatedRecheck`. Codeunit A's
      main-baseline tests, A0 and A1, both pass alone.
  - **In `SevensB`:**
    - **Main pass:** `error` with `withheldKill`, afterTest `B0_ParsesSevens`.
    - **After the recheck:** it stays `error`, its note naming rule (e) and `B2_SeesTheBump`, which passed in the main
      baseline and fails alone.
  - **Other mutants** (the loop, `Format`, `Bump`, `Count`) are recorded in the baseline only. Some may also be withheld;
    the caveats name them.
  - **The caveats:** `isolated-recheck-kills` names the `Sevens` mutant, and `withheld-kills` names the `SevensB` one.
- **The leg fails by name:**
  - when the main pass has 0 withheld kills;
  - when the `Sevens` remove-assignment mutant is not recovered;
  - when the `SevensB` one is recovered.
- **Unchanged:** the warning set `[]` (amendment 3) and every other leg.

## 0e. Amendment 5: leg RC leaves PR-144 (orchestrator ruling, option (B), 2026-11-18)
- **Why:** probes on edge-4ebfe7913 (`/coord/handoff/PR-144/rcprobe*`, serve and one-shot) showed amendment 4's shape
  cannot produce a withheld kill either.
  - A test refused only under the mutant with a KNOWN-reach refusal (the NUL `Evaluate`) leaves the next failure a plain
    trusted `fail`, with or without a write first.
  - x3's real withheld rows all follow a refusal whose reach is unknown ("part of its reach is not known ... so the state
    it would have left is not BC's": `GoToKey` on a list, `FindSet` on Company, `Codeunit.Run` with a run-time id).
  - A fixture needs an earlier test that passes at baseline and reaches such a refusal only under the mutant. That is a
    probe-and-iterate job.
- **So PR-144 lands WITHOUT leg RC and without its fixtures:**
  - nothing that `compile:fixtures` skips;
  - nothing a gate cannot run;
  - no symbol-tar change.
- §0b, §0c and §0d move to the follow-up item R1125, together with the symbol-tar rebuild.
- **The option's help text and docs say,** beside the H1 warning, that the recheck has not yet been exercised live end
  to end. It is covered by unit and real-path tests and by arm M's approximation.
- **The recheck counts as unproven live until R1125's leg passes.** P5 (the BC differential) depends on such a fixture,
  and still gates any default-on.

## 0f. Amendment 6 (coord PR-162, R1125): the shape that makes v3 withhold a kill, and leg RC's figures
- **Found by probe** (`/coord/handoff/PR-162/p3/`, `al-runner serve`, edge-4ebfe7913).
  - A test refused MID-RUN withholds the next test's failure only when its REMAINING reach, what BC would still run
    after the refusal point, holds a construct al-runner cannot know. Measured with `Page.RunModal(0, R)` ("runs page 0,
    which is not in the program") and a `Codeunit.Run` whose id is known only at run time.
  - The same constructs before the refusal point, or in an untaken earlier branch, leave the next failure a plain trusted
    `fail` (runs s2 and s4). That is why amendments 2 and 4 could not produce a withheld kill.
- **The fixture, `fixtures/sandbox-recheck` and `-tests`** (invented code, runtime 17):
  - **App, codeunit "Recheck Logic":**
    - `Sevens(N: Integer) T: Text` and `SevensB(N: Integer) T: Text`, each a loop of `C := '7'; T += Format(C);`.
  - **"Recheck A Tests", in declared order:**
    - `A0_ParsesSevens`: `T := Sevens(10)`; `if not Evaluate(D, T) then Error(...)`; then `if D < 0 then
      Page.RunModal(0, R)` (`R` a record of an app table), after the refusal point;
    - `A1_OneSeven`: `Sevens(1) = '7'`.
  - **"Recheck B Tests", in declared order:**
    - `B0_ParsesSevens`, as A0 over `SevensB`;
    - `B1_OneSevenAndMarks`: sets a GLOBAL Boolean of the test codeunit (`Marked := true`), then asserts
      `SevensB(1) = '7'`;
    - `B2_SeesTheMark`: asserts `Marked`. It passes after B1 in one codeunit run, because TestIsolation = Function keeps
      the codeunit's variables, and fails alone, under `"method"` isolation's fresh session per test. This is the
      README's `IsInitialized` case.
  - Unmutated, every test passes. Probe s5's B control passes with the same A0 shape.
- **Leg RC** (as amendment 2, with these objects):
  - an al-runner-v3 session on the gate's pinned build, `"isolation": "test"`, serve, `"recheckWithheldKills": true`,
    `--workers 1`;
  - its warning set `[]` (amendment 3).
- **Pre-committed figures, per mutant:**
  - **The remove-assignment mutant of `C := '7'` in `Sevens`:**
    - **main pass:** `error` with `withheldKill` (afterTest `A0_ParsesSevens`; the note names "part of its reach is not
      known (runs page 0, which is not in the program)");
    - **after the recheck:** `killed` by `A1_OneSeven`, with `killReproduced` and `isolatedRecheck`. Codeunit A's
      main-baseline tests, A0 and A1, both pass alone.
  - **The remove-assignment mutant of `C := '7'` in `SevensB`:**
    - **main pass:** `error` with `withheldKill` (afterTest `B0_ParsesSevens`);
    - **after the recheck:** it stays `error`, its note naming rule (e) and `B2_SeesTheMark`, which passed in the main
      baseline and fails alone.
  - **Other mutants** of the two procedures are recorded in RC's own baseline, not predicted.
  - **The caveats:** `isolated-recheck-kills` names the `Sevens` mutant, and `withheld-kills` names the `SevensB` one.
  - **The leg fails by name:**
    - on 0 withheld kills;
    - when the `Sevens` mutant is not recovered;
    - when the `SevensB` mutant is recovered.
- **The symbol tar:**
  - rebuilt with both projects (`build-fixture-symbols-tar.sh`, after adding the new projects' Microsoft symbols to its
    input);
  - `FIXTURE_SYMBOLS_TAR`, `FIXTURE_SYMBOLS_TAR_SHA256` and the manifest updated;
  - `compile:fixtures` compiles both with no SKIP on this machine.
  - CI gets the tar only through the owner's secret swap (a kraken ask, kind config). **Until the swap and a green CI
    compile, leg RC is recorded but not counted as proven** (the orchestrator, 2026-11-18).
- **Unchanged:** every other leg's figures, and P5 gating any default-on.

## 0g. Amendment 7 (coord PR-162): the refused test must NOT cover the mutant
- **What happened:** RC's live record run with amendment 6's fixture (`/coord/handoff/PR-162/rc-record.log`) was
  GATE-FAIL by name, "0 withheld kills". A manual run of the same session (`/coord/handoff/PR-162/manual/report.json`)
  shows why.
  - `A0_ParsesSevens` calls `Sevens`, so it is itself a covering test of the mutant. Its own refusal is the mutant's
    FIRST non-pass row, so the row's note is that direct refusal, and `A1`'s withheld failure only follows it ("after
    the error").
  - So `withheldKillOf` does not match, by design: a row is a withheld kill only when the withheld failure is its first.
- **The fix,** which is DO's real shape (x3's refused earlier tests are refused at every baseline and cover none of the
  mutants they spoil):
  - `A0_RefusedWithUnknownReach` and `B0_RefusedWithUnknownReach` build their own 10-NUL text (a `Char` 0 loop), not
    from `Sevens`/`SevensB`, `Evaluate` it into a Decimal (refused), then `if D < 0 then Page.RunModal(0, R)`.
    - They are refused at EVERY baseline and cover no mutant.
    - They still run first in each codeunit call, because serve sends a codeunit's tests as a prefix in declared order.
  - `A1_OneSeven` is the only covering test of the `Sevens` mutant. `B1_OneSevenAndMarks` and `B2_SeesTheMark` are
    unchanged.
- **Measured by the manual run** (the scratch copy `/coord/handoff/PR-162/manual/fx`, `report2.json`, `recheckWithheldKills`
  on, edge-4ebfe7913, serve, isolation test, `--workers 1`):
  - the baseline is 3 of 5 passing, with A0 and B0 refused;
  - **the `Sevens` remove-assignment mutant:** `killed` by `A1_OneSeven`, with `killReproduced` and `isolatedRecheck`;
  - **the `SevensB` one:** `error`, a withheld kill (afterTest `B0_RefusedWithUnknownReach`, "part of its reach is not
    known (runs page 0, which is not in the program)"). Its note ends "[recheck kept error: rule (e): the recheck
    baseline lost Recheck B Tests.B2_SeesTheMark, which passed in the main baseline]";
  - the caveats include `withheld-kills` and `isolated-recheck-kills`, plus `baseline-red`, because A0 and B0 are
    refused at baseline by design.
- **Leg RC's figures are amendment 6's,** with these names: the `Sevens` mutant recovered by `A1_OneSeven`; the `SevensB`
  mutant kept `error` by rule (e) naming `B2_SeesTheMark`, afterTest `B0_RefusedWithUnknownReach`. Its baseline is 3 of 5
  passing.
  - The warning set stays `[]` (amendment 3). The CLI run also warned `al-runner-v3-memory-guard` and
    `al-runner-v3-serve-flagged-unknown`, but the leg builds its backend without the CLI, as before.
- **The symbol tar is unchanged by this amendment:** the same projects and apps.

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
