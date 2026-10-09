# R-407 plan r3 (lethal-code): r2 plus the adversary-r2 fixes

`plan.r1.md` and `plan.r2.md` hold except as changed here. F-numbers refer to `adversary-r2.md`.

## Admission plumbing (replaces r2's section; F1)
- **A constructor field.** Admission is a field of `AlRunnerBackend`'s constructor config: `admitMultiObjectFiles`,
  a typed value, still never a config-file key. It is set at every construction site:
  - `cli.ts` `buildBackend`, from the guard's result: the main backend AND the pre-built `workerBackends`, which
    use the same `build`;
  - the itest helper (`al-runner.itest.ts`), from `withAlRunnerCoverageGuard`'s result. The helper's throw on
    `!support.supported` while coverage is on is replaced by reading the guard's admission;
  - `scripts/r534-probe/run.ts` and `scripts/r518-probe/run.ts`: they leave admission unset, which is safe given the
    backstop.
- **The backstop in `coverageIndexOf`.** Coverage is on, the index lists multi-object files, and admission is not
  `true`: throw `AlRunnerCoverageFrameError`, naming the files.
  - Any construction path that misses admission therefore fails loudly instead of silently scoring reached mutants
    no-coverage.
  - The guard makes that state impossible today, so it costs nothing.
  - P3 gains a test that goes red when the throw is removed.

## Label backstop (replaces r2's F2 bullet; F2)
For an ADMITTED multi-object file, every coverage label must RESOLVE INSIDE THE ACTIVE BUNDLE FOLDER, else throw
`AlRunnerCoverageFrameError` (file, label, build).
- One-shot labels are relative and resolve against the session's spawn cwd. The transport sets none, so that is
  lethal's own cwd, made explicit in the check.
- Server labels are absolute.
- The trailing-segment match (`fileKeyCandidates`) is NOT used for this check. It would accept a source or batch
  label ending in the same key.

P5 covers each failing label once, a single-object file with the same labels not throwing, and the red revert:
- a source label;
- a batch-sibling label (`<instrumentedDir>/batch-<n>/...`, the R219 shape);
- relative and absolute forms.

## Probe pin (amends r2; F3)
Only the ONE-SHOT probe takes the platform-app pin. The `--server` probe runs the daemon exactly as the session
does, which has no pin (`usePlatformAppsDir` is false under `--server`).

## Addenda from adversary-r3 (SOUND; folded before the build)
- **The itest helper RUNS the probe** for each leg's transport, through the same guard function. It does not only
  swap its throw for a flag.
- **The label check's folder** comes from the coverage index's own `instrumentedDir` (the deployed `active` folder),
  not a fresh `activeDir()`. The comparison uses a trailing `/` after `dirKey` normalisation.
- **No index before deploy.** Building an admitted multi-object file's index before any `deploy()` throws
  `AlRunnerCoverageFrameError`. Without a deploy, `activeDir()` falls back to the batch folders' parent, which
  would let a batch label pass.
- **A wider probe layout** narrows the one-shot "right label, wrong lines" gap:
  - a `<root>/inst/batch-1` sibling with the same app id and the same instrumented file;
  - `Probe A` a non-codeunit object with code (a table with a trigger), `Probe B` a codeunit.

  The expected lines are still MEASURED from the 43f76177 capture of this final layout.

## P4 (amends r2; F4, optional)
Also on c39ad5de, a run with the target `.app` placed in `<root>/tests/.alpackages` and the sibling present. This
records whether a package-cache copy changes discovery on the old build. Run it if the c39ad5de build succeeds; it
is not a gate.


---

# R-407 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`.

## The probe (r1 item 1, changed)
- **F3, layout fixed exactly.** `<root>/src` is the source target. Its `app.json` copies the project's
  `application`/`platform`/`runtime` (F5) and has a fixed probe app id. `<root>/tests` is the test app, declaring
  the target by that id (non-optional) and having no `.alpackages`. `<root>/inst/active` is the instrumented bundle
  with the same id. al-runner is spawned with `cwd = <root>`, so Cobertura's cwd-relative paths are defined.
- **The file.** `Probe A` then `Probe B`. A is longer in the instrumented text than in `src`, so a source-frame report
  shifts B by a known, non-zero amount.
