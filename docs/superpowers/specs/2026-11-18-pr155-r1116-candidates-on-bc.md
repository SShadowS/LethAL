# PR-155 pre-commitment (measure only): R1116's 50 DO candidates on BC

Coord PR-155 (lethal-code, 2026-11-18). The owner allowed it: q-20261117T235953-15e3ab87 ("just those 50 DO mutants, lethal bcdev on
bc4, under its bc4 lease"). DO stays under `/coord`.

## What and why
R1116 (al-runner #8267): v3 raises no error on a bare `Insert()` of an existing key, so a mutant that lets a duplicate through can
score SURVIVED on v3 where BC kills it. PR-135 counted 50 DO survivors that sit on an existence check
(`Get`/`IsEmpty`/`Find*`) with a bare `Insert` after them in their procedure. This measures how many of those 50 BC kills.

## The scope
- **The 50:** listed by `/coord/handoff/PR-155/list50.ts`, PR-135's own selection, from `/coord/handoff/R-984/x2.run.report.json`
  over DO 30's source. That source is identical to the DO installed on bc4. The list is in `list50.tsv`, with the full site key per
  mutant.
- **The run:**
  - `--lines` on the candidates' 38 lines, plus `--operator` on their 7 operators. That is 86 deployed mutants, a superset;
  - `--tests-only` on the 19 test files that cover the 50 in x2 (none is Azure);
  - `--stop-hung-sessions`.
- **First, the v3 hang check** of the exact scope: local v3, the same flags. It must show 0 timeout-killed, or the hanging
  procedures are left out by name before bc4 is used.
- **Then bcdev on bc4**, under lethal-code's held lease.
- **Afterwards:** DO is restored at a version above the instrumented one.

## What is counted (on the 50, by full site key, from the reports)
- **BC verdicts:** killed, survived, other.
- **Kills with the duplicate-key signature:** the killing failure says the record already exists (#8267's case).
- **Kills listed under `platformArtifactKills` as `linux-rdlc-stub`** (PR-143), counted apart.
- **Kills with another failure text:** named by family.

## Predictions
None pre-committed for the count: it is the open question. One guard only: every one of the 50 must be found in the bcdev report
on the full site key. Any missing one is named, and the count says so.
