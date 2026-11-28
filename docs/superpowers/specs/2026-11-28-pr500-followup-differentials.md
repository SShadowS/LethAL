# PR-500: R1236's and R1238's follow-up cells as two generated BC differentials, pre-commitment r1

lethal-preproc, 2026-11-28. Written before code. This is a gap task while bcwin waits; PR-479 comes first, and this work
pauses when bcwin is back.
- **Method:** PR-487, PR-488 and PR-489's (`scripts/refusal-family.ts`). The cells are invented, one test codeunit each.
- **Runs:** al-runner `current` (the pin `.gated` names), and BC 28.4 on one leased gate server (bc1-bc3) under its own
  coord lease.

## Checked first, so nothing is filed twice
- **The roadmap:** R1236 and R1238 (the cells measured so far, and their lists of follow-ups); R1237; R1010 (uncreated
  streams: left out); R995 and R1088; R1210 (the rule for Linux BC code-page answers).
- **Open upstream issues** a cell could meet:
  - #7760, #8091, #7996, #8257;
  - #8088, #8358, #8952, #8448 (XMLport).
- Before filing, the open issues are searched again by the cell's subject. A cell that lands in an open issue is "known",
  never re-filed.

## Family `errors-temp-2` (R1236's follow-ups 2-11; item 1 is measured)
- **The same rules as errors-temp:** each real-table cell counts its own key range and never DeleteAll; booleans and
  numbers go through `Format(x, 0, 9)`.
- **The two kinds of cell that stopped early on both runtimes in errors-temp are re-shaped,** so they reach their target:
  - a write inside a try with the return value UNUSED;
  - Codeunit.Run after a Commit, not after an uncommitted write.
- **The cells, by R1236's follow-up item:**
  - item 2, collectible errors outside the test: `HasCollectedErrors` and its count read through a `Codeunit.Run`
    boundary; `Collect.KeepGoing` returning the count;
  - item 3, TryFunction: a write with the return value unused; a Commit inside a try; a try calling Codeunit.Run;
  - item 4, Codeunit.Run: whether a successful Run clears the last error (re-measured through a Run boundary); a nested
    Run; a Commit inside the target;
  - item 5, ErrorInfo:
    - `ErrorType::Internal`;
    - RecordId, TableId and FieldNo;
    - Title and DetailedMessage through GetCollectedErrors;
    - `.AsInteger()` of the enums;
  - item 6, collect scopes: nested Collect scopes; `GetCollectedErrors(true)`; a collectible error in a try in a Collect
    scope;
  - item 7, asserterror: a Commit inside the asserterror body;
  - item 8, temporary-record triggers:
    - the row after a failing `Insert(true)`;
    - `Modify(false)` and `Delete(false)` of a bad row;
    - `DeleteAll(true)`;
    - Validate and OnRename;
  - item 9, Copy shared: SetRange and Reset on one side, and the other side's filters;
  - item 10, var vs value: a real record to a temporary parameter; a temporary record as a return value;
  - item 11, AutoIncrement: an explicit Id on a temporary table; the next Id after a rolled-back insert on a real table.

## Family `io-streams-2` (R1238's follow-ups and cheap gaps)
- **The same rules as io-streams:** its own key range, no DeleteAll, numbers through format 9. Code-page cells are
  `depends: "locale"` (R1210: a Linux BC answer is filed only if a Windows BC agrees).
- **Byte dumps:**
  - the bytes of `Write('ab')`;
  - the binary bytes of an Integer, a Char, a Boolean, a Decimal and a Date (Write then Read each);
- **ReadText:**
  - its count for UTF-8 `æ` and over CR LF;
  - LF-only and CR-only data;
  - a byte-order mark at the start of a stream being read (UTF-8 and UTF-16 BOMs);
- **Encodings:**
  - UTF-16 read as UTF-8, decoded from a FRESH stream;
  - the code point of UTF-8 `æ` read as UTF-16;
  - UTF-8 read as MSDos (locale);
- **InStream:** Length, Position and ResetPosition;
- **XMLport:**
  - the Xml export's first bytes, and its text read through UTF-16;
  - Xml with `Encoding = UTF8`;
  - VariableText with a TextEncoding;
  - 0 rows;
  - re-importing a UTF-16 export;
  - a comma and a quote in a VariableText value;
- **Temp Blob:** FromRecord and ToRecordRef.

## Expected results, and what is filed
- **Prediction:** most cells equal, as in R1236 and R1238 (131 of 132 equal so far).
- **Filed upstream** (standing yes: bug issues only, one shape, an invented repro, a duplicate search first; kraken is
  told the number): only a cell where the runtimes differ in a way an AL test can observe, and not covered by an open
  issue.
- **Not filed:**
  - error text that differs only by the server's language;
  - a Linux BC code-page answer that a Windows BC does not confirm (R1210);
  - a difference only in the test runner's rendering.
- **The roadmap:** R1236 and R1238 gain the results. A new item is filed for anything that differs and is not filed
  upstream.

## Proof
- **The tests in `refusal-family.test.ts`:** place and ids; distinct cells; no real-table DeleteAll; distinct key ranges;
  every Format checked positively.
- **The emitted apps' hashes** are pinned, as PR-487's are.
- **The red checks,** as PR-487's.
- **The runs:**
  - al-runner `current`: every cell answered, with each refusal named;
  - BC under a lease: uninstalled with its data, unpublished, read back empty; doctor before and after; released healthy.
- **Then:** the join, an Opus review, VERIFY, CI.
