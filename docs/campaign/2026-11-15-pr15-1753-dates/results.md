# PR-15: the #8006 wrong-verdict class (1753 dates) in BC.History — results

Pre-commitment `precommit.md` (81b453c2). Every re-run below is on al-runner edge-5a58a0f16 (configs pinned; each store's
`runner_build` read). Evidence: `/coord/handoff/PR-15/` (`sites.tsv`, `plan.tsv`, `run-*.log`, `compare.tsv`,
`compare-summary.txt`, `positive-control.txt`, `rerun/<n>/`). Stores are not committed: they carry AL source.

## Step 1: sites by parse
As pre-committed. There is no 1753 Date or DateTime literal, no `DMY2Date(.., .., 1753)` and no 1753 date string in the 84 projects
(3,697 files). The R985 stand-ins gave no wrong verdict of this class.

One parsed project is not re-run in step 2: R-922's app (3 tests). It is in R-975's full project list but not in its BC.History
sweep, so it has no sweep plan row.

## Step 2: 82 baselines re-run, 4,760 tests compared
- **Positive control** (`positive-control.txt`): the class test (BC's "Cannot write the value" naming a 1753 date) flags all 3
  refused writes of the regression entry `u8006-date-1753` on 5a58a0f16, and none of its 5 controls.
- **References,** by build: a184cfc79 for 40 projects (PR-05's triage) and 736fc7677 for 42. The 42 are the R-975 sweep store for 38
  projects, and PR-05's `rerun982` for the 4 below. Both builds predate the fix.
- **On 5a58a0f16:** 2,462 tests ran (pass, fail or a timeout), and 2,298 were refused by al-runner. A 1753 write that comes after a
  refusal point is not seen.
- **Class: 0.** No test turned red with that text. A scan of every baseline row in every re-run, the first pass included, finds no
  row that names 1753. No mutant is re-scored and nothing goes upstream.

Two setup changes against the plan, neither touching a figure:
- Projects 9, 21, 31 and 32 first stopped at compile (AL1022: a Microsoft test library missing from R-975's package folders). R-982
  re-swept exactly these four, with configs that carry those libraries, and PR-05 re-baselined them from R-982's configs. So the
  pinned configs and the references for these four are R-982's and PR-05's `rerun982`. Those PR-05 stores ran on 736fc7677, not
  a184cfc79. The pre-commitment named a184cfc79 for PR-05's references, but both builds predate the fix.
- Project 2's config (R-886) names a `dotnetSidecar` dll built in another lane's scratch folder for an older al-runner. On
  5a58a0f16, 11 tests met "protocol mismatch". With the setting removed (LethAL then uses the pinned build's own sidecar), project 2
  was re-run.

## Other moves, 62 tests, each attributed
- **Project 18 (Sustainability), 38 pass -> error:** #8002's number-sequence refusals. **This is not a 5a58a0f16 change.**
  - Both its reference and its first re-run hit the triage budget (900 s) inside isolation auto's re-baseline. So both stored
    baselines are mostly the first pass, which gives these refusals.
  - Repeats with configs pinned finished their re-baseline. Each build then gave 0 such refusals and 393 green, and the two
    repeats are identical test by test.
  - I first read this as a cold-cache effect: an empty cacheDir only slows the run, so the budget runs out sooner. The review
    corrected it.
  - Filed as R1031: `triage-baseline.ts`'s summary line does not name a cut re-baseline.
  - It was the only project whose baseline was cut, on either side.
- **Project 2 (Bank Deposits), 16 error -> fail and 2 error -> pass:** refused in the reference (the older broad "isolated storage
  key or a number sequence" wording). They now run, and 16 fail "The following UI handlers were not executed:
  GeneralJournalBatchesPageHandler". That is R890's suite and symptom (setup kept behind `IsInitialized` across per-test rollback),
  not this class.
- **Project 32 (Permission Sets), 3 error -> pass:** a Tenant Permission Set delete refusal no longer met.
- **Project 46 (Base64 Convert), 1 error -> pass and 2 fail -> pass:** the UTF-16 code page refusal is gone, and two line-break
  tests now give BC's length.

## Predictions, scored
1. No test of the class. **Held** (none of the 2,462 tests that ran; 2,298 refused, see above).
2. Tests move for other reasons, attributed by message, not the class. **Held** (62 moves, above). One attribution needed
   repeats: the 38 Sustainability tests looked like a 5a58a0f16 change. They come from cut re-baselines (R1031).

## Also found
R1028, closed by ruling: PR-10's 14 failing Guided Experience tests depend on test order (invented repro
`/coord/handoff/PR-10/repro/g`, output `run.txt`). They are not an al-runner difference.
