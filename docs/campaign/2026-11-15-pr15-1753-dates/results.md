# PR-15: the #8006 wrong-verdict class (1753 dates) in BC.History — results

Pre-commitment `precommit.md` (81b453c2). Every re-run below is on al-runner edge-5a58a0f16 (configs pinned; each store's
`runner_build` read). Evidence: `/coord/handoff/PR-15/` (`sites.tsv`, `plan.tsv`, `run-*.log`, `compare.tsv`,
`compare-summary.txt`, `rerun/<n>/`). Stores are not committed: they carry AL source.

## Step 1: sites by parse
As pre-committed. There is no 1753 Date or DateTime literal, no `DMY2Date(.., .., 1753)` and no 1753 date string in the 84 projects
(3,697 files). The R985 stand-ins gave no wrong verdict of this class.

## Step 2: 82 baselines re-run, 4,760 tests compared
- **Positive control:** the class test (BC's "Cannot write the value" naming a 1753 date) flags all 3 refused writes of the
  regression entry `u8006-date-1753` on 5a58a0f16, and none of its 5 controls.
- **References:** PR-05's a184cfc79 triage for 44 projects, and the R-975 sweep store on 736fc7677 for 38.
- **Class: 0.** No test turned red with that text, and no failure text in any re-run names a 1753 write. No mutant is re-scored and
  nothing goes upstream.

Two setup changes against the plan, neither touching a figure:
- Projects 9, 21, 31 and 32 first stopped at compile (AL1022: a Microsoft test library missing from R-975's package folders). R-982
  re-swept exactly these four, with configs that carry those libraries, and PR-05 re-baselined them from R-982's configs. So the
  pinned configs and the references for these four are R-982's and PR-05's `rerun982`. That is still "PR-05's a184cfc79 triage", as
  pre-committed.
- Project 2's config (R-886) names a `dotnetSidecar` dll built in another lane's scratch folder for an older al-runner. On
  5a58a0f16, 11 tests met "protocol mismatch". With the setting removed (LethAL then uses the pinned build's own sidecar), project 2
  was re-run.

## Other moves, 62 tests, each attributed
- **Project 18 (Sustainability), 38 pass -> error:** #8002's number-sequence cascade. **This is not a 5a58a0f16 change.**
  - Repeats with configs pinned: each build gave 0 such refusals on a warm cache and 89 or 148 on a fresh, empty one.
  - The two warm runs, one per build, are identical test by test.
  - Filed as R1031: a fresh cacheDir under-measures a baseline (273 against 393 green).
- **Project 2 (Bank Deposits), 16 error -> fail and 2 error -> pass:** refused in the reference (the older broad "isolated storage
  key or a number sequence" wording). They now run, and 16 fail "The following UI handlers were not executed:
  GeneralJournalBatchesPageHandler". That is R890's suite and symptom (setup kept behind `IsInitialized` across per-test rollback),
  not this class.
- **Project 32 (Permission Sets), 3 error -> pass:** a Tenant Permission Set delete refusal no longer met.
- **Project 46 (Base64 Convert), 1 error -> pass and 2 fail -> pass:** the UTF-16 code page refusal is gone, and two line-break
  tests now give BC's length.

## Predictions, scored
1. No test of the class. **Held** (0 of 4,760 tests).
2. Tests move for other reasons, attributed by message, not the class. **Held** (62 moves, above). One attribution needed
   repeats: the 38 Sustainability tests looked like a 5a58a0f16 change and are cache state (R1031).

## Also found
R1028, closed by ruling: PR-10's 14 failing Guided Experience tests depend on test order (invented repro
`/coord/handoff/PR-10/repro/g`). They are not an al-runner difference.
