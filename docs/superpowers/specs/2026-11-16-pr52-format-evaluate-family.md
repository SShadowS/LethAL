# PR-52 pre-commitment: a generator family for Format, Evaluate and text functions, with a per-cell BC differential

Status: pre-commitment (coord PR-52, lethal-code, 2026-11-16), before the build. Why the method changes: per-mutant batches now
mostly find known classes (PR-49, R1065). These functions have answers BC defines exactly, and an emulator is likely to approximate
them. Base: `scripts/refusal-family.ts` (PR-01; BC checks per PR-17, `--emit-bc-check`). The BC side is lethal-bugs' (standing
approval for small BC differentials, 2026-11-14: scratch ids, a lease, unpublished after). Evidence: `/coord/handoff/PR-52/`.
Invented AL only.

## The family `format-evaluate`

Each cell is its own test codeunit and makes ONE call. It reports its result as the test's failure message:
`Error('V:%1', <result>)`. A text result goes in as it is. Any other value goes in through `Format(<value>, 0, 9)`, the XML format,
which is fixed and locale-free. Evaluate cells report `V:<ok>|<value>`. A cell that raises reports BC's or al-runner's own error
text instead. So a cell's answer is its message (or "refused"), and nothing is asserted.

The cells (about 250; the exact count is in the result):
- **Format(value)**, **Format(value, length)** and **Format(value, 0, <n>)** for n in 0, 1, 2, 9. Also
  **Format(value, 0, '<format string>')** with standard pictures (`<Precision,2:2><Standard Format,0>`, `<Day,2>/<Month,2>/<Year4>`,
  `<Hours24>:<Minutes,2>` and similar). Value types: Decimal (0, negative, large, many decimals), Integer, BigInteger (min/max),
  Boolean, Date (0D, a normal date, the closing date), Time, DateTime, Duration, Option, Guid, Code, Text.
- **Evaluate(var X; Text)** for Integer, Decimal, Boolean, Date, Time, DateTime, Duration, Guid, Option and Code. Text is valid,
  invalid, empty, padded, or uses the other separator (`1.5` / `1,5`); some cells pass the format number 9.
- **Text functions**: CopyStr (start 0, past the end, negative length), PadStr (negative length, a long filler), SelectStr (out of
  range, empty item), ConvertStr (unequal lengths), DelChr (each where-mode), IncStr (no digits, `9`, `A9`, `Z99`, negative),
  StrSubstNo (missing and extra arguments, `%10`, `#1#`), UpperCase and LowerCase of non-ASCII, StrPos, Text.Substring and Text.Split
  edges.

Locale. Default formats (n = 0, and Evaluate without 9) depend on the session's language and region. The BC side records the
server's language and region (bc2/bc3: W1, en-US), and al-runner's run records its own. A difference that only a locale explains
is classed as such, not as an al-runner defect, unless al-runner ignores a setting it is given.

## Runs and diff
- v3, offline: `bun scripts/refusal-family.ts --family format-evaluate --json <file>` on `current`, one heavy slot.
- BC: `--emit-bc-check` writes the app (ids from 51000, as PR-17's), compiled with alc. lethal-bugs runs it on bc2 or bc3 through
  LethAL's web-service path and returns each cell's outcome and message.
- The join: per cell, v3's outcome and message against BC's. Equal is equal. A differing cell gets a class:
  - v3 refused (an issue's measured answer);
  - a different value;
  - a different error text;
  - one side errors and the other returns;
  - locale.

## Predictions
1. The family, its emit and its join get unit tests (cell shape, the value encoding, the join's classes), red both ways.
2. Most cells are equal. At least one class of differing values is found. The point of the method is that BC's exact answers
   catch approximations.
3. Each class that is al-runner's gets an invented repro, an upstream issue, a regression entry and an R586 row. The result gives
   the counts: cells, equal, differing, refused, and classes.

## Addendum 1 (2026-11-16, after the first BC run and the Opus review, before the second run)

**First run** (edac870a's 295 cells; BC: lethal-bugs, bc2, W1 en-US):
- **295 of 295 equal**, compared on raw message text with padding included. Rows checked to hold real values on both sides.
- Prediction 2 missed: no differing class under en-US.
- Files: `/coord/handoff/PR-52/joined-prelim.tsv`, `v3-edac870a.json`, `bc/format-evaluate.bc2.tsv`.

**Changes for the second run:**
- **Review fixes:**
  - one normalizer on both sides of the join;
  - raw answers shown escaped;
  - an end marker `V:[...]`, so a trimmed message reads as `transport-trimmed`;
  - an explicit per-cell `depends` flag (`locale` or `tz`) replacing the name regex;
  - Evaluate starting from a non-default sentinel;
  - a control cell for Error's own `%` substitution;
  - the join refusing ids out of range.
- **A time-zone probe cell:** local midnight printed as UTC, reported through `V:`.
- **A cell set under `GlobalLanguage(1030)` (Danish), about 30 cells.** It covers Format of Boolean, Decimal, Date, Time, DateTime
  and Option; Evaluate of Boolean ('Ja', 'Nej', 'Yes', 'true'), Decimal and Date; StrSubstNo with Decimal and Date arguments; and
  Upper/LowerCase of æøå. Also non-en-US decimal and date formats, if a test can set them without a client. The orchestrator's
  reason: the SetFilter refusal (DO t7) shows al-runner does not pin other languages' words, so differences are likely there.

**Prediction 2, restated for the second run:** the en-US cells stay equal (now with markers and sentinels). If any class differs,
it is in the Danish set, or in what a failed Evaluate leaves in its variable.
