# R-587 pre-commitment: `itest:alrunner` sequential and parallel are identical per mutant (2026-10-21, lethal-preproc)

Written BEFORE either live run. Plan: `docs/superpowers/plans/2026-10-21-r587-alrunner-leg-split.md` (r2).
Branch `lethal/r587` at b6c5b9c8. al-runner `v2.12.0-main.f06ee78c` (`/work/tools/al-runner/current` →
`/work/tools/al-runner/f06ee78c`).

## The legs (registry `packages/runner/itest/alrunner-legs.ts`, in order)

| Group | Leg ids |
|---|---|
| sandbox | sandbox-a, sandbox-b, sandbox-server, sandbox-resource, cli-default |
| layout | layout-one-shot, layout-server |
| multiobject | multiobject-one-shot, multiobject-server, multiobject-resource |
| wrapped | wrapped-one-shot, wrapped-server, wrapped-resource |
| names | names-a1, names-a2, names-a3, names-a4 |
| symbols-lethala | symbols-lethala-one-shot, symbols-lethala-server, symbols-lethala-resource |
| symbols-lethalb | symbols-lethalb-one-shot, symbols-lethalb-server, symbols-lethalb-resource |

`cli-default` now runs 5th (the end of the sandbox group), not last.

## Run S (full, sequential) and run P (full, `--parallel=3`, receipt challenge set), one after the other

**S command:**
```
bun scripts/itest-timeline.ts run /coord/handoff/R-587/seq -- env LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner -- --reports /coord/handoff/R-587/seq/reports
```
P is the same under `/coord/handoff/R-587/par`, with `--parallel=3` and the four `LETHAL_GATE_*` variables set
(the receipt goes in `/coord/handoff/R-587/par/receipt.json`). Each starts only when at most one other heavy
job runs. P counts as ONE heavy job.

**Predicted:**
1. **The last lines.**
   - S and P both end with exactly `al-runner itest: PASS`, exit 0, with every leg's existing checks passing:
     the baselines, the pre-committed tables, `REPRODUCTION_EXPECTED`, R147, R321 and R353.
   - Every leg's verdicts are unchanged against its committed baseline, exactly as master's gate.
   - The cli-default reorder changes no verdict.
2. **The reports.** Each reports dir holds `run.json`, 23 `<id>.json` and 7 `<group>.done.json`, all with the
   run's own nonce.
3. **Equality.** `bun scripts/alrunner-legs-diff.ts /coord/handoff/R-587/seq/reports /coord/handoff/R-587/par/reports`
   exits **0 (IDENTICAL)** on all 23 legs:
   - per `keyOf` key: verdict, `killingTest`, `coverageFiltered`, `errorClass` and the mutated-text hash;
   - `killingTestFailure` is equal per mutant on the names and wrapped legs (both pin kill text against
     pre-committed tables, so it is stable across runs);
   - `textUnverified` is 0 on every leg, and the build lines are equal.
4. **The receipt.** P's receipt passes `validateReceipt` with `expectedSublegs` = exactly the 23 ids above.
5. **P's warm-up:**
   - it prints the contract probe, the R551 probe, and one `provisionOnce` line per distinct (testDir, symbols)
     pair;
   - all of them name ONE platform-apps directory;
   - every worker's build line equals the supervisor's.
6. **Memory.** P's peak tree PSS is ≤ 8 GB.
7. **Timing (reported, not a pass criterion).** P is about 1200-1500 s against S about 3000 s; one-shot legs
   slow by at most 1.3x.

**Failure rules.**
- A verdict that differs between S and P, a mutant that becomes `timeout-killed` under load, or any other
  failure is a BLOCK, reported as it is. The remedy for a load effect is a lower N, never a looser check.
- If S and P print different al-runner build lines (the binary moved between them), the comparison is VOID:
  neither pass nor fail, and it is re-run.

## Live red checks (cheap, layout group, about 170 s each)
- `--legs layout` (no challenge): last line `al-runner itest: PARTIAL, 2 of 23 legs ran green (layout-one-shot,
  layout-server); NOT a gate pass, run without --legs for submit and merge`, exit 4, no receipt. Already seen
  once in the build smoke (`/coord/handoff/R-587/smoke-layout.console.txt`); repeated after P.
- `--legs layout` with a receipt challenge set: exit 2 and a `failed` receipt.
