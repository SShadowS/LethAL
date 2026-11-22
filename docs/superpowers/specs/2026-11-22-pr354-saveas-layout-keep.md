# PR-354 pre-commitment: keep the v3 serve daemon after the SaveAs-with-layout refusal (R1184)

lethal-code, 2026-11-22. **The ruling:** the orchestrator, after R1183's attribution (PR-350).
- One refusal family caused 89 of c2's 146 refusal restarts: about 3,100 s of compile, 5.5% of lane time.
- The entry lands only after a direct kept-vs-fresh check on DO.

## The family, measured (`/coord/handoff/PR-354/census.txt`, `texts.txt`; c2 and t1's stores)
Every row of the family has this one shape (164 rows: 105 in c2, 59 in t1), with exactly two report names and five inner
errors:

`NotRun: out-of-scope: an error in a SaveAs of report "<REPORT>", which has a layout of this kind or an extension
(whether SaveAs raises it or answers false is not pinned): <INNER>`

| REPORT | INNER | c2 | t1 |
|---|---|---|---|
| Standard Statement | `Start Date must have a value.` | 60 | 24 |
| Standard Sales - Invoice | `Tests cannot call the Commit function if TransactionModel property is set to AutoRollback.` | 22 | 22 |
| Standard Statement | `End Date must have a value.` | 16 | 0 |
| Standard Statement | `The payment reference must be unique. Payment reference <15 digits> already exists.` | 4 | 8 |
| Standard Statement | `Start date must be earlier than End date.` | 3 | 5 |

(These are Microsoft's BaseApp report names and BaseApp error texts.)

## 1. The entry (al-runner-server.ts, `PR56_KEPT`, one row: `saveas-layout-error`)
- **Exact, in PR-56's style.** Two new slots, each listing its measured values by name, with no open pattern:
  - `SAVEASREPORT`: `(?:Standard Statement|Standard Sales - Invoice)`;
  - `SAVEASERR`: the five inner texts above, each escaped. The payment one has `\d{15}` for the reference, and nothing
    else varies.
- **Kept only as a `notRun` `error` row,** as every keep entry is (`serveDaemonReusable`).
- **Not kept:**
  - another report name, or another inner error;
  - a tail, a truncation, or a changed word;
  - the same text on a plain fail row.
- **Not in leg C,** as PR-56's entries are not.
- **Behind no flag:** a keep entry is a closing rule, and this one waits for its check.

## 2. Tests (red-going, both ways; a new file `pr354-saveas-keep.test.ts`, modelled on `pr217-company-keep.test.ts`)
1. Each of the five measured texts is kept, with each measured report where it occurred. Red if the entry is removed.
2. Nothing looser closes:
   - another report name;
   - another inner error (`Posting Date must have a value.`);
   - a 14- or 16-digit payment reference;
   - a tail, a dropped end, a changed word, a trailing newline;
   - a `notRun: false` row.
   Red if a slot is widened to an open pattern.
3. The drift guard and PR-56's pinned tests still pass with the new row (al-runner-serve-pr56 and its JSON). If the JSON
   pins the entry count, the row is added there with this file's census as its source.

## 3. The check before landing (when the box frees; not before PR-330's end)
- **The kit:** PR-217's kept-vs-fresh kit (`/coord/handoff/PR-217/keepcheck/check.ts`), copied by Write into
  `/coord/handoff/PR-354/keepcheck/`.
- **The build:** `current` at the time, recorded, on DO's instrumented build (c2's settings).
- **The plan:** for each of the five texts, up to 2 c2 or t1 mutants whose request refused with it (fewest codeunits first),
  so up to 10 requests, each followed by a request with no mutant over the same codeunits.
- **KEPT:** every request, in order, to ONE daemon running with the entry, so the daemon is kept through each refusal.
  **FRESH:** each request to its own new daemon.
- **The claim:** every row (name, status, message) of every request is equal, kept against fresh, with 0 differences. The
  no-mutant request after each refusal is the one that would show leftover state, the payment-reference case in
  particular.
- **The self-test:** a planted difference in one row must be caught by the compare, or the check is void.
- **Any difference:** the entry does not land. The texts that differ are named, and the rest are re-planned without them
  (an amendment).

## 4. Landing, after the check passes
- the full v3 gate: no figure moves, since no gate fixture meets this refusal;
- CI;
- then the next full-DO run must show refusal restarts down by about this family's share. Verdicts and `killingTest` are
  equal per mutant against the run before, as the hard claim for that run (R1183's follow-up, not this PR's).
