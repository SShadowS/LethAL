# R808 pre-commitment, addendum 1 (2026-11-05): the OnRun answer is BC's shape, not a defect

Corrects a claim in `2026-11-05-r808-serve-keep-rule-precommitment.md` (04465628). Written by lethal-bugs.

The original file's "Also" section calls alpha.12's OnRun answer a runtime difference that silently drops tests, and says it
goes upstream and to a roadmap item. That reading was wrong. Upstream #5859 (closed 2026-10-28): on real BC run through
Microsoft's Test Runner app, a test codeunit whose OnRun raises is skipped with no rows and the run stays green. alpha.12
matches that on purpose; alpha.7's plain `fail` row was the outlier.

- Issue #7147, which reported it as a regression, was posted before #5859 was read, and is closed with a correction.
- No new roadmap item. R808 records the finding.
- LethAL's handling stands: a mutant that causes this reads `error` through `rowMissing`, never `survived`, and the session
  stops at baseline. The build's test pins it.

Every predicted figure of the original file is unchanged.
