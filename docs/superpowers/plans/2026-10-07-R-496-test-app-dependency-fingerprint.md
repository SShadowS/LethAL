# R-496 plan r3: the dependency fingerprint, proven installed and taken under the lease, is part of the proven test-app identity

This builds on R-495 (`test_app_proven`), after it merges. Evidence is in `measure.md`.

Review r1 is `review-r1-gpt-6.1-sol.md`, which says REVISE. Each change it asked for is marked
[r2]. Review r2 (`review-r2-gpt-6.1-sol.md`, REVISE narrowly) changes are marked [r3].
"Measured" below means read from code or committed measurements; this round ran no new
fake or live run.

## Choice (unchanged): put the fingerprint into the identity

A run is proven only when two things hold:
- its test app is proven installed (R495);
- its dependency closure is fingerprinted, with every extension in it proven installed [r2].

The fingerprint is recorded in the same UPDATE as the hash and the flag. All three consumers
compare it, and a NULL never matches.

We do not "refuse when the digest parts differ", because those parts are NULL whenever digests
were not taken.

The fingerprint is R-371's `dependencyFingerprint`, the same function on hook and non-hook
sessions. That way the cross-kind rows still lend when nothing changed.

## Design

### 1. Store (unchanged)

- `runs.test_app_deps TEXT` is a new column. It is additive: it goes in `CREATE TABLE runs` and
  in the migration list.
- `createRun({..., testAppDeps})`.
- `setRunTestAppHash(runId, hash, proven, deps)` writes all three in one UPDATE. A clear sets all
  three to NULL.
- `RunRow.testAppDeps`.
- Invariant: `test_app_proven = 1` implies `test_app_deps IS NOT NULL`.

### 2. [r2, critical] Every fingerprinted extension must be proven installed

**What is wrong today.** In `dependencyFingerprint`, bytes mode calls `checkInstalled` only when
the dependency or the served package is Microsoft's. R-385 ruled this way in its section 7: "out
of scope for R385". A partner dependency can therefore stay served at v2 while its installed
version moves from v1 to v2 between runs.

**The fix.** In bytes mode, call `checkInstalled(bytesMode, dep, identity.version)` for EVERY
package the walk hashes, transitive ones included. That means dropping the `isMicrosoft`
condition. The rule stays the same: exactly one installed row, at the served manifest's version.

**Which query.**
- The check goes through the existing `installed(appId)`, which is
  `HarnessVerifier.fetchInstalledVersions`, i.e. `fetchExtensionRows(appId)`.
- That is the per-app `$filter=id eq <GUID>` read. It is the only form R433 and R438 allow. Its
  sender refuses any other form before a request is sent (`UnfilteredExtensionsQueryError`), and
  `automation-api-guard.test.ts` refuses the API text anywhere outside `harness.ts`.
- No list query is added.

**Fail closed.**
- A per-app read that throws, returns no row, returns two rows, or returns a row at another
  version raises `DependencyUnreadableError`, which names the app.
- The session is then unproven: hash, flag and deps are all NULL, and it lends and borrows
  nothing.
- The digests are also NULL, with the existing `test-digests-unavailable` warning.

**What exactly is checked.**
- Every app in the hashed closure: the test app's dependencies, transitive ones, Application and
  its dependencies, and the control app's dependencies (Test Runner).
- **Not the target.** The `T` line is not hashed; LethAL deploys the target and attests it.
- **Not System.** It is not an extension.
- **Not the control app itself.** R-385's version equality already covers it.

**Cost (from the R-385 measurement in `docs/measurements/README.md` §R433).**
- A per-id read takes 40 to 70 ms. The first, cold read of a session takes 4.4 s, but R-385 already
  pays that.
