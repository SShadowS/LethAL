# C02-05: Compile the test app against the installed guarded build and publish it under the lease, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-26),** after review round 1 (`H:/lethal-coord/reviews/C02-05-plan/review-r1.md`) and the orchestrator's rulings. Changed: a failed exit with an UNREADABLE read-back is unknown, never `publish-failed`, so the marker stays (finding 1, ruling 1); `runNamedMutants` checks the target with a preflight `attach` before `inLease` AND the mandatory `attach` after the rebind (finding 2, ruling 2); the marker's guarantee is stated narrowly, the marker must be absent before its publish, and the restore leg is checked at runtime (finding 3); Task 0 asserts two distinct build hashes and checks the restore read-back (finding 4); the `--resume` gap is filed only (finding 5); Task 4's server-version test and Task 2's full-argv parity pin are repaired (review "Tests to repair"). The owner questions are gone: the rulings answer both.

**Goal:** A caller that holds a verified `BoundArtifact` (C02-04b) can compile a test project against THAT artifact's symbols, publish the result inside `runNamedMutants`' lease fence, and get back an identity the SERVER confirmed: the package it now holds is byte-for-byte the one just compiled. Nothing on `lethal run`'s path changes behaviour.

**Architecture:** One new module, `packages/runner/src/test-app-publish.ts`, with two functions and one typed error. `compileTestApp` stages a scratch symbol cache (the test project's `.alpackages` minus every copy of the target, plus the bound instrumented `.app` and `lethal-control.app`) and runs `alc` through a new `ArtifactCompiler.compileProject`. `publishTestApp` reads the resident package, refuses a downgrade before claiming the fence, then inside `fence.publish` runs `ContainerDeployer.publish`, reads the package back from `dev/packages`, and decides the outcome with the target's `decidePublishOutcome` plus ONE stricter rule: a failed exit with an unreadable read-back is unknown. `BcDevMcpBackend` gains two thin methods that hand the module its own compiler, deployer, control symbol and package read. `runNamedMutants` gains one guard: nothing runs after an `inLease` that latched the session unsafe. The preflight `attach` before `inLease` is C02-04b's to build (ruling 2 amends that plan); this plan pins it from the test-app side.

**Tech Stack:** Bun + TypeScript, `bun test`, `alc`/`altool` from the AL extension.

**Spec:** GitHub issue #15 (child 5 of epic #10, c02): "`ArtifactCompiler` for the test project, `ContainerDeployer.publish`, version reservation via `app-version.ts`, then `parsePublishedApp` confirmation. Depends on: 4." Downstream: C02-06 (#16, `lethal verify`: "republishes only the test app against the already-published guarded build, toggles each named mutant, runs only its covering tests plus the new ones"). C02-06 is not built here. Decision 3 departs from the issue's "version reservation" on evidence; ruling 1 accepts that, conditional on Task 0.

**Line numbers** are as of `c21d556`. Anchor on names; C02-04 moves most of `runSession`.

## Dependency and order

This plan assumes C02-04b (`docs/superpowers/plans/2026-09-25-C02-04-run-named-mutants.md`, Tasks 6 to 8) is ACCEPTED, and uses these names from it exactly as that plan declares them. None exists on `master` or on `lethal/lane-code` at the time of writing (`137d0b1` there is Part A):

| Name | From C02-04b | Used here for |
|---|---|---|
| `runNamedMutants`, `NamedMutantsConfig.inLease` | Task 8 | the hook this task fills |
| the order preflight `attach`, `inLease`, `rebindBackend`, `attach` | Task 8, as amended by that plan's orchestrator ruling 6 (added 2026-09-26) | decision 1; Task 6 pins it |
| `LeaseFence` (`publish<T>(run)`) | decision 1 | the only way `publishTestApp` publishes |
| `BoundArtifact` (`appId`, `artifactId`, `sha256`, `appPath`, `instrumentedDir`) | Task 6, `backend.ts` | the symbols the test app compiles against |
| `loadInstalledArtifact`, `InstalledArtifactRef` | Task 6, `named-mutants.ts` | the live itest builds a `BoundArtifact` with it |
| `installedFixture`, `recording()` with `attach` in the trace | Task 8 / Task 1 test helpers | Task 6's end-to-end tests |
| `LeaseSession.publish`, `rebindBackend` | exist today (`orchestrator.ts`) | unchanged |

Order: **Task 0 (live probe) and Task 1 (roadmap filing) may run before C02-04b is accepted**, since they touch no C02-04b code. Tasks 2 to 7 start after `coord accept C02-04b` and `git merge master`, then one full test loop.

## The decisions

### 1. What C02-05 builds, and where it hooks in

Two functions, called by C02-06 in this order:

1. `compileTestApp` runs **before** `runNamedMutants`, outside the lease. It is local (alc only) and takes no server dependency by its signature, so a compile failure (Review Focus 1, 3) costs zero lease calls and zero server calls. The issue says "compile and publish under the lease"; the compile does not need the lease, and holding a lease CentralGauge shares through a 5 to 30 s compile that may fail is cost with no safety.
2. `publishTestApp(fence, compiled)` runs **inside** `inLease`. Under ruling 2 the order inside `runNamedMutants` is: acquire, **preflight `attach`**, `inLease`, `rebindBackend`, **`attach` again**, baseline. The preflight refuses (`InstalledArtifactError("mismatch")` or `"unavailable"`) before anything on the server changes when the installed target is not the bound artifact, so a test app compiled against the bound symbols is never published over another target. The second `attach` is mandatory: an observation from before the publish cannot certify the target after it, and it binds the transport after the rebind so the backend runs with the publish's op sequence. Neither is proof of the running binary (`DeploymentVerifier`'s own doc comment says so); per-run proof stays with section G's attestation. It publishes only through `fence.publish`, which is `LeaseSession.publish`: BeginPublish claims the operation marker, EndPublish tombstones it on a confirmed-terminal outcome, and an unknown outcome leaves the marker set and records `container-needs-recycle`. On success `LeaseSession` stores the publish op seq and C02-04b's `rebindBackend` re-seeds the backend's RunMutant counter from it.

C02-06 wires them like this (not built here):

```ts
const compiled = await backend.compileTestApp(testDir, bound);          // before the lease
let published: PublishedTestApp | undefined;
const res = await runNamedMutants({ ...cfg, inLease: async (fence) => {
  published = await backend.publishTestApp(fence, compiled);
} });
```

`afterLeaseAcquired` (R19, the env-tool `publishApps` path inside `runSession`) is NOT touched and NOT reused: it publishes outside the fence and verifies nothing, which is right for the operator-delegated apps it serves and wrong for a publish whose identity a verdict depends on.

### 2. How it proves the published test app is the one just compiled

**Read-back by bytes, then by version.** After the publish, `publishTestApp` calls the backend's existing `fetchPublishedAppPackage` (the dev endpoint's `dev/packages`, R139 check 2) and compares `hashPackage(bytes)` with the compiled `.app`'s `sha256`. R139 records the evidence that this is sound: "measured against Cronus283, 21,103 bytes, byte-for-byte the app that was published". The version returned in the identity is the SERVER's `NavxManifest.xml` `Version`, read with the existing `parsePublishedApp`, not the local `app.json`. Task 0 re-measures the byte equality on Cronus28 before any code depends on it.

**The outcome rule is the target's, plus one stricter case.** The read-back becomes a `DeploymentVerification` (`accepted` when the hashes match, `mismatch` with the server's hash, `unavailable` when the read returned `null`) and goes through `decidePublishOutcome(publishOk, verification)`. That function calls a failed exit with an `unavailable` identity `failed`, which is the target path's existing behaviour. For the test app it is NOT safe (ruling 1): `fetchPublishedAppPackage` returns `null` for a timeout or a refused connection, and a read that did not answer cannot show the publish did not land, or is not still landing. So `decideTestAppOutcome` maps exactly that case to `indeterminate` and otherwise returns `decidePublishOutcome`'s answer. `decidePublishOutcome` itself does not change; the target path is untouched.

| altool | read-back | outcome | `TestAppError.reason` | fence does |
|---|---|---|---|---|
| exit 0 | our bytes | `accepted` | (returns the identity) | EndPublish `succeeded`, op seq stored |
| exit != 0 | READABLE, not our bytes, AND BC's downgrade refusal text (`parseVersionConflict`) | `failed` | `publish-failed` | EndPublish `failed`, no recycle |
| exit != 0 | READABLE, not our bytes, any other failure text | `unknown` | `publish-indeterminate` | marker left set, recycle recorded (run 002 review: altool may have lost its reply after dispatch; R250 tracks anchoring the refusal text) |
| exit != 0 | unreadable (`null`) | `indeterminate` | `publish-indeterminate` | marker left, `container-needs-recycle` |
| exit 0 | not our bytes, or unreadable | `indeterminate` | `publish-indeterminate` | marker left, `container-needs-recycle` |
| exit != 0 | our bytes | `anomalous` | `publish-anomalous` | marker left, `container-needs-recycle` |

So `publish-failed` requires positive evidence: the server answered, what it holds is not ours, AND BC's own refusal text says why (implemented in run 002, orchestrator update 2026-09-26).

