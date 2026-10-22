# R-616 plan (2026-10-22)

Evidence: `/coord/handoff/R-616/measure.md`. Short version: the timeouts are fsync waits on the shared disk.
Two verifies at once never failed alone (0 of 8 here, 0 of 20 in R-622). Under disk writes they failed every
time, at P=8 AND at P=4, and with one verify too. Scratch DBs on /dev/shm (tmpfs, a RAM disk) stayed under 80 ms
under the same load. So the fix is where the DBs live, not how many workers run.

## Recommendation
1. **Do: scratch test DBs on /dev/shm** (main fix, below).
2. **Do not build the shared worker budget for R-616.** The measurement gives it no support: P=4 failed as often
   as P=8 (15/12/7/9 fails vs 4/2/12/8). If the owner still wants it, the cheapest form is in section B.
3. Never raise a timeout. Production `lethal.sqlite` stores stay on disk (they hold resume and lend history).

## A. Scratch test DBs on /dev/shm

**What changes.**
- `scripts/test-preload.ts`: make one DB directory per test process.
  - Use `/dev/shm/lethal-unit-db-<pid>-XXXX` when `/dev/shm` is a directory, is writable, and has at least
    16 MB free (`statfsSync`). Otherwise use `<runDir>/db` on disk.
  - Export it as `LETHAL_TEST_DB_DIR`, and the reason as `LETHAL_TEST_DB_DIR_WHY`
    (`tmpfs` / `fallback: /dev/shm missing` / `fallback: /dev/shm has N MB free` / `fallback: not writable` /
    `fallback: LETHAL_TEST_DB_ON_DISK=1`).
  - Remove it in the preload's `afterAll`, like `runDir`.
  - Sweep stale ones at start: remove `/dev/shm/lethal-unit-db-<pid>-*` whose pid is dead. Why: a killed
    worker (the R622 watchdog kills workers) skips `afterAll`, and 64 MB is shared by every lane.
  - The choice is one pure exported function, `chooseDbDir(facts)`, so it is testable without a real /dev/shm.
- One helper, `testDbPath(name)` (in `packages/runner/tests/helpers/`), returns a fresh
  `mkdtemp(LETHAL_TEST_DB_DIR)/name`. It THROWS when the variable is missing (the preload did not load); it never
  falls back silently.
