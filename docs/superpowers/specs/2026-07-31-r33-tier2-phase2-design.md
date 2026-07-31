# R33 — Tier-2 Phase 2: what ships, and what is refused

**Status:** design, 2026-07-31, **revised after an adversarial review (Fable 5) and four follow-up
probes.** Spec §5 proposed three operators. **One ships, one is deferred with measured signal, one
is refused on cost.** Two conclusions in the first draft of this document were wrong; both are
recorded below rather than quietly corrected, because the wrong versions were written with exactly
the same confidence as the right ones.

## 1. `SwapRecXRec` — DEFERRED with MEASURED SIGNAL (the first draft said "refused"; wrong)

The spec made this one conditional on an experiment run *before* any operator code:

> When `Modify(true)` is driven from AL code rather than a page, `xRec` may carry the same values as
> `Rec`; LethAL drives every test headlessly. If `xRec` does not differ in that path, the operator
> is near-worthless in this execution model. **Go criterion: the two recorded values differ.**

Probe: `fixtures/sandbox-probes/src/RecXRecProbe.{Table,Codeunit}.al` — a table whose `OnModify`
raises with both values (the `Session Capability Probe` channel: a failure message is carried back
verbatim by every runner), and a test that inserts a row at `Amount = 100`, re-reads it, sets 250,
and calls `Modify(true)`.

Measured on Cronus281, 2026-07-31:

```
MEASURED rec.Amount=250 | xrec.Amount=250 | differ=No | rec.No=RX1 | xrec.No=RX1
```

Identical through the **fenced** path (`GuiAllowed=No`/`ODataV4`, where every verdict is produced)
and through the **hub** — so the answer is not a property of one runner.

**This document then concluded "the operator is not built" for every `xRec` site, which the
measurement does not support.** The go criterion was framed around `Modify(true)`; the probe
answered exactly that; the conclusion generalised to a site population it never touched. The review
named the overreach and two more probes settled it (`Tier2Phase2Probe`, same container, fenced):

| site | measured |
|---|---|
| `OnModify`, record-variable `Modify(true)` | `rec=250, xrec=250, differ=No` |
| field `OnValidate`, driven by `Validate(Amount, 250)` | `rec=250, xrec=100, **differ=Yes**` |
| `OnRename`, driven by `Rename('R2')` | `rec.No=R2, xrec.No=R1, **differ=Yes**` |

`OnValidate` is where AL's ubiquitous `if F <> xRec.F then` change detection lives, and `OnRename`
compares old and new keys — so `xRec` carries real information headlessly in exactly the trigger
kinds that read it. **A `SwapRecXRec` scoped to validate/rename sites has signal.** It is not built
in this pass (its own item, R71); what is settled here is that the blanket no-go was wrong.

## 2. `RemoveSetLoadFields` — REFUSED ON COST, and BOTH earlier reasonings were wrong

Shipped in a first pass, then removed after review. Both the original spec's framing and the first
justification written here were wrong, and the correction matters more than the outcome:

- **Wrong (v1):** "the kill paths that exist are pathological — an `asserterror` on reading an
  unloaded field, or on modifying a partial record."
- **Wrong (v2):** "there are no such errors at all; a field left out is fetched JIT on first access,
  so removing the call changes the SQL shape and nothing else. The mutant is **unkillable by
  construction**."
- **Measured** (`Tier2Phase2Probe.ReportsJitRereadOfDeletedRow`, Cronus281, 2026-07-31): the JIT
  fetch **rereads the row**, and rereading a row deleted since the partial read **raises** —
  `JIT loading of field(s): 'Amount' failed for table: 'Rec XRec Probe' ...`.

So the mutant **is** killable: with the call present that access raises, with it deleted the field
was already in memory and does not, and an `asserterror` distinguishes the two. v2's "unkillable by
construction" was an unmeasured platform claim written into the durable record — the exact failure
this project keeps paying for.

**It is still refused, now on cost rather than on impossibility.** The kill requires the row to be
deleted or changed between the partial read and the field access, which no ordinary suite arranges,
so on real code the operator emits near-universal survivors that say nothing about test quality. The
spec's own remedy (tag `likely-equivalent`, exclude from the score) already conceded it produces no
number. The difference from v2 matters: this is a judgment someone can argue with using a
measurement, not a claim about what BC can do.

**Consequence for the spec:** §5's `RemoveSetLoadFields` entry is superseded by this section. The
fixture's existing shapes (`DataMain.SetLoadFields(DataMain.Amount)`, `DataMain.SetLoadFields()`,
`Loader.SetLoadFields(3)`) stay as they are — they remain Tier-1 `void-method-call` sites, exactly
as today, so nothing in the frozen baseline moves.

## 3. `RemoveCommit` — SHIPS

