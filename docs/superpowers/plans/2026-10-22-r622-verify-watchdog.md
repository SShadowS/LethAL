# R-622 plan: R622 (a hung verify) and R616 (timeouts under load)

Evidence: `/coord/handoff/R-622/repro.md`. Short version: R622 did not reproduce in 20 full
verifies (load up to 49), 500 runs of the file alone, or about 6000 forced timeouts in its spawn
path. The kept log shows bun's per-test timeout fired with a live child in the R359 test (that is
the only thing that prints `killed 1 dangling process`, measured), and then the worker spun instead
of reporting. That points at Bun 1.4.2, not at our code. So R622 gets a watchdog, and stays open
with the evidence.

Two commits on one branch (`lethal/r622`): first R622's watchdog, then R616's P rule.

## Part A. R622: a per-file wall-clock watchdog in verify.ts

### What it does
- verify.ts makes a fresh heartbeat dir per run (`mkdtemp`) and passes it to the `bun test` child as
  `LETHAL_VERIFY_HEARTBEAT_DIR`.
- The preload (`scripts/test-preload.ts`) writes one small file per process, `<dir>/<pid>`, holding
  `<start ms>\t<process.ppid>\t<Bun.main>`. It writes it at load time and again in `beforeEach` when
  `Bun.main` changes (the preload already tracks that). Its `afterAll` deletes it. Without the
  variable (a plain `bun test`) it does nothing.
  - Measured (probe p6): under `--parallel` the preload runs once per file, and at load time
    `Bun.main` already names that file. So a file stuck while loading, or in a `beforeAll`, is named
    too.
  - Serial (P=1, as on CI): the preload loads once, so only the `beforeEach` update names later
    files. A file stuck before its first test is then reported as "after <previous file>". That is
    a known limit; the message says so.
- The test step stops using `Bun.spawnSync` for the `bun test` child. It uses `Bun.spawn` and awaits
  it, and polls the heartbeat dir every second. (This makes `exec`, `testStep` and `runVerify`
  async. It is mechanical: about 33 call sites in `scripts/verify.test.ts` gain an `await`.)
- **The limit: 120 s per file.** The slowest healthy file measured 17.6 s at P=8 under load 44
  (orchestrator.test.ts); the next was 5.1 s. 120 s is about 7 times the slowest, so a healthy file
  under heavier load, or on the slower Windows CI, never reaches it. A 10-minute hang now costs 2
  minutes. This is a wall-clock limit on a whole file. No test timeout changes. The override
  `LETHAL_VERIFY_FILE_LIMIT_S` (a whole number of at least 1) exists for the unit test.
- **Which process it kills, and only that one.** A heartbeat older than the limit is stuck when its
  process is alive and its recorded parent is the `bun test` child verify started (parallel: a
  worker), or it IS that child (serial). On Linux it also checks `/proc/<pid>/stat`'s parent before
  the kill, so a reused pid is never hit. It sends SIGTERM to that one pid. It never signals anything
  else. A pid it did not start cannot have written into this run's private dir.
