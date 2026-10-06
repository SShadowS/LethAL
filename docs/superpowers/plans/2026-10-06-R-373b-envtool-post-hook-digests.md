# R-373b plan: test digests for env-tool runs

Base: master `1a82c333`, worktree `/work/lethal-wt/r373b`. Roadmap item R373.

## The question
R372 records per-test digests from the PUBLISHED test app (`testAppIdentity`, orchestrator.ts): the
package's `.al` entries (`publishedAlSources`), its manifest inputs (`appInputsOfPackage`) and the
server's resident dependency packages (`publishedPackageReader(fetchPublishedAppPackage)`), through
`testDigestsOfModel`. An env-tool session publishes its test app itself (`envTool.publishApps`,
prebuilt `.app` files) in `afterLeaseAcquired`, AFTER that read, so today it records NULL
(`test-digests-unavailable`) and verify refuses it (`source-predates-verify`). A digest must
describe exactly what ran.

## Order of events in runSession (env-tool)
1. pre-lease: `reportPublishedTestApp` reads the published test app (R139/R372). It may be the
   OUTGOING package.
2. pre-lease: `envToolTestAppFile` reads the local `publishApps` file that is the test app (R403).
3. `createRun` writes the run row (with `testDigests`, `testAppHash`), still pre-lease.
4. under the lease: the hook publishes the files; then R403's deferred membership check runs on the
   LOCAL file; then the baseline and every mutant run, all under the same lease.

## Options considered
- (a) Digest the LOCAL `publishApps` file's `.al` entries (R403 trusts that file as the running
  test app). Not proven: a publish that "succeeds" need not install those bytes (the env tool is a
  host-only black box; e.g. an already-installed same version), and the dependency half still needs
  the server. Rejected as the source of truth.
- (b) CHOSEN. After the hook, under the lease, read the published test app AGAIN with the same R139
  read, and take the digests from that read with R372's own code. That read is what the server
  holds; nothing can republish before the tests run (the lease); and it is the same function R372
  uses, so the digest format does not change.

## Design
1. `testAppIdentity` keeps refusing pre-lease for env-tool sessions (no digest at createRun), but
   returns a marker that the digest is DEFERRED.
2. After the hook and R403's deferred check, under the lease, a new step `deferredTestDigests`:
   re-run the published-package read (`fetchPublishedAppPackage` + `reportPublishedTestApp`'s
   parsing, no duplicate warnings), then the unchanged R372 body (inputs, dependency fingerprint,
   `testDigestsOfModel`) on THAT read.
3. Cross-check before recording: the read-back's app id, name, publisher and VERSION equal the
   local test-app file's manifest (R403's `envToolTestAppFile`), and its `.al` source set equals
   the local file's (`publishedAlSources` of each, compared as sorted path+sha256 lists). Any
   difference means the publish did not install the file: record nothing and warn
   `test-digests-unavailable` naming it.
4. Record with a new store method `setRunTestDigests(runId, digests, parts)`: it writes only a row
   whose `test_digests` is NULL (never overwrites), and throws on a missing run (caller contract).
5. Every failure keeps today's answer: read unavailable (`undefined`/`null`), unparsable package,
   `TestDigestError`, `DependencyUnreadableError`, cross-check mismatch -> NULL plus a
   `test-digests-unavailable` warning that names the cause. The bcdev case R373 names (no dev
   endpoint, `fetchPublishedAppPackage` answers `undefined`) stays refused: correct by R373.