`isConfirmedTerminalPublishFailure` (orchestrator.ts) gains one line, placed FIRST: `if (err instanceof TestAppError) return err.confirmedTerminal;`, true only for `publish-failed`. First matters: an anomalous publish's message carries altool's text, which may contain BC's "newer version ... was already installed", and the existing `parseVersionConflict` fallback would otherwise call it terminal and tombstone a marker over a publish that landed.

**What the bytes do NOT show, and the narrower runtime probe.** Byte equality shows what `dev/packages` returns. It does not show which test code a session executes. The live itest (Task 7) adds a limited runtime probe: a newly named method, `ZzC0205Marker`. `RunOneMethod` (`RunMethod.Codeunit.al`) requires exactly one matching method, so on an app WITHOUT that method the baseline answers "found 0" and `StaleTestAppError` refuses. The guarantee is exactly this, and no more: **a green marker shows the session executed a test app that contains a method of that name, so not an app without it.** It does not show that every changed test body is the one executing. For the probe to discriminate, the marker must be ABSENT at runtime before its publish; Task 7 checks that, and checks it is absent again after the restore leg.

### 3. Versions, and why this does not mint one (departs from the issue)

**Decision: publish the test app at its OWN `app.json` version. Never call `reserveAppVersion` for it.** Evidence:

- `.claude/skills/control-app` records that a LethAL-minted `<major>.<minor>.<days>.<halfSeconds>` version makes the resident app outrank the repo's own build, so the operator's next ordinary publish is refused as a downgrade, and says of the version-bump escape: "Do NOT reach for a version bump to clear it: that leaves the container carrying a fixture whose version does not match the `app.json` in the repo, which is the state this whole section exists to avoid." Minting the TEST app would create that state for the test app on every `lethal verify`.
- R139 check 2 (`publishedTestAppWarning`) warns whenever the published version differs from `app.json`. A minted test app would make every later `lethal run` on that container print it.
- The target mints because every batch is a new artifact that must strictly supersede the last (Layer 5A). A test app has no artifact id; identity comes from decision 2's bytes, so the version carries no identity job.

**What this requires, and Task 0 measures it:** a dev-endpoint `altool publishapp` of the SAME name and version with DIFFERENT bytes must be accepted and replace the package. C02-06's loop republishes at an unchanged version on every iteration. If Task 0 shows it is refused, stop and `coord ask` (ruling 1: no fallback to minting without the owner). An older LethAL-minted TEST app resident above the local version is deliberately refused (below) until the resident record is cleaned or `app.json` is raised; there is no automatic path around it.

**The downgrade trap, both halves:**
- *Before the fence:* `publishTestApp` reads the resident package first. If its version is ABOVE the local `app.json` (`compareAppVersions`), it throws `TestAppError("version-below-resident", …, installedVersion)` before BeginPublish: no marker, no altool, a message that names both versions and the remedy from `.claude/skills/control-app` (`Sync-NAVApp -Mode Clean`, or raise `app.json` above the resident version). Equal passes (same-version replace). A `null` read (never published, or unreadable) passes to the backstop.
- *Inside the fence (backstop):* BC's own refusal ("newer version X was already installed", which also fires for a ghost install record that `Get-NAVAppInfo` does not list) exits altool non-zero while the server keeps its old bytes: `publish-failed`, terminal, with `installedVersion` from `parseVersionConflict`, but only when the read-back ANSWERED with the old bytes. The same refusal with an unreadable read-back is `publish-indeterminate` (decision 2).

### 4. Symbols: compile against the installed guarded build, never the stale copy

The test project's `.alpackages` normally holds a build of the UNINSTRUMENTED target, and R139/R157 record twice that it can be a stale build "at an unchanged version string". `compileTestApp` therefore never lets alc see it:

1. Make a scratch dir. For each `*.app` in `<testDir>/.alpackages`, read its `NavxManifest.xml` `Id` (new `readAppIdentity`, beside `parsePublishedApp`). Skip the file when the id is the target's (`BoundArtifact.appId`) or LethAL Control's (read from `controlSymbolPath`). A file whose manifest cannot be read is refused as `symbols-unreadable`, naming it: it could be the stale target. A missing `.alpackages` is not an error; alc names what it lacks.
2. Copy `BoundArtifact.appPath` in (the bytes `loadInstalledArtifact` already matched to the trusted record) and `controlSymbolPath` (the instrumented target depends on LethAL Control; `stageForCompile` injects that dependency).
3. `compiler.compileProject({ projectDir: testDir, packageCachePath: scratch, name })`: the same `alc` argv as `compile`, including R101(c)'s `/define`, into the compiler's content-addressed `outputDir`. An `AlcCompileError` becomes `TestAppError("compile-failed", <alc's text>)`, so an alc rejection of a TEST app can never be read as bisection's "this subset does not compile". `ArtifactPrepareError` passes through unchanged.

**Symbol compatibility with the target.** Instrumentation adds objects (the selector and control codeunits) and removes or renames none, and the instrumented `app.json` keeps the target's id, name and `major.minor`, with a minted version at or above any `app.json` minimum. That is the same reason the operator's test app, compiled against the plain target, keeps working after every `lethal run` republishes the guarded build. A test that references something the target does not export fails in `alc` (AL0132 and friends) as `compile-failed`, before any lease.

### 5. R56's stale-test-app guard and R192's reuse key when the test app changes

- **R56 / R139 check 1 (`StaleTestAppError`)** stays exactly as it is, inside `scoreBatch`. After a verified publish it can fire only when a named method is not in the source just compiled; its remedy text ("publishing the test app is the operator's own workflow") is then misleading but the refusal is right. C02-06 should check requested methods against `discoverTests(testDir)` before the lease, which makes it unreachable in the intended flow (see Notes for C02-06).
- **R139 check 2 (`reportPublishedTestApp`)** runs in `runSession` only; decision 2's byte read-back is strictly stronger, so `runNamedMutants` gains nothing from it.
- **R192 half 2 (baseline reuse)**: `runNamedMutants` passes no `snapshot`, so it neither reuses nor records. A later `--resume` of the run that published the target computes `testAppHashFor` from the server's package, which is now C02-05's bytes, so the key differs and that batch's baseline re-runs. Task 4 pins that `testAppHashFor` of the same bytes equals `package:` + the identity's `sha256`, so the two hashes cannot drift apart silently. This covers baseline REUSE for a batch that reaches its baseline, and nothing else: it does not validate a single carried verdict.
- **R192 half 1 and every carried verdict: a real gap, FILED in Task 1, NOT solved here.** `sessionFingerprint` keys on paths and scope (`projectDir`, `testDir`, `backend`), not on the test app's package bytes, and `batchCarriesEntirely` can skip a batch's deploy AND baseline, so `--resume` carries verdicts measured against a test app that has since been republished. It exists today (an operator republishing by hand between resumes) and C02-05 makes it routine. Nothing in this plan closes it.

### 6. al-runner

Not supported, and not needed. al-runner has no published test app: it compiles the test bundle from `testDir` on every invocation (once per session in `--server`/resource mode), which is why `testAppHashFor` falls back to the source tree ("al-runner compiles the test bundle itself, so the source IS what runs"). `runNamedMutants` already refuses it (`InstalledArtifactError("unsupported")`: no `attach`). The two methods exist on `BcDevMcpBackend` only; `ExecutionBackend` does not change. The env-tool path is also out: its `fetchPublishedAppPackage` returns `undefined` (no dev server of its own), which `publishTestApp` refuses as `unsupported` before the fence, and its environment was deleted 2026-09-01.

### 7. Live gates

It publishes, so it needs live proof on Cronus28, under a coord lease, within the runbook's standing authorization (no `coord ask`). Two runs, in this order, then the frozen gate:

1. **Task 0 probe** (before code): byte-for-byte read-back and same-version replace, measured.
2. **`LETHAL_ITEST_TESTAPP=1 bun run itest:testapp`** (new, Task 7): the whole path against a real server.
3. **`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`** right after, unchanged: 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, every kill at `killPosition` 1, zero `session-reused`, `assertionScreen.discrimination` `vacuous`. It proves the container is left gate-ready, and it exercises the `ArtifactCompiler.compile` refactor (Task 2) on every deploy.

Task 0 and Task 7 say exactly what each must show. A moved frozen figure is a BLOCK reported to the owner.

## Review Focus

Each pinned by a named test:

