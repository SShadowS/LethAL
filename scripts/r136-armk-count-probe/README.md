# R136 arm K probe -- why does `DoubleInsertWithoutKeyTriggerRaises` fail at BASELINE?

**Answer: `Record.Init()` does not reset a primary key field back to blank when called again on a
Record variable that was already used for a prior `Insert()` in the same transaction.** The leading
hypothesis going in -- that `Count()` returns 0 on both of two back-to-back `Insert(true)` calls --
turned out to be a red herring: three completely different counting mechanisms (`Count()`, a
table-level `var`, a `SingleInstance` codeunit counter) all failed IDENTICALLY, which was the tell
that the counting mechanism was never the problem. The actual bug is one level up, in the loop's
own `Init()` call.

Measured 2026-08-13 against **Cronus283** (the same container `fixtures/sandbox-data`/
`fixtures/sandbox-data-tests` target), via the `bc-dev` MCP tool's `bcdev_test_run` and
`bcdev_test_orchestrate`, and separately confirmed against the real fixture through the fenced
`RunMutant` path (a diagnostic replay script, not committed here) to rule out a hub-vs-fenced
execution difference.

## Why this exists

The live tables gate re-run for R136 came back with `baselineGreen=false`, all eleven of the
wave's new covering tests failing including `Data Tests.DoubleInsertWithoutKeyTriggerRaises`
(arm K), plus five mutants at `DataFlagOps.Codeunit.al` lines 76-79 recorded `error`
("unsupported test type: mutant covered only by test(s) that did not pass at baseline"). The
pre-commitment had recorded the `Count()`-inside-`OnInsert` premise as a lesser, judged-cosmetic
risk ("either reading leaves the baseline green"); the gate contradicted that, which is the
finding this probe exists to pin down precisely.

## BC's verbatim error

Both the hub (`bcdev_test_run` against the published test app) and the fenced `RunMutant` path
(replaying the exact baseline call the gate uses) return, byte-for-byte:

```
The record in table Data Key Probe already exists. Identification fields and values: No.='KEY-1'
```

Both inserts computed the SAME key. Since the key is `'KEY-' + Format(Count() + 1)`, this alone
already proves `Count()` (or whatever fed the key) returned `0` on the SECOND `OnInsert`, not `1` --
but it does not by itself say WHY.

## The investigation, round by round

1. **Reproduced the failure in an isolated probe** (`table 71591 "ArmK Count Probe"`, the identical
   `if "No." = '' then "No." := 'KEY-' + Format(Count() + 1);` trigger) with the exact real calling
   shape: a separate codeunit (`ArmK Count Probe Ops`) holding
   `for i := 1 to 2 do begin KeyProbe.Init(); KeyProbe.Insert(true); end;`, called from a test that
   asserts nothing -- matching `Data Flag Ops.InsertTwiceWithKeyTrigger` and
   `Data Tests.DoubleInsertWithoutKeyTriggerRaises` exactly. **Reproduced.**
2. **Ruled out fenced-vs-hub.** The real fixture's own test was run through BOTH the hub
   (`bcdev_test_run` against codeunit 79310) and the fenced `RunMutant` path (a direct replay
   against the live registered artifact). Identical error, identical key. Not a path difference.
3. **Ruled out call-frame indirection.** Moving the loop inline into the test body (no separate
   called codeunit) reproduced the identical failure. Not a call-depth difference.
