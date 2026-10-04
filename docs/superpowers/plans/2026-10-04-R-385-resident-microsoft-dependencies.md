# R-385: fingerprint Microsoft dependencies by what the server HOLDS, not what the test app declares

Draft r3 (last review round) for `docs/superpowers/plans/`. Evidence: `/coord/handoff/R-385/survey.md`
(section 6 new in r3), `measurement.md`, review `/coord/reviews/R-385-plan/claude-adversary-r1.md`.
No code until the orchestrator commits this plan AND the Cronus284 check (section 3) is recorded.

## Changes since r2

- **Test Runner [r3]** (`23de40a6-dfe8-4f80-80db-d70f83ce8caf`), which `lethal-control` depends on
  and which runs every test, was missing. The control app's dependencies, read from the control app
  the server runs, are now a third root (D1, D2, T2).
- **T0 cannot be dodged [r3]:** a run-time refusal in `fetchApiRows`, plus a wider source scan
  (itests and `.claude/` included). It closes master's R433 (D0, T0).
- **Application by GUID [r3]** (`c1335042-3002-4257-bf8a-75c898ccb1b8`): same identity and installed
  checks as any app (D1). **Limits L1, L2 [r3]** stated (D8); Cronus284 also counts `.al` files.
- **Rulings [r3]:** r2's three open questions were ruled (section 7).
r2 in short: package bytes replaced r1's unfiltered list (it hung BC 28.4); never the list.

## 1. The problem in one paragraph

`dependencyFingerprint` (`packages/runner/src/digest-inputs.ts:211`) writes `M <id> <declared
version>` for a Microsoft dependency and never asks the server. Every test digest carries it
(`test-digest.ts:244`), and verify treats a test as new only when its digest moved (`verify.ts:871`).
So a container update to Library Assert, the Base App or the test libraries leaves every digest
unchanged: a test that now behaves differently is treated as old (unsafe). Microsoft apps reached
only through another are not listed at all (`digest-inputs.ts:237-240`).

## 2. Design

**D0 [r3]. Never issue the unfiltered automation `extensions` query.** Unfiltered, or filtered by
publisher, it never returned on Cronus28 (BC 28.4, 2026-10-04; socket closed after about 166 s,
three times) and the service tier then stopped answering until an owner restart (R433 on master).
By id it answered in 39-49 ms. Today only `harness.ts:377` builds the path, always id-filtered
(survey section 4). r3 enforces it twice (T0): at RUN TIME `fetchApiRows` (`harness.ts:398`, the one
sender) refuses any `extensions` request not filtered by exactly one GUID, before sending; a SOURCE
scan refuses automation-API text outside `harness.ts`, so a call built elsewhere is caught.

