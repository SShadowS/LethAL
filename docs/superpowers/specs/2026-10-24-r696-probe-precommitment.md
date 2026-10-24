# R-696: probe pre-commitment (does Next see rows moved or inserted ahead of the cursor?)

Written before the probe runs. The measurement and the ruling review are in `/coord/handoff/R-696/`.

## Why the probe

Four rows were read as able to walk forever under one mutant. All are in BaseApp:
- `RenumberDocNoOnLines` in Gen. Journal Line, Item Journal Line and Job Journal Line;
- report Resend Attachments.

One more row is a candidate: report Update Contract Prices.

Each of these moves a walked row ahead of the cursor, through a SECOND variable or by inserting a copy. So each is
endless only if `Next` returns rows that moved or arrived ahead of the cursor after the find that started the walk.
That is a BC fact, so we measure it rather than reason about it.

## The probe

It runs on bc2, under a coord lease. The AL is invented, with ids 91500 and up. The app is uninstalled afterwards.
- **Table** "R696 Probe": `Id` Integer (the primary key), `Grp` Integer and `SortKey` Integer, with `key(SK; Grp, SortKey)`.
- **Rows:** N rows, Id 1..N, Grp 1, SortKey = Id*10. N is 3, 60, 1000 and 5000. The rows are re-seeded before every
  run.
- **Cap:** every loop stops at 3N+10 visits and records CAPPED. The probe can never hang the server.
- **Every walk leg** uses `SetCurrentKey(Grp, SortKey)` and `SetRange(Grp, 1)`. It is run three times, once each with
  `FindSet()`, `FindSet(true)` and `Find('-')`, and loops until `R.Next() = 0`.
  - **L1, second variable:** `R2.Get(R.Id); R2.SortKey += 1000000; R2.Modify()`.
  - **L2, own variable, large push:** `R.SortKey += 1000000; R.Modify()`.
  - **L2b, own variable, small push:** `R.SortKey += 15; R.Modify()`. Log the first 20 Ids visited.
  - **L3, insert:** insert a copy with Id = max+1, Grp 1, SortKey = the current max + 10.
  - **L4, report data item:** a ProcessingOnly report with `DataItemTableView = sorting(Grp, SortKey)
    where(Grp = const(1))`. Its OnAfterGetRecord does the L1 move and counts, with `CurrReport.Break` at the cap. It is
    run with `Report.Run(.., false)`. There is also an **L4-insert** variant that does the L3 insert.
- **Counted, per leg × find method × N:** visits, distinct Ids, and the most visits to one Id.

## What each outcome means (committed now)

**Forever.** Any L1, L3, L4 or L4-insert cell is CAPPED, or has more than N visits, at any N.
- `Next` sees rows that moved or arrived ahead of the cursor.
- The four rows above are forever under one statement-removing mutant: removing the `exit`, or the `Skip`.
- Update Contract Prices is hang-equivalent under `void-method-call` on its OnPreDataItem `SetFilter`.
- R696 gets a fail-closed refusal.
- If it happens only above some N, it still counts.

**Finite.** Every L1, L3, L4 and L4-insert cell has exactly N visits.
- The five rows are finite.
- R696 closes by ruling, keeping its stated limits.

**Own-variable legs.** If L2 or L2b visits the same Id twice, the shipped CDC Approval Group `SetPriority` code would be
contradicted. The probe itself is checked first, then the own-variable rows are read again.
