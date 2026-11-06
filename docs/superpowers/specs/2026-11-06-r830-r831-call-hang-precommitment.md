# R830 and R831 pre-commitment: a call a loop's progress rests on, and array elements (coord task R-833)

Build: `lethal/r833` at 37084799, dumped against master's cached dump at 22effbcd (production identity keys, every operator). Dumps ran
before any live gate. Evidence, with the removed sites: `/coord/handoff/R-833/final/`.

## Rule
At dispatch, for every operator (`openItemHangRefuses`), a statement call is refused when, in any enclosing `while` or `repeat`, the loop's
exit parts read a name the call can move, and no `Next`, `Read` or `MoveNext` there moves that name. The names are the call's receiver,
the base name of each argument, and what a same-object callee chain writes, to any depth. An array element reads as its array, an index
on an assignment's left side is a feed, and a mutant inside it is refused. Over-refusal is accepted: a wrong refusal loses one mutant, a
miss can end a run. Timeout and quarantine are not a guard on BC 29 on Linux until #49 lands.

Not seen, filed: a site inside the callee (R837), `empty-block` of an arm inside a loop (R838), another object or an event (R839).

## Figures, frozen
| corpus | specs | hang-refused | removed | ordinals moved |
|---|---|---|---|---|
| fixtures (25) | sandbox-hang only: 38 = | 2 = | see below | 0 |
| CDO | 56098 > 56067 | 504 > 535 | 23 | 1 |
| DO | 76685 > 76663 | 612 > 634 | 22 | 1 |
| DC | 196180 > 195954 | 2605 > 2831 | 205 | 5 |
| BC.History (519) | 1905449 > 1903854 | 63801 > 65396 | 1470 | 42 |

Every corpus: 0 keys added, 0 tags moved, 0 tuples moved. "specs" is counted before dedup and "removed" is deployed keys after it, so a
call both a Tier 1 and a Tier 2 operator claim is two specs and one key. That is why a spec difference can exceed "removed". The fixture row shows 38 keys
removed and 38 added on `sandbox-hang` alone, and that is byte offsets: its text moved, its 38 mutants did not. No other fixture key moves.

By operator:
- CDO: remove-setrange 8, void-method-call 15.
- DO: void-method-call 22.
- DC: flip-boolean-literal 3, remove-assignment 18, remove-setrange 21, swap-call-arguments 1, swap-find-direction 4, swap-modify-flag 3,
  void-method-call 155.
- BC.History: the full list is in `diff-bch.log`. The largest are void-method-call 1189, remove-setrange 95, swap-call-arguments 95,
  remove-testfield 24, remove-assignment 23, swap-find-direction 13.

## Scheme
Ordinals move, so `IDENTITY_SCHEME` goes 44 > 45. `void-method-call`'s `operatorVersion` does not move. Ruling (orchestrator, 2026-11-06): 11
baselines stay at 44 under R836, and lethal-code records them once after this lands. `explain.ts` withholds `unobservedBlock` for any
file with a `hang-refused` row, so a file that gains its first row loses that field. That is correct.

## `fixtures/sandbox-hang`
The two loops called `Advance()`, a same-object callee, which the rule now refuses, and `itest:hang` needs them. They now call
`OnAdvance()`, an `IntegrationEvent` with an empty body, and `Advance` is its subscriber in a `SingleInstance` codeunit, a shape the rule
does not see (R839). No line moves. The version stays 1.0.0.4: nothing public changed, and a bump needs a new symbol tar.

**Predictions for `itest:hang`, all legs, bc2 then bc3:**
1. Every row of `EXPECTED_ON` holds: the same 38 mutants, verdicts, lines and `killPosition`.
2. SINGLE: 24 killed, 9 survived, 5 timeout-killed. Each `HANG_FIGURES` constant holds.
3. The BASELINE leg's figures hold, and one `hang-refused` row with 2 sites stays.
4. `hang.single.baseline.json` changes in its scheme (44 > 45), and in the text of the two `void-method-call` rows on lines 37 and 145, and
   nothing else. It is re-recorded on bc2 by R332's procedure, then confirmed through `scripts/r658-hang-gate.sh` on bc2 and on bc3.

**Risk these predictions test.** Whether the subscriber fires under the fenced session and `RunMutantMany` is not measured. If it does not,
`CountUpTo` hangs at baseline, loudly. `SingleInstance` keeps `Counter` for a session: line 143's `Counter := 0` deletion is predicted
to stay survived because each mutant run gets a fresh session. If any row moves, that is a BLOCK and this document is amended first.

**A stale build cannot pass unseen.** The old text hangs the same way, so no verdict tells them apart, and the version does not move. Two
checks: the gate asserts that lines 37 and 145's mutant text is `OnAdvance()`, and LethAL compiles the instrumented target from the local
source on every run and refuses to go on unless the running build echoes that artifact's id.

## Gates on the final head
`itest:hang` on bc2 and bc3, `itest:alrunner-v3`, `itest:lend` on bc2. bc1 is out of use. No figure may differ from the above.

## Not sampled
The over-refusal was not sampled by hand. R829's rule accepts it.

## Addendum 1, after the record run on bc2 (2026-11-06)

**Prediction 4 was too narrow.** The ON leg passed every row, and SINGLE recorded 24 killed, 9 survived, 5 timeout-killed, so the event fires
under the fenced session. As multisets of procedure, operator, verdict, killing test, filter and error class, the 38 rows did not move.
Four keys moved, not two: the two `void-method-call` rows on lines 37 and 145, and the two `empty-block` rows of `CountUpTo` and `SpinUntil`,
whose blocks hold that call. No mutated-text hash moved. The file shows a larger diff only because rows sort by key. This replaces
prediction 4, and the confirm runs on bc2 and bc3 must pass against that record. The recorded file: `/coord/handoff/R-833/record/`.

**The build moved after these figures.** The opus delta review of 37084799 found six narrow misses, which are fixed and red-checked:
`Rec.P()` and `CurrReport.P()` as same-object calls, a callee's `Rec.Qty` read, a `foreach` variable, a named return, and an option value
named like a procedure. They add refusals, so the corpus figures above are replaced by Addendum 2. No `sandbox-hang` site is affected:
the table of predictions above stands. Filed, not tuned: [[R846]], the safe mutants by-name refusal costs.