**D1 [r3]. The read path: package BYTES over the dependency closure, Microsoft apps included.**
The walk in `dependencyFingerprint` (`digest-inputs.ts:211-269`) stops treating Microsoft specially
(today `:237-240` writes `M <id> <declared>` and `continue`s). In bytes mode a Microsoft dependency
takes the non-Microsoft path: `read(dep)` through `publishedPackageReader` (`dev/packages`, the
server's resident bytes), the identity check (`:259-263`), line `X <id> <sha256>`, its manifest's
dependencies enqueued (so transitive Microsoft apps are walked). Three roots: the test app's
dependencies (as today), then:
- **Platform roots.** `System` ALWAYS (a platform update changes every test): read by
  `{publisher:"Microsoft", name:"System"}`, manifest must say `Name="System"`, `Publisher=
  "Microsoft"` (not an extension, no app id), line `P <sha256>`. `Application` when any walked app
  has an `application` property (how a real suite reaches Base and System Application). **[r3]** It
  is enqueued as an ordinary dependency with its well-known id `c1335042-3002-4257-bf8a-75c898ccb1b8`
  (new constant), so the identity check and D2's per-id check apply unchanged; a GUID, not
  Name/Publisher, because D2 needs an id. Source: the `App Id` of all 17 `Microsoft_Application_*.app`
  manifests in `fixtures/*/.alpackages`, and of the package Cronus28 served (survey section 6).
- **[r3] Control-app root.** The dependencies of the `LethAL Control` app the server RUNS (today
  only Test Runner, `23de40a6-dfe8-4f80-80db-d70f83ce8caf`), which runs every test and which neither
  the test app nor the target depends on. Read from the SERVER: `fetchPublishedAppPackage({publisher:
  "LethAL", name:"LethAL Control"})`, manifest `Id` must be `CONTROL_APP_ID` (`harness.ts:11`) and
  `Version` must equal `HarnessVerifier.fetchControlVersion()` (`harness.ts:290`, what the running
  control app reports); its dependencies are enqueued like any others (Test Runner: `X` line, D2's
  check, its own dependencies walked). Not the repo's `extensions/lethal-control/app.json`: it
  describes the NEXT build, a server may run an older one (still above `MIN_CONTROL_VERSION`) with
  other dependencies, and an installed LethAL need not have the repo. The version equality proves the
  served package is the running one. Its OWN bytes are not hashed (L3).
The declared `M application` / `M platform` lines stay. Why bytes suffice (measurement.md): 13/13
byte-identical across two downloads (no spurious "new"), and 12/13 hold `.al` source, so a code
rebuild changes the bytes at the same version or not (limits L1, L2 in D8).

**D2 [r3]. Per-id reads: the one place they are needed.** `dev/packages?versionText=` (empty) returns
"a version you have"; which one, when two versions are published (a staged upgrade), is unmeasured.
Hashing a published-but-not-installed package would call it resident. So for each Microsoft package
the walk downloads, except `System` (not an extension), read its installed rows by id and require
EXACTLY ONE installed row whose version equals the downloaded manifest's `Version`. New
`HarnessVerifier.fetchInstalledVersions(appId): Promise<readonly string[]>` (installed rows only),
through the private `fetchExtensionRows(appId)` (T0) shared with `fetchExtensionInstalled`; the
companies lookup is done once per verifier. Cost: about 13 x 45 ms = 0.6 s. **[r3]** Covers
Application (by GUID) and Test Runner; the control app is covered by D1's version equality.
Non-Microsoft dependencies get no per-id check (ruled, section 7).

**D3 [r3]. API shape.** `dependencyFingerprint(root, read, microsoft: MicrosoftMode, target?)`, with
`MicrosoftMode = {kind:"bytes"; readSystem(): Promise<Uint8Array | null | undefined>; readControl():
Promise<Uint8Array | null | undefined>; controlVersion(): Promise<string>; installed(id):
Promise<readonly string[]>} | {kind:"declared"}`. Required, no default, so no caller gets the old
behaviour by omission. `{kind:"declared"}` writes today's `M <id> <declared>` lines plus one
`K declared` line, so a declared fingerprint never equals a bytes one. New optional
`ExecutionBackend.microsoftMode?(): MicrosoftMode`; `BcDevMcpBackend` builds it from
`fetchPublishedAppPackage` and `deployment.harnessVerifier`.

**D4 [r3]. Fail-closed: REFUSE BY NAME. Never the declared version, never "every test new".**
`DependencyUnreadableError`, naming the app, when: a Microsoft package (or `System`, or the control
app) reads `null`, `undefined` or empty, is not a readable package, or is another app (Application:
manifest `Id` not `c1335042-…`; control app: `Id` not `CONTROL_APP_ID`); `System`'s manifest is not
Microsoft/System; the served control app's `Version` differs from `controlVersion()` (both versions
in the message); a per-id read fails; the app has no installed row, more than one, or one whose
version differs from the hashed manifest (the message gives both versions); or a published-path
backend has no `microsoftMode`.
verify: the existing refusal `dependency-unreadable` (`verify.ts:200`), hint updated to name the
Microsoft packages, `System`, the control app and the installed check; no new refusal value, so
`VERIFY_SCHEMA_VERSION` stays 6. run: no digests plus `test-digests-unavailable`
(`orchestrator.ts:7166`), so a later verify refuses `source-predates-verify`. Not "every test new":
that trips `too-many-new-tests` or runs for hours, and reads like a real change (as R-371 ruled).

