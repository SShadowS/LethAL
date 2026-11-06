# R827 pre-commitment (2026-11-05): an empty-block mutant emitted as one guard, not a chain

**Addendum 1, same day: PARKED, not to be built as written.** The plan review found it unsafe as specified. Its "time may move" line
understates a verdict risk, and its "free" rule and its list of what moves are incomplete. R827's section "The fix: planned, reviewed,
parked" holds the seven things a pick-up must do. Any pick-up writes a new addendum first.

Committed before any code and before any live run. Coord task R-825. Plan and impact: docs/roadmap/R827.md, docs/roadmap/R826.md,
/coord/handoff/R-825/r827-impact.md. Offline proof of the shape: /coord/handoff/R-825/prove/.

## The change

A **free** `empty-block` mutant is one where no other mutant's resolved statement contains the block, and the block holds no
preprocessor directive. It is emitted as two insertions, so the block's text appears once:

    begin if Sel.Active('E') then begin <marker> end else begin BODY end end

Nested mutants keep their own components. Any other `empty-block` mutant stays a chain member, exactly as today. A block with a
directive stays a chain because its closing `end` can lie inside a `#if` arm, where one insertion reaches only one build.

## Predicted: nothing about a mutant moves

On every gate, per mutant, against the baselines as committed on master when the final gate runs: after R-818 and R-824's
records, whatever identity scheme those leave. Until then, comparisons are against the rows committed today:

- `key`, `verdict`, `killingTest`, `errorClass`, `mutatedTextSha256`, `coverageFiltered` and `identityScheme` are unchanged;
- mutant counts, `groupedCalls`, the reach tallies and the note and refusal sets are unchanged;
- mutant ids, `astHash`, identity keys, `numberingDigest`, selection and `--dry-run` counts are unchanged.

Any difference in any of these is a BLOCK. It is not re-recorded here.

## Predicted: these move

- Emitted AL, the artifact hash and app size. On 8 DO codeunits, an offline estimate: 638-2415 KB falls to 146-916 KB, and with
  `empty-block` removed altogether it would be 129-842 KB.
- Tests that pin emitted AL (goldens and snapshots), updated by hand and each read.
- `bisect.ts`' blame for a compile error in a body can name E where it named a nested mutant.
- **Time may move, up or down, and is measured and reported per gate.** Publish and compile should fall. `Active` calls move from
  once at body entry to each nested statement, so a statement in a loop calls it on every pass. That may raise run time, and the
  hang gate's timing is read under that gate. Not a BLOCK by itself; a verdict that moves because of it is.

## What runs

- Red tests, each direction, each reverted and seen red. They include: the shape on nested `if`/`else`, a trailing `if`, a `case`
  arm, a comment-only block, a directive in a block, `exit` with a named return value, and a body in a `for`.
- **A wrong `else` binding that compiles must be caught.** Measured offline: a shape with the guard's `begin ... end` lost compiles
  (alc exit 0) and fails 2 of 12 behaviour tests. A red test in the repo holds this.
- `Active` call cost in loops, measured offline before any gate.
- The full v3 gate, then every BC gate, per mutant, on bc1, bc2 and bc3 (BC 28.4, proven). Not bc4: it is unproven, and a platform
  change would hide the cause of a difference.
- One opus plan review and one opus build review. CI.

## Order

R-818 lands first, then R-824's records, then R827's final gate: a record made after this change would see different emitted AL.
R827's own gates can run earlier against the committed rows, and the final-head gates must follow those records.

## Addendum 2, the pick-up (R-836, 2026-11-06)

Unparked by the owner's goal. This replaces "The change" and answers the seven points in R827. Build before figures: the size and timing
figures, and any fixture re-pad, come in Addendum 3 before any live run.

**One rule for "free", in `buildComponents`.** Members are walked widest first, as today, equal spans included, and no second definition
exists anywhere. An `empty-block` member is free when all of these hold, else it is a chain member as today:
1. its `before` is its resolved statement, a block. A case-arm E resolves to `case_statement`, so it stays a chain, marker-less;
2. no chain root contains the block;
3. no other member resolves to a statement of the same span;
4. the block holds no preprocessor directive, at any depth (point 3 of R827).

A free block is not a root. What sits inside it is grouped again by the same walk, so a free E can hold another free E.

**Loops (point 1).** Inside a free block, a member inside a loop is grouped at the OUTERMOST loop statement within the outermost free block
that holds it. So its guard is tested on entry to that loop, once per pass of the block, where today's body chain tested it once per pass
of the block. Guards do not move inside a loop, so R246's race does not arise. Where no free E exists nothing changes. A chain rooted at a
loop that holds an E makes that E a chain member, by condition 2.

**Emission.** Two zero-width insertions and no newline, so BODY appears once and no line of BODY moves:
`begin if Sel.Active('E') then begin <marker> end else begin BODY end end`. The marker is E's, by the same plan as a root member.

**What this document adds to the "moves" list (point 6):** callstack line numbers in `killingTestFailure`; `planFile`'s and `design.md`'s
"never nested guards", which become "never nested chains"; `large-fold.ts`'s figures, since a free E adds no bytes. R318's rule, that a
line two declarations share names neither, is read by the plan review, and any effect goes in Addendum 3.

