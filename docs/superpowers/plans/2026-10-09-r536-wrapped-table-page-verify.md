# R-536 plan r2 (lethal-preproc, 2026-10-09) — FINAL

**r2 (after the opus plan review, `review-opus-plan-r1.md`):** I1-I3 adopted, and they supersede part 2's "Change"
and "Tests" below where they differ:
- Handover in `runNamedMutants` (the function every verify path goes through), not in `runVerify`: read the SOURCE
  run's recorded `buildSymbols` (`installed.fromRunId`), refuse null by name (never `[]`, R214), `handBuildSymbols`
  before the first `attach`.
- `narrow`'s ctx gains `buildSymbols` and `backendRefused` (`withBackendRefusals(backend, new Map())` after the second
  attach); verify's reach filter refuses `backendRefused` joined with `coverageRefusedObjects` under those symbols.
- Tests: orchestrator (handover before the first attach with a non-empty set; null refused before any backend call;
  `narrow` receives both); verify (RO rewritten to a NESTED wrapper, still refused; admitted direction on a bare
  object before a wrapper, which `[]` would compile out and refuse; a line-map refusal takes every new test). Every
  wiring revert went red (mutation-red-checker plus the revert-8 fix).
- Part 1: pre-committed in `docs/superpowers/specs/2026-10-09-r536-wrapped-table-page-precommitment.md` (d3dbdfba).

---

(r1 text, kept for the record)

Claim: run 001, token 14ef9cb6-d7f0-450c-9779-110518db0d4b. Branch `lethal/r536` from master 2e40f73f (scheme 36).
Item: `docs/roadmap/R536.md`. Order (orchestrator): part 2 first, then part 1.

## Part 2: `lethal verify` agrees with the run on a wrapped file

**Measured (code reading, step1.md):** verify is bcdev-only. `runVerify` already holds the SOURCE run's recorded
build symbols, `source.buildSymbols`. It refuses a run that recorded none (`source-predates-verify`, R214), and
`assertSourceUnchanged` proves the project still hashes to the source's snapshot under the given symbols. Two sites
read coverage without those symbols, so every `#if`-wrapped object is refused even where the run scored it:

1. **The backend.** `runNamedMutants` -> `attach` -> `indexInstalled` -> `lineMapFromSources(..., undefined)` (and,
   in hub mode, `indexHubRefusals`). The backend is never handed symbols in verify. Result: the line map refuses
   the object, `nameRefusals` prints "coverage refused ... Its mutants read no-coverage", and new tests' coverage of
   that object is unusable.
2. **The reach filter's refusal set.** `refusedObjectsOfSources(ctx.alSources)` calls
   `coverageRefusedObjects(..., "bcdev")` with no `armsOf`, so `narrowVerifyRequests` sends every new test to a
   wrapped survivor (`verify-reach-fail-closed`, R175/R298).

**Which symbols:** the source run's `source.buildSymbols`, not a fresh `effectiveBuildSymbols`. The keys, the
installed artifact and the stored `alSources` were all made under it, and R-497's session hands the run's effective
symbols (`handBuildSymbols`) in the same way. (Equal to the target's effective set whenever
`assertSourceUnchanged` passes, because the snapshot hash includes the symbol list.)

**Change (small):**
- `runVerify`: right after the `source-predates-verify` check, hand `source.buildSymbols` to the backend through
  the SAME helper the run uses (export `handBuildSymbols` from orchestrator.ts, or move it to a shared module).
  This must happen before `runNamed` (which attaches).
- `refusedObjectsOfSources(sources, symbols)`: pass `armsOf` = `evaluateArms(root, text, symbols)` per file to
  `coverageRefusedObjects`, exactly as `runSession` builds `bcArms`.
- Fix the stale comment ("verify reads the fenced line map's coverage (bcdev), which still refuses").

**Tests, a red one per direction and per site:**
- T1 (site 2, admitted): `#if not FOO` wrapped `Logic`, source symbols `[]` -> the arm compiles -> the survivor is
  narrowed like an unwrapped one (only reaching new tests run; no `verify-reach-fail-closed`). Red when
  `armsOf` is dropped.
- T2 (site 2, still refused): the existing RO test (`#if FOO`, symbols `[]`, compiled out) keeps taking every new
  test; add a nested-wrapper case that is refused by its shape sentence. Red if the refusal set ignores the
  shape predicate (e.g. arms passed but the result not used).
- T3 (site 1): a fake backend with `useBuildSymbols` records its argument and a call counter; `runVerify` hands it
  exactly the source's symbols (a non-empty set, e.g. `["LETHALX"]`, so `[]` vs missing is distinguishable)
  BEFORE `runNamed` is called. Red when the handover is removed or moved after `runNamed`.
- T4 (site 1, end to end through the real `BcDevMcpBackend.attach`): already pinned by R-497's
  "attach (fenced) with the build's symbols admits the wrapped object" test; T3 proves verify reaches it.
- No identity moves (no generation change), so no scheme number.

**R536.md:** part 2 closes with this; status stays open until part 1.

## Part 1: wrapped table (with a field trigger) and wrapped page in `sandbox-wrapped` (outline; detailed after part 2)
- Add one one-arm wrapped table with an `OnValidate` field trigger, and one wrapped page, each alone in its file,
  each with code a test in `sandbox-wrapped-tests` reaches (page code through a non-TestPage path if possible:
  TestPage is refused in the fenced session, R69, so a page's mutants are expected `no-coverage` unless a
  procedure on it is called directly). Bump both app.json versions; rebuild the tests app; `compile:fixtures`.
- The fixture feeds BOTH `itest:bcdev-wrapped` (fenced and procedure legs) and `itest:alrunner`'s wrapped leg, so
  pre-commit per mutant for all of them (one spec on master, [skip ci], sha to the orchestrator), then re-record
  `bcdev.wrapped.baseline.json` and `al-runner.wrapped.baseline.json` (delete, record exit 3, confirm pass).
- Live: `itest:bcdev-wrapped` under a Cronus28 lease (publish the new target and tests apps first, R56), and
  `itest:alrunner` locally.