- The 9 files (store, resume, orchestrator, cli, cli-envtool, publish-ceiling, runner-provenance, r474-context,
  scripts/store-query): build only the `.sqlite` path with `testDbPath`. Project folders and artifacts stay in
  `tmpdir()`: they are MBs (orchestrator 39 MB, resume 15 MB) and would fill 64 MB. The DBs are KB-sized.
  - A CLI test that does not test the default path passes `--db testDbPath(...)`. A test that IS about the
    default `<project>/lethal.sqlite` (R358's run-then-verify) keeps it on disk, named in a comment.
- `scripts/verify.ts`: the receipt gets one line from the same `chooseDbDir`, for example
  `test DBs: /dev/shm (tmpfs)` or `test DBs: on disk (fallback: /dev/shm missing)`.
- Windows (CI `check`) and macOS have no /dev/shm: they take the named fallback, which is today's behaviour.
  CI is serial (P=1) anyway.

**Why tmpfs and not `synchronous=OFF` in tests.**
- OFF would need a test-only switch in production code (`ResultsStore` reads an env var): one mistake and a
  real store loses its fsync. tmpfs changes no production code.
- OFF does not cover the legacy builders (raw `new Database(path)`, DELETE journal): each needs its own pragma,
  and creating/deleting the journal file still syncs the directory. tmpfs covers every fsync at once.
- Risk of tmpfs: the 64 MB fills. Mitigated by DBs only, the 16 MB free check, and the stale sweep. A full
  /dev/shm gives `SQLITE_FULL` in a test, a loud failure, not a wrong pass.
- Risk: a test meant to prove on-disk behaviour (WAL files, a real rename) now runs on tmpfs. None of the 65
  fsync-bound tests checks durability; the review must confirm that per file.

**Tests first.**
1. `chooseDbDir` (pure): shm ok gives tmpfs; missing, under 16 MB, not writable, and the opt-out each give the
   fallback WITH its reason. One case per direction.
2. The preload, in a child `bun test` (like `real-home-guard.test.ts`): on Linux with /dev/shm the child sees
   `LETHAL_TEST_DB_DIR` under /dev/shm and the dir is gone after; with `LETHAL_TEST_DB_ON_DISK=1` it is under the
   child's tmp. Skip the first case by name where /dev/shm is missing.
3. The stale sweep: a dir with a dead pid is removed; a dir with a live pid (the test's own) is kept.
4. `testDbPath`: under the dir, distinct per call; throws when the variable is missing.
5. verify's receipt line: both texts.

**Red checks, one per direction.** Make `chooseDbDir` always return disk: test 1's tmpfs case goes red. Make it
always return tmpfs: the missing and low-free cases go red. Drop the sweep's pid check: the live-pid case goes
red. Drop the sweep: the dead-pid case goes red. Make `testDbPath` fall back instead of throwing: test 4 goes red.

**The proof (I5 method; it must be able to fail).** Same load as measure.md: 3 disk writers, two full verifies
at P=8, 7 s apart. The 65 fsync-bound tests (`probe/jcmp.ts`, list fixed from the disk-vs-tmpfs baseline).
- Before (master): expected >0 tests over 5000 ms (4 of 4 verifies failed in the measurement).
- After: 5 pairs (10 verifies), zero over 5000 ms and max under 2500 ms.
- Control arm on the after-branch with `LETHAL_TEST_DB_ON_DISK=1`: must fail again like master. If it does not,
  the writers did not load the disk that day and the proof is void, not passed.
- Plus 2 pairs without writers, to show no slowdown in the quiet case.

## B. The shared worker budget (only if the owner still wants it)
Not supported by the measurement; it would not have prevented any failure seen here. If wanted anyway:
- Reuse the ledger, no flock. The ledger already counts verifies running at START (`countOverlaps`), works on
  Windows (one O_APPEND write), and handles crashed runs (pid alive and under 15 min). P =
  `max(2, floor(base / (n + 1)))`, where n is the START count; base stays `min(8, cores/4)`.
  An explicit `LETHAL_VERIFY_PARALLEL` and CI's serial rule still win.
- Race: two starts in the same instant may both see each other (both get 4) or one may miss the other (8 and 4).
  Both are safe; neither fails a run. flock would make the claim exact, but costs a holder process per verify
  (Bun has no flock call; corpus-snapshot re-execs under `flock(1)`), and `flock(1)` is absent on Windows.
- A ledger that cannot be read: P = the floor 2, and the receipt says
  `P=2 (ledger unavailable: <error>)`. The receipt always names the overlap: `P=4 (1 other verify running)`.
- Tests: the pure P function for n = 0..4 (8, 4, 2, 2, 2) and base 6; the floor; the ledger error giving the floor
  and the named reason. Red checks: remove the division (n=1 goes red), remove the floor (n=4 gives 1, red),
  ignore the error (unavailable case red).
- A verify never waits for a slot and never fails for one.

## Size
- A: preload about 40 lines, helper 15, verify 10, new tests about 120, and about 60 to 80 mechanical
  path edits in 9 test files. About one lane-day including the live proof (about 15 minutes of runs).
- B (optional): about 30 lines and 60 lines of tests, half a day.

## Open questions for the owner
- Accept dropping B, given P=4 was no better?
- A bigger tmpfs for the whole test temp folder (the host side) would also cover the 4 non-SQLite hook
  failures (mkdtemp/rm under load), but one full verify needs more than 64 MB there; A needs no host change.

## r2: orchestrator ruling and plan-review fixes (2026-10-22). These override anything above.

**Ruling:**
- TMPFS (option A) only. Option B (the shared worker budget) is DROPPED entirely: the measurement shows it cannot
  help.
- Production `lethal.sqlite` stays on disk. `synchronous=OFF` stays rejected.
- The proof is void unless the on-disk control arm fails again.
- Any test that depends on real disk semantics (fsync, rename atomicity, durability) is kept on disk deliberately and
  named. The review found NONE: no test proves durability; the R449 pragma and WAL reader-checkpoint tests behave
  the same on tmpfs.

**Review fixes** (`review-opus-plan.md`):
- **B1:** `cli.test.ts`'s `runThenArtifact` block (an explicit `dbPath = join(root, "lethal.sqlite")` in a scratch
  root, not the project's default store) MOVES to `testDbPath`. It holds R358's "verify reads the installed batch's
  files…", one of the two 08:58Z failures, and about 7 of the 11 slow cli tests. Nothing in the 9 files stays on
  disk unless a test truly needs a disk path, and each such test is named.
- **I2:** the proof scores the named 65 tests AND requires 0 failed tests across EVERY after-run verify. The
  evidence tests are named in the proof. If non-DB hook timeouts (mkdtemp, rm) still fail there, the result is
  reported as it is, not hidden.
- **I3:** verify writes `/proc/pressure/io` and `/proc/pressure/cpu` (avg10, where readable; skipped and named
  where not, e.g. on Windows) into its receipt and the ledger. Then the next unexplained timeout (like 05:33Z's R373
  at 7116 ms on a `:memory:` store) can be diagnosed. R616 stays OPEN after this lands if the 05:33Z outliers stay
  unexplained; this task does not close R616 on the 65-test list alone.
- **Minors:**
  - each worker records where its DBs went, and the receipt aggregates it, or the line is labelled "at start";
  - the proof records peak /dev/shm use, including the cli and orchestrator stores that keep bundles;
  - the 16 MB check is a fast path only (SQLITE_FULL still fails loudly);
  - the plan states that R358's leak check no longer sees the DB folders, because afterAll and the dead-worker
    sweep remove them.
