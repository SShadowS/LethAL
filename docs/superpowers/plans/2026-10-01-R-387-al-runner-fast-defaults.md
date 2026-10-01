# R-387: `lethal run --backend al-runner` gets fast defaults (short plan, r2)

Roadmap: `docs/roadmap/R387.md`. Nothing for this is built on any branch or worktree. I checked
`git log --all -S selectorMode` on `cli.ts`, and searched all 74 branches and every worktree.

r2 answers the r1 review (`H:/lethal-coord/reviews/R-387-plan/review-r1.md`) and the rulings in
`task.md`, findings 1 to 5.

## What is true today (read, not assumed)

- **The config section.** `AlRunnerConfigSection` (`cli.ts:2093`) has `alRunnerPath`, `packagesDir`
  and `serverMode`. `validateAlRunnerConfig` (`cli.ts:2266`) refuses `stubsDir` by name and accepts
  any other key, so a misspelled key is silently ignored.
- **What reaches the backend.** `buildBackend` (`cli.ts:2730`) never passes `selectorMode` or
  `coverage`, so they default inside `AlRunnerBackend` to `"static"` and `"none"`.
- **The gate builds the backend itself.** Every `itest:alrunner` leg builds `AlRunnerBackend`
  directly, with coverage on (`al-runner.itest.ts:196-247`). No leg tests `buildBackend`. So no
  leg sees the CLI defaults (finding 1). The flip goes in `buildBackend` only. A flip in the backend
  CONSTRUCTOR would silently turn the one-shot legs into server legs.

## 1. Surface (config only, no CLI flags)

- **New keys** in the `alRunner` section:
  - `selectorMode: "static" | "resource"`;
  - `coverage: "al-runner" | "none"`.
- **Validation:** each value is checked, and a bad one is refused by name.
- **Threading:** through `buildBackend` (the main backend and the per-worker backends).
- **No CLI flags.** bcdev's `coverageMode` and al-runner's `serverMode` are config-only today, so
  this follows the established pattern.
- **Afterwards:** run the `wiring-completeness` subagent over the new fields.

**Unknown keys are refused (finding 4).**
- `validateAlRunnerConfig` refuses an unknown `alRunner` key by name, and lists the allowed keys.
- The specific `stubsDir` diagnostic is KEPT, with its own message and the existing test at
  `cli.test.ts:870-901`.
- **Audit, done for this plan:**
  - Committed JSON files: none holds an `alRunner` block.
  - Docs: only `fixtures/README.md:1449-1457` shows one, with `alRunnerPath` and `packagesDir`.
  - The gitignored configs in every worktree on this machine (sandbox-app and sandbox-data, both
    `local` and `agent`) hold only `alRunnerPath` and `packagesDir`.
  - The test sources hold 11 single-line `alRunner: {` literals, all with `alRunnerPath` only.
- **Re-audit in the build:** multi-line literals in tests too, listed in the submit.
- **Tests:**
  - a stray key is refused by its name;
  - every documented and audited shape is accepted.
- **CHANGELOG:** the refusal is listed as a breaking change.

**Coverage is exposed, with a complete guard (finding 2, the BLOCKER).**
- **What is wrong now:** `alRunnerCoverageSupport` refuses only multi-object files. The index then
  also drops any file whose object is wrapped in `#if` (`fileHoldsWrappedObject`,
  `al-runner-coverage.ts:186`), so those mutants would read as a false `no-coverage`.
- **The fix:** the pre-run guard runs the SAME `fileHoldsWrappedObject` check over the source and
  returns `wrappedObjectFiles` beside `multiObjectFiles`. If either list is non-empty, the run falls
  back to `"none"` and prints one named warning listing those files. One rule, shared with the
  index, so the two cannot drift.
- **Tests, each red-checked:**
  - a single `#if`-wrapped object falls back;
  - a multi-object file falls back;
  - a clean project keeps coverage on.

## 2a. Decision: flip `serverMode` and `selectorMode`, in `buildBackend` only

- **`serverMode` defaults to `true`.** `"serverMode": false` turns it off.
- **`selectorMode` defaults to `"resource"` only when the server is on.** This is a POLICY, not a
  technical need (finding 5): resource also works one-shot, but no gate has ever run one-shot plus
  resource live. With `"serverMode": false` the default stays `"static"`. An EXPLICIT one-shot plus
  resource is accepted, and the advisory line names it as unmeasured.
- **The claim, narrowed (finding 3):** "verdicts do not move" is claimed only for the measured
  fixtures:
  - sandbox-app, by the new leg and the A/B runs;
  - the R321 and R353 legs, as today.
  Two server-mode differences can move a verdict elsewhere, and they are checked or stated:
  - **The R147 pin.** Server mode declines it, so platform apps resolve differently. The A/B runs
    and the new leg RECORD the BC build and the platform-app directory each transport selects:
    - one-shot reads them from `[bc]` and `[provision]`;
    - the server reads them from the daemon's output, or else from a one-time `al-runner --version`
      and provisioning probe.
    They are compared, and a difference is reported. If the daemon does not name them, that is
    stated as a limit and not inferred.
  - **The request deadline.** The server runs the whole suite under one long deadline (at least
    10 minutes), where one-shot sends a per-test timeout. A hanging test can change from a
    runner-confirmed timeout to a server error. This is checked OFFLINE with a fake daemon that
    never answers, which pins what the server path classifies it as. A LIVE hang is not run:
    R164 bars hang-capable sites from scored gates, and no al-runner hang fixture exists. It is
    stated as a limit and filed as a roadmap item.
