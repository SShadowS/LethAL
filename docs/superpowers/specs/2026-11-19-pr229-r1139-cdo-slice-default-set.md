# PR-229 pre-commitment: the CDO slice re-measured on BC with the default operator set (R1139)

Coord PR-229 (lethal-code, 2026-11-19). Roadmap: R1139 (on lethal/pr209 until PR-209 merges). Related: R594, R855,
R1136, PR-209 (`condition-true` and `blank-argument` default-on). Evidence: `/coord/handoff/PR-229/`.

## 1. What runs
- **LethAL:** PR-209's head `b452b65b0`, which is the default operator set with the two new operators on. Its worktree is
  `/work/lethal-wt/pr209-bc3`.
- **CDO:** `/work/lethal-wt/cdo-r396` at `5f2a71d`, read-only.
- **The v3 scope check, first:** R594's exact scope on al-runner v3 `current` (`edge-4ebfe7913`), default set
  (`v3-scope.sh`).
  - It must show **0 `timeout-killed`**, or nothing is leased.
  - Its rows are the v3 side of §3.
- **On bc3**, under one coord lease (the owner's standing yes covers bcdev runs on Continia apps on a leased BC), as R855
  did (`/coord/handoff/R-855/cdo-legs.sh`, `scripts/r594/cdo-publish.ts`, `scripts/r594/run-leg.sh`):
  1. publish the pinned Continia stack and the CDO apps (Dev scope);
  2. run leg A (`coverageMode none`) and leg B (`fenced`) with R594's exact flags: `--only` CDORecipientMgt,
     `--tests-only` CDORecipientMgtTests, the selector ids, `--stop-hung-sessions`;
  3. remove the CDO apps;
  4. doctor, then release only if healthy.
- **No `--profile`:** the default set.

## 2. The predictions (BC is the oracle, R1139)
- **Mutant count per leg: 78** = R594's 65 + R1139's 13. The 13 are in `CDORecipientMgt.Codeunit.al`: `condition-true`
  at lines 15, 28, 34, 36, 44, 60, 64, 70, 78, 85; `blank-argument` at 36, 40, 42.
- **The 65 old rows:** joined with `docs/measurements/r594/bc3-A.report.json` and `bc3-B.report.json` on the full site
  key (file, start and end index, line, operator).
  - Each must be EQUAL on verdict and killing test, and in leg B on covering tests too.
  - **Any difference is a BLOCK:** it is reported verbatim, nothing is re-run, and nothing is absorbed.
  - So leg A old rows stay 53 killed / 12 survived, and leg B old rows 53 / 8 / 4.
- **The baseline:** 21 of 21 green, with R594's 21 names.
- **The 13 new rows:** BC's verdicts are recorded as they come (no prediction; BC is the oracle). Each is compared with v3's
  row on the same site key. A v3 row that differs is a v3 difference, reported (and, if it is an al-runner refusal or a
  wrong verdict, filed upstream), never absorbed.
- **A row count other than 78**, or a site of the 13 missing, is a BLOCK for that leg.

## 3. What lands after the runs
- **The reports, redacted** (`bun scripts/redact-campaign-report.ts`; `--check` clean): no CDO source text.
- **The oracle extended by exactly the 13 rows:** `docs/measurements/r594/` gains the default-set reports, and every old
  row is checked unchanged, row by row.
- **D1 and D1c back to the default set,** with the new counts (from leg A and leg B), and their gate page updated.
  - That is a v3 gate change: the v3 gate runs, and every other leg's figures must stay put.
  - A D-leg verdict for a new mutant that differs from BC's is a pre-committed v3 difference, recorded as such; it is never
    hidden.
- **Roadmap:** R1139 is set to done.