1. **The test app does not compile.** `TestAppError("compile-failed")` carrying alc's own text, never an `AlcCompileError`, and no server or lease call can happen because `compileTestApp` is given none. Pinned by Task 3's `"compileTestApp: an alc rejection is TestAppError compile-failed, never AlcCompileError"` and, with the real `alc`, step 4 of Task 7's itest.
2. **A test app whose version is below the resident one.** Refused before BeginPublish with both versions named, zero altool spawns; and BC's own refusal inside the fence is a confirmed-terminal `publish-failed` (EndPublish `failed`, no recycle). Pinned by Task 4's `"publishTestApp refuses a local version below the resident one before the fence"` and `"publishTestApp: a BC downgrade refusal inside the fence is publish-failed and names the installed version"`, and Task 6's `"C02-05: a confirmed test-app publish failure ends the marker as failed and records no recycle"`.
3. **A test app that references a symbol the instrumented target does not export.** alc must see the INSTALLED guarded build and only it, so a stale `.alpackages` target cannot make a bad reference compile (or a good one fail). Pinned by Task 3's `"compileTestApp compiles against the bound artifact, never the stale target copy in .alpackages"` and `"compileTestApp refuses an .alpackages entry it cannot identify, naming the file"`; the missing-symbol rejection itself by Task 7 step 4 (real alc, AL0132).
4. **Publish succeeds but the server still holds the old app, or the read-back cannot answer.** `publish-indeterminate`: marker left set, `container-needs-recycle` recorded, no identity returned. That covers an exit 0 with the old bytes, an exit 0 with an unreadable read-back, AND a FAILED exit with an unreadable read-back (ruling 1). Pinned by Task 4's `"publishTestApp: altool success but the server still holds the old package is publish-indeterminate"` and `"publishTestApp: a failed exit with an unreadable read-back is publish-indeterminate, never publish-failed"`, and Task 6's `"C02-05: an indeterminate test-app publish leaves the marker and records container-needs-recycle"` and `"C02-05: a failed exit with an unreadable read-back keeps the marker"`. The anomalous twin (failed exit, bytes landed, BC downgrade text in the message) by Task 6's `"C02-05: an anomalous publish carrying BC's downgrade text is not treated as terminal"`. At runtime, by Task 7's marker, within decision 2's narrower guarantee.
5. **The lease is lost during the publish.** BeginPublish refused: no altool spawn, `LeaseUnavailableError`, lease released. EndPublish refused after the bytes landed: the session is latched `lease-lost`, and NOTHING runs after it (no post-publish `attach`, no baseline, no mutant), every request answered `not run`. Pinned by Task 6's `"C02-05: BeginPublish refused spawns no altool and releases the lease"` and `"C02-05: a lease lost across the test-app publish runs nothing after it"`.

Also pinned: `"publishTestApp returns the server's identity only when its bytes are the compiled ones"`, `"publishTestApp returns the server's version, not app.json's"`, `"publishTestApp refuses a configuration that cannot read the package back, before the fence"`, `"the published identity's sha256 is the R192 key of the same bytes"`, `"C02-05: a server reporting another target is refused before any test-app publish"` (ruling 2's preflight), `"C02-05: a verified test-app publish is followed by rebind, attach and the baseline"` (ruling 2's post-publish check), `"compile's argv is exactly the pre-refactor argv"` (Task 2's parity claim).

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`.
- `TestAppError extends Error` directly: not `DeploymentError`, `AlcCompileError`, `InstalledArtifactError` or `NamedMutantError`, and none of those extends it.
- Fail loudly: every read or parse failure is a typed `TestAppError`; nothing returns a plausible default identity.
- Never mint a test-app version (decision 3). Never publish the test app outside `fence.publish`.
- No `SessionReport` field, event type, `Caveat` or `MutantErrorCause` value is added. `REPORT_SCHEMA_VERSION` and `STREAM_SCHEMA_VERSION` do not move; `bun scripts/generate-schemas.ts` produces no diff.
- `runSession`, `SessionConfig`, `afterLeaseAcquired` and `ExecutionBackend` do not change. The only edits on `lethal run`'s path are the `ArtifactCompiler.compile` refactor (argv byte-identical) and the one `isConfirmedTerminalPublishFailure` line (reachable only by a `TestAppError`).
- Credentials: altool gets them by environment (`ContainerDeployer`), the read-back by an `Authorization` header (`fetchPublishedAppPackage`). No `TestAppError` detail, log line or itest output may include a header, an env value or the loaded config. Read credentials from the fixture config, never echo them.
- Live work: Cronus28 only, under `coord lease Cronus28 code`, heartbeat every 5 minutes, release right after, one gate at a time. Never Cronus281/282/283.
- No em dashes in code comments or docs you write. Roadmap text cites names, never `file.ts:<line>`.

---

### Task 0: Live probe on Cronus28: byte-for-byte read-back and same-version replace

**Why first:** decisions 2 and 3 each rest on one BC fact. R139 measured the first on Cronus283; the second is not recorded anywhere in this repo.

**Files:** a throwaway script in the session scratchpad (NOT committed). Record the result in `docs/measurements/README.md` under a new short section "Dev endpoint: test-app read-back and same-version replace (C02-05)".

- [ ] **Step 1:** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`; then `coord lease Cronus28 code`.
- [ ] **Step 2:** The script loads `fixtures/sandbox-app/lethal.config.local.json` the way `packages/runner/itest/bcdev.itest.ts` does (never print it), builds a `ContainerDeployer` and a `BcDevMcpBackend` for `fetchPublishedAppPackage`, and:
  1. reads the resident `LethAL Sandbox Tests` package; prints its version and sha256;
  2. compiles `fixtures/sandbox-tests` into a scratch dir TWICE with `alc` (`/packagecachepath:fixtures/sandbox-tests/.alpackages`); prints both sha256. If they are equal, makes a scratch copy with one added comment line and compiles that as build B; otherwise build B is the second compile;
  3. **ASSERTS `hash(A) !== hash(B)`** and exits 1 WITHOUT publishing anything if they are equal (a comment-only edit that yields identical package bytes would make every later check pass without testing a replacement). If the comment copy still hashes equal, add a trivial `[Test]` method to the copy instead and re-check;
  4. publishes build A with `altool publishapp` through `ContainerDeployer`, reads back, ASSERTS `readback == A`;
  5. publishes build B (same name, same version `1.0.0.2`, other bytes), reads back, prints the altool exit code and ASSERTS `readback == B`;
  6. publishes build A again (restore), reads back, and ASSERTS `readback == A`. A failed restore is reported as its own STOP, since the container then carries build B.
- [ ] **Step 3:** Release the coord lease.
- [ ] **Step 4: Decide.** All three read-back assertions true and step 5's exit 0: decisions 2 and 3 stand, write the section (the four hashes and the exit codes). `readback != A` in step 4 after an exit 0: STOP, `coord ask` (decision 2 has no foundation on Cronus28). Step 5 refused, or `readback != B`: STOP, `coord ask` with the refusal text verbatim (ruling 1: no fallback to minting without the owner). Step 6 failed: STOP, `coord ask`, and say the container holds build B. Every other stop has run step 6 and leaves the container at build A.
- [ ] **Step 5: Commit** `docs(measurements): dev-endpoint test-app read-back and same-version replace on Cronus28 (C02-05)`.

### Task 1: File the carried-verdict gap (decision 5)

**Files:** `docs/roadmap/R<nnn>.md`, then `bun scripts/roadmap-index.ts`. Re-check the next free id with `ls docs/roadmap/` immediately before writing: R235 and R236 were already taken on `lethal/lane-code` at the time of writing, so expect R237 or later.

- [ ] **Step 1:** Write it from `_template.md`, section `correctness-risks`, status `open`. Title: "`--resume` carries verdicts measured against a test app that has since been republished: the resume fingerprint names the test directory, not the test app's content". Body: found while planning C02-05, confirmed by reading `sessionFingerprint` (keys `projectDir`, `testDir`, `backend`) and R192 half 1 (`batchCarriesEntirely` carries without a baseline). Today it needs a hand republish between resumes; C02-05/C02-06 make a republish routine. R192 half 2's `testAppHashFor` key sees the change only for baseline REUSE in a batch that reaches its baseline; it validates no carried verdict, so it does not close this. A possible fix shape: refuse or re-measure carried verdicts when the published test app's package hash differs from the one the carrying run recorded. Not measured live. Status `open`: C02-05 files it and does not solve it.
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`; `bun test scripts/roadmap-index.test.ts`.
- [ ] **Step 3: Commit** `roadmap: file R<nnn>, --resume carries verdicts across a republished test app`.

### Task 2: `ArtifactCompiler.compileProject`, and a publisher that needs only path and hash

**Files:** Modify `packages/runner/src/artifact.ts`, `packages/runner/src/publisher.ts`, `packages/runner/src/env-tool-publisher.ts`. Test: `packages/runner/tests/artifact.test.ts`.

**Interfaces:**

```ts
// artifact.ts, on ArtifactCompiler
/**
 * Compiles a project that is not a mutation artifact (C02-05's test app): the same alc argv as
 * `compile`, R101(c)'s /define included, but against the caller's package cache and with no
 * manifest. Output is content-addressed in this compiler's outputDir: `<sha256[0:16]>-<name>.app`.
 */
async compileProject(input: {
  readonly projectDir: string;
  readonly packageCachePath: string;
  readonly name: string;
}): Promise<{ readonly appPath: string; readonly sha256: string }>;

// publisher.ts
export interface AppPublisher {
  publish(artifact: Pick<CompiledArtifact, "appPath" | "sha256">): Promise<void>;
}
```

`compile` and `compileProject` share one private `alcToContentAddressed(projectDir, packageCachePath, name)` holding today's spawn, `AlcCompileError`, read, hash and rename code, moved verbatim. `compile` keeps its manifest check first and passes `this.cfg.packageCachePath` and `input.artifactId`. `ContainerDeployer.publish` and `EnvToolPublisher.publish` read only `appPath` and `sha256` today, so the narrowed parameter is type-only and every caller still typechecks.

- [ ] **Step 0: Pin the complete pre-refactor `compile` argv, on the UNMODIFIED code.** The existing `artifact.test.ts` tests check selected argv members, so their unchanged pass cannot prove parity. Add, and see PASS before touching `artifact.ts`:

```ts
describe("C02-05: compile's argv parity", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const input = (projectDir: string) => ({
    projectDir, artifactId: ID, appId: "app", appVersion: "1.0.0.0",
    mutantManifest: { artifactId: ID, mutants: [] } as unknown as MutantManifest, appManifest: {},
  });
  function recordingIo(argvs: string[][]): ArtifactIo {
    return {
      spawn: async (argv) => { argvs.push([...argv]); return { exitCode: 0, stdout: "", stderr: "" }; },
      readArtifact: async () => new TextEncoder().encode("x"),
      writeArtifact: async () => {},
    };
  }
  test("compile's argv is exactly the pre-refactor argv", async () => {
    const argvs: string[][] = [];
    await new ArtifactCompiler({ alcPath: "C:/alc.exe", packageCachePath: "C:\\cache", outputDir: "C:\\out" }, recordingIo(argvs)).compile(input("C:\\proj"));
    expect(argvs).toEqual([["C:/alc.exe", "/project:C:/proj", "/packagecachepath:C:/cache", `/out:C:/out/${ID}.app`]]);
  });
  test("compile's argv with preprocessor symbols is exactly the pre-refactor argv", async () => {
    const argvs: string[][] = [];
    await new ArtifactCompiler({ alcPath: "C:/alc.exe", packageCachePath: "C:/cache", outputDir: "C:/out", preprocessorSymbols: ["A", "B"] }, recordingIo(argvs)).compile(input("C:/proj"));
    expect(argvs).toEqual([["C:/alc.exe", "/project:C:/proj", "/packagecachepath:C:/cache", "/define:A,B", `/out:C:/out/${ID}.app`]]);
  });
});
```

  If either fails on the unmodified code, the expected array is wrong, not the code: correct it to what `c21d556` produces and say so in the submit note. Commit these two on their own first (`test(runner): pin compile's full alc argv before the C02-05 refactor`), so the refactor commit shows them unchanged.

