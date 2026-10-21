# itest:alrunner

`LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` runs LethAL through al-runner.
`LETHAL_ALRUNNER_PATH` names the al-runner binary. al-runner is a third-party test runner for AL
that needs no BC server. The gate prints the al-runner build it ran against as its first line.
CLAUDE.md holds the rules for moving to a new al-runner build. This page holds the figures and the
history.

## Frozen figures

```json gate-figures
{
  "gate": "itest:alrunner",
  "baselines": {
    "al-runner.baseline.json": { "killed": 3, "survived": 12, "no-coverage": 4 },
    "al-runner.cli-default.baseline.json": { "killed": 3, "survived": 12, "no-coverage": 4 },
    "al-runner.symbols-lethala.baseline.json": { "killed": 5, "survived": 4 },
    "al-runner.symbols-lethalb.baseline.json": { "killed": 5, "survived": 4 },
    "al-runner.layout.baseline.json": { "killed": 7, "survived": 3 },
    "al-runner.multiobject.baseline.json": { "killed": 6, "survived": 1, "no-coverage": 5 },
    "al-runner.wrapped.baseline.json": { "killed": 58, "survived": 37, "no-coverage": 3 },
    "al-runner.names.baseline.json": { "killed": 36 }
  },
  "constants": {
    "ALRUNNER_FIGURES.totalMutantSites": 19,
    "ALRUNNER_FIGURES.killed": 3,
    "ALRUNNER_FIGURES.survived": 12,
    "ALRUNNER_FIGURES.noCoverage": 4,
    "ALRUNNER_FIGURES.noCoverageFile": "SandboxPricing.Codeunit.al",
    "LAYOUT_MAX_GUARDS": 7,
    "NAMES_TABLE.length": 12,
    "REPRODUCTION_EXPECTED.sandbox/one-shot.killerRowsPerKill": 2,
    "REPRODUCTION_EXPECTED.names/server.killerRowsPerKill": 2,
    "REPRODUCTION_EXPECTED.cli-default.killerRowsPerKill": 2,
    "REPRODUCTION_EXPECTED.cli-default.activations": 23,
    "REPRODUCTION_EXPECTED.cli-default.serverSuiteRuns": 22
  },
  "notPinned": {
    "groupedCalls": 0,
    "warmKills": 0
  }
}
```

The legs and their figures:

- Leg A, sandbox-app one-shot: 3 / 12 / 4 over 19. All four no-coverage mutants are in
  `SandboxPricing.Codeunit.al`. This equals `itest:bcdev` mutant by mutant. The leg makes no
  grouped call and cannot measure a warm kill, so `groupedCalls` and `warmKills` are both 0, and
  every kill is at `killPosition` 1. Those two zeros are literals in the gate's assertions, so the
  pin test cannot check them.
- The `--server` leg (R220) uses al-runner's warm daemon. The resource leg (R222) uses
  `selectorMode: "resource"`. Every leg's verdicts must equal the one-shot leg's, mutant by
  mutant.
- The symbol sets (R321): 5 / 4 / 0 over 9 for each of `[LETHALA]` and `[LETHALB]`.
- The layout leg (R353): 7 / 3 / 0 over 10, at `maxGuardsPerBatch` 7.
- The multi-object leg (R383, R407): 6 / 1 / 5 over 12.
- The wrapped leg (R-300b, R343): 58 / 37 / 3 over 98.
- The CLI-default leg (R387, R394): 3 / 12 / 4 over 19, equal to leg A.
- The names legs (R557): 36 / 0 / 0 over 36.
- Kill reproduction (R577): every kill on every leg is reproduced, with 2 killer rows per kill.
  The CLI-default leg makes 23 activations and 22 `runTests` requests.

## The legs in detail

- **Leg A and coverage.** Leg A has been 3 / 12 / 4 since R220 wired al-runner's own
  `--coverage`. Before that it was 3 / 16 / 0: the backend reported `coverage: "none"`, and a
  mutant no test reached came back as survived. The four that moved are `SandboxPricing`'s. The
  gate now matches `itest:bcdev` mutant by mutant, which is the point.
- **The `--server` and resource legs.** The resource leg compiles the bundle once. It then writes
  the active mutant to a resource file that the compiled AL reads at run time, instead of putting
  the id into the AL and compiling again for each mutant. Measured on this fixture: 137 s one-shot,
  31 s with `--server`, 20 s with `--server` and the resource selector. The fixture understates the
  last figure, because two files make a compile cheap. The mode exists for projects where each
  compile takes about 65 s.
- **The platform-app pin (R147).** The gate pins `executionContexts[].platformAppsDir`. A one-shot
  leg that did not pin al-runner's platform-app directory fails the gate. It also emits an
  `al-runner-platform-apps-unpinned` warning that names the check that refused. Only the two
  one-shot legs use the pin. The `--server` and resource legs never receive it, so the gate checks
  it on the one-shot legs only. Since R242 the report records the field only where the pin was
  sent, so the field is absent on the `--server` and resource legs, and the gate checks that too.
