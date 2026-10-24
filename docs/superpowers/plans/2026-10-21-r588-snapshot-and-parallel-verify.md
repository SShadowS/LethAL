# R-588 plan r3 — fixes N1 to N5 of adversary-r2 (roadmap R593)

> Superseded by R724 (2026-10-24): the heavy-job guard refusal now exits 75, not 2. Permanent refusals still exit 2. flock's own "slot busy" code is now 111, not 75, so the plan's `flock -n -E 75` below reads `-E 111` today.

## Amendment (orchestrator, 2026-10-21, during the build): verify.ts exit codes
| exit | verify.ts |
|---|---|
| 0 | FULL run, every test passed (the only 0) |
| 4 | PARTIAL run (`--changed`, package names), every test passed; the receipt reads `VERIFY PARTIAL: PASS, exit 4` |
| 1 | any failure, full or partial |
| 2 | refused arguments (unknown flag or package, partial or snapshot opt-out under CI) |

Reason: push and merge chains run `verify && git push`, so a partial pass that exits 0 would let a push
through. R-587's partial gates exit 4 too. Pinned in verify.test.ts (`exit codes: ...`), red-checked in
three directions: partial pass returning 0, full pass returning 4, partial failure returning 4.
`corpus-snapshot.ts` keeps its own table (0 / 1 / 2) below.

Base: plan.r2.md, which rests on plan.r1.md. Everything r2 says holds unless a section below replaces it.
No full-suite runs were made for r3.

## N1. A7 can go red
A7 spawns its child `bun test --parallel=2` with an EXPLICIT env built from scratch:
`HOME = USERPROFILE = S` and `TMPDIR = TEMP = TMP = T`, where S and T are fresh sentinel dirs; `PATH` is
kept, and every `LETHAL_TEST_*` variable is removed. Each of the three child files asserts
`process.env.HOME !== S`, `homedir() !== S`, `process.env.USERPROFILE !== S`, `process.env.TMPDIR !== T`
and `process.env.LETHAL_TEST_REAL_HOME === S`. With the preload, all three pass. RED CHECK: drop the preload
line from the temp `bunfig.toml` -> all three files fail, and A7 asserts that each of the three fails by
name. The env is built by a small exported helper (`sentinelEnv(base, S, T)`), and A7 also asserts its
output contains no `LETHAL_TEST_*` key. Then an inherited fake can never make the red check pass.

## N2. Only the dumper keys an entry
- The reuse and `diff` checks hash ONLY `scripts/prod-identity-keys.ts` (sha256 of its bytes). That hash and a
  `format` number go into `dumperKey = sha256(format + "\n" + fileHash).slice(0, 16)`. Neither
  `corpus-snapshot.ts` nor the bun version is hashed. The bun version is still recorded in the
  manifest, for information only.
- Layout becomes `/coord/cache/dumps/<B>/<set>/<dumperKey>/{<n>.jsonl, projects.tsv, manifest.json, DONE}`.
  A different dumper writes BESIDE an existing entry, never over it, so no entry blocks a sha. The
  exclusive-mkdir lock and DONE-last move to that directory, unchanged otherwise.
- `snapshot` step 2 (`cached`) and step 3 (reuse) look only at entries whose `dumperKey` equals the
  invoking checkout's. `diff` takes the master entry with the branch's `dumperKey`; when there is none it
  refuses (exit 2) and names the keys that DO exist at that sha.
- The legacy `15c3a620` entry has no key. It stays readable only through `diff --legacy-master`, as in r2.
- The generation rule drops `scripts/corpus-snapshot.ts`, because the dumper hash now covers what generates
  keys. It keeps `scripts/prod-identity-keys.ts`.
- B8 is replaced. Equal `dumperKey` -> `cached`/reuse. A changed dumper -> a NEW entry directory is written
  beside the old one, which stays byte-identical. A changed `corpus-snapshot.ts` alone -> the same key, so
  `cached`. RED CHECK each way: fold `corpus-snapshot.ts` into the key -> the third case goes red; drop the
  key from the path -> the second case goes red (the existing-entry refusal fires).

## N3. Slots held by the kernel (flock)
- Two lock files, `/coord/locks/heavy.1` and `/coord/locks/heavy.2`. Before any work, the tool re-execs
  itself as `flock -n -E 75 /coord/locks/heavy.<n> bun scripts/corpus-snapshot.ts <same args>
  --in-slot <n>`, trying slot 1 and then slot 2. If both return 75, it refuses (exit 2,
  "two heavy slots held"). It writes its pid into the lock file for display only; nothing reads that pid
  to decide anything.
