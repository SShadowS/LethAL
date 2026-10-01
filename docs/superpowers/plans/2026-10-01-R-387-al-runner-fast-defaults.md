# R-387: `lethal run --backend al-runner` gets fast defaults (short plan)

Roadmap: `docs/roadmap/R387.md`. Nothing for this is built on any branch or worktree. I checked
`git log --all -S selectorMode` on `cli.ts`, and searched all 74 branches and every worktree.

## What is true today (read, not assumed)

- **The config section.** `AlRunnerConfigSection` (`cli.ts:2093`) has `alRunnerPath`, `packagesDir`
  and `serverMode`. `validateAlRunnerConfig` (`cli.ts:2266`) does not reject unknown keys. So a
  user who writes `"selectorMode": "resource"` today has it silently ignored.
- **What reaches the backend.** `buildBackend` (`cli.ts:2730`) passes `serverMode` only when it is
  set, and never passes `selectorMode` or `coverage`. Both are defaulted inside
  `AlRunnerBackend`: `"static"` and `"none"`.
- **The gate builds the backend itself.** Every `itest:alrunner` leg builds `AlRunnerBackend`
  directly (`al-runner.itest.ts:196-247`, with coverage hard-coded on). No leg goes through
  `cli.ts`. So a default flipped in `buildBackend` moves no gate leg. A default flipped in the
  backend CONSTRUCTOR would silently turn the one-shot legs into server legs. That is why the flip
  goes in `buildBackend` only.
- **Coverage and multi-object files.** The R383 rule (`alRunnerCoverageSupport`,
  `al-runner-coverage.ts:150`) is called only by the itest. If the CLI turned coverage on without
  calling it, a multi-object file would give false `no-coverage` verdicts.
- **CLI flags.** No backend option has a CLI flag today: bcdev's `coverageMode` and al-runner's
  `serverMode` are config-only.

## 1. Surface (config only, no CLI flags)

- **New keys** in the `alRunner` section:
  - `selectorMode: "static" | "resource"`;
  - `coverage: "al-runner" | "none"`.
- **Validation:** each value is checked, and a bad one is refused by name. **Unknown keys in
  `alRunner` are refused by name too**, so a misspelling cannot be silently ignored. This can break
  a user config that holds a stray key, so the refusal message names the key and the allowed set.
- **Threading:** through `buildBackend` (the main backend and the per-worker backends) and through
  doctor's `alRunnerStatusFor`.
- **Coverage is guarded:** when it is `"al-runner"`, the CLI first calls `alRunnerCoverageSupport`
  over the project. On a multi-object file it falls back to `"none"` and prints one warning naming
  the files, which is the module's own documented fallback. It is never a silent `no-coverage`.
- **No CLI flags.** Config-only is the established pattern for backend options. A flag would also
  ripple through FLAG_OWNERS and C02-07's pinned `DRY_RUN_REFUSED` count for no gain.
- **Afterwards:** run the `wiring-completeness` subagent over the new fields.

## 2a. Decision: flip `serverMode` and `selectorMode` (in `buildBackend` only)

