# R784 pre-commitment (R-784): the serve order probe as a gated update-gate leg (O1)

Written 2026-10-25 by lethal-bugs, before any build or live run of the leg.
Basis: R-778's order probe (`/coord/handoff/R-778/order-probe/result.md`), NO CARRY-OVER on al-runner
`3.0.0-alpha.5+edge.20261024 (dcdf9e821)` with the 17-app D1 dependency set.

## The leg
- Name `O1`, added to `V3_GATE_LEGS`, run on every update-gate pin.
- Fixture: a small committed AL fixture of a dependency app plus a test app (a Writer codeunit that sets state, a Reader
  codeunit that reads it). It carries no test that commits: al-runner refuses `Commit` under `TestIsolation = Function`
  (`NotRun: out-of-scope`), so commit-based state stays unmeasured, as in R-778's probe.
- Kinds (7): WorkDate, GlobalLanguage, uncommitted table rows, a SingleInstance codeunit in the test app, a SingleInstance
  codeunit in the dependency app, NumberSequence, IsolatedStorage.
- Requests to ONE serve daemon, in this order, each entry one codeunit: `[R]`, `[W, R]`, `[R, W]`,
  `[W1, R1, W2, R2, R3]`, then a new request `[R]`.
- Package sets: the fixture's own; and, when `LETHAL_ITEST_V3_CDO` is set, the CDO `Test/.alpackages` (17 apps) as the
  package cache, read-only. Without CDO the second set is skipped the way D1 is.

## Predicted figures (both package sets, every build the gate judges, starting with whichever is `current`)
- Every Reader entry, in every request, reads the defaults on all 7 kinds: WorkDate = the run's own date (the clock),
  language 1033, rows 0, both SingleInstance marks at their default, number sequence absent, isolated storage absent.
- No writer value ever appears in a Reader entry.
- Every Writer test passes in every Writer entry, including W2 in the batch shape (no "already exists" or "already set"
  from W1), so each state really was set.
- Every entry is answered, with 0 echo mismatches.
- Leg O1: `pass`. Every other leg and figure of `itest:alrunner-v3` is unchanged, per mutant.

## Judgement
- A writer value in any Reader entry (carry-over within or across requests) is `gate-fail`: that build cannot become
  `current`, because R778's kill-pair batching rests on per-entry isolation.
- A Writer test that does not pass is also `gate-fail`: the leg could not set the state, so it proves nothing.
- A request the daemon cannot run at all (spawn, compile, transport) is `infra-fail`, as other legs read it.
- Any other difference from the figures above is a BLOCK until explained, in a dated addendum, never an edit of this
  file.
- Per R777, the update gate reads `infra-fail` for `current` until it is regated at a commit that has O1: `--regate` of
  `current` runs right after the merge, with lethal-spare.
