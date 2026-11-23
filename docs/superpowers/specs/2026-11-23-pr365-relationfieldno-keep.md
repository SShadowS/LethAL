# PR-365 pre-commitment v2 (R1187): keep the v3 serve daemon after the Field.RelationFieldNo baseline refusal

Written 2026-11-23, before the build and before the DO check. v2 folds in an Opus spec review of v1
(`/coord/handoff/PR-365/spec-review.md`: 1 BLOCK, 2 SERIOUS, LOWs). v2.1 folds in its delta review: reach is measured on
y3's coverage, because c3 keeps none for a refused test. Measured first (`/coord/handoff/PR-365/`: `overlap.py`,
`overlap.tsv`, `census.py`, `census.txt`; PR-364's `findings.md`). Names and counts only: DO test names, codeunit names and
mutant data stay under /coord.

## Why
- **The refusal:** on current main-bf3a3e863, al-runner refuses `Field.RelationFieldNo` for three BaseApp TableRelations
  without a field (upstream `1bea5bc7a`, a deliberate refusal of unmeasured shapes). It hits 7 baseline test runs in two DO
  test codeunits.
- **What it costs:** the daemon does not keep that refusal, so PR-250 cuts each codeunit's entry before the refused test.
  **1,504 c3 mutants read `error`**; in y3 the same sites were 182 killed and 1,233 survived (R1187).

## The overlap with R1160 / PR-347 (refusedCutTail), measured (`overlap.tsv`)
- **The join:** c3's 1,504 cut mutants, per full site key, against PR-302's t1 (the flag on, main-ccd0f823d).
- **What the flag alone does:**
  - **895 get a verdict:** 689 survived, 205 killed, 1 timeout-killed;
  - **595 stay `error`:** all are cut before codeunit 68984's refused test, and each needs that codeunit's one tail test
    PR-302 found not stable when run alone (20 of 21);
  - **12 stay `error`** for refusals of their own under the mutant, which neither lever touches.
