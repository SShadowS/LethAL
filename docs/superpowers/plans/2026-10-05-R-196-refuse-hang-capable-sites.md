# Plan: R-196 (closes R196 and R239)

Worktree `/work/lethal-wt/r196`, branch `lethal/r196` off master `8c6dcf4b`. Mode: smallest change.
Prototype: `/coord/handoff/R-196/prototype.patch` (applies cleanly; the worktree is clean). It is
for counting only: it refuses in `generate()` alone and lacks items 5 and 6 of section 4.
Reviewed by gpt-6.1-sol: `/coord/handoff/R-196/review-gpt-6.1-sol.md`. All 7 findings are folded
in (identity scheme bump, `#if` tails, R402 tests, targets/generate agreement, same-loop controls,
narrowed claims, M-code renumbering scope).

## 1. What is already there (read before planning)

R196 is half built. Plan B1 (commits `81e7f653`..`1e8f121c`) shipped ONE shared detector,
`packages/builtin-tier1/src/loop-hazard.ts`:

- `classifyHangCapable(assignment, ctx)`: the assignment's target is read by the condition of an
  enclosing `while`/`repeat` (resolved by declaration, never by name; `for` excluded; preheader,
  body-only reads and progress through a call are out of scope).
- `hangCapableForMutatedNode(node, ctx)`: walks from a mutated node to its assignment (value side
  only) and asks the question above.

All four value operators (`remove-assignment`, `shift-integer`, `swap-additive`,
`flip-boolean-literal`) already call it and TAG the spec `hangCapable: "loop-condition-target"`.
The tag travels to the manifest, `MutantOutcome.hangCapable`, and `hangCapableCount` on
`mutation-set-generated`, plus a pre-deploy warning `hang-capable-sites-deployed`.

What the tag does at run time today: **nothing**. Plan B2 (the forced per-mutant session stop,
design `docs/superpowers/specs/2026-09-06-r196-hang-capable-design.md` sections 5 to 8) was never
built. The warning itself says so: with `--stop-hung-sessions` off, a tagged mutant strands its
tier like any other timeout. So the 40-minute cost R196 measured is still fully paid.

The other loop refusals, for comparison:
- `shift-integer`: `inLoopCondition` refuses an integer literal ANYWHERE inside a `while`/`repeat`
  condition (R164 ruling). Pinned positionally in `tests/shift-integer.test.ts`.
- `negate-conditional`: cedes the EXACT `repeat ... until <cond>` span to `loop-truncate` (R164).
  A cession to a terminating substitute, not a detector; nothing to reuse for value operators.
- `flip-boolean-literal`: `isLoopCondition` refuses a literal that is a loop's WHOLE condition,
  walking through parentheses only (GH-07). R239 is the shapes it misses.

**Answer to "one detector for all value operators?"** Yes, it exists: `hangCapableForMutatedNode`.
It covers R196 for all four operators. It does NOT cover R239, because R239's shapes are literals
inside a CONDITION, not values written by an assignment. R239 is a widening of
`flip-boolean-literal`'s own `isLoopCondition`, not a second detector.

## 2. Decision: REFUSE, not tag

**Refuse every site `hangCapableForMutatedNode` names, and refuse R239's condition shapes.**

Why:
1. A tag with no forced stop saves nothing. Making the tag useful means building B2: a per-dispatch
   stop in `RunOpts`/`RunManyOpts` and both backends, a backend capability, a new caveat (with an
   `explain` value-domain and schema-version decision), resume eligibility keyed on the current
   manifest, and a new `itest:hang` arm in a file that sorts first, pre-committed. That is the
   large half of R196. Refusing is one line per operator.
2. R196's own measurement: none of the eight measured hangs is scoreable without R53's stop. The
   detector names 6 of the 8 (the other two are an `empty-block` and progress through a call), so
   this saves most of the 40 minutes, not all of it.
3. Precedent: R164 (`negate-conditional` until), R179 (`empty-block` while body), GH-07
   (`flip-boolean-literal` whole loop condition) and `shift-integer`'s loop condition all REFUSE.
4. It is safe for the gates: one fixture moves, by two mutants (section 6).

What it costs, stated plainly:
- The design spec's section 2 ruled TAG ("the more honest answer": a suite that does not notice an
  infinite loop has a real gap). Refusing reverses a reviewed ruling, so **the owner must accept
  it**. Under `--stop-hung-sessions` those mutants were scoreable, and that finding is now lost.
- Over-refusal: on the one measured slice, 3 of 9 tagged mutants were not hangs (2 killed, 1
  survived). `sandbox-hang`'s `DrainQueue` is a live example: both refused mutants there were
  KILLED by Int32 overflow, not by the budget.
