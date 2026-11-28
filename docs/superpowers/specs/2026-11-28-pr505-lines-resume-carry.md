# PR-505: a `--lines` resume carries its twins when the numbering is unchanged; and the resume names every survivor it re-runs

Pre-commitment (lethal-bugs, 2026-11-28), written before any code. R1229. Evidence:
`/coord/handoff/PR-505/findings.md` (step 1, read-only replay of `/coord/handoff/PR-427/f4-a-carry/`).

## What was measured

- DOTests' file 4 half A (`--lines …CDOEMailHandler.Codeunit.al:1-650`) was resumed across a lost-database restart with
  an equal baseline. It carried 79 of its 133 run-1 survivors and silently re-ran 54.
- **All 54 fall to `isCarryDisabled`** (R307 section 3, fail closed), and none of the 79 does. The disabled set (404
  coarse tuples) is EXACTLY the coarse tuples of the file's sites outside the `--lines` range: `--lines` keeps those
  sites out, so the run numbers no ordinal for them, and every in-range twin of theirs is distrusted.
- **The two runs' numbering output is identical:** equal `numbering_digest`, equal `carry_hidden`, equal `twin_tuples`.
- The 43 prior kills not re-run "with the prior killer first" were refused the same way and re-ran unseeded. That is
  cost only.

## Change 1 (the rule): resume only

In `carriedVerdictFor`, the R307 refusal (`isCarryDisabled`) does NOT apply when all of these hold between the resumed
run (recorded) and this session (current):

1. both numbering digests are recorded, and they are equal;
2. the hidden tuple sets are equal (`carry_hidden`), with neither absent;
3. the twin tuple sets are equal, with neither absent.

Everything else stays as it is:
- R391's `carryRecord` still decides the carry by key, with all its own checks;
- R646, the restart batch gate (PR-456), the R621 no-coverage rule and the stranded-skip rule all still apply;
- history (`filterHistory`) and equivalence marks keep R307's refusal unchanged. They compare runs whose scopes may
  differ, and this pre-commitment does not cover them.

## Why it is sound

R307 disables a twin because a key a PRIOR run recorded (tuple plus ordinal) may name a different site in THIS run when
the two runs numbered different site sets. The hidden sites had no key in either run.

The numbering digest is computed from the numbered entries and their ordinals. So an equal digest, with equal hidden
and twin sets, means both runs gave every in-range site the same key. A recorded key therefore names the same site, and
the recorded verdict is that site's verdict.

So carrying adds no false kill and no false survivor: it is the same verdict R1229 already carries for a non-twin. A
mismatch in any of the three keeps today's refusal (fail closed).

## Change 2 (never silent): the resume names every survivor it re-runs

- Whenever a resume re-runs a mutant whose recorded verdict for its key or site is `survived` (or `killed`), it emits
  ONE warning per session, `resume-recorded-not-carried`.
- The warning counts the re-runs by reason and lists the mutant ids per reason. A long list is cut, with the count kept.
- The reasons: `carry-disabled` (R307, when change 1 does not apply), `carry-refused` (R391's rule refused the key),
  `no-coverage-now`, `not-faced` (R646), `restart-batch-unequal`, `restart-kill-rerun` (by design, PR-456), and `other`
  (with the code path named).

## Tests: red both ways

- (a) a twin whose numbering is UNCHANGED (equal digest, hidden and twins) carries;
- (b) a twin must still NOT carry when any one of the three differs: three cases, one per fact;
- (c) a non-twin carries as before, and a mutant with no record runs as before;
- (d) the warning names every re-run survivor with its reason. It is absent when everything carries.

Each test is red-checked: revert the specific change and see the test go red.

## Predicted outcomes

- **Offline:** replaying f4-a's store copy and saved manifest through the new rule carries all 133 survivors. The 115
  kills are re-run, each seeded with its prior killer.
- **Gates** (the gate table's legs for `resume.ts`, `selection.ts`, `orchestrator.ts` and `events.ts`: bcdev, lease,
  tables, chunked, alrunner-v3, coverage-differential; plus `itest:lend`, because resume moved): every frozen figure
  UNCHANGED. None of these gates resumes a `--lines` run with twins outside the range.
  - The new warning may appear only where a resume re-runs a recorded survivor or kill. If a gate's warning set moves,
    that is pre-committed here by name: `resume-recorded-not-carried`, in `itest:lend` only, and only if its resume
    re-runs a recorded verdict. Any verdict move is a BLOCK.
- **Unit:** VERIFY full PASS. CI is green on the submitted head.

## Amendment r2 (after the build review, 2026-11-28; before any gate)

An Opus review of the build found nothing blocking. It confirmed that `numberingDigestOf` hashes every numbered entry's
file, span, operator, tuple and ordinal, and that the lift is confined to resume. These points change the text above.
Where r1 and r2 differ, r2 holds.

- **Scope of change 1:** the lift covers every hidden tuple, not only the ones `--lines` makes. A header-refused file
  outside the range is the other source. The soundness argument is the same: a hidden site has no key in either run.
- **Change 2: one warning per BATCH**, as its sibling warnings (`resume-tests-not-faced`, `resume-survivor-no-record`)
  already are. Not one per session.
- **Change 2's reasons, as built:**
  - `carry-disabled` (R307), `carry-refused` (R391);
  - `restart-batch` (PR-456: the batch's fresh baseline did not equal the prior run's);
  - `restart-not-carryable` (PR-456).
  - `not-faced` and `no-record` keep their own warnings and are not repeated.
  - A restart's prior kills are re-run by design (PR-456) and stay counted in `resume-across-restart`, not named here.
  - `no-coverage-now` is dropped: such a mutant is not executed at all.
- **Change 2's record:** "recorded" means a row found by key, or by rule 2's member site when the mutant has a member
  hash. A recorded `known-survivor` counts like `survived`; a recorded `no-coverage` never counts (R621).
- **A second new warning, pre-committed by name:** `resume-numbering-unchanged`. It is emitted once per resume when
  the hidden set is non-empty and change 1 lifts the refusal. Like `resume-recorded-not-carried`, it may appear only in
  a gate whose resume has hidden tuples: of the gates above, `itest:lend` at most. No verdict moves.
- **Tests added after the review:** null-on-both-sides rows for `hidden` and `twins` in the unit table, each
  red-checked, and a direct test that `recordedVerdictOf` finds a rule-2 site match, red-checked.
  - Case (b)'s three facts are pinned by the unit table; the integration test covers the digest-and-hidden case.
