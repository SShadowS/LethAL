# PR-133 (R1092): what still restarts DO's serve daemon (x2): pre-commitment

Status: r2, committed to master before the census and any keep-list change (coord PR-133, lethal-preproc, 2026-11-17). r2
answers the spec-adversary's review of r1 (§0). Evidence: `/coord/handoff/PR-133/`.

## 0. The review of r1 (opus spec-adversary), finding by finding
- **H1 (high): DO reached the RunRequestPage refusal INSIDE an open write transaction.** 4 of the 6 closes are a test that
  asserts it is in a write transaction (AutoRollback, no request-page handler, a BaseApp report). r1's "every occurrence
  is outside a write transaction" was wrong. It held only for the probe's state (default transaction model, a handler, a
  report with no code).
  - **Fixed: the RunRequestPage keep is dropped.**
- **H2 (high):** that keep would have covered every report, but nothing measured whether report code (triggers, request
  page, subscribers, the handler) runs before the refusal. The same reasoning that keeps SaveAs out applies here. Dropped
  with H1.
- **M3:** the census writes first (`State.DoWrites()`), so a "no write" cell cannot be measured. Moot: the RunRequestPage
  cells are dropped.
- **M4: the drift reading was wrong.** The drift check compares only rows that cannot differ under the mutant: a NONE
  entry, or tests before the first covering test. So the drift is not a mutant effect.
  - It is possible evidence against the existing `RecordRef.Duplicate` keep, or a test whose answer varies.
  - The events do not record the fresh re-run's rows (seq 33896 raised no second drift).
  - Filed as a roadmap item for a direct check (§5).
- **L5:** one SaveAs tail is an error label from DO's test source. The P2 test uses invented tails, or BC's own platform
  tail, never DO's.
- **L6:** the slot holds the regex-escaped `C\*` (in TypeScript `String.raw`). The near misses include an empty value,
  `` `C` `` and `` `CC` ``.

## 0b. Amendment 1, before a second census (the opus review of the built keep, 36bee8e3)
- **The GetTable keep:** safe. DO reaches it as a plain call from an AutoRollback test: no writes, no handler, no
  TryFunction. That is the census cell's state.
- **The `C*` keep (medium):** DO reaches it in a deeper state than the cell measured. The refusal unwinds through a
  `[TryFunction]`, the field's `OnValidate`, two nested `ModalPageHandler`s and an open TestPage, with uncommitted writes.
  No census cell has ever measured a refusal that unwinds through a TryFunction.
- **So, before `C*` ships,** the family gets one more cell in that shape:
  - the standard writes;
  - a TestPage on an invented card page;
  - an action opens an invented wizard page modally;
  - a `ModalPageHandler` invokes the wizard's action;
  - the action calls a `[TryFunction]`, which validates a BigInteger field whose `OnValidate` does `SetFilter(..., 'C*')`.
- **Then the census runs again** (`--refusers 7`).
  - **P1':** the new cell refuses with the exact text, and the class stays CLEAN with both cells as refusers. Only then
    is `C*` kept.
  - If the cell does not refuse with that text, or the class is not CLEAN, `C*` is removed from BIGCODE, and this PR
    ships the GetTable keep alone. P3 then falls to 27.1 s.
- **The "not kept" comment for RunRequestPage** is corrected to the real distinction: no request-page handler in DO, a
  BaseApp report, and report code that may run before the refusal, unmeasured.

## 1. The measurement (x2's own events, read-only: `/coord/handoff/R-984/x2.run.events.ndjson`)
x2 closed its daemon 26 times. Each warm-up's own `cause` field accounts for all 1,202.8 s of warm-up compile:

| cause | warm-ups | compile | wall |
|---|---|---|---|
| after a refusal close | 17 | 636.7 s | 728.3 s |
| after a timeout cut | 8 | 410.0 s | 529.4 s |
| first start (unavoidable) | 3 | 111.0 s | 168.6 s |
| after a kept-refusal drift (a safety close) | 1 | 43.7 s | 52.8 s |
| lazy-prove (R1092 lever 2; nearly no compile) | 64 | 1.3 s | 263.4 s |