- The Microsoft part of the closure is already checked: 13 reads, 0.6 s, on the sandbox closure.
- The NEW calls are one per non-Microsoft app in the closure:
  - every committed fixture test app depends only on its target and Microsoft apps, so it adds 0
    calls, and no gate moves;
  - a partner app with k partner dependencies adds k reads, about 0.05 s each. A typical k is 1
    to 5 (not measured on a customer suite).

**Hook proof covers the whole closure.**
- The hook session's identity now needs both `proveReadBack` (the test app and each `publishApps`
  app) AND this fingerprint, which checks every extension in the closure.
- So a hook that publishes only one app of the closure, or none of it, still has every other
  closure app proven installed.
- A `publishApps` app outside the closure stays covered by `proveReadBack` alone. Its bytes are not
  hashed (see the limits).

**A side effect, shared with `lethal verify`.** `dependencyFingerprint` also feeds verify's
digests. A staged partner dependency now makes the digests unavailable, so verify refuses by name.
That is the safe direction, it is the same rule R-385 applies to Microsoft apps, and it goes in the
CHANGELOG. No gate's closure has a partner app, so no gate moves.

[r3] This verify refusal is INTENDED: a digest over a staged dependency would describe a package
no test runs against. Document it in three places:
- the CHANGELOG ("Changed", R496);
- the agent guide's verify section;
- the refusal text, which names the app and its installed and served versions.

**Not affected:** al-runner (`declared` mode). Its packages are the folder files it loads; it has no
installed state.

### 3. [r2, race] The fingerprint is taken under the lease, before any carry, skip or reuse

**The order today** (R495 `runSession`):
1. `resolveResume`, which builds the resume index before the lease;
2. `createRun`;
3. `openLeaseScope` (acquire);
4. the hook;
5. the read-back and proof, plus the post-hook resume compare;
6. the batch loop.

Every carry (`replayCarriedBatch`, `carriedVerdictFor`), every history skip (`priorSurvivorKeys`
per batch) and every snapshot reuse (`scoreBatch`) happens in step 6.

**The new step.** Directly after the hook block and before the batch loop, every session takes the
fingerprint, whether it has a hook or not.
- **A hook session** computes it from the read-back, after the hook it awaited (unchanged from r1).
- **A non-hook bcdev session** computes it here, under the lease. Its pre-lease value is never the
  identity. Another lease holder may have published a dependency while this session waited.
- **Recording.** The value from this step is recorded with `setRunTestAppHash(runId, hash, true,
  deps)`. `createRun` writes `testAppDeps` only for al-runner, which has no lease and no server.
- **The resume compare.** It runs here for both kinds, as the hook post-hook compare does today.
  The resumed row must have `test_app_proven = 1`, a non-NULL `test_app_deps`, and both values equal
  to this session's. Otherwise the session throws `TestAppRepublishedError` with the reason "the
  test app's dependencies changed (A, now B)" or "it recorded no dependency fingerprint", before
  the batch loop, so nothing is carried.
- **History and snapshot.** `historyTestAppHash` becomes the identity `{hash, deps}`, and it is set
  only after this step. The history filter and `findBaselineSnapshot` therefore compare against the
  under-lease value.

**The pre-lease non-hook digests: F9, in a fixed order [r3].** Their `D` part comes from the
pre-lease walk. For a non-hook session whose row holds pre-lease digests:
1. Take the under-lease fingerprint.
2. Compare it with the recorded `test_digest_parts.dependencies`.
3. If they differ, or the walk fails, invalidate. In one step:
   - clear hash, flag and deps (`setRunTestAppHash(runId, null, false, null)`);
   - clear the digests (a new `clearRunTestDigests`);
   - emit one `test-digests-unavailable` warning that names the change;
   - leave the identity `undefined`.
4. Only when they are equal: write deps (`setRunTestAppHash(runId, hash, true, deps)`), set the
   identity `{hash, deps}` (which history and the snapshot read), then run the resume compare.

So the usable identity is never published, and resume is never authorised, before F9 has passed.
Nothing in steps 1 to 3 records a carry, skip or snapshot, because the batch loop has not started.

