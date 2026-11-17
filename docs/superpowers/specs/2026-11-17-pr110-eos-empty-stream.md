# PR-110 pre-commitment (measure first): R1105, `remove-not` on `while not S.EOS` with no pre-read (the empty-stream case)

Coord PR-110 (lethal-code, 2026-11-17). Filed as R1105 by PR-109's review. Method: PR-44's and PR-109's.

## The question
- **R173's ruling.** `lethal.remove-not` on a `while not S.EOS` exit is safe because "EOS is false at the start".
- **The first failure.** R1104 (PR-109) refuses the case where S was READ before the loop.
- **The second failure.** S is opened over an EMPTY stream (a BLOB with no value). EOS is then true at the start, so the
  mutated `while S.EOS do ... S.ReadText(T)` can never exit.
- **What a static rule can and cannot see.** It cannot see whether a stream is empty at run time. So the only candidate rule
  is the broad one: refuse every remaining `remove-not` on a `while not S.EOS` exit (InStream S, no pre-read). That would undo
  R173's ruling.

## What is measured (no product change before the verdict)
- **The candidate.** A measurement-only switch refuses every `lethal.remove-not` whose `not` is the whole `while` condition on
  `S.EOS`/`S.EOS()`/`(S.EOS)` with S an InStream, and which R1104 does not already refuse.
- **The runs.** A dry-run of the corpus (72 BC.History modules), DO and every `fixtures/*` project, before and after, on this
  head.
- **The classification.** Removed sites are classified against the stored verdicts: DO's t13, with earlier windows for sites
  it never reached; the corpus's PR-37 stored verdicts. timeout-killed counts as a hang.
- **The bar.** PR-37's: at least 1 hang per 8 scored sites lost.

## Predictions (committed before the measurement)
- **P1.** DO has 1 such loop site (`GetErrorMessage`; t13 `error`, not a hang).
- **P2.** The corpus has a handful. Most such loops read a stream filled just before by the same procedure, so they are rarely
  empty in tests.
- **P3, the verdict.** The rule FAILS the bar (fewer than 1 hang per 8 scored lost), and R1105 is closed as measured: R173's
  ruling stands for streams that are not known to be empty, and the empty-stream hang is left to the run-time stop (R954) and
  PR-108's walk cap.
- **If the bar holds instead,** the narrow refusal is built with red-checked unit tests and the v3 and hang gates, and the moved
  DO sites go to lethal-bugs before any DO window.
