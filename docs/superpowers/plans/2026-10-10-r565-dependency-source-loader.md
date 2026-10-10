# R-565 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`.

1. **Every outside report counts as extended (F1).** In the dependency context, R487's `reportExtended` answers YES
   for every outside report. The project, or any app installed on the server, may extend the report, and that
   cannot be known from the packages.
   - This is an explicit per-context flag, a WeakSet of dependency contexts. The "no file list" path is not used,
     because `ctx.files` is also needed by `projectObjects` and R569's census.
   - The dependency's own reportextensions of X are still read, for their OWN writers (`extensionPresetExitNames`).
   - Plan r1's step 3 rule ("an extension with no source counts as extended") is now included in this one.
   - **Measured** (`measure.md` section 6): no new removals on any of the 12 projects; the key sets are identical
     to the r1 prototype. Of the 72 outside reports, 63 have no Integer or Date item. The other 9 either have no
     exit that reads a name, or already had the same writers.
2. **ReadyToRun acceptance, fail closed (F2), on the measured shape.**
   - A package is a wrapper ONLY when `readytorunappmanifest.json` is present at its top level.
   - The wrapper must have exactly one top-level `.app` entry, named exactly `EmbeddedAppFileName`.
   - That inner package's `NavxManifest.xml` id, version, name and publisher must equal the wrapper's `EmbeddedAppId`,
     `EmbeddedAppVersion`, `EmbeddedAppName` and `EmbeddedAppPublisher`. This reuses `readAppIdentity`.
   - The inner package must have a `SymbolReference.json`.
   - There is no file-name fallback. Anything else is `unwrap-failed`, and nothing is read.
   - A plain package with no `SymbolReference.json` and no wrapper manifest (a runtime package) is `no-symbols`.
   - Duplicate exact entry names inside a package fail closed as `unreadable`.
   - A package `listPackageEntries` cannot open (corrupt) is `unreadable` for that package alone, with a warning.
     Generation continues.
   - Test 4 builds the measured wrapper shape. Test 5 covers the variants: two inner `.app`, a name that is not
     `EmbeddedAppFileName`, an inner identity that differs from `Embedded*`, a missing inner `SymbolReference.json`,
     and a missing wrapper manifest.
3. **Folder priority (F3).** For each app id, the first folder in search order that holds the app wins: on
   al-runner, the pinned `platformAppsDir` comes before `packagesDir`. Only within that folder is the highest
   version taken. Extensions are read only from the selected version of each app. Different app ids declaring X
   give `ambiguous`.
4. **Fingerprint mechanism (F4).**
   - The digest goes on `RecordedCarrySide`.
   - `carryRecord` (`selection.ts`) rule 1 requires BOTH `generationSourceSha256` and `dependencySourceSha256` to be
     equal. A null on either side counts as not equal.
   - Rule 2 (a singleton carried by its member hash) is unchanged. A renumbering cannot reach a singleton.
   - History and resume both go through `carryRecord`, and `carryCurrent` is built after generation.
   - The digest is written to the run row by a setter after generation and before any mutant row (like
     `setCarryHidden`). A run that dies before that point keeps null.
   - Test 8 keeps the project source hash equal, uses a twin tuple so that rule 1 is the deciding rule, changes only
     the dependency entry hash, and expects no carry. Red: drop the digest from rule 1.
   - Test 9 tests `carryRecord` directly: a recorded side with a null digest is not carried by rule 1. It is not
     an end-to-end test, because the scheme bump already blocks older runs.
5. **Digest coverage (F5).** The digest covers every lookup record:
   - each outside report: outcome, the selected package's inner app id and version, its entry path and entry hash;
   - each extension record of X, with or without source;
   - `not-found`, `ambiguous`, `unwrap-failed`, `no-symbols` and `unreadable` outcomes.
6. **Smaller gaps (F6).**
   - The index is keyed by report id as well as by name, so `Report 50100` resolves.
   - `lethal mutate` and dry-run on al-runner have no pinned platform folder. Their refused set can differ from a
     real run's. A warning names this, and R565 and the agent guide state it.
   - On bcdev, the BaseApp in `packageCachePath` can be older than the server's after a server update. This is
     accepted and stated. The report records the version read.