**After an invalidation:**
- **A FRESH run** (no resume flag) does not throw. It runs unproven: it lends nothing, borrows
  nothing and skips nothing.
- **A REQUESTED resume (`--resume` or `--resume-run`) refuses.** It throws `TestAppRepublishedError`
  ("this session's test app is not proven: a dependency changed while it waited for the lease, or
  could not be read") before the batch loop, with 0 carried rows. Any unproven session that asked
  to resume does the same, hook or not, as R495's post-hook rule already does.
- **So a race on a run that holds digests borrows NOTHING,** even from a donor that matches the
  under-lease value. That is accepted: its pre-lease digests no longer describe what runs.
- **A source-less run, or one with no digests,** has no `D` part to compare. Its under-lease value
  is its identity (T7).

**Cost.** A second walk per non-hook bcdev run. Budget about 4.3 s in total on the measured closure,
which is R-385's per-walk figure:
- 3.2 s of downloads;
- 0.6 s of per-id reads;
- 0.4 s for the control app.

Partner apps add about 0.05 s each, and their number is unmeasured.
- To save that walk, the non-hook digests could be deferred under the lease (the R373 shape).
  That is a larger move of R-372's read and is offered as a follow-up, not part of R-496.

**A session without a lease** (`cfg.lease` undefined) takes the fingerprint at the same point. It
has no exclusion against concurrent publishers, the same as everything else such a session does.
This is stated.

### 4. [r2, source-less] Proof does not depend on whether the test app carries `.al`

**Measured from the code.**
- **Non-hook source-less: already proven under R495.** `provenWithoutHook` reads
  `read.kind === "bytes"` and the package's own manifest, never `sources`. R495's
  `tests/helpers/proven-test-app.ts` serves a package with NO source, and every resume test built
  on it carries.
- **al-runner offline: proven** (`no-fetch`).
- **Hook source-less: never proven, today and under R495.** `reportPublishedTestApp` returns
  `sources.kind = "unavailable"` for a readable package without `.al`, and `proveReadBack` refuses
  `unavailable`. This fails closed (a run that cannot resume), not a false carry.

**R-496's part.**
- The fingerprint's dependency inputs come from the served package's MANIFEST
  (`appInputsOfPackage(read.bytes)`), never from `sources.pkg`. So a source-less non-hook run
  fingerprints and stays proven.
- al-runner reads `app.json` and its package folders, so an offline al-runner run stays proven
  when those are readable.
- `testAppDependencies` therefore takes the read bytes, not `PublishedTestSources`.

**Split.** Proving a source-less hook read-back changes R492's `proveReadBack`. Its source-set
equality with the `publishApps` file would need a byte or manifest equality instead, and "served
bytes = file bytes" is unmeasured. That is larger than R-496, and it costs resumability, not
correctness.

**Proposal:** file it as its own roadmap item, "a hook session whose test app carries no `.al`
never proves its identity, so it never resumes, skips or reuses". R-496 leaves that path unproven,
as today.

[r3] **File it at BUILD time, in the R-496 branch.**
- Re-check the next free id (`ls docs/roadmap/`) immediately before writing the file.
- Write `docs/roadmap/R<next>.md`.
- Run `bun scripts/roadmap-index.ts`.

It is a pre-existing availability limit, not a regression.

### 5. Consumers (r1, with the under-lease value)

- **Resume.** `assertSameTestApp`, the non-hook pre-lease half, keeps R495's hash check. The deps
  half is compared in step 3 above for both kinds. R495's per-batch drift check still guards the
  test app's bytes after the lease.
- **`priorSurvivorKeys(..., identity)`.** It selects `test_app_deps` and requires `test_app_proven
  = 1` and equal hash and deps. `testAppChanged` gains `deps`.
- **`findBaselineSnapshot(batchHash, testAppHash, deps, mode)`.** It adds `AND test_app_deps = ?`
  inside the `runs` subquery.

### 6. Drift (unchanged)

A dependency changed during a session's batches is not re-checked; this is stated. Re-walking per
batch costs the full walk each time.

## Old rows lend nothing (unchanged)

A row with NULL `test_app_deps` is refused by all three consumers. That includes rows written by an
R495-only build, which are proven but have NULL deps. This is a second one-time cost, recorded in
the CHANGELOG and the agent guide.

## Versions and ripple (unchanged)

- `IDENTITY_SCHEME`: unchanged.
- SessionReport, schemas, report-fold, sample reports and `Caveat`: unchanged. The CLAUDE.md
  "SessionReport field" ripple does not apply.
- No gate figure moves: no itest resumes or skips, and no gate closure holds a partner app.
- The verify digest scheme does not move: the hashed lines are unchanged. Only which closures are
  readable changes.

## Tests [r2]

**Naming.**
- "Changed" means the same test-app bytes with a rebuilt dependency (same id and version, other
  bytes).
- "Donor -> session" is the kind of the earlier run and the kind of the later one. Kinds: N is a
  non-hook bcdev session, H is a hook session whose `publishApps` holds the dependency only.

**How red-checks are stated.**
- Every refusal test's red-check is a REVERT OF A NAMED FIX (F1 to F9 below). The test must go red
  with the fix reverted and green with it restored.
- Control tests (the "still carries" direction) cannot go red on a revert, because the old code
  carried too. They are red-checked by an OVER-STRICT mutation of the same fix, named per test.
- The r1 scratch patch asserted the buggy behaviour, so it is only the reproduction, not a
  red-check.

**The fixes:**
- F1: the deps compare in step 3, on resume.
- F2: the deps compare in `priorSurvivorKeys`.
- F3: `AND test_app_deps = ?` in `findBaselineSnapshot`.
- F4: NULL deps never match. Its revert is `test_app_deps IS NULL OR test_app_deps = ?`, and treating
  NULL as equal in JS.
- F5: `checkInstalled` on every hashed extension. Its revert restores the `isMicrosoft` condition.
- F6: the fingerprint is taken under the lease. Its revert takes the identity from the pre-lease
  walk.
- F7: proven requires deps. Its revert records proven with NULL deps when the fingerprint fails.
- F8: the inputs come from the manifest. Its revert uses `sources.pkg`, so a source-less run loses
  its fingerprint.
- F9: the pre-lease `D` part is compared with the under-lease value. Its revert skips the comparison.

| # | test | expected | red-check |
|---|---|---|---|
| T1 | changed dep, resume, N->N, N->H, H->N, H->H | `TestAppRepublishedError` (dependencies reason); 0 carried rows | revert F1: carried > 0 |
| T2 | changed dep, `--skip-known-survivors`, the same four pairs | 0 known survivors; the history warning names dependencies | revert F2 |
| T3 | changed dep, R192 snapshot, the same four pairs: A (dep one) records batch k; B (dep two) aborts before k; C `--resume-run B` (dep two) | no `resume-baseline-reused` | revert F3 |
| T3s | store unit test: `findBaselineSnapshot` with other deps | null | revert F3 |
| T4 | proven donor with NULL deps (an R495-era row), to N and to H, in all three consumers (resume refused; 0 skipped; no snapshot reuse) | lends nothing | revert F4, one consumer at a time; each consumer's test goes red |
| T5 | staged DIRECT partner dep: served v2, installed [v1] | the run is unproven (NULL hash, flag and deps); lends nothing in all three | revert F5 |
| T6 | staged TRANSITIVE dep: test app -> A -> B, B served v2, installed [v1] | the same as T5; the warning names B | revert F5 |
| T6b | a partner per-id read that throws, or returns two rows | unproven, the warning names the app | revert F5 |
| T7 | [r3] acquisition race, N, SOURCE-LESS test app (no digests, no `D` part): dep "one" served before acquire and "two" after (a fake lease client that swaps on acquire); donor proven with "two" | carries, skips and reuses: the under-lease value is the identity | over-strict: take the identity from the pre-lease walk; it is refused |
| T7b | the same source-less race, donor proven with "one" | refused; 0 carried; 0 skipped; no reuse | revert F6: carries |
| T7c | [r3] the race WITH digests (a test app with source); donor proven with "two", which matches the under-lease value | `--resume-run` throws `TestAppRepublishedError` "not proven", 0 carried; skip-known skips 0; no snapshot reuse; the row's hash, flag, deps and digests are all NULL; one warning | revert F9: carries from the "two" donor while the run's digests say "one" |
| T7d | [r3] the same digest race on a FRESH run (no resume flag) | no throw; runs unproven; records nothing usable | over-strict: throw on a fresh run; red |
| T7e | [r3] order: on an F9 mismatch, a spy on `setRunTestAppHash` sees no `proven = true` call for that run, and the history identity is `undefined` at batch 0 | as stated | move F9 after the deps write; red |
| T8 | H: the race is impossible by order. The dependency changes in the hook, and the recorded deps equal the post-hook walk | deps equal the post-hook walk | revert: walk before the hook; red |
| T9 | fingerprint failure (a dependency not served) | NULL and unproven; lends nothing | revert F7 |
| T10 | source-less non-hook test app, unchanged dep | proven, deps recorded, carries / skips / reuses | revert F8: unproven, red |
| T10b | [r3] the same, changed dep | refused with the DEPENDENCY reason ("dependencies changed (A, now B)"), and both rows proven with non-NULL deps | revert F1 only. A revert of F8 also refuses, but as "not proven", so it does not count here; T10 is F8's red-check |
| T11 | al-runner: a changed `.app` in its package folder is refused on resume; an unchanged one carries | as stated | revert F1 (refusal); over-strict control: hash folder mtimes |
| C1 | controls: unchanged dep, all four pairs, all three consumers | carries, skips, reuses | over-strict: add the run id to deps; red |
| C2 | R495's existing cross-kind controls, with a declared dependency | still green | (as above) |

## Stated limits [r2: explicit]

1. **Apps outside the closure.**
   - An installed app that is neither a dependency of the test app nor of the target is neither
     hashed nor checked. An event subscriber is an example.
   - That includes a `publishApps` app outside the closure, which only `proveReadBack` checks for
     installed state.
2. **Symbols-only packages.** A package with no `.al` (Application, wrapper apps, the control app)
   hides a rebuild that changes bodies only (R-385 limit).
3. **Binary-only platform updates.** These may not change System's bytes (R-385 limit).
4. **al-runner.** It compares Microsoft dependencies by DECLARED version only (`K declared`, R385).
5. **R192's caveat is about DATA.** A test that is green at the stored baseline and red now because
   of the environment's data is not re-detected. It does not cover changed app code; that is what
   this item closes, within limits 1 to 4.
6. **Mid-session changes.**
   - A dependency changed after step 3, during the batches, is not caught.
   - An install-only change of the test app is not caught (R495).
7. **Hook sessions with a source-less test app** stay unproven (split, section 4).
8. **No lease.** A session without a lease has no exclusion between its fingerprint and its runs.
9. [r3] **The control app's own bytes are excluded,** by design (R-385 L3).
   - Only its version is checked against the running one, and only its dependencies are walked.
   - So a control-app upgrade whose dependencies are unchanged leaves the fingerprint unchanged,
     and runs still match across it.
   - This is a deliberate exclusion, not only the symbols-only limit (2). The control app is the
     harness, not code under test, and `MIN_CONTROL_VERSION` gates it.
10. [r3] **After an F9 invalidation,** a run that holds digests borrows nothing, even from a
    matching donor, and a requested resume refuses (section 3).
