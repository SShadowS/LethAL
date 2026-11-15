# PR-37 pre-commitment: R1050, `empty-block` that freezes a loop's progress is hang-refused

Status: pre-commitment (coord PR-37, lethal-code, 2026-11-15), after the build (lethal/pr-37) and its offline measurement, before the
emit golden's re-record, VERIFY on the final head and any gate. Design approved by the orchestrator (2026-11-15). Related: R1050,
R830, R837 (closed by ruling; it stands), R196, R818, R829 (the safe direction). Evidence: `/coord/handoff/PR-37/`.

## Ground truth (an invented reduction of PR-34's M0332 shape, `/coord/handoff/PR-37/shape/`)

A caller's `while Length <> 0` loop advances only when a same-object callee `ReadUntil(..., var Position)` moves `Position`
(`Length` follows through `Text := CopyStr(Text, Position)` and `Length := StrLen(Text)` in the loop body). On al-runner v3, 7 of
16 mutants hang: the `empty-block` of the callee's body (M0332's shape), its other 5 sites (the `Length` assignment, 4 on its own
`while`), and the `empty-block` of the caller's `if Position > 1 then begin .. end` block, which holds `Length := StrLen(Text)`
(that statement's own `remove-assignment` is already refused). R1050's premise that "R830 refuses deleting the call" does not
hold: a bare same-object call is not a `void-method-call` target.

## The change (`packages/builtin-tier1/src/loop-hazard.ts`, `openItemHangRefuses`, `lethal.empty-block` only)

1. **`emptiedProgressCalleeHangs` (R1050).** `empty-block` on a procedure's own body is refused when a call to that procedure in
   the same object sits in a `while`/`repeat` whose exit reads (`exitEffect`, which already follows the loop body's assignments,
   R818) a name the call can move: the callee chain's writes (`chainEffect`), or an argument bound to a `var` parameter (an
   argument by value cannot be moved: build review fix; an unreadable parameter counts as `var`).
2. **`emptiedRefusedBlockHangs` (consistency).** `empty-block` on a block inside such a loop is refused when the block holds an
   assignment to a name the loop's exit reads (and does not step), or a progress call (`callIsProgress`, R830): each is already
   refused on its own, and emptying the block removes it the same way.
Not refused, by R837's ruling: the other sites inside such a callee (5 of the 7 hangs in the shape). On a BC server those stay
hang-capable; the safety net is the zero-timeout check and `--stop-hung-sessions` (PR-34 addendum 2). R830's own refusals,
`callIsProgress` and `exitEffect` are unchanged.

## Measured before this commitment

- **Fixtures** (dry run of every target fixture, `dry-before/` vs `dry-after/`): one site changes in one fixture:
  `sandbox-optin`'s `OptinLogic.Codeunit.al:130` `empty-block` (`ResetCounter`'s body; the loop `while Counter < N` reads
  `Counter`, which the callee resets) is now refused. It would not hang (it removes a reset), the same over-approximation R830
  accepts for deleting that call (R829). No other fixture's site list changes, so no gate's mutant set changes.
- **Corpus** (72 BC.History modules, the PR-34 clock count's roots; `corpus-diff.txt`): 26 sites newly refused in 11 modules,
  none newly allowed. Against the earlier v3 run of each (R-969/R-961/R-953/R-964 stores): 4 `timeout-killed` (Bank Account
  Reconciliation 2, Filter Tokens 2 = PR-03's M0043, M0338), 8 killed, 3 survived, 3 error, 8 no-coverage. Those 4 are every
  `empty-block` hang in these stores; 8 other hangs (other operators, R837's family) remain. Cost: 11 scored mutants for 4 hangs.

## Predictions

1. Unit tests: the new file `packages/builtin-tier1/tests/r1050-emptied-progress.test.ts` (6 tests, each red-checked) passes;
   VERIFY FULL passes after the one change below.
2. The emit golden (`packages/runner/tests/__fixtures__/instrumented-output-golden.json`, R-307 O8) changes in exactly one entry,
   `fixtures/sandbox-optin/src/OptinLogic.Codeunit.al` (its instrumented output loses line 130's mutant). This commitment asks the
   orchestrator's ruling for that one re-record (the test's own rule); every other entry, and the reach-grain golden, unchanged.
3. Gates: no gate fixture's site list changes, so `itest:alrunner-v3` passes every leg, and `itest:hang`, `itest:harden` and the
   bcdev gates are predicted unchanged (not run: their mutant sets are identical by the dry run; the v3 gate runs).

## Addendum 1 (2026-11-15, after the Opus build review, before the golden re-record, VERIFY and any gate)

**Review fixes** (lethal/pr-37 94790266). Three hangs the first build missed, each an `empty-block` of a callee body, now refused:
B, a progress callee one call further down (`StepB(Pos)` -> `AdvB(var P)`: progress procedures are a per-object fixpoint over
same-object calls that move a name the caller moves); C, a value-returning callee whose result is assigned to a name the exit reads
(`Pos := NextC(Pos)`); D, a value-returning callee called in the loop's exit (`until IsDone()`). D is refined by the callee's
default return (0, false, ''): when the exit is the call, its `not`, or a comparison with a literal, and the default makes the loop
exit at once, the call is not progress (keeps `sandbox-hang`'s `until NextRow() = 0`, frozen as `survived` in
`hang.single.baseline.json`). Calls are indexed per object. Tests: 18 in `r1050-emptied-progress.test.ts`, red-checked.
The review's two other shapes (a progress call inside an assignment; emptying the block that holds a loop's only exit) are R1052.

**Re-measured, replacing the figures above:**
- Fixtures (`dry-after3/`): only `sandbox-optin`'s `OptinLogic.Codeunit.al` changes, sites 124 -> 122: line 130 (`ResetCounter`'s
  body, as above) and line 257 (`Consume(Left): Integer`'s body, called as `Remaining := Consume(Remaining)` under
  `while Remaining > 0`: refused by C; it does not hang, the default 0 exits, R829's trade). `sandbox-hang` and every other fixture
  unchanged, so no gate's mutant set moves.
- Corpus (`corpus-diff2.txt`, `classify2.txt`): 53 sites refused in 13 modules (was 26 in 11), none newly allowed. Earlier v3
  verdicts: 4 timeout-killed (the same 4 hangs), 25 killed, 3 survived, 13 error, 8 no-coverage: **28 scored mutants lost for 4
  hangs, about 1 in 8** (was 11, 1 in 4). The review fixes added 27 sites and no hang met in this corpus; most of the extra cost is
  B's transitive step in Filter Tokens (11 helper bodies, all killed). Accepted by the orchestrator (2026-11-15) for server safety;
  narrowing B's step is the follow-up [[R1053]].

**Prediction 2 replaced:** the emit golden changes in exactly one entry, `fixtures/sandbox-optin/src/OptinLogic.Codeunit.al`, 124 ->
122 mutants (lines 130 and 257 leave its output); the orchestrator's ruling covers both sites. Every other entry and the reach-grain
golden byte-identical; with mutant ids normalized, the entry's output differs only by those two mutants' guards.
