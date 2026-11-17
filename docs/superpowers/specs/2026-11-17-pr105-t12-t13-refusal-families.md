# PR-105 pre-commitment: a keep census of the refusal families DO windows t12 and t13 still close on (lever 1, next round)

Coord PR-105 (lethal-code, 2026-11-17). Method and rules: PR-93's (`docs/superpowers/specs/2026-11-16-pr93-t10-t11-refusal-families.md`),
unchanged: invented refusers in `scripts/refusal-family.ts`, `scripts/keep-census.ts` strict (`--refusers 7`), and CLEAN only
as PR-93 defines it.

## The closes (after PR-93's keeps)
Source: every `serve-daemon-closed` with reason `refusal`.
- **Where they come from:** t12 (head 4763e43d, edge-847b1fa5a) and t13 (finished; PR-100's close phase present).
- **The exact texts** are in `/coord/handoff/PR-105/targets.out.txt` (local; they are al-runner's own, never committed). It
  was made by `/coord/handoff/PR-105/targets.ts` against master's `V3_SERVE_SAFE_REFUSALS`. No text is on the keep-list.

| | t12 | t13 |
|---|---|---|
| refusal closes | 35 | 36 |
| scored mutants (`mutant-scored`) | 28,461 | 29,851 |
| per 1,000 | 1.23 | 1.21 |
| phase (t13 only) | — | prefetch 22, live 14 |

**71 closes on 17 texts, in these classes:**
1. **FieldRef.CalcField of a field that is not a FlowField:** 14.
2. **Report.RunRequestPage with a parameters string without the XML declaration:** 12. NOT measured here: PR-74's review H1
   and PR-93 (it does not refuse inside a write transaction) keep it off.
3. **SetFilter: `C10000` is not a BigInteger:** 8. PR-93 kept two measured values; this one is a new measured variant.
4. **An error in a SaveAs of a report with a layout** (`Standard Sales - Invoice` 6, `Standard Statement` 2): 8. NOT
   producible in an invented cell (it needs Base Application's reports; PR-93).
5. **Evaluate of a whitespace-only text into Decimal** (three widths): 6.
6. **Conversion of an XML Text to Blob:** 4.
7. **A list without the new-row line that lost its only row to an action:** 4.
8. **An action left another row in Rec with changes to save:** 4.
9. **Conversion of Text `=18` / `1=18` to Integer:** 4.
10. **A read of a placeholder Pdf of a report:** 2. NOT producible (PR-93).
11. **CopyStream from an untouched handle into a DotNet stream:** 2.
12. **DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raising its .NET exception:** 2.
13. **Report.SaveAs#2 to an untouched handle:** 1.

Classes 2, 4 and 10 (22 closes) are out of reach. Classes 1, 3 and 5-9 and 11-13 (49 closes, 69%) are measured.

## Predictions (committed before the census)
- **P1:** every measured class is CLEAN, as all of PR-54's, PR-74's and PR-93's were.
- **P2:** at least 8 of the 10 measured classes can be driven by an invented cell. The likely misses:
  - the two page-action classes (7, 8), which need a page run;
  - the DotNet class (12), which needs the sidecar and a Newtonsoft state that gives this exception.
- **P3, the DO close drop.** After the CLEAN classes are kept, the next DO window's mutant-phase refusal closes on the kept texts
  are 0. Its refusal closes per 1,000 scored mutants fall by at least the share of these 71 closes that the kept texts had.
  - That share is computed from the census and stated in the result file BEFORE the window runs.
  - Its ceiling is 69%.
  - New texts are reported separately.
- **Drift fires** after a newly kept text are counted per text (R1072's false-fire rule).

## What changes in code, only for a CLEAN class
- **A keep-list entry.** Each CLEAN class gets a `PR56_KEPT` entry in `packages/runner/src/al-runner-server.ts`, in PR-93's
  style:
  - exact where one text was measured;
  - a `%SLOT%` only where t12/t13 show variants, and only over measured values: the Evaluate whitespace width, the Integer
    text, the SetFilter BigInteger code.
- **No over-matching.** No pattern may match a text of another class, or a close text that stays out of reach (classes 2, 4,
  10).
- **Pinned tests.** Tests that pin today's closes for these texts are changed on purpose, each change named in the result.
- **A NOT CLEAN class** gets a deny note, and its keep stays off.
- **Checks:** red checks in both directions (a kept entry broken; a slot widened to any text), VERIFY, and the v3 gate on the
  final head.
