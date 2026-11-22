# PR-329 pre-commitment (draft v2): R1173's real fix, a SingleInstance mutant's covering codeunits as ONE al-runner `strictOrder` lane

Coord PR-329 (lethal-code, 2026-11-22). GitHub #53, part (b). **MEASURE FIRST.** Step 0 decides whether the design is
buildable at all. v2 folds in an Opus spec-adversary review of v1 (`/coord/handoff/PR-329/spec-review.md`): five blocking
findings on the design and four gaps in step 0.

## What is known (measured)
- **v3 today:** each covering test codeunit is a fresh entry; LethAL's contract requires `batch-no-cross-singleinstance`.
  On PR-327's #53 probe the `EndIt` leak mutants SURVIVE on v3; bcdev kills all three.
- **al-runner's `strictOrder` lane** (leg-C fact `batch-lane-strict-reruns`, measured at every pin): in ONE batch entry
  (the complement in `excludeTests`) with `strictOrder: true`, a reader the lane hints at is re-run.
  - The first row is fresh and FAILS; the second carries the state and passes.
  - **NOT shown by that fact:** whether a reader whose fresh row PASSES is re-run.

## Step 0: measure (each case recorded raw; the design is dead or alive on these)
The measurement prototype (`LETHAL_V3_LANE_DUMP`) sends, for each tagged survivor, ONE batch-shaped `strictOrder`
request of its covering codeunits in the no-ledger codeunit order, twice: with the mutant active and with none. It
changes no verdict.

1. **S0.1, the #53 probe** (A writes then resets; B's fresh row PASSES, since the flag is off when fresh).
   - **The deciding question:** is B re-run under the mutant (whose leak leaves the flag set), and does its re-run row
     FAIL?
   - If B is not re-run, a passing-fresh reader is never re-run. **The design is DEAD:** report it, keep the label, and
     stop.
2. **S0.2 to S0.6, only if S0.1 shows a re-run.** An extended probe fixture, invented, with one case each:
   - **S0.2:** the reader BEFORE the writer in the codeunit order. A re-run of the reader after a LATER writer is an order
     bcdev never uses, so such a re-run must never kill.
   - **S0.3:** a resetter codeunit between the writer and the reader.
   - **S0.4:** a mutant that REMOVES the write. Does the hint, and with it the re-run, disappear?
   - **S0.5:** every request sent twice, to check the rows are the same each time.
   - **S0.6:** a codeunit on `method` isolation, since a lane has one `testIsolation`.
3. **S0.7:** the request shape. One batch entry (the measured fact) against several serve-entries. Expected: only the
   single-entry shape carries.

## The design (only if step 0 holds; v2's rules)
- **Which mutants:** PR-327 (a)'s tagged ones (the site in a SingleInstance codeunit, covering 2 or more test codeunits).
  On c2, 90.
- **The SAME shape for baseline and mutant:**
  - the lane request is sent uncut, with NO L4 cut, no PR-250 cut and no PR-303 pruning for lane mutants;
  - identical entries and `excludeTests` for the lane baseline and the mutant lane;
  - the lane baseline is keyed on that exact shape.
- **Rows are matched by (codeunit, method, occurrence).**
  - If the per-method row counts differ between baseline and mutant, the verdict is `error` (named) and the label stays.
  - A row red in the lane baseline is never a kill.
  - A kill counts only on a re-run row that follows an EARLIER codeunit in the order (S0.2).
- **The kill confirm:** the whole NONE lane and the whole mutant lane are sent again, and the same rows are required. A lane
  row is never rechecked alone, and never served from per-codeunit prefetch.
- **Timeouts:** the deadline comes from the lane baseline's own wall time. A lane timeout is `timeout-killed` only if it
  reproduces.
- **The label comes off only when the mutant's answer holds the re-run rows its lane baseline had** (proof per mutant that
  the carry happened). Otherwise it stays.
- **R1174 on v3:** lanes in the no-ledger order. The R1174 re-walk comment ("bcdev only") is updated with the build.
- **`killingTest`** is the first qualifying re-run row's test. It may differ from bcdev's, and that is pre-committed as
  allowed in the c2 BLOCK rule.
- **Version gating:** a new leg-C fact ("strictOrder accepted in a mutant request; a passing-fresh reader is re-run") gates
  the flag. `batch-lane-strict-reruns` alone does not.
- **The flag:** `LETHAL_V3_SINGLEINSTANCE_LANE=on`, default OFF.
- **A known limit:** a writer OUTSIDE the covering set is missed. bcdev also runs only covering tests, so the two backends
  match.

## After the build
- **The #53 probe on v3:** red then green.
- **c2's 90:**
  - flips;
  - the wall time;
  - **BLOCK:** any killed → survived, or any verdict change outside the 90.
- **A v3 gate leg** on the probe shape with the flag ON, its figures pre-committed.
