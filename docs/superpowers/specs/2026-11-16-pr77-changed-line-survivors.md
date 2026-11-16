# PR-77 pre-commitment: survivors on the changed lines, advisory by default (threshold option 3, first step)

Coord PR-77 (2026-11-16). Owner ruling q-20261116T134341-645f4a0f: option 3 of `docs/ci/threshold-options.md`, advisory
first. The ruling's stated reason: "Decide on gating from the DO pilot's measured numbers."

## What is built

**1. The list.** After a `lethal run` whose mutants were narrowed by `--lines` or `--changed-since` (the report carries the
`line-narrowed` caveat), the console ends with a section **SURVIVORS ON THE CHANGED LINES**. It has two parts:
- **counted:** every `survived` mutant of the run, one line each: `<batchIndex>/<mutantCode> <file>:<line> <operator>
  <procedure>`, sorted by file, line and code;
- **listed apart (al-runner-v3 caveat, never fails):** the survivors with a caveated site (see 2), each with its reason.

"New" means every survivor on those lines: there is no accept list yet (the next task). `killed`, `timeout-killed`,
`no-coverage`, `error` and carried verdicts are not survivors and are not listed. A run with no line filter prints no section.

**2. "A site with an al-runner-v3 caveat".** It applies only to a run on the `al-runner-v3` backend; on bcdev nothing is
caveated. A survivor is caveated when at least one of these holds:
- (a) a test that covers it (`coveringTests`) has `baselineFlagged` in `testMethods`: al-runner flagged that test's baseline
  pass as resting on an unprobed assumption;
- (b) such a test has `baselineFlaggedUnknown`: its baseline ran on a serve daemon, so its flag is unknown;
- (c) its file is in the report's `coverageOffFiles` (the `al-runner-v3-coverage-off` caveat): coverage was off, so the run
  cannot tell whether a test reached it;
- (d) the report already labels this survivor at risk. Today that is one list: `restrictiveDefault.survivors` (PR-36, R1048,
  upstream #8160). It holds the survivors whose every covering test BC would refuse under the Restrictive default, so on BC
  they would have no covering test. It is the only per-survivor at-risk label the report carries today (checked in
  `report.ts`). A future per-survivor label is added to this list by name, never by pattern.

Every other v3 survivor is counted. "v3 is not authoritative" is NOT taken as a caveat on every survivor, since that would
make the flag a no-op on v3.

**Who decided this.** The orchestrator accepted (a)-(c) and added (d) (2026-11-16). This plain statement is here so the
owner can object to it.

**3. The opt-in failure.** `lethal run --fail-on-survivors`:
- exits **9** (`SURVIVORS_ON_CHANGED_LINES_EXIT_CODE`) when the counted part is not empty;
- exits 0 when only caveated survivors remain.
- Without the flag, the run's exit code is what it is today (advisory: exit 0).
- Exit codes 3 (quarantined), 4 (nothing scored) and 7 (time budget) win over 9, because their reports cannot be trusted
  as a full list.
- Exit 8 (no mutable line) writes no report, so 9 never applies there.
- The flag is refused, as a usage error (exit 1), on a run with no `--lines` or `--changed-since`. A whole-app survivor count
  is a different quantity (threshold-options.md, "Scope changes the number").
- 9 is free: 3, 4, 7 and 8 are run's, and 5 and 6 are verify's.

**4. Docs.**
- The CLI usage's exit-code list, and `docs/using-lethal-from-an-agent.md` §"Exit codes" (checked by `agent-contract.test.ts`).
- `docs/ci/README.md`, and both templates. They map 9 to a failure and add a commented-out `--fail-on-survivors` with one line:
  advisory until the DO pilot's numbers decide (the ruling).
- `docs/ci/threshold-options.md` records the ruling and what was built.

## Not built (next task)
The accept list and its anchoring: extending R443's proof rules to accepted survivors. The default stays advisory until the
pilot's numbers.

## Tests, red both ways
- The list: counted and caveated survivors are split by (a), (b) and (c) on a v3 report; a bcdev report caveats nothing;
  non-survivor verdicts are left out; no section without a line filter.
- Exit codes: 9 with the flag and a counted survivor; 0 with the flag and only caveated survivors; 0 without the flag; 3, 4
  and 7 win; the flag without a line filter is refused.
- Each rule is reverted to show its test red: drop each caveat reason in turn, map 9 without the flag, let 9 win over 7, and
  accept the flag without a line filter.
- The CI templates' exit mapping (the PR-76 harness that runs each block for codes 0..9) must show 9 failing.

## Predictions
- P1: no existing test's expectation moves, except the exit-code tables, the usage text and the CI-template harness.
- P2: the v3 gate passes on the final head. The console section prints only on line-narrowed runs, and the gate's legs are
  not line-narrowed, except any leg the gate narrows by `--lines`. If such a leg exists, its console gains the section and
  its verdicts do not move.

## Addendum 1 (2026-11-16, after the Opus build review; orchestrator's decision)

The text above is left as it was committed. These changes were made after review and before any merge.

**Reason (b) is dropped. This NARROWS the owner's "al-runner-v3 caveat" to POSITIVE signals only.** A survivor is listed apart
only for (a) a flagged baseline, (c) coverage off, or (d) the restrictive-default at-risk list. "Flag unknown"
(`baselineFlaggedUnknown`) and "flag not recorded" are treated alike: both count. Why:
- **The review's M3:** on the serve-entries transport, al-runner's default where proven, every baseline pass is
  `baselineFlaggedUnknown`, because serve rows carry no flag (R949, upstream #7954). With (b), almost every covered survivor
  went apart, so the counted list read about 0. The owner's ruling waits for the DO pilot's counted numbers, and those would
  have said nothing.
- **The review's H1:** a resumed run that reuses its baseline records no flag at all (absent means "says nothing"). With (b),
  "unknown" went apart while "not recorded" counted, so the same scope flipped. A fresh run gave about 0 counted; the same run
  resumed after exit 7 counted every survivor and exited 9.

Treating "unknown" and "not recorded" alike removes the flip. The cost: a survivor whose covering test WOULD have been flagged
counts, if serve reported flags. The flag stays opt-in and the default advisory. **The section prints one line** naming how
many survivors' covering tests ran with unknown al-runner flags (#7954), so a reader sees how far the counted list rests on
that. The owner can object to this narrowing here.

**Also changed:**
- `known-survivor` rows (`--skip-known-survivors`) are survivors too, as in `SURVIVING_VERDICTS` (review M1).
- Carried `survived` rows are listed and counted (review M2). The sentence above that leaves out "carried verdicts" was wrong:
  a resume after exit 7 must not drop the survivors measured before the stop.
- When exit 3 or 7 wins, the section is marked partial (review L1).
