---
name: live-gate
description: Run the LethAL live integration gate against the Cronus BC container — the frozen per-mutant tables through both backends. Use when validating a layer end-to-end on live infra, or when the user says "run the live gate" / "run the itests live". Publishes to a live BC container, so it is user-invoked only.
disable-model-invocation: true
---

# Live gate

The authority for LethAL correctness (unit tests are structurally blind to AL that can't compile / real BC behavior). Runs the env-gated integration itests foreground and checks the frozen per-mutant tables. A differing verdict = BLOCKED (a real regression), never "close enough".

## Prerequisite: harness + publish order (bcdev path)
The instrumented target depends on the `LethAL Control` extension and every RunMutant routes through it. Publish order to the container (Cronus281):
1. `LethAL Control` (`extensions/lethal-control`) — must expose `HarnessInfo`, `RegisterArtifact` is IN-PROCESS only (no OData write), `RegisteredArtifact` + `RunMutant` OData actions.
2. The instrumented sandbox target (the itest publishes it — needs the LethAL Control dependency + `lethal-control.app` symbol staged).
3. `fixtures/sandbox-tests`.
4. `fixtures/sandbox-probes` (protocol-invariant probes).

Precondition: at most ONE instrumented target installed per container; no concurrent/external publish during the run.

## Run (foreground — do NOT poll/background)
```bash
cd U:/Git/LethAL
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
```

**The al-runner leg GATES again** (R93 closed, `51e6415`). It was skipped while v2's CLI rewrite left it unrunnable; the adapter landed and it passes per-mutant on v2.

```bash
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
```

**Check the al-runner version before trusting a verdict from this leg.** al-runner publishes several times a day, and it is a globally-installed dotnet tool that `dotnet tool update` can move between one gate run and the next. Measured 2026-08-07: 2.0.0.0 reported a runner-enforced timeout as `TIMEOUT after <n>s`, and 2.0.1.0 — released the same day — changed it back to `Test exceeded <n>s timeout.`. The gate prints `al-runner build under test: <version>` as its first line; read it. If it is not what the freeze below names, that is a TOOL change, not a code regression — re-measure the contract (`docs/measurements/README.md` §"al-runner v2") before touching anything. `dotnet package search MSDyn365BC.AL.Runner --exact-match` lists what is published.
Connection details come from the gitignored `fixtures/sandbox-app/.vscode/launch.local.json` + `fixtures/sandbox-app/lethal.config.local.json` (Cronus281, sshadows/1234, company `CRONUS Danmark A/S`, tenant default).

## Expected (frozen — BLOCKED on any difference)
- **bcdev**: killed **3** / survived **12** / no-coverage **4** (20.0%), baseline green, per-mutant baseline matches `packages/runner/itest/bcdev.baseline.json`, all protocol-invariant probes pass, ≥1 clean attestation (`observedAny && !identityMismatch`) per deployed artifact, NO `identityMismatch` on any run.
- **al-runner**: killed **3** / survived **16** / no-coverage **0** (15.8%), baseline green, per-mutant baseline matches `packages/runner/itest/al-runner.baseline.json` — **measured against al-runner v2.10.0.0** (2026-09-03). The 3 kills are the same three bcdev kills (`IsOverBudget`, killed by `OverBudgetDetected`, a bare `Error(...)` test). The 16 survivors are bcdev's 12 plus its 4 no-coverage mutants, which this backend runs (no coverage) and reports survived. The v1-era `asserterror` defect (R7) is fixed upstream: the canary reports `defect-not-reproduced` each session, and this fixture never exercised it either way.

## On failure
BLOCKED. Live execution is the authority — diagnose the root cause (not a shotgun retry), fix in one commit, re-run. Do not proceed on a differing verdict, failing probe, attestation mismatch, or a never-attested artifact. **No standing exceptions.** The al-runner one is retired: that leg gates again. Before diagnosing an al-runner failure as a code regression, check the version line the gate prints — an upstream release is the likelier cause and is not a regression.

## Optional (touches shared infra)
```bash
LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish
```
