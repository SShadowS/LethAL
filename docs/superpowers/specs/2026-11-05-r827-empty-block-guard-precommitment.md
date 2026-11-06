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
