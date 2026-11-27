# PR-487: errors, transactions and temporary records as a generated BC differential — pre-commitment r1

lethal-code, 2026-11-27. Written before code. Method: PR-83/PR-87's (`scripts/refusal-family.ts`).

## r2 (during the build, recorded after the review; overrides r1 where they differ)

- **No DeleteAll.** Cells count their OWN key range instead. A DeleteAll is a write, and a write before `Codeunit.Run`'s
  return value is used changes what BC does.
- **Two cells DO Commit:** asserterror after a Commit, and Codeunit.Run after a Commit.
  - Precedent: Y2_XML's cells committed on bc2. The standing yes covers invented probes on a leased server; PR-200's
    breakage came from creating a company.
  - Their rows stay committed, so the app is re-run only after uninstalling it with its data.
- The result, and what the cells do not reach, are in R1236.

## The family `errors-temp`
- **Where:** appended to FAMILIES (BC-check number 29). Cell i is codeunit 51001+i, `TestPermissions = Disabled`.
- **Support objects:**
  - tables at 51000-51002: a plain row; an AutoIncrement row; a row whose OnInsert and OnModify raise when `Val = 'BAD'`;
  - support codeunits after the last cell id (`extraIds`): a helper with TryFunctions, Collect procedures and a by-var /
    by-value pair; a codeunit whose OnRun inserts and errors; one whose OnRun inserts.
- **Each cell:**
  - makes its calls, then reports through `Error('V:[...]')`;
  - or fails with the runtime's own error, which is then the answer;
  - starts with `DeleteAll` on the tables it counts, so a BC server that keeps rows between tests gives the same counts.
- **Groups (about 50 cells):**
  - TryFunction: the return value; the error propagating when the return value is unused; writes inside a try;
    GetLastErrorText, GetLastErrorCode and the call stack's presence; ClearLastError;
  - Codeunit.Run: the return value, rollback, the last error, and Run-with-return after a write in the same transaction;
  - asserterror: its rollback of writes inside and before it; "no error";
  - ErrorInfo: Message, DetailedMessage, Title, Collectible, ErrorType and Verbosity defaults;
  - collectible errors: HasCollectedErrors, GetCollectedErrors, ClearCollectedErrors, a non-collectible error inside a
    Collect scope, a collectible ErrorInfo outside one, collected errors left at the scope's end;
  - errors in OnInsert/OnModify of a temporary record, with and without RunTrigger;
  - temporary records: Copy shared vs not, Reset, a filtered DeleteAll, IsTemporary, by var vs by value, AutoIncrement
    on a temporary vs a real table, a duplicate key, Clear on one side of a shared copy.

## Left out, stated
- **Commit:** no cell commits. A commit in a test on a shared gate server needs the owner's say-so (memory: PR-200's T3
  broke bc4). So "asserterror after Commit" is not measured here; a separate ask can add it.
- **Raw ids and call-stack text:** AutoIncrement ids on a real table are reported as the difference between two inserts.
  A call stack is reported only as "non-empty".

## Runs and compare
- al-runner `current` (edge-e5176a9fd) via the script.
- The BC-check app on a leased bc1-bc3 (BC 28.4, BC on Linux); cleaned up after, doctor before and after.
- `--join` per cell.
- **A class where al-runner differs** (a wrong answer or a refusal) is filed upstream, one issue per class, under the
  standing yes. Culture cells are not filed; this family is not expected to have any.
- **An R item records the tally.**

## Tests
- The family's cell count, its ids and support ids.
- The emitted app's hash pinned in `pr363-legc-keep-apps.test.ts`.
- One red check each for the cell count and the hash pin.
