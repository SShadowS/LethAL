# R-360 plan (r2): remove `lethal run`'s scratch folder, keep what verify needs in the store

Base: master `0ad59d08`. Offline only: no al-runner, no live BC, no gate re-freeze expected.
r1 review: `H:/lethal-coord/reviews/R-360-plan/review-r1.md`. Every ruling is mapped at the end.

## What verify reads today (measured in code)
`verify.ts` `installedOf` resolves the NAMED artifact to its exact `(run_id, batch_index)` row and
refuses unless it is the run's highest batch. `named-mutants.ts` `loadInstalledArtifact` then reads
four things: the `.app` at `app_path` (hash-checked), `mutant-manifest.json` (hash-checked),
`app.json` and every `.al` under the batch dir. **The last two are checked against nothing**, and
bcdev builds the coverage line map from that text (`indexInstalled`), so edited text on disk can move
coverage to the wrong procedure today. Nothing else reads the folder after a run (resume and
snapshot reuse use the CURRENT batch; `explain` reads a report path).

## Sizes (measured 2026-09-30, read-only, in the real temp folder)
| run folder | total | verify needs (.app + .al + manifest + app.json) | the rest |
|---|---|---|---|
| Continia Document Output (real, 1 batch) | 84.9 MB | 8.7 + 5.7 + 0.38 MB = 14.8 MB | 70.5 MB of `.xlf` |
| `sandbox-data` fixture (1 batch) | 10.3 MB | 0.2 MB | 10.1 MB: a copy of `lethal.sqlite` (+wal) |
BaseApp (`U:/Git/BC.History/BaseApp`: 9,620 `.al`, 196 MB, plus 88.6 MB other): about 0.3 GB per
batch, estimated from those counts. `gzip -6` of the `.al` text: CDO 5.7 -> 0.68 MB, BaseApp 196 -> 23 MB in 3 s.

## Decision: option A, the lasting place is the store (tables), not a folder
A folder beside the default store `<project>/lethal.sqlite` is unsafe: `targetAlFiles` includes
`.al` in dot folders on purpose, so copies there would be mutated, change `source_sha256` and give
`alc` duplicate objects. Option B (keep N temp folders) leaves GBs in a folder Windows may empty.

**Schema** (CREATE IF NOT EXISTS for tables; the existing ALTER loop in `migrate()` for columns,
NULL on old rows):
- `installed_bundles(run_id, batch_index, app_bytes BLOB, app_json_text, manifest_gz BLOB)`, PK `(run_id, batch_index)`.
- `installed_bundle_files(run_id, batch_index, path, text_gz BLOB)`, PK `(run_id, batch_index, path)`:
  one row per `.al`, so neither side ever builds one giant JSON string (I5).
- `batch_artifacts.payload_sha256 TEXT`: the payload digest (C1). `batch_artifacts.bundle_pruned_by INTEGER`.
- `runs.resource_key TEXT`: `quarantineResourceKey({server, serverInstance})`, the key `runSession`
  already computes for quarantine; NULL for al-runner and for fakes without a server.

**C1, payload digest.** At step 3d `runSession` reads the batch's files ONCE and computes SHA-256
over: `app.json` bytes, then each `.al` as `<forward-slash path> NUL <bytes> NUL` in sorted order,
then the manifest file bytes, then the `.app` SHA-256. It writes the digest into the row and the same
bytes into the bundle, in one transaction. Verify recomputes the digest over what it decompressed
and refuses on any mismatch with new reason `payload-differs` -> `artifact-files-unusable`, naming
"the instrumented payload digest". This closes today's path-based weakness too, since the path
reader is deleted. It detects corruption and mixed rows; it does not stop a deliberate edit of both
row and blob in the same database, which is the same trust the store already has.

