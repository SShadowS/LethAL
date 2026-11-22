# PR-302 pre-commitment: `alRunnerV3.refusedCutTail` measured on DO (flag on against off), and R1156's live claim

Status: pre-commitment (coord PR-302, lethal-preproc, 2026-11-22), before the run. Evidence and scripts:
`/coord/handoff/PR-302/` (`size.py/.txt`, `run-on.sh`, `v3.tail-on.json`). Names and numbers only; DO test names stay
in /coord.

## What runs
- **ON arm, t1:** a full DO run (`do-cloud` x `do-test`) from master at this commit or later, with PR-297 (b227e6df6),
  PR-292 (4942afa27) and PR-307 (5481d03ef) in HEAD (the script checks).
  - The binary is main-ccd0f823d, sha256 bc3595c4…ad7c. The script checks the config's binary and the run's version line.
  - c2's settings: `--profile slim`, `LETHAL_V3_PACK_ENTRIES=256`, `companies` CRONUS, CPUs 0-11.
  - Plus `refusedCutTail: true` and `ciSessionKind: "client"` (PR-307; it matches v3's session kind).
  - `--workers 8 --peak 24`: at c2's 3.3 GiB per lane, 6 lanes need 23.6 GiB, so R1156 can be read at 6 lanes.
- **OFF arm: c2** (`/coord/handoff/combined-do/c2.*`, master 5ce080dce, the same binary and settings, the flag absent,
  which is the off behaviour PR-297 pins byte for byte). Master's code commits since then:
  - PR-301: measured at 0 DO sites.
  - PR-297: off-identical.
  - PR-292: bound print in a worker; no verdict path.
  - PR-298: an env-gated trace, off.
  - PR-307 and PR-311: a session-kind label and its flag; notes, not verdicts.
  - None moves a DO verdict. **If a move outside the cut set below cannot be named from that list, a fresh OFF run from
    t1's head follows before any claim is read.**

## Sizing (offline, c2's baseline and report, `size.py`)
c2 has 1,590 cut-error mutants (`baseline-refused-cut`, verdict `error`), in four codeunits. Every one is covered by at least
one green test after its codeunit's cut:
| codeunit | tests | cut at | tail, green | cut-error mutants |
|---|---|---|---|---|
| 68975 | 78 | #27 | 51, 49 | 841 |
| 68984 | 42 | #15 | 27, 21 | 599 |
| 68906 | 25 | #13 | 12, 12 | 96 |
| 68874 | 10 | #5 | 5, 1 | 54 |
83 green tail tests in all.

## Predictions
- **Void unless the cut fired:** t1 prints one `al-runner-v3-refused-cut-tail` notice per cut codeunit, at least one
  names a stable test, and the end-of-session count of tail alone calls under a mutant is above 0. Otherwise the run
  measures nothing about the flag, and that is reported as such.
- **Verdicts, per mutant on the full site key, t1 against c2:**
  - Moves happen ONLY among the 1,590 named cut-error mutants (`/coord/handoff/PR-302/cut1590.tsv`, written from c2
    before the run). A move outside them is a BLOCK until named (see the OFF arm rule).
  - Of the 1,590, the ones whose covering tail tests are stable leave `error`, for `killed`, `survived` or
    `timeout-killed`. Which tests are stable is not predicted. Reported: how many leave `error`, to which verdict, per
    codeunit, and the stable/unstable names t1 prints.
  - Every tail kill carries the PR-297 note in `failureMessage` and is confirmed alone under NONE, then reproduced alone
    under the mutant. A tail kill without the note, or not reproduced, is a BLOCK.
- **The BC check (lethal-bugs):** every `error -> killed` move if there are 100 or fewer. Otherwise a random sample of 100,
  stratified by codeunit in proportion, seed 302, drawn by a script committed with the result before any BC call.
  - A false kill (on BC the killing test passes under the mutant) blocks flipping the default.
  - It does not block reporting this run.
- **Cost (reported against c2):**
  - The stability pass spawns one throwaway daemon per green tail test: 83 at about 40-48 s each (c2's after-refusal
    and first warm-ups), so about 55 minutes at the end of the baseline (30-90).
  - The tail alone calls add requests in the mutant phase; their count and time are printed and reported.
  - Phase and per covered mutant are reported with the box load. They are not a claim.
- **R1156 (its live claim, read here as the orchestrator asked):** the per-check bound time (`bound <ms> over <n>
  checks`, divided) with PR-292's worker, at the lanes t1 starts. The claim is under 130 ms per check at 6+ lanes (c2:
  218 ms at 5, before the worker). If fewer than 6 lanes start, the reading is reported and the claim is not judged.
- **Hard checks (BLOCK):** the binary and version line; the flag set; PR-297, PR-292 and PR-307 in HEAD; no move outside
  the 1,590 unless named; every tail kill noted, confirmed and reproduced.