**D5 [r3]. Cost, and no cache.** Once per run (`orchestrator.ts:7158`) and per verify
(`verify.ts:1098`), measured on Cronus28: 68.8 MB in 2.57 s, SHA-256 28 ms, peak RSS 215 MB (one
buffer at a time), plus 0.6 s per-id: about 3.2 s. [r3] The control root adds two small downloads,
one per-id read and one HarnessInfo read (Cronus284 measures them). No cache (ruled): keyed by
(appId, version) it misses a same-version rebuild, and `packageId` was never read.

**D6. al-runner keeps `{kind:"declared"}`, explicitly.** It provisions Microsoft apps at the
project's version prefix resolved to the LATEST Microsoft build (`al-runner-backend.ts:436-447`), so
the gap is there and wider. No effect today: verify is bcdev only (`cli.ts:5263-5287`), so al-runner
digests are never compared. Roadmap item (T6): resolve from the provisioned platform-apps dir before
verify supports al-runner. The `K declared` line keeps such a digest from passing as a bytes one.

**D7 [r2]. Digest scheme `v2` -> `v3`.** `TEST_DIGEST_SCHEME = "v2"` on r385 and origin/master
(survey section 5). Every digest moves on every fixture (the `P` line is added even with no
Microsoft dependency), so I do NOT argue that digests stay unchanged. The bump turns that into ONE
named refusal per old source run (`source-predates-verify`, `verify.ts:836`) instead of "every test
is new"; its text becomes "scheme <recorded>, this build <current>". CHANGELOG (Changed): "verify
refuses, once per source run, every run recorded before R385; run `lethal run` again."

**What moves:** digest values and scheme tag, `testDigestParts.dependencies`, verify's refusal text
and hint. **Not:** `sessionFingerprint` (`resume.ts:391`), `testAppHash`, `lethal explain`, verify
JSON schema (v6), `SessionReport` and store schemas, `explainNewTests` causes.

**D8 [r3]. Stated limits**, written in the module comment of `digest-inputs.ts`,
`docs/using-lethal-from-an-agent.md` and the CHANGELOG. In each, **the reader sees** verify report
the affected tests as OLD (not re-run, no cause), with no warning; only these docs say it can happen.
- **L0 (r2).** An INSTALLED app outside the closure (any publisher) that changes a test, for example
  through a global event subscriber. Filed as its own item (T6).
- **L1 [r3]. A symbols-only package hides a body-only rebuild:** with no `.al` source, only
  `SymbolReference.json`, its bytes stay the same when only procedure bodies change. On Cronus28 only
  the `Application` meta package (0 `.al`; its dependencies carry source). Any closure package that
  Cronus284 shows with 0 `.al` is NAMED here.
- **L2 [r3]. A server-only binary update** (new service-tier DLLs, no new `System` package) changes
  runtime behaviour; whether `System`'s bytes move with it is UNMEASURED (it needs a real platform
  update), so it is stated, not claimed.
- **L3 [r3]. The control app's own bytes are not hashed:** that would make every recorded test new
  on every control-app upgrade (`too-many-new-tests`); its version is checked against
  `MIN_CONTROL_VERSION` and the live gates measure its behaviour.

## 3. Measurement [r3]

**Done on Cronus28, 2026-10-04 (measurement.md):** 13 packages, 68.8 MB, 2.57 s, SHA-256 28 ms,
13/13 byte-identical across two downloads, 12/13 hold `.al` source, Library Assert per-id 39-49 ms.
Not settled: one installed row per closure app (now with Application and Test Runner) at the served
version, which D2 relies on; whether `dev/packages` serves the control app; `.al` counts elsewhere.

**Still owed [r3]: the D2 check, on Cronus284 ONLY.** A separate sonnet agent. First confirm with
the orchestrator that Cronus284 is healthy and take its lease through coord; release it at the end.
NEVER Cronus28. Read-only: no publish, unpublish or install; the ONLY control-app call is
`fetchControlVersion()` (a read-only HarnessInfo GET), once. **NEVER the automation `extensions`
list** (unfiltered, by publisher, or paged by `$top`/`$skip`): the only extensions call allowed is
`HarnessVerifier.fetchExtensionInstalled(<guid>)`, per id; the script builds no automation URL
itself. Never print, log or write a credential or the config's contents.

