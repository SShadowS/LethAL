# R-551 pre-commitment r2 (written 2026-10-09, before any implementation or live run)

Applies to the R551 change as specified in `plan.md` r2 (same folder), on top of `origin/master`
`97d295c7`. Written before the code exists. Nothing below may be re-read after the data.

## Changes from r1

1. N3: the reason must contain `exit 2` AND `Unknown option '--test-exact'` (review I2).
2. F3 and N3: a numeric probe-time bound, read from the message's `<n> ms` (review).
3. F4/N4: the mechanism is stated: the cli-default leg's emit hook asserts zero selector events,
   non-vacuously (review I3).
4. A failure rule for run F, as well as run N (review M4).
5. U1/B3 resolved: B3 is a new test, so R488's 14 tests are not edited (review M2).
6. Build identity comes from `--version`. The hashed file is the dotnet-tool SHIM, so the hash
   identifies only the copied shim, not the build.
7. Message wording follows plan r2: "accepted", not "proven".

## Builds

| name | binary | build identity: `--version` must print | shim sha256, first 16 hex (copy check only) |
| --- | --- | --- | --- |
| FLAG | `/tmp/claude-1000/-work-lethal-wt-lane-bugs/42bbe1d1-6c93-426d-bdfa-21fd7ce46008/scratchpad/r551/c5bbaf89/al-runner` | `al-runner v2.12.0-main.c5bbaf89` | `eef93ff97dc9b47f` |
| NOFLAG | `/tmp/claude-1000/-work-lethal-wt-lane-bugs/42bbe1d1-6c93-426d-bdfa-21fd7ce46008/scratchpad/r551/43f76177/al-runner` | `al-runner v2.12.0-main.43f76177` | `16e45d54db180c17` |

Before each run, run the binary with `--version`. A different string voids the run. The `al-runner`
file is the dotnet-tool shim (78,256 bytes); the build lives under its `.store/`. If the scratch copy
is gone, copy `/work/tools/al-runner/<sha>/` again (whole folder) and re-check `--version`. If that
folder no longer exists, stop and report.

## Run F: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<FLAG> bun run itest:alrunner`

- F1. The gate exits 0. Its first line names `v2.12.0-main.c5bbaf89`.
- F2. Every frozen baseline compares equal PER MUTANT, on every field the gate compares (verdict,
  `killingTest` and the rest), with no file re-recorded:
  `al-runner.baseline.json` 3 killed / 12 survived / 4 no-coverage (19);
  `al-runner.cli-default.baseline.json` 3 / 16 / 0 (19);
  `al-runner.symbols-lethala.baseline.json` 5 / 4 / 0 (9);
  `al-runner.symbols-lethalb.baseline.json` 5 / 4 / 0 (9);
  `al-runner.layout.baseline.json` 7 / 3 / 0 (10);
  `al-runner.multiobject.baseline.json` 6 / 1 / 5 (12);
  `al-runner.wrapped.baseline.json` 58 / 37 / 3 (98 rows).
  Every server/resource leg still equals its one-shot leg per mutant, as the gate already asserts.
- F3. Every ONE-SHOT leg's session emits exactly one `al-runner-test-selector` warning. Its message
  begins `al-runner test selector: exact (--test-exact accepted by a one-call probe in ` and the
  `<n> ms` it states is below 3000 (measured 1243-1276 ms in scratch).
- F4. Every `--server` and resource leg emits NO `al-runner-test-selector` warning (the shared
  `runOnce` hook). The cli-default leg's new emit hook records ZERO `al-runner-test-selector` events
  AND at least one event of another kind; zero events of any kind is a FAIL, not a pass. The
  cli-default leg's one-shot allow-list check passes unchanged.
- F5. The wrapped one-shot leg (10 look-alike pairs, `GrowPre`/`GrowPreTwin` and nine more) matches
  its pre-committed table per mutant, including every `killingTest` that names a `...Twin` test and
  every one that names its shorter look-alike. No mutant on any leg records an error whose message
  contains `R488` or `R551`.

## Run N: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<NOFLAG> bun run itest:alrunner`

R488's regression shape on a build without the flag: the wrapped one-shot leg takes the R488 path.

- N1. The gate exits 0. Its first line names `v2.12.0-main.43f76177`.
- N2. Exactly the per-mutant equalities and counts of F2.
- N3. Every ONE-SHOT leg's session emits exactly one `al-runner-test-selector` warning. Its message
  begins `al-runner test selector: substring with R488 excludes (--test-exact not accepted: `, its
  reason contains `exit 2` AND `Unknown option '--test-exact'`, and the probe `<n> ms` it states is
  below 1000 (measured 135-160 ms).
- N4. As F4.
- N5. As F5.

## Unit level (before either live run)

- U1. `bun scripts/verify.ts` passes. R488's 14 existing tests (plan section 0, items 1-5) pass with
  NO edit to their bodies or names. B3 is a new test.
- U2. Every new test in plan r2 section 6 (A1-A2, P1-P9 with P2b/P2c, B1-B8, O1-O4) and the I3 itest
  check go red under the revert named beside it, and green on restore. Both outputs are reported per
  test. R488's red-checks for 3.6, 3.7 and 3.9 are re-run once and still go red.
- U3. No `.snap` file changes. `bun scripts/generate-schemas.ts` produces no diff.

## Decision rule

- Any verdict or `killingTest` difference on either run: BLOCK, never "close enough".
- F3, F4, N3 or N4 not met (wrong prefix, missing line, two lines, a line on a server leg, a vacuous
  cli-default hook): BLOCK. The selector did not engage as designed, even if the verdicts agree.
- **Run F or run N fails for any other reason:** re-run the same command, same binary, on
  `97d295c7` without the R551 change (the itest's I3 hook is part of R551, so the base run is judged
  only on the gate's existing checks). If the base run fails identically, the failure predates R551:
  file it as its own roadmap item and report it; R551 stays blocked until the run passes or the
  owner rules. If the base run passes, BLOCK on R551.
- A probe time above the F3/N3 bound with every other prediction met: report it; not a block.