- **`serverMode` defaults to `true`.** `"serverMode": false` turns it off.
- **`selectorMode` defaults to `"resource"`, but only when the server is on.** With
  `"serverMode": false`, the default stays `"static"`, because one-shot plus resource has never run
  live in any gate. An EXPLICIT one-shot plus resource is still accepted (it is the user's choice),
  but it is the one combination the advisory line names as unmeasured.
- **Why verdicts must not move:** the `--server` and resource legs are gated equal to one-shot, per
  mutant (3/12/4, plus the R321 and R353 legs).
- **What else moves:**
  - On a CLI al-runner run, `executionContexts[].platformAppsDir` and the `al-runner-platform-apps`
    event become absent, because server mode declines the R147 pin by design (R242). No committed
    sample report is an al-runner CLI report, so no schema or snapshot test moves.
  - With `--workers > 1`, each worker starts its own daemon. That costs memory, and it is named in
    the docs.
- **Doctor** mirrors the new default, so it checks the transport `run` will use. Its stale comments
  ("REFUSES `serverMode: true`", `cli.ts:4308` and `4427`) are corrected.

## 2b. Decision: coverage stays OFF by default in this task

- **Recommendation:** flip it in a follow-up, not here. Two reasons:
  - **R383 is not re-measured on 2.12.0.** The fallback above makes a flip safe, but the multi-object
    rule's premise (upstream #3713) may already be fixed in 2.12.0. If it is, the rule should go,
    not be defaulted around.
  - **It moves verdicts by design.** The pre-commitment for the follow-up would be, on
    `fixtures/sandbox-app` through the CLI: `SandboxPricing`'s 4 mutants go from `survived` to
    `no-coverage`, nothing else moves, and the CLI goes from 3/16/0 to 3/12/4. That equals the
    gate's legs and the R220 pre-commitment
    (`docs/superpowers/specs/2026-09-09-r220-alrunner-coverage-precommitment.md`).
- **To file:** a roadmap item for the flip that needs that pre-commitment, using the next free id
  from `roadmap-next-id.ts`.

## 3. The advisory line

- **When:** one stderr `[lethal]` line on an al-runner `run`, after the canary announcement, like the
  envTool-ignored warning at `cli.ts:3555`.
- **What it names:** each effective slow or unmeasured setting, with the config key that changes it:
  - `alRunner.serverMode: false`;
  - `selectorMode: "static"`;
  - `coverage: "none"`, which prints by default until 2b lands;
  - explicit one-shot plus resource.
- **Not a `Caveat`:** an advisory needs no report field, and a `Caveat` would ripple through
  `CAVEAT_INTERPRETATIONS` and the counts.

## 4. Measure (al-runner, only after your go; I tell you when I stop)

- **Setup:** a scratch config with `alRunnerPath` set (the gitignored local configs lack it).
- **Runs:** `lethal run` on `fixtures/sandbox-app` + `sandbox-tests`, three runs one after another:
  - (i) the old defaults, set explicitly (`serverMode: false`, `selectorMode: "static"`);
  - (ii) the new defaults, with no keys set;
  - (iii) the new defaults plus `coverage: "al-runner"`, for the record only.
- **Recorded:** wall time for each.
- **Verdict check:** `report-diff.ts` (i) against (ii) must be IDENTICAL per mutant, at 3/16/0. That
  is also the first end-to-end CLI check of server plus resource.
- **Expectation:** about 137 s against about 20 s on this 2-file fixture (R222). That is stated as a
  prediction, not a result.

## 5. Tests, gates, docs

- **Unit tests, each red-checked:**
  - the `buildBackend` defaults;
  - `serverMode: false` gives static;
  - the explicit choices are honoured;
  - unknown keys and bad values are refused;
  - the coverage fallback on a multi-object file;
  - the advisory line's content.
- **Existing test that changes:** `cli-selector-ids.test.ts:145` reads the static selector file
  without a deploy. It gets an explicit `"static"`, and a resource twin is added.
- **Gates:**
  - `bun scripts/verify.ts` (full suite);
  - `itest:alrunner`, after your go, with every frozen figure unchanged. A moved verdict blocks, for
    the owner.
- **Docs:** `README.md`, `docs/using-lethal-from-an-agent.md` and `fixtures/README.md`. These
  passages are stale and get fixed:
  - the README and the agent guide say LethAL reads al-runner's coverage, which is false from the
    CLI;
  - `fixtures/README.md` shows 3/13/0, the removed `ServerTransport` and an old sample config.
- **CHANGELOG:** the two default flips, the new keys, and the strict unknown-key refusal as a
  breaking change.

## Out of scope

Flipping coverage (2b), CLI flags, and the R383 re-measure.