Script `/tmp/claude-1000/-work-lethal-wt-lane-code/6932a541-ed4a-46cd-8d4e-b283732337d8/scratchpad/r385/measure-per-id.ts`
(Write tool), run from `/work/lethal-wt/r385` with `--config <a fixture config whose bcdev.server is
Cronus284>`; it EXITS 2 without any request if `bcdev.server` does not name Cronus284. Same imports
as `measure-resident.ts`. Steps, one request at a time:
1. Health: `fetchExtensionInstalled(Library Assert dd0be2ea-f733-4d65-bb34-a28f4624fb14)` once. If it
   fails or takes over 5 s, stop and write that.
2. Control app: `fetchPublishedAppPackage({publisher:"LethAL", name:"LethAL Control"})` once and
   `fetchControlVersion()` once. Record bytes, ms, manifest `Id` (= `CONTROL_APP_ID`?), `Version`
   (= `fetchControlVersion()`?), its dependency ids and names.
3. Walk the closure from Library Assert, `Application`, `Tests-TestLibraries`, the control app's
   dependencies (Test Runner) and `System`, each package downloaded ONCE through
   `fetchPublishedAppPackage`. Per package: name, manifest `Id` (Application: = `c1335042-…`?),
   version, bytes, ms, SHA-256 prefix, entry count and **`.al` entry count** (entry names ending
   `.al`; no source is read out or written).
4. For every closure app except `System` and the control app (so Application and Test Runner too):
   `fetchExtensionInstalled(id)` once. Record ms, rows, installed rows, installed version(s), "equals
   manifest version?".
5. Stop at the first failed or hung read (the 30 s verifier timeout); do not retry.
Output: append "Cronus284 per-id check" to `/coord/handoff/R-385/measurement.md`: date, lease, BC
build (System version), the control-app row, one table (steps 3-4, a row per app), totals (bytes,
download ms, per-id ms). No AL source.

## 4. Decision rule [r3] (applied before code is written)

1. **Bytes: chosen** by the orchestrator's ruling, and every r1 precondition the numbers can answer
   holds (byte-identical 13/13, not symbols-only, 2.6 s for 68.8 MB). r1's condition (iii) on
   `packageId` is dropped with the cache (D5).
2. **D2 as written** iff every non-System closure app (Application and Test Runner included) returns
   exactly one installed row equal to its manifest version on Cronus284. No row or two rows: stop
   and re-plan with that app named; do not guess an exemption.
3. **Cost** accepted iff the per-id total is under 2 s; else re-plan D2 (still never the list).
4. **[r3] Control-app root as written** iff the control package is served, its `Id` is
   `CONTROL_APP_ID`, its `Version` equals `fetchControlVersion()`, and it depends on Test Runner.
   Else stop and re-plan, naming the fact (no fall-back to the repo `app.json`).
5. **[r3] Application by GUID** iff the served `Id` is `c1335042-…`; else stop. **L1:** every
   package with 0 `.al` entries is named in L1; no re-plan.

## 5. Tasks (TDD; one red-check per direction of every two-way check)

**T0 [r3]. Guard: the extensions query is always filtered by one GUID id** (`harness.ts`,
`tests/doctor-issue-23.test.ts`, new `tests/extensions-query-refusal.test.ts`, new
`scripts/automation-api-guard.test.ts`). Three parts:
- (a) **Builder.** One private `fetchExtensionRows(appId)` builds the `extensions` path; it throws
  `HarnessVerificationError` for a non-GUID id before any fetch.
- (b) **Run-time refusal in `fetchApiRows`** (`harness.ts:398`), before the URL is built: if `path`
  contains `/extensions` (any case), `path` must hold no `?` and `extra` must have exactly one key,
  `$filter`, matching `^id eq <GUID>$` (8-4-4-4-12 hex, bare). Else it throws the new
  `UnfilteredExtensionsQueryError extends Error` (directly), naming the path and filter. This also
  refuses a new method inside `harness.ts` that forgets the filter, which no source scan sees.
