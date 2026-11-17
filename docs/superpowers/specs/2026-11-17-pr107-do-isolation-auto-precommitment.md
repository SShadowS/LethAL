# PR-107 pre-commitment: DO's withheld kills under isolation "auto" (R1102)

Status: committed before any run of PR-107 part 1 (coord PR-107, lethal-preproc, 2026-11-17). Evidence:
`/coord/handoff/PR-107/`.

## What it tests
[[R1102]] (PR-106): DO's config forces isolation "test". Under it al-runner withholds kills: the covering test fails under
the mutant, but an earlier test of its codeunit was refused, and al-runner reports the failure as `NotRun` ("this failure
is not trusted"). Isolation "auto" (R896/R921/R956) moves a codeunit to per-test calls, where the refused test is never
sent, when its baseline shows the need. On PR-106's 60-mutant slice, "method" turned 39 of 39 such errors into kills and
kept every survivor.

This run asks, on the whole affected part of DO, whether "auto" scores the withheld kills of the codeunits it moves, and
moves nothing else. The answer decides DO's default isolation.

## The data the predictions come from
- **DO run 15** = R-984 window t14 (head 3fe3bd1a, build edge-847b1fa5a, `dos3.sqlite`). It completed the campaign's
  covered set (rc 0, no budget stop). It has 868 error verdicts: 557 withheld kills (cascades) and 311 direct refusals.
- **The auto choice** is predicted with LethAL's own `isolationCandidates`, `isZeroGreen` and `chooseCodeunitIsolation`,
  applied to the two whole-suite DO baselines of PR-106's slice runs (same build and config, isolation test and method;
  `/coord/handoff/PR-106/s-test.sqlite`, `s-method.sqlite`).
  - 42 candidate codeunits, **31 moved to method**: 68871, 68873, 68876, 68878, 68879, 68885, 68903, 68904, 68912, 68914,
    68922, 68953, 68958, 68959, 68960, 68961, 68962, 68963, 68968, 68970, 68973, 68978, 68979, 68986, 68991, 68994, 68995,
    69001, 69002, 69003, 69011.
  - Of the 557 withheld kills, 451 sit in a moved codeunit. 106 do not: 96 in `CDO Variant Setup UI Tests`, where method
    does not pass strictly more, and 10 in codeunits that are not candidates.

## The slice
- Every mutant of the 129 procedures that hold run 15's 557 withheld kills: **2,656 mutants** in 36 files.
- Narrowed by 1,864 one-line `--lines` spans (`lines.args`), one per mutant line. A procedure name repeats in a file (a
  page's OnAction triggers), so first-to-last spans would take in other procedures; no mutant of another procedure starts
  on these lines.
- The dry run on master 31d9139f deploys 2,656, equal to the slice by (file, line, operator).
- Pins: `/coord/handoff/PR-107/slice-keys.tsv` (sha256 `9066696794e051e1cbf76b4fc00254c37c618288a9ff4ffb26ca033e992ebc10`).
  A mutant is pinned by (file, procedure, operator, `ast_hash`, `identity_ordinal`).

## The runs
Two runs on the same LethAL head, the head of lethal/pr107 at the time, which carries only PR-107's refusal-ledger
entries over master. Both use build edge-847b1fa5a (from the config path), fresh scratch stores, `--workers 1`, the same
spans, no time budget, and one after the other inside one `heavy-slot.sh --wait --peak 12 baseapp` slot:
1. **control:** `/coord/handoff/R-984/v3.do-serve.json` (isolation "test", DO's config);
2. **auto:** `/coord/handoff/PR-107/v3.do-auto.json` (the same, with isolation "auto").

## The predictions (auto against control, per pinned mutant)
The file: `/coord/handoff/PR-107/predictions.tsv` (sha256
`ead78effee735298251ff474cd658edeab8dbe5b7b3f5239878eb2a4337b3953`), one class per mutant, from run 15:

| class | mutants | prediction |
|---|---|---|
| P0 | the run | auto's choice puts exactly the 31 codeunits above on method |
| P1 | 451 | withheld kills in a moved codeunit: control error, auto **killed** |
| P2 | 106 | withheld kills in a codeunit kept on test: error in both |
| P3 | 71 | direct refusals: error in both |
| P4 | 2,028 | the rest (run 15: 465 killed, 1,387 survived, 176 no-coverage): the same verdict in both |

**The one allowed exception to P2, P3 and P4.** Let G be the tests that are green in auto's baseline and not green in
control's baseline. Both are read from the two runs' stores. A mutant whose covering tests under auto include a test of G
may move:
- to killed, if it was error, survived or no-coverage;
- from no-coverage to survived.

`killingTest` may change only for a killed mutant whose covering tests include a test of a moved codeunit. Every other
move, of any class, is **unexplained**.

The control is also compared with run 15 per mutant. That comparison is reported only: the LethAL heads differ, and
master has gained PR-100 to PR-106 since.

## The bar, and what it decides
- **Measured facts, all reported:** P0 equal or not, with the difference named; P1 hits; P1 misses, each with its row; the
  allowed moves, each with the G test that explains it; the walls of the baseline, the isolation re-baseline and the
  mutant phase of each run; the tree peaks.
- **Isolation "auto" is recommended as DO's default** only if both hold:
  - there are 0 unexplained moves;
  - at least 90% of P1 (406 of 451) are killed.
- Otherwise the recommendation is "test" (today's), with the reason, and the failing rows go to [[R1102]].
- If P0 differs, P1 and P2 are recounted by the run's own choice before the bar is read, and the difference is reported
  as P0's miss.
- A crash, a budget stop or an infra failure makes the run not evidence. It is re-run, never counted.

## Amendment 1 (2026-11-17 12:40Z, before the narrowed run): the auto leg narrowed to the P1 lines
- **What happened.** The control leg ran the whole slice in 5,236 s, at about 2 s per mutant. The auto leg's baseline,
  with the method re-baseline, took 1,737 s. Its mutant phase then ran at 9.7-15.6 s per mutant: each pass runs every test
  of a moved codeunit in its own session, and per [[R1099]] each session pays the company login. At 470 of 2,656 it would
  have needed about 6 h more, past its 6 h timeout.
- On the orchestrator's instruction, it was stopped cleanly at 12:30Z: SIGTERM, report written, rc 7. **Under the rule
  above that run is not evidence.** Its 471 scored mutants are reported only as a side observation.
- **The control leg stands as run:** the whole slice, isolation test, N = 1, on the same head and build.
- **The new auto leg.** The same config and build, and the head of lethal/pr107 at the time.
  - **Scope:** the 353 lines of all 451 P1 mutants, as one-line `--lines` spans (`/coord/handoff/PR-107/lines-narrow.args`,
    sha256 `b28d176f69f593b49e0a86509963f07f15e31d9222ebad55f48b0af49f630098`). Its dry run deploys 606 mutants, all of
    them slice mutants with their committed class: P1 451, P4 149, P3 6.
  - **`--workers 3`**, under `heavy-slot.sh --wait --peak 16 baseapp`. PR-99 proved N = 1 equal to N = 3 per mutant on DO.
    Any lane effect would show as an unexplained move against the N = 1 control, and block.
- **Unchanged:** the classes, the allowed exception, the killingTest rule, P0 and the bar. They are read over these 606
  mutants, the 451 P1 included. P2 is not measured: the narrowed scope holds no P2 mutant.
