# PR-44 pre-commitment: hang refusals for t5's remaining real-hang shapes (PR-41 step 2)

Status: pre-commitment (coord PR-44, lethal-code, 2026-11-16), before the build. It lands only after lethal-bugs confirms DO window
t7 has started: t7 pins its own head, and a change to the mutation set would void its baseline reuse. Evidence:
`/coord/handoff/R-984/t5-timeouts.md`, `/coord/handoff/R-984/t6.run.report.json`, `/coord/handoff/PR-44/`. Method: PR-37's
(`2026-11-15-pr37-r1050-emptied-progress.md`). Invented AL only in anything committed.

## The five t5 hangs, on t6's head (PR-37 in)

| t5 mutant | shape | on t6's head |
|---|---|---|
| M11940 | empty-block of the block that clears the loop's variable | gone: R1050 refuses it |
| M11468 | `toggle-blank-string` on the `''` of `until X = ''`, X refilled in the body | still mutated; timeout-killed in t6 |
| M11934 | `toggle-blank-string` on the `''` of `while X <> ''`, X cut down in the body | still mutated; timeout-killed in t6 |
| M7544 | `remove-assignment` of a batch size set before the loop, read by the outer loop's exit (`until N < Size`) | still mutated; timeout-killed in t6 |
| M10450 | `void-method-call` in a record loop | killed by a real failure in t6, not a hang; line mapping uncertain. Not addressed |

## The rules (`loop-hazard.ts`)

- **Rule A.** `lethal.toggle-blank-string` is hang-refused on a blank string literal that is a direct operand of `=` or `<>` when:
  - that comparison is a loop's exit condition: the whole `until` or `while` condition, or an operand of a top-level `and`/`or`
    in it;
  - and the other operand is a name the loop body writes (the names R196 already reads).
  Toggling that literal makes the exit unreachable whenever the name converges to blank.
- **Rule B.** `lethal.remove-assignment` is hang-refused on `X := <literal or expression>` in straight-line code before a loop
  of the same procedure, when the loop's exit condition reads X and the loop body does not write X. Removing it leaves X at its
  default, which can make the exit unreachable (M7544: a size of 0 is never above the count).
- R837's ruling stands: no callee-side extension.

## Acceptance (measured before the build lands)

Each rule is measured alone. The method:
- dry-run the corpus (72 BC.History modules and DO) before and after;
- list the sites the rule removes;
- classify each against the stored verdicts (timeout-killed / killed / survived / error / no-coverage), as PR-37's
  `classify2.txt`.

A rule is kept only if its hang rate is at least PR-37's accepted one, about 1 hang per 8 removed scored sites, counting
timeout-killed as a hang. A rule below that is dropped, and an addendum gives its figures. Rule B is expected to be the weaker:
most loop bounds set before a loop end the loop when left at their default.

## Predictions

1. Unit tests, red both ways, per rule:
   - rule A refuses `until X = ''` / `while X <> ''` with X written in the body;
   - rule A keeps a blank literal in a comparison that is not the exit, and one whose other operand the body does not write;
   - rule B refuses the before-the-loop assignment of an exit-read name;
   - rule B keeps the assignment when the body writes the name, or when the exit does not read it.
2. Fixtures: the dry-run of every `fixtures/*` project is unchanged, or each moved site is named before any gate. A moved emit
   golden needs the orchestrator's ruling, as PR-37's did.
3. DO's mutation set loses M11468's, M11934's and (rule B kept) M7544's sites, plus the others the corpus diff lists.
   `itest:alrunner-v3` passes every leg.
4. From t8 on, DO's mutant phase has no timeout close from these shapes.

## Addendum 1 (2026-11-16, the measurement; the orchestrator's ruling: rule A alone)

Measured (`/coord/handoff/PR-44/measure.md`; corpus before = PR-37's `corpus-after2`, unchanged since; DO against t6's report,
t5's for sites t6 never reached):
- **Rule A** removes 1 corpus site (killed) and 6 DO sites (3 timeout-killed: M11468's, M11934's and a third t6 timeout, at line
  247 of the same table; 1 killed, 1 no-coverage, 1 never reached). That is **3 hangs per 5 scored sites lost**, far above PR-37's
  1 per 8. No fixture site moves and no golden moves. **Kept.**
- **Rule B** removes 11 corpus sites (1 timeout-killed, 1 killed, 4 survived, 3 error, 3 no-coverage) and 15 DO sites (1
  timeout-killed: M7544; 1 survived, 1 error, 7 no-coverage, 5 never reached). That is 2 hangs per 8, just at the bar. But it also
  removes 3 sites of `fixtures/sandbox-hang` (rows of `hang.single.baseline.json`, so `itest:hang` would BLOCK) and 1 of
  `sandbox-optin`, moving 6 emit goldens. All 4 are false positives: their loops progress through an event subscriber that the body
  analysis cannot see (R830's blind spot), and removing an initial `Counter := 0` does not hang. **Dropped** by ruling, filed as
  R1061 with the narrowing it needs.

So prediction 2 holds with no moved site. Prediction 3 loses M11468's and M11934's sites and the third, but not M7544's: R1061
covers it.

## Addendum 2 (2026-11-16, after the Opus build review, before any gate): rule A follows the exit's polarity

Rule A as built climbed any `and`/`or` and accepted `=` and `<>` alike, so it also refused exits a toggle cannot hang. Examples:
- `until X <> ''` or `while X = ''`: the toggle ends the loop sooner;
- `until (X = '') or (N > 10)`: the other side still ends the loop;
- one of the six DO sites it removed was such an exit (`... <> '') or (... Next() = 0)`).

Once X has emptied, the toggled comparison is fixed: `=` is false, `<>` is true. A `not` flips it. Rule A now follows that value
up to the loop, as R572's walk does:
- it continues through `and` only while the value is false, and through `or` only while it is true;
- it refuses a `repeat ... until` only when the exit stays false, and a `while` only when it stays true.
The three measured hangs and the corpus site keep their refusal. The false positive stays mutated. That makes 3 hangs per 4 scored
sites lost. The call-wrapped operand (`until DelChr(X) = ''`) stays out of scope: no measured hang has it.

**Predictions, added to 1.** Each red both ways:
- refuse `until (X = '') and (N > 0)`, `while (X <> '') or (N < 3)` and `until not (X <> '')`;
- keep `until (X = '') or (N > 10)`, `while (X <> '') and (N < 3)`, `until X <> ''` and `while X = ''`.
