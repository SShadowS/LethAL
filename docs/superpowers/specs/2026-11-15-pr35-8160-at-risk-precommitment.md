# PR-35 pre-commitment: which stored results #8160 could have changed (2026-11-15)

Written before any parse of the corpora for this question and before reading any stored result for it.

## The class (R1048, #8160)
On BC a test codeunit that does not declare `TestPermissions` runs Restrictive, the AL default. With Microsoft's Permissions Mock
installed, a table without `InherentPermissions` cannot be written from it before the test lowers its permissions: BC refuses the
write ("Sorry, the current permissions prevented the action. (TableData ...)"). This is measured by u8160 on bc2 and by LethAL's
control app (R026, `PermissionProbe.Table.al`, which also reports reads as refused). al-runner edge-5a58a0f16 passes such a test.
So a stored al-runner baseline can hold a pass that BC would turn red, and a mutant can be scored as killed by such a test.

## Scope
- **BC.History:** PR-15's 84 projects (R-975 `projects.tsv` plus Guided Experience).
- **DO:** every Document Output test app under `/work/src/do-lethal` that has stored LethAL results under `/coord/handoff`.

## The predicate, fixed before measuring
1. **The project installs Permissions Mock:** its test app depends on Permissions Mock (40860557-a18d-42ad-aecb-22b7dd80dc80),
   directly or through a dependency whose manifest in the project's `.alpackages` names it. Projects without it are reported
   apart: the gate servers bc1-bc3 have the mock installed (PR-14), but BC's behaviour without the mock is not measured.
2. **The codeunit is exposed:** a `Subtype = Test` codeunit with no `TestPermissions` property, or with `Restrictive`.
3. **The test is at risk,** by parse, in statement order: the `[Test]` method writes a record (`Insert`, `Modify`, `Delete`,
   `ModifyAll`, `DeleteAll`, `Rename`) before its first permission-lowering call (`PermissionsMock.Set`/`Assign`/`Start`, or any
   method of a `Library - Lower Permissions` variable). Calls to procedures of the same codeunit (an `Initialize`) are followed
   in order, to a fixed depth. Calls into other codeunits are not followed: such a test is "indirect" (it may write through a
   library) and is reported apart, not counted as at risk.
   - Tables with `InherentPermissions` are not excluded by parse (the table is often in another app); this is a stated limit.
4. **What a BC-faithful al-runner would change:**
   - **Baseline:** an at-risk test that passed in a stored al-runner baseline would fail on BC (a permission refusal).
   - **Mutants:** a kill whose killing test is at risk rests on a test BC would not run green; it is at risk. A mutant whose
     only covering tests are at risk would lose its coverage.

## Predictions
- P1: in projects that install the mock, most test codeunits declare `TestPermissions` (at least 80%), since Microsoft's suites
  pass in Microsoft's pipeline with the mock installed.
- P2: across BC.History, fewer than 100 at-risk test methods with a passing stored baseline, in fewer than 10 projects.
- P3: DO: no project installs Permissions Mock, so DO has no at-risk test.
- P4: kills resting on at-risk tests are under 5% of the kills of each affected project.
- **Validation:** where a stored BC (bcdev) baseline exists for an in-scope project, each at-risk test passing on al-runner should
  carry BC's permission refusal there. An at-risk test that passes on BC falsifies the predicate for it; it is reported, not
  dropped.

## Addendum 1 (before any BC run for it): whose table?
The parse (`/coord/handoff/PR-35/at-risk.ts`) found 307 exposed write-first tests. The table each one writes first is owned by:
the test app 34, the app under test 47, another app (Microsoft's) 226. #8160's measurement covers only the first: a write to the
test app's own table. The stored BC evidence points the other way for the rest: Service Declaration's "Serv. Decl. Suggest
Lines" (no TestPermissions, Permissions Mock reachable through Tests-TestLibraries) has 7 tests that create data through Microsoft's
libraries before any lowering, and all 7 pass in a stored BC baseline (R-882 S3.sqlite).

So before counting, one BC measurement (lethal-bugs, bc2, Permissions Mock installed, LethAL's web-service path), of a target app
and a test app that depends on it and on the mock. Each test codeunit declares no TestPermissions unless stated:
1. Insert into the test app's own table (the #8160 shape; the control).
2. Insert into the target app's table, from the test codeunit.
3. Call a target-app codeunit that inserts into the target app's table.
4. FindFirst on the target app's table.
5. FindFirst on the test app's own table.
6. As 2, with `TestPermissions = Disabled` (the control that it can pass).

**Predictions.** 1 fails (measured before). 2 and 3 pass: the Service Declaration evidence says a Restrictive test can write tables
outside its own app. 6 passes. No prediction for 4 and 5: the control app's probe reported reads as refused, but that probe read its
own app's table.

**How the count follows.**
- If 2 and 3 pass, the at-risk set is the 34 tests that write the test app's own table.
- If 2 fails and 3 passes, the at-risk set is 34 plus the direct writes to app-under-test tables (47); "other" stays out.
- If 2 and 3 fail, the set is every exposed write-first test (307), and the indirect class must be re-examined.

## What is done with the result
No al-runner build fixes #8160 yet, so nothing is re-scored. The at-risk set (per project: tests, baseline status, kills resting on
them) is recorded in R1048 and in the refusal ledger's note for the class. A re-score follows when a build fails
`InsertUnderRestrictiveDefault`.
