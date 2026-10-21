# itest:alrunner

`LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` (with `LETHAL_ALRUNNER_PATH` naming the al-runner
binary; see CLAUDE.md for which build each machine uses) runs LethAL through **al-runner**, a
third-party AL test runner that needs no BC server. The gate prints the al-runner build it ran
against as its first line. The rules for moving al-runner (pinned build, prose sweep, no downgrade)
are in CLAUDE.md; this page holds the figures and history.

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
    "LAYOUT_MAX_GUARDS": 7,
    "NAMES_TABLE.length": 12,
    "REPRODUCTION_EXPECTED.sandbox/one-shot.killerRowsPerKill": 2,
    "REPRODUCTION_EXPECTED.names/server.killerRowsPerKill": 2,
    "REPRODUCTION_EXPECTED.cli-default.killerRowsPerKill": 2,
    "REPRODUCTION_EXPECTED.cli-default.activations": 23,
    "REPRODUCTION_EXPECTED.cli-default.serverSuiteRuns": 22
  },
  "notPinned": {
    "totalMutantSites": 19,
    "groupedCalls": 0,
    "warmKills": 0,
    "noCoverageFile": "SandboxPricing.Codeunit.al"
  }
}
```

## The legs

- **sandbox-app, one-shot (leg A)**: **3 / 12 / 4** since R220 wired al-runner's own `--coverage`.
  It was 3 / 16 / 0 while the backend reported `coverage: "none"` and an unreached mutant came back
  `survived`; the four that moved are `SandboxPricing`'s. The gate now matches `itest:bcdev` PER
  MUTANT, which is the point. It makes no grouped call (`groupedCalls` 0) and cannot measure a warm
  kill (`warmKills` 0; every kill at `killPosition` 1 on the sequential path).
- **`--server` leg** (R220): al-runner's warm daemon. **Resource leg** (R222):
  `selectorMode: "resource"` compiles the bundle ONCE and writes the active mutant to a
  source-backed resource file the compiled AL reads at runtime, instead of baking the id into AL
  and recompiling per mutant. Every leg's per-mutant verdicts must equal the one-shot transport's.
  Measured on this fixture: 137 s one-shot, 31 s server, 20 s server+resource. The fixture
  UNDERSTATES the last one, because two files make a compile cheap (the mode exists for the
  65 s-per-invocation case).
- **Platform-app pin** (R147): the gate pins `executionContexts[].platformAppsDir`. A ONE-SHOT leg
  that did not pin al-runner's platform-app directory fails the gate and emits an
  `al-runner-platform-apps-unpinned` warning naming which check refused. The pin is consumed by the
  two one-shot legs only; the `--server` and resource legs never receive it, so the gate asserts it
  on the one-shot legs alone. Since R242 the report records the field only where the pin was sent,
  so it is absent on the `--server` and resource legs, and the gate asserts that.
- **Symbol sets** (R321): `fixtures/sandbox-symbols` + `-tests` under `[LETHALA]` and `[LETHALB]`,
  each through the one-shot, `--server` and resource legs. Frozen per set since R214 (re-frozen
  24e3312a, 2026-10-01): **5 / 4 / 0** over 9. Each build mutates only the arm it compiles, so the
  per-mutant check, not the counts, separates the sets. Every leg must match the pre-committed
  table (`docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`, verdict and
  killing test), and the server legs must equal the one-shot leg per mutant. RED-CHECKED both ways
  defines can be lost: dropping `buildAlRunnerArgv`'s `--define` fails
  `R321 one-shot [<set>]: per-mutant verdicts differ from the pre-committed table`; dropping R319's
  daemon `--define` fails the `--server` and resource equality checks. These legs do not prove the
  R147 pin.
- **Layout leg** (R353): `fixtures/sandbox-layout` + `-tests` at `maxGuardsPerBatch` 7, which
  splits the project into TWO batches, through the one-shot and `--server` legs. Every other
  al-runner leg runs one batch, which is why R349 (the coverage index kept across `deploy()`) passed
  every gate before its fix. Frozen **7 / 3 / 0** over 10, per mutant AND per covering test against
  `docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md`, keyed `<batch>/<code>`
  because codes restart per batch. RED-CHECKED: deleting `resetLayoutState()` from `deploy()` fails
  the one-shot leg on `1/M0006` and `1/M0007` (killed to survived; their covering test moves from
  `TwiceOfThree` to `GrowAboveTen`). The `--server` leg does NOT go red and must not: the daemon
  names a covered statement's procedure itself, so only the one-shot leg can see a stale layout
  live, and the `serverSuite` half of the reset is guarded by R349's unit test alone.
- **Multi-object leg** (R383, R407): `fixtures/sandbox-multiobject`, recorded 2026-10-02 per
  `docs/superpowers/specs/2026-10-02-r383-multiobject-refusal-precommitment.md`; the admission
  table is in `docs/superpowers/specs/2026-10-09-r407-multiobject-admission-precommitment.md`.
- **Wrapped leg** (R-300b): `fixtures/sandbox-wrapped`, recorded 2026-10-06 on al-runner
  v2.12.0-main.c39ad5de (`--define` measured to ADD to `app.json`'s symbols), per
  `docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md`.
- **CLI-default leg** (R387, R394; from the owner-approved R-394 proposal): runs `sandbox-app` LAST
  through the CLI's own `buildBackend` with no transport or coverage key (`cli-default-leg.ts`), and
  checks that `--server` and the resource selector actually ran. Since R394 coverage is on by
  default, so the leg is frozen at **3 / 12 / 4**, EQUAL per mutant (verdict and `killingTest`) to
  leg A, in `al-runner.cli-default.baseline.json`. It was 3 / 16 / 0 under R387, with
  `SandboxPricing`'s four `survived`. Pre-commitment:
  `docs/superpowers/specs/2026-10-11-r394-coverage-default-precommitment.md`.
- **Names legs** (R557; from the owner-approved R-557 proposal): `fixtures/sandbox-names` +
  `-tests`, 12 tests, each the ONLY killer of its procedure. al-runner renames 10 of their AL names
  (space, `-`, `()`, `.`, `/`, `&`, a leading digit, the unquoted keyword `Default`, Danish
  letters), and 2 are unrenamed controls. The legs are one-shot and `--server`, under coverage
  `al-runner` and `none`. Frozen **36 / 0 / 0**, per mutant against
  `docs/superpowers/specs/2026-10-09-r557-names-precommitment.md`. RED-CHECKED: on the pre-R557 name
  builder it reads 6 / 30 / 0 (coverage none) and 6 / 0 / 30 (coverage al-runner). Recorded
  2026-10-20 on v2.12.0-main.f06ee78c. The bcdev twin is [bcdev-names.md](bcdev-names.md).
- **Kill reproduction** (R577): every kill on every leg is reproduced; `REPRODUCTION_EXPECTED` in
  `kill-reproduction.ts` pins 2 killer rows per kill, and the cli-default leg's 23 activations and
  22 `runTests` requests (measured at 102821df; the names legs' 2 is predicted, addendum a40097fc).

## Why `authoritative` stays false

`authoritative: false` still holds, but BOTH of its old reasons have moved (R220): coverage is now
read from al-runner's `--coverage`, and the canary's `transactionRollback` probe reports on 2.11.0
that a row written inside `Codeunit.Run` IS discarded by the error, which 2.7.0.0 did not. What
keeps the flag false is that coverage is CONDITIONAL. It is on by default in `lethal run` since R394
(`"alRunner.coverage": "none"` turns it off). But a file whose objects after the first are not all
code-free (permission sets, enums, interfaces, entitlements) disables it for the whole run unless
R407's frame probe admits the installed build, because al-runner reports every later object's lines
in a mixed frame (previous object's end in the source plus distance in the instrumented text),
measured on c39ad5de (R383; #3713's object loss is fixed; f06ee78c is admitted). A refused
`#if`-wrapped file disables it too (R298; 15 of 519 BC.History projects, none in CDO, DC or DO;
R579, R580). A capability flag that depends on the project's file layout is not a capability.