- (c) **Source scan.** Fails on the text `api/microsoft/automation` in any file under
  `packages/*/src`, `packages/*/itest`, `packages/*/tests`, `scripts/` and `.claude/`, outside
  `harness.ts` (`docs/` is prose, not scanned; the guard builds its needle in two pieces). Allowed by
  file and exact hit count, each with a reason: `scripts/probe-continia-env.ts` (1, `companies`
  only, while the file holds no `extensions` text) and test files whose hit line carries
  `filter=id+eq+<GUID>`. Any other hit or changed count fails.
Tests: a non-GUID id (`""`, `"app-1"`) throws with zero fetches (existing tests move to a GUID);
every `extensions` URL a fake sees carries `$filter=id eq <that guid>`; `fetchApiRows` (called
through a cast) REFUSES with zero fetches: no `extra`; `publisher eq 'Microsoft'`; `id eq app-1`; a
GUID filter plus `$top`; `?$top=5` inside the path; and ALLOWS `id eq <GUID>` (one fetch, URL
checked); the companies path is unaffected. Callers that must still pass, all filtered by a GUID:
`lethal doctor` (`cli.ts:4858`, the tests `app.json` id) and five itests calling
`fetchExtensionInstalled(BASE_APPLICATION_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972")`:
`verify.itest.ts:268`, `verify-agreement.itest.ts:324`, `verify-scale.itest.ts:344`,
`harden.itest.ts:156`, `test-app-publish.itest.ts:232`.
Red-checks, restore after each: (builder) drop the GUID check, the `""` test goes red; (refuse)
delete (b), the refusal tests go red (they see a fetch); (allow) make (b) demand a quoted GUID, the
allowed-form test goes red; (scan) plant `packages/runner/itest/zz-automation-guard-scratch.ts`
holding the text, the guard goes red; delete it, green.

**T1 [r2]. `HarnessVerifier.fetchInstalledVersions(appId)`** (`harness.ts`). Fake rows: installed,
published-not-installed, malformed. Tests: installed versions only; a malformed row throws; N calls
make ONE companies GET (call counter). Red-checks: drop the `isInstalled` filter, the
not-installed test goes red; re-read companies per call, the counter test goes red; restore.

**T2 [r3]. `dependencyFingerprint` bytes mode** (`digest-inputs.ts`, `tests/digest-inputs.test.ts`).
Replace the "stated limit" test (`:71-80`, reader called 0 times) with **upgrade seen**: a Microsoft
dep moving from manifest `28.0.1.0` to `28.0.2.0` (declared `28.0.0.0` fixed) changes the
fingerprint (acceptance 4). Plus, each changes it: **same-version rebuild** (other bytes); a
Microsoft app reached only through another; `System`; [r3] **Test Runner**: a test app with NO
Microsoft dependency, a control package (right `Id` and `Version`) depending on Test Runner, Test
Runner's bytes change at the same version (and `installed` is asked for its id). An `application`
property walks `Application` and asks `installed` for `c1335042-…`. **Stability**: same packages,
dependencies in another order, same fingerprint. Fail-closed, each throws `DependencyUnreadableError`
naming the app: Microsoft read `null`; `System` read `null`/`undefined`; `System` not
Microsoft/System; no installed row; two; installed != manifest version; per-id read throws; [r3]
`Application` served with another `Id`; `readControl` `null`; control `Id` not `CONTROL_APP_ID`;
control `Version` != `controlVersion()`. Declared mode never equals bytes mode on the same inputs.
Red-checks, one per direction, restore each: (seen) restore r1's `M ... continue`, the upgrade AND
rebuild tests go red; (stable) hash lines in walk order without the sort, stability goes red;
(cross-check) skip `installed(id)`, the mismatch test goes red; (platform) skip `readSystem`, the
System test goes red; [r3] (control) drop the control root, the Test Runner test goes red; (control
version) skip that comparison, its test goes red; (Application) skip its id check, its test goes red.

