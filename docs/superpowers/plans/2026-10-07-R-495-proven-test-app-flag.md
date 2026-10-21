# R-495 plan: an explicit proven flag on every run, required by every consumer

Branch `lethal/r495` (worktree `/work/lethal-wt/r495`), built on `lethal/r492` (R492 run 002,
`43b8bc15`, not yet merged; rebased onto master once it is). Roadmap R495.

## Reproduced offline (three red tests, `orchestrator.test.ts` "R495: no unproven test-app
## identity crosses sessions, hook or not")
Run 1 is served P2 while P1 is installed (it MEASURES P1); the later session has P2 served and
installed. Each case asserts `--resume-run` is refused and `--skip-known-survivors` skips 0; all three
fail today (the resume proceeds):
1. no hook -> no hook: the non-hook run recorded the served P2 unproven;
2. old hook row -> no hook: a hook row recorded before R492 (served P2, NULL digests) is trusted by a
   non-hook session (R492's digests marker applies to hook consumers only);
3. no hook -> hook: a non-hook row's digests (taken pre-lease from the SERVED package) satisfy R492's
   marker, though they prove nothing about the installed app.

## Design
1. **Store: `runs.test_app_proven INTEGER`**, added by the existing additive migration list
   (`ensureColumn`-style). 1 = the recorded `test_app_hash` was proven to be what ran; NULL/0 =
   not. Older rows read NULL, so they lend nothing (no data rewrite). There is no store schema
   version to bump.
2. **Writers, one rule: a hash is recorded only with its proof, and the flag with it.**
   - Hook session: `proveReadBack` passes -> `setRunTestAppHash(runId, hash, proven = true)`; else
     NULL and unproven (R492, unchanged in effect).
   - Session WITHOUT a hook, `package:` identity (bcdev reads the served package): prove it with the
     same `checkInstalled` against the backend's `microsoftMode` (exactly one installed row at the
     served version, as `proveReadBack` does); proven -> record hash + flag; unproven, or a backend
     that cannot read installed versions -> NULL (lends and borrows nothing).
   - `source:` identity (al-runner, or a backend without a package read): the backend compiles the
     test source it hashed, so the identity is proven by construction: record hash + flag. al-runner
     behaviour is unchanged.
3. **Consumers require the flag, replacing R492's digests marker everywhere:**
   - resume (hook and non-hook): the resumed row must have `test_app_proven = 1` and an equal hash
     (non-hook: `assertSameTestApp`; hook: the post-hook compare);
   - `--skip-known-survivors` (`priorSurvivorKeys`): the latest run must be proven;
   - R192 snapshot (`findBaselineSnapshot`): the snapshot's run must be proven and recorded the key;
     and (all sessions now) the batch's own read must equal the session's proven hash
     (`runsWhatWasRead`, R492 run 002).
   `requireDigests` is removed.
4. **The session's own identity** used for history and snapshot is the proven hash or `undefined`
   (matches nothing), for both session kinds.

## Migration and one-time cost
After the upgrade every existing row is unproven: the first run carries nothing on `--resume`, skips
nothing on `--skip-known-survivors`, and re-runs every baseline. Stated in the CHANGELOG and refusal.

## Gates and versions
No gate figure moves: no itest gate resumes across runs or skips known survivors, and a fresh run's
verdicts do not depend on the flag. No store schema version exists (additive column). The report
schema is untouched. `IDENTITY_SCHEME` is untouched (mutant keys do not change).

## Tests (each red-checked per direction)
- the three reproductions (red today);
- controls: a PROVEN non-hook run resumes, skips and lends its snapshot to a proven non-hook session;
  a proven hook row to a proven non-hook session and the reverse (equal hashes);
- an al-runner (`source:`) run resumes and lends as before (red: require a package proof);
- a backend that cannot read installed versions records NULL;
- an older row (flag NULL, hash set, digests set) lends nothing to either kind;
- the migration: an existing database without the column opens and reads NULL.

## Changes since r1 (review r1, opus; `/coord/handoff/R-495/review-r1.md`). OVERRIDE the above.
- **B1, proven by construction is decided by BACKEND, never by the `source:` prefix.** Proven only
  when `buildBackend.kind === "al-runner"` and the read is `no-fetch` (it compiles `cfg.testDir`).
  A bcdev session whose read is `not-requested` (no dev-endpoint credentials, no server, an unreadable
  local `app.json`) records NULL: BC runs the published app, not the disk.
- **B2, the non-hook proof reads the PACKAGE's identity.** `checkInstalled` gets the served package
  manifest's id and version (`readAppIdentity(bytes)`, as `proveReadBack` does), never the local
  `app.json`'s.
- **I1, drift during the session clears the proof.** `scoreBatch` already re-reads the identity per
  batch (`hashTestApp`); when that read differs from the session's proven hash, the run's hash and flag
  are cleared (`setRunTestAppHash(runId, null)`) and that batch reuses nothing. Fails safe; catches a
  served-package change (or an al-runner test-dir edit), not an install-only change (stated).
- **I2, digests are kept** on unproven non-hook rows (verify's `planVerify` uses them only to pick new
  tests; a wrong digest there under-reports, the safe direction). Stated.
- **I3, NULL semantics.** The column is in `CREATE TABLE runs` and the migration list; SQL tests
  `test_app_proven = 1`, JS tests `!== 1`; `RunRow` exposes it and the post-hook resume check reads it
  (replacing `testDigests(...) !== null`).
- **Q2: record NULL** (no warning-only path); the refusal and skip messages name "not proven
  installed". Fake-backend unit tests that resume, skip or reuse get a `microsoftMode` or the
  al-runner kind (expected churn, as in R492).
- **I4, tests added:** the reproductions assert the refusal type and text and no carried rows; the
  R192 snapshot path in both cross directions (non-hook row -> hook session, hook row -> non-hook
  session); B1 (a bcdev fake whose read is `not-requested` lends nothing; red: the prefix rule); B2
  (local version = installed version, package at another version: unproven; red: local version);
  I1 (the batch read differs from the proven hash: the row is cleared; red: no clear).
- **Stated:** a config with a hook but no lease never runs the hook, so it takes the non-hook path;
  `--resume` (last) still picks the latest unfinished run, so an unproven one refuses rather than
  falls back to an older proven run.

## Changes since r2 (re-review: safe with one change to I1). OVERRIDE the above.
- **I1 completed: drift REFUSES, it does not only clear.** Clearing the row protects later sessions
  only; the current one would still record carried verdicts (`select`'s `carriedVerdictFor`,
  `replayCarriedBatch`, which never calls `scoreBatch`) and skip survivors against the old hash. So
  when a session that HAD a proven identity reads a different one at a batch, it clears the run's hash
  and flag AND throws a typed `TestAppDriftedError` (extends `Error` directly; names both hashes and
  the batch) before that batch records anything. A session with no proven identity (already NULL) does
  not throw. Test: a resumed session whose batch-2 read differs refuses there and carries nothing from
  batch 2 on (red: no throw).
- **Stated limits:** the drift read runs once per batch, before its baseline, so a republish during a
  batch's mutant loop is caught only at the next batch; an install-only change is not caught.
- `setRunTestAppHash(runId, hash, proven)` writes hash and flag in ONE UPDATE, unconditionally.
- Q1 and Q2 are answered above (r1 B1; Q2 = record NULL); no open questions remain.
