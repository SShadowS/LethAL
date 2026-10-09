# R-550 pre-commitment: a wrapped report in `fixtures/sandbox-wrapped`

Written 2026-10-09, BEFORE any live run of the R-550 fixture change (branch `lethal/r550`, plan r2 adopted on master
as `docs/superpowers/plans/2026-10-09-r550-wrapped-report-arm.md`). It extends the R-545 pre-commitment (bcf4ca32);
every row pinned before (M0001-M0070) is unchanged. A difference in a live run is a finding and a STOP, never a
re-record.

## 1. Why
R550: 30 `#if`-wrapped BaseApp reports deploy 1,945 sites today (report procedures 811, data-item triggers 756, report
triggers 213, request-page triggers 165; `/coord/handoff/R-550/step1.md`), admitted on BC on the codeunit/table/page
measurement. This adds one wrapped report and its unwrapped twin.

## 2. What changes in the fixture
- Target `fixtures/sandbox-wrapped` 1.0.0.3 gains:
  - `WrappedBandRow.Table.al`: plain (unwrapped) table 78915 "Wrapped Band Row" (`"Band Code"`, `Entry`, `Qty`), no
    triggers, no procedures: no mutant;
  - `WrappedYBand.Report.al`: report 78913 "Wrapped Y Band", `#if WRAPDEF` ... `#endif` (namespace inside),
    `ProcessingOnly`, one bounded TABLE data item over 78915 filtered `const('BAND')` with `OnAfterGetRecord`
    (`Total += Band(BandRow.Qty);`), a request page with `OnOpenPage` (`Shown := true;`, never shown), report trigger
    `OnPreReport` (`Total := 0;`), and BELOW them `procedure Band(N)` (`if N > 2 then exit(2); exit(1);`) and
    `procedure GetTotal()` (`exit(Total);`);
  - `WrappedYBandTwin.Report.al`: report 78914, the same text on the same lines, the wrapper lines as comments, its
    data item filtered `const('BANDTWIN')`.
- Tests 1.0.0.3 gain `BandYDirect` (`Band(3)` = 2 and `Band(2)` = 1 on an un-run report variable), `BandYRun` (delete
  its own 'BAND' rows, seed Qty 1..4, `UseRequestPage(false)`, `RunModal()`, `GetTotal()` = 6), and both twins.
- File names sort after `WrappedXtraTwin`; the plain table has no site. M0001-M0070 keep their codes.

## 3. Measured offline before this was written
- Mutants: under both builds' symbols, 28 new, M0071-M0098 (14 per report). R-500 refuses none (the twin, generated
  without the wrapper, deploys 14 with 0 hang-refused, 0 skipped). The al-runner index admits `WrappedYBand.Report.al`;
  the bcdev line map refuses neither report and names `Band` and `GetTotal` on their own lines; their ORIGINAL-text
  lines lie inside the instrumented triggers above them (pinned offline, `wrapped-fixture.test.ts`).
- Replacements (offline): empty-block -> `begin end`; remove-assignment -> statement removed; flip -> `false`;
  shift-integer `0` -> `1`; return-value -> `exit(0)`; conditional-boundary `N > 2` -> `N >= 2`.
- al-runner probe (plan I2; `/coord/handoff/R-550/scratch/probe550.ts`, current build 43f76177), the four tests
  UNMUTATED: all pass one-shot and `--server`. `BandYDirect` hits only `Band` (lines 58-60); `BandYRun` hits the data
  item trigger (23), `OnPreReport` (53), `Band` (58-60) and `GetTotal` (65); the request page is not hit; the twins
  the same lines; `--server` per-test scopes equal one-shot.

## 4. Verdicts, per mutant, EVERY leg (bcdev fenced and hub; al-runner one-shot, `--server`, resource)

Triggers are placed by the REPORT object (fallback 1): every test that ran anything in it, `BandYDirect` (runs
`Band`) and `BandYRun`. `Band` is covered by both by name, `GetTotal` by `BandYRun` only. Killer-first order puts
`BandYDirect` (fewest members) first, so every `Band` kill names it. Each kill's failure text is pinned (`KILL_TEXTS`).

| code | site (WrappedYBand) | verdict | killing test | covering | failure text contains |
|---|---|---|---|---|---|
| M0071 | 22 empty-block (OnAfterGetRecord) | killed | BandYRun | BandYDirect, BandYRun | `band total should be 6, got 0` |
| M0072 | 23 remove-assignment | killed | BandYRun | both | `band total should be 6, got 0` |
| M0073 | 42 empty-block (request page OnOpenPage) | survived | - | both | (never shown) |
| M0074 | 43 remove-assignment | survived | - | both | |
| M0075 | 43 flip-boolean-literal | survived | - | both | |
| M0076 | 52 empty-block (OnPreReport) | survived | - | both | (equivalent: Total starts 0) |
| M0077 | 53 remove-assignment | survived | - | both | (equivalent) |
| M0078 | 53 shift-integer `0`->`1` | killed | BandYRun | both | `band total should be 6, got 7` |
| M0079 | 57 empty-block Band | killed | BandYDirect | both | `Band(3) should be 2, got 0` |
| M0080 | 58 conditional-boundary Band | killed | BandYDirect | both | `Band(2) should be 1, got 2` |
| M0081 | 59 return-value Band | killed | BandYDirect | both | `Band(3) should be 2, got 0` |
| M0082 | 60 return-value Band | killed | BandYDirect | both | `Band(2) should be 1, got 0` |
| M0083 | 64 empty-block GetTotal | killed | BandYRun | BandYRun | `band total should be 6, got 0` |
| M0084 | 65 return-value GetTotal | killed | BandYRun | BandYRun | `band total should be 6, got 0` |
| M0085-M0098 | WrappedYBandTwin, the same 14 sites | as M0071-M0084 | names plus `Twin` | names plus `Twin` | the same texts |

New rows: killed 18, survived 10, no-coverage 0 over 28. Totals:
- **bcdev (both legs): killed 60, survived 38, no-coverage 0 over 98** (was 42 / 28 / 0 over 70).
- **al-runner (every leg): killed 58, survived 37, no-coverage 3 over 98** (was 40 / 27 / 3 over 70).

## 5. What the gates assert
`wrapped-fixture.ts`: the 28 rows, the `WrappedYBand` twin pair, `KILL_TEXTS` checked by both checkers, and `report`
in the bcdev refusal pattern. Both wrapped baselines re-recorded by R332's procedure, then confirmed; R-545's bcdev
leg already recorded (bcdev 42/28/0) before this. The R-307 instrumented-output golden gains the three new files and
the changed tests codeunit (to be approved for these files only).

## 6. What would mean what
- A twin difference: BC or al-runner places a wrapped report's lines differently from its twin: STOP.
- `Band`/`GetTotal` rows `no-coverage` on fenced or al-runner: a frame mix-up for reports (their original lines are
  inside the instrumented triggers): STOP.
- A killed row whose text is not the pinned one (a duplicate key, a refused `RunModal`, a permission error): a kill
  for another reason: STOP.
- A trigger row covered by `BandYRun` alone: BC does not credit a procedure call on an un-run report variable to the
  report object (a placement fact): STOP and read the coverage rows.
- `BandYRun` or `BandYDirect` red at baseline on BC: report execution or the variable call differs in the fenced
  session: STOP.
