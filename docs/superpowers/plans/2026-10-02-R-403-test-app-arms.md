# R-403: discovery reads the TEST app's `#if` build (short plan, r2)

Task: `H:/lethal-coord/tasks/R-403/task.md`. Item: `docs/roadmap/R403.md`. Branch `lethal/lane-preproc`, master 4c78e2b1.

## Revision r2 (`H:/lethal-coord/reviews/R-403-plan/reject-r1.md`)

| Finding | r2 change | Where |
|---|---|---|
| 1. On bcdev the symbol set is a guess | MEASURED: a compiled test `.app`'s `SymbolReference.json` lists ONLY the compiled-in test methods. Discovery's filtered list must equal that compiled list, both directions; a mismatch refuses by name | §2, §3(b) |
| 2. Verify | `planVerify` gets the same test set, and the parser is initialised before discovery on both paths. Integration tests are added | §3(d) |
| 3. Resume | The fingerprint gains the test app's effective set and the discovery-policy version. The `[]` to `[X]` counterexample is red-checked | §3(e) |
| 4. Undecided | Keep every test, and state that the bcdev limit stays. The test shape is one alc ACCEPTS | §3(c), §5 |
| 5. Persist | `SessionReport` fields `testBuildSymbols` and `excludedTests`, plus a caveat, following the full CLAUDE.md ripple | §3(f) |
| 6. Gate check | Projects are enumerated as `compile-fixtures.ts` does. Test identities AND order are compared, master against branch, under every gate build. R56 is unchanged | §4 |

## 1. Measured today (scratch `H:/lethal-scratch/R-403/`; Cronus28 lease 085 released; scratch apps unpublished)
**The shape.** `[Test] PlainDoubles`, and under `#if LETHALX`, `[Test] OnlyUnderX`, against a target with 2 mutants.

| Backend | Build | Result |
|---|---|---|
| al-runner (pinned c39ad5de) | `[]` | Discovery lists both tests. Baseline `1/2 passed — failing: R404 Tests.OnlyUnderX` (status `error`, in `unsupportedTests`). The run is `degraded [baseline-red]` |
| al-runner | `[LETHALX]` | 2/2 green |
| bcdev, Cronus28 | `[]` | **The run is REFUSED.** R31: "the published test app does not contain OnlyUnderX, which this project's source declares" |

## 2. Where the test app's build is evidenced
- **Compiled membership (new, measured).** `alc` on the scratch tests, read with `listPackageEntries` / `readPackageEntry`:
  - built `[]`: `SymbolReference.json` lists `R404 Tests.PlainDoubles` only, with `Attributes [{"Name":"Test"}]`;
  - built `[LETHALX]`: it lists both `PlainDoubles` and `OnlyUnderX`.
  - The embedded source (`src/...al`) holds both methods in BOTH builds, so it is NOT evidence.
  - R372 measured that the package downloaded from the dev endpoint (`devPackagesUrl`, the one R139 check 2 reads) has the same entries as the local `.app`, so this is available on bcdev at no extra cost.
- **The derived set**, used for discovery on both backends, is computed by the same `effectiveBuildSymbols`, on `testDir`:
  - the config's `preprocessorSymbols`;
  - plus the TEST app's own `app.json` symbols, measured on al-runner: with `LETHALX` only in the tests' `app.json`, `OnlyUnderX` ran, while the target set stayed `[]`;
  - plus, on al-runner, the probe-measured predefined symbols (R392);
  - plus per-file `#define` (in `evaluateArms`).
- **Per backend:**
  - **al-runner** compiles the tests itself from exactly that, so the derived set is right by construction. A disagreement still surfaces as an `error` test.
  - **bcdev:** the derived set is an assumption, so it is CHECKED against compiled membership (§3(b)).

## 3. Changes
- **(a) Discovery.** `discoverTests(testDir, { only, buildSymbols })` evaluates each test file's arms (`evaluateArms(wrapRoot(parseAL(source)), source, buildSymbols)`, R214's evaluator). A `[Test]` whose attribute starts in an inactive range is not discovered. The offsets match, because `maskNonCode` keeps positions. Each excluded test is recorded (§3(f)).
- **(b) bcdev: compiled membership must agree.**
  - Where R139 check 2 already downloads the published test app, read its `SymbolReference.json` `[Test]` methods (`AppMethodIndex`, extended to keep the `Test` attribute).
  - Within the `--tests-only` scope, compare them with discovery's filtered list, by codeunit and method. A difference in EITHER direction refuses before the baseline: `test-app-symbols-differ: the published test app's compiled tests differ from the tests LethAL derived for symbols [<set>]: published-only <names>; derived-only <names>. Set preprocessorSymbols (config or the test app.json) to the symbols the test app was built with.`
  - R139's existing SOURCE comparison applies the same arm filter to both sides, because it is a staleness check of source against source and is not circular for that purpose. The compiled check is the independent evidence.
  - R56 and R31 are unchanged, except that R31's message gains one sentence when the missing method lies inside an `#if` region.
