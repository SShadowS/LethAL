# R-550 plan r2: a wrapped report arm in `sandbox-wrapped` (lethal-preproc, 2026-10-09)

**r2 (opus plan review r1, `review-opus-plan-r1.md`, all adopted; plus the orchestrator's two conditions). These
supersede r1 below where they differ.**
1. **Request-page triggers, which way they fail (orchestrator condition 1).** A trigger has no member name, so every
   backend places a trigger mutant by its OBJECT (selection's fallback 1), never by a line: a misnumbered line cannot
   move a request-page trigger mutant at all. And coverage only chooses which tests run: a kill still needs a test
   green at baseline to FAIL under the active mutant. So the worst case is mis-selection (an extra covering test, or
   `survived` where a test would have killed with a request page shown), never a false kill. Per the ruling they stay
   deployed and get their own item (request-page trigger mutants run covered-but-unreached; no gate shows a request
   page). The arm also gains ONE request-page trigger (review M3), which survives on both backends under
   `UseRequestPage(false)` and puts that section's object-level placement under twin parity.
2. **Fixture order (orchestrator condition 2; review M2).** `lethal/r550` is built on `lethal/r545` (merged in), the
   pre-commitment uses codes after M0070 against R-545's bcf4ca32, and R-550's `bcdev.wrapped.baseline.json` is
   recorded only after R-545's own bcdev leg has passed and recorded. Submit only after R-545 is accepted, then merge
   onto master; if R-545's BC run moves anything, this pre-commitment gets an r2.
3. **I1:** `BandYRun` (and its twin) DELETES its own rows (`"Band Code" = 'BAND'` / `'BANDTWIN'`) before seeding, as
   R254's `ClearRelated` does, so no backend's rollback behaviour matters.
4. **I2:** before pre-committing, the four new tests (`BandYDirect`, `BandYRun` and their twins) run UNMUTATED on
   al-runner, one-shot and `--server`, with `--coverage`: they pass, both reports have a `<class>`, the trigger and
   `Band` lines are hit, and `BandYDirect` alone hits only `Band`'s lines. On BC the same is read from the gate's
   record run, which is after the pre-commitment by design.
5. **I3:** the new kill rows pin their failure text (an optional per-row field in `wrapped-fixture.ts`, checked
   against `killingTestFailure`), and `assertBcWrappedRun`'s refusal pattern gains `report`.
6. **M1:** the plain table's key field is `"Band Code"`, not `Code`.
7. Numbering evidence, stated exactly: only the `Band` and `GetTotal` rows on the fenced and al-runner legs; trigger
   rows are object-placed and the hub leg places by method id.

---

(r1 text, kept for the record)

# R-550 plan r1: a wrapped report arm in `sandbox-wrapped` (lethal-preproc, 2026-10-09)

Claim: run 001, token 1d32a956-c35f-4123-a6c8-ef59e5370ba5. Branch `lethal/r550` from master a9a89955.
Measured first: `step1.md` (30 admitted wrapped BaseApp reports deploy 1,945 sites: report procedures 811, data-item
triggers 756, report triggers 213, request-page triggers 165; DC/DO/CDO none; the one report extension deploys 0).

## Goal
Measure, live on both backends, that a `#if`-wrapped REPORT's covered lines are placed in the same member as its
unwrapped twin's, as R536 did for a table and page and R545 for a page extension. Pre-committed per mutant.

## Sequencing
R-545 (pageextension, M0059-M0070) is not merged yet (its bcdev leg waits on a container). This arm's mutant codes
follow R-545's, so: build R-550 on top of `lethal/r545` (merge it in) or wait for its merge; the pre-commitment is
written against the tree that includes R-545's files. File names sort after `WrappedXtraTwin` (`WrappedYBand*`), so
M0001-M0070 keep their codes.

## How each backend runs a report (the measured method, R254's `DataBandExt` arm in `sandbox-data`)
- **Fenced BC session:** a test reaches report code two ways, both MEASURED live by R254 (fixture comments in
  `sandbox-data-tests`): (a) calling a report procedure on a `Report` variable WITHOUT running it; (b)
  `Rep.UseRequestPage(false); Rep.RunModal();` after the test seeds rows (uncommitted; BC rolls them back after the
  test, R32), which runs the data items and their triggers and the report triggers in the session. No request page
  is shown, so no handler is needed.
- **al-runner:** the same two routes run in its in-memory runtime (R254 measured both on al-runner too). A request
  page would go through its `[RequestPageHandler]` dispatch; `UseRequestPage(false)` avoids it.
- Request-page triggers (165 sites in BaseApp) are reached only with a request page shown. This arm does NOT cover
  them: on BC a request page in the fenced session is the TestPage-family problem (R69), so it would measure that
  refusal, not the numbering. Recorded as a known gap in R550, not built.

## The arm (one report and its twin, each alone in its file, plus one plain table)
- `WrappedBandRow.Table.al`: a PLAIN (unwrapped) table 78915 "Wrapped Band Row" with `Code: Code[20]` (PK part),
  `Entry: Integer` (PK part) and `Qty: Integer`, NO triggers and NO procedures, so it adds no mutant and no coverage
  object for the existing rows (the tests' seeding touches no code). Shared by both reports.
- `WrappedYBand.Report.al`: `#if WRAPDEF` report 78913 "Wrapped Y Band", `ProcessingOnly`, one data item over
  "Wrapped Band Row" with `DataItemTableView = where(Code = const('BAND'))` (a bounded TABLE item, not an open
  Integer item), with:
  - data-item trigger `OnAfterGetRecord`: `Total += Band(Qty);`
  - report trigger `OnPreReport`: `Total := 0;`
  - report-level `procedure Band(N: Integer): Integer` (`if N > 2 then exit(2); exit(1);`) placed BELOW the triggers,
    so its original-text lines lie inside the instrumented triggers (the numbering evidence, as `Doubled`/`Label`);
  - report-level `procedure GetTotal(): Integer`.
- `WrappedYBandTwin.Report.al`: report 78914, the same text on the same lines, the wrapper lines as comments, its data
  item filtered `const('BANDTWIN')` (so the two reports never read each other's rows).
- Tests: `BandYDirect` (`Rep.Band(3)` = 2 and `Rep.Band(2)` = 1 on a report variable, no run), `BandYRun` (seed four
  'BAND' rows with Qty 1..4, `UseRequestPage(false)`, `RunModal()`, `GetTotal()` = 1+1+2+2 = 6), and both `...Twin`.
  Inserts only into the new plain table.
- **Before pre-committing, measured offline:** the new file's sites deploy (none hang-refused, none skipped) under
  both builds' symbols; the al-runner index admits it; the bcdev line map names `Band`/`GetTotal` on their lines and
  refuses nothing; the placement guard (original-text `Band` lines inside the instrumented triggers) holds. If R-500
  refuses the data-item trigger's sites, change the shape (not the refusal) and re-measure.

## Predictions to pre-commit (shape, to be filled from the offline mutant list)
- Data-item and report triggers: placed by OBJECT (fallback 1), so covered by every test that ran anything in report
  78913: `BandYDirect` (runs `Band` only) AND `BandYRun`. Kills come from `BandYRun` (the total); `BandYDirect` can
  never kill a trigger mutant.
- `Band` and `GetTotal`: exact member coverage. `Band` is covered by both tests; `GetTotal` by `BandYRun` only.
- Existing rows M0001-M0070 unchanged (the new table has no code; the report touches no existing object).
- Totals then: bcdev and al-runner both grow by the new rows; al-runner keeps its 3 no-coverage (WrappedArms).

## Gates and records
`itest:bcdev-wrapped` (a container lease; publish target at a minted version, then tests) and `itest:alrunner`; both
wrapped baselines re-recorded by R332's procedure after a pre-commitment on master; the R-307 instrumented-output
golden re-recorded for the new files (pre-approval to be asked: new files only). No identity moves; no scheme number.
Opus review of this plan before building; opus build review before submit.

## Risks the review should test
- R-500's table-item refusal: does a bounded `DataItemTableView` table item with a trigger calling a report procedure
  count as an open item, or a one-hop callee? (Measured offline before pre-commitment, see above.)
- `BandYRun` inserts: could BC record coverage on the plain table object, or on `Wrapped Trigger`? (The table has no
  code; the gate's twin and per-mutant rows would show any spill.)
- al-runner report execution of a `ProcessingOnly` report with `UseRequestPage(false)`: R254 measured it; confirm the
  measurement covers a report-level trigger, not only an extension's `modify` trigger.
