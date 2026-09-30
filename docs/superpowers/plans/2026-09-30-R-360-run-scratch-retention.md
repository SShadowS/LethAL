# R-360 plan: remove `lethal run`'s scratch folder, keep what verify needs in the store

Base: master `0ad59d08`. Offline only: no al-runner, no live BC, no gate re-freeze expected.

## What verify reads today (measured in code)
`verify.ts` `installedOf` takes the artifact's row (`store.artifactRecordById`) and refuses unless it
is the run's highest batch and `app_path`, `instrumented_dir`, `source_sha256` are all set. Then
`named-mutants.ts` `loadInstalledArtifact` reads exactly four things and nothing else:
1. the `.app` at `app_path` (bcdev: `<scratch>/publish/<sha16>-<id>.app`), hashed against the row;
2. `<batch dir>/mutant-manifest.json`, hashed against `manifest_sha256`;
3. `<batch dir>/app.json`, as text;
4. every `.al` under the batch dir (`readAlSources`, recursive).
It returns them in memory (`BoundArtifact`); bcdev's `indexInstalled` reads no file after that, and
`appPath`/`instrumentedDir` are only labels in messages. Nothing else reads the scratch folder
after a run: `resume` scores from store rows, snapshot reuse hashes the CURRENT batch dir, `explain`
reads a report JSON. A missing file today refuses as `local-copy-unreadable` -> `artifact-files-unusable`.

## Sizes (measured 2026-09-30, read-only, in the real temp folder)
| run folder | total | verify needs (.app + .al + manifest + app.json) | the rest |
|---|---|---|---|
| Continia Document Output (real corpus, 1 batch) | 84.9 MB | 8.7 + 5.7 + 0.38 MB = 14.8 MB | 70.5 MB of `Translations/*.xlf` |
| `sandbox-data` fixture (1 batch) | 10.3 MB | 0.06 + 0.12 + 0.02 MB = 0.2 MB | 10.1 MB: a copy of `lethal.sqlite` (+wal) |
| Credit Limit Demo | 0.42 MB | 0.07 MB | store and report copies |
Every batch is a full copy, so a many-batch run multiplies the table. BaseApp (`U:/Git/BC.History/BaseApp`,
9,620 `.al`, 196 MB of `.al` plus 88.6 MB of other files): about 0.3 GB per batch, estimated from those
counts, not run. Gzip of the `.al` text (measured with `gzip -6`): CDO 5.7 MB -> 0.68 MB, BaseApp
196 MB -> 23 MB in 3 s. Temp holds 20,078 `lethal-XXXXXX` entries, 172 MB, mostly old test runs.

**Found on the way (a real defect):** `prepareBatchProject`'s resource copy skips only dot paths, so
the default store `<project>/lethal.sqlite`, its `-wal`/`-shm` and any report JSON are copied into
every batch dir. That is the 10.1 MB above, and it would get worse once the store holds files.

## Decision: option A, but the lasting place is the store itself (a table), not a folder
A folder "next to the store" is unsafe here. The default store is `<project>/lethal.sqlite`, and
`targetAlFiles` deliberately includes `.al` inside dot folders (CDO keeps real source in
`.dependencies`). Copies under `<project>/.lethal/artifacts/` would be mutated by the next run,
change `source_sha256` (so verify refuses `source-changed` for ever) and give `alc` duplicate objects.
So step 3d writes the installed batch's four inputs into a new table in the same transaction as its
`batch_artifacts` row: `installed_bundles(run_id, batch_index, app_bytes BLOB, payload BLOB)`,
`payload` = gzip of JSON `{ manifestText, appJsonText, alSources }`. The same transaction deletes
every other bundle in the store, so one bundle is kept: the latest published batch (about 9.8 MB for
CDO, 23 MB plus the `.app` for BaseApp). `runFromCli` then removes its scratch folder after a run
that returned a report.

Why not B (keep the last N folders): temp still holds N x 85 MB for CDO and N x several GB for
BaseApp; Storage Sense or a user can empty temp at any time, so rows would point at nothing; the
scratch folder does not know its store, so "N per store" needs a new index anyway; and it cannot tell
a live run's folder from a dead one. A table has none of these: it moves with the store, commits
with the row, has no Windows file lock and SQLite serializes two writers.

