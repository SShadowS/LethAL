# R-604b (roadmap R604): pre-commitment for the gates at IDENTITY_SCHEME 42 (2026-10-23)

Written BEFORE the build and before any live run, from the adopted plan
(`docs/superpowers/plans/2026-10-23-r604b-iterator-shapes.md`, 94ec393f) and its pre-committed list
(`2026-10-23-r604b-expected-refused.tsv`). Any difference is a BLOCK, recorded and not reinterpreted.

## What changes
- **M1, narrowed.**
  - A same-object callee that shares the loop's cursor by `var` and touches it (any `r570Scan` reason except a write
    to a non-key, non-filter field) is refused.
  - So is a callee that inserts or renames rows of the iterated table through any record (A0).
  - So is an `R570_UNKNOWN` entry, together with its touches.
  - So is a forced global the callee names.
- **`IDENTITY_SCHEME` moves from 41 to 42.** Every frozen `itest/*.baseline.json` below 42 is listed in `LAGGING_SCHEME`
  pointing at R690, which re-records them once on master after this merges. That is ten files: `bcdev`,
  `bcdev.names`, `bcdev.wrapped`, `hang.single`, `harden`, `tables`, `al-runner-v3.tables`, `al-runner-v3.layout`,
  `al-runner-v3.symbols-lethala` and `al-runner-v3.symbols-lethalb`. `envtool` stays on R683. The harden marks file is
  restamped to 42.

## What "nothing is removed" means
The re-price compared master's refused set with r2's, at master f31ae5ad.
- **r2 only ADDS refusals.** No procedure or guard site that master refuses today becomes mutated, in any corpus.
- **The added refusals cost at most** 170 deployed mutants in DC (6 procedures, 2 guard sites) and 584 in BaseApp (16
  procedures, 18 guard sites). DO, CDO and the fixtures cost 0.
- **So no fixture or gate mutant changes:** none becomes refused, and none becomes newly mutated.
- **The STOP rule:** any refused procedure or guard site outside the expected list.

## The gates: every per-mutant verdict unchanged
The leg list is `selectLegs` on the final diff, copied literally. It is written into an addendum here before any gate
runs. The plan expects bcdev, tables, chunked and alrunner-v3; if it names `lease`, that is `itest:lease`. BC legs run
on `bc2` (bc1 is out of use, bc3 out), one gate at a time, each leased only when free.
- **Every gate the list names:** verdict and killing test unchanged for EVERY mutant against its committed baseline.
  Same mutant count, no mutant refused or added, and every figure on its gate page unchanged.
- **The scheme lines.** A gate whose baseline is below 42 prints its scheme-change line, for example
  `identity scheme changed (<recorded> -> 42): N mutant(s) checked by their mutated-text hash, M mutant(s)
  text-UNVERIFIED`.
  - `<recorded>` is that baseline's scheme: 38 for bcdev, bcdev.wrapped, hang.single, harden and tables; 40 for
    al-runner-v3.tables and bcdev.names; 41 for al-runner-v3.layout, -symbols-lethala and -symbols-lethalb.
  - N and M are unchanged from the same gate's run on master at 41. For example, al-runner-v3 leg T printed
    `(40 -> 41): 394 ... 12 ... text-UNVERIFIED` on master.
  - A changed N or M, or a mismatch on a hash-checked mutant, is a BLOCK.
- **itest:alrunner-v3:** all 12 legs unchanged per mutant: C 26 facts, S1 3/12/4, S3 refused by name, N1 36, X,
  L1 7/3, Y-A 5/4, Y-B 5/4, K 3/12/4, D1 51/12/0, D1c 51/8/4, T 290/57/59. Run with `LETHAL_ITEST_V3_CDO` and
  `LETHAL_ITEST_V3_TABLES` set.
- **Offline only (R164):** no hang-capable site enters any live gate. The new probes (A, A0, A0p, B, the I2 global,
  A′, and the I3 unknown) are unit tests.

## How the run is judged
Gates run on the final R-604b head (master merged in). Any moved figure, any changed scheme-line count, any refused or
added gate mutant, or any procedure outside the expected list is a BLOCK.

## Addendum 1 (before any gate): the leg list, copied literally
`selectLegs` on the final diff (`git diff --name-only origin/master...lethal/r604b`, 19 paths, head f0bc3a60):
`{"legs":["bcdev","lease","stale-publish","tables","chunked","alrunner-v3","hang"],"park":[],"unmatched":["fixtures/sandbox-harden/lethal.equivalent.json"]}`
- **The legs to run:** bcdev, lease, stale-publish, tables, chunked, alrunner-v3 and hang. `lease` is
  `itest:lease`.
- The full set follows from default-deny on the one unmatched path. Each leg is unchanged per mutant, as in the
  sections above.
- **Proposed in addition: `itest:harden`.** The unmatched path, the harden marks file restamped 41 to 42, is read only
  by that gate, and no agentflow leg covers it. Expected: unchanged per mutant against `harden.baseline.json`
  (scheme 38), with its scheme line `(38 -> 42)`, and the marked mutants still applied as marked.
- **Where they run:** the BC legs on bc1 or bc2, one gate at a time under a lease, each server checked for an
  out-of-use marker first; itest:alrunner-v3 locally, with `LETHAL_ITEST_V3_CDO` and `LETHAL_ITEST_V3_TABLES` set.