- [ ] **Step 1: Write the failing tests** in `artifact.test.ts`:

```ts
describe("C02-05: compileProject", () => {
  function io(argvs: string[][], exitCode = 0, stdout = ""): ArtifactIo {
    const bytes = new TextEncoder().encode("test-app-bytes");
    return {
      spawn: async (argv) => { argvs.push([...argv]); return { exitCode, stdout, stderr: "" }; },
      readArtifact: async () => bytes,
      writeArtifact: async () => {},
    };
  }

  test("compileProject uses the caller's package cache and returns content-addressed bytes", async () => {
    const argvs: string[][] = [];
    const c = new ArtifactCompiler({ alcPath: "alc", packageCachePath: "C:/target-cache", outputDir: "C:/out" }, io(argvs));
    const out = await c.compileProject({ projectDir: "C:/tests", packageCachePath: "C:/scratch-cache", name: "testapp-x" });
    expect(argvs[0]).toContain("/packagecachepath:C:/scratch-cache");
    expect(argvs[0]).not.toContain("/packagecachepath:C:/target-cache");
    expect(out.sha256).toBe(Bun.SHA256.hash(new TextEncoder().encode("test-app-bytes"), "hex"));
    expect(out.appPath).toBe(`C:/out/${out.sha256.slice(0, 16)}-testapp-x.app`);
  });

  test("compileProject passes the configured preprocessor symbols like compile does", async () => {
    const argvs: string[][] = [];
    const c = new ArtifactCompiler({ alcPath: "alc", packageCachePath: "p", outputDir: "C:/out", preprocessorSymbols: ["CLEAN24"] }, io(argvs));
    await c.compileProject({ projectDir: "C:/tests", packageCachePath: "C:/s", name: "t" });
    expect(argvs[0]).toContain("/define:CLEAN24");
  });

  test("compileProject throws AlcCompileError with alc's own text", async () => {
    const c = new ArtifactCompiler({ alcPath: "alc", packageCachePath: "p", outputDir: "C:/out" }, io([], 1, "error AL0132: nope"));
    await expect(c.compileProject({ projectDir: "C:/tests", packageCachePath: "C:/s", name: "t" })).rejects.toThrow(/AL0132/);
  });
});
```

- [ ] **Step 2: Run and see them fail** (`compileProject` is not a function).
- [ ] **Step 3: Implement.** Step 0's two parity tests and every existing `artifact.test.ts` test pass unedited.
- [ ] **Step 4: Red-checks:** make `compileProject` pass `this.cfg.packageCachePath`: the first `compileProject` test goes red. In the shared helper, emit `/packagecachepath` before `/project`: both parity tests go red. Restore.
- [ ] **Step 5: Commit** `refactor(runner): ArtifactCompiler compiles a non-artifact project; publishers need only path and hash (C02-05)`.

### Task 3: `readAppIdentity`, `compileTestApp` and `TestAppError`

**Files:**
- Modify: `packages/runner/src/published-test-app.ts` (`readAppIdentity`, beside `parsePublishedApp`, same manifest entry).
- Create: `packages/runner/src/test-app-publish.ts`.
- Test: `packages/runner/tests/published-test-app.test.ts`, `packages/runner/tests/test-app-publish.test.ts` (new; uses `buildFakeAppWithEntries` from `tests/helpers/fake-app.ts`).

**Interfaces:**

```ts
// published-test-app.ts
/** The <App> element's Id, Name, Publisher and Version. Throws, like parsePublishedApp, on a package without them. */
export function readAppIdentity(pkg: Buffer): { readonly id: string; readonly name: string; readonly publisher: string; readonly version: string };

// test-app-publish.ts
export type TestAppRefusal =
  | "manifest-unreadable"      // testDir/app.json, or a package manifest, could not be read
  | "symbols-unreadable"       // an .alpackages entry with no readable identity
  | "compile-failed"           // alc said no
  | "unsupported"              // the backend cannot read the package back
  | "version-below-resident"   // decision 3, before the fence
  | "publish-failed"           // decision 2's table
  | "publish-indeterminate"
  | "publish-anomalous";

export class TestAppError extends Error {
  constructor(
    readonly reason: TestAppRefusal,
    readonly detail: string,
    /** BC's installed version, when a downgrade names one. */
    readonly installedVersion: string | undefined = undefined,
  ) {
    super(`test app refused (${reason}): ${detail}`);
    this.name = "TestAppError";
  }
  /** Only a publish the server demonstrably did not take may tombstone the fence's marker. */
  get confirmedTerminal(): boolean {
    return this.reason === "publish-failed";
  }
}

export interface CompiledTestApp {
  readonly appPath: string;
  readonly sha256: string;
  /** From testDir/app.json. */
  readonly appId: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  /** The installed guarded build it was compiled against. */
  readonly compiledAgainst: { readonly artifactId: string; readonly sha256: string };
}

export async function compileTestApp(a: {
  readonly testDir: string;
  readonly target: BoundArtifact;
  readonly compiler: ArtifactCompiler;
  readonly controlSymbolPath: string;
}): Promise<CompiledTestApp>;
```

`compileTestApp`, in order: read and check `testDir/app.json` (`id`, `name`, `publisher`, `version` all strings, else `manifest-unreadable`); `mkdtemp` a scratch cache; decision 4's steps 1 and 2 (only `ENOENT` on `.alpackages` is swallowed); `compileProject` with `name: "testapp-" + appId`, mapping `AlcCompileError` to `compile-failed`; `rm` the scratch cache in `finally`, best-effort.

- [ ] **Step 1: Write the failing tests.** In `published-test-app.test.ts`: `"readAppIdentity reads Id, Name, Publisher and Version"` and `"readAppIdentity throws on a package with no manifest"`. In `test-app-publish.test.ts`:

