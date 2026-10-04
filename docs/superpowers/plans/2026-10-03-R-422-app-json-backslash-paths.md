# R-422: write `/` paths in the batch app.json (plan)

Task: `/coord/tasks/R-422/task.md`. Item: `docs/roadmap/R422.md`. Lane `code`. Branch `lethal/r422`
from **master b9146ec3**, merged on its own. Offline only: no live gate, no `.al` edit, no fixture.
Evidence: `/coord/handoff/R-422/evidence.md` (cited as E1-E5). Every line number below was read at
b9146ec3. Once reviewed, the orchestrator commits this file as
`docs/superpowers/plans/2026-10-03-R-422-app-json-backslash-paths.md`.

**Problem.** `prepareBatchProject` (`packages/runner/src/orchestrator.ts` line 7962) writes each
batch's `app.json` through `writeStampedAppJson` (line 7915). A path written on Windows, such as
`"logo": "Images\\Logo.png"`, is copied as is. The Linux `alc` reads the `\` as part of the file
name and stops with AL1001 (or AL0863 for a folder) before compiling a line, so every batch fails
and nothing says why (E3).

**Ruling (orchestrator).** Replace `\` with `/` in the app.json LethAL WRITES for a batch, never in
the user's project. Say so through the existing `{ type: "warning", code, message }` run event
(`events.ts` line 470), once per session. No `SessionReport` field.

## 1. Which fields (acceptance 1)

From the alc schema, `syntaxes/appSyntax.json` of AL extension 18.0.2732683 (E1), three
top-level fields name a file or folder. Each was measured on the Linux alc 18.0.41.45789: `\`
fails, `/` compiles (E3).

| field | type | `\` gives | normalised |
|---|---|---|---|
| `logo` | string, one file | AL1001 | yes |
| `screenshots` | string[], files | AL1001 | yes, each string element |
| `resourceFolders` | string[], folders | AL0863 | yes, each string element |

Left alone, with the reason:
- **URLs** (`privacyStatement`, `EULA`, `help`, `url`, `contextSensitiveHelpUrl`, `helpBaseUrl`,
  `source.repositoryUrl`, `build.url`, `keyVaultUrls`): not file paths. A `\` in a URL is the
  user's problem, not the compiler's file lookup.
- **Names and text** (`name`, `publisher`, `brief`, `description`, `build.by`, `source.commit`):
  free text; a `\` there is content and must survive.
- **Ids, versions, lists of names** (`id`, `version`, `dependencies`, `internalsVisibleTo`,
  `idRanges`, `features`, `preprocessorSymbols`, `suppressWarnings`, `supportedLocales`,
  `applicationInsights*`, `runtime`, `target`, `platform`, `application`): not paths.
- **Translations and layouts:** the schema has NO app.json field for them (E1). Translation files
  are found by convention (`Translations/*.xlf`), and layouts and control add-in scripts are named
  in `.al` files relative to that file. Those files are already copied with their relative path
  (R39, issue #8; `prepareBatchProject` lines 8018-8040). Out of scope here.

**Rule.** For each of the three fields: a string value has every `\` replaced by `/`; in an array,
each string element is treated the same and every non-string element is kept as is; a missing
field, `null`, a number, an object, or an array holding none of these is left untouched. Leading
`.\` becomes `./`, a trailing `\` becomes `/`; both are what alc accepts on Linux for the slash
form (the trailing form was not measured; E1 notes it, and Task 5's alc run covers `Res\Sub\`).

**Bytes.** `writeStampedAppJson` already re-serialises the whole manifest
(`JSON.stringify({ ...projectManifest, version }, null, 2) + "\n"`): the user's own spacing is
already replaced today, key order is kept, and `version` keeps its key slot
because the key exists. The fix changes only the string values of the three fields. A manifest
with no `\` in them produces byte-identical output to today (test 5 pins that).

## 2. Design

- New pure, exported helper in `orchestrator.ts`, next to `writeStampedAppJson`:
  `normaliseAppJsonPaths(manifest): { manifest; changes: readonly AppJsonPathChange[] }`, where
  `AppJsonPathChange = { field: string; from: string; to: string }` and `field` is `logo`,
  `screenshots[<i>]` or `resourceFolders[<i>]`. It builds new arrays and never mutates the input
  (the caller's `projectManifest` is `Readonly` and is re-used for `targetIdentity` and the
  re-stamp).
- `writeStampedAppJson` calls it, writes `{ ...normalised, version }`, and returns `changes`.
  Both writers therefore normalise: the initial stamp (line 7970) and the version-conflict
  re-stamp in `runSession` (line 5211), whose result is ignored (the session already warned).
- `prepareBatchProject` and `prepareArtifactDir` (line 1560) change from `Promise<void>` to
  returning those `changes`. The bisection caller (line 1642) ignores them.
- **Warning, once per session.** `runSession` declares `let appJsonPathsWarned = false` before
  the batch loop. At the `prepareArtifactDir` call (line 5004), if `changes.length > 0` and the
  flag is false, it emits the warning and sets the flag. The manifest is re-read per batch from
  the same snapshot (line 4973), so every batch reports the same changes; the flag keeps it to one
  event. Local state in `runSession`, not a module global, so two sessions in one process (the
  test suite) do not suppress each other.
- **Code:** `app-json-backslash-path`. **Message** (exact; parts joined by `; `):
  `app.json names a path with "\": logo "Images\Logo.png" -> "Images/Logo.png"; resourceFolders[0] "Res\Sub" -> "Res/Sub". LethAL wrote "/" in the app.json it compiles for each batch, because the Linux alc reads "\" as part of the name and fails with AL1001 or AL0863. Your project's own app.json was not changed; write "/" there to remove this warning.`
  Values are shown raw inside `"`, not JSON-escaped, so the user sees what is in their file.
- Normalisation runs on every host, Windows included: the Windows alc accepts `/` too (R422 body),
  and one rule on both hosts keeps the batch dir the same everywhere.

## 3. Tasks (TDD; each test red on b9146ec3 first, then green, then red-checked)

**Task 1 - unit tests in `packages/runner/tests/batch-project.test.ts`** (`prepareBatchProject`):
1. Project app.json with `logo: "Images\\Logo.png"`, `screenshots: ["Shots\\a.png", 7]`,
   `resourceFolders: ["Res\\Sub", ".\\Other\\"]`. SHA-256 the user's app.json before and after.
   Assert the batch app.json holds `Images/Logo.png`, `["Shots/a.png", 7]`,
   `["Res/Sub", "./Other/"]`, and the hash is unchanged. Red today: the batch holds `\`.
2. Same project plus `description: "a\\b"`, `brief: "c\\d"`, `url: "http://x\\y"`: each is
   byte-for-byte as in the source. Red-check target: a normaliser that walks every string.
3a. Return value (feeds the warning): `prepareBatchProject` returns the three changes in field order with exact
   `from`/`to`; an all-`/` project returns `[]`.
5. **No-op control:** a manifest with `logo: "Images/Logo.png"` and `resourceFolders: ["Res"]`:
   the batch app.json equals `` `${JSON.stringify({ ...manifest, version }, null, 2)}\n` ``
   exactly (`toBe`), i.e. today's bytes. Green today and after; it guards the fix from touching
   anything else.

**Task 2 - runSession tests in `packages/runner/tests/orchestrator.test.ts`:**
3b. (warning) A `makeProject()` copy whose app.json gains a `\` logo (plus the logo file) AND
   `resourceFolders: ["Res\\Sub"]` (plus that folder) [r2: so the §2 text, which names both, is
   exact and the `; ` join is pinned], and a second carrier file with `maxGuardsPerBatch: 1`, the two-batch pattern at line 4251. Collect
   events; filter `type === "warning" && code === "app-json-backslash-path"`; assert exactly ONE,
   and its `message` `toBe` the exact text from §2. Second case: an all-`/` project gives ZERO
   such events. Red today: no such event exists.
4. (re-stamp) The version-conflict test at line 4153 with the `\` logo added. After `runSession`
   returns, the batch dir's app.json on disk is the re-stamp's write (version `9.9.9.10`); assert
   that version AND `logo` `Images/Logo.png`. Red today.

**Task 3 - implement** §2. Make tests 1-4 green; test 5 stays green.

**Task 4 - red-checks** (via `mutation-red-checker`), each reverted after:
- remove the helper call from `writeStampedAppJson` -> tests 1, 3a, 3b, 4 red;
- move the call out of `writeStampedAppJson` into `prepareBatchProject` only -> test 4 red alone;
- normalise every string field -> test 2 red;
- drop the `appJsonPathsWarned` check -> test 3b red (two events);
- replace only the first `\` (`replace` not `replaceAll`) -> test 1 red on `.\Other\`.

**Task 5 - alc proof after the fix (acceptance 3).** Before-fix results are recorded in E3
(`Images\Logo.png` -> AL1001 exit 1; `Images/Logo.png` -> exit 0; the same for `screenshots` and
`resourceFolders`). After the fix, re-run it on what LethAL actually writes: a scratchpad script
(not repo code) calls `prepareBatchProject` on the E3 scratch project with `logo`
`Images\\Logo.png` and `resourceFolders` `["Res\\Sub\\"]`, then
`$LETHAL_ALC_DIR/alc /project:<batchDir> /packagecachepath:<pk> /out:<o.app>` with E3's symbols.
Expect exit 0. Record the command, alc version and exit code in R422's body. This is offline and
cheap, so it is done rather than argued.

## 4. Other backends and tools

- **al-runner (acceptance 4): needs nothing.** R-396 run (i) deployed the unpatched CDO copy
  (`"logo": "Images\\Logo.png"`) without tripping, and a scratch run on al-runner
  v2.12.0-main.c39ad5de with both a `\` logo and `resourceFolders: ["Res\\Sub"]` gave `PASSED`,
  exit 0, no AL1001/AL0863 (E4). It does not resolve those paths. It also receives the normalised
  copy anyway, since `runSession` prepares the batch dir for every backend (line 5004);
  `installResourceSelector` (`al-runner-backend.ts` line 859) then appends its own `/`-style
  folder to that copy, which is harmless.
- **`scripts/campaign/compile-only.ts` [r2].** It calls `prepareBatchProject` itself
  (`compile-only.ts`, its batch-prep call) and ignores the new return value, so it gets the
  normalised app.json with NO warning. That is acceptable for a compile-only campaign tool; say so in
  a comment at that call.
- **compile:fixtures (acceptance 5): not applicable.** It compiles each fixture in place
  (`/project:<fixture dir>`) and writes no app.json copy (E5), so there is no LethAL-written file
  to normalise. Fixtures are repo-owned: a `\` path there should fail loudly with AL1001 and be
  fixed in the fixture. No fixture has one today.

## 5. No identity effect (acceptance 6)

app.json enters no mutant identity and no fingerprint that the batch copy can move:
- Mutant identity, `identityKeyOf` (`packages/runner/src/selection.ts` line 36): `astHash`,
  `codeunitName`, `procedureName`/`triggerName`, `operatorName`, `operatorMajor`, `ordinal`. No
  app.json. `IDENTITY_SCHEME` (`packages/schemata/src/project.ts` line 118) stays 7.
- Batch artifact hash, `hashAlTree` (`baseline-snapshot.ts` line 61): `.al` files only; a test
  there already pins that app.json is invisible to it.
- Source hash, `hashTargetSource`/`readTargetSource` (`baseline-snapshot.ts` lines 103-125): reads
  the USER's app.json, which this change never touches, so `lethal verify` sees the same bytes.
- Build inputs, `canonicalBuildInputs` (`digest-inputs.ts` line 49): `runtime`, `target`,
  `features`, `application`, `platform`, `preprocessorSymbols`. None of the three path fields.

## 6. Final steps

1. `bun run typecheck`; `rm -rf packages/*/dist`; `bun scripts/verify.ts` (no `.snap` may change).
2. `bunx biome check packages/runner/src/orchestrator.ts packages/runner/tests/batch-project.test.ts packages/runner/tests/orchestrator.test.ts`.
3. Set R422 `status: "done (<commit>)"` and
   update its body: the three fields and why the rest are left, the fix in `writeStampedAppJson`,
   the warning code and message, Task 5's alc result, al-runner needs nothing (R-396 run (i) and
   E4), compile:fixtures not applicable, no identity effect.
4. `bun scripts/roadmap-index.ts`; `bun test scripts/roadmap-index.test.ts`. Commit on
   `lethal/r422`.
