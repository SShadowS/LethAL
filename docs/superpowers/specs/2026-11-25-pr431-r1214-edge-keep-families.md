# PR-431 pre-commitment v2 (R1214): keep rows for edge's new daemon-closing refusal families

Written 2026-11-25, before any DO check or build.
- **v2** folds in the spec reviews (`/coord/handoff/PR-431/spec-review.md`).
  - Two spec-adversary runs each stopped early on a denied command of their own; both slips are recorded there.
  - Their findings, plus my own reading of upstream's session setup, are taken below. Each change is marked "(v2)".
- **Measured first,** offline, from c5's events and store (`/coord/handoff/PR-422/c5`; full DO, edge-e5176a9fd, master
  032083085): `/coord/handoff/PR-431/lines.py` -> `lines.txt`.
- DO's own values and names stay under /coord. This spec names BaseApp tables and invented values only.

## Why
On c5, refusal restarts stay at 56, against PR-411's predicted fall of at least 24. Two families new on edge close daemons
(R1214):
- **A** (13 closes): `SetRange or SetFilter of <Code|Text> '<value>' into a <BigInteger|Integer> field in a shape no cell
  measures (assumption setrange-other-type-convert)`.
- **B** (11 closes): upstream #8801's restamped rows (`al-vm/src/records/restamped.rs`).
  - `SystemRowVersion of a row of <table> that the open transaction inserted before a row version sent ahead of it: BC
    gives the row its row version when it sends it, this runtime the Insert's` (four BaseApp tables);
  - `a find filtered or sorted on SystemRowVersion of a table (<table>) with rows the open transaction inserted before a row
    version sent ahead of them: …` (one table).

## The real lines (`lines.txt`)
- **A: 5 distinct texts on c5.**
  - Code values: two project setup codes (6 and 3 closes).
  - Text values: two random 20-letter test strings (2 and 1) and the empty text (1).
  - The store holds A rows under 7 mutants (incl. PR-408's `GL00000000` value), in test codeunits 68911, 68967, 68979
    and 68916. None is at baseline.
- **B: 5 distinct texts:** four tables (Service Invoice Header 5, Dimension Set Entry 3, Sales Invoice Header 1, Default
  Dimension 1), and the find form once (Sales Invoice Header).
  - The store holds B rows under 3 mutants in 68963. The other B closes (test codeunits 68936, 69008, 68916) refused in
    tests whose rows decide no verdict, so the census finds their mutants.
  - None is at baseline.

## The design question each family raises
- **A's values are test data, and some are random per run.** An exact row per value cannot follow them. So each row carries
  a bounded VALUE slot:
  - `%CONVCODE%` = `[A-Z0-9]{1,15}` for Code into BigInteger. The longest Code seen is 10; the house rule is the longest
    plus about 50% (v2).
  - `%CONVTEXT%` = `(?:=18|1=18|[A-Z]{0,20})` for Text into Integer. The random test strings are always 20 letters, so the
    bound is exactly the measured one, not 30 (v2).
  - Anything else still closes.
  - The new slots do not overlap the existing ones (review, lead 3): `%BIGCODE%` and `%INTTEXT%` serve other texts
    (`SetFilter: \`…\` is not a BigInteger`, `conversion of Text '…' to Integer`).
  - **PR-408's two exact rows and PR-419's one** are values these slots cover, so they are REPLACED by the two slotted rows.
    One home per text; a line must be kept by exactly one entry. Their tests and the PR-361 and PR-363 guards move to the new
    names, with the same real lines.
- **B's texts come from session state, and here is where it lives (v2, read at e5176a9fd).**
  - `restamped_rows` is a field of `Session`.
  - Every codeunit run builds a NEW session from the install baseline: `run_codeunit_inner` calls `new_session`, which calls
    `session_from`, which calls `Session::with_host` and then `restore_baseline` (`al-testrun/src/runtime/run.rs`).
  - `restore_baseline` overwrites `restamped_rows` from the baseline (`al-vm/src/baseline.rs`).
  - So a note cannot cross from one codeunit run to the next on a kept daemon, except through a baseline that already holds
    restamped rows. c5's baseline holds none: no B line is at baseline.
  - The lane's moved single instances (`LANE_SINGLES`) carry no restamped rows.
  - **The DO check still measures it:** the NONE request after a refusing mutant, and the NONE entry after it in the same
    request, must equal fresh.
  - Separately, install code's notes are dropped by `restore_install_left` (`install_left.rs` destructures
    `restamped_rows: _`). That means fewer refusals, not more, and is recorded in R1214.
  - B's rows carry a table-name slot, `%ROWVERTABLE%` = `[A-Z][A-Za-z0-9 .-]{1,40}`. The four BaseApp names seen and
    invented ones fit it.
  - The field-name part is fixed to `SystemRowVersion`: an SQLTimestamp field's text still closes.
- **Not kept:** the `a query on SystemRowVersion …` form (never seen on DO), and every other text.

## The rows (`PR56_KEPT`)
- `setrange-code-to-biginteger`: `SetRange or SetFilter of Code '%CONVCODE%' into a BigInteger field in a shape no cell
  measures (assumption setrange-other-type-convert)`;