- **F1, the session's own transport.**
  - When the session runs `--server` (the default since R387), the probe sends one `runTests` through
    `AlRunnerServer`, with coverage and per-test coverage, and the session's selector mode.
  - Otherwise it makes one one-shot run.
  - The probe is answered for the transport the session will use, never inferred from the other one.
- **F6, expected lines MEASURED.** The expected hit set (Probe B's lines) and the expected path form come from a
  capture of the finished probe on 43f76177, committed as fixtures. They are not derived from reasoning.
- **Admitted only when** the run completed, the test passed, and coverage was read, AND:
  - B's hits equal the measured set;
  - A has no hit;
  - every label for the file resolves into `<root>/inst/active` (one-shot) or the bundle file (server).
- **Refused** otherwise. A deadline refusal is named distinctly (F5). Al-runner outcomes never throw; caller-contract
  violations do.
- **F5, the pin.** The CLI runs `provisionOnce` (as `runSession` does for R392) and passes the platform-app pin. The
  probe therefore runs under the same argv the session will use. Its cost is measured cold and warm on 43f76177.

## Admission plumbing (r1 item 2, changed; F4)
- **Not config.** Admission is NOT a config key. The guard returns `{ config, multiObjectAdmission }`.
- **Explicit hand-off.** `runFromCli` passes the admission to `runSession` as a typed option (beside `coverageMode`),
  and from there to every `AlRunnerBackend` the session builds (workers included). The backend passes it to
  `buildAlRunnerCoverageIndex(..., { admitMultiObjectFiles })`.
- **Refused in config.** An `admitMultiObjectFiles` key in a config file stays unknown to `AL_RUNNER_KEYS`, so the
  existing strict key check refuses it. A test pins that.
- **The itest helper** `withAlRunnerCoverageGuard` returns both values, and its callers pass the admission on.

## Session backstops (new; F1, F2)
For an ADMITTED multi-object file:
- the index keys only the instrumented path. A SOURCE-path label for that file (R219 `sourceProjectDir`) THROWS
  `AlRunnerCoverageFrameError` naming the file, the label and the al-runner build;
- in the `--server` procedure rule, "scope disagrees, position wins" THROWS for that file instead of warning.

Single-object files keep today's behaviour exactly. A run that hits a backstop fails loudly; it never silently
mis-attributes.

## Tests (r1 section changed; F6, F4, F3)
- **P1** synthetic captures, each failing ONE oracle; each check's revert must turn exactly its own case red:
  - correct lines with the source path (path oracle);
  - lines shifted with the bundle path (line oracle);
  - B correct plus one stray A hit (A-silence oracle).
  The measured 43f76177 probe capture is the positive, and the old c39ad5de capture is a combined negative.
- **P2** incomplete answers refuse: test failed, no coverage, spawn error, deadline (named).
- **P3** through `buildBackend`/`runSession` with fakes:
  - admitted gives every worker backend's index admitting;
  - refused gives coverage `"none"` and a warning naming the reason;
  - no multi-object file gives a probe call count of 0;
  - an `admitMultiObjectFiles` config key is refused.
  - Red checks: always-admit, always-refuse, and admission dropped before the workers (the last turns reached
    mutants no-coverage, which the test must catch).
- **P5** (backstops):
  - a source-path label on an admitted multi-object file throws (red: drop the throw);
  - "position wins" on an admitted file throws (red: back to warn);
  - the same inputs on a single-object file do not throw.
- **P4** (live negative control, F3), through the PRODUCTION probe function from the repo-root cwd:
  - c39ad5de, built in a scratch tool path (fetch by sha, since `--depth 50` cannot reach it; fallback: ask the
    owner for the host copy): `refused`, measured shift and source path;
  - c39ad5de with `<root>/src` deleted (the layout control): `admitted`, which proves the sibling causes the
    refusal;
  - 43f76177: `admitted`, on one-shot AND server.

  Recorded in the build log (it needs built binaries).

## Gate (r1 section changed; F7, Q2)
- **`itest:alrunner` REQUIRES `admitted`** on every leg it runs. The multi-object legs move to the FUTURE table
  (bc2511ba: 6 / 1 / 5), a re-freeze of `al-runner.multiobject.baseline.json` under R332, pre-committed.
- **The host pin** (Windows, c39ad5de) must move to a build with #5249 before the host runs this gate. That is an
  owner step, and the plan asks for it.
  - Until then, the gate on the host is expected to FAIL on the probe line, by name. It must not fall back to the
    refusal table.
  - If the owner keeps the pin: a committed known-refused list with c39ad5de only, so an unknown build must say
    `admitted`.
- **Other fixtures.** Before pre-committing, I measure offline which other itest:alrunner fixtures hold a
  multi-object file, and pre-commit each moving figure.

## Report (Q1)
A warning/console line only, printed on admission as well as on refusal, with the probe outcome and the build
banner. R355's `coverageMode` already records the effective mode, so no `SessionReport` field is added.


---

# R-407 plan r1 (lethal-code): admit multi-object files to al-runner coverage, gated by a frame probe

Base: master bcf4ca32. Branch `lethal/r407`. Step-1 measurement: `/coord/handoff/R-407/measure.md` (captures and
scripts beside it).

## Measured (step 1)

On al-runner `v2.12.0-main.43f76177` (container current) and `c5bbaf89` (next candidate), one-shot and `--server`,
the R383 layout gives the control's lines for every object of `MultiPair.Codeunit.al`:
- ReachedBothWays: 33 35 40 45 50 57 58 59.
- CallsNever: 8 10 14 20.

That layout is the test project beside a copy of the source fixture that has the SAME app id. The coverage is
labelled with the INSTRUMENTED path (`<bundle>/MultiPair.Codeunit.al`). On c39ad5de it was labelled with the
SOURCE path (`fixtures/sandbox-multiobject/src/...`) and every later object came back 17 lines early.

Upstream #5249 (merge 3c350f65, 2026-10-02) closed #5222 and is in both builds. Attribution through
`admitMultiObjectFiles: true` passes 32 of 32 checks.

There is no negative control yet. c39ad5de is not installed in the container, and the Windows host gates still run
the PINNED c39ad5de (CLAUDE.md). So admission must NOT be unconditional: on the host it would mis-attribute
silently, which is the wrong-claim direction.

## Change (orchestrator's preference: option (a), a fail-closed runtime probe)

1. **The frame probe.** New `al-runner-frame-probe.ts`, modelled on R392's `al-runner-predefined-probe.ts`: a
   scratch project, ONE one-shot run through the same `OneShotTransport`/argv builder, and a complete-answer rule.
   - **Layout** (the R383 shape that triggers source discovery): a target app whose single file holds TWO codeunits
     (`Probe A` first, `Probe B` second, with enough lines that a shift is unambiguous). Its instrumented copy is
     the bundle handed to al-runner, a SIBLING source folder carries the same app id and the un-instrumented text
     (A shorter than in the bundle, so a source-frame report would shift B), and a test app calls one procedure
     of `Probe B` only.
   - **Answer.** `admitted` only when ALL hold:
     - the run completed, the one test passed, and coverage was read;
     - every hit line for the file equals the expected instrumented lines of `Probe B`'s procedure, and `Probe A`
       has no hit;
     - the reported path resolves into the bundle, not the sibling source.
   - **Anything else** gives `refused`, with the measured lines and path in the reason. That includes a shift, a
     source path, no coverage, a spawn error, or the deadline.
   - **The second oracle.** The path check is a second, independent oracle. The defect's mechanism was
     "labelled with the SOURCE path", so a build that fixes the lines but not the label, or the reverse, still
     refuses.
   - **Errors.** It NEVER throws for an al-runner outcome (it becomes `refused`), like `runAlRunnerContractProbe`.
     A caller-contract violation (missing al-runner path) throws.
2. **Where it runs.** Only when the project HAS a multi-object file (`alRunnerCoverageSupport(...).multiObjectFiles`
   non-empty) and coverage is `"al-runner"`, at the point the CLI guard decides today
   (`applyAlRunnerCoverageGuard`, before `runSession`, so `BackendCapabilities.coverage` is still decided up front),
   once per session.
   - `admitted`: multi-object files no longer trip the guard. The session's coverage index is built with
     `admitMultiObjectFiles: true`, threaded from the guard's answer through the existing options into the
     al-runner backend's index build.
   - `refused`: today's behaviour exactly (coverage `"none"` for the run). The warning keeps the multi-object
     sentence and adds the probe's measured reason and the al-runner build banner.
   - `#if`-wrapped files keep their own refusal, unchanged.
3. **`alRunnerCoverageSupport`.** `supported` is kept as it is: the raw multi-object question. The guard adds the
   probe on top. No other caller changes meaning.
4. **The report says so.** A run that admitted multi-object files records the probe outcome where the contract
   probe's facts go (`contractSummary`'s neighbour). The orchestrator decides whether that is a new `SessionReport`
   field (the R-ripple: events, fold, report, schemas, snapshot, sample reports) or a warning line only.
   Recommendation: a warning/console line only for r1, since nothing reads it programmatically. (Open question
   for the review.)
