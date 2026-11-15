# PR-36 pre-commitment: label #8160's at-risk verdicts in al-runner-v3 reports (2026-11-15)

Written before any code for it and before any gate run.

## What it does
R1048 / #8160: under BC's Restrictive default (a test codeunit without `TestPermissions`, or with `Restrictive`), with Microsoft's
Permissions Mock installed, BC refuses every write and every read of a table that holds rows until the test lowers its
permissions; al-runner allows them. Until upstream fixes it, an `al-runner-v3` run labels the verdicts that rest on such tests.
It never hides them and never changes one: verdicts, counts and `mutationScore` stay as they are.

- **Detection, by parse at run time,** on the one parse of the test app the session already makes (`testpage-scan.ts`'s model):
  1. the test app installs the mock: its app.json depends on Permissions Mock (40860557-…) or on Tests-TestLibraries
     (5d86850b-…, which depends on it; PR-35 found no other path in 84 projects);
  2. the test's codeunit declares no `TestPermissions`, or `Restrictive`;
  3. walking the test in statement order (same-codeunit procedures followed), its first table access comes before its first
     permission lowering (a `Permissions Mock` call, or any `Library - Lower Permissions` method). The tiers are PR-35's:
     - `firm`: the first access is an Insert or a Modify;
     - `uncertain-write`: a DeleteAll, ModifyAll or Delete;
     - `uncertain-read`: a read.
     An access through another codeunit is not seen ("indirect", left out as in PR-35).
- **Labels:**
  - a kill whose killing test is at risk (resolved through the mutant's own covering tests, which are qualified names);
  - a survivor any of whose covering tests is at risk.
- **Report:**
  - a new caveat value, `tests-restrictive-default-at-risk`, with its `CAVEAT_INTERPRETATIONS` entry;
  - an optional `SessionReport` field naming the at-risk tests with their tiers, and the labelled mutants;
  - one banner line.
  It runs only on `al-runner-v3`: bcdev runs on BC, where the refusal is BC's own and R35's `tests-permission-refused` already
  names it.

## Schemas
- Report schema: an additive optional field and a new caveat enum value.
- Explain schema: a new caveat value, so it bumps 27 → 28 (R233); v27 is frozen.
- No root-required field changes, so the committed sample reports stay valid without regeneration.

## Gate prediction
**No gate figure moves.** No fixture's test app depends on Permissions Mock or Tests-TestLibraries (checked: every
`fixtures/*/app.json`), so detection finds nothing, the event is not emitted, and every gate report is unchanged: no new field,
no new caveat. The al-runner-v3 gate runs on the final head; any difference in its per-mutant table is a BLOCK.

## Red checks, both ways
- A write-first test in an exposed codeunit, mock installed: labelled.
- The same test with `TestPermissions = Disabled`, or with the mock not installed, or lowering first: not labelled.
- A kill by an at-risk test is labelled; a kill by another test is not.
- A survivor covered by an at-risk test is labelled; one covered only by safe tests is not.
