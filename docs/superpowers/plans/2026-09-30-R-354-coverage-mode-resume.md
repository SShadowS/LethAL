# R-354: no verdict crosses a coverage-mode change (short plan)

The coverage mode is `caps.coverage` (`CoverageMode` in `backend.ts`: none, procedure, line,
fenced, al-runner). `runSession` reads `caps` before it computes the fingerprint
(`orchestrator.ts`, `sessionFingerprint({...})` just before `resolveResume`), so the mode is
known at that point. Rule throughout: modes must be EQUAL. Any difference, including fenced
against procedure, refuses. Re-scoring is the cheap direction.

## 1. Fingerprint
Add `coverageMode?: CoverageMode` to `SessionFingerprintInput`, serialised as a conditional
key (`...(input.coverageMode !== undefined ? { coverageMode } : {})`), placed like C02-06's
`preprocessorSymbols`. `runSession` ALWAYS passes it. So the function keeps every old digest
for an input without the key (the `PINNED` value and R325's recomputed scheme-1 digest do not
move), but no digest a new session computes can equal one recorded before R354. An old digest
is simply the same JSON without `coverageMode`.

## 2. Old runs with no recorded mode: option (a), refuse to carry
Not knowable. The mode came from config, and the default moved (R58 made `fenced` the bcdev
default; al-runner went from `none` to optional `al-runner` in R220). No run row records the
build or the config, so "the mode that config would produce" would be a guess. The cost is the
same one-time cost R325 paid: every unfinished run in an existing store stops resuming once, and
the next `--skip-known-survivors` run skips nothing once. Both are loud (named refusal, named
warning), and neither can change a verdict.

## 3. Store
Yes, one migration. Add `coverage_mode TEXT` to `runs` in `SCHEMA` and in the `migrate()` column
loop, beside `identity_scheme`. NULL on an older row, read as "unknown", which never equals a
mode. `createRun` takes `coverageMode: CoverageMode` as a REQUIRED field (like
`identityScheme`), filled from `caps.coverage`; `lethal verify`'s `createRun` call passes the
source run's mode, or the backend's, whichever it measures under (check at build time). `RunRow`
gains `coverageMode: CoverageMode | null`. A value outside the closed set throws (corrupt row).

## 4. Named refusals
- `--resume-run <id>`: checked after the scheme check and before the fingerprint check:
  `--resume-run <id> was measured under coverage mode <old>, but this session measures under
  coverage mode <new>. An unreached mutant scores survived with coverage off and no-coverage with
  it on, so none of its verdicts is carried (R354). Drop --resume-run to run from scratch.`
  For NULL, `<old>` reads `an unrecorded coverage mode (the run predates R354)`.
- `--resume last`: when `findResumableRun` finds nothing and the R325 scheme check finds
  nothing, a new `store.unfinishedRunUnderOtherCoverageMode({projectPath, backend, coverageMode,
  carryableVerdicts})` (SQL `coverage_mode IS NOT ?`, so NULL counts) names it:
  `--resume found an unfinished run for this project and backend, run <id>, but it was measured
  under coverage mode <old> ... (R354). Drop --resume to run from scratch.`

## 5. History
`priorSurvivorKeys(projectPath, coverageMode, onSchemeChanged, onCoverageModeChanged)`: the
latest finished run's `coverage_mode` must equal the current one, else no key is returned and
the callback fires. Scheme is checked first. The orchestrator emits warning
`history-coverage-mode-changed` once per session (same guard as R325's), naming the run, both
modes and R354. Both directions matter: off to on, an off survivor may be `no-coverage`; on to
off, an on survivor faces more tests and may be killed.

## 6. Tests (`packages/runner/tests/resume.test.ts`, new `R354` describe block)
`CountingBackend` gains an optional caps override so a test can run coverage `none` and
`procedure`. A helper records a run under mode A, then a second session runs under mode B.
- For both directions (none to procedure, procedure to none): `--resume-run` refused by the
  exact message; `--resume last` refused naming the run; history executes every mutant, zero
  `known-survivor`, one `history-coverage-mode-changed` warning.
- A NULL-mode row (set by SQL, as R325's helper does) is refused on all three paths.
- Controls, same mode: resume-run and resume last carry; history skips the survivors.
- Fingerprint: differs by mode; `PINNED` unchanged without the key.
- Report: under the refused off-to-on resume, the fresh coverage-on report has no survived
  mutant without `coverageAttribution` (the R252 shape `explain` refuses).
Red-checks: remove the mode from the fingerprint call (resume last carries, test red); remove
the `--resume-run` mode check (falls to the generic "scoped differently" message, the exact
message test goes red); remove the history mode check (known-survivors appear, red). Each
restored and reported.

## 7. Tasks
1. Store: `coverage_mode` column, migration, `createRun`/`RunRow`/`getRun`,
   `unfinishedRunUnderOtherCoverageMode`, `priorSurvivorKeys` mode filter
   (`packages/runner/src/store.ts`, store tests). This is the one schema change.
2. Fingerprint, refusals, history warning: `packages/runner/src/resume.ts`,
   `packages/runner/src/orchestrator.ts` (`resolveResume` takes the mode, `createRun` call,
   history call), plus any other `createRun` caller.
3. The R354 test block and red-checks in `packages/runner/tests/resume.test.ts`; roadmap R354
   marked done.
No change to the report schema or `explain`: R252 already records `coverageMode`. The new
warning code is an event string only; check whether `events.ts` keeps a closed list of warning
codes and add it there if so.

**Controller rulings on the plan's open points (to confirm in review):** (1) ANY coverage-mode
difference is a change, fenced against procedure included, not only off against on: a verdict
scored under one attribution rule is not evidence under another. (2) `lethal verify` records its
OWN backend's mode on the run it creates, because that is what the run it records actually used.

## Approved 2026-09-30 (c188b768)

Both controller rulings confirmed. Addition for (2): when verify's mode differs from its SOURCE run's recorded mode, or the source's is NULL, verify's output says so by name, since a `no-coverage` verdict in the source is not comparable across modes. Verify REFUSES if its logic depends on the source's coverage facts; otherwise it WARNS. The note says which, with a test. CHANGELOG gains one line: unfinished runs from before R354 are refused once, and the next `--skip-known-survivors` skips nothing once.