- The flocked fd is inherited by every child, which is measured: after the `flock` parent exits, a backgrounded
  child still holds the lock, and the lock frees when that child exits. So the lock lasts as long as the
  last project child. SIGKILL needs no cleanup, and there is no reclaim step and no pid-reuse question.
- The ps scan for jobs that take no slot stays as r2 says, with two changes. It excludes the DESCENDANTS of
  the pid written in each held slot file and its own ancestors and descendants, instead of excluding
  "pgids recorded in a slot". And it still counts distinct pgids among what is left. Foreign pgids plus held
  slots `>= 2` -> refuse.
- Known limit, stated in the runbook line: two corpus jobs started from ONE non-interactive shell
  (`a & b`) share a pgid and count as one. So does a job on a corpus COPY, which the scan cannot see by
  path. Both should take a slot themselves: `flock -n /coord/locks/heavy.<n> <cmd>`.
- B5 now uses real `flock` on temp lock files, and a fake `ps` for the scan. Cases: both slots held by
  live `flock … sleep` -> refuse; a slot whose holder was SIGKILLed -> free at once; a slot held only by an
  orphaned child of a killed holder -> still held. RED CHECK: try `-n` on one slot only -> the case
  "slot 1 busy, slot 2 free" refuses wrongly and goes red; ignore slot 2's 75 -> the both-held case goes
  red. The r2 ps cases (ancestor wrapper, timeout+bun pair, threshold) are kept.

## N4. The file-set check uses bun's discovery rule
- The expected set is computed the way bun discovers tests, not through git. The tool walks the repo root
  with `readdirSync` and skips `node_modules` and every dot-directory, which is bun's measured rule
  (gitignored NON-dot dirs are walked). It matches bun's name patterns:
  `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*`, for `ts|tsx|js|jsx|mts|cts|mjs|cjs`. `packages/*/dist` is
  already deleted at that point.
- On a mismatch the full run fails, naming both counts and up to 20 paths each way. The paths bun ran come
  from the junit report's `file=` attributes, so verify's own bun child writes junit to a temp file as well.
- Test A8, on a temp tree: a `*.spec.ts`, a test under a gitignored `build/`, a test under `.hidden/` and a
  zero-test file -> expected = 3 (`.hidden` is skipped), equal to what a real `bun test` reports there.
  So A8 is the check against bun itself, not against our own reading of its rule.

## N5. How a Windows-parallel decision would run
Precedence for P, pinned by A4:
1. `LETHAL_VERIFY_PARALLEL` set explicitly -> that value, under CI or not.
2. else `CI` or `GITHUB_ACTIONS` set -> 1.
3. else `min(8, floor(cores / 4))`.

So if the r2 rule sends Windows parallel, ci.yml's `check` job changes its step to
`bun scripts/verify.ts` with `env: LETHAL_VERIFY_PARALLEL: <n>`, never to a bare
`bun test --parallel`. It then keeps the snapshot belt, crash naming and the file-set check. A4 cases:
CI alone -> 1; CI + explicit 4 -> 4; neither -> the cores rule. RED CHECK: swap rules 1 and 2 -> the
"CI + explicit" case goes red. As r2 says, under the default no CI job runs the parallel path for real. The
measurement push is the one CI run that does.


---

# R-588 plan r2 — fixes to adversary-r1, finding by finding (roadmap R593)

Base: plan.r1.md. Anything r1 says that this file does not change still holds. Orchestrator rulings
applied: a parallel FULL verify is in scope; `--changed` is a labelled PARTIAL mode that refuses under CI;
equivalence must be PROVEN; measure the Windows CI job before choosing; older-sha reuse agreed; item 4 skipped.

New measurements since r1, all small and with no full-suite run (live BC gates are running):
- **bun 1.4.2 probe** (temp project, `--parallel=2 --reporter=junit --reporter-outfile`): junit gives one
  `<testcase name=… file=…>` per test under `--parallel`. A file whose worker is SIGKILLed is reported as
  `✗ c.test.ts (worker crashed: SIGKILL)` and as a junit testcase named `(worker crashed)`. Its tests that
  had already passed are LOST from ` N pass` (3 passed, `2 pass` printed). `Ran 5 tests across 3 files`
  still counts the crashed file.
- **CI step times** (gh run 39627867963, master, green): Windows `check` takes 6 min 07 s, of which `Unit tests`
  (serial `bun test`) is 110 s. `unit-linux` takes 3 min 23 s, of which `verify.ts` is 58 s. The Windows job sets the
  wall clock; Linux finishes 2 min 44 s earlier.

## Must-fix

