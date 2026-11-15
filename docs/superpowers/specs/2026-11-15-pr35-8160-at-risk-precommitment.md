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

## Addendum 2 (after the review, before any BC run for it): which write methods?
The probe of addendum 1 measured `Insert` only: refused everywhere. The 306 write-first tests write first with: DeleteAll 140,
Insert 114, Modify 48, Delete 3, ModifyAll 1. A stored BC baseline (R-882 S3, Service Declaration, mock installed, 7 tests passing)
has tests whose first write is a `RecordRef.Modify` of a table without InherentPermissions, before any lowering. So a second probe,
same setup (target app plus test app, no TestPermissions, nothing lowered). The target app seeds one row per test at install:
1. `Modify` of a seeded target row.
2. `Delete` of a seeded target row.
3. `DeleteAll` on the target table, filtered to a seeded row.
4. `DeleteAll` on the target table, filtered to a value no row has (nothing to delete).
5. `ModifyAll` on a seeded target row.
6. `Rename` of a seeded target row.
7. `RecordRef.Modify` of a seeded target row (the S3 shape).
8. `Insert` into the target table (the control: refused before).

**Predictions.** 8 fails. 4 passes (no row is written). No firm prediction for 1-3 and 5-7: S3 says a `RecordRef.Modify` can pass,
while addendum 1's probe refused every `Insert`.

**How the count follows.** The at-risk set keeps a test only if BC refuses its first write method. If DeleteAll with rows fails and
DeleteAll with none passes, the 140 DeleteAll-first tests become "uncertain" (a parse cannot tell whether the table holds rows)
and are reported apart. The figures of the first count (306 / 123 / 455) are replaced, not kept.

## Addendum 3 (after probe 2, before any BC run for it): does TestType decide it?
Probe 2 (lethal-bugs, bc3, `/coord/handoff/PR-35/bc3-run2/result.md`) did not answer the write question. Every cell failed on its
first READ of the seeded table (a Get, or the filtered scan inside DeleteAll and ModifyAll), even a DeleteAll with no matching row.
Probe 1's reads passed on an empty table. So under the Restrictive default BC refuses reads of a table that holds rows.

That makes R-882 S3 harder to explain: its 7 passing tests read and write before any lowering. Their codeunit declares
`TestType = Uncategorized` and no TestPermissions; probes 1 and 2 declared neither. Among the 83 exposed codeunits, TestType is
absent in 61, Uncategorized in 8, IntegrationTest in 6, UnitTest in 5; 3 declare Restrictive. Probe 3, same setup as probe 2:
1. `TestType = Uncategorized`: Get a seeded row, then Modify (the S3 shape).
2. `TestType = IntegrationTest`: the same.
3. `TestType = UnitTest`: the same.
4. `TestType = Uncategorized`: Insert a new row.
5. no TestType: FindFirst on the seeded (non-empty) table, read only.
6. no TestType: Modify of a record built in memory with a seeded key, no read before it.
7. no TestType: Get a seeded row, then Modify (probe 2's shape, the control).

**Predictions.** 1 and 4 pass (S3). 5 fails (probe 2). 7 fails (probe 2). No prediction for 2, 3 and 6.

**How the count follows.** If TestType lifts the refusal, codeunits declaring it leave the at-risk set. Because BC also refuses
reads of tables with rows, the class is wider than "a write before lowering": it is any table access before lowering. A parse
cannot see table contents, so the count becomes "tests whose first table access (read or write) comes before lowering", reported
with that caveat.

## What is done with the result
No al-runner build fixes #8160 yet, so nothing is re-scored. The at-risk set (per project: tests, baseline status, kills resting on
them) is recorded in R1048 and in the refusal ledger's note for the class. A re-score follows when a build fails
`InsertUnderRestrictiveDefault`.