Delete `Commit()`. **Fully scored, not hint-tagged**, per the spec: `WriteA; Commit(); Error(...)`
rolls `WriteA` back once the `Commit` is gone, which a transaction-boundary test can observe, and
hiding a real gap of that kind in an excluded bucket is the failure this operator exists to avoid.

Guards (`packages/builtin-tier2/src/remove-commit.ts`, predicate `claimsSystemCall` in
`receiver.ts`):

1. `isStatementPosition` — as for every deletion operator.
2. **Receiverless only.** The AL system `Commit` has no qualified form, so `X.Commit()` is by
   construction a project-declared procedure. The fixture has that shape (`Data Shadow` declares
   `Commit`; `Data Ops.ShadowedBuiltins` calls it).
3. **No enclosing declaration.** An unqualified call binds to the enclosing object's own procedure
   before the system function — the fixture's `Data Shadow.BumpViaCommit` is a bare `Commit()`
   inside the table that declares one. A `tableextension` of the enclosing table declaring `Commit`
   refuses too, on the same rule `claimsRecordMethod` applies to record methods.
4. `countArguments === 0` — the system `Commit` takes none.

Every refusal points the safe way: a missed site costs one operator's signal and Tier-1
`void-method-call` still covers it, while a wrong claim mislabels the mutation *and* deletes the
correct Tier-1 mutant at that site under §3.2 dedup precedence.

**Known limits:**
- The parenthesis-less `Commit;` parses as `call_statement`, never as a `procedure_call`, so it is
  silently not claimed. Tier-1 `void-method-call` targets `procedure_call` too, so **neither tier
  covers that form** — §3's general "Tier-1 still covers it" does not hold for this one shape.
- **`Commit()` is permitted and DOES execute in the fenced test run** — measured
  (`commit-executed=Yes`), which is the precondition for this operator having any signal at all. A
  first probe wrapped it in a `[TryFunction]` and BC refused the WRAPPER ("Call to the function
  'COMMIT' is not allowed inside the call to 'RunTests' when it is used as a TryFunction") — the
  probe measuring itself, R26's mistake, caught and corrected.
- **Not measured:** whether a committed write survives a later uncaught error under the test
  runner's isolation, which is the actual kill mechanism.

## 4. The platform artifact the report must distinguish

Spec §5: removing a `Commit` before a subsequent `Codeunit.Run(...)` produces BC's *"cannot run
codeunit in a write transaction"*. That is an **error-kill** — the mutation caused an observable
failure, but the failure says nothing about assertion quality, and counting it as a kill inflates
the score with a platform artifact.

**Not built in this pass, deliberately — filed as R72.** Nothing in any fixture has ever produced
that message, so a detector written now would match an ASSUMED string: the R31 shape (a diagnosis
that silently stops firing) resting on an unmeasured platform claim. The review also named a hole
any such detector must survive — `if not Codeunit.Run(...) then Error(PostFailedErr,
GetLastErrorText())` re-wraps the artifact in the caller's own message and defeats a text match.
Measure the artifact live, pin its text, then write the detector.

Direction chosen for when it IS built: **annotate, do not reclassify.** The verdict stays `killed` (the mutation did
cause observable misbehaviour, the same reasoning design §6.7 applies to a timeout), and the report
names the artifact so a reader does not read it as a test-quality signal. Reclassifying to `error`
would discard a real observation; leaving it silent would inflate the number.

## 5. Testing and gates

- Unit: the operator's four guards, each red-checked, with the fixture's real negative shapes as
  the cases.
- Fixture: **no positive is added in this pass.** A `Commit()` in an object declaring no `Commit`
  would land `no-coverage`, not `survived`, unless a covering test were added with it — the review
  caught that; `survived` requires a test to EXECUTE the procedure. Both fixture `Commit` sites are
  negatives today and both are correctly refused, verified offline: registering the operator leaves
  `sandbox-data` at 93 specs and `sandbox-app` at 16, with zero `remove-commit` specs. The operator
  therefore ships PROVEN ON ITS REFUSALS and unproven on its claims. Filed as R73.
- Gates: `itest:tables` (primary — new site, new mutant, baseline moves by construction) and
  `itest:bcdev`. Per-mutant on the pre-existing set.

## 6. What this does NOT prove

- No live evidence that `RemoveCommit` is ever KILLED: the fixture's mutant is expected to survive,
  and no gate contains a transaction-boundary test. The operator's claim/refusal behaviour is
  proven; its kill signal is not.
- The write-transaction artifact detector is unit-only for the same reason — nothing in the
  fixtures runs a `Codeunit.Run` after a commit.
- `SwapRecXRec`'s measurement is one table on one BC 28 container. It is decisive for this
  execution model, not a statement about `xRec` on a page.