```ts
const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a"; // fixtures/sandbox-app
const TESTS_ID = "ff7935bb-9fe2-4f7a-adf3-aa7132a41fe7";  // fixtures/sandbox-tests
const CONTROL_ID = "5e7a1c00-1111-4c00-8c00-1e7a1c000701"; // extensions/lethal-control
const SYSTEM_ID = "8874ed3a-0643-4247-9ced-7a7002f7135d";
const manifest = (id: string, name: string, version: string) =>
  `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="LethAL" Version="${version}" /></Package>`;
const pkg = (id: string, name: string, version: string, extra: Record<string, string> = {}) =>
  buildFakeAppWithEntries({ "NavxManifest.xml": manifest(id, name, version), ...extra });

async function fixture(alpackages: Record<string, Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), "c0205-"));
  await writeFile(join(dir, "app.json"), JSON.stringify({ id: TESTS_ID, name: "LethAL Sandbox Tests", publisher: "LethAL", version: "1.0.0.2" }));
  await mkdir(join(dir, ".alpackages"));
  for (const [f, b] of Object.entries(alpackages)) await writeFile(join(dir, ".alpackages", f), b);
  const targetPath = join(dir, "bound.app");
  await writeFile(targetPath, pkg(TARGET_ID, "LethAL Sandbox App", "1.0.20357.100", { "marker.txt": "INSTRUMENTED" }));
  const controlPath = join(dir, "control.app");
  await writeFile(controlPath, pkg(CONTROL_ID, "LethAL Control", "1.0.0.18"));
  const target: BoundArtifact = { appId: TARGET_ID, artifactId: "a".repeat(32), sha256: "b".repeat(64), appPath: targetPath, instrumentedDir: dir };
  return { dir, target, controlPath, out: await mkdtemp(join(tmpdir(), "c0205-out-")) };
}

/** A compiler whose alc records what is in the package cache it was handed. */
function watchingCompiler(out: string, seen: Array<{ id: string; marker: string | null }>, exitCode = 0, stdout = "") {
  return new ArtifactCompiler({ alcPath: "alc", packageCachePath: "UNUSED", outputDir: out }, {
    spawn: async (argv) => {
      const cache = argv.find((x) => x.startsWith("/packagecachepath:"))?.slice("/packagecachepath:".length);
      if (cache === undefined) throw new Error("no package cache in argv");
      for (const f of await readdir(cache)) {
        const b = await readFile(join(cache, f));
        seen.push({ id: readAppIdentity(b).id, marker: readPackageEntry(b, "marker.txt")?.toString("utf8") ?? null });
      }
      return { exitCode, stdout, stderr: "" };
    },
    readArtifact: async () => new TextEncoder().encode("compiled-test-app"),
    writeArtifact: async () => {},
  });
}

test("compileTestApp compiles against the bound artifact, never the stale target copy in .alpackages", async () => {
  const fx = await fixture({
    "Microsoft_System_28.0.0.0.app": pkg(SYSTEM_ID, "System", "28.0.0.0"),
    "LethAL_LethAL Sandbox App_1.0.0.0.app": pkg(TARGET_ID, "LethAL Sandbox App", "1.0.0.0", { "marker.txt": "STALE" }),
    "LethAL_LethAL Control_1.0.0.17.app": pkg(CONTROL_ID, "LethAL Control", "1.0.0.17"),
  });
  const seen: Array<{ id: string; marker: string | null }> = [];
  const app = await compileTestApp({ testDir: fx.dir, target: fx.target, compiler: watchingCompiler(fx.out, seen), controlSymbolPath: fx.controlPath });
  expect(seen.filter((s) => s.id === TARGET_ID).map((s) => s.marker)).toEqual(["INSTRUMENTED"]);
  expect(seen.filter((s) => s.id === CONTROL_ID)).toHaveLength(1);
  expect(seen.some((s) => s.id === SYSTEM_ID)).toBe(true);
  expect(app).toMatchObject({
    appId: TESTS_ID, name: "LethAL Sandbox Tests", publisher: "LethAL", version: "1.0.0.2",
    compiledAgainst: { artifactId: fx.target.artifactId, sha256: fx.target.sha256 },
  });
});

test("compileTestApp: an alc rejection is TestAppError compile-failed, never AlcCompileError", async () => {
  const fx = await fixture({});
  const err = await compileTestApp({
    testDir: fx.dir, target: fx.target, controlSymbolPath: fx.controlPath,
    compiler: watchingCompiler(fx.out, [], 1, `error AL0132: 'Codeunit "Sandbox Logic"' does not contain a definition for 'NoSuchProcedure'`),
  }).catch((e) => e);
  expect(err).toBeInstanceOf(TestAppError);
  expect(err).not.toBeInstanceOf(AlcCompileError);
  expect((err as TestAppError).reason).toBe("compile-failed");
  expect((err as TestAppError).message).toContain("AL0132");
});

test("compileTestApp refuses an .alpackages entry it cannot identify, naming the file", async () => {
  const fx = await fixture({ "mystery.app": Buffer.from("not a package") });
  await expect(compileTestApp({ testDir: fx.dir, target: fx.target, compiler: watchingCompiler(fx.out, []), controlSymbolPath: fx.controlPath }))
    .rejects.toMatchObject({ reason: "symbols-unreadable", message: expect.stringContaining("mystery.app") });
});

test("compileTestApp refuses a test project whose app.json lacks a name", async () => {
  // write app.json without "name": reason manifest-unreadable
});
```

  `SYSTEM_ID` is any id that is neither the target's nor the control's; if `readAppIdentity` needs attributes this fake manifest lacks, add them to `manifest` rather than loosening the reader.
- [ ] **Step 2: Run and see them fail.** **Step 3: Implement.** **Step 4: Run** the loop.
- [ ] **Step 5: Red-checks** (red line, then restored green):
  - drop the same-id filter: "never the stale target copy" goes red (two target entries, `["STALE","INSTRUMENTED"]` in some order);
  - drop the control-id filter: the same test goes red on `toHaveLength(1)`;
  - rethrow `AlcCompileError` unwrapped: "never AlcCompileError" goes red;
  - swallow an unreadable `.alpackages` entry instead of refusing: "cannot identify" goes red.
- [ ] **Step 6: Commit** `feat(runner): compile a test app against the installed guarded build (C02-05)`.

### Task 4: `publishTestApp`

**Files:** Modify `packages/runner/src/test-app-publish.ts`, `packages/runner/src/orchestrator.ts` (the one `isConfirmedTerminalPublishFailure` line, decision 2). Test: `test-app-publish.test.ts`.

**Interface and body:**

```ts
export interface PublishedTestApp {
  readonly appId: string;
  readonly name: string;
  readonly publisher: string;
  /** The server's own NavxManifest Version, read back after the publish. */
  readonly version: string;
  /** sha256 of the package the server returned after the publish: the compiled bytes' hash. */
  readonly sha256: string;
  readonly compiledAgainst: CompiledTestApp["compiledAgainst"];
}

export type ReadPublished = (app: { readonly publisher: string; readonly name: string }) => Promise<Uint8Array | null | undefined>;

export async function publishTestApp(
  fence: LeaseFence,
  app: CompiledTestApp,
  deps: { readonly publisher: AppPublisher; readonly readPublished: ReadPublished },
): Promise<PublishedTestApp> {
  const key = { publisher: app.publisher, name: app.name };
  // Before the fence: a refusal here claims no operation marker.
  const before = await deps.readPublished(key);
  if (before === undefined) {
    throw new TestAppError("unsupported", "this configuration cannot read a published package back (no dev server or no credentials), so a publish could not be verified");
  }
  if (before instanceof Uint8Array) {
    const resident = versionOf(before); // readAppIdentity, wrapped: manifest-unreadable
    if (compareVersionsOrRefuse(app.version, resident) < 0) {
      throw new TestAppError("version-below-resident", `the container holds ${app.name} ${resident}, above this project's app.json ${app.version}. LethAL publishes a test app at its own version and never mints one. Clear the resident record (Sync-NAVApp -Mode Clean, see .claude/skills/control-app) or raise app.json above ${resident}.`, resident);
    }
  }
  // null: never published, or unreadable. BC's own downgrade refusal inside the fence is the backstop.
  return fence.publish(async () => {
    let publishError: string | undefined;
    try {
      await deps.publisher.publish(app);
    } catch (err) {
      publishError = describeThrown(err);
    }
    const after = await deps.readPublished(key);
    const afterBytes = after instanceof Uint8Array ? after : undefined;
    const verification: DeploymentVerification =
      afterBytes === undefined
        ? { status: "unavailable", detail: "the server's package could not be read back after the publish" }
        : hashPackage(afterBytes) === app.sha256
          ? { status: "accepted" }
          : { status: "mismatch", reported: hashPackage(afterBytes) };
    const outcome = decideTestAppOutcome(publishError === undefined, verification);
    if (outcome !== "accepted" || afterBytes === undefined) {
      throw new TestAppError(`publish-${outcome === "accepted" ? "indeterminate" : outcome}`, describeOutcome(publishError, verification, app), parseVersionConflict(publishError ?? "") ?? undefined);
    }
    return { appId: app.appId, name: app.name, publisher: app.publisher, version: versionOf(afterBytes), sha256: app.sha256, compiledAgainst: app.compiledAgainst };
  });
}

/**
 * The target's rule (decidePublishOutcome), with one stricter case (ruling 1): a failed exit with
 * an UNAVAILABLE read-back is unknown, never failed. `null` from fetchPublishedAppPackage is a
 * timeout or a refused connection, which cannot show the publish did not land.
 */
export function decideTestAppOutcome(publishOk: boolean, verification: DeploymentVerification): PublishOutcome {
  if (!publishOk && verification.status === "unavailable") return "indeterminate";
  return decidePublishOutcome(publishOk, verification);
}
```

  `describeOutcome` says what altool said (its text, which never holds credentials: `ContainerDeployer` passes them by env) and what the server holds (its hash, or "unreadable"). `LeaseFence` is imported as a type from wherever C02-04b exports it.

- [ ] **Step 1: Write the failing tests** (same file, with `pkg` from Task 3):

```ts
const NEW = pkg(TESTS_ID, "LethAL Sandbox Tests", "1.0.0.2", { "src/T.al": "new" });
const OLD = pkg(TESTS_ID, "LethAL Sandbox Tests", "1.0.0.2", { "src/T.al": "old" });
const COMPILED: CompiledTestApp = {
  appPath: "C:/out/x-testapp.app", sha256: hashPackage(NEW), appId: TESTS_ID, name: "LethAL Sandbox Tests",
  publisher: "LethAL", version: "1.0.0.2", compiledAgainst: { artifactId: "a".repeat(32), sha256: "b".repeat(64) },
};
const DOWNGRADE = "altool publishapp failed (exit 1):\nCannot install the extension LethAL Sandbox Tests by LethAL 1.0.0.2 because a newer version 1.0.0.9 was already installed.";

