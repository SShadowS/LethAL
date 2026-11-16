# PR-63 pre-commitment: the format-evaluate family across five languages, month and day names, and GlobalLanguage carry-over

Status: pre-commitment (coord PR-63, lethal-code, 2026-11-16), before the build. Follow-up of PR-52 (R1068; first Danish set →
#8178). Method: `scripts/refusal-family.ts` family `format-evaluate` and `--join` (one call per cell; the answer is carried by
`Error('V:[%1]', ...)`; per-cell BC differential by lethal-bugs on bc2/bc3). Evidence: `/coord/handoff/PR-63/`. Invented AL only.

## The new cells

**Languages.** GlobalLanguage 1031 (German), 1036 (French), 1044 (Norwegian), 1053 (Swedish), beside 1030 (Danish). Each runs one
cell set:
- Format of a Boolean;
- an Option and an Enum caption (an invented enum with captions per language, in XLIFF if the generator can carry translations;
  else the default caption);
- Date, Time, DateTime and Duration with format 0;
- a closing date;
- Decimal with `<Precision,2:2><Standard Format,0>` and `<Integer Thousand><Decimals>`;
- Evaluate of Boolean in the language's own words, the English words and `true`/`1`; Evaluate of Date and Decimal.

**Month and day names**, under each language and English:
- `Format(Date, 0, '<Month Text>')`, `'<Month Text,3>'`, `'<Weekday Text>'`, `'<Weekday Text,2>'`;
- `'<Day,2>. <Month Text> <Year4>'`.

**GlobalLanguage carry-over.** A codeunit holds two tests in a fixed order:
- `SetLanguage`: `GlobalLanguage(1030)`, then it passes;
- `ReadLanguage`: reports `V:[<GlobalLanguage()>]` and the Format of a closing date.
These cells are the generator's first two-test codeunits; each other cell stays alone in its own. On v3, PR-53 measured the
language back at 1033 between tests. On BC the answer depends on how the test path runs a codeunit (one session or a call per test).
lethal-bugs names the path, and the result is reported for that path. LethAL's bcdev path runs one test per call (R857).

## The diff

`--join` as in PR-52, with the depends flag `locale` on every language cell. A difference that only the server's region explains
(number and date shapes, which the region decides) is classed `locale`. A difference in a language word, a caption, a month or day
name, or the closing-date letter is classed as a language difference. al-runner's would be like #8178.

## Predictions
1. Unit tests for the new groups: the cell shape, the two-test codeunit's emit and join, red both ways.
2. The 325 equal cells of PR-52 stay equal (same build).
3. Language differences beyond #8178 are likely in month and day names and in the closing-date letter under the other four
   languages. Each new class: an invented repro, an upstream issue, a regression entry and an R586 row. The counts are reported:
   cells, equal, differing, classes.
4. Carry-over: v3 reads 1033. BC's answer is reported for the path lethal-bugs ran. If BC keeps 1030 within a codeunit run,
   that is a v3 difference only for paths that run a codeunit's tests in one session, and LethAL's bcdev path is not one.

## Addendum 1 (2026-11-16, after the v3 run and the Opus review, before the BC run)

**Prediction 4 was wrong on v3.** v3 reads **1030** in the carry-over reader, because the language stays within one codeunit run.
PR-53's 1033 was across requests and codeunits, a different question. So a BC 1033 on a path that runs both tests in one session
would be a v3 difference, and the carry cell's join class is `carry`, not `locale?`.

**The carry-over cell is made readable** (review HIGH):
- its tests are `A_SetLanguage` and `B_ReadLanguage`, so alphabetical and declaration order agree;
- a SingleInstance counter (codeunit 51540) is raised by the setter, and the reader reports it as `V:[<lang>|<closing
  date>|<counter>]`. With counter 1 the setter ran first in the same session; with counter 0 it did not, and the language value
  is not carry-over evidence;
- a two-test cell needs its setter row, or it is `missing`.

**Other review fixes:**
- the second name date is a Tuesday (6 Aug 2024), so Swedish weekday names differ from Danish and Norwegian, which are identical
  on every day;
- `<Month Text,3>` is noted as weak;
- the Enum and Option language cells are marked `default caption` (no translation file), not translation evidence.

**v3 refusals:** 42 new cells are refused on v3 (`Month Text` or `Weekday Text` in the language: da, fr, nb, sv, and German
Friday). They stay as cells; BC's answer is what the run records.
