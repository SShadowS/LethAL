# R-583 pre-commitment: the runtime-17 move changes no gate verdict

Committed by lethal-code BEFORE any live run of the R-583 build. Branch `lethal/r583`, plan
`docs/superpowers/plans/2026-10-18-r583-runtime-17.md` (plan r3).

## The change being gated
- Every committed fixture, example, `scripts/*-probe` and `extensions/lethal-control` `app.json` moves to
  `"runtime": "17.0"`. Each fixture and example version goes up one patch. LethAL Control becomes 1.0.0.22, and
  `MIN_CONTROL_VERSION` becomes 1.0.0.22.
- A runtime below 14.0 under the resource selector is refused by name (`ResourceSelectorRuntimeError`).
- An al-runner answer with TARGET-bundle compile diagnostics is never scored. The diagnostics are the
  `compilationErrors` field on either transport, plus the `EMIT-ZERO`, `EMIT-EXCLUDED` and `PARTIAL-EMIT-DROP`
  blocks in the invocation's own stderr, on one-shot only. On the baseline this refuses the session; on a mutant
  run every row becomes `error`.
- An offline alc compile before and after found no new or changed diagnostic
  (`/coord/handoff/R-583/compile-17.md`).

## Prediction
**Every gate below gives the same verdict for every mutant** as its committed baseline (and, where the gate
records them, the same killing test and pinned extras). The identity scheme stays 40. Every difference is a BLOCK,
reported to the orchestrator, never re-recorded.

| gate | fixture(s) | expectation |
|---|---|---|
| `itest:alrunner`, every leg (one-shot, `--server`, resource, cli-default, symbols LETHALA/LETHALB, layout, multiobject, wrapped) | sandbox-app/-tests, sandbox-symbols/-tests, sandbox-layout/-tests, sandbox-multiobject/-tests | per mutant identical to `al-runner*.baseline.json`; frozen 3/12/4, symbol sets 5/4/0, layout 7/3/0. Run on BOTH the pin f06ee78c and a scratch build of upstream 069cbf32 (which failed the gate before this change). |
| `itest:bcdev` | sandbox-app/-tests (+ sandbox-probes) | per mutant identical to `bcdev.baseline.json`; 3/12/4, groupedCalls 15, warmKills 0, assertionScreen `vacuous` |
| `itest:bcdev-wrapped` | its wrapped fixture | identical to its committed expectation |
| `itest:tables` | sandbox-data/-tests | per mutant identical to `tables.baseline.json`, including the one named baseline failure |
| `itest:chunked` | sandbox-data | both legs identical as frozen |
| `itest:hang` | sandbox-hang/-tests | identical to its committed expectation (the only gate exercising the stop path; needs control 1.0.0.22) |
| `itest:harden`, `itest:agreement` | sandbox-harden, -answers, -tests | per mutant identical to `harden.baseline.json` and the agreement expectation |
| `itest:verify`, `itest:verify-scale` | sandbox-app/-tests, sandbox-data | identical to their committed expectations |
| `itest:stale-publish`, `itest:testapp` | as committed | pass (`canonicalBuildInputs` includes `runtime`, so the test-app identity changes by design; the gates' own assertions must hold) |
| growth, lease, names (`itest:bcdev-names`) | as committed | pass |
| `itest:envtool` | sandbox-app via the env tool | **NOT RUN, unverified**: the environment was deleted and the tool is host-only. Its provisioning requirement is now BC 28+ |

**Measured expectation added by plan r3:** zero TARGET-bundle compile diagnostics on every leg of every
al-runner gate, on both builds. Test-app entries, if any, are listed in the result and must be the same on both
builds.

## Order
1. This pre-commitment, on master.
2. `itest:alrunner` on f06ee78c and on scratch 069cbf32. al-runner runs locally, with no BC.
3. The BC gates run only after LethAL Control 1.0.0.22 is on Cronus28 (recreated by the owner, set up over the
   dev endpoint) and on Cronus284, and `lethal doctor` shows control-version 1.0.0.22. Each fixture pair is
   rebuilt at runtime 17 and published under a lease, target first and then its tests app.
4. The results are recorded per gate in `/coord/handoff/R-583/gates.md`.