function loggingFence(log: string[]): LeaseFence {
  return { publish: async (run) => { log.push("begin"); const r = await run(); log.push("end"); return r; } };
}
function deps(log: string[], reads: Array<Uint8Array | null | undefined>, publishFails?: string) {
  const queue = [...reads];
  return {
    publisher: { publish: async (a: { sha256: string }) => { log.push(`publish ${a.sha256.slice(0, 8)}`); if (publishFails !== undefined) throw new Error(publishFails); } },
    readPublished: async () => { log.push("read"); return queue.shift(); },
  };
}

test("publishTestApp returns the server's identity only when its bytes are the compiled ones", async () => {
  const log: string[] = [];
  const out = await publishTestApp(loggingFence(log), COMPILED, deps(log, [OLD, NEW]));
  expect(out).toEqual({ appId: TESTS_ID, name: "LethAL Sandbox Tests", publisher: "LethAL", version: "1.0.0.2", sha256: hashPackage(NEW), compiledAgainst: COMPILED.compiledAgainst });
  expect(log).toEqual(["read", "begin", `publish ${COMPILED.sha256.slice(0, 8)}`, "read", "end"]);
});

test("publishTestApp refuses a local version below the resident one before the fence", async () => {
  const log: string[] = [];
  const err = await publishTestApp(loggingFence(log), COMPILED, deps(log, [pkg(TESTS_ID, "LethAL Sandbox Tests", "1.0.0.5")])).catch((e) => e);
  expect(err).toMatchObject({ reason: "version-below-resident", installedVersion: "1.0.0.5" });
  expect((err as Error).message).toContain("1.0.0.2");
  expect(log).toEqual(["read"]);
});

test("publishTestApp: a BC downgrade refusal inside the fence is publish-failed and names the installed version", async () => {
  const log: string[] = [];
  const err = await publishTestApp(loggingFence(log), COMPILED, deps(log, [null, OLD], DOWNGRADE)).catch((e) => e);
  expect(err).toMatchObject({ reason: "publish-failed", installedVersion: "1.0.0.9", confirmedTerminal: true });
  expect(log).not.toContain("end");
});

test("publishTestApp: altool success but the server still holds the old package is publish-indeterminate", async () => {
  const err = await publishTestApp(loggingFence([]), COMPILED, deps([], [OLD, OLD])).catch((e) => e);
  expect(err).toMatchObject({ reason: "publish-indeterminate", confirmedTerminal: false });
});

test("publishTestApp: a read-back that fails after an exit 0 is publish-indeterminate", async () => {
  const err = await publishTestApp(loggingFence([]), COMPILED, deps([], [OLD, null])).catch((e) => e);
  expect(err).toMatchObject({ reason: "publish-indeterminate", confirmedTerminal: false });
});

test("publishTestApp: a failed exit with an unreadable read-back is publish-indeterminate, never publish-failed", async () => {
  const err = await publishTestApp(loggingFence([]), COMPILED, deps([], [OLD, null], DOWNGRADE)).catch((e) => e);
  expect(err).toMatchObject({ reason: "publish-indeterminate", confirmedTerminal: false });
  expect(decideTestAppOutcome(false, { status: "unavailable", detail: "timeout" })).toBe("indeterminate");
  expect(decidePublishOutcome(false, { status: "unavailable", detail: "timeout" })).toBe("failed"); // the target's rule is unchanged
});

test("publishTestApp returns the server's version, not app.json's", async () => {
  // The server's package says 1.0.0.3, the local app.json says 1.0.0.2. COMPILED3 hashes NEW3,
  // so the byte check passes and the version is the only thing under test.
  const NEW3 = pkg(TESTS_ID, "LethAL Sandbox Tests", "1.0.0.3", { "src/T.al": "new" });
  const COMPILED3: CompiledTestApp = { ...COMPILED, sha256: hashPackage(NEW3), version: "1.0.0.2" };
  const out = await publishTestApp(loggingFence([]), COMPILED3, deps([], [OLD, NEW3]));
  expect(out.version).toBe("1.0.0.3");
  expect(out.sha256).toBe(hashPackage(NEW3));
});

test("publishTestApp: a failed exit whose bytes landed anyway is publish-anomalous", async () => {
  const err = await publishTestApp(loggingFence([]), COMPILED, deps([], [OLD, NEW], DOWNGRADE)).catch((e) => e);
  expect(err).toMatchObject({ reason: "publish-anomalous", confirmedTerminal: false });
});

test("publishTestApp refuses a configuration that cannot read the package back, before the fence", async () => {
  const log: string[] = [];
  await expect(publishTestApp(loggingFence(log), COMPILED, deps(log, [undefined]))).rejects.toMatchObject({ reason: "unsupported" });
  expect(log).toEqual(["read"]);
});

test("the published identity's sha256 is the R192 key of the same bytes", async () => {
  const out = await publishTestApp(loggingFence([]), COMPILED, deps([], [OLD, NEW]));
  expect(await testAppHashFor(async () => NEW, "unused")).toBe(`package:${out.sha256}`);
});
```

- [ ] **Step 2: Run and see them fail.** **Step 3: Implement**, including the `isConfirmedTerminalPublishFailure` line, FIRST in that function. **Step 4: Run** the loop.
- [ ] **Step 5: Red-checks:**
  - compare the read-back against the resident (`before`) bytes instead of `app.sha256`: "identity only when its bytes" goes red;
  - drop the pre-fence version check: "below the resident one" goes red (`log` gains `begin`);
  - return the identity whenever altool exits 0: "still holds the old package" goes red;
  - use `app.version` instead of the server's in the identity: "the server's version, not app.json's" goes red (`1.0.0.2`, expected `1.0.0.3`). That test builds its own `NEW3` and a `COMPILED3` whose `sha256` hashes `NEW3`, so the byte check passes and cannot mask the version (r1's version of this red-check left the hash on the old `NEW` and was refused before the version was reached);
  - delete `decideTestAppOutcome`'s first line (call `decidePublishOutcome` directly): "a failed exit with an unreadable read-back" goes red (`publish-failed`, `confirmedTerminal: true`);
  - The `isConfirmedTerminalPublishFailure` ordering is red-checked in Task 6, where the real `LeaseSession` reads it.
- [ ] **Step 6: Commit** `feat(runner): publish a test app through the lease fence and verify it by bytes (C02-05)`.

### Task 5: `BcDevMcpBackend.compileTestApp` and `publishTestApp`

**Files:** Modify `packages/runner/src/bcdev-backend.ts`. Test: `packages/runner/tests/bcdev-backend.test.ts` (`makeDeployment`, `makeBackendWithDeploy`).

```ts
/** C02-05: compile a test project against an installed guarded build. Local only: alc, no server call. */
async compileTestApp(testDir: string, target: BoundArtifact): Promise<CompiledTestApp>;
/** C02-05: publish it inside the lease fence and verify it by the server's own bytes. */
async publishTestApp(fence: LeaseFence, app: CompiledTestApp): Promise<PublishedTestApp>;
```

Both throw `Error("BcDevMcpBackend: no compiler/deployer/verifier configured")` without a deployment (the `deploy` wording). They pass `deployment.compiler` and `this.cfg.controlSymbolPath`, and `deployment.deployer` with `(k) => this.fetchPublishedAppPackage(k)`.

- [ ] **Step 1: Write the failing tests:**
  - `"compileTestApp uses the backend's own compiler and control symbol, and calls no server"`: `makeDeployment` with a recording spawn; argv[0] is its alcPath; the cache contains the control symbol's bytes; the MCP fake's `runHandler` and a recording `fetchFn` are never called.
  - `"publishTestApp publishes with the backend's deployer and reads back from dev/packages"`: a `fetchFn` that answers the resident package, then the compiled bytes; the altool argv names the compiled `.app`; both fetch URLs contain `appName=LethAL%20Sandbox%20Tests`; the result's `sha256` is the compiled one.
  - `"a backend with no deployment refuses both"`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Run** the loop.
- [ ] **Step 5: Red-check:** pass `this.cfg.packageCachePath` through as the scratch cache (skip staging): the first test goes red on the cache contents. Restore.
- [ ] **Step 6: Commit** `feat(runner): the bcdev backend compiles and publishes a test app for a bound artifact (C02-05)`.

### Task 6: Inside `runNamedMutants`: the real fence, and nothing after a latched publish

**Files:** Modify `packages/runner/src/orchestrator.ts` (`runNamedMutants`: wrap the POST-publish `attach` and `scoreBatch` in `if (!safety.isUnsafe)`; the existing `not run` fill and `quarantined` then answer every request). The preflight `attach` before `inLease` is C02-04b's (its ruling 6); if C02-04b landed without it, add it here as its own commit, `fix(runner): attach before inLease as well as after the rebind (C02-04b ruling 6)`, and say so in the submit note. Expected order of trace entries: `attach` (preflight), BeginPublish, the test-app publish, EndPublish, `setLease` (rebind to the publish op seq), `attach` (post-publish), baseline. Test: `orchestrator.test.ts`, `describe("C02-05: the test-app publish inside runNamedMutants' fence")`, built on C02-04b's `installedFixture` with a `FakeLeaseClient` lease, `quarantineDir: freshTmpDir()`, `resourceServer: "http://cronus28"`, `resourceServerInstance: "BC"`. The hook in every test is:

```ts
// ONE log PER TEST (gpt-6-sol r2): a shared log lets an earlier test's successful publish leave a
// "publish ..." entry that makes a later "spawns no altool" or empty-log assertion fail with correct
// code, and makes the preflight test depend on test order. Each test creates its own `tlog` and
// passes it in.
const inLease = (tlog: string[], reads: Array<Uint8Array | null | undefined>, publishFails?: string) => async (fence: LeaseFence) => {
  await publishTestApp(fence, COMPILED, deps(tlog, reads, publishFails)); // COMPILED, deps, NEW, OLD, DOWNGRADE copied from test-app-publish.test.ts
};
```

Every test below starts with `const tlog: string[] = [];` and calls `inLease(tlog, ...)`; the snippets that
still show `inLease([...])` mean `inLease(tlog, [...])` with that test's own log.

`FakeLeaseClient`'s own knobs (`beginPublishOutcome`, `endPublishOutcome`, `endPublishArgs`, `releaseCalls`) are used as they are; do not add one.

- [ ] **Step 1: Write the failing tests:**

```ts
const attaches = (t: Trace) => calls(t).filter((c) => (c as { call: string }).call === "attach").length;