- `setrange-text-to-integer`: the same, with `Text '%CONVTEXT%' into a Integer field`;
- `rowversion-restamped-read`: `SystemRowVersion of a row of %ROWVERTABLE% that the open transaction inserted before a row
  version sent ahead of it: BC gives the row its row version when it sends it, this runtime the Insert's`;
- `rowversion-restamped-find`: `a find filtered or sorted on SystemRowVersion of a table (%ROWVERTABLE%) with rows the open
  transaction inserted before a row version sent ahead of them: BC gives them their row version when it sends them, this
  runtime the Insert's`.
- **Removed (covered by the slots):** `setrange-code-gl-to-biginteger`, `setrange-text-eq18-to-integer`,
  `setrange-text-1eq18-to-integer`.

## The DO check (PR-411's kit, `/coord/handoff/PR-431/keepcheck/`; edge-e5176a9fd pinned; c5's isolation, `test`)
- **The refusing mutants.**
  - **A:** the store names 7 refusing mutants, which is enough. No census.
  - **B:** the store names 3, all in 68963. So a census runs where the store names none: test codeunits 68936, 69008 and
    68916.
    - Each codeunit's whole entry runs on ONE daemon, under every c5 mutant covered by the test that refused there (484,
      1,304 and 484), then under NONE.
    - Each request whose rows carry a B text is a refusing mutant.
- **A floor PER ROW (v2, review: one per family was too weak).** Each of the four rows lands only if its own text is seen
  under at least one refusing mutant in the kept run.
  - In particular, `rowversion-restamped-find` (one close in c5) does not land if no census request reproduces it.
  - A row whose text was never exercised is never kept.
- **Plan A** (across requests, kept vs fresh) and **Plan A2** (`[refusing entry, NONE]` in one request), per family and per
  codeunit. Up to 8 refusing mutants per codeunit, spread across the census.
- **The guards are as in PR-411:**
  - equal request counts;
  - rows equal to each entry's test count;
  - no ERROR row;
  - one pid in the kept run;
  - the positive control: the family's line under each refusing mutant;
  - the planted-difference self-test.
- **B's crossing check, by name:**
  - every NONE row after a B refusal equals fresh, in Plan A's next request and in A2's second entry;
  - any difference blocks B.
- **The verdict:** a family whose A and A2 are equal and whose guards hold lands its rows. Any other result blocks that
  family, and is filed in R1214.

## Leg C (PR-363's keep cases; the gate runs on `current`, edge-e5176a9fd)
- **A new invented family, `edge-refusals`** (`scripts/refusal-family.ts`), whose cells produce:
  - SetRange of a Code value of another shape (`ABCDE1`) into a BigInteger field, and SetFilter of the same (v2: the text
    says "SetRange or SetFilter", so both paths get a cell);
  - SetRange of a 20-letter Text (`QWERTYUIOPASDFGHJKLZ`, the measured width) and of an empty Text into an Integer field,
    and SetFilter of the 20-letter Text;
  - the restamped read: insert a row of invented table A, then insert and Get a row of invented table B, then Get the A row
    and read its SystemRowVersion (upstream's own `InsertTwoTables` shape);
  - the restamped find: the same, then a SetCurrentKey on SystemRowVersion and a FindFirst on A.
- **KEEP_SELECTIONS** gains one case per new row; the t10/t12 cases move to the new names.
  - The gate's pinned counts move by exactly these, pre-committed: the app family count +1, the keep cases +4 (one per
    row; the extra cells above are in the family app but judge the same rows), and PR-363's pinned map loses the three
    removed names.
  - **Each new case must read `kept` on `current`, or the row does not land.**
  - Each family cell runs once by hand before the gate (the smoke-test rule).

## Predictions for the next full DO run on edge with the rows (c5's settings)
- **0 daemon closes** on the four rows' texts (c5 had 24: A 13, B 11).
- **Refusal restarts fall from 56 to at most 32** (56 - 24).
- **No verdict moves against c5 except by a named cause** (compare-c5's classes). A gained kill is a BLOCK unless explained
  one by one.

## Checks
- Red tests both ways (each row removed; each slot widened past its class).
- VERIFY.
- The v3 gate (leg C and PR-363's map).
- CI.

## Amendment 1 (2026-11-25, after the DO checks and the build review; no prediction or count changes)
- **The t10/t12 leg C cases do NOT move to the new names.**
  - Their entries (`code-gl-to-biginteger`, `conversion-text-to-integer`) still exist for builds with the old wording, and need
    a case. Entry names in KEEP_SELECTIONS must also be unique, and the four new names are judged by `edge-refusals`' cases.
  - So the t10/t12 cases keep their old entries. On `current` they read MOVED under the new rows, a warning, as since PR-408.
  - The pinned counts are as pre-committed: +1 family app, +4 cases, and PR-363's map loses the three removed names.
- **A MOVED on an `edge-refusals` case would look the same to the gate** (build review LOW 1), since both are a warn. So the
  v3 gate's `serve-keep-reasons` measured text is read by hand: no `edge-refusals ... MOVED` may appear, or the row does not
  land.
- **The Text cells reach the Integer field through the key** (`KeyIndex(1).FieldIndex(2)`). Measured on edge: a plain
  `Field(n)` only fails with an Evaluate error, which is not the row's text.
