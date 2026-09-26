# C02-06: `lethal verify --artifact <id> --survivors <ids> --tests <dir> --db <path>`, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3 (2026-09-26),** after review round 1 (`H:/lethal-coord/reviews/C02-06-plan/review-r1.md`) and orchestrator rulings 7 to 12. Changed: the source run records a hash of the target's source inputs and verify refuses `source-changed` on any difference, replacing the per-site text check (finding 1, ruling 7, decision 8); a required `--artifact <id>` names the source, with no "newest run" default, and ids are always `<batchIndex>/<mutantCode>` (finding 2, ruling 8, decisions 2 and 3); any requested method without a valid green unmutated run makes its mutant `error` (finding 3, ruling 9, decision 13); old covering tests are matched to the source baseline by `(codeunitId, method)`, which needs the codeunit name stored on each test row (finding 4, ruling 10, decision 5); the killer's full `TestMethodRef` rides on the outcome (finding 5, ruling 11, decision 14); both unmutated runs of a new test are checked for a fresh session, and an unattributable one makes the test `flaky-unknown` (finding 6, ruling 12, decision 11). Every new rule has a red-check.

**Revision 2 (2026-09-26),** after orchestrator rulings 1 to 6: `killedBy` reported and never gating; every new test runs twice on the unmutated build; overfitting filed; gap ids a later task; the 20% ratio recorded here and gated in C02-08; split into coord `C02-06` and `C02-06b`; R248 designed for in part b.

**Goal:** An agent that added or changed tests can ask "do my tests now kill these survivors?" without a full run. `lethal verify` compiles the test project against the guarded build that is ALREADY installed, publishes it once under the lease, runs each named survivor against its old covering tests plus every new test, and prints one JSON kill proof with a verdict per survivor: `killed`, `survived`, `error` or `skipped`. The exit code is the gate.

**Architecture:** One new module, `packages/runner/src/verify.ts`, and one new subcommand. Everything that decides a verdict already exists: `runNamedMutants` (C02-04b) holds the lease, the quarantine latch, R194 and R206; `compileTestApp` and `publishTestApp` (C02-05) compile against the bound artifact and publish inside the fence, proving the result by the server's own read-back. `verify.ts` resolves the request (which artifact, which mutants, which tests), calls those, and maps the answer to JSON and an exit code. The store gains five nullable columns so it alone can answer "where are the installed files", "was this row carried", "what source was instrumented" and "which codeunit was that test". `runNamedMutants` gains three small, optional, off-by-default behaviours (decisions 11, 13, 14). Nothing reads the report file.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun test`, one live itest on Cronus28.

**Spec:** GitHub issue #16 (child 6 of epic #10, c02): "Resident-artifact check, new-test diff, per-survivor verdicts, `verifySchemaVersion` JSON, exit code, timings, refusal on multi-batch mismatch. Depends on: 1, 2, 4, 5." The owner's comment on #16 (requirements 1 to 5) is input; see "What this plan takes from the owner's comment on #16". Epic acceptance it serves ("one test-app publish, 4 killed / 1 skipped, a later full run agrees on all 5, under 20% of the full run's wall time") is MEASURED by C02-08 (#18) on C02-03's fixture, not here (decision 9).

**Line numbers:** none are load-bearing. Anchor on names.

## Dependencies, and what must land first

| Needs | State on `master` at writing (`d1d04cc`) | Used here for |
|---|---|---|
| C02-02: `batch_artifacts`, `artifactsForRun`, the report's `artifacts[]` | merged | the `--artifact` lookup; the agent reads the id from `artifacts[]` |
| C02-04b: `runNamedMutants`, `loadInstalledArtifact`, `InstalledArtifactRef`, `NamedMutantError`, `InstalledArtifactError`, ruling 6 order | merged | every verdict |
| C02-05: `BcDevMcpBackend.compileTestApp`, `publishTestApp`, `TestAppError`, `PublishedTestApp`, the `if (!safety.isUnsafe)` guard | on `lethal/lane-code`, not yet accepted (plus R247 and R248 filed there) | the one publish; decision 12 changes its pre-fence read |
| C02-01: per-survivor `artifactId`, `batchIndex` in `explain` | not implemented | NOT needed: the report already carries `artifacts[]` and each row's `batchIndex`/`mutantCode`. When it lands, `explain` gives the same three values per survivor |
| C02-03: `sandbox-harden` | not implemented | NOT needed here; C02-08 uses it |
| GH-24: `guardReached` | not implemented | NOT needed; a follow-up copies it into the JSON (decision 10) |

**Split (ruling 5):**
- **coord `C02-06`, part a** (Tasks 1 to 4): store columns and the offline resolution. No server, no C02-05 code. Can start now.
- **coord `C02-06b`, part b** (Tasks 5 to 9): the primitive changes, orchestration, JSON schema, CLI, live proof. Depends on `C02-06` and `C02-05`. Starts after both are accepted and `git merge master`, then one full test loop.

## Decisions

### 1. CLI shape

```
lethal verify --db <path> --artifact <32-hex id> --survivors <ids> --tests <dir> [--config <path>]
```

- `--db` REQUIRED, no default: the store is the only record of which run published which artifact and where its files are.
- `--artifact` REQUIRED (ruling 8): the source identity, exactly as the report's `artifacts[].artifactId` (and, after C02-01, `explain`'s per-survivor `artifactId`) prints it. 32 lowercase hex, else refused before the store is opened.
- `--tests` REQUIRED: the test project to compile and publish. Already in `RUN_FLAGS`.
- `--survivors` NEW, `{ type: "string", multiple: true }`, each value a comma list, repeats union.
- `--config` defaults to `<project>/lethal.config.json`, where `<project>` is the source run's `runs.project_path`. There is no `--project`.
- Output: JSON on STDOUT, progress on STDERR (the `run` renderer, reused). `verify` REFUSES every shared flag outside `db`, `artifact`, `survivors`, `tests`, `config`, by an explicit allowlist, so `--out`, `--report`, `--project`, `--backend` are refused, never ignored (the `--report`-on-`run` trap, closed from day one).
- `artifact` and `survivors` join `FLAG_OWNERS` with `owners: ["verify"]`, so `run --artifact` and `run --survivors` are refused too.
- bcdev only. A config with an `envTool` section is refused up front (C02-05 decision 6). No `--backend` flag, so al-runner cannot be asked for.

### 2. Survivor ids: `<batchIndex>/<mutantCode>` within the named artifact

Every id is `<batchIndex>/<mutantCode>` (for example `0/M0004`). No bare form: one spelling, one parser. `batchIndex` must equal the batch `--artifact` names (refused `wrong-batch`, naming both); the code is resolved inside that artifact's trusted manifest (C02-04b). An id copied from another run can therefore never select a different mutant silently: it either names this artifact's batch, or it is refused (review finding 2).

### 3. How verify finds the run, the artifact and its files

**By the named artifact, never by recency (ruling 8).** `store.artifactRecordById(artifactId)` reads `batch_artifacts` joined to `runs`. Refusals, all before any server call: no row (`unknown-artifact`); more than one row (`unknown-artifact`, "the store records this id twice", which a random 32-hex id should make impossible, so it is a corrupt store, not a choice); the batch is not its run's highest `batch_index` (`batch-not-installed`: every batch publishes the same app id, so only the last stays installed, C02-02). A verify row can never be picked, because `runNamedMutants` writes no `batch_artifacts` row (C02-04b test "runNamedMutants never deploys the target").

**The files.** `loadInstalledArtifact` needs `appPath` and `instrumentedDir`, which `runFromCli` puts under a random `mkdtemp(tmpdir(), "lethal-")` scratch root that nothing records. So `batch_artifacts` gains `app_path` and `instrumented_dir`, written at step 3d from `compiled.appPath` and the batch dir. They are NOT identity: `loadInstalledArtifact` still hashes the files against the trusted row (moved or edited: `local-copy-differs`; a cleaned temp dir: `local-copy-unreadable`, both mapped to `artifact-files-unusable`, "re-run `lethal run`"). A row without them is refused as `source-predates-verify`.

**Installed on the server.** The recorded artifact is checked against the server by ruling 6's PREFLIGHT `attach`, before `inLease`: if another run has since published a different target, `InstalledArtifactError("mismatch")` refuses before any test app is published, mapped to `stale-artifact` ("re-run `lethal run`, then verify with its artifact id").

**Carried rows.** `mutants` gains a nullable `carried INTEGER`, written `1`/`0` by `record()`. A named row with `carried = 1` is refused as `carried`; `NULL` is refused as `source-predates-verify` (unknown is never "not carried").

**Pool workers.** Only al-runner can have workers (bcdev with `--workers > 1` is refused at parse time), and verify is bcdev only, so a worker-produced verdict can never be a verify source.