- Unlike R164/R179, there is no terminating substitute operator: the finding is dropped, not
  replaced. That is why owner approval is real, not a formality.
- The R239 body-guard refusal has no corpus count (R239 says so); measure it with the next corpus
  census. It is not in the figures below.
- Corpus size of the loss, from `docs/measurements/README.md`: 81 / 87 tagged sites on the two
  reference corpora (about 1.2% of assignments). Mutants per operator there: remove-assignment
  57 / 61, shift-integer 19 / 23, swap-additive 6 / 5, flip-boolean-literal 5 / 7.

The tag channel stays (spec field, manifest, report field, `hangCapableCount`, warning): it is a
public `MutationSpec` field a plug-in operator can still set, and deleting it is a schema ripple
with sample reports re-generated live. For built-in operators `hangCapableCount` simply reads 0.

## 3. The rule

A site "governs a loop exit" when one of these holds:

- **R196 (all four operators):** `hangCapableForMutatedNode(node, ctx) !== null`, i.e. the value
  the mutant writes goes to a variable that an enclosing `while`/`repeat` condition reads.
  Unchanged detector, only the action changes from tag to refuse.
- **R239, nested literal:** a boolean literal reached from a `while`/`repeat` condition through
  `and`/`or`/`xor` (`until Done and true`, `while Go or false`).
- **R239, under `not`:** reached through a unary `not` (`while not true`, `until not false`).
- **R239, body guard:** a boolean literal that is (through the same wrappers) the condition of an
  `if` that sits inside a `while`/`repeat` (`while true do if true then exit;`).

The R239 rule refuses BOTH polarities. R239 proposed a polarity-aware rule (refuse only the flip
that can block the exit). Not taken: zero sites anywhere (section 5), and parity tracking through
`not`/`and`/`or` is more code with more ways to be wrong. Cost: the terminating flip
(`until Done or false` -> `or true`) is lost too, at zero measured sites.

A literal that is a call ARGUMENT inside such a condition is still claimed
(`if not Confirm('x', false) then exit;` in a loop keeps its flip): the walk stops at anything that
is not parentheses, a unary or a logical expression. Probed: claimed.

Not covered, and said so: `remove-assignment` of a counter in a body-exit loop
(`while true do begin I += 1; if I > 3 then exit; end`). That is the design's section 3.2.1
widening (a target read in the body, not the condition) and is R159's general hazard. Probed:
still emitted. See open question 2.

## 4. Code changes (prototype = `prototype.patch`, about 15 lines)

1. `remove-assignment.ts`, `shift-integer.ts`, `swap-additive.ts`, `flip-boolean-literal.ts`:
   where `hangCapable` is computed, refuse instead of tag. Put it in each operator's single claim
   decision so `targets()` and `generate()` agree:
   - `flip-boolean-literal`: in `flipped(node, ctx)`.
   - `swap-additive`: in `flipFor(node, ctx)` (its doc already says "one decision function").
   - `remove-assignment`: in `targets` (rename `_ctx` to `ctx`; `generate` already calls it).
   - `shift-integer`: in `targets` and `generate` (`shifted()` has no ctx).
   Then drop the `...(hangCapable ...)` spread from all four (now always absent).
2. `flip-boolean-literal.ts` `isLoopCondition`: walk through
   `{parenthesized_expression, unary_expression, logical_expression}` instead of parentheses only,
   and also stop at an `if_statement` for which `hasEnclosingLoop(p)` (already exported from
   `loop-hazard.ts`) is true. Rewrite its doc comment: the "NOT refused, filed as R239" paragraph
   becomes the R239 refusal.
3. Comments that say "tags": `loop-hazard.ts` header, `runner/src/hang-capable.ts`, the
   orchestrator's warning comment: one line each saying built-in operators now refuse these sites
   and the channel remains for plug-in operators. Design spec: add a status line at the top
   ("superseded in part: built-in operators refuse; B2 not built").
4. `docs/using-lethal-from-an-agent.md` and `.claude/skills`: grep for `hang-capable`; fix any
   sentence that promises a tagged mutant is deployed.

5. **`IDENTITY_SCHEME` 9 -> 10** (`packages/schemata/src/project.ts`, with a line in its history
   comment). Found by review and checked: identity ordinals number same-tuple twins in source order
   (`identityOrdinalsOf`), so refusing an EARLIER twin moves a later twin's key to the refused one's
   old key (e.g. three identical `Done := true` flips in one procedure, the middle one in a loop).
   R214 bumped for the same reason ("no longer generated"). Add that exact regression test.
