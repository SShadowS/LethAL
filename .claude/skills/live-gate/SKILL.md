---
name: live-gate
description: Run the LethAL live integration gate against the Cronus BC container — the frozen per-mutant tables through both backends. Use when validating a layer end-to-end on live infra, or when the user says "run the live gate" / "run the itests live". Publishes to a live BC container, so it is user-invoked only.
disable-model-invocation: true
---

# Live gate

The authority for LethAL correctness (unit tests are structurally blind to AL that can't compile / real BC behavior). Runs the env-gated integration itests foreground and checks the frozen per-mutant tables. A differing verdict = BLOCKED (a real regression), never "close enough".

## Prerequisite: harness + publish order (bcdev path)
The instrumented target depends on the `LethAL Control` extension and every RunMutant routes through it. Publish order to the container (Cronus28, or one of the BC on Linux servers `bc1`-`bc3`, which `scripts/bc-linux-setup.ts` prepares; Cronus284 is CentralGauge's, never LethAL's):
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

Inside the kraken container, run it from the repo checkout instead of `U:/Git/LethAL`; the gate reaches `Cronus28` by name. Publishing the control app Global is host-only: ask the owner.

**The al-runner leg is the Rust al-runner's gate, `itest:alrunner-v3`** (R586). The .NET al-runner's gate, `itest:alrunner`, was retired with that backend on 2026-10-22 (R654): it no longer exists, and `--backend al-runner` is refused by name. The v3 gate needs no BC server and no lease, and runs on Linux only.

```bash
LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3
```

The binary defaults to the pinned build (`/work/tools/al-runner-v3/current/al-runner`); `LETHAL_ALRUNNER_V3_PATH` overrides it.

**Check the al-runner build before trusting a verdict from this leg.** The backend refuses a build that its `.gated` file does not name (`AlRunnerV3UngatedBuildError`), so the pin moves only through `bun scripts/al-runner-v3-update.ts`, never by hand. If a leg differs after the pin moved, that is a TOOL change first, not a code regression: see `docs/gates/alrunner-v3.md` §"The pin and the update gate" and `docs/measurements/README.md` §"al-runner v3" before touching anything.
Connection details come from the gitignored `fixtures/sandbox-app/.vscode/launch.local.json` + `fixtures/sandbox-app/lethal.config.local.json` (Cronus28, sshadows/1234, company `CRONUS Danmark A/S`, tenant default).

## Expected (frozen — BLOCKED on any difference)
The frozen figures, per gate and per leg, are on the gate pages: `docs/gates/bcdev.md`, `docs/gates/alrunner-v3.md`, and the rest listed in `docs/gates/README.md` (`docs/gates/alrunner.md` is the retired .NET gate's page, kept as history). `packages/runner/tests/gate-pages.test.ts` keeps those pages equal to the committed baselines, so do not copy figures into this skill. On top of the figures:
- **bcdev**: baseline green, per-mutant baseline matches `packages/runner/itest/bcdev.baseline.json`, all protocol-invariant probes pass, ≥1 clean attestation (`observedAny && !identityMismatch`) per deployed artifact, NO `identityMismatch` on any run.
- **al-runner-v3**: every leg passes, and the itest asserts each leg's pre-committed table before its baseline. S1, S3 and K equal `bcdev.baseline.json` (`itest:bcdev`'s table) PER MUTANT. L1, Y-A, Y-B and the tables leg match their own baselines (`al-runner-v3.layout`, `al-runner-v3.symbols-lethala` / `-lethalb`, `al-runner-v3.tables`) per mutant. A missing baseline is refused; record one only by the R332 procedure (`LETHAL_ITEST_RECORD_BASELINE=<file>`, which exits 3, never a pass). The legs and their rules: `docs/gates/alrunner-v3.md`.

## On failure
BLOCKED. Live execution is the authority — diagnose the root cause (not a shotgun retry), fix in one commit, re-run. Do not proceed on a differing verdict, failing probe, attestation mismatch, or a never-attested artifact. **No standing exceptions.** Before diagnosing an al-runner-v3 failure as a code regression, check which build ran: a moved pin is the likelier cause and is not a regression.

## Optional (touches shared infra)
```bash
LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish
```