- **The symbol sets (R321).** `fixtures/sandbox-symbols` with its tests runs under `[LETHALA]` and
  under `[LETHALB]`, each through the one-shot, `--server` and resource legs. The figures were
  frozen per set by R214 and re-frozen at 24e3312a on 2026-10-01. Each build mutates only the arm
  it compiles. So the per-mutant check separates the two sets, not the counts. Every leg must
  match the pre-committed table in verdict and killing test
  (`docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`). The server legs must
  also equal the one-shot leg mutant by mutant. Red-checked both ways the defines can be lost:
  dropping `buildAlRunnerArgv`'s `--define` fails
  `R321 one-shot [<set>]: per-mutant verdicts differ from the pre-committed table`. Dropping R319's
  daemon `--define` fails the `--server` and resource equality checks. These legs do not prove the
  R147 pin.
- **The layout leg (R353).** `fixtures/sandbox-layout` with its tests runs at
  `maxGuardsPerBatch` 7. That splits the project into two batches. It runs through the one-shot
  and `--server` legs. Every other al-runner leg runs one batch. That is why R349 (a coverage index
  kept across `deploy()`) passed every gate before it was fixed. The figures are checked mutant by
  mutant and covering test by covering test against
  `docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md`. Mutants are keyed
  `<batch>/<code>`, because codes restart in each batch. Red-checked: deleting
  `resetLayoutState()` from `deploy()` fails the one-shot leg on `1/M0006` and `1/M0007`. They go
  from killed to survived, and their covering test moves from `TwiceOfThree` to `GrowAboveTen`.
  The `--server` leg does not go red, and must not. The daemon names a covered statement's
  procedure itself, so only the one-shot leg can see a stale layout live. The `serverSuite` half of
  the reset is guarded only by R349's unit test. `LayoutBeta`'s header comment sets the line spans
  that the prediction rests on.
- **The multi-object leg (R383, R407).** `fixtures/sandbox-multiobject` was recorded on 2026-10-02,
  per `docs/superpowers/specs/2026-10-02-r383-multiobject-refusal-precommitment.md`. The admission
  table is in `docs/superpowers/specs/2026-10-09-r407-multiobject-admission-precommitment.md`.
- **The wrapped leg (R-300b, R343).** `fixtures/sandbox-wrapped` with its tests holds codeunits
  wrapped in `#if`, each alone in its file, and each with an unwrapped twin on the same lines. It
  runs under the symbol `WRAPDEF` through the one-shot, `--server` and resource legs. Each admitted
  wrapped file must equal its twin mutant by mutant, in both directions. `WrappedArms` is refused
  by name. Any R383 "position wins" warning, or R-300b "line is dropped" warning, fails the leg.
  The header comments of `Twice` in the wrapped files set line spans the prediction rests on, as
  `LayoutBeta`'s does. It was first recorded on 2026-10-06 on al-runner v2.12.0-main.c39ad5de,
  per `docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md`; that run measured
  that `--define` adds to the symbols in `app.json`. R343 froze it at 36 mutants
  (`docs/superpowers/specs/2026-10-08-r343-wrapped-leg-precommitment.md`); the fixture has grown
  since, to the figures above.
- **The CLI-default leg (R387, R394).** It runs `sandbox-app` last, through the CLI's own
  `buildBackend`, with no transport or coverage key (`cli-default-leg.ts`). It checks that
  `--server` and the resource selector actually ran. Since R394 coverage is on by default. So the
  leg equals leg A mutant by mutant, in verdict and `killingTest`. Under R387, before coverage was
  the default, it was 3 / 16 / 0, with `SandboxPricing`'s four mutants survived. The
  pre-commitment is `docs/superpowers/specs/2026-10-11-r394-coverage-default-precommitment.md`.
- **The names legs (R557).** `fixtures/sandbox-names` with its tests has 12 tests. Each is the only
  test that kills its procedure. al-runner renames 10 of the test names: they contain a space,
  `-`, `()`, `.`, `/`, `&`, a leading digit, the unquoted keyword `Default`, or Danish letters. The
  other 2 are controls that are not renamed. The legs are one-shot and `--server`, under coverage
  `al-runner` and `none`. They are checked mutant by mutant against
  `docs/superpowers/specs/2026-10-09-r557-names-precommitment.md`. Red-checked: with the name
  builder from before R557, it reads 6 killed and 30 survived under coverage `none`, and 6 killed
  and 30 no-coverage under coverage `al-runner`. It was recorded on 2026-10-20 on
  v2.12.0-main.f06ee78c. The bcdev twin is [bcdev-names.md](bcdev-names.md).