5. **Docs sweep** (CLAUDE.md "when al-runner moves, sweep the prose"):
   - R407.md (close), R383.md (pointer), `al-runner-coverage.ts` and `line-map.ts` headers (the c39ad5de
     sentences become "on builds the frame probe refuses"), `docs/measurements/README.md` §"al-runner v2", and the
     agent guide.
   - CLAUDE.md's "a file whose objects after the first ... disables it for the whole run ... (R383; re-admission is
     R407)" is NOT mine to edit on a peer's request. I list the exact replacement sentence for the owner.

## Cost

One extra one-shot al-runner process, only for a project with a multi-object file. It is to be MEASURED in the build
on 43f76177 (wall time cold and warm, beside the contract probe's). If it is above about 30 s warm, report it, and
the orchestrator rules between (a) and (b), a known-build check.

## Tests (each red-checked one direction at a time)

- **P1** (unit, stateful fake spawn): the probe answers `admitted` on a capture equal to the new
  `43f76177-oneshot-same-*` shape and `refused` on the old c39ad5de capture (`cobertura-reached-both-ways.xml`:
  shifted lines AND the source path).
  - Red: invert the line check, and separately the path check, so each oracle is shown load-bearing.
- **P2**: `refused` on each incomplete answer: test failed, no coverage, spawn error, deadline, an A hit.
- **P3** (guard): a multi-object project with probe `admitted` keeps coverage `"al-runner"` and the index admits.
  With `refused`, coverage is `"none"` and the warning names the probe reason. With no multi-object file, the
  probe is NOT run (call counter 0).
  - Red: remove the probe call (always admit), and separately make it always refuse.
- **P4** (live, negative control): build c39ad5de from source in a SCRATCH dir (`al-runner-update.sh`'s
  `dotnet pack` + `tool install` steps, `--tool-path` under the session scratchpad; `current` and `$tools` are not
  touched). Run the real probe against it: expect `refused` with the -17 shift and the source path. Against
  43f76177: `admitted`.
  - The probe's real red test against a real broken build. Recorded in the build log, not a unit test, because it
    needs a built binary.
- `r383-real-frame.test.ts`: keep the c39ad5de captures as the probe's negative evidence. Add the new 43f76177
  captures as the positive evidence. Reword its header from "why production refuses" to "what the frame probe
  separates".

## Live gate (itest:alrunner, no BC; pre-commit before running)

- The multi-object legs move from the REFUSAL table
  (`docs/superpowers/specs/2026-10-02-r383-multiobject-refusal-precommitment.md`) to the FUTURE table
  (`2026-10-02-r383-multiobject-precommitment.md`, bc2511ba: killed 6 / survived 1 / no-coverage 5, which bcdev
  already matches). That is a re-freeze of `al-runner.multiobject.baseline.json` under R332.
- Before that I measure offline which other itest:alrunner fixtures hold a multi-object file. Each such leg's
  figures are pre-committed the same way. Expected none; to be checked.
- The gate prints the probe outcome. On the container build it must say `admitted`.
- The Windows host stays on c39ad5de until the owner moves the pin. There the probe refuses, and the multi-object
  legs keep the REFUSAL table. So the gate must accept the table that matches the probe's answer, and assert the
  probe answer matches the build: admitted on a build the probe admits, the refusal table otherwise. Each table
  is pre-committed.
  - Alternative: the gate requires `admitted`, and the host pin moves first (an owner step).
  - Open question for the review and orchestrator.

## Scheme

None. Coverage does not enter identity.


---

