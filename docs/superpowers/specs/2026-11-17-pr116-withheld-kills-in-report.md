# PR-116 (R1108): name withheld kills in the report

Status: r1 (coord PR-116, lethal-preproc, 2026-11-17). Report-only: no verdict, cause, failure note or exit code changes.

## Why
- [[R1102]] (PR-106, PR-107): on DO, 557 of 868 error verdicts (run 15) are **withheld kills**. A covering test FAILED
  under the mutant, but al-runner v3 reported the failure as `NotRun` because an earlier test of the same codeunit was
  refused, or did not pass, so "the state it would have left is not BC's". The row text ends with
  `this failure is not trusted: <the assertion message>`.
- LethAL records such a mutant as `error` with cause `runner-refused`, the same as a mutant whose own path al-runner
  refuses. A reader sees "error" and a score that leaves those mutants out, with no word that a covering test detected
  them.
- Under isolation "auto" (R896/R921) the codeunits whose baseline shows the need run one test per session; PR-107
  measured 450 of 451 such errors become kills on DO, at +21 min of baseline and ~3x per mutant in moved codeunits. That is
  the remedy to name. The ruling (orchestrator, 2026-11-17): DO's default stays "test"; auto is a measured opt-in.

## What a withheld kill is (the one detection rule)
An `error` mutant whose `failureNote` contains al-runner v3's phrase `this failure is not trusted: ` (the trust rule; v3
writes it after an earlier refused test, R1102, and after an earlier failure, R967/R978, and after a timeout, R-637's
contract fact). The text after the phrase, up to v3's ` [al-runner v3 did not run this test` suffix when present, is the
withheld failure. When the note has the form `an earlier test of this codeunit was refused while it ran (<T>: ...` or
`a test before this one in the codeunit did not pass (<T>: ...`, `<T>` is the earlier test.

Only v3 writes the phrase. A mutant whose cause is not `runner-refused` is never a withheld kill (a guard against the
phrase appearing in a test's own assertion text: a `killed` mutant's `killingTestFailure` is never read).

## The change
1. **Per mutant:** `MutantRecord.withheldKill?: { readonly failure: string; readonly afterTest?: string }`, set only on
   such an error mutant. `cause`, `verdict` and `failureNote` are unchanged.
2. **Counts:** `counts.withheldKills: number`, the number of mutants with `withheldKill` (always present, 0 when none).
3. **Caveat** `withheld-kills`, pushed when `counts.withheldKills > 0`, with its `CAVEAT_INTERPRETATIONS` entry:
   - meaning: a covering test failed under each of these mutants, but al-runner v3 withheld the failure (the trust rule),
     so the mutant is `error`, outside `mutationScore`; the score is LOWER than it would be had al-runner trusted them
     (each is a kill BC would likely score);
   - remedy: run with `"alRunnerV3.isolation": "auto"` (the default; a config that forces "test" opts out), which runs
     the codeunits whose baseline shows refused tests one test per session; measured on DO: 450 of 451 such errors became
     kills, at about 21 min more baseline and about 3x the time per mutant in moved codeunits (R1102);
   - entailedNegative: not a kill LethAL counts, not a wrong verdict, not a statement that BC would kill every one (the
     earlier test's state is unknown); under isolation auto some remain (a codeunit auto keeps on "test").
   - basis: R1108.
   Never with `all-errors`? It may come with either `all-errors` or `some-errors` (a withheld kill is an error).
4. **Console:** one line after the score's error-range line, when the count is > 0:
   `N of the E error mutant(s) are withheld kills: a covering test failed under the mutant, but al-runner v3 did not trust
   the failure after an earlier refused test of its codeunit; the score leaves them out (validity.caveats "withheld-kills";
   isolation "auto" scores most of them, R1102).`
5. **`lethal explain`:** the caveat by reference (as every caveat), and a withheld-kill mutant's `withheldKill` in its
   not-measured entry if explain lists per-mutant causes.

## The ripple (CLAUDE.md "Adding a SessionReport field")
`events.ts` (if the mutant event carries the record), `report-fold.ts`, `report.ts` (type, builder, banner), `bun
scripts/generate-schemas.ts`, `tests/schemas.test.ts` (root-required list for `counts.withheldKills`; older reports
without it), `report-equality` snapshots, committed sample reports regenerated if the schema test requires the new count,
`CAVEAT_INTERPRETATIONS` and the caveat counts in `interpretation.test.ts` and `report.test.ts`.

## Tests (each red-checked both ways)
- detection: a `runner-refused` error whose note carries the phrase gets `withheldKill` with `failure` and `afterTest`;
  one without it does not; a `killed` mutant whose killingTestFailure contains the phrase does not; a non-`runner-refused`
  error with the phrase does not.
- counts and caveat: present iff count > 0; with `some-errors` and with `all-errors`.
- console line: printed iff count > 0, with N and E.
- the three v3 note shapes (after a refused test, after a failure, after a timeout) all detect.

## Gates
- The v3 gate: no pinned figure moves (verdict, cause/errorClass, killing test, note set, refusal set, warning codes are
  unchanged by construction; the new field and caveat are not compared). A moved figure is a BLOCK.
- No BC gate: the bcdev backend never writes the phrase, so a bcdev report gains only `counts.withheldKills: 0`.