- **Kill reproduction (R577).** `REPRODUCTION_EXPECTED` in `kill-reproduction.ts` holds the
  figures. They were measured at 102821df. The names legs' 2 killer rows per kill is a prediction
  (addendum a40097fc), not a measurement.

## Why `authoritative` stays false

`authoritative: false` still holds, but both of its old reasons have gone (R220). Coverage is now
read from al-runner's `--coverage`. And the canary's `transactionRollback` probe shows on 2.11.0
that a row written inside `Codeunit.Run` is discarded by the error, which 2.7.0.0 did not do.

What keeps the flag false is that coverage is conditional. It is on by default in `lethal run`
since R394; `"alRunner.coverage": "none"` turns it off. But some files turn it off for the whole
run:

- A file whose objects after the first are not all code-free (permission sets, enums, interfaces,
  entitlements are code-free) turns coverage off, unless R407's frame probe admits the installed
  build. The reason: al-runner reports every later object's lines in a mixed frame, the previous
  object's end in the source plus a distance in the instrumented text. This was measured on
  c39ad5de (R383). The object loss reported upstream as #3713 is fixed, and f06ee78c is admitted.
- A refused file wrapped in `#if` turns coverage off too (R298). 15 of 519 BC.History projects have
  one; CDO, DC and DO have none (R579, R580).

A capability that depends on how a project lays out its files is not a capability.

## History of al-runner versions on this gate

- **Pinned source build (2026-10-02).** On the Windows host, gates and lanes run a pinned source
  build of upstream main (`v2.12.0-main.c39ad5de`, BC runtime 28.5, worktree
  `H:/al-runner-builds/src-c39ad5de`), not the released global tool. The reason: v2.12.0's rewrite
  of its ncl shadow crashed concurrent sessions (R345), and the fix was not yet released. Every
  figure on this page was identical on that build, measured the same day. The released global tool,
  `C:/Users/SShadowS/.dotnet/tools/al-runner.exe` (v2.12.0), stays installed as the fallback.
- **v2.7.0.0 (2026-08-28).** A jump of four minor versions from 2.3.1.0 that the gate had never
  seen. All 19 verdicts were unchanged, and R129's `[bc]` line still parsed. But the bump exposed a
  LethAL defect, which the gate caught. R147 read only the cold-cache line
  `[provision] Downloaded <N> app(s) ... to <dir>`. So the pin worked only on a run that actually
  downloaded: the optimisation turned itself off whenever the cache was healthy. A warm 2.7.0
  prints `[provision] platform apps already complete at <dir>.` instead. Both lines are now read.
  Two similar lines in the same output, for the engine directory and the test toolkit, are pinned
  by test as lines that must not match.
- Also in 2.7.0: `--auto-provision` is on by default and kept only for older callers;
  `--no-auto-provision` is new; and a `provision` subcommand exists that LethAL still does not use.
  The reason it is unused: it resolved the test toolkit at the binary's version, while the run
  resolved the platform apps at the project's. That held on 2.1.1.0 and 2.7.0.0. It no longer
  reproduces on 2.10.0.0, where both resolve to the binary's build on this fixture (R207).
- 2.1.0.0 needed `--auto-provision` in the argv. The fix was to pass it, not to move to an older
  release (R125).
- **v2.10.0.0, re-measured 2026-09-03: PASS, all 19 verdicts identical.** This run followed
  al-runner's author reading this repo and finding claims that were no longer true. He was right,
  and every one was user-facing prose, not code. `README.md`, the EMEA runbook and the agent guide
  still said "its `asserterror` never fails a test". That was a v1 finding (R7), fixed in v2, and
  `runAlRunnerCanary` has reported it as `defect-not-reproduced` since 2.0.0.0. This is why
  CLAUDE.md asks for a sweep of the prose whenever al-runner moves.
- On a warm cache, 2.10 and 2.11 print no provisioning line. 2.11 also searches the engine
  variant's build for platform apps (`28.1.49838.54368` while `28.1.49838.54487` is selected), so
  R200's `<selected>/platform-apps` does not exist there. 2.11 names the real directory only in its
  verbose `[pkg-cache] <dir>` line. `provisionOnce` now asks for that line through
  `AL_RUNNER_VERBOSE=1`, on the provisioning call alone (R235).
- **v2.11.0, 2026-09-26:** PASS, 19 verdicts identical.
- **v2.12.0:** `[bc] selected` prints only under `AL_RUNNER_VERBOSE`. So the build is read from the
  default `[bc] warning ... not the selected <build>` line, or from the banner
  `al-runner <ver> · BC <build> · <n> apps` (R338). Measured on 2026-09-29: PASS, 19 verdicts
  identical, symbol sets 5 / 8 / 0 (the symbol fixture's figures at that time).
- The measured v2 CLI and wire contract is in `docs/measurements/README.md` §"al-runner v2". R123
  is the probe that would check it in each session instead of by habit.