- **What the output says.** Under `--parallel`, bun itself then prints
  `✗ <file> (worker crashed: SIGTERM)` and goes on with the other files. verify already reads that
  line (R622's log proves it). verify adds one line of its own, and the run FAILS even if bun's line
  is missing:
  `watchdog: FAIL, packages/runner/tests/real-home-guard.test.ts ran over 120 s in worker <pid>
  (stuck without yielding, so bun's per-test timeout could not fire); killed that worker. R622.`
  Serial: the killed process is the whole run, so this line is the only report, and it says so.
- Not covered (skipped on purpose): a hang in bun's coordinator itself, after all files are done. If
  that is ever seen, add a whole-run limit then.

### Test-first (in `scripts/verify.test.ts`)
1. Pure function `stuckWorkers(heartbeats, now, limitMs, childPid)`: an old heartbeat whose parent is
   the child is returned; a fresh one is not; one whose parent is another pid is not; the child's own
   heartbeat (serial) is. One test per case.
2. The real thing, spawned: a temp dir with a `bunfig.toml` that preloads the repo's
   `scripts/test-preload.ts` by absolute path, `ok.test.ts`, and `spin.test.ts` (a synchronous busy
   loop that ends ITSELF after 25 s, so nothing can hang for long). Run the exported test-step runner
   on it with P=2 and `LETHAL_VERIFY_FILE_LIMIT_S=2`. Assert: it ends in under 15 s, it fails, the
   output has the `watchdog: FAIL, spin.test.ts ran over 2 s` line, and `ok.test.ts` passed. This
   test's own timeout is 40 s (a new test; no existing timeout changes).
3. The same at P=1 (serial): it fails within 15 s and the watchdog line names the file.

### Red checks (each reported red, then restored green)
- Disable the kill (the watchdog only logs): test 2 goes red. The run lasts the 25 s of the spin, and
  the "under 15 s" assertion fails.
- Remove the preload's heartbeat write: test 2 goes red. Nothing is named and nothing is killed.
- Drop the parent check in `stuckWorkers`: the "other parent" case in test 1 goes red.

### Docs
- R622 stays **open**: "watchdog landed (<commit>); root cause not reproduced, see
  /coord/handoff/R-622/repro.md". Add a line to CLAUDE.md step 3 (verify.ts now fails a file that
  runs over 120 s and names it), and update verify.ts's header comment.

### Optional, a separate small change (say yes or no)
Bun's recursive `readdirSync` follows directory symlinks, unlike Node (measured, probe p7). Two
links forming a cycle under `scripts/` or `packages/*/tests|src` (for example in a lane's gitignored
scratch dir) would hang the two R409 walks in real-home-guard.test.ts forever. Swapping them for a
walk that skips symlinks (the pattern `discoverTestFiles` in verify.ts already uses) is about ten
lines. The watchdog makes this a named 2-minute failure anyway, so it is not urgent. I would file it as
its own roadmap item rather than fold it in.

## Part B. R616: P from load and heavy jobs

### The rule (a pure function)
`chooseParallelism({ env, cores, load1, heavy }) -> { p, why }`
1. `LETHAL_VERIFY_PARALLEL` wins, as today. Then CI or GITHUB_ACTIONS gives 1, as today.
2. Otherwise P = max(1, min(base, byLoad, byHeavy)), where:
   - `base` = min(8, floor(cores / 4)), today's rule;
   - `byLoad` = floor((cores − load1) / 4): about 4 cores per worker of the cores that are free now.
     `load1` is `os.loadavg()[0]`. On Windows it is 0, so this term changes nothing there;
   - `byHeavy` = 8 with no heavy job, 4 with one, 2 with two or more.
3. `heavy` = the heavy slots held in `/coord/locks` (or `LETHAL_HEAVY_LOCK_DIR`), plus the heavy jobs
   that hold no slot. This REUSES `slotHeld`, `parsePs` and `heavyVerdict` from
   `scripts/corpus-snapshot.ts` (the `isHeavy` scan R616 names). If importing that script drags in too
   much, move those helpers to `scripts/lib/heavy.ts`. With no lock dir and no `ps` (Windows), heavy = 0.

Why both terms. R616's failure was at P=8, load 9.6, two heavy jobs. The load term alone gives 5
there; the heavy term gives 2. My runs add a second fact: a pure-CPU load of 48 did NOT break P=8
(15 passes). So load is a weak signal, and the measured trigger is the heavy jobs, which also use
memory and disk. The load term stays as a backstop for a box that is busy for other reasons.
Never raise a timeout.

### The receipt
The first line already prints the reason. It becomes, for example:
`verify mode: FULL (all test files, --parallel=2; P from min(8, 32 cores / 4)=8, load 9.6 -> 5,
2 heavy jobs (heavy.1 held, 1 unslotted: <args>) -> 2)`.
The last line (`VERIFY FULL: ...`) also gets `P=2`, so a pasted receipt shows it.