**I1, retention.** Lookup is always exact `(run_id, batch_index)`, never "the latest bundle".
Nothing is pruned at publish time. `finishRun` (reached only when the session did not throw and did
not latch unsafe, orchestrator.ts ~5480) prunes, in its own transaction, within the group
`(runs.app_id, runs.resource_key)` of the finishing run (`IS` comparison, so NULL groups with NULL):
every bundle of an OTHER finished run, and this run's lower batches. It sets `bundle_pruned_by` on
the pruned rows. Unfinished runs' bundles are never pruned (open question 1). A run that throws or
quarantines prunes nothing.

**I4, mandatory on the publishing path.** Where `compiled !== null`, `recordArtifact` REQUIRES the
bundle (no optional parameter; existing store tests pass a small one). Before `runSession` returns, it checks by exact lookup that the highest published
batch has a bundle and throws `InstalledBundleError("bundle-missing")` if not.

**I5, limits.** A failed bundle write (read error, size limit, SQLite error) rolls back the row with
it; `runSession` throws `InstalledBundleError` (extends `Error` directly) naming the batch and cause;
the run fails before success, the scratch folder is kept and named (I2). Limits, set from task 3's
measurement (provisional): `.app` 512 MB, one `.al` 16 MB decompressed, whole payload 1 GB
decompressed, checked while writing (`bundle-too-large`) and while reading with zlib's
`maxOutputLength` (`payload-too-large` -> `artifact-files-unusable`).

## Refusals, by name (no new `VerifyRefusal`, so no verify schema change)
- Row has `payload_sha256 = NULL`: written before R360 -> `no-record` -> `source-predates-verify`,
  text "recorded before R360; its files were kept in the temp folder then; run lethal run again".
- Row has a digest and `bundle_pruned_by` set: new reason `replaced` -> `artifact-files-unusable`,
  text "run 7's installed files were pruned when run 9 finished (same app, same server)".
- Digest or size mismatch: `payload-differs` / `payload-too-large` as above. No path fallback.

## I2, scratch folder ownership (cli.ts `runFromCli`)
Ownership starts at `mkdtemp`: everything after it (contract probe, canary, `resolveEnvToolSession`,
`withEnvTeardown`) moves into one `try`. On any throw: print `[lethal] kept scratch folder <path>`
and rethrow. After a returned report, remove the folder (`removeScratchQuietly`, 3 retries then a
warning, which covers EBUSY after `backend.close()` stopped the al-runner daemon) ONLY IF
`report.quarantined` is unset AND the tier has no durable quarantine record. That check is R238's:
generalize `tierHasQuarantineRecord` to take `{server, serverInstance}` (from `resourceIdentityFor`),
read `QuarantineStore(defaultQuarantineDir())`, and treat an unreadable store as quarantined. Else
keep and name it. A killed process leaves its folder by design; `doctor` deletes nothing.

## I3, resource copy (the `prepareBatchProject` defect)
`prepareBatchProject` gains `excludeOutputs: readonly string[]`, filled by `runFromCli` with the
resolved `--db` path plus `-wal`, `-shm`, `-journal`, and the `--out` and `--progress-out` paths when
given. The copy loop skips a file whose resolved path is in that set. Policy: an old report not
named this run is copied like any resource (harmless, never read by a build); nothing is guessed from
a file extension.

## Tasks (in order)
1. File the defect: run `ls docs/roadmap/`, every worktree's `docs/roadmap` (`git worktree list`),
   `git log --all --name-only -- docs/roadmap` and `H:/LethAL-wt/lane-preproc/docs/roadmap` IMMEDIATELY
   before writing (highest seen today: R362), write `R<next>.md`, `bun scripts/roadmap-index.ts`.
2. I3 in `orchestrator.ts` + `cli.ts`; close that item in the same task.
3. Measurement (offline, scratchpad script, not committed): write and read a bundle of 9,620 real
   BaseApp `.al` files plus a 100 MB random `.app` into a fresh store; record peak RSS
   (`process.resourceUsage().maxRSS`), the `-wal` size after write, after prune and after
   `PRAGMA wal_checkpoint(TRUNCATE)`, and the `.sqlite` size. Set the limits from it and write the
   numbers into R360.md. If the WAL stays large, checkpoint after the bundle write and after pruning.
