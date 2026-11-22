# PR-327 (c) pre-commitment: R197's kill ledger never moves a test across test codeunits (R1174)

Coord PR-327 (lethal-code, 2026-11-22). **The orchestrator's order:** (a) the v3 label (built), then this (c), then (b).
**Evidence:** `/coord/handoff/PR-327/findings.md`; the sizing is in `/coord/handoff/PR-327/r1174-size.txt`.

## What R1174 found (bcdev, bc2, BC 28.4, the invented probe)
- **The probe:** a SingleInstance flag that test codeunit A sets and resets, and test codeunit B, which reads it.
- **Three mutants of the reset leak the same way.** The first (M0009) was killed by B, since A ran before B.
- **For the next two (M0010, M0011),** `orderCoveringTests` put B FIRST, because B had killed in this scope. B passed
  before A set the flag, so both **survived**.
- **So the ledger changes a verdict on the authoritative backend.**

## The rule
- **`orderCoveringTests` keeps the test CODEUNITS in their order in `covering`,** the coverage index's own order, which is
  the run's codeunit order.
- **It reorders only WITHIN each test codeunit,** by the existing keys:
  1. kills in the scope, most first;
  2. the narrowest test;
  3. the code-unit-name tie-break.
- **The reason:** state a test codeunit leaves (SingleInstance globals, and anything else the runner does not reset between
  codeunits) can only reach a LATER codeunit. Keeping the codeunit order keeps every such reach, as an unordered run would
  have had it.
- **The cost:** the ledger's speed-up, a killer tried first, now applies only within a codeunit. A kill in a later codeunit
  costs the earlier codeunits' tests first. The A/B below measures that.
- **Both backends use `orderCoveringTests`.**
  - On v3 every codeunit is a fresh entry, so the order across codeunits cannot change a verdict there. The rule is
    harmless on v3 and kept the same, for one code path.

## Predictions (written before the build)
- **The probe on bcdev:** all three `EndIt` mutants (M0009-M0011) are KILLED by `ComputeIsPlain`. Today only M0009 is.
- **A unit test** on a stateful fake: with a kill recorded for a test in codeunit B, `orderCoveringTests` returns A's tests
  before B's. Today it returns B's first.
- **Gates:** any gate whose figures rest on cross-codeunit reordering can move `killingTest`, `killPosition` or a verdict.
  - The build runs EVERY BC gate's comparison offline where possible, and the full v3 gate.
  - Each moved figure is listed and pre-committed before a re-record, by the R332 procedure. **No silent re-record.**
  - The expected result is that the v3 gate figures do not move (fresh entries).
  - **BC gate moves are possible, and each is reported by name, not assumed away.**

## Measure (after the build)
- **The probe on bcdev** (a leased bc server): red (the current head) then green (the fix), with per-mutant verdicts and
  the test order from the store.
- **The size on a real bcdev slice:** re-run R-882's S3 slice (101 at-risk survivors by the static bound, the smallest
  real slice with a non-zero bound) with the fix, on the same server. Count the survived → killed moves (the false
  survivors the ledger caused) and the wall-time cost.
  - **BLOCK:** any killed → survived move is a BLOCK.

## Out of scope
- (b) the v3 `strictOrder` lane comes after this.