### Unit tests, with one red check per direction
- High load lowers P: cores 32, load 30 gives 1; load 9.6 gives 5.
- Low load keeps P: cores 32, load 0.5 gives 8.
- Heavy jobs lower P: 1 gives 4, 2 gives 2, 3 gives 2.
- None keeps P: heavy 0 and load 0 gives 8.
- The override and CI still win: `LETHAL_VERIFY_PARALLEL=8` with load 30 and 2 heavy jobs gives 8.
- The `why` text names each term that lowered P.
- Red checks: delete the load term, and "high load lowers P" goes red. Make the rule return 1
  always, and "low load keeps 8" goes red. The same pair for the heavy term.

### The proof (R616's step 3)
- First, show that the failure can happen at all: at least 3 runs of `LETHAL_VERIFY_PARALLEL=8 bun
  scripts/verify.ts` beside two heavy jobs. If P=8 never fails there, the 10 green runs below prove
  nothing. Say so in the record, and do not claim R616 is closed by that proof.
- Then 10 full `bun scripts/verify.ts` runs at the chosen P, beside the same two heavy jobs: zero
  timeouts, every receipt with its P and reason. Plus 10 runs of the two named files
  (`publish-ceiling.test.ts`, `resume.test.ts`) at that P.

**Question for the orchestrator or owner (the heavy-job limit).** The owner allows two heavy jobs
container-wide. The proof needs two heavy jobs PLUS the verify. My reading: a unit verify is not a
heavy job (it never took a slot, and it runs for 20 s to 2 min), so "two heavy jobs in heavy.1 and
heavy.2, verify unslotted" stays within the rule. Two ways to get the heavy jobs:
- (a) Wait for two REAL heavy jobs from other lanes (corpus dumps, al-runner legs) and run beside
  them. This matches R616's conditions. Preferred, because a pure-CPU burner did not trigger R616 at
  load 48.
- (b) Two synthetic burners of my own in heavy.1 and heavy.2 (CPU plus memory and disk churn), for
  about 20 minutes. This blocks every other lane's heavy job for that time.
Which one? If (b), please confirm that holding both slots for about 20 minutes is fine.

## Size
- Part A: about 120 lines (the watchdog and its pure function in verify.ts, about 10 in the preload,
  the async ripple through verify.test.ts, three new tests). Half a day with the red checks.
- Part B: about 50 lines plus 6 tests. Two hours, plus the proof runs: 13 verifies and 10 file runs,
  about 1 hour of wall clock, more if it waits for real heavy jobs.
- Overall: medium, about one working day, one branch, two commits. CI: both jobs (the Windows
  `check` and `unit-linux`) must be green.

## r2: rulings and plan-review fixes (2026-10-22). These override anything above.

**Orchestrator rulings.**
- Build Part A (the watchdog). R622 stays OPEN with the evidence (not reproduced; likeliest a Bun
  1.4.2 fault).
- Part B is NOT built on faith. Option (1) only: no synthetic burners in the heavy slots. A bounded
  attempt shows P=8 failing under REAL load (`/coord/handoff/R-622/r616/attempt.sh`: a full verify
  only while two heavy slots are held by other lanes, read from `ps`; at most 10 runs or 4 h).
  - If one fails: build Part B with that run as its proof, and apply review I4 and I5.
  - If none fail: close R616 by ruling, with the measurements.

**Review fixes for Part A** (`review-opus-plan.md`).
- **I1 (pipe deadlock):** drain the child's stdout and stderr at the same time as awaiting its
  exit, never after.
- **I2 (inner-run leak):** the watchdog tests give the inner verify run its own TMPDIR and remove
  it, so a killed inner worker's `lethal-unit-run-*` folder cannot fail the outer run's R358 check.
- **I3 (Windows):**
  - spawn `process.execPath`, not `bun` (a shim pid would never match);
  - the watchdog tests must RUN on the Windows `check` job, not be skipped;
  - before the limit is fixed, read serial per-file times from a Windows CI junit, and keep 120 s
    only if it is still at least 5 times the slowest file there.
- **Minor:** the message says "ran over 120 s" (a slow but healthy file also matches); it never
  says "stuck without yielding".