- **Workers:** with `--workers > 1`, each worker starts its own daemon. The docs say so.
- **Doctor (finding 5):** `status()` only runs `--version`, so doctor does NOT verify the transport.
  The plan's r1 claim is dropped, and doctor's stale "REFUSES `serverMode: true`" comments
  (`cli.ts:4308` and `4427`) are corrected.

## 2b. Decision: coverage stays OFF by default in this task

- It is exposed (section 1), guarded, and off by default.
- **Follow-up flip, filed as a roadmap item** (next id from `roadmap-next-id.ts`). It needs:
  - R383 re-measured on 2.12.0;
  - a pre-commitment. On `fixtures/sandbox-app`, `SandboxPricing`'s 4 mutants move from
    `survived` to `no-coverage`, nothing else moves, and the CLI goes from 3/16/0 to 3/12/4,
    matching the R220 pre-commitment
    (`docs/superpowers/specs/2026-09-09-r220-alrunner-coverage-precommitment.md`).

## 3. The advisory line

- **When:** one stderr `[lethal]` line on an al-runner `run`, placed like the envTool-ignored
  warning (`cli.ts:3555`).
- **What it names:** each effective slow or unmeasured setting, with the config key that changes it:
  - `serverMode: false`;
  - `selectorMode: "static"`;
  - `coverage: "none"`, which prints by default until 2b lands;
  - explicit one-shot plus resource.
- **Not a `Caveat`:** an advisory needs no report field.

## 4. A lasting CLI-default leg in `itest:alrunner` (finding 1)

- **What it runs:** a new leg on sandbox-app goes through `buildBackend` with an `alRunner` section
  that sets NO transport keys.
- **Its control:** the existing one-shot leg A (coverage on). The figures are pre-committed in
  `docs/superpowers/specs/2026-10-01-r387-cli-default-leg-precommitment.md` BEFORE the first run:
  - 3/16/0 over 19;
  - every mutant has the same verdict and killing test as leg A, except `SandboxPricing`'s 4
    mutants, which are `survived` here and `no-coverage` there (coverage is off by default);
  - the leg is serialized after the existing legs (R345).
- **Evidence the mechanism ran,** independent of the config:
  - `buildBackend` gains an injectable spawn in its existing `deps` parameter, which the leg wraps
    with a recorder;
  - server: exactly one spawn with `--server` per worker, and NO one-shot test spawn;
  - resource: the selector resource file exists after `deploy()`, it changes on each `activate()`,
    and the compile count is one per batch, not one per mutant.
- **Red-check:** revert each default separately and see its own assertion fail:
  - `serverMode` back to off: the server assertion fails;
  - `selectorMode` back to static: the resource assertion fails.
  Both are reported, as are the BC build and platform-app directory recorded in section 2a.
- **Baseline:** `al-runner.cli-default.baseline.json`, recorded once under R332's record mode,
  never as a pass.

## 5. Measure, tests, gates, docs

- **Measure.** al-runner runs happen only after your go, one at a time, and I tell you when I stop.
  - Three CLI runs on sandbox-app: (i) the old defaults set explicitly, (ii) the new defaults,
    (iii) the new defaults plus coverage.
  - Recorded: wall time, and the BC build and platform-app directory for each.
  - `report-diff.ts` (i) against (ii) must be IDENTICAL per mutant.
  - Expectation, stated only as a prediction: about 137 s against about 20 s.
- **Unit tests, each red-checked:**
  - the `buildBackend` defaults;
  - `serverMode: false` gives static;
  - the explicit choices are honoured;
  - the key refusals;
  - the coverage guard (section 1);
  - the advisory line's content;
  - the never-answering daemon (section 2a).
- **`cli-selector-ids.test.ts:145`:** it gets an explicit `"static"`. Its resource twin calls
  `deploy()` before `activate()`, so it shows the resource layout is actually installed.
- **Gates:** `bun scripts/verify.ts`, then `itest:alrunner` with every frozen figure unchanged plus
  the new leg's figures. A moved verdict blocks, for the owner.
- **Docs:**
  - `README.md`, `docs/using-lethal-from-an-agent.md` and `fixtures/README.md`;
  - the stale coverage claims, the 3/13/0 figures, the `ServerTransport` reference and the old
    sample config;
  - the CLAUDE.md al-runner gate paragraph needs one sentence on the new leg, which goes to you as
    a proposed line rather than an edit.
- **CHANGELOG:** the two flips, the new keys, the coverage guard, and the strict-key refusal as a
  breaking change.

## Out of scope

Flipping coverage (2b), CLI flags, the R383 re-measure, and a live al-runner hang fixture.
