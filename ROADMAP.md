# LethAL Roadmap — open work and known limitations

Living list of everything known-but-not-done: planned work, correctness risks we have measured and
not yet closed, and product gaps a real user would hit. Session ledgers under `.superpowers/` are
scratch and get archived; **this file is the durable record.**

## How to use this file

- **Add an item the moment it is discovered**, even mid-task — one line of "what breaks, for whom"
  beats a perfect write-up later. Items get a stable `R<n>` id; never renumber, never reuse an id.
- **Every item names its evidence** — a file, a commit, a measured result. An item with no evidence
  pointer is a rumour, not a roadmap entry.
- **Status:** `open` · `in progress` · `blocked (<on what>)` · `done (<commit>)`.
- **Closing an item:** mark it `done` with the commit, leave it in place for one release cycle, then
  delete it. Deleted items live on in git history.
- **Do not** duplicate what the code or `design.md` already says. This file records what is *missing*
  or *wrong*, not how the system works.

Priority is deliberately not a column: the ordering inside each section is the priority.

---

## Next up

| id | item | status |
|---|---|---|
| **R10** | **Tier-2 Phase 1 — the first real Tier-2 operators.** Spec: `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md`. Phase 0 (merged 2026-07-25) proved table triggers mutate, execute and kill on a live server; Phase 1 writes the operators that target them. | open |
| **R12** | **Live proof of a dedup collision.** `dedupeSpecs` is unit-proven and runs on the live path, but no two Tier-1 operators claim the same site, so the collision branch has never fired against a real server. Do it at Phase 1's gate, with a real Tier-1/Tier-2 overlap — do not fake one with a throwaway duplicate operator. | blocked (R10) |
| **R11** | **`tierRank` has no tier-3 rank.** A tier-3 operator colliding with a tier-1 one hits "cannot order" and throws instead of resolving by precedence. Fix when tier 3 becomes real. | blocked (R13) |
| **R13** | **Tier-3 operators.** Design not started; sequenced after Tier 2 ships. | open |
| **R15** | **Custom environment tool support** — run LethAL against environments owned by an external CLI (first case: Continia's `continia.exe`), described purely in config: tool path plus command templates for create / resolve / symbols / publish / delete. The tool provisions; LethAL's fenced `RunMutant` path still decides every verdict. Spec: `docs/superpowers/specs/2026-07-26-custom-env-tool-design.md`. **Implementation is complete and reviewed**: `packages/runner/src/{env-tool,env-tool-session,env-tool-publisher}.ts`, the `cli.ts` wiring (`resolveEnvToolSession`, `--keep-env`, `--allow-expiring-env`), and the live-gate script `packages/runner/itest/envtool.itest.ts` are all committed. Task 1's live probe against a real Continia environment measured `coverage: "procedure"` (full fidelity — see `fixtures/README.md` §"Running against an external environment tool"). **The live gate itself has not been run** — see R16. | done (gate PASSED 2026-07-26, baseline frozen) |
| **R16** | **Run the `envtool` live gate and record its baseline.** `bun run itest:envtool` (env-gated `LETHAL_ITEST_ENVTOOL=1`) is committed and wired through the real CLI seams (`resolveEnvToolSession`, `buildBackend`, `leaseSessionFor`, `resourceIdentityFor`) but has never actually been executed against a real environment — no `packages/runner/itest/envtool.baseline.json` exists yet. Needs a human decision on which Continia environment to point it at (config: gitignored `fixtures/sandbox-app/lethal.config.envtool.json`, `.env` with `CONTINIA_API_TOKEN`/`CONTINIA_ENV_ID`) and one live run to record the per-mutant baseline, the way `itest:bcdev` and `itest:tables` already did. Expected 3 killed / 10 survived / 3 no-coverage — carried over from the bcdev gate on the identical fixture, on the strength of Task 1's coverage-mode probe, but not yet confirmed by an actual `itest:envtool` run. | done (2026-07-26 — 3 killed / 10 survived / 3 no-coverage, matching the container gate) |

## Correctness risks (measured, not closed)

| id | item | status |
|---|---|---|
| **R1** | **Fenced-path write permissions.** `RunMutant` executes under the OData runner session, which does not hold the target test app's write permissions: a test that INSERTs fails with *"Sorry, the current permissions prevented the action"* while passing everywhere else. The fixture worked around it with `InherentPermissions = RIMD` (`fixtures/sandbox-data/src/*.Table.al`) — **a real customer table will not carry that**, so any project whose tests write to its own tables hits this. Needs its own answer before Tier-2 trigger operators are usable outside the fixture. Evidence: `fixtures/README.md` §Tier-2 Phase 0. | open |
| **R2** | **Single-tenant containers only, unenforced.** The harness reports `tenantCountReachable:false` — AL cannot enumerate tenants from an extension — so the 5C-B1 lease cannot fence a second tenant, and app publication is service-instance-wide regardless. Verify single-tenancy out of band (`Get-BcContainerTenants`). Evidence: `fixtures/README.md` §"Single-tenant containers only". | open (documented limitation) |
| **R8** | **al-runner drops a table global var written by a trigger.** After `Validate("No.", 'B2')` the fixture's `TouchCount()` returns 0 there, though the trigger body demonstrably ran. Unchased. Any mutant whose only observable effect is table-global state may be misjudged on that backend. Evidence: `fixtures/README.md` §Tier-2 Phase 0, last paragraph. | open |

## Product gaps a real project hits

| id | item | status |
|---|---|---|
| **R3** | **Selector object ids are hardcoded.** `DEFAULT_SELECTOR_IDS` in `packages/runner/src/cli.ts` pins 79197–79199 with no flag and no config key. A project whose `idRanges` exclude those three cannot be instrumented at all (`alc` rejects with AL0297). | open |
| **R4** | **Two instrumented projects cannot share one BC container** — a direct consequence of R3: publishing a second one fails with *"The application object of type 'CodeUnit' with the ID '79197' is defined in multiple apps"*. Multi-project users hit this immediately. Closed by fixing R3. | blocked (R3) |
| **R5** | **The report does not say how much of the project was skipped.** Object kinds the selector var cannot be injected into (page, report, query, xmlport) are dropped at spec generation with a stderr warning only, so a page-heavy project can get a confident-looking score computed over a small fraction of its code. Wants an explicit "N files not instrumented" field on the report itself. | open |
| **R6** | **A file declaring two AL objects is refused outright.** Legal AL, rare in practice. Every layer below `objectHeaderOf` assumes one object per file — the real fix is per-object attribution, not a looser check. Refusal is correct until then. Evidence: `packages/schemata/src/project.ts`, commit `81c1e96`. | open |

## Backends and tooling

| id | item | status |
|---|---|---|
| **R7** | **al-runner's `asserterror` never fails a test** — `asserterror I := 1;` is reported `pass`, so any mutant killable only by an `asserterror` assertion comes back SURVIVED there while bcdev kills it (measured: 0/7 vs 3/2/2 on the table fixture). Under-reporting only, never a false kill. The CLI now warns once per al-runner session; a stronger answer is a startup canary that runs a known-failing `asserterror` and refuses or hard-warns, or an upstream fix. Evidence: `fixtures/README.md` §Tier-2 Phase 0, `scripts/probe-alrunner-tables.ts`. | open (mitigated by warning) |
| **R9** | **`itest:tables` runs its session once**, where `itest:bcdev`/`itest:alrunner` run twice and assert run-to-run equality. Cross-run nondeterminism there surfaces as a confusing per-mutant baseline mismatch rather than an explicit determinism failure. | open |
| **R14** | **Stay on the newest tree-sitter-al.** Policy, not a defect: a grammar bump silently changed node shapes once (v2.5.0 → v3.0.1 inserted container nodes and zeroed `statementCalls` 703,239 → 0). The bump procedure — corpus site counts plus a **per-site** baseline proof, not a multiset signature — is in `packages/engine/vendor/README.md`. Re-check on every upstream release. | recurring |
| **R17** | **The env-tool crash-recovery record has a writer and no reader.** `recordCreatedEnv`/`removeRecordedEnv` maintain `~/.lethal/env-state/<runId>.json`, but nothing ever lists it. The design promises "a later `lethal run` prints a warning naming every stale entry it finds"; that scan was never built, so the whole recovery story for a leaked environment is a file nobody reads. Cheap fix: `readdir` + `console.warn` in `resolveEnvToolSession`. Evidence: `packages/runner/src/env-tool-session.ts`, final review of branch `layer-6c-env-tool`. | open |
| **R18** | **`envTool` + `--backend al-runner` is silently ignored.** `--keep-env` and `--allow-expiring-env` are refused loudly for al-runner on the reasoning that a silent no-op is wrong; an entire configured `envTool` section being ignored deserves at least the same warning. Evidence: `packages/runner/src/cli.ts` al-runner branch. | open |
| **R19** | **`publishApps` republishes unconditionally on every reuse-mode run**, before any lease is held. The control app gets verify-before-publish for exactly this reason; the test app gets no equivalent, so a shared long-lived environment can have its test app swapped under a concurrent session. Evidence: `packages/runner/src/env-tool-session.ts`. | open |
| **R20** | **`HarnessVerificationError` conflates "wrong build" with transport failures including 401/403**, so an auth blip can still trigger one needless control-app republish — which runs install/upgrade codeunits under a concurrent session's lease. Needs a distinct `HarnessAuthError` thrown from `fetchHarnessInfo`'s 401/403 branch. Plausible trigger: a freshly-created environment whose admin user 401s transiently right after start. Evidence: `packages/runner/src/harness.ts`. | open |
| **R21** | **Env-tool mode still hard-requires `altool.exe` to exist**, even though the env-tool publish path never constructs a `ContainerDeployer`. Harmless where the AL extension is installed; a confusing gate otherwise. Evidence: `packages/runner/src/cli.ts` `defaultAlToolPaths()` check. | open |
| **R22** | **Deferred test-quality gaps on the env-tool code** (each one-line, safe to fix when the file is next opened): `redact`'s longest-first ordering is never exercised (a substring-of-another-secret leak would not be caught); the publisher test's `readArtifact` fake ignores its `path` argument, so hashing the wrong file would pass; the array dot-path test indexes `"0"` of a single-element array, surviving a constant-fold mutation; a `vars` collision test's regex matches boilerplate rather than the key; two "names whichever block is missing" assertions survive a message merge. Evidence: final review of branch `layer-6c-env-tool`. | open |
| **R23** | **Nothing forbids `username`/`password` in `envTool.publish.reads`.** If a config did that, the credential-withholding rule would replace a publish failure's detail with "(output withheld)" and silently break the orchestrator's version-conflict recovery, which parses BC's rejection text out of that message. No plausible tool emits credentials from a publish command, so this is a guardrail, not a live bug. Evidence: `packages/runner/src/env-tool.ts`. | open |
| **R24** | **The env-tool bcdev-key collision check is opt-in.** `validateEnvToolConfig`'s `bcdevDeclaredKeys` parameter defaults to a no-op when omitted, so a future second caller that forgets it silently loses the "two sources for one value" guard. `resolveEnvToolSession` is the only caller today and does supply it. Make the parameter required. Evidence: `packages/runner/src/env-tool.ts`, commit `967554c`. | open |
| **R25** | **A stale locally-built `lethal-control.app` fails with a confusing error.** `*.app` is gitignored, so the control artifact is a local build — and a build older than its AL source publishes fine, then fails harness verification with `HTTP 400: the parameter 'clientProtocol' … is not a valid parameter`. Confusing precisely because the endpoint EXISTS and answers; it just rejects an argument added later. Hit live on 2026-07-26 during the first env-tool gate run. Wants either a build step that rebuilds it before a gate, or a version/shape check in `HarnessVerifier` that says "your control app is older than this client" instead of surfacing BC's parameter error. | open |

---

**Recently closed** (delete these once a release has passed):

- Tier-2 Phase 0 — table triggers mutate, execute and kill on a live server; merged 2026-07-25 (`841069c`), frozen at `itest:tables` 3 killed / 2 survived / 2 no-coverage.
- Coverage keyed on `(objectType, objectId)` rather than the bare id (`6e89948`) — a table and a codeunit sharing an id sent a trigger mutant at the wrong object's tests.
- Per-mutant time budget floored at 30 s (`ab58469`) — an unfloored `2 × baseline` quarantined a cold start as in-flight-unknown.