- **What a keep row does:** no cut for this text at all, so those codeunits' tests run in sequence with the earlier tests'
  state intact, and the tail route never fires there. It covers the 895 AND the 595.
  - The flag runs tails alone, and PR-302 found one al-runner false kill that way (M13065, upstream #8721). That mutant is in
    this set, so the DO check watches it.
- **Both are needed:** the keep row is the faithful fix for these texts, and the flag stays the general route for every
  other unkept refusal (codeunits 68874, 68906 and 68959).
  - Whichever lands second re-predicts: for PR-344's DO re-check, 68975 and 68984 leave the tail route. Agreed with
    lethal-preproc, 2026-11-23.
  - The SaveAs-as-Pdf cut (54 mutants) is recovered in full by the flag, when the flag is on. It is NOT kept here (see
    below).

## The census (`census.txt`)
- **`RelationFieldNo`:** exactly 3 texts, identical on main-ccd0f823d (t1) and main-bf3a3e863 (c3), one per field:
  `Dimension Code` of `Dimension Set Entry`, and `Ship-to Post Code` and `Dimension Set ID` of `Sales Invoice Header`.
  - Every text is "the value of field 'RelationFieldNo' of platform table 'Field' is not known for field '<f>' of table
    '<t>', a TableRelation without a field of a shape not measured: no corpus test pins it (docs/probes-needed.md)".
  - c3: 7 rows, all at baseline. t1: 16 rows, 14 at baseline and 2 under a mutant.
- **SaveAs-as-Pdf:** its text differs between the two builds, and carries upstream corpus paths with line numbers, so an
  exact row would break on any upstream edit. 14 of its 15 c3 rows are under a mutant (no keep row changes those), and
  the flag recovers all 54 cuts, **with `refusedCutTail` on** (it is off by default until PR-347). **Not kept**; recorded
  here as decided.
- **Reach (`reach.py`, `reach.tsv`; v2.1 after the delta review):**
  - **c3 keeps NO coverage for a refused (notRun) test:** the 7 refused tests appear as a covering test 0 times in c3's whole
    report. So c3 cannot say what they reach, and v2's "none is covered by a refused test" was an empty-vs-empty match. It
    is withdrawn.
  - **So reach is read from y3's report,** where the 7 tests ran fully, joined per full site key (1,504 of 1,504 joined).
    The positive control: the refused tests appear as a covering test 4,865 times in y3.
  - **Of the 1,504:**
    - **775 are covered by a refused test AND a later test** of the same codeunit. The refused test's partial run does
      reach their code. t1 left 524 of them `error`, killed 55 and scored 196 survived.
    - 696 are covered by no refused test;
    - 33 are covered by a refused test and tests only earlier or elsewhere;
    - **0 are covered only by refused tests.** So the keep row can score all of them except the 12 with their own
      refusals.
- **The refusals' place (review):** codeunit 68975 refuses 3 of its 78 tests (all `RelationFieldNo`). Codeunit 68984
  refuses 4 `RelationFieldNo` tests and 2 GoToKey tests of its 42, and the GoToKey text is already kept. So with these rows,
  no other refusal in either codeunit brings the cut back. Both PR-250's cut and R998's left-out run select on "a named
  refusal the daemon does not keep", so the rows remove both.

## The change
- **Three exact `PR56_KEPT` rows,** one per measured (field, table) pair, with no slot. A fourth pair, or any reworded text,
  still closes the daemon (fail-safe), and PR-244's near-miss warning names it.
- **Tests:**
  - each real line is kept;
  - a fourth field or table is not;
  - the rows join PR-361's fixture of real lines (`pr361-keep-real-lines.json`, `proven`) and PR-362's branches;
  - PR-363's leg-C coverage map names them.
  - These rows reach no leg-C case (no family cell produces them), so PR-363's pinned map lists them under "no family
    cell yet".

## The kept-vs-fresh DO check (before the rows can land; PR-354's kit, `keepcheck/`)
- **The workspace:** PR-190's instrumented DO workspace and the test app, with the binary pinned to main-bf3a3e863
  (sha256 and version checked).
- **The mutants (review):** chosen by reach (y3's coverage), not by t1 verdict.
  - Per codeunit: 4 from the 775 covered by a refused test AND a later test, spread over the refused tests that reach them.
  - Plus M13065 (#8721's known al-runner false kill; covered by no refused test), as the watch.
  - A and B under these mutants therefore test real reach. Plan C is still the oracle.
- **Plan A, across requests (PR-354's shape):**
  - for each of the two codeunits, its whole entry, the refused tests included, under no mutant and under its 4 mutants;
  - a request with no mutant after each;
  - all on ONE kept daemon, against a fresh daemon per request;
  - every row equal (name, status, message).
- **Plan B, within a request:** whether a refused test's partial run changes a LATER test in the same request, compared
  with that test absent.
  - For each of the 7 refused tests: the whole entry, against the same entry with that test excluded (`excludeTests`);
  - every row of every OTHER test equal;
  - the "without" answer must have exactly one row fewer (`excludeTests` matches by prefix, #8059);
  - under no mutant and under the 9 mutants.
- **Plan C, against a full run (review; the oracle closest to BC):** the same entries, under no mutant and the 9 mutants, on
  y3's binary edge-4ebfe7913.
  - That build predates upstream `1bea5bc7a`, so the 7 tests run fully there (they passed in y3).
  - Every row of every test after a refused test, in keep mode on main-bf3a3e863, must equal that run's row.
  - A difference is explained one by one (another upstream change between the two builds, named), or it blocks.
- **The self-test:** one planted row difference must be caught by each compare.
- **The verdict:** A, B and C equal (C's differences each explained) means the rows may land. Any other difference blocks,
  and it is filed with R1187.
- **When:** the check runs after PR-359's A+B, on the orchestrator's word (one light process, CPUs 0-11 or 12-21 as given).

## The prediction for the next full DO run on current with the rows (the hard claims)
- **The run pinned (review LOW):** main-bf3a3e863 (sha256 and version checked), c3's settings, and `refusedCutTail` as in
  c3 (absent, so off). V below holds only if both match c3; otherwise it is void.
- **V:** no verdict moves outside the cut mutants of codeunits 68975 and 68984 (per site key, against c3).
- **Of c3's 1,504 cut mutants:**
  - **exactly the 1,492 outside the 12 leave `error`** (no mutant is covered only by refused tests, `reach.tsv`). Each that
    does not is listed by mutant, with its reason.
  - Every `error` that remains names a reason other than PR-250's cut for these texts.
- **Gained kills, the false-kill direction (review BLOCK):** every one of the 1,504 that reads `killed` where y3 read
  `survived` is listed by mutant, with its killing test.
  - A killing test after a refused test in the same codeunit is a BLOCK, unless that mutant is explained one by one (for
    example, a kill y3 missed for a named reason).
  - y3 ran these tests with no refusal, so it is the closest stand-in for a full run on DO.
- **Lost kills:** of the 182 y3 kills among them, at least 150 read `killed` again. Each that does not is listed.
- **Against t1:** every verdict that differs from t1's among the 895 is listed. That is not a block, since t1 ran on another
  binary (main-ccd0f823d) and ran tails alone.
- **The error count:** c3's 2,110 falls to at most 618 (2,110 − 1,492). The 54 SaveAs-as-Pdf cuts are separate from the
  1,504, are already in the 2,110, and stay `error` with the flag off. v1 said 660, and the review's "606 + 54" counted
  those 54 twice.
- **The daemon:** no close on these 3 texts, and the serve-entries line shows 0 cuts for them.
- **Throughput (expected, not judged; review LOW):** these refusals sit in nearly every entry of the two codeunits, so
  `keptRefusal` is set often and the packing gate stops packing those pieces. The mutant phase there is expected to be
  slower per entry. It is reported.

## Checks
- **For the rows:** VERIFY (one at a time), Opus review, CI, and the v3 gate when the box frees. Leg C is unchanged, since no
  case is added.
- **The DO check and the full DO run** are their own steps after PR-359, each on the orchestrator's word.

## Amendment 1 (2026-11-23, before the DO check): the oracle's value of RelationFieldNo
- **Why:** PR-366's probe (`scripts/r1188-probe`) shows y3's build edge-4ebfe7913 answered `RelationFieldNo = 1` for every
  no-field shape, the measured control included. Upstream issue #8249 found BC gives 0 for the control.
  - So Plan C's oracle may have run the 7 tests on a value BC does not give, and so may y3, which the gained-kill check reads.
  - BC's own answer for the three shapes comes from bugs' PR-367 (the probe on bc4). **The DO check starts only after
    PR-367's answer is in.**
- **Plan C, in the two codeunits whose entries hold the 7 tests (68975 and 68984), classified against PR-367:**
  - **If BC gives 1 for the three shapes** (the oracle's value): unchanged. Every difference is explained one by one, or it
    blocks.
  - **If BC gives another value:** the oracle ran those tests on a value BC does not give. A Plan C difference in a test
    after a refused test is then classified, never counted blindly:
    - **"oracle value":** the later test reads state the refused test built from `RelationFieldNo` (named per difference
      from the test's code path). It is reported, not blocking, and R1187 records it.
    - **otherwise:** explained one by one, or it blocks, as before.
  - Plans A and B are unaffected: both run on main-bf3a3e863 only.
- **The gained-kill check against y3, under the same case:** a gained kill is still a BLOCK unless explained one by one.
  "y3 ran on `RelationFieldNo = 1`" is an allowed explanation only when the killing test's failure follows from that value,
  named from its code path; it never covers a kill by itself.
- **The predicted lost kills (at least 150 of 182 y3 kills):** if BC gives another value, a y3 kill that does not recur is
  listed with whether it rests on the value. Such a kill is not counted against the bound.