6. **R402 preprocessor tails.** A literal in a `#if` tail of a loop condition
   (`while false` `#if X or false #endif` `do`) sits in a `preproc_conditional_expression_tail`
   BESIDE the `condition` field, so the prototype's walk misses it. Treat a tail child of the loop
   (or of the in-loop `if`) as part of its condition, the way `loop-hazard.ts`'s
   `conditionIdentifiers` already does. Test with the define active and inactive.

No report or event schema change, no operator version bump (GH-07's refusals bumped none).
Removing a mutant renumbers later `M` codes across the whole id-assignment batch, not just the
file (`assignMutantIds` keeps one counter over sorted paths); on `sandbox-hang` there is one file.

## 5. Fixture count (offline, before vs after the prototype)

Measured two ways: `lethal run --dry-run --out` per project, and a per-mutant census with the tag
(scratch copy of `scripts/census-fixture-mutants.ts`). Both agree.

| fixture | frozen gate | deployed before | after | removed |
| --- | --- | ---: | ---: | --- |
| `fixtures/sandbox-app` | itest:bcdev, itest:envtool, itest:alrunner | 19 | 19 | none |
| `fixtures/sandbox-data` | itest:tables, itest:chunked | 387 | 387 | none |
| `fixtures/sandbox-hang` | itest:hang | **40** | **38** | `HangLogic.Codeunit.al:104` remove-assignment (`Pending -= 1`), `:104` shift-integer (`1 => 2`) |
| `fixtures/sandbox-symbols` (no defines / LETHALA / LETHALB) | itest:alrunner symbol legs | 9 (13 raw, all sets) | 9 | none (zero tagged sites in any arm) |
| `fixtures/sandbox-layout` | itest:alrunner layout leg | 10 | 10 | none |
| `fixtures/sandbox-harden` | harden baseline | 21 | 21 | none |
| `fixtures/sandbox-multiobject` | alrunner multiobject baseline | 12 | 12 | none |
| `fixtures/sandbox-coverage-probe` | none | 80 | 80 | none |
| `fixtures/sandbox-probes` | none | 269 | 269 | none |
| `examples/gift-card` | demo campaign (frozen 60) | 60 | 60 | none |
| `examples/credit-limit` | demo | 42 | 42 | none |

Per operator, all fixtures: remove-assignment -1, shift-integer -1, swap-additive 0,
flip-boolean-literal 0. R239's shapes: **zero sites** in every fixture and example (grep plus
census), as R239 already predicted. No other mutant appeared (no dedup displacement).

## 6. Gate impact and the pre-commitment

Exactly one frozen gate moves: **`itest:hang`, ON leg** (with `--stop-hung-sessions`).

| figure | before | after |
| --- | ---: | ---: |
| mutants (`EXPECTED_ON` rows) | 40 | 38 |
| killed | 26 | 24 |
| survived | 9 | 9 |
| timeout-killed | 5 | 5 |
| warmKills | 4 | 4 |
| groupedCalls (asserted as scored + 4) | 44 | 42 |

Removed rows: `{ line: 104, operator: "lethal.remove-assignment", verdict: "killed" }` and
`{ line: 104, operator: "lethal.shift-integer", verdict: "killed" }`. Every other row predicted
unchanged, including every `killPosition` in `SpinUntil` (the kill ledger is per procedure;
`DrainQueue` is a different procedure). The OFF leg strands at `:37` before `DrainQueue`, so it
does not move. No `*.baseline.json` file changes.

Pre-commitment to write BEFORE the live run:
`docs/superpowers/specs/2026-10-04-r196-refuse-precommitment.md` with the table above, the two
removed rows by identity, and "every other row identical". Then: edit `EXPECTED_ON` (remove the two
rows, rewrite the overflow comment above them: these were the refusal's measured over-approximation,
killed by overflow, not hangs), and run `itest:hang` live (both legs) on the host. Optional
confirmation: `itest:tables` and `itest:bcdev` should be untouched by construction (zero diff in
their dry runs); running them is not required.

## 7. Tests (offline, positional, red first)

All in `packages/builtin-tier1/tests/`, shaped like `shift-integer.test.ts`: one fixture, assert
the refused site by POSITION while a sibling site in the same loop is still claimed.

Each refusal test asserts BOTH `targets() === false` and `generate()` returns `[]` (the prototype
only does the latter; the plan puts the check in the claim decision). Each R196 test also carries a
same-loop control: an unrelated mutation in the SAME loop body that must still be claimed, so a
regression that refuses every in-loop site goes red (red-check that too).