7. **Scheme.** The bump stays as ruled: the next free number at merge, pinned as 40 now. The re-measured cost is
   unchanged from r1 §6: QM -7, ATL -15 with 2 ordinals moved, and the other ten projects 0.


---

# R-565 plan r1 (lethal-code): a dependency source loader for R555's preset-writer rule

Base: master 9e3ca9a7. Branch `lethal/r565`, worktree /work/lethal-wt/r565. The prototype is uncommitted there:
`packages/runner/src/r565-dep-source.ts` (new), with hooks in `loop-hazard.ts`, `builtin-tier1/src/index.ts` and
`orchestrator.ts`, switched on by an env var. Measurement: `/coord/handoff/R-565/measure.md`. Items: R565 (the
mechanism) and R561 (the hazard: QM's 5).

Orchestrator rulings 2026-10-10:
- refusal only;
- no source: keep today's behaviour, with a named warning and a report field; count a report as extended when an
  extension's source is missing;
- a narrow `dependencySourceSha256`, checked after generation and before any reuse;
- `#if` arms in dependency files are all active;
- two packages declaring X: the same app means the highest version, different apps means ambiguous (warn, do not
  read);
- the project's own reportextensions of X count as extending it;
- identity scheme bump: the NEXT FREE number at merge. Pinned as 40 now and re-pinned if preproc's R-570 takes 40
  first.

Never write into the user's package folders. The loader only reads.

## 1. Locating packages (`packages/runner`)
`MutationSetOptions` gains `dependencyPackageDirs: string[]`, the folders to search, in order:
- **al-runner:** the pinned `platformAppsDir` (set by `provisionOnce` before generation), then `cfg.packagesDir`
  (`dependencyPackageDirs()`);
- **bcdev and envtool:** `bcdev.packageCachePath`, resolved against the config folder as `artifact.ts` does.

`runSession` passes them. `lethal mutate` and dry-run pass what the config names. A missing folder is not an error.
It shows up as `not-found` warnings.

## 2. Reading one called report (`r565-dep-source.ts`)
**Index (built lazily, once per generation).** For each `.app` in those folders (not recursive), the loader reads
`NavxManifest`/`SymbolReference.json`: app id, publisher, name and version, plus `Reports[]` and
`ReportExtensions[]` with `ReferenceSourceFileName` and `Target`, walking `Namespaces`. `app-package.ts`'s readers
are reused (`listPackageEntries`, `readPackageEntry`).

**ReadyToRun unwrap.** A package with no top-level `SymbolReference.json` is opened as a wrapper. The loader must
fail CLOSED: a package that does not match the expected wrapper shape is treated as "no source"
(`unwrap-failed`), never read as something else. The shape is:
- the wrapper has exactly one inner entry ending in `.app`, at the top level;
- that inner package opens as a package and carries a `SymbolReference.json`;
- the inner manifest's app id and version equal the wrapper's own manifest values, where the wrapper has one;
- otherwise the inner app id and version must match the inner file name (`<publisher>_<name>_<version>`).

**Lookup for a call `R.M(...)` with `R: Report X` and X outside the project:**
1. Find the packages that declare report X, matched by name case-insensitively, as alc binds. If none:
   `not-found`.
   - If several share one app id, the highest version is used.
   - If the apps differ: `ambiguous`, and nothing is read.
2. Read the entry `src/<ReferenceSourceFileName>` (verified by its exact entry path). If it is missing:
   `no-source`.
3. Also read every reportextension entry whose `Target` is X, from all indexed packages, plus the project's own
   reportextensions of X (already in the project context).
   - A dependency extension with no source counts the report as EXTENDED (the R487 reading, the safe direction).
4. Parse these files into one context of their own (`parseAL`/`wrapRoot`/`buildSemanticContext`), with every
   `#if` arm active. Then run `presetExitNames`, `extensionPresetExitNames` and `presetWriters`.
   - A parse error marks `parse-damaged`, and R555's `damagedProcs` handling applies.
5. The result feeds `crossWriters().byReport[X]`, so `crossWriterCall` and its prefilter work unchanged. This is
   wired through a typed option on the semantic context or the generation options. The prototype's module-level
   setter is not kept, so nothing global leaks between runs.

Only reports actually called through a `Report X` receiver outside the project are read. Cost: about 0.4 s per
generation, measured.

## 3. No source
- There is no refusal. Today's behaviour stays.
- Each lookup that is not `ok` emits one warning, `dependency-report-source-unavailable`, naming the report and the
  reason (`not-found`, `no-source`, `unwrap-failed`, `ambiguous`, `parse-damaged`).
- A new `SessionReport` field, `dependencyReportSources`, lists every lookup as `{report, outcome, package?, version?,
  entry?}`.

## 4. Fingerprint
- **`dependencySourceSha256`.** This is SHA-256 over the sorted lookup records: report, outcome, package
  id@version, entry path and the entry's SHA-256. It is computed during generation and returned by
  `generateMutationSet`.
- **Where it is stored:** in the run row and the carry record beside `generationSourceSha256`
  (`CurrentCarrySide`/`carryRule`), and in `SessionReport`.
- **When it is checked:** right after generation, before any carried or resumed result is reused. A mismatch with
  the recorded digest refuses resume and carry by name (`dependency-source-changed`), in the same way a project
  source mismatch refuses.
- **Older stores and reports** with no digest compare as UNVERIFIED and are never reused silently. I will read and
  follow how R252/R355 handle a missing `coverageMode`.
- **The CLAUDE.md SessionReport ripple**, step by step: `events.ts`, `report-fold.ts`, `report.ts`
  (type/builder/banner), `bun scripts/generate-schemas.ts`, `tests/schemas.test.ts` (the required list and the
  older-report expectation), `report-equality` snapshots, the committed sample reports regenerated, and the
  new Caveat or warning in `CAVEAT_INTERPRETATIONS` with its counts, if it is a caveat.

## 5. Identity scheme
`IDENTITY_SCHEME` goes to 40 (the next free number at merge). The refused set now depends on dependency bytes, and
ordinals move (Application Test Library: 2). The nine pin places are updated: the eight identity tests, resume.test
(pin and PINNED digest), the report-equality snapshot, `fixtures/sandbox-harden/lethal.equivalent.json` and
`docs/using-lethal-from-an-agent.md`. Committed itest baselines tolerate a scheme change.

## 6. Expected cost (re-measured on the built branch)
- **Quality Management:** -7, R561's 5 plus 2 of R555's shape (negate-guard and loop-truncate in
  `QltyDispWarehousePutAway`).
- **Application Test Library:** -15, test-side, with 2 ordinals moved.
- **0 elsewhere:** DO, CDO, DC, Intrastat Core, Subcontracting, Contoso Coffee and Perf Toolkit.
- Tuples moved: 0.
- R561 is closed by this item (`done`), and R565 is `done`.

## 7. Tests (each red-checked alone, full output read)
1. Loader: a fixture `.app` built in the test, plain, holding a report with a preset writer and its source. A call
   from the project is refused (seam off: emitted). Red: skip the lookup.
2. Extension needed: the base report has no open item without its dependency reportextension, and the extension is
   present. The call is refused. Red: skip the extension read.
3. Extension without source: the report counts as extended and the call is refused. Red: treat missing extension
   source as not extended.
4. ReadyToRun wrapper, valid: read correctly.
5. Wrappers that must fail closed, each reporting `unwrap-failed` and reading nothing:
   - two inner `.app` entries;
   - an inner entry with no `SymbolReference.json`;
   - an inner app id or version that differs from the wrapper's.
   Red: take the first inner entry blindly.
6. No source, `not-found` and `ambiguous`: each gives a warning plus a report record, and the mutant stays emitted.
   Red: refuse on no source.
7. Same app at two versions: the highest is used. Red: take the first.
8. Fingerprint: a changed dependency entry hash refuses resume (the orchestrator's required red test). Red: leave
   the digest out of the check.
9. An older store or report with no digest gives UNVERIFIED and is not reused. Red: treat missing as equal.
10. Read-only: the package folders' mtimes and file lists are unchanged after a run.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index; `bun scripts/generate-schemas.ts` with a clean diff check.
- Re-measure QM, ATL and the others against fresh master legs, using the al-runner cache, read-only.
- Live gates: `itest:alrunner`, because the al-runner backend path changes (`platformAppsDir` is passed to
  generation). Fixture verdicts are expected unchanged, since no fixture calls an outside report. The identity
  scheme in its baselines is tolerated.
- Opus build review; one CI push; R565 and R561 `done (<commit>)`; submit.


---