Why keep only one bundle: verify also checks that the server still holds the artifact
(`stale-artifact`), and every later publish on the same container replaces it, so an older bundle
is almost never usable. al-runner records no artifact (`deploy()` returns null), so an al-runner run
never prunes a bcdev bundle. See open question 1 for two containers on one store.

## Refusals, by name (no new `VerifyRefusal`, so no schema change)
- Bundle present: verify behaves as today, hashing bytes from the store instead of files.
- No bundle, but a later run in the store has one: new `InstalledArtifactError` reason `replaced`,
  mapped to `artifact-files-unusable`, detail "run 7's installed files were replaced by run 9's".
- No bundle and none later (a store written before R360): `no-record` -> `source-predates-verify`,
  detail naming R360. The path-reading branch is DELETED, not kept as a fallback.
`installedOf` stops requiring `app_path`/`instrumented_dir`; the columns stay (no migration) and
are still written as build provenance. The new table needs no `migrate()` step (CREATE IF NOT EXISTS).

## Crash, concurrency, Windows, R358
- Thrown session: keep the folder (compile diagnostics name files in it, R358 review M1) and print
  its path once. Quarantined report: keep it too. A killed run leaves its folder; the next run does
  NOT sweep temp (it cannot tell a live run's folder from a dead one), but the store already holds
  the killed run's last published bundle, so verify still works.
- Two runs on one store: separate `mkdtemp` folders; each removes only its own; the last bundle
  written wins, and the loser is refused by name as `replaced`.
- EBUSY: removal runs after `store.close()`, `backend.close()` (which stops an al-runner daemon) and
  runSession's worker closes, through the existing `removeScratchQuietly` (3 retries, then a warning
  naming the folder, never a failed run).
- R358: `removeRunScratchAfterAll` stays only in test files whose `runFromCli` calls throw; the preload
  guard then fails any file that leaks on a success path.

## Tasks (small, in order)
1. `orchestrator.ts` resource copy: skip `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`. Test in the
   `prepareBatchProject` tests. Also file this defect as its own roadmap item.
2. `store.ts`: `installed_bundles` table; `recordArtifact` takes an optional `bundle` and writes and
   prunes in its transaction; `installedBundle(runId, batch)` and `laterBundleRun(runId)` readers.
3. `orchestrator.ts` 3d: read `compiled.appPath`, the manifest file, `app.json` and `readAlSources(batchDir)`, pass as `bundle`.
4. `named-mutants.ts` + `artifact.ts`: read from the bundle, add reason `replaced`; `verify.ts`
   map it, drop the path null check; `InstalledArtifactRef` loses `appPath`/`instrumentedDir`.
5. `cli.ts` `runFromCli`: after the `finally`, when not quarantined, `removeScratchQuietly(scratchRoot)`;
   on throw print the kept path. Update the R358/R360 comment at `mkdtemp`.
6. Tests helper and docs: trim `removeRunScratchAfterAll` users; close R360 in `docs/roadmap/R360.md`.

## Tests (each red-checked: revert the one line, see it go red, restore)
- cli.test "run then verify (R358)": also assert no `lethal-XXXXXX` is left in the private temp
  BEFORE verify runs. Red: drop the removal (task 5). Red: drop the bundle write (task 3) -> verify refuses.
- store.test: a second run's bundle deletes the first; batch 1 replaces batch 0 of one run; row and
  bundle land in one transaction (a failing insert leaves neither).
- verify.test: `replaced` refuses as `artifact-files-unusable` naming the later run; a pre-R360 row
  refuses as `source-predates-verify`; the existing tamper tests move to tampering the stored blob.
- cli.test: a throwing `runSession` stub keeps its folder and prints the path.

## Open questions
1. One store used against two containers would keep only the newest bundle. Keep one bundle per
   store (planned), or one per (app id, server)? The runs table would need the server key.
2. Keep the folder on a quarantined report (planned), or remove it like a success?
3. Should `lethal doctor` list stray `lethal-XXXXXX` folders from killed runs? Not planned.
