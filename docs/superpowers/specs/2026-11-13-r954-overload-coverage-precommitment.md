# R-954 (R965) pre-commitment: coverage from one overload no longer covers another overload's mutants

Written 2026-11-13 by lane preproc, after the build (lethal/r954 e0c1ff16) and before any gate or measured run.
Where: `/coord/handoff/R-954/where.md` (al-runner's per-test coverage lines are right; LethAL keyed coverage by procedure name).

## The change
A mutant site in a procedure whose name another procedure of the same object shares carries `procedureOverloadIndex` (its
source-order position among them); coverage lines map to an overload index; `coverageFilter` gives such a mutant only the tests that
ran THAT overload. Coverage with no overload index gives an overloaded name no exact claim (unknown, never a survivor on a guess).
Procedures with their own name are unchanged. Identity (`IDENTITY_SCHEME`, hashes, digests) is unchanged.

## Expected results
- **Direction:** a mutant can only LOSE a covering test it never ran: survived -> no-coverage (or fewer covering tests). A killed
  mutant stays killed (a kill proves execution). No mutant gains coverage.
- **The gates:** no figure moves. The only gate fixture with a repeated procedure name is `sandbox-wrapped`'s `Pick`, declared once in
  each arm of an `#if` (only one compiles): that is NOT an overload, and the v3 gate's WR/WRE legs and `itest:bcdev-wrapped` must not
  move. A move there means the arms were counted as overloads: a BLOCK. `sandbox-order-tests` repeats `SetMark` in two different
  codeunits (a test project, no mutants). Gates: the full v3 gate; `itest:bcdev` and `itest:bcdev-wrapped` on one bc server (the
  shared coverage path).
- **Blast radius re-measured** (stored runs keep no per-test lines: `/coord/handoff/R-954/blast/count.md`, 2,345 at-risk survived rows,
  153 file/procedure pairs). Cryptography Management re-run on the same build and config as R-950 (al-runner edge-c8fe56e05,
  `/coord/handoff/R-950/v3.crypto.json`, `--mutant-timeout-ms 180000`), new LethAL against R-950's report, per mutant by site offsets:
  every verdict identical except survived -> no-coverage, and only among the at-risk mutants of `count.tsv` for that report.

## Amendment (2026-11-13, after the build review, before any gate or measured run)

- **"A killed mutant stays killed" holds except in bcdev HUB coverage mode** (opt-in, in no gate): hub coverage carries no overload
  index, so an overloaded public procedure's mutants get no exact claim there and become no-coverage, killed ones included. That is
  the safe direction (unscored, never a false survivor); overloaded locals keep the object-grain fallback.
- A run started before R965 and continued with `--resume`/`--resume-run`, or an installed artifact from before R965, keeps the old
  name-keyed coverage for the verdicts it carries; R965's text says so. The predictions above are about fresh runs.
- The review's probe confirmed `sandbox-wrapped`'s `Pick` gets no overload index (each `#if` arm is its own object node), so the
  wrapped legs are still predicted unchanged.
