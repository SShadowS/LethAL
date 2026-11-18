# PR-159: y1's remaining sibling refusal texts on the serve keep-list (pre-commitment)

Status: r1, committed to master before the census and any keep-list change (coord PR-159, lethal-preproc, 2026-11-18).
Evidence: `/coord/handoff/R-984/y1.run.events.ndjson` (read-only) and `/coord/handoff/PR-159/`.

## 1. The measurement (y1, a fresh DO run on 8ff134f1, before PR-139)
- **The restarts:** 94 daemon closes, of which 71 followed a refusal and 23 a timeout. After-refusal warm-ups total
  2,746 s.
- **The NUL-run Evaluate closes:** 9, at widths 3, 10 (3 times), 12, 14, 30, 37 and 40. **All 9 are inside PR-139's
  widened `NULS` set.**
  - 7 are M28736's live closes, the same requests PR-139's `keepcheck.ts` showed fully kept with the widened widths.
  - 2 are prefetch closes (codeunits 68907 and 68915). A prefetch request's other refused rows cannot be read from the
    events.
  - Their warm-ups total 409 s.
- **The two sibling texts this item keeps:**

| text | closes | warm-up | kept sibling today | where DO reaches it |
|---|---|---|---|---|
| ``RecordRef.GetTable of Integer 12345`` | 1 (prefetch) | 29 s | `RecordRef.GetTable of Integer 123` (PR-133) | `CDO E-Mail Handler.GetLogInfo`: `RecRef.GetTable(VariantRecord)` after its `if not VariantRecord.IsRecord then exit` guard; the 12345 is the test's own Variant (`GetLogInfo_WhenVariantIsNotRecord_ShouldReturnZero`). |
| WriteStartObject at JSON path `message.body.toRecipients[0].emailAddress` | 2 (prefetch) | 111 s | the same text at `message.body.ccRecipients[0].emailAddress` and four other paths (`JSONPATH`, PR-74/93/105) | `CDO Mail Message Builder` through `CDO Json Writer` (`CreateMail_WhenMultipleToRecipients_AddsAllToJson`) |

- **DO's state at both:**
  - an `AutoRollback` test with no handler functions and no TestPage;
  - the called codeunits (`CDO E-Mail Handler`, `CDO Mail Message Builder`, `CDO Json Writer`) hold no `[TryFunction]` and
    no `Commit()`.
  - That is the state PR-133's review measured safe for the `GetTable` keep (a plain call from an AutoRollback test).
- **No direct check on DO:** both closes are prefetch closes. Their mutant ids are only the next mutant scored, which
  PR-139 showed is no attribution, so there is no known mutant to guard. The census cells model the plain state above.

## 2. The change (built after this commit)
1. **A family `y1-refusals`** in `scripts/refusal-family.ts`, with cells:
   - `RecordRef.GetTable` of a Variant holding the Integer 12345, called plainly, as PR-133's 123 cell does;
   - the same through a called procedure that first checks `IsRecord` the way DO's guard does, with the check inverted
     as a mutant would;
   - **a probe of the slot:** `GetTable` of a Variant holding each of 0, 1, -1 and 2147483647. A value whose text has
     the same shape becomes a census class of its own.
   - the JSON writer reaching `WriteStartObject` at path `message.body.toRecipients[0].emailAddress`, built the way
     PR-105's JSONPATH cells are;
   - the same at `message.body.toRecipients[1].emailAddress`, the second To recipient. DO's test sends two.
2. **The census:** `keep-census.ts --family y1-refusals --refusers 7`, on edge-4ebfe7913.
3. **Keep only CLEAN classes, each text by name:**
   - `GetTable`: the measured Integer values join the PR-133 entry as a named slot. The slot is generalised only to the
     values measured; no open integer pattern.
   - `JSONPATH`: gains the measured `toRecipients` paths by name.
4. **Tests:** a pinned test per kept text, near misses (other values and paths, a reworded text, a row that is not
   `notRun`), and the PR-56 class guard if a ledger key matches.
5. **Red checks both ways:** a kept value removed turns its test red; an open pattern turns a near-miss test red.

## 3. Predictions
- **P1:** every `y1-refusals` cell refuses with its exact text, and every class is CLEAN. A class that is not CLEAN is not
  kept, and PR-159 states which.
- **P2 (y1's own events):**
  - the two new keeps cover 3 of y1's 71 refusal closes, 140 s of warm-up;
  - with PR-139's widths, 12 of 94 restarts and 550 s of 4,976 s;
  - P2 counts each close's named text. A prefetch request's other refused rows are unknown, so this is an upper bound.
- **P3 (the next DO window on a head with this change):** 0 closes on a kept text. Any close on a sibling not kept is
  named.
- **The gates:** the al-runner-v3 gate on the final head shows that nothing else moved.