6. No `TEST_DIGEST_SCHEME` change proposed: same function, same inputs, only taken later. (The
   orchestrator's call.)

## Side finding (to file, not built here)
R247's `testAppHash` (resume, `--skip-known-survivors`, baseline-snapshot reuse) is taken from the
PRE-lease read too, so on an env-tool run it can describe the outgoing package. Whether the same
post-hook re-read should also set `testAppHash` is its own decision (it is read before the lease by
resume). File as a new item.

## Tests (fakes; the env tool is host-only)
A fake backend whose `fetchPublishedAppPackage` returns package A (outgoing) before the hook and
package B after it (the hook flips it); `afterLeaseAcquired` and `afterLeaseAcquiredPublishes`
set, with B's bytes as the local file.
1. The recorded digests equal R372's digests of B, not A (red: digest from the pre-lease read).
2. Read-back version differs from the local file -> NULL plus the named warning (red: drop the
   version check). Same for a differing source set (red: drop the source check).
3. Read-back unavailable -> NULL plus a warning (control: today's message unchanged).
4. `setRunTestDigests` never overwrites a non-NULL row and throws on a missing run.
5. A non-env-tool bcdev run is byte-identical to today (digests at createRun).
6. verify accepts the env-tool run's digests (end to end through the verify planner with fakes).

## Docs
R373 closed with the design; CHANGELOG; the agent guide's `test-digests-unavailable` text.

## Changes since r1 (review r1 by an opus spec-adversary standing in for sol, whose quota was out;
`/coord/handoff/R-373b/review-r1.md`). These OVERRIDE the text above.
- **B1, installed, not just published.** `fetchPublishedAppPackage` reads `dev/packages` with an
  empty `versionText`, "a version you have": during a staged upgrade that can be published but not
  installed (R-385 D2, `checkInstalled` in digest-inputs.ts). So the deferred step also requires
  EXACTLY ONE installed row for the read-back's app id, at the read-back's version (`checkInstalled`
  exported, through `cfg.backend.microsoftMode().installed`). Otherwise NULL plus the named warning.
  The source-set cross-check stays (it catches an env tool that skips a same-version republish).
- **B2, every app the hook republished.** Each `afterLeaseAcquiredPublishes` file's app id is read
  once, before the lease; after the hook, each must pass the same installed check at the version
  `dev/packages` serves, or the digest is NULL. (Non-Microsoft dependencies are otherwise hashed from
  whatever `dev/packages` serves, an R372 gap the hook makes ordinary.)
- **Resume and history guard (class 1, folded in).** R247's `testAppHash` is the pre-lease read, so
  an env-tool `--resume` could carry kills measured under the OUTGOING test app while the new one
  runs (a false kill). The deferred step hashes the post-hook read; if it differs from the
  pre-lease `testAppHash` and a resume or `--skip-known-survivors` baseline was resolved, the session
  throws by name before the first baseline. The post-hook hash is written to the row in the same
  update as the digests. Baseline-snapshot reuse is NOT affected (`scoreBatch` re-hashes per batch,
  after the hook).
- **The mismatch warning from the right package.** With a deferred read, `published-test-app-mismatch`
  is judged on the post-hook read, not the pre-lease one.
- **`setRunTestDigests`** is one `UPDATE runs SET test_digests, test_digest_parts, test_app_hash
  WHERE id = ? AND test_digests IS NULL`; zero rows changed throws (missing run or already set).
- **Paths that do not reach the step:** no local test-app file (publishApps holds only dependencies)
  or a membership of `none`: the installed check plus the post-hook read with no file cross-check;
  the step does not depend on R403's `deferredTestAppCheck`. The hook skipped (no lease session):
  no deferred step, NULL with the named warning. The hook throws: the row stays NULL, the step never
  runs.
- **Warnings:** the pre-lease `test-digests-unavailable` for env-tool sessions goes; the deferred
  step emits it at most once, only when it records nothing.
- **No `TEST_DIGEST_SCHEME` change** (reviewer agrees): same inputs and format; the checks add no
  fingerprint lines; earlier env-tool rows are NULL.
- **Tests, each red in its own direction:** recorded digests are the post-hook package's (red:
  pre-lease read); installed `[v1]` / `[v2]` / `[v1, v2]` -> NULL / recorded / NULL (red: drop the
  check; check always fails); a dependency republished in the hook is fingerprinted post-hook (red:
  pre-lease reader); version or source-set mismatch -> NULL (red per check); resume guard refuses on a
  post-hook hash change, control proceeds (red: drop the compare); `setRunTestDigests` throws on a
  filled row and on a missing run; hook throws -> row NULL and the step uncalled (call counter);
  warnings exactly as above; mismatch warning from the post-hook package; verify end to end both ways
  (accepts the run; an edited test on disk is classified new).

## Changes since r2 (re-review r2, same reviewer). These OVERRIDE the text above.
- **The resume and history guard fails CLOSED.** When a `--resume` or `--skip-known-survivors`
  baseline was resolved, the session proceeds only if the post-hook hash is DEFINED and EQUALS the
  pre-lease `testAppHash`; a post-hook read that returns nothing (`null`, `undefined`, unparsable)
  refuses by name. The guard runs first after the hook, before and independent of every digest check
  (never inside the digest step's NULL-returning path). Test: post-hook read `null` under `--resume`
  refuses (red: an `!== undefined` short-circuit); control with equal hashes proceeds.
- **The row's `test_app_hash` is always rewritten for an env-tool run, on its own.** After the hook,
  a separate store write sets it to the post-hook hash, or to NULL when that read is unavailable, so
  a run that published P2 never records P1, whatever the digest step decides. `setRunTestDigests`
  then writes only `test_digests` and `test_digest_parts` (the strict zero-rows-throws rule stays).
  Test: digest step records NULL (installed check fails) and the row still carries the post-hook
  hash; post-hook read unavailable -> `test_app_hash` NULL.