**T3 [r3]. `BcDevMcpBackend.microsoftMode()`** (`bcdev-backend.ts`). Tests: wired to
`fetchPublishedAppPackage` (System, and `LethAL`/`LethAL Control` for `readControl`) and
`deployment.harnessVerifier` (`fetchInstalledVersions`, `fetchControlVersion`); no verifier
throws. Red-check: return `{kind:"declared"}` when the verifier is missing, the throw test goes red.

**T4 [r2]. Wiring** (`orchestrator.ts:7146-7158`, `verify.ts:1092-1103`, `digest-inputs.ts:347`).
Published path passes `backend.microsoftMode()`; al-runner passes `{kind:"declared"}`; a published
path without `microsoftMode` throws (run: no digests + warning; verify: `dependency-unreadable`).
Tests (`tests/verify.test.ts`, `tests/orchestrator.test.ts`), fake bcdev backend: Library Assert's
bytes change at the SAME version between run and verify, every reaching test is new (cause
`dependency`); unchanged leaves them old; no method refuses `dependency-unreadable`. Red-checks:
(up) wire verify with `{kind:"declared"}`, the changed-bytes test goes red; (down) fresh-but-equal
buffers per call, sort removed, dependencies reordered, the unchanged test goes red; (fail-closed)
fall back to `{kind:"declared"}`, the refusal test goes red. Update the R-372 tests
(`orchestrator.test.ts:572`) and `scripts/r371-reach-measure/dep-download.ts`.

**T5. Scheme v3** (`test-digest.ts:51`, `verify.ts:836-841`). Test: a source run whose digests start
`v2:` refuses `source-predates-verify` with the new text. Red-check: leave the scheme at `v2`, the
test goes red; restore.

**T6 [r3]. Docs and roadmap.** `digest-inputs.ts` module comment; `verify.ts:172-173` hint;
`docs/using-lethal-from-an-agent.md:535`, `:594-595`; CHANGELOG (Microsoft packages, `System` and
Test Runner hashed by bytes, about 3 s per run and verify, the once-per-run refusal, L0-L3). R433
step 5: its table in `docs/measurements/README.md`; "never list all extensions; read by id" in the
`al-probe` and `measurement-campaign` skills, without the API path (T0 scans `.claude/`). File the
al-runner item (D6) and L0, each as the next free `docs/roadmap/R<nnn>.md` (`ls docs/roadmap/`
right before EACH write). Close R433 with T0's commit, after merging master into the branch.

## 6. Final steps [r3]

1. `bun scripts/build-native-parser.ts` if the addon is stale; `bun run typecheck`; `rm -rf
   packages/*/dist`; `bun scripts/verify.ts` from the repo root; `bunx biome check` on touched files.
2. Live, foreground, under leases, ONLY on containers the orchestrator confirms healthy (Cronus28
   untouched until the owner says so): `LETHAL_ITEST_VERIFY=1 bun run itest:verify` (sandbox-tests;
   now downloads `System`, the control app and Test Runner; must pass with no new refusal or
   warning) and `LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement`. Recommended (the only fixture
   with a declared Microsoft dependency): `LETHAL_ITEST_VERIFY_SCALE=1 LETHAL_VERIFY_SCALE_OUT=<path>
   bun run itest:verify-scale`. Any verdict difference is a BLOCK. No baseline is re-recorded: no
   committed `packages/runner/itest/*.baseline.json` contains `testDigest` (checked 2026-10-04).
3. Set R385 `status: done (<commit>)`, `bun scripts/roadmap-index.ts` (again after master merges).
   Report: the Cronus284 table, the rule outcome, the red-check outputs (red and restored green),
   the added seconds per verify, and that identity, explain and the verify schema did not move.

## 7. Orchestrator rulings (on r2's open questions) [r3]

1. **Installed version differs from the served one** (a staged upgrade): REFUSE by name (D2, D4).
2. **Installed check for non-Microsoft dependencies:** out of scope for R385 (R-371 unchanged).
3. **Cost:** about 3.2 s per run and per verify, accepted; NO cache (D5).