test("C02-05: a server reporting another target is refused before any test-app publish", async () => {
  const fx = await installedFixture({ serverReports: "b".repeat(32) });
  const err = await runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, NEW]), requests: [{ mutantId: "M0001", methods: [OVER] }] }).catch((e) => e);
  expect(err).toBeInstanceOf(InstalledArtifactError);
  expect((err as InstalledArtifactError).reason).toBe("mismatch");
  expect(tlog).toEqual([]);                       // no read, no publish: the server was not modified
  expect(fx.client.beginPublishArgs).toEqual([]); // no marker claimed
  expect(fx.client.releaseCalls).toBe(1);
});

test("C02-05: a verified test-app publish is followed by rebind, attach and the baseline", async () => {
  const fx = await installedFixture();
  const res = await runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, NEW]), requests: [{ mutantId: "M0001", methods: [OVER] }] });
  expect(res.outcomes.map((o) => o.verdict)).toEqual(["killed"]);
  expect(fx.client.endPublishArgs.map((a) => a.outcome)).toEqual(["succeeded"]);
  const tr = calls(fx.trace) as Array<{ call: string; id?: string | null; lastCompletedOpSeq?: number }>;
  const idx = (p: (c: (typeof tr)[number]) => boolean) => tr.findIndex(p);
  const preflight = idx((c) => c.call === "attach");
  const rebind = idx((c) => c.call === "setLease" && c.lastCompletedOpSeq === fx.client.beginPublishArgs[0]?.opSeq);
  const postPublish = tr.findIndex((c, i) => i > rebind && c.call === "attach");
  const firstRun = idx((c) => c.call === "run" || c.call === "runMany");
  expect(preflight).toBeGreaterThan(-1);
  expect(rebind).toBeGreaterThan(preflight);
  expect(postPublish).toBeGreaterThan(rebind);
  expect(firstRun).toBeGreaterThan(postPublish);
  expect(attaches(fx.trace)).toBe(2);
});

test("C02-05: a confirmed test-app publish failure ends the marker as failed and records no recycle", async () => {
  const fx = await installedFixture();
  const err = await runNamedMutants({ ...fx.cfg, inLease: inLease([null, OLD], DOWNGRADE), requests: [{ mutantId: "M0001", methods: [OVER] }] }).catch((e) => e);
  expect(err).toMatchObject({ reason: "publish-failed", installedVersion: "1.0.0.9" });
  expect(fx.client.endPublishArgs.map((a) => a.outcome)).toEqual(["failed"]);
  expect(await new QuarantineStore(fx.cfg.quarantineDir).read("http://cronus28|BC")).toBeNull();
  expect(fx.client.releaseCalls).toBe(1);
  expect(attaches(fx.trace)).toBe(1); // the preflight only
});

test("C02-05: a plain altool failure ends the marker as failed", async () => {
  // No BC downgrade text: only the TestAppError line in isConfirmedTerminalPublishFailure can call it terminal.
  const fx = await installedFixture();
  await expect(runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, OLD], "altool publishapp failed (exit 1):\nThe app could not be published."), requests: [{ mutantId: "M0001", methods: [OVER] }] }))
    .rejects.toMatchObject({ reason: "publish-failed" });
  expect(fx.client.endPublishArgs.map((a) => a.outcome)).toEqual(["failed"]);
  expect(await new QuarantineStore(fx.cfg.quarantineDir).read("http://cronus28|BC")).toBeNull();
});

test("C02-05: a failed exit with an unreadable read-back keeps the marker", async () => {
  // Ruling 1: null is a timeout or a refused connection; it cannot show the publish did not land.
  const fx = await installedFixture();
  await expect(runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, null], DOWNGRADE), requests: [{ mutantId: "M0001", methods: [OVER] }] }))
    .rejects.toMatchObject({ reason: "publish-indeterminate" });
  expect(fx.client.endPublishArgs).toEqual([]);
  expect(await new QuarantineStore(fx.cfg.quarantineDir).read("http://cronus28|BC")).not.toBeNull();
  expect(attaches(fx.trace)).toBe(1);
});

test("C02-05: an indeterminate test-app publish leaves the marker and records container-needs-recycle", async () => {
  const fx = await installedFixture();
  await expect(runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, OLD]), requests: [{ mutantId: "M0001", methods: [OVER] }] }))
    .rejects.toMatchObject({ reason: "publish-indeterminate" });
  expect(fx.client.endPublishArgs).toEqual([]);
  expect(await new QuarantineStore(fx.cfg.quarantineDir).read("http://cronus28|BC")).not.toBeNull();
});

test("C02-05: an anomalous publish carrying BC's downgrade text is not treated as terminal", async () => {
  const fx = await installedFixture();
  await expect(runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, NEW], DOWNGRADE), requests: [{ mutantId: "M0001", methods: [OVER] }] }))
    .rejects.toMatchObject({ reason: "publish-anomalous" });
  expect(fx.client.endPublishArgs).toEqual([]);
  expect(await new QuarantineStore(fx.cfg.quarantineDir).read("http://cronus28|BC")).not.toBeNull();
});

test("C02-05: BeginPublish refused spawns no altool and releases the lease", async () => {
  const fx = await installedFixture();
  fx.client.beginPublishOutcome = { begun: false, alreadyCompleted: false };
  await expect(runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, NEW]), requests: [{ mutantId: "M0001", methods: [OVER] }] }))
    .rejects.toBeInstanceOf(LeaseUnavailableError);
  expect(tlog.some((l) => l.startsWith("publish"))).toBe(false);
  expect(fx.client.releaseCalls).toBe(1);
});

