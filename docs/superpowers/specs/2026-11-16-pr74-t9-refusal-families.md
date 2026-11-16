# PR-74 pre-commitment: t9's drift check (part 1) and a keep census of the refusal families t9 met (part 2)

Coord PR-74 (2026-11-16). Source: DO window t9 (R-984, `/coord/handoff/R-984/t9.run.events.ndjson`), the first window with
PR-56's keep entries and drift guard.

## Part 1 (settled; recorded here)

PR-56's drift guard fired once in t9. Its kept refusal was the number-sequence cascade in Codeunit68994. The next request on
the same daemon gave `Codeunit68859.CreatePDF_WithValidData_ShouldCreatePDF` the row "RecordRef.Duplicate on a RecordRef that
is not open", where its baseline row is `fail`. The guard closed the daemon and re-sent the same request, and only that one,
on a fresh daemon (seq 33332). The fresh daemon gave the same refusal on the same test (seq 33333). So a daemon that never saw
the kept refusal reproduces the row: the kept class carried no state that mattered.

The baseline row is a red test. Its coverage stops where it fails, so a mutant past that point can change the outcome, or
here turn it into a refusal, without counting as covering. **Ruling (orchestrator, 2026-11-16): keep the guard as it is.**
A false fire costs one re-run, while a skipped fail-to-pass flip could cost a verdict. The class is noted in R1072.

## Part 2: what is measured

t9's refusal closes in the mutant phase came from families PR-56 does not keep. Six are measured here, each by an INVENTED
refuser that produces t9's exact text (no DO source is read into a cell; the texts are al-runner's own):
1. `SetFilter: value expected after ..` (and `.. after @`, the same family);
2. `Evaluate of `>100` into Decimal (form not pinned by the corpus)`, with `>1000` and `<1000`;
3. `RecordRef.Duplicate on a RecordRef that is not open: ...`;
4. `a parameters string without the XML declaration in this form, given to Report.RunRequestPage (...)`, and the same given
   to `Report.SaveAs`;
5. `DotNet new System.IO.Compression.ZipArchive raised the .NET exception System.IO.InvalidDataException: Central Directory
   corrupt. ...`;
6. `DotNet Newtonsoft.Json.JsonTextWriter.<method> raised the .NET exception Newtonsoft.Json.JsonWriterException: ...` for
   WriteEndObject, WriteStartObject and WritePropertyName.

Also measured where a cell can produce them, since t9 met them in the same count range: `conversion of Boolean false to
BigInteger`, `RecordRef.ClearMarks on a RecordRef that is not open`, `FieldRef.SetFilter on a FieldRef that was never
assigned`.

**Method:** PR-54's `scripts/keep-census.ts` in its strict form, unchanged, on a new generator family in
`scripts/refusal-family.ts`. Each cell starts with R-967's kit writes. There is one kept daemon per class (the control, then
3 rounds of refuser and reader, then one request holding both), and 3 fresh daemons per refuser. CLEAN means every reader
equals the control, `engineKept` is true on every kept reader, the refuser refused under serve, and no panic text appeared.
al-runner build: `current`, as printed. A family whose refuser cannot be made to produce t9's text in an invented cell is
reported NOT MEASURED, with what the cell gave instead. It is never kept.

## Predictions

- P1: every measured class is CLEAN, as all 74 of PR-54's were.
- P2: at least 5 of the 6 families can be driven by an invented cell. The likely miss is the ZipArchive one, whose text
  names a stream-position exception that depends on the bytes given.

## What changes in code, only if a class is CLEAN

Each CLEAN class gets a `PR56_KEPT` entry in `packages/runner/src/al-runner-server.ts`, in PR-56's style: exact where one
text was measured, `%SLOT%` placeholders only where t9 shows variants (the Evaluate operand, the JsonTextWriter method and
the JSON path, the Report method). No pattern may match a text of another class in the census or a close text R945 keeps
closed. A NOT CLEAN class gets a deny note instead, and its keep stays off. The v3 gate runs on the final head.
