# R-536 pre-commitment: a wrapped table and a wrapped page in `fixtures/sandbox-wrapped`

Written 2026-10-09, BEFORE any live run of the R-536 fixture change (branch `lethal/r536`). It extends
`2026-10-08-r343-wrapped-leg-precommitment.md` (al-runner) and `2026-10-08-r497-bcdev-wrapped-precommitment.md`
(bcdev); every row those two pin is unchanged. A difference in a live run is a finding and a STOP, never a
re-record.

## 1. Why
R536 part 1 (roadmap `R536.md`): R497 admits the one-arm wrapped shape for every object kind on BC, but the R-300b
probe and both wrapped gates held only codeunits. The admitted files in the real corpora are mostly tables, pages and
their extensions. This adds one wrapped TABLE with a field trigger and one wrapped PAGE, each with an unwrapped twin
whose text sits on the same lines, so a numbering difference by object kind shows up as a twin difference.

## 2. What changes in the fixture
- Target `fixtures/sandbox-wrapped` 1.0.0.1 gains four files, each one object alone in its file:
  - `WrappedTrigger.Table.al`, table 78907, `#if WRAPDEF` ... `#endif` (namespace inside the wrapper): field
    `Qty` with `trigger OnValidate` (`if Qty < 0 then Qty := 0;`) and `procedure Doubled(): Integer`
    (`exit(Qty * 2)`);
  - `WrappedTriggerTwin.Table.al`, table 78908, the same text, the two wrapper lines replaced by comments;
  - `WrappedView.Page.al`, page 78909 (Card, SourceTable `Wrapped Trigger`), wrapped the same way:
    `trigger OnOpenPage` (`Opened := true;`) and `procedure Label(X: Integer): Text`
    (`if X > 5 then exit('big'); exit('small');`);
  - `WrappedViewTwin.Page.al`, page 78910, its twin.
- Tests `fixtures/sandbox-wrapped-tests` 1.0.0.1 gains six tests, asserting by `Error()` and inserting nothing:
  `ClampTrigger` (`Validate(Qty, -5)` must give 0), `DoubledTrigger` (`Qty := 4`, `Doubled()` must be 8),
  `LabelView` (`Label(7)` on a page VARIABLE, never opened, must be `big`), and the three `...Twin` tests on the
  twins. No TestPage (the fenced session refuses one, R69).
- File names sort after `WrappedTopTwin`, so M0001-M0036 keep their codes.

## 3. Mutants (derived OFFLINE on `lethal/r536`)
`generateMutationSet` under the al-runner build's symbols (`WRAPAPP`, `WRAPDEF`, the predefined set) and under the
bcdev build's give the SAME list: M0001-M0036 unchanged, and 22 new ones, M0037-M0058. The al-runner index admits
`WrappedTrigger` and `WrappedView` (one arm, one object, nothing beside it); the bcdev line map refuses none of the
four new objects and names `Doubled` and `Label` on their own lines.

## 4. Verdicts, per mutant, EVERY leg (bcdev fenced, bcdev procedure/hub, al-runner one-shot, `--server`, resource)

A trigger mutant has no member name, so every backend places it by its OBJECT (selection's fallback 1: the tests
that ran anything in that object). So the table's trigger mutants are covered by BOTH table tests, and the page's
never-run `OnOpenPage` is covered by `LabelView`, which calls `Label` and never opens the page: those mutants are
run and SURVIVE (covered-but-unreached), they are not `no-coverage`.

| code | site | verdict | killing test | covering set | reason |
|---|---|---|---|---|---|
| M0037 | WrappedTrigger 19 empty-block (OnValidate) | killed | ClampTrigger | ClampTrigger, DoubledTrigger | -5 is not clamped |
| M0038 | WrappedTrigger 20 conditional-boundary | survived | - | ClampTrigger, DoubledTrigger | `<=` still clamps -5 |
| M0039 | WrappedTrigger 21 remove-assignment | killed | ClampTrigger | ClampTrigger, DoubledTrigger | -5 kept |
| M0040 | WrappedTrigger 21 shift-integer | killed | ClampTrigger | ClampTrigger, DoubledTrigger | clamps to a non-zero value |
| M0041 | WrappedTrigger 35 empty-block Doubled | killed | DoubledTrigger | DoubledTrigger | returns 0, not 8 |
| M0042 | WrappedTrigger 36 return-value Doubled | killed | DoubledTrigger | DoubledTrigger | not 8 |
| M0043-M0048 | WrappedTriggerTwin, the same six sites | as M0037-M0042 | the same names plus `Twin` | the same sets, names plus `Twin` | twin |
| M0049 | WrappedView 27 empty-block (OnOpenPage) | survived | - | LabelView | the page is never opened |
| M0050 | WrappedView 28 remove-assignment | survived | - | LabelView | the same |
| M0051 | WrappedView 28 flip-boolean-literal | survived | - | LabelView | the same |
| M0052 | WrappedView 32 empty-block Label | killed | LabelView | LabelView | returns '' |
| M0053 | WrappedView 33 conditional-boundary Label | survived | - | LabelView | `>=` still `big` for 7 |
| M0054-M0058 | WrappedViewTwin, the same five sites | as M0049-M0053 | the same names plus `Twin` | the same, plus `Twin` | twin |

New rows: killed 12, survived 10, no-coverage 0 over 22. Totals:
- **bcdev (both legs): killed 38, survived 20, no-coverage 0 over 58** (was 26 / 10 / 0 over 36).
- **al-runner (every leg): killed 36, survived 19, no-coverage 3 over 58** under the "adds" reading (was 24 / 9 / 3
  over 36; `WrappedArms` stays refused by name there).

Covering tests are `Wrapped Tests.<method>`; killing tests are bare method names.

## 5. What the gates assert, unchanged rules, extended tables
`packages/runner/itest/wrapped-fixture.ts`: `EXPECTED_WRAPPED` gains the 22 rows (the bcdev table derives from it),
`TWINS` gains the two pairs (strict parity both ways), and the bcdev check's refusal pattern now covers
`Table:789xx` and `Page:789xx` as well as codeunits. Baselines `al-runner.wrapped.baseline.json` and
`bcdev.wrapped.baseline.json` are deleted and recorded once each by R332's procedure (a record run exits 3), then a
confirming run of each gate. `itest:bcdev` (sandbox-app) does not use this fixture and cannot move.

## 6. What would mean what
- A twin difference on a new object: BC (or al-runner) numbers a wrapped table or page differently from its unwrapped
  twin: R536 part 1's risk is real; STOP.
- A trigger mutant covered by `ClampTrigger` alone, or a page trigger mutant `no-coverage`: object-level placement
  differs from the codeunit case (a selection finding, not a numbering one); STOP and read the coverage rows.
- A `coverage refused` naming Table/Page 789xx: the shape rule refuses a kind it should admit.
- `LabelView` or `DoubledTrigger` red at baseline: the page-variable call or the record call does not run on that
  backend (al-runner's page support is the least certain prediction here); STOP.
