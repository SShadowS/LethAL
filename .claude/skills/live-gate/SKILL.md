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
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
```
Connection details come from the gitignored `fixtures/sandbox-app/.vscode/launch.local.json` + `fixtures/sandbox-app/lethal.config.local.json` (Cronus281, sshadows/1234, company `CRONUS Danmark A/S`, tenant default).

## Expected (frozen — BLOCKED on any difference)
- **bcdev**: killed **3** / survived **10** / no-coverage **3** (23.1%), baseline green, per-mutant baseline matches `packages/runner/itest/bcdev.baseline.json`, all protocol-invariant probes pass, ≥1 clean attestation (`observedAny && !identityMismatch`) per deployed artifact, NO `identityMismatch` on any run.
- **al-runner**: killed **3** / survived **13** / no-coverage **0** (18.8%).

## On failure
BLOCKED. Live execution is the authority — diagnose the root cause (not a shotgun retry), fix in one commit, re-run. Do not proceed on a differing verdict, failing probe, attestation mismatch, or a never-attested artifact.

## Optional (touches shared infra)
```bash
LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish
```