4. `store.ts`: schema and columns above; `recordArtifact` with bundle; `installedBundle`; pruning in `finishRun`.
5. `orchestrator.ts`: 3d reads files, computes the digest, writes; the end-of-run bundle check; `resource_key` into `createRun`.
6. `named-mutants.ts`, `artifact.ts`, `verify.ts`: read from the store, new reasons, texts above;
   `installedOf` stops requiring `app_path`/`instrumented_dir` (kept as provenance, still written).
7. `cli.ts`: I2 ownership and removal.
8. Tests helper: drop `removeRunScratchAfterAll` from files whose runs all succeed; keep it in files
   that exercise throws. CHANGELOG `[Unreleased]` "Changed": verify refuses runs recorded before R360,
   which must be run again. Close R360.

## Tests (each red-checked: revert one line, see red, restore)
- C1: change one byte of one stored `.al` blob; verify refuses `artifact-files-unusable` naming the digest.
- I1 (store.test): two app ids and two resource keys; finishing a run prunes only its own group;
  an unfinished run's bundle survives; a session that throws after its bundle write prunes nothing
  and the older finished run still verifies; exact lookup of a lower batch finds nothing after finish.
- I2 (cli.test): a throwing canary stub (before `withEnvTeardown`) keeps and names the folder; a
  report with a durable quarantine record for its tier keeps the folder; a clean run removes it.
- I3: a custom `--db results.db` and its `-wal` are not copied; a needed `addin/config.json` is.
- I4 (cli.test, real run path): a backend whose `.app` vanishes after deploy fails the run by name
  and keeps the folder; a store that drops the bundle fails the end-of-run check.
- I5: an over-limit fake bundle is refused on write and on read by name.
- Refusal texts: a pre-R360 row says "predates R360"; a pruned row says "replaced" and names run 9.
- Update the run/verify agreement test, `cli.test.ts` "lethal run then lethal verify on one store
  (R358)": its test "verify reads the installed batch's files the run left behind" now expects the
  folder GONE (asserted in the private temp before verify runs) and verify still reaching `compileTestApp`.

## Changes from r1
- **C1:** added the payload digest (`payload_sha256`), `payload-differs`, the one-byte test; noted it closes today's path weakness.
- **I1:** exact `(run_id, batch_index)` lookup; per `(app_id, resource_key)` group; prune only in
  `finishRun`; unfinished bundles kept; `runs.resource_key` added with migration; the three tests.
- **I2:** ownership from `mkdtemp`; keep and name on throw; remove only after a non-quarantined report
  AND no durable quarantine record (R238's check, generalized).
- **I3:** exclude the actual `--db` (+ `-wal`/`-shm`/`-journal`), `--out`, `--progress-out`; no
  extension guessing; two tests; tasks 1-2 file and close the defect as its own roadmap item.
- **I4:** bundle mandatory on the publishing path plus an end-of-run check; tested on the real run path.
- **I5:** per-file rows instead of one JSON blob; task 3 measures peak RSS and WAL; limits with named refusals; a failed write fails the run and keeps the folder.
- **Minors:** no fallback, with distinct "predates R360" and "replaced" texts; CHANGELOG entry;
  quarantined folders kept; `doctor` deletes nothing; the agreement test's expectation updated.

## Open questions
1. A killed run's bundle is never pruned (it never finishes). Should a finishing run also prune
   UNFINISHED older runs in its group? Cost today: up to one bundle (about 10 MB for CDO) per killed run.
2. During one run every batch keeps its bundle until `finishRun`. For a many-batch BaseApp run that
   is N x (23 MB + `.app`). May a publish replace the SAME run's lower batch (never another run's)?