4. **Tried three different counting mechanisms, all failed identically:**
   - `Count()` (the real fixture's own mechanism).
   - A table-level `var Integer` counter incremented inside `OnInsert`.
   - A `SingleInstance` codeunit counter (`ArmK Key Sequence`, whose state a `Record.Init()` call
     cannot touch by construction -- SingleInstance state belongs to a different object entirely).

   All three produced the exact same `'KEY-1'` collision. Since a `SingleInstance` codeunit's
   in-memory counter genuinely cannot be affected by anything happening to a `Record` variable, its
   failure is what forced abandoning the "the counter is stale" theory -- the counter was never
   being asked the right question, or was never being reached at all.
5. **Decisive isolation test, `CheckNoAfterReInit`:** insert one row (`"No." := 'MANUAL1'`) on a
   Record variable, then call `Init()` again on that SAME variable, then read `"No."` back.
   **Result: `"No."` still reads `'MANUAL1'`, not blank.** `Init()` does not reset the primary key
   field of a record variable that already holds a value from a prior `Insert()` on itself in the
   same transaction.
6. **Confirmed `Clear()` behaves differently:** the same sequence but with `Clear(Probe)` instead
   of a second `Init()` correctly reports `"No." = ''`.

So the real mechanism: on the loop's second iteration, `KeyProbe.Init();` leaves `"No."` still set
to `'KEY-1'` from the first iteration's trigger-assigned value. The trigger's own
`if "No." = '' then` guard therefore evaluates FALSE, the key-assignment logic never runs at all
(regardless of what mechanism it would have used), and the second `Insert(true)` attempts to
insert a SECOND row with the SAME key the first row already holds. This happens at BASELINE
(`Insert(true)`, trigger fully enabled) exactly as much as it would with any other counting
approach, because the bug is in the loop's failure to re-arm the guard, not in `Count()`.

## Candidate fixes measured, cheapest first

All three were verified against the REAL fixture's unmodified `Count()`-based trigger (round 5
above reverted the probe table to the exact `fixtures/sandbox-data/src/DataKeyProbe.Table.al`
body), changing only the calling loop:

| candidate | result | new claimable sites | identity cost |
|---|---|---|---|
| `Clear(KeyProbe);` instead of `KeyProbe.Init();` | **fixes it**, 3/3 stable passes | zero | changes the AST shape (and therefore the baseline hash) of BOTH the existing `void-method-call` mutant at that call AND the enclosing `empty-block` mutant, because the call arity changes (0-arg `Init()` -> 1-arg `Clear(KeyProbe)`) |
| Add `KeyProbe."No." := '';` right after the existing `KeyProbe.Init();`, otherwise unchanged | **fixes it**, 3/3 stable passes | zero -- a plain assignment statement is claimed by no operator in this product | changes the AST shape (hash) of ONLY the enclosing `empty-block` mutant on the loop body, because adding any statement to that block changes its span's shape regardless of whether the new statement is itself claimable. `Init()`'s and `Insert(true)`'s own mutants are completely untouched. |

**The second candidate is strictly cheaper**: it re-keys exactly one existing mutant
(`empty-block` on the loop body) instead of two, and every other mutant at the site --
`void-method-call` on `Init()`, `void-method-call` on `Insert(true)`, `swap-modify-flag` on
`Insert(true)` -- keeps its exact original identity untouched.

## What this does NOT establish

- Whether `Init()`'s key-preserving behavior after a same-variable `Insert()` is documented
  Microsoft platform behavior or an internal implementation detail. Not investigated here; the
  probe only needed to know THAT it happens, not why.
- Whether the same holds for composite (multi-field) primary keys, or for `Insert()` calls made
  through `Codeunit.Run` or another indirection layer. Only the single-`Code[20]`-key,
  same-procedure-loop shape `Data Key Probe`/arm K actually uses was measured.

## Reproducing

Same recipe as `scripts/r136-armc-probe/`: id range 71590-71600 (this probe uses 71591 for the
table and 71592 for the test codeunit; earlier rounds also used 71593-71595, now removed),
compile against a copy of `fixtures/sandbox-data-tests/.alpackages`'s base symbols, publish to
Cronus283 with `Publish-BcContainerApp -useDevEndpoint -syncMode ForceSync -install`, drive with
the `bc-dev` MCP tool's `bcdev_test_discover`/`bcdev_test_run`/`bcdev_test_orchestrate`. Unpublish
when finished:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus283 -name 'LethAL R136 ArmK Count Probe' -unInstall -doNotSaveData -force
```
