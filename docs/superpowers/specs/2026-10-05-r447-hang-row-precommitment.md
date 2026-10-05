# R447 pre-commitment: the `hang-refused` row on `itest:hang` (DRAFT)

Status: draft for the R-447 implementer. Commit it UNCHANGED as
`docs/superpowers/specs/2026-10-05-r447-hang-row-precommitment.md` before the live run. Any
value below that the live run does not reproduce is a MISS: stop and investigate. Do not edit
this file to match the run.

## What R447 changes on this fixture

`fixtures/sandbox-hang` has exactly two hang-refused sites, both on `Pending -= 1` at line 104 of
`src/HangLogic.Codeunit.al` (`DrainQueue`, `while Pending > 0`): one `lethal.remove-assignment`
site and one `lethal.shift-integer` site. R196 refuses both (see
`docs/superpowers/specs/2026-10-04-r196-refuse-precommitment.md`). Measured by the census in the
R-447 plan, section 6. No mutant is added or removed.

The row is built in `generateMutationSet`, before any mutant is scored, and folded from
`mutation-set-generated`. Both legs therefore carry it, including the OFF leg, which quarantines
mid-run: `runSession` still returns a `SessionReport` for that leg (today's `assertOffLeg` already
reads `report.mutants`, `report.counts` and `report.quarantined` from it).

## ON leg (`stop-hung-sessions` ON, `assertOnLeg`)

1. `report.excludedSites.files.filter(f => f.reason === "hang-refused")` deep-equals exactly:
   `[{ file: "src/HangLogic.Codeunit.al", reason: "hang-refused", kinds: "codeunit_declaration", sites: 2 }]`
   (no `detail` field).
2. `report.validity.reliability === "narrowed"` (today `full`: baseline green, `counts.errors`
   0, no filter flags; only the narrowed half moves).
3. `report.validity.scoreDescribes` contains `; 2 hang-refused site(s) in 1 file(s) not mutated`.
4. `report.validity.caveats` gains no value from R447 (no new caveat); the existing
   `stop-hung-sessions` and `session-warm` assertions hold unchanged.
5. Every one of the 38 `EXPECTED_ON` rows is identical (line, operator, verdict, and
   `killPosition` where pinned); line 104 still has NO row. `warmKills` 4, `groupedCalls`,
   `counts.errors` 0, and every other existing ON assertion unchanged.

## OFF leg (`stop-hung-sessions` OFF, `assertOffLeg`)

1. A report exists (it does today; see above).
2. The same `hang-refused` filter deep-equals exactly the same one row as ON item 1.
3. `report.validity.reliability === "narrowed"` (exactly; NOT `narrowed-degraded`).
   **Where the prior value was read.** No OFF-leg report survives on disk: `hang.itest.ts` writes
   every leg into a `mkdtemp` scratch root and deletes it in `main()`'s `finally`, and the gate
   prints no `reliability`. So the value is computed from the MEASURED inputs of the last live run
   plus the one function that decides it:
   - Measured (live `itest:hang` on Cronus28, R-196, branch HEAD `df200ce4`, 2026-10-04, PASS; log
     kept in the lane's scratch, not committed): OFF leg `killed=1 timeoutKilled=0 survived=2
     errors=1 baselineGreen=true`, the one error being M0004 (line 37 `void-method-call`,
     quarantined: "could not be confirmed complete").
   - Function: `packages/runner/src/report.ts` (`reliability` in the report builder):
     `degraded = !baselineGreen || allErrors`; `narrowed` = any of `only`, `exclude`,
     `operators`, `lines`, non-empty `testsOnly`, refused rows, left-out rows with sites.
   - The OFF leg's `runSession` call (`runLeg`) passes none of those filters, and the fixture has
     no refused or left-out file, so TODAY the OFF leg reads `full`: baseline green, and 1 error
     out of 4 scored mutants (killed 1, survived 2, error 1) is not all-errors, so the M0004
     quarantine does NOT make it degraded.
   - R447 adds only a `hang-refused` row with sites 2, which sets the narrowed half. R447 does not
     touch the degraded half. Hence exactly `narrowed`.
   The gate also asserts `report.baselineGreen === true` and that `caveats` does not contain
   `all-errors`. If the live OFF leg reads `narrowed-degraded` (or anything else), that is a MISS to
   investigate and a block, never a re-pin.
4. `report.validity.scoreDescribes` contains `; 2 hang-refused site(s) in 1 file(s) not mutated`.
5. Every existing OFF assertion unchanged: fewer mutants than `EXPECTED_ON`, `timeoutKilled` 0,
   at least one `error` with "could not be confirmed complete", a `deadline-exceeded` row and no
   `timeout` row, and `report.quarantined` set.

## What would falsify R447 rather than this file

- A second `hang-refused` row, or `sites` other than 2: the count or a filter is wrong.
- A mutant at line 104, or any `EXPECTED_ON` row changing: the split changed what the operators
  claim, which R447 must never do.
- `reliability` still `full` on either leg: the row did not reach `narrowed`.