### 4. The verify run row: never finished, never resumable, never history

```ts
store.createRun({ projectPath: source.projectPath, backend: "lethal-verify", appVersion: "0.0.0.0" });
```

No `configFingerprint`, so the column is NULL. Excluded from every reader, with no new "run kind" column (review r1 confirmed these hold):
- `priorSurvivorKeys` reads only `finished_at IS NOT NULL`; verify never calls `finishRun`, and `runNamedMutants` refuses a finished row.
- `findResumableRun` requires `backend = ?` AND `config_fingerprint = ?`; a verify row fails both (`NULL = ?` is never true in SQLite, which the R47 comment in `migrate` already relies on). An explicit `--resume-run <verify id>` is refused by `resolveResume`'s backend/fingerprint check.
- `artifactRecordById` reads `batch_artifacts`, which a verify row never has.

### 5. Which tests run per survivor, and how each is identified

For each non-skipped survivor: **its source-run covering tests UNION every new test**, deduplicated by `testKeyOf`.

- **Covering tests are matched by `(codeunitId, method)` (ruling 10).** `mutants.covering_tests` holds qualified `Codeunit.Method` NAMES. Each name is mapped to the source run's BASELINE row with that `codeunit_name` and `method` (new column `test_results.codeunit_name`, written by `recordTestResult` from the `TestMethodRef` it already receives; no call site changes). Exactly one row must match; its `codeunit_id` is the source identity. The current `discoverTests(--tests)` must then contain that SAME `(codeunitId, method)` with the same codeunit name. Anything else, a renumbered codeunit, a renamed codeunit, a removed method, zero or two source rows, is refused as `covering-test-unmatched`, naming the covering test and both identities. A same-named replacement is never substituted (review finding 4). A source row with `codeunit_name IS NULL` is refused as `source-predates-verify`.
- **New tests** are the methods `discoverTests(--tests)` finds whose `testKeyOf` (`codeunitId::method`) is NOT among the source run's baseline rows. Keyed on the source run, so a test stays "new" across every verify iteration. An empty source baseline is refused (`source-predates-verify`): it would make every test "new" silently.
- **Why keep the old covering tests:** "strengthen an assertion" edits an EXISTING covering test; running only new tests would miss that fix.
- **The blind spot, stated:** an existing test that did NOT cover the mutant and was edited to reach it is neither covering nor new, so it does not run. Recompiling cannot detect an edit, because `alc` output is not byte-deterministic (C02-05 Task 0). Filed in Task 9.
- A `no-coverage` survivor with no new tests has nothing to run: refused as `no-tests-to-run`.

### 6. "skipped": a reader mark, and nothing else

A named survivor whose R166 identity (`serializeKey(identityKeyOf(<manifest entry>))`) matches a mark in the project's CURRENT `lethal.equivalent.json` is `skipped`: not sent to `runNamedMutants`, not a verdict (R172). Read at verify time (the agent may mark after the run), matched against the TRUSTED manifest entry, so C02-01 is not needed. `identityKeyOf` already applies the `||` rule R229 is about; R230 (twins after the first cannot be marked) still applies. `equivalenceRisk` NEVER skips (class-level and advisory). All skipped: no compile, no lease, no publish, exit 0.

### 7. What the JSON says, and what "error" covers

`VERIFY_SCHEMA_VERSION = 1`, hand-written `schemas/verify-v1.schema.json` (small, like `doctor` and `explain`; `schemas/README.md` gains a row), pinned by `schemas.test.ts` both ways against `VerifyOutput`.

```ts
export const VERIFY_SCHEMA_VERSION = 1;
export const VERIFY_VERDICTS = ["killed", "survived", "error", "skipped"] as const;
export const VERIFY_REFUSALS = [
  "malformed-request", "unknown-artifact", "batch-not-installed", "wrong-batch", "unknown-mutant",
  "not-a-survivor", "carried", "source-predates-verify", "source-changed",
  "covering-test-unmatched", "no-tests-to-run", "unsupported-config",
  "stale-artifact", "artifact-files-unusable",                                        // InstalledArtifactError
  "test-app-compile-failed", "test-app-version-below-resident", "test-app-publish-failed",
  "test-app-resident-unreadable",                                                     // TestAppError
] as const;
export const KILLED_BY = ["assertion", "runtime-error", "other"] as const;
export const NEW_TEST_STATES = ["stable", "flaky", "red", "flaky-unknown"] as const;
export interface UnmutatedRun {
  readonly outcome: "pass" | "fail" | "not-run";
  readonly fresh: boolean;                      // decision 11
  readonly sessionId?: number;
  readonly testRunsBefore?: number;
}
export interface NewTestResult {
  readonly test: string;                        // qualified Codeunit.Method
  readonly codeunitId: number;
  readonly state: (typeof NEW_TEST_STATES)[number];
  readonly runs: readonly UnmutatedRun[];       // [baseline, rerun]
  readonly failure?: string;                    // the first failing run's text
}
export interface VerifyResult {
  readonly id: string;                          // "<batchIndex>/<mutantCode>"
  readonly batchIndex: number;
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  readonly verdict: (typeof VERIFY_VERDICTS)[number];
  readonly testsRun?: readonly string[];        // qualified names sent to runNamedMutants
  readonly invalidBaseline?: readonly string[]; // decision 13: requested methods without a valid green unmutated run
  readonly killingTest?: { readonly codeunitId: number; readonly codeunitName: string; readonly method: string };
  readonly killedByNewTest?: boolean;           // decision 14: by testKeyOf, never by method name
  readonly killedBy?: (typeof KILLED_BY)[number];
  readonly killingTestFailure?: string;
  readonly failureNote?: string;
  readonly skipped?: { readonly reason: "reader-marked-equivalent"; readonly mark: { readonly key: string; readonly reason: string } };
}
export interface VerifyOutput {
  readonly verifySchemaVersion: number;
  readonly ok: boolean;                         // exitCode === 0
  readonly exitCode: number;
  readonly source?: { readonly runId: number; readonly batchIndex: number; readonly artifactId: string; readonly artifactSha256: string; readonly sourceSha256: string };
  readonly verifyRunId?: number;
  readonly testApp?: { readonly name: string; readonly version: string; readonly sha256: string; readonly compiledAgainst: { readonly artifactId: string; readonly sha256: string } };
  readonly newTests: readonly NewTestResult[];
  readonly results: readonly VerifyResult[];
  readonly counts: { readonly killed: number; readonly survived: number; readonly error: number; readonly skipped: number };
  readonly quarantined?: string;
  readonly refused?: { readonly reason: (typeof VERIFY_REFUSALS)[number]; readonly detail: string };
  readonly timings: { readonly totalMs: number; readonly compileMs?: number; readonly publishMs?: number };
}
```

- `testApp` is C02-05's `PublishedTestApp`: the SERVER's read-back hash and version, never the local compile's (`alc` is not deterministic).
- **`killedBy`** (ruling 1), one pure function `killedByOf(text, testAppName)`, in order: `assertion` when `looksLikeAssertionFailure(killMessageOf(text))` (R121's `Assert.` prefix) or the text names `NavNCLAssertErrorException` (the test's own `asserterror` expectation failed); `runtime-error` when the first callstack frame (second line, `<Object>(CodeUnit <id>).<Method> line <n> - <App> by <Publisher> version <v>`, the shape in `examples/credit-limit/demo.report.json`) names an app other than the test app; `other` otherwise, including a bare `Error(...)` raised in the test and a text with no parseable frame. Reported with the failure text, NEVER gating: this deviates from #16 requirement 5's wording ("killed by an assertion") because R121's rule is 26.1% precise on the one scored corpus and flags every kill on a bare-`Error(...)` suite (`itest:bcdev` pins `discrimination: "vacuous"`), so gating would fail every kill on `sandbox-app` and `sandbox-harden`. No `ui-unhandled` detector.
- **`error` covers:** a requested method without a valid green unmutated run (decision 13, `invalidBaseline` names them); a strand, timeout or in-flight-unknown run; a batch the section G gate or a lost lease invalidated; a `session-reused` kill the mutant loop already refuses (R206); "not run: the session latched unsafe". It never covers a refusal. **A refusal** has `refused` set and `results: []`, always.

**Exit codes** (constants exported from `cli.ts`):