### 1. `test (all)` printed on a `--changed` run
Fix: `testStep(mode, paths, io)` takes the mode; the scope text comes from it: `all` only for `full`,
`changed since <sha>` or `packages: a b` otherwise. `main` becomes `runVerify(argv, io)` with exec,
env, clock and log injected and returns every line it would print. **A2 now asserts over ALL lines** of
`runVerify` (typecheck, clean, testStep, receipt) for each partial mode (`--changed`, `--changed=<ref>`,
one package, two packages): no line contains `test (all)` or `VERIFY FULL`; the full mode's lines contain
both. RED CHECK: restore `paths.length === 0 ? "all"` -> the `--changed` case goes red. Other direction:
make the full scope `changed` -> the full case goes red.

### 2. Equivalence asserted, not proven (ruling 3)
**(a) Per-test-name equivalence.** New committed tool `scripts/verify-equivalence.ts`:
`bun scripts/verify-equivalence.ts --serial <k> --parallel <n> --p <P> --out /coord/handoff/R-588/equiv/`.
Each run is `CI=true bun test [--parallel=P] --reporter=junit --reporter-outfile=<run>.xml`, after one
typecheck and dist clean. It parses each XML into a multiset of `(file, classname, name, status)` and
diffs every run against serial run 1. Output per run: pass/fail/skip counts, test-file count, and the
names that differ, by file. Exit 0 only if every run has the same multiset as serial run 1. Measurement plan,
run ONLY after the orchestrator says no live gate is running: `--serial 3 --parallel 10 --p 8`, then
the same at the chosen P under typical load (other lanes' unit runs, no live gate). Unit tests for the
parser and diff use hand-written junit XML: a missing test, an extra one, a status change, and a
`(worker crashed)` case each give a named difference.
**(b) R264 and R393 in every worker.** Already measured by the reviewer: under `--parallel`
(which implies `--isolate`) the preload runs once per FILE, and `CI=true` reaches the workers. New spawn
test in `scripts/verify.test.ts` (A7): a temp project with a copy of the repo's `bunfig.toml` preload
line pointing at `scripts/test-preload.ts`, and three test files. Each file asserts that `homedir()`,
`HOME`, `USERPROFILE` and `TMPDIR` are the fake ones and that `LETHAL_TEST_REAL_HOME` holds the real
home. It runs under `--parallel=2`; all three must pass. RED CHECK: drop the preload line from the temp
`bunfig.toml` -> all three files go red, BY NAME (the test asserts that it fails in all three, not only in
one). The snapshot half is A5 (finding 3). Windows: A7 runs in the Windows `check` job too. That job is the
measurement of `USERPROFILE` per file there; it is not claimed before that run is green.
**(c) Flake rate.** The 10 parallel runs in (a) are the flake measurement, recorded in
`/coord/handoff/R-588/equiv/summary.md` with the load at the time (`uptime`, other bun/al-runner
processes). Any timeout -> lower P and re-run the 10. A test timeout is never raised.
**P and other lanes.** `P = LETHAL_VERIFY_PARALLEL ?? min(8, floor(cores / 4))`. That is 8 on this
32-core container and 1 (serial) on a 4-core machine. verify prints the P it used. Before the build is
submitted: one `itest:hang` run with a parallel verify started next to it, against its frozen baseline.
That run is planned, not done; it needs the orchestrator's go and a free Cronus slot. If it shows any
change, P drops to 4 and the run is repeated.
**Full-run completeness (r1's open question, now YES).** A full run must also print
`Ran N tests across M files` with M equal to bun's own discovery count. bun has no dry-run, so the expected M is
`git ls-files '*.test.ts'` plus untracked ones from `git ls-files --others --exclude-standard '*.test.ts'`
(dist is already deleted at that point). Measured today: 388 tracked = bun's 388. A mismatch fails the full run, naming both numbers.
A partial run prints M and does not check it.

### 3. A5 predicted the wrong thing
Fixed per the measurement: A5 runs the same temp fixture (one test with a new `toMatchSnapshot()`)
SERIAL and `--parallel=2`, both under `testChildEnv`. In BOTH runs the test fails with bun's
`Snapshot creation is disabled in CI` text, and the `.snap` file, if one is written, contains no `exports[`.
Same outcome both ways = the guard holds in workers. The header-only `.snap` bun writes is untracked in the
repo, and the existing belt (`git status --porcelain -- '*.snap'`) already fails verify on it; A5's comment says so.
RED CHECK: give the fixture child env no `CI` -> both runs write an `exports[` entry and A5 goes red.

### 5. `fixtures` set reused across fixture edits
For in-repo sets, `corpusHead := git rev-parse <sha>:fixtures` (the tree hash), recorded in the
manifest. Reuse requires it to be equal, so any change under `fixtures/` between A and B forces a dump.
B3b test: in a temp repo, B changes only `fixtures/x/a.al` -> no reuse for `fixtures`, and reuse still
happens for an external set (the other direction). RED CHECK: leave `corpusHead` undefined for
`fixtures` -> B3b goes red.

### 6. The dumper that ran is not recorded
The manifest records `sha256` of `scripts/prod-identity-keys.ts` and `scripts/corpus-snapshot.ts` as
run, plus `bun --version`. Reuse requires all three to equal the invoking checkout's. `diff` refuses
(exit 2) when the master entry's script hashes differ from the branch run's, naming the file. A
legacy entry (no manifest) can never be reused. It is accepted by `diff` only with `--legacy-master`,
and the report then says `dumper unrecorded`. Test B8 covers the two directions: equal hashes -> reuse, a
changed `prod-identity-keys.ts` -> refusal naming it. RED CHECK: skip the hash compare -> the refusal
case goes red.

### 7. Projects matched by index
`diff` joins master and branch dumps by project path RELATIVE to the set's corpus root. For `fixtures`,
the absolute roots differ between the archive tree and the worktree, which makes the relative key
necessary. A path on one side only is listed by name as `only in master` or `only in branch` and is
never diffed. `diff` refuses (exit 2) when either side has an `{error}` project (named), and refuses
"identical" when the total key count is 0 on both sides. B6b test: a branch with one project inserted
before the others in sort order -> the others report 0 change, and the new one is listed by name. RED CHECK:
join by index -> B6b goes red. Empty-vs-empty -> refusal. RED CHECK: drop it -> exit 0, red.

### 8. Heavy-job guard undercounts and races
Two mechanisms, both held for the whole run:
- **Slots.** Before any work (archive, `cp -al`, install, parser build, projects), the tool takes one of
  `/coord/locks/heavy/1` or `/coord/locks/heavy/2` with an exclusive `mkdir`, and writes
  `{pid, pgid, cmd, started}` inside. A slot whose pid is dead is stale: it is removed, and the removal is
  printed. If no slot is free, the tool refuses (exit 4). The slot is released in `finally` and on
  SIGINT/SIGTERM.
- **ps scan for jobs that take no slot.** The scan counts DISTINCT process groups (pgid) with a process
  whose argv contains a corpus root. It excludes its own pgid, its ancestors (the ppid chain) and any pgid
  already recorded in a slot. `timeout`+`bun` pairs and `bash -c` wrappers share a pgid, so they count as one.
  Slots taken plus foreign pgids `>= 2` -> refuse.
- Known limit, stated in the runbook line: a job on a corpus COPY (for example
  `/work/lethal-wt/cdo-r396`) is invisible to the ps scan. Such jobs are asked to take a slot by hand
  (`mkdir /coord/locks/heavy/<n>` with a pid file). No wrapper command is built (YAGNI).
- B5 cases: 0/1/2 foreign pgids; an ancestor `bash -c` wrapper whose argv names a corpus root (not
  counted); a `timeout`+`bun` pair (one); its own children (not counted); two slots held by live pids
  (refused); a slot held by a dead pid (reclaimed). RED CHECKS, one per direction: threshold `> 2` -> the
  two-job case goes red; counting processes instead of pgids -> the timeout+bun case goes red; not
  excluding ancestors -> the wrapper case goes red.

## Lesser findings

### 4. A worker crash fails with no name
`parseTestSummary` also reads `✗ <file> (worker crashed: <why>)` into `failing`, as
`<file> (worker crashed: <why>)`. A6's fixture is the probe's real output (above), including the crash
line and the lost pass. RED CHECK: drop the new regex -> A6 sees an empty failing list, red.

### 9. Branch dump cache
Taken: branch dumps go to a fresh `/coord/cache/tmp/branch-<pid>/`. They are deleted after the report,
including after a failure, and never cached or reused. `/coord/cache/branch/` is dropped from the layout.

### 10. CI parallel or serial, measured first
Measured above: the Windows test step is 110 s of a 6 min 07 s job, and the Linux job is not the long pole.
- **Default until measured:** CI stays serial. When `CI`/`GITHUB_ACTIONS` is set, verify.ts uses P=1 and
  says so. That also keeps one serial run of the POSIX-only tests (for example R-589's mode-600 test) on Linux.
- **Measurement (planned):** ONE CI run on lethal/r588 (a push without `[skip ci]`, after local green).
  For that run, `ci.yml` temporarily runs the unit step twice in each job: serial, then `--parallel=<runner
  cores>` through `verify-equivalence.ts --serial 1 --parallel 1`. That gives per-name equality on both OSes and
  both step times.
- **Decision rule, written into the plan now:** Windows goes parallel only if its step falls by 45 s or
  more AND the names are equal. Linux stays serial whatever the result: it saves no wall time, and it is
  the serial control. The temporary step is removed before submit, and the decision goes in R593's status note.

## Minor findings

- **Generation rule:** add `bunfig.toml` and `tsconfig*.json`. The bun version is recorded under (6).
  Grammar and `.node` staleness were checked by the reviewer and are covered.
- **`cp -al` node_modules:** link-copy the root `node_modules` AND every `packages/*/node_modules`. The
  workspace links are relative, so the copied ones resolve inside the new tree. If any project fails to
  load `@lethal/*`, the tool stops at the first project, so a broken tree does not waste a run.
- **Exit codes, one table for both subcommands:** 0 ok/identical, 1 different or a dump failure,
  2 refused (args, missing master entry, hash mismatch, error project, empty-vs-empty, existing entry),
  3 dropped. 4 also goes: a heavy-job refusal is a refusal, so it is exit 2, and the message names the
  guard. The DONE-entry refusal from r1 (exit 3) becomes exit 2.
- **`LETHAL_TEST_ALLOW_SNAPSHOT_CREATE=1`:** the full receipt then reads
  `VERIFY FULL: PASS (snapshot guard OFF)`, and verify refuses the variable under CI (exit 2).
  A2 covers both.
- **"affected projects":** still skipped, as reasoned in r1 (a generation change can touch any project).
  `--projects` and `--all` stand.

## Tests, updated list

A1 args; A2 all lines, every mode (finding 1); A3 CI refusal both ways; A4 command shape (P from the env/
cores rule, P=1 under CI); A5 snapshot guard serial+parallel (3); A6 crash line parsed (4); A7 R264
per worker (2b); verify-equivalence parser/diff units (2a).
B1 rule table (+bunfig, tsconfig); B2/B3 reuse both ways; B3b fixtures tree hash (5); B4 DONE never
overwritten, both ways; B5 heavy guard (8); B6 diff counts and no tuple text; B6b join by path, error and
empty refusals (7); B7 dumper on a fixture; B8 dumper hashes (6).
Every listed red check is run in the build and reported, red output and restored green.

## Expected time saved

Unchanged from r1 for the measured parts: local full verify 67.5 s -> about 18.5 s at P=8. That figure
is to be re-confirmed by the 10-run measurement under load. The master dump is free on 68 of 104 commits.
The CI saving is 0 to about 60 s, decided by the CI measurement.

## Order

1. Part A code and tests (no full-suite runs). 2. Part B code and tests. 3. On the orchestrator's go:
`verify-equivalence` 3 serial + 10 parallel, then the itest:hang co-run. 4. The CI measurement push,
then the decision. 5. Fixtures smoke for the snapshot tool. 6. Opus build review, CI, R593 done, submit.


---

# R-588 plan r1 — shared master-corpus snapshot tool, and a fast verify (roadmap R593)

Measurements: `/coord/handoff/R-588/measure.md`. Branch `lethal/r588` from master `1eb4dcf6`.
Two parts, one roadmap item. Item 4 (al-runner warm cache) is SKIPPED: not cheap (measure.md §c).

## The two measured facts that shape this plan

1. **The verify cost is the serial test step, not the typecheck.** Full verify 67.5 s = typecheck 1.2 s +
   `bun test` 66.3 s. runner is a dependent of every package, so a package-level "changed + dependents" run
   always includes runner + scripts (58.6 s): it would save 0-12% on 52 of the last 60 merges.
   **Bun 1.4.2 already ships `bun test --parallel=N` and `bun test --changed=<ref>`** (import graph, per file).
   Full suite with `--parallel=8`: 17.0 / 17.2 s, 8,539 pass / 8 skip / 0 fail, identical to serial
   (three parallel runs at 4/8/16, all green). Floor: `orchestrator.test.ts` alone is 14.3 s.
   `--changed` on r589's diff: 175 of 388 files, 46.4 s serial, 16.5 s parallel.
2. **A master dump is reusable on about two commits in three.** Of 104 first-parent master commits since
   the cached `15c3a620`, 36 touch a generation path (rule below), 68 do not. Each miss is a 30-35 min
   BaseApp leg (owner figure) per lane per round today.

## Part A — verify.ts

CLI (one file, `scripts/verify.ts`; existing positional `[pkg...]` IS the `--packages` form, kept as is):

```
bun scripts/verify.ts                    # FULL: typecheck, clean dist, bun test --parallel=<P>
bun scripts/verify.ts --changed[=<ref>]  # PARTIAL: ... bun test --parallel=<P> --changed=<sha>
bun scripts/verify.ts runner engine      # PARTIAL: ... bun test --parallel=<P> packages/runner packages/engine
```

- `P = min(8, os.availableParallelism())` (8 was the knee: 4 -> 22.7 s, 8 -> 17.0 s, 16 -> 17.5 s).
- `--changed` default ref: `git merge-base HEAD origin/master`, resolved to a sha and printed. Dependents are
  computed by bun's own import graph (file level), which is finer than the package graph and needs no code of
  ours. Known blind spot, printed on every `--changed` run: a test that reads a changed NON-import file (a
  fixture `.al`, `.json`, `.snap`) is not selected; run the full verify after touching those.
- The full run uses `--parallel` too. This is the main saving (67.5 s -> about 18.5 s) and keeps full
  coverage. The Windows `check` CI job keeps its plain serial `bun test`, so an order-dependent test still
  has one serial run per push.

**The receipt.** verify.ts prints a first line and a last line:

```
verify mode: FULL (all test files, --parallel=8)
...
VERIFY FULL: PASS (8539 pass / 8 skip / 0 fail)
```
or
```
verify mode: PARTIAL (--changed since 1eb4dcf6; bun selected 175 of 388 test files) -- NOT a submit or merge verify
...
VERIFY PARTIAL: PASS (5126 pass / 0 skip / 0 fail) -- run `bun scripts/verify.ts` with no arguments before submit
```
One pure function `receipt(mode, summary)` builds both lines; the word `FULL` is produced only for mode
`full`, which is only built from an empty argv.

**Why a partial run can never read as full:**
1. Nothing machine-reads a receipt today (grep of `scripts/`, `.claude/skills`, `ci.yml`): CI's unit-linux job
   runs `bun scripts/verify.ts` with no arguments, and submit notes cite the CI run id. So there is no
   submit/merge script to change; the guards are on the producing side.
2. **verify.ts refuses `--changed` and package arguments when `CI` or `GITHUB_ACTIONS` is set in its OWN
   environment** (exit 2, `VerifyArgsError`, naming the variable). So a CI job edited to pass a partial flag
   fails instead of going green on a subset. (verify.ts sets `CI=true` only for its child; the check reads
   the parent env.)
3. A partial receipt never contains `VERIFY FULL` or `test (all)`; a full receipt always does.
4. The runbook line for submit (`docs/superpowers/runbooks/autonomy/README.md`, Speed rules) gains one
   sentence: the verify quoted in a submit note is the `VERIFY FULL` line.

Tests (in `scripts/verify.test.ts`, pure functions plus one spawn):
- A1 `parseArgs` -> `{ mode: "full" }` for `[]`; `{ mode: "partial", changed: <ref> }` for `--changed`;
  partial for package names; unknown flag still throws.
- A2 **partial never reads as full** — `receipt()` for every partial mode contains `PARTIAL` and `NOT a submit`
  and never `FULL`; for `full` it contains `VERIFY FULL`. RED CHECK: make `receipt` print `FULL` when the
  argv is `--changed` -> A2 goes red.
- A3 **CI refusal** — `parseArgs(["--changed"], known, { CI: "true" })` and with `GITHUB_ACTIONS` throw;
  `parseArgs([], known, { CI: "true" })` does not. RED CHECK (the other direction of the same guard): delete
  the refusal -> the throw test goes red; refuse also for `[]` -> the full-under-CI test goes red.
- A4 the test command: full -> `["bun","test","--parallel=P"]` with no path and no `--changed`;
  `--changed` -> exactly one `--changed=<sha>`.
- A5 (spawn, ~1 s) the R393 snapshot guard still holds under `--parallel`: in a temp dir, a test file with a
  `toMatchSnapshot()` that has no snapshot, run through `testStep`'s real exec with `--parallel=2`, must
  FAIL and write no `.snap`. If bun's workers do not inherit `CI=true`, this test is what says so, and the
  fallback is to drop `--parallel` from verify (the belt still catches the write).
- A6 `parseTestSummary` on a captured `--parallel` output (fixture string) reads counts and `(fail)` names.

## Part B — `scripts/corpus-snapshot.ts`

Files: `scripts/prod-identity-keys.ts` (taken from `1b1fc501`, extended with tags), `scripts/corpus-snapshot.ts`
(CLI + exported pure functions; `prod-keydiff.ts` is folded into it and not added), `scripts/corpus-snapshot.test.ts`.

### CLI

```
bun scripts/corpus-snapshot.ts snapshot <set> --master
bun scripts/corpus-snapshot.ts diff <set> --branch <worktree> [--projects <n|dir>[,...]] [--all]
```
Sets (as R-500's `run500.ts`): `fixtures` (`<tree>/fixtures`), `cdo` `/work/src/do-lethal`, `bch`
`/work/src/BC.History`, `dc` `/work/src/DC`, `do` `/work/src/DO`. Projects = directories holding `app.json`,
sorted (same order as the legacy entry, so `<n>` indices stay compatible). Cache root `/coord/cache/dumps`,
overridable by `LETHAL_DUMP_CACHE` (tests use a temp dir).

### Layout

```
/coord/cache/dumps/<master sha>/<set>/
  <n>.jsonl        one prod-identity-keys line per project
  projects.tsv     <n>\t<project dir>
  manifest.json    { format: 2, masterSha, set, corpusRoot, corpusHead, depDirs, started, finished, projects }
  DONE             written last
```
Format 2 adds the kill tag to each key line: `<file>|<op>|<start>-<end>\t<tuple>|<ordinal>|<tag>`, `tag` =
the spec's `platformKillMechanism` or empty. The legacy `15c3a620` entry (top-level `DONE`, no manifest, no
tags) is read as format 1: usable for `diff`, tags reported as `n/a`.

Branch dumps go to `/coord/cache/branch/<branch HEAD sha>[-dirty]/<set>/` and are never read as master.

### snapshot <set> --master

1. `B = git rev-parse origin/master` (printed). No fetch: the caller fetches.
2. If `<B>/<set>/DONE` exists (or legacy `<B>/DONE` with `<B>/<set>/`): print `cached: <path>`, exit 0.
3. Else, for each cached entry `A` with a DONE for this set, newest first, that `git merge-base --is-ancestor
   A B` accepts: if `generationChanged(git diff --name-only A B)` is empty AND the manifest's `corpusHead` and
   `depDirs` equal today's, print `reuse <A> for <B>: <k> commits, <m> files changed, none is generation code`
   and exit 0 (writes nothing). Otherwise print the first generation path that changed for the newest
   candidate, then dump.
4. Heavy-job guard (all sets except `fixtures`), then dump (below).

### Generation-code rule

A path is generation code when it matches any of:
`packages/*/src/**` except `*.test.ts`; `packages/engine/native/**`; `bun.lock`; any `package.json`;
`scripts/prod-identity-keys.ts`; `scripts/corpus-snapshot.ts`.

Measured against the precise alternative (the `Bun.build` import closure of `orchestrator.ts` +
`schemata/src/index.ts`, 146 files): 36 vs 31 commits of 104 hit. The 5-commit gap is not worth a build step
that needs a materialised tree with node_modules. A false "changed" costs one re-dump; a false "unchanged"
would serve a stale dump, and the static rule cannot produce one for any file in the closure, since every
closure file is under `packages/*/src`. `IDENTITY_SCHEME` lives in `schemata/src/project.ts`, inside the rule.

### Refuse to overwrite

At the start of a dump, `mkdirSync(<B>/<set>)` WITHOUT `recursive` is the lock: `EEXIST` -> refuse, exit 3:
`<path> exists (DONE: yes|no). A cache entry is never edited, only replaced whole: delete it by hand to
re-dump.` Also refused when legacy `<B>/DONE` exists. Files are written into that directory, `DONE` last.
Any project that writes `{error}` -> no DONE, exit 1 (the legacy entry has zero error projects, so errors
are not a normal state). A crashed run leaves a directory without DONE, which the next run refuses by name.

### Heavy-job guard (2 container-wide)

`heavyJobs()` reads `ps -eo pid,args` and counts processes whose args contain a corpus root
(`/work/src/BC.History`, `/work/src/do-lethal`, `/work/src/DC`, `/work/src/DO`), excluding its own pid
and the `ps`/`grep` line. That is the test `run500.ts` already used, and our own per-project children carry
the project path in their argv, so other lanes' guards see us. A dumper that runs projects one at a time
counts as 1; one that runs several in parallel counts as several (the safe direction). `>= 2` -> refuse,
exit 4, listing the pids and the first 100 characters of each argv. Checked once at start (the task says
refuse, not wait). Live BC itests are not counted: the rule is about memory-heavy corpus jobs.

### Dump tree

`git archive B` into `/coord/cache/tmp/<B>-<pid>/` (not session scratch). node_modules: `cp -al` from the
invoking checkout when `bun.lock` is byte-identical, else `bun install --frozen-lockfile`. Native parser:
copy the built `.node`; the loader refuses a stale one (`NativeParserStaleError`), and then the tool runs
`bun scripts/build-native-parser.ts` in the tree. The tree is deleted after DONE. One project per process
(`bun scripts/prod-identity-keys.ts <tree> <out> <project>`), `DEP_DIRS` passed through and recorded.

### diff <set> --branch <worktree>

- Master side: the entry `snapshot` would pick for `merge-base(<worktree> HEAD, origin/master)` (cached or
  reusable). None -> refuse: `no master dump for <sha>; run snapshot <set> --master first`.
- Projects: `--projects` (indices or dirs from the entry's `projects.tsv`); `--all`; neither -> all for
  `fixtures`/`cdo`/`dc`/`do`, REFUSED for `bch` (a 519-project branch leg must be asked for). Automatic
  "affected projects" detection is skipped: a generation change can touch any project.
- Same heavy-job guard. Branch dump from the worktree as it is (dirty allowed, marked `-dirty`).
- Report (stdout; paths, operators, counts only, never tuple text), per project then totals:
  `added N`, `removed N` (each grouped by file + operator), `tuples moved`, `ordinals moved`,
  `tags changed` (per mechanism, `n/a` against a format-1 entry), `specs a -> b; hang a -> b; skipped a -> b`.
  Exit 0 identical, 1 different, 2 refused.

### Tests (`scripts/corpus-snapshot.test.ts`; temp git repos and temp cache dirs, no corpus)

- B1 `generationChanged`: a table of paths (each rule hits; `docs/`, `fixtures/`, `packages/runner/tests/`,
  `*.test.ts` under src, `scripts/other.ts` miss).
- B2 **a stale sha is never used when generation changed** — temp repo: commit A (cached entry with DONE),
  commit B touching `packages/engine/src/x.ts`; `pickMaster(B)` returns "dump", naming that path.
  RED CHECK: make `generationChanged` return `[]` -> B2 red.
- B3 **a reusable sha IS reused when generation did not change** — same repo, B touches only `docs/a.md`;
  `pickMaster(B)` returns `reuse A`. RED CHECK: make `generationChanged` return every path -> B3 red.
  (B2 and B3 are the two directions of one guard.) Plus: A not an ancestor -> no reuse; differing
  `corpusHead` -> no reuse.
- B4 **a DONE entry is never overwritten** — temp cache with `<B>/<set>/DONE` and a known `1.jsonl`;
  `snapshot` with a stub dumper exits 3 and both files are byte-identical afterwards, and the stub was never
  called (call counter). Same for an incomplete dir and for legacy `<B>/DONE`. RED CHECK: replace the
  exclusive `mkdirSync` with `recursive: true` -> B4 red (the stub runs and rewrites `1.jsonl`).
  Other direction: an empty cache -> the stub is called once per project and DONE is written last
  (asserted by write order on the stub).
- B5 heavy guard: fixture `ps` lines with 0, 1, 2 corpus processes plus its own pid and a `grep` line ->
  go, go, refuse. RED CHECK each way: threshold `> 2` -> the 2-process case goes red; count self -> the
  1-process case goes red.
- B6 `diffDumps` on two hand-written format-2 dumps: exact added/removed/tuples/ordinals/tags counts, and the
  output contains no tuple text (a sentinel string in a tuple must not appear).
- B7 (spawn, ~1 s) `prod-identity-keys.ts` on `fixtures/sandbox-app` of this checkout: a format-2 line with
  `keys.length > 0` (keys are identity entries, not specs), every key line ending in `|<ordinal>|<tag>`,
  and at least one key on a `platformKillMechanism` site carrying its tag (the fixture is chosen in the build
  so that such a site exists).

## Expected time saved (measured)

| what | today | after |
|---|---|---|
| full verify | 67.5 s | ~18.5 s (1.2 typecheck + 17.0-17.2 tests, measured twice) |
| inner loop, r589's diff | 67.5 s | 16.5 s `--changed` (parallel); 46.4 s if serial |
| master dump leg, cache hit or reuse | 30-35 min BaseApp per lane per round | 0 (a `git diff`); reuse eligible on 68 of 104 master commits since 15c3a620 |
| branch leg | full set | named projects only |

## Build order

1. Part A, A1-A6, red checks A2 and A3 (both directions). `bun scripts/verify.ts` twice (parallel), then
   one serial `bun test` to confirm the same counts.
2. Part B, B1-B7, red checks B2/B3, B4 (both directions), B5 (both).
3. One live smoke: `snapshot fixtures --master` into a temp cache (1 s), then `diff fixtures --branch .` ->
   identical. No corpus run in the build; the first real `bch` snapshot is for the next lane that needs one.
4. Opus build review, CI (both jobs), R593 `done (<commit>)`, submit.

## Open questions for the reviewer

- Making the FULL verify parallel goes beyond item 3's wording; it is the measured win. Accept, or keep full
  serial and parallelise only `--changed`?
- Should a full run also assert that bun ran every tracked test file (`Ran N tests across M files`,
  M = `git ls-files '*.test.ts'` count), so a worker that silently drops files cannot pass as full?
  Not built unless asked.


---