**Gates (points 4 and 5).** `Grow`'s and `LayoutBeta`'s instrumented spans shrink, so `itest:bcdev-wrapped` and the v3 layout leg may go
blind while staying green. Addendum 3 says how each stays load-bearing, with its red check redone. A fixture arm for an `if`-branch E joins
a gate. No crash runs, and bc1 is out of use.

**Order, ruling 2026-11-06.** Early gates may run now against the committed rows. Baselines record after R-842 and R-848, and the final
per-mutant comparison waits for the orchestrator's word.

## Addendum 3, before any live run (R-836, 2026-11-06)

From the delta plan review of Addendum 2, and the build at `lethal/r836`. It replaces Addendum 2 where they differ.

**"Free" is narrower: a procedure or trigger body only.** An `empty-block` member is free when its statement's parent is a procedure or a
trigger, its block holds no `#if`-family node and no `#pragma`, and no other member resolves to the same span. A branch block is never free:
measured, every free block in a default run is a body, because a condition mutant roots every `if`. So free blocks do not nest. A filtered run
loses nothing: the branch stays a chain, as today.

**Loops.** Inside a free body a member in a `for`, `foreach`, `while` or `repeat` is grouped at the outermost loop, and the free test comes after
that, so an `empty-block` of a loop body is a chain member there. The fold cannot see this, because it compares meaning. So the residualising
helper also reads the emitted tree: no guard inside a loop under a free guard's `else` (`guard-in-loop`), default and with the loop's own
mutants left out.

**The gates that would have gone blind (R827 point 4).** `Grow` gains a `#pragma` line in the two wrapped files, their twins and `LayoutBeta`,
which keeps it a chain as long as today. Each comment loses a line, so no mutant's line moves, and that puts the directive rule on a live gate.
Measured with this build: 9 fixture keys move by byte offset, all in `sandbox-layout` and `sandbox-wrapped`. No tuple, ordinal or tag moves
on any fixture, and DO's keys are identical (0 added, 0 removed). So no baseline changes for this.

**What else moves, adding to the list:**
- `itest:alrunner-v3` leg X (d): the Sleep index is 1 + 5, it was 4 + 5, and SLEEP_LINES and R5's table lines read 18. No verdict moves.
- `line-map.test.ts` GH-09: its rows are measured on BC in the old layout, so they are measured again on `bc2`, by
  `LETHAL_FENCED_COVERAGE_DUMP`, during `itest:bcdev`.
- `reach`: a statement that is neither in a list nor a slot (under `asserterror` or `with`) goes from `unplaced` to `statement`, because it is
  now its own root. The grain golden on every fixture is byte-identical, so no gate moves, but on real code the tally can.
- `large-fold.ts`: the warning named `lethal.empty-block`, which is no longer the largest cause. It now names `if` conditions and `case` arms.
- Tests and goldens that pin emitted text: emission hashes re-pinned, manifests unchanged, grain golden unchanged.

**Size, 21 of DO's codeunits, offline, with the loop rule:** with `empty-block` against without it, 1.0 to 1.6 x, down from 1.8 to 7.6 x. 96 KB to
1,226 KB, longest chain 66. On 10 DO files in total: 10,863 KB on master, 3,303 KB now, 2,721 KB with no `empty-block`.

**Predictions, as before:** every gate, per mutant, nothing moves. Early gates run against the committed rows. `itest:alrunner-v3` first, then
`itest:bcdev`, `-wrapped`, `tables` and `harden` on `bc2`, and `itest:hang` on `bc3`. Time is measured and reported per gate. A verdict that moves
is a BLOCK, for time or any other reason. No crash runs; bc1 is out of use.

## Addendum 4, a correction (R-836, 2026-11-06)

**Addendum 3 is wrong where it says "So no baseline changes for this."** That read the dump's identity tuples, and the early gates at 7b0ecf7f
showed the gate's key hashes the block's text as well. `Grow`'s `#pragma` is inside the block, so its `empty-block` row re-keys, from
`556f5859...|<object>|Grow|lethal.empty-block|1` to `170d7adf...|<object>|Grow|lethal.empty-block|1`. All five rows, by baseline:

| baseline | objects |
|---|---|
| `bcdev.wrapped.baseline.json` | `Wrapped Top`, `Wrapped Top Twin`, `Wrapped Pre`, `Wrapped Pre Twin` |
| `al-runner-v3.wrapped.baseline.json` | the same four |
| `al-runner-v3.layout.baseline.json` | `Layout Beta` |

**Ruling (orchestrator, 2026-11-06): option A.** lethal-code records under R-848. Then these three baselines are re-recorded in R-836's branch at the
final scheme, by R332. Only these rows may move, and each must read `killed` by its same test on its same line: `GrowTop`, `GrowTopTwin`, `GrowPre` and
`GrowPreTwin` on lines 7, 7, 9 and 9, and `Layout Beta`'s row as committed. Confirmed per mutant, and a confirm run passes without record
mode. Any other difference is a BLOCK.
