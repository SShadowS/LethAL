# R-392: measure al-runner's predefined symbols per binary, never assume them (short plan)

Task: `H:/lethal-coord/tasks/R-392/task.md`. Item: `docs/roadmap/R392.md` (follows R377). Code research:
`H:/lethal-scratch/R-392/research.md`. Today `AL_RUNNER_PREDEFINED_SYMBOLS` (CLEANSCHEMA1..25, measured on
v2.12.0) feeds `effectiveBuildSymbols` for every al-runner run, and nothing checks it.

## Where the probe runs
`runAlRunnerCanary` is the wrong place. It runs in `runFromCli`, and its result reaches only the report, never `runSession`.
`runSession` already spawns al-runner (`provisionOnce` and the contract probe) BEFORE it computes `buildSymbols`.
So a new `probeAlRunnerPredefinedSymbols` runs there, for the al-runner backend only. Its result is passed as a
parameter to `effectiveBuildSymbols` AND to `generateMutationSet`, so the existing `BuildSymbolsDivergedError`
guard still holds. This covers `lethal run`, `campaign` and every itest that calls `runSession`. The `--dry-run`
path with `--backend al-runner` uses the same function, through the cache (below).

## The probe
One one-shot al-runner run (the `OneShotTransport` the canary uses) on a two-app project generated in a temp dir,
with no `--define`. The app holds `Mask()`, which appends one label per `#if CLEANSCHEMA<n>` arm for n = 1..40, plus
`#if CLEANSCHEMA`. The test does `Error('MASK:' + Mask() + ':END')`, and the arms that compiled are read from the
failure message. This is R377's measured method. A missing `MASK:...:END` marker is a probe failure, never "no symbols".

## What a result does
- **It matches the constant:** use it; nothing is printed.
- **It differs:** USE THE MEASURED SET, and emit a named warning, `al-runner-predefined-symbols-changed`, listing what
  was added and removed against the v2.12.0 list. Why not refuse: the measured set IS what al-runner builds. Refusing
  would block every user on each al-runner release that changes the list. Because the measured set goes into
  `buildSymbols`, it reaches the run row, the fingerprint, history, resume and marks, so a changed list correctly
  separates the history. The constant stays only as the documented v2.12.0 expectation that the warning compares
  against.
- **The probe fails** (spawn error, no marker, or a timeout): REFUSE the run with a named error,
  `AlRunnerPredefinedProbeError` (extends `Error` directly), giving the cause and al-runner's output tail. The
  hard-coded list is NEVER used in its place.

## Cache, once per binary build
- **Key:** al-runner's `--version` line, plus the resolved binary path and its size and mtime. A new release changes the
  version; a re-installed binary changes the mtime. Either one is a cache miss, so the probe runs again.
- **Location:** `~/.lethal/al-runner-probe/<sha256(key)>.json`, holding `{ key, symbols, measuredAt }`. The directory is
  injectable (the test preload hides the real home, R264).
- **Contents are checked on read:** a corrupt file, or one whose key differs, is a miss, never a match.
- **Cost:** measured on the first live run and written into R392, as the probe's wall time on this machine. The
  R377 runs suggest one compile plus run, a few seconds; after the first run per binary it costs one stat call.

## Tests (TDD, fake al-runner through the canary's `scriptedSpawn` seam; red-check each hunk)
1. Match: the fake reports 1..25. `buildSymbols` holds 1..25, and no warning is emitted.
2. Mismatch: the fake reports 1..26 without 25. `buildSymbols` holds the MEASURED set, and the named warning lists
   +CLEANSCHEMA26 and -CLEANSCHEMA25. An `#if CLEANSCHEMA26` arm is then enumerated as al-runner builds it. Red-check:
   making the function return the constant turns this test red.
3. Probe failure (no marker): runSession refuses with `AlRunnerPredefinedProbeError`. Red-check: a fallback to the
   constant turns this test red.
4. Cache: a second session with the same key does not spawn the probe (checked with a call counter). A changed
   version or mtime does spawn it. A corrupt cache file is a miss.
5. bcdev: no probe and no change (the existing R214 control).
6. `--dry-run --backend al-runner` takes the same path (cache hit; with no cache, a probe or a named refusal).
Live: one `itest:alrunner` run, after asking for the al-runner go and reporting at STOP. Expected: no frozen figure
moves (v2.12.0 matches the constant, so it is the match path), and the probe's wall time is recorded.

## Out of scope
The report field for the effective set (R381); bcdev or alc, which predefine nothing.
