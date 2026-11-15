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
