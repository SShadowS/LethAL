# R-403: discovery reads the TEST app's `#if` build (short plan)

Task: `H:/lethal-coord/tasks/R-403/task.md`. Item: `docs/roadmap/R403.md`. Branch `lethal/lane-preproc`, master 4c78e2b1.

## 1. Measured today (2026-10-02, scratch `H:/lethal-scratch/R-403/`, Cronus28 lease 085 released, scratch apps unpublished)

**The shape.** A test codeunit with `[Test] PlainDoubles` and, under `#if LETHALX`, `[Test] OnlyUnderX`, against a one-procedure target with 2 mutants.

| Backend | Build | What happened |
|---|---|---|
| al-runner (pinned c39ad5de) | `[]` | Discovery lists both tests. The baseline asks for `OnlyUnderX`: **`baseline batch 0: 1/2 passed — failing: R404 Tests.OnlyUnderX`**, status `error`, listed in `unsupportedTests`. The run completes **`degraded [baseline-red]`** and both mutants are still killed (by PlainDoubles). |
| al-runner | `[LETHALX]` | 2/2 green, normal. |
| bcdev, Cronus28 | `[]` (test app compiled without LETHALX) | **The whole run is REFUSED** at baseline: "`R404 Tests.OnlyUnderX: the published test app does not contain OnlyUnderX, which this project's source declares`". This is R31's stale-test-app refusal, telling the operator to republish a test app that is NOT stale. |

**Urgency.**
- On bcdev, any test app with a `[Test]` in an `#if` arm that its build compiles out cannot be measured at all.
- On al-runner, the run is falsely red. By R55, a mutant covered only by such a test would also become `no-coverage`, although here none is.

## 2. The test app's effective symbol set
- **al-runner** compiles both apps itself. Measured: the config's `preprocessorSymbols` (passed as `--define`) reach the test app; that was the `[LETHALX]` run. The test app's OWN `app.json` `preprocessorSymbols` also apply to it: with `LETHALX` only in the tests' `app.json`, `OnlyUnderX` ran and passed, while the report's TARGET set stayed `[]`. So the test set can differ from the target's.
- **alc** unions `/define` with the project's `app.json` symbols (R214, measured on the target). The operator compiles the test app for bcdev, so LethAL cannot see their `/define`s.
- **Rule.** The test set is computed exactly as the target's, by `effectiveBuildSymbols(testDir, configSymbols, ..., backend)`:
  - the config's `preprocessorSymbols`;
  - plus the TEST app's own `app.json` `preprocessorSymbols`;
  - plus, on al-runner, the probe-measured predefined symbols (R392), since al-runner compiles the tests too;
  - plus per-file `#define`/`#undef` (inside `evaluateArms`).

  There is no new config key. On bcdev, this is the assumption that the operator built the test app the way the config says. R31's refusal stays as the backstop for when they did not (see §3).

## 3. The `discovery.ts` change
- **Discovery.** `discoverTests(testDir, { only, buildSymbols })` evaluates each test file's arms with `evaluateArms(wrapRoot(parseAL(source)), source, buildSymbols)`, the same evaluator R214 uses for the target. A `[Test]` whose attribute starts in an inactive range is NOT discovered. The offsets match, because `maskNonCode` keeps positions.
- **Reporting.** Each dropped test is named once, in a warning `tests-compiled-out` (file, codeunit, method, and the set). There is no `SessionReport` field, to avoid the CLAUDE.md ripple; filing one is a later option if wanted.
- **An undecided test file** is discovered as TODAY: every `[Test]` is listed, plus a named warning `tests-preproc-undecided` naming the file and the reason. That is the safe direction for discovery:
  - a listed test that does not exist fails VISIBLY (al-runner `error` plus `baseline-red`; bcdev a refusal);
  - a dropped test that does exist loses its coverage SILENTLY, turning mutants into a plausible `no-coverage`.
  - So uncertainty must never drop a test.
- **R139 check 2** (`published-test-app.ts`) parses the PUBLISHED app's embedded source with the same `testsInAlSource`. It gets the same arm filter with the same set, so both sides agree, as that function's comment requires.
- **R31's refusal message.** When the missing method's declaration sits inside an `#if` region of its file, the refusal adds one sentence: the test may be compiled out because the test app was built with different symbols than LethAL derived (and it names them), so set `preprocessorSymbols`. The refusal itself stays, because the set really is inconsistent then.
- **Wiring.** The orchestrator computes the test set once, beside the target's, and passes it to discovery.

## 4. `testpage-scan` and `test-digest`
Both read every arm, and both err in their safe direction:
- `testpage-scan` over-refuses a test whose TestPage is only in an inactive arm. That is NAMED (`testpage-unsupported`), not silent.
- `test-digest` over-includes inactive text, so verify sees an edited test.

They are left as is. R403 is narrowed to them and stays open, with the arm map for the test app now available to them, so a later fix is cheap.

## 5. Gates and frozen figures
- **Test apps with `#if`:** only `fixtures/sandbox-symbols-tests` has one, and its `#if` is INSIDE a test body (`RateSmall`), not around a `[Test]`. Discovery is unchanged there under `[]`, `[LETHALA]` and `[LETHALB]`. No fixture's `app.json` declares `preprocessorSymbols`.
- **Check before submit:** run `discoverTests` on master against the branch for every `fixtures/*-tests` and `examples/*-tests`, under each set its gate uses. The discovered lists must be identical.
- **Keys and scheme:** a test is not part of a mutant identity key, so no key moves and there is no scheme bump.
- **Frozen gate figures:** none can move.

## 6. Tests (test-first, each red-checked)
- **`discovery.test.ts`:**
  - the R403 shape under `[]` drops `OnlyUnderX` and warns `tests-compiled-out`; under `[LETHALX]` it keeps both;
  - an `#if not LETHALX` test is the mirror case;
  - a test file with `#if and` (undecided) keeps every test and warns `tests-preproc-undecided`;
  - the test app's `app.json` symbols are applied.
- **`published-test-app` test:** the same shape published, so the local and remote lists agree with no refusal.
- **R31 message test:** a missing method inside an `#if` region gets the added sentence.
- **Red-checks:**
  - remove the arm filter: the `[]` drop test goes red;
  - drop the test `app.json` from the set: the `app.json` test goes red;
  - make undecided drop tests: the undecided test goes red;
  - filter only one side of R139: the agreement test goes red.
- **Live re-measure after the build:** the same scratch shape on al-runner `[]` must give a green baseline 1/1 with `tests-compiled-out` naming `OnlyUnderX`. On bcdev `[]` under a lease, there must be NO refusal and a green baseline.