| Code | Meaning |
|---|---|
| 0 | every non-skipped survivor `killed`, AND every new test `stable`. `killedBy` plays no part |
| 3 | quarantined: `res.quarantined` set, or `TestAppError` `publish-indeterminate`/`publish-anomalous` (both leave `container-needs-recycle`) |
| 4 | every non-skipped survivor `error`: nothing measured (same meaning as `run`'s 4) |
| 5 | NEW. Some non-skipped survivor `survived` or `error`, or some new test not `stable` |
| 6 | NEW. Refused before measuring; `refused.reason` says why |
| 1 | an uncaught failure |

Precedence: 3, 6, 4, 5, 0.

### 8. The source-changed check: the target's source hash (ruling 7)

Owner requirement 1, literally: if the target's source changed since it was instrumented, refuse with "re-instrument first".

- **SUPERSEDED by the r2 fix below (erratum 2026-09-26, lane ruling confirmed): the r1 rule was** `hashTargetSource(projectDir, testDir)` = SHA-256 over every `*.al` file under `projectDir` plus `projectDir/app.json`, as `<forward-slash relative path> NUL <bytes> NUL` in sorted path order, EXCLUDING any file under `testDir` when the test project is nested inside the target (fixtures are siblings, real repos sometimes nest), and excluding nothing else. A new helper beside `hashAlTree` in `baseline-snapshot.ts`; `hashAlTree` itself is not changed (R192 reads it).
- **`app.json` is IN.** It is a compile input of the instrumented build: `dependencies`, `runtime`, `features`, `preprocessorSymbols` and the id ranges all change what `alc` builds. Choosing a subset of its fields would be a second model of what matters, which is how a check goes stale. Cost, stated in the refusal text: a version-only bump also refuses, and costs one `lethal run`.
- **What is hashed (orchestrator fix after review r2, finding 1):** exactly the inputs the TARGET build uses: every `*.al` file `prepareBatchProject` copies from `projectDir` (it copies ALL of them, including a nested test directory's, so nothing under `projectDir` is excluded unless the build excludes it too), plus `app.json`, plus the sorted `preprocessorSymbols` the config passes to the target compiler (`buildBackend` in `cli.ts`), serialized as one line. Share one enumeration with `prepareBatchProject` (extract it if needed) so the two cannot drift.
- **When it is recorded (finding 2):** bound to the source actually compiled. Compute the hash once from the file contents generation reads, and again after the LAST batch's preparation; record `runs.source_sha256` only when the two agree. When they differ (the tree was edited during the run), record NULL and emit a warning naming the run as not verifiable; verify then refuses it as `source-predates-verify`. A test edits a file between the two reads and asserts NULL. **Checked** by verify before any server call: recompute now, compare; a difference is `source-changed` ("the installed build was made from other source; run `lethal run` again, then verify"). NULL is `source-predates-verify`.
- **Ceiling, named in a `ponytail:` comment:** files outside `*.al`, `app.json` and the compile symbols (a `.xlf`, a report layout, the rest of `lethal.config.json`) are not hashed. They do not change AL behaviour under test the way AL does; add them if a measured case shows otherwise.
- The per-site text comparison of revision 2 is dropped (ruling 7 allows it as a diagnostic; the whole-source hash subsumes it, so it is not built).

### 9. The live proof here, and the 20% measurement (ruling 4)

C02-06's live proof runs on `sandbox-app` now. The epic acceptance, including the 20% ratio, is C02-08's on `sandbox-harden`. `itest:verify` PRINTS `verify.timings.totalMs / fullRun.timings.totalMs`; the submit note records it; it is not gated. Verify has fixed costs (a test-app compile, one publish, a lease, a baseline, the second unmutated run) a small fixture's full run does not dwarf, so the ratio may be above 20% even when verify is correct; Task 8's printout is the first measurement.

### 10. GH-24 and C02-01: nothing waits

- **GH-24.** C02-04's decision 1 trust assumption covers `survived`. When GH-24 lands, a follow-up copies `guardReached`/`reachedBy` onto `VerifyResult` with Decision 8's narrow wording ("the mutant's statement began executing"), additive, no bump.
- **C02-01.** Not needed. Its packet can print the verify command from `artifactId`, `batchIndex` and `mutantCode`.

### 11. Flakiness: two FRESH unmutated runs of every new test (rulings 2 and 12)

`NamedMutantsConfig` gains `rerunOnUnmutated?: readonly TestMethodRef[]`; `NamedMutantsResult` gains `baseline` and `rerun`, each entry `{ ref, outcome, failureMessage?, testRunsBefore?, sessionId?, fresh }`.

- **Where the second run happens:** after `scoreBatch` returns and only when `!safety.isUnsafe`: `activate(null)`, then each listed method through the SAME baseline dispatch `scoreBatch` uses (`runOnce` plus `handleBaselineLeaseOutcome`), so the lease, in-flight and quarantine rules are the shared ones. Its rows are written under the verify run like any baseline row. After the covering loop on purpose: a test that passes clean but fails after mutant runs touched the server is the "not a fix" case the owner named, and `scoreBatch` needs no change.
- **Freshness (ruling 12, review finding 6).** The baseline dispatch records outcomes without the R206 check the mutant loop applies. So `runNamedMutants` computes `fresh` per unmutated run, with the mutant loop's own predicate: `testRunsBefore === 0` and a defined `sessionId`; for a RERUN also a `sessionId` not seen in any earlier call of this verify session. "Seen" is the set of `session_id`s recorded under the verify run before the rerun starts (baseline calls, covering calls, and the R206 warm replays and confirmations, which all record rows), snapshotted from the store once, and GROWN as the rerun loop goes: each rerun's `sessionId` is added to the set before the next method is dispatched (orchestrator fix after review r2, finding 3), so two reruns reporting the same session cannot both be fresh. A test returns the same `sessionId` for two reruns with `testRunsBefore: 0` and asserts the second is `flaky-unknown`; red-check: stop growing the set and it goes `stable`. `testRunsBefore` absent (not a `ran` answer) is not fresh.
- **State of a new test:** `red` when its baseline run is a fresh `fail`; `stable` when both runs are fresh `pass`; `flaky` when the baseline is a fresh pass and the rerun a fresh `fail`; `flaky-unknown` in every other case (a run that was not fresh, or `not-run`). Only `stable` allows exit 0. Ruling 2's "fails either run" is honoured: every non-`stable` state blocks.
- **Overfitting** is not cheap from collected data (verify never runs the unnamed survivors): filed in Task 9.

### 12. R248: a pre-fence read that cannot answer refuses, before the fence (ruling 6)

`publishTestApp` reads the resident package BEFORE the fence to refuse a downgrade, and `fetchPublishedAppPackage` returns `null` alike for a 404, a 401 and a timeout. With C02-05 as built, a wrong `BC_DEV_USER`/`BC_DEV_PASSWORD` publishes anyway, reads back `null`, and ends `publish-indeterminate` with a recycle record: every verify strands the container.

**Decision: a pre-fence `null` throws `TestAppError("resident-unreadable")`, before `fence.publish`, so no marker is claimed.** Pre-fence `TestAppError`s are already terminal in `runLeaseHook` (C02-05, `7d74030`), so the lease is released with no recycle record. The fetch contract does not change (R139 check 2 reads the same `null`); no 404 detection is added. "Never published" needs no pass-through: in verify the test app is always resident, because the source run's baseline executed it (R139 check 1 refuses a run whose methods are not on the server), and `publishTestApp`'s other caller, `itest:testapp`, publishes over a resident app too. The message names both causes (not published, or unreadable with the configured dev credentials, by NAME) and prints no credential value.

**Only the pre-fence read changes.** Every in-fence classification stays exactly as C02-05 ships it in `decideTestAppOutcome`: in particular a read-back after an altool failure that cannot be read stays `publish-indeterminate` (marker kept, recycle), because the fence was entered and the server may have taken the package. Pinned by C02-05's existing test `"publishTestApp: a failed exit with an unreadable read-back is publish-indeterminate, never publish-failed"`, unedited, plus a red-check in Task 5.1. (C02-05 as MERGED (cd604f5, run 002) maps a failed exit whose read-back answered with the old package to `publish-failed` ONLY when BC's own downgrade refusal text is present, and to `publish-indeterminate` otherwise; R250 tracks anchoring that text. This plan does not change either.)

Two C02-05 tests read `null` pre-fence to reach BC's in-fence downgrade refusal (`"publishTestApp: a BC downgrade refusal inside the fence is publish-failed and names the installed version"` and `"C02-05: a confirmed test-app publish failure ends the marker as failed and records no recycle"`). Their FIRST read becomes a resident package at the SAME version as the local `app.json`, which passes the pre-fence check as `null` did; their assertions are untouched. R248 is closed `done (<commit>)` by Task 5.1. Task 5.1 adds `resident-unreadable` to C02-05's `TERMINAL_REASONS` allow-list as well as to the refusal type: `TestAppError.confirmedTerminal` is an allow-list, and `runLeaseHook` latches any error absent from it as an uncertain publish. The test asserts the uncertainty warning ("no proof that the server stopped") is ABSENT, besides no marker and no recycle; red-check: leave it out of `TERMINAL_REASONS` and that assertion goes red.

### 13. Every requested method needs a valid green unmutated run (ruling 9)

C02-04b's `selectNamed` drops a red method and scores the mutant on the rest (its test "a red baseline method is never run against its mutant" pins that). For verify that is wrong: an old covering test that went red, or a broken new test, would be silently omitted while the others produce `killed` or `survived` (review finding 3).

`NamedMutantsConfig` gains `requireEveryMethodGreen?: boolean` (default off, so C02-04b's pinned behaviour is unchanged). When on, `selectNamed` records the mutant `error` if ANY of its requested methods lacks a VALID green baseline run, where valid means `outcome === "pass"` AND fresh (decision 11's predicate). The failure note names every such method with its outcome, failure text, or "not fresh: session <id> had run <n> test(s) before"; the mutant is never activated. Verify always passes `true` and copies the names into `invalidBaseline`.

### 14. The killer's full identity (ruling 11)

`SessionOutcome.killingTest` is the bare `ref.method` at every kill site, so two tests with the same method name in different codeunits cannot be told apart (review finding 5). `SessionOutcome` gains `killingTestRef?: TestMethodRef`, set beside `killingTest` at each site that decides a kill (`runMutantsOnBackend`'s confirmation branch, its timeout branch, and the warm-confirmation branch; the resume replays have no ref and leave it absent). It is NOT copied to `MutantOutcome` or any event, so `SessionReport` and both generated schemas do not move (`generate-schemas.ts` must show no diff: `SessionOutcome` is internal to `buildReport`'s input). Verify reports `killingTest` from the ref and sets `killedByNewTest` by `testKeyOf(ref)` membership in the new-test set, never by method name. If a kill arrives without `killingTestRef`, verify throws a plain `Error` (a bug, exit 1), never guesses.

## What this plan takes from the owner's comment on #16

| Requirement | Here |
|---|---|
| 1. Keep the resident artifact, republish only the test app, run only named mutants and tests; refuse on changed source | Yes: decisions 3, 5, 8 (whole-source hash, ruling 7) |
| 2a. The test passes on the unmutated code | Yes: twice, both runs fresh (decision 11); any other state blocks exit 0; decision 13 makes its mutant `error` |
| 2b. The test kills the mutant | Yes: `killingTest` as a full ref, `killedByNewTest` by id (decision 14) |
| 2c. `killedBy` | Yes: `assertion`/`runtime-error`/`other` with the text; reported, not gating (ruling 1) |
| 3. Gap ids | No: a separate task after C02-06 (ruling 3) |
| 4. Overfitting; passes twice in a row | Twice: yes. Overfitting: filed (ruling 2) |
| 5. Exit codes | Yes (decision 7); exit 0 does not require an assertion kill (ruling 1) |

## Review Focus

Each pinned by a named test:

1. **The request names exactly one source, and nothing else is verified against it.** An unknown artifact, an artifact that is not its run's installed batch, an id from another batch, a carried row, a stale server artifact, or a changed target source: each is refused with its reason and exit 6, never `survived`. Pinned by `"verify refuses an artifact id the store does not hold"`, `"verify refuses an artifact that is not its run's highest batch"`, `"an id from another batch of the same artifact's run is wrong-batch, even when that batch has the same code"`, `"verify refuses a carried row"`, `"verify refuses a row recorded before the carried column existed"`, `"an edit to a helper outside every mutated procedure is refused as source-changed"`, and `"verify: a server holding another artifact is refused as stale-artifact and publishes nothing"`.
2. **No requested method is silently dropped, substituted or misattributed.** Pinned by `"a mutant whose old covering test is red at baseline is error naming that test, although another method is green"`, `"a mutant whose new test is red at baseline is error, although its covering test is green"`, `"a renumbered covering codeunit with the same name and method is refused, never run as the old test"`, and `"killedByNewTest is exact when an old and a new test share a method name"` (both directions).
3. **"Passed twice" means two attributable runs.** Pinned by `"a new test that passes the baseline and fails a fresh rerun is flaky and forces exit 5"`, `"a rerun in a session a warm replay already used is flaky-unknown"`, `"a baseline run with testRunsBefore above 0 is flaky-unknown, and its mutant is error"`, and `"runNamedMutants: rerunOnUnmutated runs each method once more with no mutant active, after the covering loop"`.
4. **The verify run row never becomes history or a resume target, and one publish happens at most once, proven by read-back.** Pinned by `"a verify run row is never found by findResumableRun, priorSurvivorKeys or artifactRecordById"`, `"verify never finishes its run row"`, `"verify compiles before the lease and publishes the test app exactly once, inside the fence"`, and `"verify reports the server's read-back identity, not the local compile's"`.
5. **A reader-marked equivalent is skipped, not run, not a verdict, and R248 cannot strand the container.** Pinned by `"a reader-marked survivor is skipped and never reaches runNamedMutants"`, `"every survivor skipped: no compile, no lease, no publish, exit 0"`, `"equivalenceRisk alone never skips"`, and `"publishTestApp refuses an unreadable resident package before the fence, claiming no marker (R248)"`.

Also pinned: `"verify refuses every shared flag outside its allowlist, --out and --report included"`, `"run refuses --artifact and --survivors"`, `"the exit code precedence is 3, 6, 4, 5, 0"`, `"a TestAppError publish-indeterminate exits 3"`, `"killedBy never changes the exit code"`, `"killedByOf reads assertion, runtime-error and other from the measured callstack shapes"`, `"hashTargetSource includes app.json and excludes a nested test project"`.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`.
- `VerifyError extends Error` directly, `readonly reason` (a `VERIFY_REFUSALS` member) and `readonly detail`. It extends none of `NamedMutantError`, `InstalledArtifactError`, `TestAppError`, `DeploymentError`, `AlcCompileError`, and none extends it.
- Fail loudly: an unknown carried state, a missing source hash, an empty baseline set, an unmatched covering test, a malformed `covering_tests`, an unreadable marks file, a kill without a ref: each is a typed refusal or a thrown bug, never an empty default.
- No `SessionReport` field, event type, `Caveat` or `MutantErrorCause` is added. `REPORT_SCHEMA_VERSION`, `STREAM_SCHEMA_VERSION`, `EXPLAIN_SCHEMA_VERSION` do not move; `bun scripts/generate-schemas.ts` produces no diff.
- The five store columns (`batch_artifacts.app_path`, `batch_artifacts.instrumented_dir`, `mutants.carried`, `runs.source_sha256`, `test_results.codeunit_name`) are nullable and added with the `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN` pattern `migrate` uses for `manifest_sha256`.
- The only edits on `lethal run`'s path are store writes (the five columns, and one source hash per run) and the `killingTestRef` field on `SessionOutcome`. No verdict, event or report field moves.
- The only changes to the C02-04b and C02-05 primitives: `rerunOnUnmutated`, `requireEveryMethodGreen` and `killingTestRef` (each absent or off: behaviour unchanged, pinned by the existing tests passing unedited), and decision 12's pre-fence refusal.
- Live work: Cronus28 only, under `coord lease Cronus28 code`, heartbeat every 5 minutes, release right after, one gate at a time.
- No em dashes. Roadmap text cites names, never `file.ts:<line>`. Re-check the next free roadmap id (`ls docs/roadmap/` on master AND `git show lethal/lane-code:docs/roadmap/`) right before writing: at least R248 is taken across branches.
- Agent docs are C02-07's. This task changes only `helpText` and `schemas/README.md`.

---

# Coord C02-06 (part a): store and offline resolution (no server, no C02-05)

### Task 1: Five store columns, the source hash, and the queries

**Files:** Modify `packages/runner/src/store.ts`, `packages/runner/src/baseline-snapshot.ts` (`hashTargetSource`), `packages/runner/src/orchestrator.ts` (step 3d's `recordArtifact` call; `record()`'s `recordMutant` call; one `recordSourceHash` call after `createRun`). Test: `store.test.ts`, `baseline-snapshot.test.ts` (or the file that tests `hashAlTree`), `orchestrator.test.ts` (Layer 5A identity describe), `resume.test.ts`.

**Interfaces:**

```ts
// recordArtifact's info gains: appPath?: string; instrumentedDir?: string   (absent writes NULL)
// MutantRow gains:            carried?: boolean                              (record() always passes it)
// recordTestResult writes ref.codeunitName into test_results.codeunit_name  (signature unchanged)
recordSourceHash(runId: number, sha256: string): void;
/** C02-06: the batch that recorded this artifact id, with its run. `null` when none; throws on two rows. */
artifactRecordById(artifactId: string): { runId: number; projectPath: string; batchIndex: number;
  highestBatchIndex: number; artifactSha256: string; sourceSha256: string | null;
  appPath: string | null; instrumentedDir: string | null } | null;
/** One batch's mutant rows. `carried` null on a pre-column row. */
batchMutantRows(runId: number, batchIndex: number): Array<{ mutantCode: string; verdict: MutantVerdict;
  coveringTests: readonly string[]; carried: boolean | null }>;
/** Every BASELINE row of a run (mutant_row_id IS NULL), deduplicated. `codeunitName` null on a pre-column row. */
baselineTests(runId: number): Array<{ codeunitId: number; codeunitName: string | null; method: string }>;
/** Every session_id recorded under a run (decision 11's snapshot). */
sessionIdsOf(runId: number): Set<number>;

// baseline-snapshot.ts
/** Decision 8. Every *.al under projectDir plus projectDir/app.json, minus anything under testDir. */
export async function hashTargetSource(projectDir: string, preprocessorSymbols: readonly string[]): Promise<string>; // erratum: r2 rule, shares prepareBatchProject's enumeration
```

- [ ] **Step 1: Write the failing tests.**
  - `store.test.ts`: `"recordArtifact stores the app path and batch dir, and artifactRecordById returns the batch, its run's highest batch and the source hash"` (one run with two batches: looking up batch 0's id gives `batchIndex 0, highestBatchIndex 1`); `"artifactRecordById is null for an unknown id"`; `"a database from before C02-06 gains the five columns, and old rows read back null"` (the pattern C02-04b's manifest-hash migration test uses); `"batchMutantRows reads carried as true, false, or null"`; `"baselineTests reads only baseline rows, with their codeunit names"`; `"sessionIdsOf returns every session id of a run and none of another's"`.
  - `"a verify run row is never found by findResumableRun, priorSurvivorKeys or artifactRecordById"`: a real store; run A `runSession`-shaped (backend, fingerprint, `recordArtifact`, a `survived` row, `finishRun`); run B via decision 4's exact `createRun` with `survived` and `killed` rows. `findResumableRun` with A's backend and fingerprint is `null`; `priorSurvivorKeys` equals A's keys; `artifactRecordById(A's id)?.runId` is A. Negative control in the same test: a third row with A's backend and fingerprint and a `survived` row IS found by `findResumableRun`.
  - `baseline-snapshot` tests: `"hashTargetSource changes when a helper .al file changes"`, `"hashTargetSource includes app.json and excludes a nested test project"` (edit `app.json`: changes; edit a `.al` under a nested `testDir`: unchanged; add a `.xlf`: unchanged, the stated ceiling), `"hashTargetSource does not depend on directory listing order"` (same files written in two orders).
  - `orchestrator.test.ts`: `"step 3d records the app path and batch dir it compiled"` (against `PhaseBackend.returned[0].appPath`, C02-02's independent oracle); `"runSession records the target source hash before generation"` (equals `hashTargetSource(projectDir, testDir)` computed by the test itself).
  - `resume.test.ts`, on the R192 run with exactly one carried mutant: `"a carried verdict is stored carried, a measured one not"`.
  - **Erratum 2026-09-26 (r2 rule, lane ruling confirmed):** the nested-test test reads "a nested test project's .al IS hashed, because the target build copies it" (plus app.json in, .xlf out, order-independent); the recording test reads "records the hash only when generation and the last batch's preparation agree; an edit between them records NULL and warns". Where the two bullets above say otherwise, this line wins.
- [ ] **Step 2: Run and see them fail.** **Step 3: Implement.** **Step 4: Run** the loop. The C02-04 Part A characterization snapshots select explicit columns and must not change; if one does, stop and report.
- [ ] **Step 5: Red-checks** (red line, then restored green):
  - write `carried` only when true: "carried as true, false, or null" goes red;
  - (erratum 2026-09-26, replaces the r1 "drop the `testDir` exclusion" check) record the source hash unconditionally instead of only when generation and last-batch preparation agree: "an edit between the reads records NULL and warns" goes red;
  - leave `app.json` out: the same test goes red on the `app.json` edit;
  - hash in `readdir` order without sorting: "does not depend on directory listing order" goes red;
  - drop `codeunit_name` from the INSERT: "with their codeunit names" goes red;
  - compute `highestBatchIndex` from the looked-up row: the two-batch lookup goes red;
  - give the verify row A's backend name: the exclusion test stays GREEN (the NULL fingerprint still excludes it); add A's fingerprint too: red on `findResumableRun`. Report both lines: each exclusion holds on its own.
- [ ] **Step 6: Commit** `feat(store): record the installed files, source hash, carried verdicts and test codeunit names that lethal verify reads (C02-06)`.

### Task 2: Parse the request and resolve the source

**Files:** Create `packages/runner/src/verify.ts`. Test: create `packages/runner/tests/verify.test.ts`.

```ts
export class VerifyError extends Error {
  constructor(readonly reason: (typeof VERIFY_REFUSALS)[number], readonly detail: string) {
    super(`verify refused (${reason}): ${detail}`);
    this.name = "VerifyError";
  }
}
/** Decisions 1 and 2. 32-hex artifact; `<batchIndex>/<mutantCode>` ids; comma lists; refuses empty, malformed, repeated. */
export function parseVerifyRequest(artifact: string, survivors: readonly string[]):
  { readonly artifactId: string; readonly ids: ReadonlyArray<{ readonly batchIndex: number; readonly mutantCode: string }> };
export interface VerifySource {
  readonly runId: number;
  readonly projectPath: string;
  readonly artifactSha256: string;
  readonly sourceSha256: string;
  readonly installed: InstalledArtifactRef;
  readonly targets: ReadonlyArray<{ readonly batchIndex: number; readonly mutantCode: string; readonly coveringTests: readonly string[] }>;
}
/** Decision 3. Store only. Never touches a file or a server. */
export function resolveVerifySource(store: ResultsStore, req: ReturnType<typeof parseVerifyRequest>): VerifySource;
/** Decision 8. Reads the project's files; never a server. */
export async function assertSourceUnchanged(source: VerifySource, preprocessorSymbols: readonly string[]): Promise<void>; // erratum: r2 rule
```

`resolveVerifySource`, in order: `artifactRecordById` or `unknown-artifact`; `batchIndex !== highestBatchIndex` -> `batch-not-installed`; null paths or null `sourceSha256` -> `source-predates-verify`; then per id: batch not the artifact's -> `wrong-batch`; no row -> `unknown-mutant`; `carried === null` -> `source-predates-verify`; `carried` -> `carried`; verdict not `survived`/`no-coverage` -> `not-a-survivor` (`known-survivor` says "re-run without --skip-known-survivors"). Every per-id refusal names ALL offending ids.

- [ ] **Step 1: Failing tests** (real `ResultsStore(":memory:")`, Task 1's writers): `"parseVerifyRequest refuses a non-hex artifact, a bare M0004, 0/, M4x and a repeat"`; `"verify refuses an artifact id the store does not hold"`; `"verify refuses an artifact that is not its run's highest batch"`; `"an id from another batch of the same artifact's run is wrong-batch, even when that batch has the same code"` (two batches both holding `M0001`; artifact names batch 1; `0/M0001` refused); `"an id copied from an older run is resolved in the named artifact only"` (runs 1 and 2 both have `0/M0004`, different identities; `--artifact` = run 1's id resolves run 1's row, never run 2's); `"verify refuses a carried row"`; `"verify refuses a row recorded before the carried column existed"`; `"a killed or known-survivor row is not-a-survivor, and a no-coverage row is accepted"`; `"every offending id is named, not only the first"`; `"an edit to a helper outside every mutated procedure is refused as source-changed"` and `"an unchanged project passes the source check"`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Run.**
- [ ] **Step 5: Red-checks:** resolve the source as the newest publishing run instead of by id: "resolved in the named artifact only" goes red; skip the batch-equality check: "wrong-batch" goes red; treat `carried === null` as false: "before the carried column" goes red; compare only the named mutants' files in the source check: "a helper outside every mutated procedure" goes red; stop at the first unknown id: "every offending id" goes red.
- [ ] **Step 6: Commit** `feat(runner): verify resolves its source by artifact id and refuses changed source (C02-06)`.

### Task 3: Tests to run, and skips

**Files:** Modify `verify.ts`. Test: `verify.test.ts`.

```ts
export interface VerifyPlan {
  readonly requests: readonly NamedMutantRequest[];      // [] only when every target was skipped
  readonly newTests: readonly TestMethodRef[];
  readonly skipped: ReadonlyArray<{ readonly entry: MutantManifestEntry; readonly mark: EquivalenceMark }>;
  readonly entries: ReadonlyMap<string, MutantManifestEntry>;
}
/** Decisions 5 and 6. `manifest` is the one loadInstalledArtifact matched. Never a server. */
export async function planVerify(a: {
  readonly source: VerifySource;
  readonly manifest: MutantManifest;
  readonly sourceBaseline: ReturnType<ResultsStore["baselineTests"]>;
  readonly testDir: string;
}): Promise<VerifyPlan>;
```

- [ ] **Step 1: Failing tests,** on a temp test dir with real `.al` test codeunits and a hand-built manifest:
  - `"covering tests plus new tests, deduplicated, in that order"`;
  - `"a renumbered covering codeunit with the same name and method is refused, never run as the old test"` (source baseline has `(50100, "T", "M")`; the test dir now has codeunit 50199 `"T"` with `M`: `covering-test-unmatched`, naming both ids, and NOT listed as new either);
  - `"a renamed covering codeunit with the same id is refused"`, `"a removed covering method is refused"`, `"a covering name matching two source baseline rows is refused"`, `"a source baseline row without a codeunit name is source-predates-verify"`;
  - `"a test in the source baseline is not new, even if it is edited"` (pins the blind spot as behaviour);
  - `"an empty source baseline is refused, never read as every test new"`;
  - `"a no-coverage survivor with no new test is refused as no-tests-to-run"`;
  - `"a reader-marked survivor is skipped and never reaches runNamedMutants"`, `"equivalenceRisk alone never skips"`, `"a trigger mutant's mark matches by triggerName"`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Run** the loop.
- [ ] **Step 5: Red-checks:** match covering tests by `codeunitName` and `method` in discovery only (revision 2's rule): "renumbered covering codeunit" goes red; key "new" on the method name alone: "not new, even if it is edited" goes red on its two-codeunit fixture; skip on `equivalenceRisk`: "alone never skips" goes red; build the mark key with `procedureName ?? triggerName`: the trigger test goes red.
- [ ] **Step 6: Commit** `feat(runner): verify matches covering tests by codeunit id and skips reader-marked survivors (C02-06)`.

### Task 4: C02-06 (part a) submit

Submit note: every red-check with its red and restored-green line; that the C02-04 Part A snapshots did not change; that `generate-schemas.ts` produced no diff; that nothing touched a server; that `lethal run`'s only change is the store writes (the owner's `itest:bcdev` on the merged tree is the live check, and C02-06b Task 8 runs it anyway).

---

# Coord C02-06b (part b): orchestration, schema, CLI, live proof (after C02-06 and C02-05 are accepted)

### Task 5: Primitive changes, then `runVerify`

Four commits, in this order.

**5.1, R248 (decision 12).** Files: `packages/runner/src/test-app-publish.ts` (`TestAppRefusal` gains `"resident-unreadable"`), `test-app-publish.test.ts`, `orchestrator.test.ts` (the two C02-05 fixtures decision 12 names), `docs/roadmap/R248.md`, then `bun scripts/roadmap-index.ts`.
- [ ] Failing tests: `"publishTestApp refuses an unreadable resident package before the fence, claiming no marker (R248)"` (reads `[null]`: `resident-unreadable`, log `["read"]`, no `begin`; the message contains `BC_DEV_USER` as a name and no configured value); `"C02-06: an unreadable resident test app releases the lease with no recycle record"` (`beginPublishArgs` empty, `releaseCalls` 1, quarantine store empty).
- [ ] Change the two C02-05 fixtures' first read as decision 12 says; assertions untouched. Implement. Run the loop.
- [ ] Red-checks: restore the `null` pass-through: both new tests go red. Then, separately, extend the refusal to the IN-fence read (throw `resident-unreadable` when the read-back after a failed altool is `null`): C02-05's unedited `"a failed exit with an unreadable read-back is publish-indeterminate, never publish-failed"` goes red. Restore both.
- [ ] Commit `fix(runner): an unreadable resident test app refuses before the fence (R248)`.

**5.2, the killer's ref (decision 14).** Files: `packages/runner/src/report.ts` (`SessionOutcome.killingTestRef`), `orchestrator.ts` (the kill sites and `record()`'s outcome push), `orchestrator.test.ts`.
- [ ] Failing tests on `installedFixture`, whose tests file gains codeunit 79101 with a method named `OverBudgetDetected` too: `"killingTestRef names the codeunit that killed, when two codeunits share the method name"` (79101's method kills: ref is 79101; then the mirror, 79100 kills: ref is 79100); `"a warm-confirmed kill carries its ref"`; `"killingTestRef never reaches the report"` (`buildReport` output has no such key; `generate-schemas.ts --check` passes).
- [ ] Implement. Red-check: set the ref from the FIRST method of the call instead of the killer: the two-codeunit test goes red on one direction.
- [ ] Commit `feat(runner): a kill outcome carries the killer's full test ref (C02-06)`.

**5.3, strict baseline and the fresh second run (decisions 11 and 13).** Files: `orchestrator.ts` (`NamedMutantsConfig.rerunOnUnmutated`, `requireEveryMethodGreen`; `NamedMutantsResult.baseline`, `rerun`), `orchestrator.test.ts`, `describe("C02-04b: runNamedMutants")`.
- [ ] Failing tests on `installedFixture`:
  - `"requireEveryMethodGreen: a mutant with one red method is error naming it, although another method is green"` (M0002 with `[RED, OVER]`: `error`, note names `RedAtBaseline`, M0002 never activated);
  - `"requireEveryMethodGreen: a green baseline run in a reused session is not valid"` (a fake answering `testRunsBefore: 2`: `error`, note says "not fresh");
  - `"without requireEveryMethodGreen, C02-04b's red-baseline behaviour is unchanged"` (the existing test passes unedited);
  - `"runNamedMutants: rerunOnUnmutated runs each method once more with no mutant active, after the covering loop"` (the rerun's `run` entries come after the last mutant call, preceded by `activate` with `id: null`, before `release`);
  - `"runNamedMutants: baseline and rerun carry each run's own outcome and session"`;
  - `"a rerun in a session a warm replay already used is not fresh"` (a `WarmStubBackend`-style fake whose warm replay reports session 7 and whose rerun reports session 7 with `testRunsBefore: 0`: `fresh: false`);
  - `"a rerun in a session the baseline used is not fresh"`, and `"a rerun in a new session with testRunsBefore 0 is fresh"` (the positive control);
  - `"runNamedMutants: a latched session answers every rerun not-run"`.
- [ ] Implement, reusing `scoreBatch`'s baseline dispatch and the mutant loop's R206 predicate (extract it to one small function both call, if it is inline). The C02-04 Part A snapshots must not change.
- [ ] Red-checks: drop the session-id snapshot and check only `testRunsBefore`: "a session a warm replay already used" goes red; accept a pass without the freshness check in `requireEveryMethodGreen`: "reused session is not valid" goes red; filter red methods out instead of recording `error` when strict: "one red method is error" goes red; run the rerun before the covering loop: the ordering test goes red.
- [ ] Commit `feat(runner): runNamedMutants can demand a valid baseline for every method and rerun methods on a fresh unmutated session (C02-06)`.

**5.4, `runVerify`, with every dependency injected.** Files: `verify.ts`. Test: `verify.test.ts` (fakes) and `orchestrator.test.ts`-level tests on `installedFixture` for the real path.

```ts
export interface VerifyDeps {
  readonly store: ResultsStore;
  readonly backend: ExecutionBackend & Pick<BcDevMcpBackend, "compileTestApp" | "publishTestApp">;
  readonly lease: LeaseSessionConfig;
  readonly resourceServer: string;
  readonly resourceServerInstance: string;
  readonly quarantineDir?: string;
  readonly emit?: SessionConfig["emit"];
  readonly now?: () => number;
  /** Seam for tests; defaults to runNamedMutants. */
  readonly runNamed?: typeof runNamedMutants;
}
export async function runVerify(args: { readonly artifact: string; readonly survivors: readonly string[]; readonly testDir: string }, deps: VerifyDeps): Promise<VerifyOutput>;
```

Order: `parseVerifyRequest`; `resolveVerifySource`; `assertSourceUnchanged`; `loadInstalledArtifact` (local only); `baselineTests`; `planVerify`; all skipped: return with no compile, no run row, no lease. Else `compileTestApp(testDir, bound)` BEFORE any lease; `createRun` (decision 4); `runNamed({ ..., runId, installed, requests, lease, requireEveryMethodGreen: true, rerunOnUnmutated: <every new test>, inLease: async (fence) => { published = await backend.publishTestApp(fence, compiled); } })`; `newTests[]` from `res.baseline`/`res.rerun` (decision 11); `invalidBaseline` from the error notes' method list (carried as structured data on the outcome, not parsed from prose: `selectNamed` records it on a new `SessionOutcome.invalidBaseline?: readonly TestMethodRef[]`, internal like `killingTestRef`); `killingTest`, `killedByNewTest` from `killingTestRef` (decision 14); `killedBy` from `killedByOf`; exit code (decision 7). `VerifyError`, `NamedMutantError`, `InstalledArtifactError`, `TestAppError` become `refused`, except `publish-indeterminate`/`publish-anomalous`, which become `quarantined` and exit 3. Anything else propagates (exit 1).

- [ ] **Step 1: Failing tests:**
  - `"verify compiles before the lease and publishes the test app exactly once, inside the fence"` (log `["compile", "runNamed", "begin", "publish", "end"]`);
  - `"verify reports the server's read-back identity, not the local compile's"`;
  - `"every survivor skipped: no compile, no lease, no publish, exit 0"`;
  - on the real `runNamedMutants`: `"a mutant whose old covering test is red at baseline is error naming that test, although another method is green"` and `"a mutant whose new test is red at baseline is error, although its covering test is green"` (both exit 5, `invalidBaseline` names the method, `verdict` is never `killed` or `survived`);
  - on the real `runNamedMutants`: `"killedByNewTest is exact when an old and a new test share a method name"` (old `79100.Check` covering, new `79101.Check`; the new one kills: `true`, `killingTest.codeunitId` 79101; mirror: the old one kills, `false`);
  - `"a new test that passes the baseline and fails a fresh rerun is flaky and forces exit 5"`, `"a rerun in a session a warm replay already used is flaky-unknown"`, `"a baseline run with testRunsBefore above 0 is flaky-unknown, and its mutant is error"`;
  - `"verify passes every new test, and only new tests, as rerunOnUnmutated, and always requireEveryMethodGreen"`;
  - `"killedBy never changes the exit code"` (all-killed with `Assert.` texts, and with bare-`Error` texts: both exit 0);
  - `"killedByOf reads assertion, runtime-error and other from the measured callstack shapes"` (literals verbatim from `examples/credit-limit/demo.report.json`: the `Expected an order of 400, got 0.` kill whose first frame is `Credit Limit Tests(CodeUnit 90250)` in the test app is `other`, its `NavNCLAssertErrorException` kill is `assertion`; an `Assert.AreEqual failed` text is `assertion`; a text whose first frame names the target app is `runtime-error`, built from the demo's frame format with a comment that this one shape is constructed, not measured; no second line is `other`);
  - `"a kill without killingTestRef is a bug, never a guess"`;
  - `"verify never finishes its run row"`; `"the exit code precedence is 3, 6, 4, 5, 0"`; `"a TestAppError publish-indeterminate exits 3"`; `"a compile failure is refused as test-app-compile-failed, and no run row or lease exists"`;
  - `"verify: a server holding another artifact is refused as stale-artifact and publishes nothing"` (on `installedFixture({ serverReports: "b".repeat(32) })`, real `runNamedMutants`, C02-05 `publishTestApp`: `tlog` empty, zero `beginPublishArgs`, exit 6);
  - `"verify refuses an artifact that is not its run's highest batch, before any server call"`, end to end: the `recording()` trace has no calls.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Run** the loop.
- [ ] **Step 5: Red-checks:** compile inside `inLease`: the order test goes red; take `testApp` from the compile: "read-back identity" goes red; pass `requireEveryMethodGreen: false`: both "red at baseline, although another method is green" tests go red; set `killedByNewTest` by method name: "share a method name" goes red; treat `flaky-unknown` as passing: "warm replay already used" goes red on the exit code; let `killedBy` `other` block exit 0: "never changes the exit code" goes red; always read the first frame's app as the test app: the `runtime-error` case goes red; map `publish-indeterminate` to 6: "exits 3" goes red; call `finishRun`: "never finishes" goes red.
- [ ] **Step 6: Commit** `feat(runner): runVerify, one test-app publish and one kill proof per call (C02-06)`.

### Task 6: `schemas/verify-v1.schema.json`

**Files:** Create `schemas/verify-v1.schema.json` (hand-written, draft 2020-12, `additionalProperties: false` on every object, `verifySchemaVersion` `const: 1`). Modify `schemas/README.md` (one row). Test: `schemas.test.ts`.

- [ ] **Step 1: Failing tests,** copying the doctor block: `"the verify schema describes exactly the leaves VerifyOutput declares"`; `"every verify enum equals the runtime domain it copies"` (`VERIFY_VERDICTS`, `VERIFY_REFUSALS`, `KILLED_BY`, `NEW_TEST_STATES`, `UnmutatedRun.outcome`); `"the verify schema's version const and $id match VERIFY_SCHEMA_VERSION"`; `"a runVerify output validates"` (Task 5.4's happy path and a `refused` one).
- [ ] **Step 2: Fail. Step 3: Write the schema. Step 4: Run.** `generate-schemas.ts --check` still passes.
- [ ] **Step 5: Red-check:** add a `VERIFY_REFUSALS` value without the schema: the enum test goes red.
- [ ] **Step 6: Commit** `feat(schemas): verify-v1, the kill-proof JSON (C02-06)`.

### Task 7: The `verify` subcommand

**Files:** Modify `packages/runner/src/cli.ts` (`VALID_SUBCOMMANDS`, `RUN_FLAGS.artifact` and `RUN_FLAGS.survivors`, `FLAG_OWNERS`, a `VerifyCliConfig` branch in `parseCliConfig`, `verifyFromCli`, `main`'s dispatch, `helpText`, two exit-code constants). Test: wherever `parseCliConfig` is tested (`grep -ln "parseCliConfig" packages/runner/tests`), `run-limits.test.ts` (help text, unchanged).

- Parse: `--db`, `--artifact`, `--tests`, `--survivors` required (each missing one named); `--config` optional. Allowlist `db`, `artifact`, `tests`, `survivors`, `config`; any other present `RUN_FLAGS` value (a boolean only when true) is refused naming it.
- `verifyFromCli`: open the store; `artifactRecordById` gives the project path (or `unknown-artifact`, printed as JSON, exit 6); load the config; refuse `envTool` as `unsupported-config`; build the bcdev backend the way `runFromCli` does (`buildBackend` with a fresh `mkdtemp` scratch, `leaseSessionFor`, `resourceIdentityFor`). If that needs a `RunCliConfig`, extract the smallest shared helper rather than faking one; name it in the submit note. Print `JSON.stringify(output, null, 2)`; return `output.exitCode`. Close store and backend in `finally`.
- [ ] **Step 1: Failing tests:** `"verify parses --db, --artifact, --tests and repeatable --survivors"`; `"verify refuses every shared flag outside its allowlist, --out and --report included"`; `"run refuses --artifact and --survivors"`; `"verify requires --db and --artifact"`; `"verify refuses a config with an envTool section"`; `"VERIFY_NOT_ALL_KILLED_EXIT_CODE and VERIFY_REFUSED_EXIT_CODE are 5 and 6, and 3 and 4 are reused"`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Run** the loop, including `agent-contract.test.ts` and the help-text test unchanged.
- [ ] **Step 5: Red-checks:** allow `out`: the allowlist test goes red; make `--artifact` optional with a newest-run default: "requires --db and --artifact" goes red.
- [ ] **Step 6: Commit** `feat(cli): lethal verify (C02-06)`.

### Task 8: `itest:verify`, the live proof on `sandbox-app`

**Files:** Create `packages/runner/itest/verify.itest.ts`; add `"itest:verify"` to the root `package.json`. Copy `test-app-publish.itest.ts`'s (C02-05 Task 7) config loading, backend and lease wiring. Skips unless `LETHAL_ITEST_VERIFY=1`. Prints the control-app and BC build first. Uses a fresh temp store. Pre-commitment `docs/superpowers/specs/2026-09-26-c02-06-verify-precommitment.md`, committed ALONE before the first live run, stating every prediction below.

What it must show (any failure exits 1):

1. `runSession` on `sandbox-app` + `sandbox-tests` into the temp store, per mutant equal to `bcdev.baseline.json`. Keep its `timings.totalMs` and its `artifacts[]` last entry (the `--artifact` value).
2. A scratch copy of `fixtures/sandbox-tests` (same `app.json`, version `1.0.0.2`) with ONE added method in the existing test codeunit, `[Test] procedure ZzC0206ClampKeepsMidValue()` raising `Error(...)` unless `SandboxLogic.ClampPercent(50) = 50`. Prediction: it kills `Sandbox Logic|ClampPercent|lethal.negate-conditional` (frozen `survived`; under the negation, 50 returns 0).
3. `verifyFromCli`'s code path with `--artifact` from step 1, that survivor and `Sandbox Logic|LogAudit|lethal.negate-conditional` (frozen `survived`), both as `<batch>/<code>`. Must show: `newTests` is exactly `ZzC0206ClampKeepsMidValue` in the real codeunit, `state: "stable"`, both runs `fresh: true` with two DIFFERENT `sessionId`s; the ClampPercent row `killed`, `killingTest` that method with the real codeunit id, `killedByNewTest: true`, `killedBy: "other"` (pre-committed: a bare `Error(...)` the test raised); the LogAudit row `survived`, the new test in `testsRun`; no `invalidBaseline` on either; `testApp.sha256` equals a FRESH read-back after the call; exit 5; `quarantined` absent, the quarantine dir empty, and a lease acquire right after succeeds.
4. **Restore, also the "survived" leg:** the same call with the UNCHANGED `fixtures/sandbox-tests`. Must show: `newTests` empty; both rows `survived`; `testApp.sha256` equals a fresh read-back; exit 5. Runs in a `finally` once step 3 began. Its ClampPercent `survived` is the runtime proof the new test is gone from the server.
5. Refusals against the real store, each exit 6 with no lease acquire logged: a KILLED mutant (`Sandbox Logic|IsOverBudget|lethal.return-value`) is `not-a-survivor`; a random 32-hex `--artifact` is `unknown-artifact`.
6. Print the wall-time ratio, step 3's `timings.totalMs` over step 1's. Recorded, not gated (ruling 4).

The source-changed refusal is NOT exercised live: it would mean editing `fixtures/sandbox-app` during a gate. It is pinned offline in Task 2.

Live steps:
- [ ] **Step 1:** typecheck, clean dist, `bun test`.
- [ ] **Step 2:** `containers.ps1 status -Names Cronus28`; `coord lease Cronus28 code`; heartbeat every 5 minutes.
- [ ] **Step 3:** commit the pre-commitment spec alone; then `LETHAL_ITEST_VERIFY=1 bun run itest:verify`, foreground.
- [ ] **Step 4:** `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`, same lease: 3 / 12 / 4 and every frozen figure in CLAUDE.md, per mutant equal to `bcdev.baseline.json`. It proves the container was left gate-ready and exercises the new store writes and `killingTestRef` on the real path.
- [ ] **Step 5:** release the lease. A step-3 failure after the itest's step 3 began: confirm its step 4 ran and ClampPercent read `survived`. A moved frozen figure: BLOCK, report to the owner, re-record nothing.
- [ ] **Step 6: Commit** `test(runner): itest:verify, lethal verify proven live on Cronus28 (C02-06)`.

### Task 9: Roadmap items, then submit

- [ ] **Step 1:** re-check the next free id on master AND `lethal/lane-code` immediately before writing. File, from `_template.md`, names only:
  - `product-gaps`, `open`: "`lethal verify` cannot see an edited test that did not cover the mutant: a test is 'new' only by identity, against the source run's baseline". Evidence: `planVerify`, `baselineTests`, and the measured non-determinism of `alc` output (C02-05 Task 0 in `docs/measurements/README.md`).
  - `product-gaps`, `open`: "`lethal verify` does not say whether a new test also kills other survivors in the same procedure (overfitting signal, #16 requirement 4)". Evidence: `runVerify` sends only the named mutants to `runNamedMutants`. Ruling 2: filed, not built.
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`; `bun test scripts/roadmap-index.test.ts`. Commit `roadmap: file R<nnn> and R<nnn>, verify's new-test identity and overfitting`.

**C02-06b submit note must say:** every red-check with its red and restored-green line; that `REPORT_SCHEMA_VERSION`, `STREAM_SCHEMA_VERSION`, `EXPLAIN_SCHEMA_VERSION` did not move and `generate-schemas.ts --check` passes; that the C02-04b and C02-05 tests pass unedited except the two fixture inputs decision 12 names; `itest:verify`'s full output including the BC build line and the wall-time ratio; `itest:bcdev`'s figures; the shared-helper decision in Task 7; the roadmap ids filed.

## Out of scope, on purpose

- **The epic acceptance** (4 killed / 1 skipped, agreement with a later full run, the 20% gate): C02-08 on C02-03's fixture. That later full run must be a FRESH `lethal run`, never `--resume`: R247 (a resume carries verdicts across a republished test app) is exactly the state verify leaves behind.
- **Restoring the operator's test app after a verify.** The agent's tests stay installed, as C02-05 leaves them.
- **Verifying an earlier batch, a carried verdict, or a build made from other source.** Refused (decisions 3 and 8). Doing it needs a target republish.
- **Gap ids** (#16 requirement 3): a SEPARATE task after C02-06 (ruling 3). C02-06 takes batch-qualified mutant ids within one named artifact only.
- **The overfitting signal:** filed (ruling 2). **`ui-unhandled`:** no detector (ruling 1). **Gating on `killedBy`:** reported only (ruling 1).
- **Hashing non-AL inputs** (`.xlf`, layouts, `lethal.config.json`): decision 8's stated ceiling.
- **Agent docs, `SKILL.md`, `agent-contract.test.ts` wording:** C02-07. **al-runner and the env-tool path:** C02-05 decision 6.

## Follow-ups (not built here)

- When GH-24 lands: copy `guardReached` and `reachedBy` onto `VerifyResult` (additive, no bump), with GH-24 Decision 8's wording.
- When C02-01 lands: its packet can print `lethal verify --db ... --artifact <id> --survivors <batch>/<code> --tests ...` (#11 requirement 6).

## Orchestrator rulings (2026-09-26)

1. **OWNER: the assertion screen is REPORTED, never gating.** Each kill carries `killedBy` (`assertion` | `runtime-error` | `other`) plus its failure text; exit 0 needs only `killed` plus every new test passing on the unmutated build. This deviates from #16 requirement 5's wording, because R121's rule is 26.1% precise on the one scored corpus and flags every kill on a bare-`Error(...)` suite. No `ui-unhandled` detector now. Applied in decision 7.
2. **OWNER: flakiness is IN C02-06.** Every new test runs TWICE on the unmutated build; one that fails either run blocks exit 0. Overfitting is reported only if cheap from data already collected; it is not, so it is filed. Applied in decision 11, Task 5.3, Task 9.
3. **OWNER: gap ids are a separate task after C02-06.** C02-06 takes batch-qualified mutant ids only. Applied in "Out of scope".
4. **Orchestrator: the 20% wall-time target is RECORDED in C02-06** (printed by `itest:verify`) and becomes a gate decision in C02-08. Applied in decision 9 and Task 8.
5. **Orchestrator: the split is accepted.** Coord `C02-06` is part a (Tasks 1 to 4); coord `C02-06b` is part b (Tasks 5 to 9), depending on `C02-06` and `C02-05`.
6. **Orchestrator: R248 is C02-06's to decide.** Decision 12: an unreadable pre-fence read is a terminal `resident-unreadable` before the fence; Task 5.1 closes R248.
7. **Orchestrator (review finding 1):** the source run records a hash of the target's original AL source inputs (sorted, excluding the test project), and verify refuses `source-changed` ("re-instrument first") when the current project hashes differently. `app.json` is IN, as a compile input; the per-site comparison is dropped. Applied in decision 8, Tasks 1 and 2.
8. **Orchestrator (finding 2):** a required `--artifact <32-hex id>` names the source; verify refuses when it is not the installed, recorded artifact. Ids stay `<batchIndex>/<mutantCode>` within that artifact. No "newest run" default. Applied in decisions 1 to 3, Tasks 2 and 7.
9. **Orchestrator (finding 3):** if ANY requested method, old covering or new, has no valid green unmutated baseline in this verify session, that mutant is `error` with the method named, never killed or survived; tested with another method green. Applied in decision 13, Tasks 5.3 and 5.4.
10. **Orchestrator (finding 4):** old covering tests are matched to the source baseline by `(codeunitId, method)`; one that cannot be matched that way (renumbered codeunit, removed method) is a typed refusal naming it, never silently substituted. Applied in decision 5, Tasks 1 and 3.
11. **Orchestrator (finding 5):** the killer's `TestMethodRef` rides through `runNamedMutants`' outcome, and the duplicate-method-name case is pinned so `killedByNewTest` is exact. Applied in decision 14, Tasks 5.2 and 5.4.
12. **Orchestrator (finding 6):** both unmutated runs of a new test are freshness-checked as the mutant loop rejects a reused session (`testRunsBefore` / `sessionId`); an unattributable run makes the test `flaky-unknown` (blocks exit 0). Reuse across baseline, warm replay and rerun is tested. Applied in decision 11, Tasks 5.3 and 5.4. Also kept: R248's refusal is pre-fence only; the in-fence read after an altool failure keeps C02-05's classification (decision 12, red-checked in Task 5.1).
