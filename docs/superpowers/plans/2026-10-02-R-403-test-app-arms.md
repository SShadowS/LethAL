# R-403: discovery reads the TEST app's `#if` build (short plan, r3)

Task: `H:/lethal-coord/tasks/R-403/task.md`. Item: `docs/roadmap/R403.md`. Branch `lethal/lane-preproc`, master 4c78e2b1.

## Revisions
- **r2 (b4a0ad73):** fixed review r1's findings 2, 3, 4 and 6.
- **r3** (`H:/lethal-coord/reviews/R-403-plan/reject-r2.md`, plus the orchestrator's versioning decision):

| Point | r3 change | Where |
|---|---|---|
| 1. No compiled evidence | Keep the UNFILTERED suite with a named caveat. Never an unchecked drop | §3(c) |
| 2. Versioning | Report stays **v3**: the new fields are OPTIONAL (additive, as R-307 does). Explain bumps, because the caveat domain widens. The number (v11 if this merges after R-307's v10) is confirmed by the orchestrator when the build reaches that step | §3(g) |
| 3. Exact equality | Membership is taken before execution refusals; a Test codeunit AND the `Test` attribute on both sides; `--tests-only` mapped from unfiltered declarations; the key is codeunit id plus the case-normalised method; a test for each legitimate case; the refusal text names every cause | §3(b) |
| 4. Which package | The check reads the package the session actually RUNS: after the `afterLeaseAcquired` publication (env-tool), under the lease. A valid replacement is not refused against the outgoing package | §3(b) |
| 5. Resume wording | `testBuildSymbols` is conditional on the SYMBOLS being non-empty. The old digest is kept only when the policy demonstrably leaves the suite unchanged | §3(e) |
| 6. al-runner | No package check. `testBuildSymbols` is documented as the DERIVED set | §2, §3(f) |

## 1. Measured today (scratch `H:/lethal-scratch/R-403/`; Cronus28 lease 085 released; scratch apps unpublished)

| Backend | Build | Result for `[Test] OnlyUnderX` under `#if LETHALX` |
|---|---|---|
| al-runner (c39ad5de) | `[]` | Listed, then `error` at baseline. `degraded [baseline-red]` |
| al-runner | `[LETHALX]` | 2/2 green |
| bcdev, Cronus28 | `[]` | The run is REFUSED (R31: "the published test app does not contain OnlyUnderX") |

**Compiled membership is evidence, measured.** The alc-built test `.app`'s `SymbolReference.json` lists only compiled-in methods:
- built `[]`: `PlainDoubles`;
- built `[LETHALX]`: `PlainDoubles` and `OnlyUnderX`, each with `Attributes [{"Name":"Test"}]`.

The embedded source holds both in both builds, so it is not evidence. Per R372, the dev-endpoint download has the same entries as the local `.app`.

## 2. The derived test set
The set is `effectiveBuildSymbols(testDir, configSymbols, ..., backend)`. It is made of:
- the config's `preprocessorSymbols`;
- the TEST app's own `app.json` symbols (measured on al-runner: with `LETHALX` only there, `OnlyUnderX` ran, while the target set stayed `[]`);
- on al-runner, the R392 predefined symbols;
- per-file `#define` (in `evaluateArms`).

It is called `testBuildSymbols` everywhere, and documented as the DERIVED set, not as an observed one.
- **al-runner** compiles the tests from exactly this set.
- **bcdev:** the set is checked against compiled membership (§3(b)).

## 3. Changes
**(a) Discovery.** `discoverTests(testDir, { only, buildSymbols })` evaluates each file's arms with `evaluateArms` (R214). A `[Test]` whose attribute starts in an inactive range is not discovered. Every exclusion is recorded (§3(f)).

**(b) bcdev compiled-membership check (exact definition).**
- **Package.** It reads the package the session RUNS.
  - On a direct bcdev session, that is the R139 download (the operator published before the run).
  - On an env-tool session, the check runs AFTER the `afterLeaseAcquired` hook (`publishTestApps`) and under the lease. It reads the `.app` files that hook published, not the pre-lease R139 read, which can hold the outgoing package.
- **Both sides are counted BEFORE any execution refusal:** TestPage-refused and disabled tests stay in on both sides.
- **What counts as a test, on both sides:** a method in a codeunit with `Subtype = Test` that carries the `Test` attribute. Handler attributes (`MessageHandler`, `ConfirmHandler` and the like) do not count, and `[HandlerFunctions]` does not remove the test it decorates.
  - Compiled side: `SymbolReference.json`'s codeunits, with recursion into namespaces, filtered by `Subtype` and by the method attribute.
  - Source side: discovery's `[Test]` list, which already requires `Subtype = Test` per codeunit section.
- **The key:** the codeunit id plus the method name lower-cased.
- **Scope:** with `--tests-only`, the compiled list is mapped to FILES through the UNFILTERED eligible source declarations (codeunit id to file, before arm filtering). So a compiled-only conditional test in an in-scope file is still compared, and a codeunit outside the scope is skipped on both sides.
- **The result:**
  - Equal: pass.
  - Unequal, in EITHER direction: refuse before the baseline with `test-app-differs`: `the published test app's compiled tests differ from the tests LethAL discovered in the test source under symbols [<set>]: published-only <names>; source-only <names>. Possible causes: the test app was built with other preprocessor symbols (set preprocessorSymbols in the config or the test app.json), or a test was added, renamed or removed in the source without republishing.`
  - R56, R31 and R139's source check are unchanged, except that R139's source-to-source comparison applies the same arm filter on both sides.
- **Tests:**
  - a case-only name difference passes;
  - a `[Test]` in a non-Test codeunit is ignored on both sides;
  - a TestPage test is compared;
  - a handler method is not counted, and its decorated test is;
  - an out-of-scope codeunit is skipped;
  - both mismatch directions refuse at EQUAL versions;
  - on env-tool, a valid replacement package published by the hook passes, although the pre-lease package differed.

**(c) No compiled evidence** (no package, an unreadable `SymbolReference.json`, a path that skips R139).
- Discovery uses the UNFILTERED suite. That is today's behaviour, never an unchecked drop. The new caveat `test-symbols-unverified` names the files with `#if` around a `[Test]`.
- It refuses only when the unfiltered suite is itself known to break the run. That case is R31's existing refusal at baseline; nothing new is added.
- al-runner never takes this path, because it compiles the tests itself (§3(f)).
- A test covers it.

**(d) Undecided test file.** Every `[Test]` is kept, as today, and recorded as `preproc-undecided-kept`.
- **Limit:** a compiled-out test in such a file still refuses the session on bcdev, now by name through `test-app-differs`, and still errors on al-runner.
- The test shape is R402's `s13` (R214: `marker-mismatch`; alc compiles it).

**(e) Resume.** `sessionFingerprint` gains:
- `testBuildSymbols` (sorted), present only when the derived test SYMBOL set is non-empty;
- `testDiscovery: "arms-v1"`, present only when the arm filter EXCLUDED at least one test or kept one as undecided.

So an old fingerprint stays valid exactly when the new policy left the discovered suite unchanged (no symbols, and no exclusion or undecided record).

**Red-check of the counterexample:** the target's `app.json` defines `X`; the config moves from `[]` to `[X]`; the test `app.json` is empty. The test set goes from `{}` to `{X}`, so the fingerprint differs and resume refuses.

**(f) al-runner.** There is no published-package check, because nothing is published. Discovery uses the derived set, and the discovery-completeness tests (§5) hold. `testBuildSymbols` in the report is the derived set.

**(g) Persist and version** (the CLAUDE.md `SessionReport` ripple).
- **New OPTIONAL fields**, present only when they say something:
  - `testBuildSymbols` (non-empty);
  - `excludedTests: {test, file, reason: "compiled-out" | "preproc-undecided-kept"}[]` (non-empty).
- **New caveats:** `tests-compiled-out` and `test-symbols-unverified`, each with its `CAVEAT_INTERPRETATIONS` entry, and the counts in `interpretation.test.ts` and `report.test.ts`.
- **Ripple:** `events.ts`, then `report-fold.ts`, then `report.ts` (type, builder and banner), then `bun scripts/generate-schemas.ts` (report v3 regenerated), then `tests/schemas.test.ts` (the optional fields, NOT the required list), then the `report-equality` snapshot update. The report stays **v3**, so committed sample reports remain valid and need no live regeneration.
- **The explain bump** (the caveat domain widens):
  - `EXPLAIN_SCHEMA_VERSION` in `packages/runner/src/explain.ts`;
  - a new hand-written `schemas/explain-v<N>.schema.json` (the previous file plus the two caveats), with the previous file kept readable;
  - `schemas/README.md`;
  - the explain version pin test (R233), and any agent-guide example that quotes the number.
  - **Before this step I message the orchestrator, who confirms `<N>`** (v11 if R-307's v10 is merged first).

## 4. Gates
- **Projects:** enumerated as `compile-fixtures.ts` does: every directory with an `app.json` under `fixtures/` and `examples/`.
- **The check:** under every build its gate uses (the R321 `symbol-sets.json` sets, otherwise `[]`), master's `discoverTests` against the branch's must give identical identities in identical order.
- **Expected:** only `sandbox-symbols-tests` has `#if`, inside a test body, so nothing moves. The fixtures' test apps are all compiled, so the compiled check must pass on each bcdev gate. That is checked live at the end, under a lease, on the fixtures it exercises.
- **Scheme:** a test is not in an identity key, so no bump.

## 5. Tests (test-first, each red-checked)
- **Discovery:** the R403 shape in `[]` and `[LETHALX]`, `#if not`, the test `app.json` symbols, and undecided `s13`.
- **Compiled check:** every case in §3(b), both directions, and the env-tool replacement.
- **No evidence:** the unfiltered suite plus the caveat.
- **Integration:** `planVerify` and `runSession` (the parser initialised BEFORE discovery on both paths); the resume counterexample.
- **Red-checks:**
  - remove the arm filter;
  - drop the test `app.json` from the set;
  - let undecided files drop tests;
  - check one direction only;
  - read the pre-lease package on env-tool;
  - filter on the evidence-less path;
  - leave `testBuildSymbols` out of the fingerprint;
  - initialise the parser after discovery.
- **Live re-measure:**
  - al-runner `[]`: green, 1/1, `OnlyUnderX` in `excludedTests`;
  - bcdev `[]`: no refusal, green;
  - bcdev with the tests published `[X]` and derived `[]`: `test-app-differs`, naming `OnlyUnderX` published-only.

## 6. `testpage-scan` and `test-digest`
Left as they are. Both err in their safe direction. R403 is narrowed to them and stays open.