## History of al-runner versions on this gate

- **v2.7.0.0** (2026-08-28, a FOUR-minor jump from 2.3.1.0 that the gate had never seen): all 19
  per-mutant verdicts UNCHANGED and R129's `[bc]` announcement still parses. But the bump exposed a
  LethAL DEFECT the gate caught: R147 read only the COLD-cache sentence
  `[provision] Downloaded <N> app(s) ... to <dir>`, so the pin engaged only on a run that actually
  downloaded, i.e. the optimisation switched itself off whenever the cache was healthy. A warm 2.7.0
  prints `[provision] platform apps already complete at <dir>.` instead; both are now read, and two
  sibling sentences in the same output (the ENGINE directory and the test toolkit) are pinned by
  test as things that must NOT match.
- Also in 2.7.0: `--auto-provision` is ON BY DEFAULT and kept only for back-compat,
  `--no-auto-provision` is new, and a `provision` subcommand exists that LethAL still does not use.
  The reason, that it resolved the test toolkit at the BINARY version while the run resolved the
  platform apps at the project's, held on 2.1.1.0 and 2.7.0.0 and NO LONGER REPRODUCES on 2.10.0.0,
  where both resolve to the binary's build on this fixture (R207).
- 2.1.0.0 needed `--auto-provision` in the argv, not a downgrade (R125).
- **v2.10.0.0, re-measured 2026-09-03: PASS, all 19 verdicts identical**, after al-runner's author
  read this repo and found claims that were no longer true. They were, and every one was
  user-facing prose, not code: `README.md`, the EMEA runbook and the agent guide still said "its
  `asserterror` never fails a test", a v1 finding (R7) fixed in v2 and reported
  `defect-not-reproduced` by `runAlRunnerCanary` since 2.0.0.0. This is why CLAUDE.md asks for a
  prose sweep whenever al-runner moves.
- On a warm cache 2.10 and 2.11 print NO provisioning sentence, and 2.11 searches the engine
  VARIANT's build for platform apps (`28.1.49838.54368` while `28.1.49838.54487` is selected), so
  R200's `<selected>/platform-apps` does not exist there. 2.11 names the real directory only in its
  verbose `[pkg-cache] <dir>` search-set line, which `provisionOnce` now requests through
  `AL_RUNNER_VERBOSE=1` on the provisioning call alone (R235).
- **v2.11.0**, 2026-09-26: PASS, 19 verdicts identical.
- **v2.12.0**: `[bc] selected` prints only under `AL_RUNNER_VERBOSE`, so the build is read from the
  default `[bc] warning ... not the selected <build>` line or the
  `al-runner <ver> · BC <build> · <n> apps` banner (R338). Measured 2026-09-29: PASS, 19 verdicts
  identical, symbol sets 5 / 8 / 0.
- **Pinned source build** (2026-10-02): on the Windows host the gates and lanes run a PINNED SOURCE
  BUILD of upstream main (`v2.12.0-main.c39ad5de`, BC runtime 28.5), because v2.12.0's ncl-shadow
  rewrite crashed concurrent sessions (R345) and the fix was unreleased. Measured that day: every
  figure on this page identical on it.
- The measured v2 CLI and wire contract is in `docs/measurements/README.md` §"al-runner v2"; R123 is
  the probe that would check it per session instead of by habit.
