# R-392: measure al-runner's predefined symbols every session, never assume them (short plan, r2)

Task: `H:/lethal-coord/tasks/R-392/task.md`. Item: `docs/roadmap/R392.md` (follows R377). r1 review:
`H:/lethal-coord/reviews/R-392-plan/review-r1.md`; all five findings are accepted, and each was checked against the code.

## Paths that enumerate al-runner mutants (checked)
- `runSession` (orchestrator.ts): used by `lethal run` and campaign stages, and by every itest. It calls
  `effectiveBuildSymbols` and then `generateMutationSet`.
- `printDryRun` (cli.ts) calls `generateMutationSet` DIRECTLY, without going through runSession (r1 finding 1, confirmed).
- **Do not enumerate al-runner mutants:**
  - `lethal verify` is bcdev only.
  - campaign freeze and compare only read reports.
  - `scripts/campaign/compile-only.ts`, `r214-capture.ts`, `r364-mut-compile.ts`, `measure-gui-guarded.ts` and
    `probe-alrunner-tables.ts` call `generateMutationSet` with no backend, so they get the alc set. That is
    documented and not changed here.

## The change
1. **No constant fallback.** `effectiveBuildSymbols` and `generateMutationSet` take a backend input,
   `{ kind: "bcdev" } | { kind: "al-runner"; predefined: AlRunnerPredefinedProbe }`. The al-runner variant cannot be
   built without a probe result, so TypeScript rejects any al-runner call that lacks one. An absent backend still
   means alc. The constant is renamed `AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0`, and is used ONLY to compare against for
   the change warning.
2. **runSession** awaits `probeAlRunnerPredefinedSymbols` for the al-runner backend. It runs after `provisionOnce` and
   before `effectiveBuildSymbols`, sequentially, with nothing started in parallel. Its result goes to both calls, so
   the `BuildSymbolsDivergedError` guard still holds.
3. **printDryRun with `--backend al-runner`** runs the same probe, or refuses by name when it cannot (for example,
   no al-runner path is configured).

## A complete, checkable probe result (r1 finding 2)
- **The project:** one one-shot al-runner run with no `--define`, on a two-app project generated in a temp dir. For
  each candidate `c` in CLEANSCHEMA1..40 plus CLEANSCHEMA, `Mask()` appends `+c` under `#if c` and `-c` under `#else`.
  There is also an `+ALWAYS` arm under `#if true` and a `+NEVER` arm under `#if LETHALR392NEVER`, which alc and al-runner
  never define. The test `LethAL R392 Probe.ProbeMask` raises `Error('R392MASK:' + Mask() + ':END')`.
- **Accept only when all of these hold:**
  - exactly one result, for that exact test, with status failed;
  - exactly one `R392MASK:...:END`;
  - tokens are `+` or `-` with an id in candidates ∪ {ALWAYS, NEVER}, with no repeat and no other token;
  - EVERY candidate appears exactly once (that is 41, so every arm was compiled and read);
  - `+ALWAYS` is present and `+NEVER` is absent.
- **Anything else** is refused with `AlRunnerPredefinedProbeError` (extends `Error` directly), carrying the reason and
  al-runner's output tail.
- **The limit, stated:** the probe sees only its candidate range. A predefined symbol outside CLEANSCHEMA1..40 and
  CLEANSCHEMA would go unseen; R392 records this as a known limit.

## What a result does
- **Equal to the v2.12.0 list:** it is used, and nothing is printed.
- **Different:** the MEASURED set is used, and the named warning `al-runner-predefined-symbols-changed` lists what was
  added and removed. Why not refuse: the measured set IS what al-runner builds, and refusing would block every user
  on each al-runner release that changes the list. It flows into the run row, the fingerprint, history, resume and marks.
- **No cache (r1 finding 4).** The probe runs every al-runner session, as R345 chose for the contract probe. Its
  wall time is measured on the first live run and written into R392. If it is over 15 s, a cache becomes a follow-up
  item, with the validations r1 lists (symbols checked on read, an atomic write, a byte-level binary identity, and
  fake-home tests).

## R-387 (r1 finding 3)
R-387 merges FIRST. R-392 then extends R-387's `cliDefaultMechanismFailures` to allow exactly ONE one-shot spawn whose
`--test` is `LethAL R392 Probe.ProbeMask`, per backend, next to its provision sentinel. Red-checks:
- removing the probe spawn fails the "probe ran" assertion;
- adding an ordinary one-shot `--test` still fails the gate;
- a second probe spawn fails too.

## Tests (TDD with a fake al-runner, the canary's `scriptedSpawn`; red-check each hunk)
- The match, mismatch and refuse paths, with the partial cases: a missing candidate, a repeat, an unknown token, no
  ALWAYS, NEVER present, two masks, the wrong test, and a passed status.
- **Order (r1 finding 5):** a runSession test with call-order counters proves probe -> effectiveBuildSymbols ->
  fingerprint -> generateMutationSet, and that the probe finished before the next call.
- The dry-run probe and its refusal.
- bcdev is untouched (it never spawns the probe).

## Live, and limits
One `itest:alrunner` run, after the orchestrator's go and with STOP reported. It should take the match path, with no
frozen figure moving, and it records the probe's wall time. R345's risk across sessions (two sessions running al-runner
at once) remains. This plan only keeps its own probe sequential within one session.