- **(c) Undecided test file.**
  - Every `[Test]` is kept, as today, with a named record (§3(f)).
  - **Limit, stated plainly:** if such a file holds a compiled-out test, it still refuses the whole session on bcdev (now by `test-app-symbols-differ`, naming it), and still errors on al-runner. Undecided projects are NOT fixed by R403.
  - The test shape is the R402 `s13` loop header (`#if X while (B < 5) #else while (A < 10) #endif do`). R214 calls it undecided (`marker-mismatch`), and alc COMPILES it (measured in the R402 sweep, `src=ok` in every build).
- **(d) Verify.**
  - `planVerify` (`verify.ts`) calls `discoverTests(testDir)` itself. It gets the test set derived from verify's own config and the test app's `app.json`, the same helper.
  - `initParser()` moves BEFORE discovery in `planVerify` and in `runSession`'s discovery step (both initialise it after, today).
  - Integration tests run through `planVerify` and `runSession` with the scratch shape.
- **(e) Resume.**
  - `sessionFingerprint` gains `testBuildSymbols` (sorted, conditional and only when non-empty, like `preprocessorSymbols`) and `testDiscovery: "arms-v1"` (conditional, and only when the test set is non-empty or an exclusion happened, so old digests stay stable).
  - **Red-check of the counterexample:** the target's `app.json` defines `X`; the config moves from `[]` to `[X]`; the test `app.json` defines nothing. The target set is `{X}` in both runs and the package hash is unchanged, but the test set goes from `{}` to `{X}`. The fingerprint MUST differ, so the resume is refused.
- **(f) Persist** (the `SessionReport` checklist in CLAUDE.md):
  - **Fields:** `testBuildSymbols: string[]` and `excludedTests: {test, file, reason: "compiled-out" | "preproc-undecided-kept"}[]`.
  - **A new `Caveat`, `tests-compiled-out`:** its `CAVEAT_INTERPRETATIONS` entry, plus the counts in `interpretation.test.ts` and `report.test.ts`.
  - **Ripple, in order:** `events.ts`, `report-fold.ts`, `report.ts` (type, builder and banner), `bun scripts/generate-schemas.ts`, `tests/schemas.test.ts` (the required list and older reports), and the `report-equality` snapshot update.
  - **Committed sample reports** regenerated LIVE (gift-card, as `schemas.test.ts` asserts). That needs a lease and a live run; I will ask before taking it.

## 4. Gates and frozen figures
- **Projects:** enumerated as `compile-fixtures.ts` does: every directory with an `app.json` under `fixtures/` and `examples/`, so `sandbox-harden-answers` and every test-only project are included.
- **The check:** for each project, under every build its gate uses (the R321 sets from `symbol-sets.json`, otherwise `[]`), master's `discoverTests` against the branch's must give identical test identities in identical order.
- **Expected:** only `fixtures/sandbox-symbols-tests` has `#if`, and that one is inside a test body, so nothing moves. No `app.json` declares `preprocessorSymbols`.
- **Scheme:** a test is not in a mutant identity key, so no bump. **R56:** unchanged.

## 5. Tests (test-first, each red-checked)
- **Discovery:**
  - `[]` drops `OnlyUnderX` and records it; `[LETHALX]` keeps it; `#if not X` is the mirror;
  - the test `app.json` symbols apply;
  - an undecided `s13` file keeps every test and records `preproc-undecided-kept`.
- **The compiled check:** built from the two scratch `.app`s, both mismatch directions at EQUAL versions:
  - published `[X]` and derived `[]` refuses, naming `OnlyUnderX` as published-only;
  - published `[]` and derived `[X]` refuses, naming it as derived-only;
  - equal sets pass.
- **Integration:** `planVerify` and `runSession` with the shape; the resume counterexample.
- **Red-checks:**
  - remove the arm filter;
  - drop the test `app.json` from the set;
  - let undecided files drop tests;
  - check only one direction of the compiled comparison;
  - leave `testBuildSymbols` out of the fingerprint;
  - initialise the parser after discovery.
- **Live re-measure after the build:**
  - al-runner `[]`: a green baseline, 1/1, with `excludedTests` naming `OnlyUnderX`;
  - bcdev `[]` under a lease: no refusal and a green baseline;
  - bcdev with the tests published `[X]` but the derived set `[]`: refused with `test-app-symbols-differ`.

## 6. `testpage-scan` and `test-digest`
Both are left. They err in their safe direction (a named over-refusal, and over-inclusion). R403 is narrowed to them and stays open, with the test arm map now available.
