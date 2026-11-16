# PR-53 pre-commitment: the SetFilter-Boolean refusal joins the keep-list; rule A's assignment variant; a proposal for a general fix

Status: pre-commitment (coord PR-53, lethal-code, 2026-11-16), before the build. DO window t7 (`/coord/handoff/R-984/`): 35 of 68
daemon closes came from one baseline-refused test, sent once per mutant request. That is PR-47's GoToKey pattern again. Evidence:
`/coord/handoff/PR-53/`. Invented AL only.

## 1. The keep entry (PR-47's method)

The refusal: `NotRun: out-of-scope: SetFilter: a Boolean filter value under GlobalLanguage <n> (the words of that language are not
pinned)`. The pinned source (`crates/al-builtins/src/filter_boolean_words.rs`) refuses `SetFilter` on a Boolean field for every
word under any language other than 1033, 1031 or 1036.

**Measured CLEAN, before this pre-commitment** (`/coord/handoff/PR-53/README.md`). The method is R-967's kit, on edge-5a58a0f16 with
`ALRUNNER_SEED=1`. The refuser does R-937's standard writes, then `GlobalLanguage(1030); Rec.SetFilter(Flag, 'Ja');`:
- 47 of 47 answers carry the text;
- on a kept daemon, 27 of 27 readers equal the control;
- 20 fresh daemons give one answer, equal to it;
- the pid stays constant, and there is no panic.
A reader added for this case reports `GlobalLanguage()`. It reads 1033 after every refusal, kept and fresh, so the language set
inside the refused test does not carry into the next test.

The change: `V3_SERVE_SAFE_REFUSALS` gains this text. The language number is a parameter (digits), and the rest is literal and
anchored at both ends. Leg C's `serve-keep-reasons` gains the invented case.

## 2. Rule A's assignment variant (DO t7's new timeout, CDOEMailSignature:254)

`lethal.toggle-blank-string` on the blank literal of `X := ''` inside a loop is hang-refused when the loop's exit needs X blank,
read with rule A's polarity walk (PR-44): `while X <> ''`, or `until X = ''`. Toggled, X never empties. The assignment must be a
direct statement in the loop body or in a branch of it. Acceptance as PR-44, measured alone:
- the 72 BC.History modules, DO and every fixture;
- kept at zero scored sites lost, or at PR-37's bar (about 1 hang per 8);
- no fixture site and no golden may move;
- DO's line 254 must be refused.

## 3. The general fix: a proposal, not built

**The problem.** Each refusal text that is not on the keep-list costs a DO window a daemon restart per mutant request, whenever a
baseline-refused test sits mid-codeunit (the GoToKey case in t6, SetFilter in t7). Each fix today is one measured keep entry,
learned after a window has paid for it.

**The evidence.** Every refusal measured for keeping has been clean:
- R-937's 17 families;
- PR-29's stale buffer;
- PR-47's GoToKey;
- PR-53's SetFilter.
In the pinned source, a refused test's store writes are rolled back (`roll_back_refused_test`), and page and handler state lives in
a per-codeunit session (PR-47's review).

**The proposed fix: invert the keep-list.** Keep the daemon after ANY `notRun` refusal row, and close it only for:
- a timeout row;
- a panic or protocol error;
- a deny-list of refusal texts measured NOT clean (none so far).

**Before building:**
- (a) Ask upstream whether `serve` guarantees a clean session after any `notRun` refusal (state rolled back, nothing kept but
  the store's rollback).
- (b) Run R-967's kit over every refusal family the refusal ledger lists, at least one cell each, as a census, not one measurement
  per window.
- (c) Write a pre-commitment with the census as its evidence.

**Alternatives considered:**
- Leaving a mid-order refused test out of mutant entries (PR-47's option B). It changes the state that later tests start from. Out
  of scope, as before.
- Learning keep entries at run time (measuring the first close of a new text in the run). Costly and complex.

## 4. Filed, not built

The filter-before-copy-loop hang from t7 (CDODocumentTemplateLine:1636): R1069.

## Predictions
1. Unit tests, red both ways: the keep entry matches the measured text, with other language numbers, and refuses a reworded one;
   rule A's variant refuses and keeps as above.
2. `itest:alrunner-v3` passes every leg; leg C's case reads as a kept refusal.
3. DO's next window: this family closes no daemon in a mutant request.
