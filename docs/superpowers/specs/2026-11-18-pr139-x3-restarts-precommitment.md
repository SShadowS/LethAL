# PR-139 (R1092): why x3 restarted DO's serve daemon 10 more times than x2, and the safe cut: pre-commitment

Status: r2, committed to master before the census and any keep-list change (coord PR-139, lethal-preproc, 2026-11-18).
r2 answers the opus spec-adversary's review of r1 (§0). Evidence: `/coord/handoff/PR-139/` (`attr.py`, `attr-x3-x2.txt`,
`attr-x2-x3.txt`, `probe/`).

## 0. The review of r1 (opus spec-adversary), finding by finding
The review checked §1's figures and found them right:
- the 9 closes (seq 39402 and 39452 prefetch; 39490-39523 live), their widths and the 365.0 s;
- that no verdict changed;
- that DO runs under isolation "test", with no BindSubscription in the 9 test codeunits.

- **H1 (high): the planned cells do not cover DO's states at the refusal.**
  - Six of the 9 tests reach it deeper than a plain TryFunction:
    - a TestPage with four modal handlers (`U_FieldPickerHopIntoAnUnpinnableKey_TakesTheValueTyped`);
    - a table's `OnInsert` mid-Insert (`VariantEntry_Insert_CreatesRecord`);
    - a SingleInstance cache mid-update (`GetTerminalFieldCached`).
  - There are more TryFunction callers than r1 named: `TryEvaluateChain`, `TryEvaluateIntoField`,
    `TryCanonicalizeTypedValue`.
  - **Why it matters:** the drift guard (`keptRefusalDrift`) compares only rows before the first covering test. So a
    dirty kept daemon could score a later covering test's failure as a kill, unchecked.
  - **Fixed: a direct check on DO itself is now a condition of the keep (§2 step 3),** PR-134's method (`drive.ts`, the
    guarded `do-cloud-guard` copy). It covers every DO state at once.
  - The census stays as the class proof, with two state cells added (§2 step 1).
- **M2 (medium): no prediction could catch a moved verdict.**
  - P2 replays x3's texts against a regex built from them, and P3 follows from the regex.
  - No gate fixture produces this text, so the v3 gate proves nothing for this keep.
  - **Fixed:** P4 is added (§3). The v3 gate stays only as "nothing else moved".
- **L3: the census judges 7 classes,** one per width (`classOf` splits on `": "`; the text has no colon). **Fixed in P1:**
  - all 7 classes must be CLEAN;
  - the width-10 class's refusers must name the array cell and the TryFunction cell;
  - each of those must refuse at least once under serve, so a Try that swallows the refusal cannot drop out unseen.
- **L4: the same text from other target types.** The text says "into Decimal" for an Integer target, and
  `TryEvaluateIntoField` evaluates into Date, DateTime, Time, Decimal, Integer, BigInteger, Boolean and Duration.
  **Fixed (§2 step 0):** a probe of a NUL run into each type. Every type that gives the exact text gets a census cell,
  in its own class if its text differs.
- **L5: widths by name** stay, in the safe direction. The census and every check name the build: edge-4ebfe7913, the
  pinned `current`, which is the build x3 ran on.

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

## 2. The change (built after this commit, in this order; each step gates the next)
0. **The target-type probe (L4):** a NUL run of width 10 into Date, DateTime, Time, Decimal, Integer, BigInteger, Boolean
   and Duration (`probe/`). Each type that gives this exact text gets a census cell in step 1. A type with another text
   is named and left unkept.
1. **A family `x3-refusals`** in `scripts/refusal-family.ts`, with:
   - one cell per x3 width (3, 10, 12, 14, 30, 37, 40) in DO's shape `if not Evaluate(<Integer>, <NULs>)`;
   - a bare `Evaluate(<Integer array element>, <10 NULs>)`;
   - **a TryFunction cell:** the census's standard writes, then a `[TryFunction]` that does the bare Integer Evaluate of
     10 NULs, called as `if not Try...() then`;
   - **(H1) a nested-state cell,** modelled on `X2_REFUSALS`' `Page.NestedValidate` with the Evaluate in place of the
     SetFilter: a TestPage whose action runs a modal page, whose ModalPageHandler invokes the wizard's action, which
     calls a TryFunction that validates a field whose `OnValidate` does the NUL Evaluate;
   - **(H1) an OnInsert cell:** the Evaluate runs in a table's `OnInsert` during `Insert()`, after writes to a
     SingleInstance codeunit's Dictionary;
   - a cell per extra target type from step 0.
2. **The census:** `keep-census.ts --family x3-refusals --refusers 7` under `heavy-slot.sh --peak serve`, on
   edge-4ebfe7913.
3. **(H1) The direct check on DO** (PR-134's method: `drive.ts` over a guarded copy of DO, with M28736's mutation applied
   behind its guard):
   - drive the 7 test codeunits that closed the daemon live in x3 (68936, 68975, 68916, 68973, 68984, 68972, 68985),
     then M28736's remaining plan;
   - **arm K:** one daemon kept through every NUL refusal (the widened keep in a local build);
   - **arm F:** a fresh daemon after each refusal (today's behaviour).
   - **Every row of every test must be equal** between K and F, refused rows included. Any difference stops the keep.
4. **Only if step 2's 7 classes are all CLEAN (P1) AND step 3's rows are equal:** `NULS` becomes `\x00{4,6}` plus the
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
- **P1:** every `x3-refusals` cell refuses with the exact text for its width, and all 7 width classes (plus any type
  class from step 0) are CLEAN.
  - The width-10 class's `refusers` names the array cell, the TryFunction cell, the nested-state cell and the OnInsert
    cell, and each refused at least once under serve.
  - If any of that fails, no width is widened, and PR-139 closes as measured only.
- **P1b (H1):** step 3's arms K and F give equal rows for every test of the 7 codeunits and of M28736's plan.
- **P2:** on x3's own events, the widened entry keeps 9 of the 27 refusal closes: the 7 live closes of M28736 and the 2
  prefetch closes. That is 365.0 s of after-refusal warm-up (the measured warm-ups that followed those 9 closes), of
  x3's 1,204 s and of PR-81's +476 s.
- **P3 (the next DO window on a head with this change):** 0 closes on a NUL-run Evaluate text whose width is kept.
  NUL-run texts of other widths may still close, and each is named in that window's report.
- **P4 (M2; the next DO window on a head with this change, compared by site with x3):**
  - M28736 stays `error`, with the same set of refused tests;
  - every mutant scored on a lane between a kept NUL refusal and that lane's next daemon close has its x3 verdict. Any
    difference is re-run on a fresh daemon before the window is accepted;
  - every `serve-drift-after-kept-refusal` event after a NUL text is named and explained.
- P2 and P3 count time saved; they cannot catch an unsafe keep. P1b and P4 can.
- **The al-runner-v3 gate** on the final head shows only that nothing else moved: no gate fixture produces this text.