| refusal family | closes | compile | kept today? | invented cell (probe, edge-4ebfe7913) |
|---|---|---|---|---|
| `a parameters string without the XML declaration in this form, given to Report.RunRequestPage ...` | 6 | 272.8 s | no (PR-74 H1) | the text, but not in DO's state (H1) |
| ``SetFilter: `C*` is not a BigInteger`` | 4 | 137.9 s | the entry exists; `C*` was never measured | the exact text |
| `an error in a SaveAs of report "<x>", which has a layout of this kind or an extension ...: <message>` | 4 | 144.3 s | no | the shape, with an invented Word-layout report |
| `a read of the content of a placeholder Pdf of report Standard Sales - Invoice (...)` | 2 | 54.6 s | no | the shape, with an invented report |
| `RecordRef.GetTable of Integer 123` | 1 | 27.1 s | no (only `Text 'Not a record'`) | the exact text |

## 2. The change (built after this commit)
1. A family `x2-refusals` in `scripts/refusal-family.ts` with two cells:
   - `SetFilter` of `C*` on a BigInteger field;
   - `RecordRef.GetTable` of a Variant holding the Integer 123.
2. **The census:** `keep-census.ts --family x2-refusals --refusers 7` under `heavy-slot.sh --peak serve`.
3. **Keep only these, and only if their class is CLEAN** (anchored, the measured texts only):
   - `BIGCODE` gains the escaped `C\*`;
   - a new entry for `RecordRef.GetTable of Integer 123`.
4. **Not kept:**
   - **RunRequestPage** (H1, H2). It needs a census cell in DO's state: AutoRollback, writes with no Commit, no handler.
     It also needs a sentinel probe (an error in OnInitReport, in the request page's OnOpenPage, in the handler and in a
     report-event subscriber) showing that nothing runs before the refusal. Then a new pre-commitment.
   - **SaveAs with a layout, and the placeholder PDF:** they need BaseApp's own reports (after #8191's fix in `current`).
5. Tests pin each kept text and its near misses, in a PR-93-style test file.
6. Red checks both ways: a kept entry broken goes red; the slot widened (an unescaped `C*`) goes red.

## 3. Predictions
- **P1:** both classes census CLEAN, with every distinct text a measured refuser.
- **P2:** the keep entries match x2's exact close texts for those two families (5 of the 17 refusal closes), and none of
  the other twelve. The unit test uses x2's texts for the two kept families (public-safe) and invented tails for the
  others.
- **P3** (stated now, judged on the next fresh DO window, not here): 0 refusal closes on the two families. That saves
  about 165.0 s of warm-up compile per x2-sized window (wall about 197 s), 26% of x2's refusal warm-up compile.
- **The v3 gate** (`itest:alrunner-v3`, full) passes unchanged.

## 4. The other causes: the lever, named (no change here)
- **RunRequestPage:** 6 closes, 272.8 s. Needs the DO-state census and the sentinel probe (§2.4), then its own
  pre-commitment.
- **Timeout cuts:** 8 closes, 410.0 s. A cut request must kill the daemon. The lever is upstream #8143 (keep the compiled
  workspace in the disk cache).
- **SaveAs with a layout, and the placeholder PDF:** 6 closes, 198.9 s. They wait for BaseApp's reports.
- **The kept-refusal drift:** 1 close, 43.7 s. A safety close; see §5.
- **Lazy-prove:** 64 warm-ups, 263.4 s of wall time. R1092 lever 2, waiting on owner question
  q-20261116T214008-a938ded5.

## 5. Filed
A roadmap item: x2's kept-refusal drift after `RecordRef.Duplicate` (a fail -> pass on a test the mutant cannot reach) may
be evidence against that keep. The check: re-run the drifting request's codeunits on a daemon kept after the refusal, and
on a fresh one.
