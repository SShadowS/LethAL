# PR-93 pre-commitment: a keep census of the refusal families DO windows t10 and t11 still close on (lever 1 of R1092)

Coord PR-93 (2026-11-16). Source: PR-92's census of t9-t11's mutant-phase refusal closes (`/coord/handoff/PR-92/census-t9-t11.tsv`).
The 30 distinct texts that t10 (77 refusal closes, edge-847b1fa5a) and t11 (98 so far, edge-4ebfe7913, still running) closed
on are listed in `/coord/handoff/PR-93/t10-t11.close-texts.txt`. Method and rules: PR-74's
(`docs/superpowers/specs/2026-11-16-pr74-t9-refusal-families.md`), unchanged.

## What is measured
Every text t10/t11 closed on that is not on master's keep-list (`V3_SERVE_SAFE_REFUSALS`, e0c0b545). Each is produced by an
INVENTED refuser in a new generator family of `scripts/refusal-family.ts`. No DO source is read into a cell; the texts are
al-runner's own. The families:
1. **RecordRef not open:**
   - `KeyIndex` (16), `GetFilters` (14), `FindFirst` (6).
   - Today they close by name: never measured (R945's closes, PR-56 review M3).
2. **FieldRef never assigned:**
   - `Value` (7), `EnumValueCount` (4).
   - `Value` closes by name today: never measured.
3. **SetFilter:**
   - unexpected `>` in filter `<-1M>..<CM>` (39);
   - a text filter value for Date under no pinned language form (`-1M` 8, `-2026-09-01` 2);
   - `<x>` is not a BigInteger (`GL00000000` 7, `GU00000001` 2);
   - value expected after `<>` (4);
   - empty filter term (2).
4. **Report.RunRequestPage with a parameters string without the XML declaration (12):**
   - today kept for `Report.SaveAs` only;
   - RunRequestPage was measured only after a `Commit()` (PR-74 review H1).
   - Here it is measured inside a write transaction too (R1078).
5. **KeyRef never assigned:** `FieldCount` (4), `FieldIndex` (2).
6. **RecordRef.GetTable of Text** (6). Today it closes by name.
7. **Page.Run** with RecordRef as the record (6), and with an unassigned Variant (2).
8. **Conversion of Code to BigInteger** (4).
9. **An error in a SaveAs of a report with a layout** (`Standard Sales - Invoice` 4, `Standard Statement` 2). The inner
   error text is BC's own.
10. **An OutStream was expected, got an untouched handle** (4).
11. **Evaluate of `<300` into Decimal** (3). Today only `>100`, `>1000` and `<1000` are kept.
12. **Placeholder Pdf read** of a report (2).
13. **XmlDocument.ReadFrom** of something that is not an InStream (2).
14. **Report.SaveAs#2 of id 0** (2).
15. **CalcDate result outside 0001-9999** (2).
16. **DotNet Newtonsoft.Json.JsonTextWriter:**
    - `WritePropertyName` in state ArrayStart and in state Array (2 + 2), with the JSON paths t10/t11 show;
    - `WriteEndArray` "No token to close" (2).

**Method:** PR-54's `scripts/keep-census.ts` in its strict form, unchanged. For each class:
- one kept daemon (the control, then 3 rounds of refuser and reader, then one request holding both);
- 3 fresh daemons per refuser.

CLEAN means:
- every reader equals the control;
- `engineKept` is true on every kept reader;
- the refuser refused under serve with the TARGET TEXT exactly (or, for a family with a slot, a measured variant);
- no panic text.

The al-runner build is `current`, as printed. A family whose refuser cannot produce the target text in an invented cell is
NOT MEASURED, with what the cell gave instead, and is never kept.

## Predictions (committed before the census)
- **P1:** every measured class is CLEAN, as all 84 measured by PR-54 and PR-74 were.
- **P2:** at least 12 of the 16 families can be driven by an invented cell. Likely misses:
  - the SaveAs-with-layout errors (they need a report with a layout and BC's own inner error);
  - the placeholder Pdf read;
  - possibly Page.Run with RecordRef (it needs a page run without a client).
- **P3, the DO close drop.** After the CLEAN classes are kept, a later DO window's mutant-phase refusal closes on the kept texts
  are 0 (each kept text stops closing). Its refusal closes per 1,000 scored mutants fall by at least the share of t10/t11's
  175 closes that the kept texts had.
  - That share is computed from the census result and stated in the build's result file BEFORE that window runs.
  - If every family is kept, the share is 100% of these texts.

A drift-guard fire after a newly kept text is counted per text (R1072's false-fire rule applies: a fire whose fresh daemon
reproduces the row on a baseline-fail test is the known false class, and is reported as such).

## What changes in code, only for a CLEAN class
- Each CLEAN class gets a `PR56_KEPT` entry in `packages/runner/src/al-runner-server.ts`, in PR-56/PR-74's style:
  - exact where one text was measured;
  - `%SLOT%` placeholders only where t10/t11 show variants (the SetFilter operand and value, the Date text, the
    BigInteger code, the KeyRef/FieldRef member, the JSON path).
- No pattern may match a text of another class in the census, or a close text that stays unmeasured.
- The tests that pin today's closes for these texts (`al-runner-serve-rule.test.ts`, `al-runner-serve-pr74.test.ts`) are
  changed on purpose, each change named in the build's result.
- A NOT CLEAN class gets a deny note instead, and its keep stays off.
- The v3 gate runs on the final head.
