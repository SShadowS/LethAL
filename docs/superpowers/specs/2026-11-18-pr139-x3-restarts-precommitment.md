# PR-139 (R1092): why x3 restarted DO's serve daemon 10 more times than x2, and the safe cut: pre-commitment

Status: r1, committed to master before the census and any keep-list change (coord PR-139, lethal-preproc, 2026-11-18).
Evidence: `/coord/handoff/PR-139/` (`attr.py`, `attr-x3-x2.txt`, `attr-x2-x3.txt`, `probe/`).

## 1. The measurement (x2's and x3's own events, read-only: `/coord/handoff/R-984/x{2,3}.run.events.ndjson`)
x3's after-refusal warm-ups: 27 (1,204 s), against x2's 17 (728 s).

| refusal family | x2 | x3 |
|---|---|---|
| ``Evaluate of `<x>` into Decimal (form not pinned by the corpus)`` | 0 | **9** |
| a list without the new-row line that lost its only row to an action | 0 | 2 |
| an error in a SaveAs of report ..., which has a layout of this kind or an extension | 4 | 5 |
| a parameters string without the XML declaration ..., given to Report.Run... | 6 | 5 |
| SetFilter | 4 | 4 |
| a read of the content of a placeholder Pdf of report ... | 2 | 2 |
| RecordRef.GetTable of Integer N | 1 | 0 |

**By phase:** prefetch 15 -> 16, live 2 -> 11. A live close belongs to one mutant's walk, so it is charged exactly. A
prefetch close is not: a prefetch batch carries many mutants, and the next mutant scored is only a stand-in.

**The live closes, per mutant:**

| x3 mutant | site | live closes | before PR-81 (a walk stopped at its first refusal) | verdict |
|---|---|---|---|---|
| M28736 | `CDOTableFieldArrayMgt.Codeunit.al:338`, remove-assignment | 7, all the Evaluate family | 1 | error either way |
| M17377 | report attach (SaveAs with a layout, then Report parameters) | 3 | 1 (x2: 1) | error either way |
| M17962 | report parameters | 1 | 1 (x2: 1) | error |

- **PR-81's walk-on added 8 live closes (about 350 s), and none changed a verdict.**
- The prefetch closes are flat. The 2 new-row closes and 2 Evaluate prefetch closes come from code x2 never reached: x2
  scored 0 mutants in `CDOTableFieldArrayMgt` (both runs ended on their time budget).

**The Evaluate family, read byte by byte:** every one of x3's 9 texts is a run of NUL characters (code 0) of width 3, 10
(3 times), 12, 14, 30, 37 or 40. It is NOT spaces: a terminal shows NULs as blanks.
- The keep-list already keeps this exact text for widths 4-6 (PR-105, R1103: slot `NULS` = `\x00{4,6}`, entry
  `evaluate-decimal-nul-run`). x3's widths are all outside it.
- How DO reaches it: M28736 removes `CurrentChar := ArrayAsText[CharIndex]`, so every split element becomes a NUL run. It
  then reaches `if not Evaluate(<Integer>, ...)` (`GetTableFieldCaption`) and a bare `Evaluate(<Integer array>[i], ...)`
  (`TextToArray`).
  - Two callers of that path are `[TryFunction]`s (`TryResolveChain`, `TryGetTerminalField`), so DO can reach the
    refusal unwinding through one.
- **Probe on edge-4ebfe7913** (`probe/run1.json`): `if not Evaluate(Integer, <10 NULs>)`, a bare `Evaluate(IntArray[1],
  <10 NULs>)` and `if Evaluate(Decimal, <10 NULs>)` all refuse with the exact text, and so do widths 3 and 40. Width 1
  does not refuse: Evaluate returns false.

## 2. The change (built after this commit)
1. **A family `x3-refusals`** in `scripts/refusal-family.ts`, with one cell per x3 width (3, 10, 12, 14, 30, 37, 40) in DO's
   shape `if not Evaluate(<Integer>, <NULs>)`, plus:
   - a bare `Evaluate(<Integer array element>, <10 NULs>)`;
   - **a TryFunction cell:** the census's standard writes, then a `[TryFunction]` that does the bare Integer Evaluate of
     10 NULs, called as `if not Try...() then`.
2. **The census:** `keep-census.ts --family x3-refusals --refusers 7` under `heavy-slot.sh --peak serve`.
3. **Only if the class is CLEAN, with every cell a refuser of the exact text:** `NULS` becomes `\x00{4,6}` plus the
   measured widths by name: `(?:\x00{3}|\x00{4,6}|\x00{10}|\x00{12}|\x00{14}|\x00{30}|\x00{37}|\x00{40})`. No open range;
   widths 7-9, 11 and others stay unkept.
4. **Not kept,** for the reasons PR-105 and PR-133 give:
   - the SaveAs-with-layout and Report-parameters closes (M17377's 2 extra live closes);
   - the new-row-line text (no invented cell produces it).
5. **Not built:** "defer the restart to the end of the mutant's walk". It is not provably verdict-neutral (a later step
   runs on a daemon whose state after a refusal is unmeasured), and the keep covers 9 of the 10 extra closes.
6. A test file `al-runner-serve-pr139.test.ts` pins each kept width, plus the near misses (widths 1, 2, 7, 11, 41, and a
   NUL run with a space in it).
7. **Red checks both ways:**
   - a kept width removed from the slot turns its test red;
   - an open range (`\x00+`) turns a near-miss test red.

## 3. Predictions (stated before the census and before any DO window)
- **P1:** every `x3-refusals` cell refuses with the exact text (widths as given), the TryFunction cell included, and the
  class is CLEAN. If the TryFunction cell is not CLEAN, no width is widened, and PR-139 closes as measured only.
- **P2:** on x3's own events, the widened entry keeps 9 of the 27 refusal closes: the 7 live closes of M28736 and the 2
  prefetch closes. That is 365.0 s of after-refusal warm-up (the measured warm-ups that followed those 9 closes), of
  x3's 1,204 s and of PR-81's +476 s.
- **P3 (the next DO window on a head with this change):** 0 closes on a NUL-run Evaluate text whose width is kept.
  NUL-run texts of other widths may still close, and each is named in that window's report.
- No verdict may move because of the keep. A gate run shows this: the al-runner-v3 gate, per mutant, on the final head.
