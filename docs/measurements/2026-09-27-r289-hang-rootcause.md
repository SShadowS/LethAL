# itest:hang M0004 failure: root-cause report (2026-09-27)

This is the offline analysis behind R289 (`docs/roadmap/R289.md`): whether R-236b's kept-answer
readback caused the `itest:hang` M0004 stop failure, or whether it is a pre-existing flake in the
stop path itself. Moved here from `.superpowers/sdd/` (session scratch, gitignored) so the evidence
lives in the repo. No customer source code; paths, counts and names are quoted as recorded.

Branch `lethal/lane-bugs` at `43f8e01`. No commits, no edits left behind. No live runs used.

## Verdict

The evidence supports **hypothesis 2, the pre-existing stop flake**: it is judged not caused by
R-236b, on the offline mechanism analysis below. What is NOT proven is why the stop did not land on
M0004: the one record that says so (the
verdict's `failureMessage`, which carries the watchdog's `stopDetail`) was in the quarantine record
and store the gate deletes, and the gate prints only the note.

## Evidence chain

1. **Which path ran.** `hang.itest.ts` passes no `groupRuns`, so `resolveGroupRuns` enables grouped
   runs (ceiling 300 000 ms, grace 30 000 ms). A 20 000 ms budget fits, so M0004's covering test ran
   through `runFencedMany` -> `RunMutantTransport.runMany` -> `runManyOnce` (watchdog, `StopHungRunAt`,
   the 408 rule). The same argument holds for the single path (`execute` -> `dispatch` first).

2. **The readback runs strictly after the classification, and cannot change it.** `runMany` calls
   `runManyOnce` first and reads back only when that result is already `in-flight-unknown`. The
   readback's only outcomes are (a) replace it with an all-pass/fail verdict set, which would have
   scored M0004, not quarantined it, or (b) append a reason to the failure text. It never touches
   `operation`. A 408-with-stop answer is `outcome: "timeout"` with no `operation`, so it never
   reaches the readback.

3. **The stop path is textually unchanged by R-236b.** The client diff since `35214ad` extracts
   `callOf` and `scoreManyAnswer` (both run after the body is in hand) and adds an OPTIONAL timeout to
   `postAction`; `GetOperationStatus` and `StopHungRunAt` still call it without one. The watchdog,
   `stopFired`/`stopConfirmed`, the hard cap and the 408 branch are byte-for-byte the same. Server
   side, `ControlState.Codeunit.al` (which holds `TryStopHungRunAt`) is unchanged; `RunMutantMany`
   changed only in its last statement (`KeepAnswer`), which a looping method never reaches.
   `GetOpAnswer` is a ReadCommitted read of a different table and writes nothing.

4. **Offline reproduction** (session scratch test, deleted from the tree; a permanent version of
   scenario B lives in `packages/runner/tests/run-mutant-many.test.ts`, describe block "runMany,
   a confirmed stop with no 408"), fake fetch, `stopHungSessions: true`, 1 s budget, server clock
   10 s elapsed:
   - A: `StopHungRunAt` answers `stopped: true` and the held request gets BC's stop 408. Result
     `timeout`; calls were `RunMutantMany, StopHungRunAt`; `GetOpAnswer` never called.
   - B: `StopHungRunAt` answers `stopped: true` but the 408 never comes. `runManyOnce` alone already
     returns `deadline-exceeded` / `in-flight-unknown` ("aborted at the hard cap"). Full `runMany`
     returns the same outcome and operation with only "; answer readback: ..." appended, and the
     call log shows `RunMutantMany-aborted` BEFORE `GetOpAnswer`. Both pass.
   The existing `run-mutant-many` and `run-mutant-transport` suites pass on HEAD (131 / 0).

5. **Why "stranded" rather than "result-lost" says the stop never committed.** A confirmed
   `TryStopHungRunAt` sets `Last Completed Op Seq := OpSeq` and commits before `stopped: true`
   returns. Then `reconcileLostAck` would read `completed` and the orchestrator would record
   `result-lost` (or retry), never the stranded note. The stranded note needs `unresolved`: the marker
   still named the op as running through the whole 330 s poll, or the status read failed. So the
   server-side stop did not land for this op: never fired (status polls failing or the row never
   "running" over budget), refused, threw, or StopSession blocked before its commit. Which one is in
   the lost `failureMessage`.

6. **Timing fits a hard-cap abort.** 640 s wall for setup, baseline and 4 mutants is consistent with
   M0004 running to the 330 s hard cap (300 s ceiling + 30 s grace), not with a 20 s stop.

7. **Same symptom without R-236b.** `docs/measurements/2026-09-27-nst-wedge-incidents.md` section 3
   (on master): 2026-09-26, Cronus28, control app 1.0.0.19, master client: the ON leg failed to stop
   the same M0004, the first hanging mutant of the ON leg. That run also wedged OData; this one did
   not (doctor ok after, and two more gates passed), so the aftermath differs but the failure point is
   identical.

8. **"No lost-reply-recovered warning" is not evidence either way.** `hang.itest.ts` passes no `emit`
   subscriber to `runSession`, so no warning of any code reaches its output.

## Proposed fix

Not an R-236b code change. File the flake as a roadmap item and make the gate able to name it next
time: on a failed leg, `hang.itest.ts` should print each `error` mutant's `failureMessage` (it
carries `stopDetail`: last stop refusal, last progress row, stop hook error) and the quarantine
record's `detail`, and print the run's warnings, before its `finally` deletes the scratch directory.
Pin it with a unit test on the gate's print helper (fed a report with one stranded `error` mutant, it
must emit the failure text containing "progress row:"), red-checked by removing the print.

The R-236b behaviour itself can be pinned with scenario B above as a permanent test in
`run-mutant-many.test.ts`: a confirmed stop with no 408 stays `in-flight-unknown`, and `GetOpAnswer`
is called only after the abort.

## Live runs

This analysis itself used no live runs: the offline evidence decides client versus server for
R-236b, since its client change sits downstream of the classification and its server change is
outside the hung path.

The orchestrator's A/B afterwards did use a live run: master's client (`03e276c`) on Cronus28 with
control 1.0.0.20 failed identically (M0004 quarantined, `4 !== 40`). So the A/B did decide client
versus flake for the client side: master's own client reproduces the same failure, which this
branch's client diff cannot explain. The server version remains unseparated: 1.0.0.19 was not
re-tested in that A/B, and the only other data point is master failing 1 of 3 on 1.0.0.19 on
2026-09-26. Full detail: `docs/roadmap/R289.md`, "Fourth check".