R196, one per operator (rewrite the existing "tags ..." tests and conformance cases into refusals;
each keeps its preheader control, which must still be claimed):
1. remove-assignment: `while Continue do Continue := false;` refused; preheader `Continue := true`
   claimed. Conformance case: expected specs lose the in-loop entry.
2. shift-integer: `Remaining := 1; while Remaining > 0 do Remaining := 0;` the `0` refused, the
   `1` claimed.
3. swap-additive: `while I < N do I := I + 1;` refused; an additive outside the loop claimed.
4. flip-boolean-literal: `while Continue do Continue := false;` refused; preheader claimed.

R239, one per shape (flip-boolean-literal):
5. nested `and` in `until` (`until Done and true`): refused. Replaces the existing test "does NOT
   over-refuse a boolean nested inside a compound exit condition", which pins the old behaviour.
6. nested `or` in `while` (`while Go or false`): refused. Replaces the "compound while" test.
7. under `not` (`while not true`, `until not false`): refused.
8. body guard (`while true do if true then exit;`): the `if` literal refused.
9. Controls: `if true then exit(1);` OUTSIDE any loop still claimed; `Confirm('x', false)` as an
   argument inside an in-loop `if` condition still claimed.

Red-first: write tests 1 to 8 against master and see each fail (tests 1 to 4 fail today because the
mutant is emitted with a tag; 5 to 8 because it is emitted). Red-check each direction after the fix
with the `mutation-red-checker` agent: (a) drop the `hangCapable` refusal in one operator, its test
goes red; (b) put the parentheses-only walk back, tests 5 to 7 go red; (c) drop the `if_statement`
stop, test 8 goes red; (d) make the walk refuse everything in a loop, control 9 goes red. Report
each red and the restored green.

Other tests that move (seen on the prototype, 12 failures in builtin-tier1):
- `split-member.test.ts` (R302): swap-additive's twin fixture now yields zero sites and fails
  `toBeGreaterThan(0)`. Add one additive outside the loop to that fixture (both twin and split
  change identically). The remove-assignment row now pins the refusal inside a split member,
  which is still the point (`resolveVarRef` through `findEnclosingProcedure`); rename its label.
- `loop-hazard.test.ts`: unchanged (it tests the detector, not the action).
- `packages/runner/tests/r402-hang-active-arm.test.ts` reads the tag off REAL generated
  remove-assignment specs per `#if` arm. "Tagged" becomes "refused (no spec)"; keep every
  active/inactive-arm expectation, only the observable changes. Same for the counts pinned in
  `scripts/fixtures/r402/expected.json` (checked by `scripts/r402-shape-sweep.ts`).
- The identity-scheme pin tests (grep `IDENTITY_SCHEME` under `packages/*/tests`).
- Runner tests that build specs with `hangCapable` by hand: unchanged (the channel stays).

Then: typecheck, `rm -rf packages/*/dist`, `bun scripts/verify.ts`, `bunx biome check <touched>`,
`bun test scripts/line-citations.test.ts`.

## 8. Close-out

- R196: `done (<commit>)` with one line: built-in operators refuse every `loop-condition-target`
  site instead of tagging it (IDENTITY_SCHEME 10); the forced stop (B2) is not built; the
  detector's known misses (progress through a call, body-only reads) stay unclassified;
  itest:hang 40 -> 38, pre-committed.
- R239: `done (<commit>)`: `flip-boolean-literal` refuses a literal reached from a loop condition, or
  from an in-loop `if` condition, through parentheses, `not`, `and`/`or`; zero fixture sites.
- If the owner keeps open question 2 out of scope: file a new item for the body-exit loop counter
  (`remove-assignment` / `swap-additive` / `shift-integer` on a variable read only by an in-body
  exit guard), the design's section 3.2.1 widening. Check the next free id with `ls docs/roadmap/`
  right before writing. Regenerate `ROADMAP.md`.

## 9. Open questions for the owner

1. **Refuse reverses the design's TAG ruling** (section 2 of the R196 design). Accept? The
   alternative is building B2 (large, live-gated). A middle way, filtering tagged mutants in the
   orchestrator only when `--stop-hung-sessions` is off, keeps them for opt-in runs but makes the
   deployed set (and `M` codes) depend on a runtime flag, which resume and dry-run would both have
   to learn. Not recommended.
2. **Body-exit loops** (`while true do begin I += 1; if I > 3 then exit; end`): in scope or filed?
   Closing it means reading in-body exit-guard conditions in `classifyHangCapable`, a widening
   with no corpus count yet. Recommended: file, measure first.
3. **Silent vs named refusal.** These refusals are silent, like every other operator refusal. R196
   mentions "a named refusal"; a count in the report is a schema ripple. Recommended: silent.