test("C02-05: a lease lost across the test-app publish runs nothing after it", async () => {
  const fx = await installedFixture();
  fx.client.endPublishOutcome = { ended: false };
  const res = await runNamedMutants({ ...fx.cfg, inLease: inLease([OLD, NEW]),
    requests: [{ mutantId: "M0001", methods: [OVER] }, { mutantId: "M0002", methods: [OVER] }] });
  expect(res.quarantined).toMatch(/lease-lost/);
  expect(res.outcomes.map((o) => [o.verdict, o.failureNote?.startsWith("not run: ")])).toEqual([["error", true], ["error", true]]);
  const work = calls(fx.trace).filter((c) => {
    const x = c as { call: string; id?: string | null };
    return x.call === "run" || x.call === "runMany" || (x.call === "activate" && typeof x.id === "string");
  });
  expect(work).toEqual([]);
  expect(attaches(fx.trace)).toBe(1); // the preflight ran; the post-publish attach did not
});
```

  Match the `beginPublishOutcome`/`endPublishOutcome` shapes to `lease.ts`'s `BeginPublishOutcome`/`EndPublishOutcome` if they differ. `installedFixture` must expose its `FakeLeaseClient` as `client` (C02-04b's "wrong installed artifact" test already reads `fx.client.releaseCalls`), its `quarantineDir`, and the `serverReports` option that test uses; if it does not take a `quarantineDir`, pass it in the config spread.
- [ ] **Step 2: Run and see them fail.** Expected before Step 3: the lease-lost test is red (`attaches` is 2); if any other test is red, find out why before implementing (a red "another target" or "rebind, attach" test means C02-04b landed without ruling 6's preflight: add it, see Files).
- [ ] **Step 3: Implement** the `if (!safety.isUnsafe)` guard. **Step 4: Run** the loop; C02-04b's order test (as amended by its ruling 6) and the Part A snapshots are unchanged.
- [ ] **Step 5: Red-checks:**
  - remove the guard: "a lease lost across the test-app publish" goes red on `attaches` (2, expected 1);
  - remove the preflight `attach`: "another target is refused before any test-app publish" goes red (`tlog` gains reads and a publish, `beginPublishArgs` is not empty);
  - remove the post-publish `attach`: "followed by rebind, attach and the baseline" goes red (`postPublish` is -1);
  - move the `TestAppError` line in `isConfirmedTerminalPublishFailure` below the `parseVersionConflict` fallback: "anomalous ... not treated as terminal" AND "a failed exit with an unreadable read-back keeps the marker" go red (`endPublishArgs` gains `failed`, no recycle), since both messages carry `DOWNGRADE`;
  - make `confirmedTerminal` true for every `publish-*`: "indeterminate ... leaves the marker" and "unreadable read-back keeps the marker" go red;
  - delete `decideTestAppOutcome`'s first line: "a failed exit with an unreadable read-back keeps the marker" goes red (EndPublish `failed`, no recycle);
  - drop the `isConfirmedTerminalPublishFailure` line entirely: "a confirmed test-app publish failure ends the marker as failed" stays GREEN, because `DOWNGRADE` is caught by the fallback, and "a plain altool failure ends the marker as failed" goes red (recycle recorded). That is why both tests exist: only the second pins the line.
- [ ] **Step 6:** `bun scripts/generate-schemas.ts` produces no diff. Biome on touched files.
- [ ] **Step 7: Commit** `feat(runner): runNamedMutants runs nothing after a latched test-app publish (C02-05)`.

### Task 7: `itest:testapp`, the live proof

**Files:** Create `packages/runner/itest/test-app-publish.itest.ts`; add `"itest:testapp": "bun packages/runner/itest/test-app-publish.itest.ts"` to the root `package.json`. Copy `bcdev.itest.ts`'s config loading, backend construction and `runSession` lease wiring verbatim; do not write a second loader. Skips (and says so) unless `LETHAL_ITEST_TESTAPP=1`. Prints the control-app and BC build it ran against first, as the other gates do. Use a store in a fresh temp dir, not `fixtures/sandbox-app/lethal.sqlite`, so the frozen gate's database is untouched.

**What the itest does, and what it must show** (each numbered item is an assertion; any failure exits 1):

1. `runSession` on `fixtures/sandbox-app` + `fixtures/sandbox-tests`, as `itest:bcdev` does. Per-mutant verdicts equal `itest/bcdev.baseline.json`. This is only a sanity check; its job is to leave a guarded build installed with a trusted `batch_artifacts` row.
2. `loadInstalledArtifact(store, { fromRunId, batchIndex: <highest>, appPath, instrumentedDir })` succeeds.
3. From the report, pick the mutant whose identity key is `bcdev.baseline.json`'s `Sandbox Logic|IsOverBudget|lethal.return-value` row (frozen `killed` by `OverBudgetDetected`) and the one for `Sandbox Logic|ClampPercent|lethal.negate-conditional` (frozen `survived`), with their `mutantCode` and `coveringTests`.
4. **Bad reference, real alc:** a scratch copy of `fixtures/sandbox-tests` with one added `[Test]` method calling `SandboxLogic.NoSuchProcedureC0205();`. `backend.compileTestApp` throws `TestAppError` `compile-failed` whose message contains `AL0132`. No lease is involved (none is open).
5. **Marker ABSENT before its publish (runtime).** `runNamedMutants` with NO `inLease`, one request: the kill with `[OverBudgetDetected, ZzC0205Marker]`. It must throw `StaleTestAppError` whose `missingTests` names `ZzC0205Marker` (and only it). Without this, a marker that was already on the server (a leftover from an earlier failed run) would make step 6's green marker prove nothing. If it does NOT throw, the itest exits 1 before publishing and says the container carries a marker build: restore it by hand (step 7's compile and publish) before any gate.
6. **Marker publish:** a scratch copy of `fixtures/sandbox-tests` (same `app.json`, version `1.0.0.2`) with one added method in the existing test codeunit: `[Test] procedure ZzC0205Marker() begin end;`. `compileTestApp`, then `runNamedMutants` with `inLease` calling `backend.publishTestApp(fence, compiled)`, requests: the kill with `[OverBudgetDetected, ZzC0205Marker]`, the survivor with its `coveringTests` plus `ZzC0205Marker`. Must show:
   - `published.sha256 === compiled.sha256`, and a FRESH `fetchPublishedAppPackage` after the call hashes to the same value (package identity: what `dev/packages` returns);
   - `published.version === "1.0.0.2"`;
   - the store's baseline `test_results` row for `ZzC0205Marker` is `pass`. With step 5 this is decision 2's narrower runtime guarantee and no more: the session executed a test app that contains a method of that name, so NOT the pre-publish app. It does not show that every changed test body is the one executing;
   - the kill is `killed` with `killingTest` `OverBudgetDetected`, the survivor `survived`;
   - `res.quarantined` is undefined, the quarantine dir holds no record, and a lease acquire right after succeeds (the LethAL lease was released).
7. **Restore publish, checked at runtime.** `compileTestApp` on the UNCHANGED `fixtures/sandbox-tests`, then `runNamedMutants` with `inLease` publishing it and the two requests WITHOUT the marker. Must show the same identity checks (`published.sha256 === compiled.sha256 ===` a fresh read-back, version `1.0.0.2`) and the same two verdicts. Then REPEAT step 5's probe: it must throw `StaleTestAppError` naming `ZzC0205Marker` again. The original methods' verdicts alone cannot discriminate (they pass on the marker build too); the marker's runtime absence can. What is proven is exactly that: the session no longer executes the marker build, and `dev/packages` returns the bytes just compiled from the repo's source. It is not proof that every test body equals the repo's. This leg is the second same-version publish of the run. It runs in a `finally` once step 6 started, so a failed step 6 still restores (and the itest still exits 1).

**Live steps (lane, under the standing authorization):**

- [ ] **Step 1:** Compile check: `bun run typecheck`, clean dist, `bun test`. The itest file must typecheck.
- [ ] **Step 2:** `containers.ps1 status -Names Cronus28`; `coord lease Cronus28 code`; heartbeat every 5 minutes.
- [ ] **Step 3:** `LETHAL_ITEST_TESTAPP=1 bun run itest:testapp`, foreground. Expected: every assertion above, PASS.
- [ ] **Step 4:** `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`, foreground, same lease. Expected: the frozen figures in decision 7, per mutant identical to `bcdev.baseline.json`.
- [ ] **Step 5:** Release the lease. A failure in Step 3 after its step 6 began: check that its step 7 ran AND that its repeated absence probe passed (the next `itest:bcdev` would otherwise measure the marker copy). A moved figure in Step 4: BLOCK, report to the owner; do not re-record anything.
- [ ] **Step 6: Commit** `test(runner): itest:testapp, a test-app publish under the lease proven live on Cronus28 (C02-05)`.

**Submit note must say:** Task 0's four printed hashes and the altool exit codes; every red-check with its red and restored-green line; that the Part A snapshots and C02-04b's tests did not change except by the guard; that `bun scripts/generate-schemas.ts` produced no diff; the R<nnn> id filed in Task 1; `itest:testapp`'s output including the BC build line; `itest:bcdev`'s figures; whether C02-04b already had ruling 6's preflight `attach` or this task added it.

## Out of scope, on purpose

- **`lethal verify` itself** (argument parsing, mapping a report row to an `InstalledArtifactRef`, choosing methods, the kill-proof JSON, exit codes): C02-06.
- **Restoring the container's previous test app after a verify.** The epic asks for ONE test-app publish per verify, so C02-05 leaves the app it published installed. The R192 key sees that change; R139 check 2 sees it only when a test goes missing; Task 1's item covers carried verdicts. A later full run measures whatever test app is installed, as it always has.
- **The env-tool path** (decision 6) and **al-runner** (decision 6).
- **Proving each named guard exists in the running target:** C02-04's decision 1 trust assumption and GH-24, unchanged.
- **The `--resume` carry gap** (decision 5): filed in Task 1, not solved.
- **Proof that every changed test body executes.** Only the marker's narrower guarantee (decision 2).
- **A retry of an unreadable read-back.** It is unknown (indeterminate, recycle), after either exit code (ruling 1). If Task 7 shows `dev/packages` flaking on Cronus28, file it; do not add a retry here.

## Notes for C02-06 (not built here)

- Call `compileTestApp` BEFORE `runNamedMutants`, so a compile failure never takes the lease.
- Check every requested method against `discoverTests(testDir)` before the lease. Then a `StaleTestAppError` after a verified publish can only mean something new, and its operator-workflow remedy text is never shown for a request mistake.
- Report `published.sha256` and `published.compiledAgainst` in the kill proof: together they say which test bytes ran against which guarded build.
- `TestAppError` reaches the caller as a throw from `runNamedMutants` (the hook runs inside its `try`; only `SessionUnsafeError` is caught). Map `reason` to an exit code; `publish-indeterminate` and `publish-anomalous` mean Cronus28 now carries a `container-needs-recycle` record that an operator must clear.

## Orchestrator rulings (2026-09-26)

1. **No minted test-app version: accepted, conditional on Task 0.** If Task 0 shows BC refuses a same-version republish, or the read-back hash differs, the lane stops and runs `coord ask`; it does not fall back to minting.
2. **Order of `inLease` and `attach`: BOTH checks.** A PREFLIGHT `attach` before `inLease`, which refuses before anything on the server is modified when the installed target is not the bound artifact, AND the mandatory post-publish `attach` after the op-sequence rebind, because an observation from before the publish cannot certify the target after it and the backend must run with the publish's new sequence. If only one were possible, the post-publish one would be kept. The order is: acquire, preflight `attach`, `inLease`, `rebindBackend`, `attach`, baseline. Recorded for Part B as ruling 6 of `2026-09-25-C02-04-run-named-mutants.md`; pinned from this side by Task 6.
3. **Live work** on Cronus28 only, under `coord lease Cronus28 code` (standing owner authorization). The owner adds the `itest:testapp` line to `CLAUDE.md` after acceptance.
