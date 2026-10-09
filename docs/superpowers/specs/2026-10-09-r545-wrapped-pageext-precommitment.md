# R-545 pre-commitment: a wrapped page extension in `fixtures/sandbox-wrapped`

Written 2026-10-09, BEFORE any live run of the R-545 fixture change (branch `lethal/r545`). It extends
`2026-10-09-r536-wrapped-table-page-precommitment.md`; every row pinned before (M0001-M0058) is unchanged. A difference
in a live run is a finding and a STOP, never a re-record.

## 1. Why
R545 (roadmap `R545.md`): the R-545 census (`/coord/handoff/R-545/step1.md`) found wrapped PAGE EXTENSIONS admitted on
BC with sites (BaseApp 10 files, 20 sites), never measured. Table extensions (11 files), report extensions (1) and
XmlPorts (4) have 0 sites and are closed by the count. Reports are R550, by ruling.

## 2. What changes in the fixture
- Target `fixtures/sandbox-wrapped` 1.0.0.2 gains two files, each one object alone in its file:
  - `WrappedXtra.PageExt.al`, `pageextension 78911 "Wrapped Xtra" extends "Wrapped View"`, wrapped `#if WRAPDEF` ...
    `#endif` (namespace inside the wrapper): `var Seen: Boolean`, `trigger OnOpenPage` (`Seen := true;`) and
    `procedure Scaled(X: Integer): Integer` (`if X > 2 then exit(X * 10); exit(0);`);
  - `WrappedXtraTwin.PageExt.al`, `pageextension 78912 "Wrapped Xtra Twin" extends "Wrapped View Twin"`, the same text,
    the two wrapper lines replaced by comments.
- Tests 1.0.0.2 gain `ScaledXtra` (`Scaled(4)` on a variable of page `Wrapped View`, never opened, must be 40) and
  `ScaledXtraTwin`. Nothing is inserted; no TestPage.
- File names sort after `WrappedViewTwin`, so M0001-M0058 keep their codes.

## 3. Mutants (derived OFFLINE on `lethal/r545`)
Under both the al-runner and the bcdev build's symbols: M0001-M0058 unchanged, and 12 new, M0059-M0070. The al-runner
index admits `WrappedXtra.PageExt.al`; the bcdev line map refuses none of `pageextension:78911/78912` and names
`Scaled` on its own line in both; `Scaled`'s ORIGINAL-text lines lie inside the instrumented `OnOpenPage` above it
(pinned offline), so a frame mix-up would turn its rows `no-coverage`.

## 4. Verdicts, per mutant, EVERY leg (bcdev fenced and hub; al-runner one-shot, `--server`, resource)

The extension's `OnOpenPage` is a trigger, placed by its OBJECT (the extension, `pageextension:78911`), which only
`ScaledXtra` reaches; it is never run, so its mutants SURVIVE under `ScaledXtra`.

| code | site | verdict | killing test | covering set | reason |
|---|---|---|---|---|---|
| M0059 | WrappedXtra 14 empty-block (OnOpenPage) | survived | - | ScaledXtra | never opened |
| M0060 | WrappedXtra 15 remove-assignment | survived | - | ScaledXtra | the same |
| M0061 | WrappedXtra 15 flip-boolean-literal | survived | - | ScaledXtra | the same |
| M0062 | WrappedXtra 19 empty-block Scaled | killed | ScaledXtra | ScaledXtra | returns 0, not 40 |
| M0063 | WrappedXtra 20 conditional-boundary Scaled | survived | - | ScaledXtra | `>=` still true for 4 |
| M0064 | WrappedXtra 21 return-value Scaled | killed | ScaledXtra | ScaledXtra | not 40 |
| M0065-M0070 | WrappedXtraTwin, the same six sites | as M0059-M0064 | names plus `Twin` | names plus `Twin` | twin |

New rows: killed 4, survived 8, no-coverage 0 over 12. Totals:
- **bcdev (both legs): killed 42, survived 28, no-coverage 0 over 70** (was 38 / 20 / 0 over 58).
- **al-runner (every leg): killed 40, survived 27, no-coverage 3 over 70** (was 36 / 19 / 3 over 58).

Every existing row is unchanged, in particular the base page's `OnOpenPage` rows M0049-M0051 (and twins M0054-M0056)
stay covered by `LabelView` ALONE: `ScaledXtra` runs extension code, not the base page's.

## 5. What the gates assert
As R-536's spec §5; `wrapped-fixture.ts` gains the 12 rows and the `WrappedXtra` twin pair, and the bcdev refusal
pattern also covers `pageextension:789xx`. Both wrapped baselines are deleted and recorded once by R332's procedure,
then confirmed. The R-307 instrumented-output golden gains the two new files and the changed tests codeunit
(pre-approved by the orchestrator for the new fixture files only).

## 6. What would mean what
- A twin difference on the extension: BC or al-runner places a wrapped page extension's lines differently from its
  unwrapped twin: STOP.
- `ScaledXtra` added to M0049-M0051's covering set: BC attributes an extension procedure call to the BASE page object
  too (a placement finding, not a numbering one): STOP and read the coverage rows.
- M0059-M0061 `no-coverage`: the extension's object key is not where its coverage lands.
- `ScaledXtra` red at baseline: calling an extension procedure on an unopened page variable does not run on that
  backend (al-runner's support is the least certain prediction): STOP.
