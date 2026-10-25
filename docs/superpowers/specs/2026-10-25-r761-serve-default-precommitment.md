# R-761 pre-commitment (2026-10-25): serve-entries as the default v3 transport where proven; legs K and S1E

Committed before the gate run that proves R-761. Plan r2 is at `/coord/handoff/R-761/plan.md` (an opus plan review
BLOCKed r1, and every point is answered in r2; orchestrator-approved). The code is on lethal/r761 (dc855ac3 and
f53ec5d4). The binary is the pinned `current`, al-runner 3.0.0-alpha.5+edge.20261024 (dcdf9e821).

The figures below are from ONE observe run (`LETHAL_ITEST_OBSERVE_WARNINGS=1 LETHAL_ITEST_V3_LEGS=K,S1E`), receipt
`/coord/handoff/R-761/observe-K-S1E.log`. An observe run is never a pass. This file freezes those figures as the
expectation for the real gate.

## The rule being proved
A config with NO `transport` key resolves to serve-entries, unless one of these holds, in which case it resolves to
one-shot and LethAL emits ONE warning, `al-runner-v3-serve-default-fallback`, naming the reasons:
- `resume`;
- `multi-object-or-wrapped`;
- `unproven-test-name-shape` (method `/^[A-Za-z_][A-Za-z0-9_]*$/`, codeunit `/^[A-Za-z0-9_ .]+$/`, from the R-761
  inventory of D1, S1 and the gift card);
- `no-serve-build`.

An explicit `serve-entries` with a "." in a test METHOD name refuses before any test call, as
`AlRunnerV3ServeDottedTestNameError` (#5798). Explicit keys are honoured.

## Leg K (it takes the user-facing default; sandbox-app has plain names, no MO/WR shapes and no resume, so serve)
- Its figures move from one-shot to serve. Pinned facts:
  - coverage `"al-runner"`;
  - `inRunStopIsBudget` **false** (it was true);
  - serveSpawns **1** (it was 0);
  - oneShotTestCalls **1** (the baseline call; serve-entries keeps the baseline one-shot);
  - warned true (`AL_RUNNER_V3_NOT_AUTHORITATIVE`);
  - noCoverageFiles 4.
- Counts **3 / 12 / 4** over 19, errors 0, timeout-killed 0.
- **0 per-mutant differences** against `bcdev.baseline.json` (text verified 19 of 19). Any verdict difference is a
  BLOCK.
- `GATE_WARNINGS["al-runner-v3/K"]` = `[]`, unchanged. In particular `al-runner-v3-serve-default-fallback` must NOT
  appear on K.

## New leg S1E (in `V3_GATE_LEGS`, so the update gate proves the default's serve path on every build)
- S1's project and test app under `transport: "serve-entries"`, with S1's assertions:
  - counts **3 / 12 / 4** over 19;
  - **0 per-mutant differences** against `bcdev.baseline.json` (text verified 19);
  - baseline green;
  - no state, refused-nearby or §6 notes;
  - Sleep index 0 + 0.
- Serve counters, equal to R-653 E1's (`/coord/handoff/R-653/live/final/results.md`): pairRequests **3**, liveRequests
  **3**, boundChecks **5**, warmups **1**, entriesSent **44**, echoMismatches **0**.
- `GATE_WARNINGS["al-runner-v3/S1E"]` = `[]`.
- On a build with no serve-entries path (`V3_NO_SERVE_ENTRIES`, alpha.2), S1E reads "not applicable" and passes, as
  N1E does. The same refusal on any other build fails.

## Every other leg
C, S1, S3, N1, N1E, X, L1, Y-A, Y-B, MO, WR, D1, D1c and T: **unchanged**, with their existing figures and baselines.
They build their backends explicitly (`backendCfg`, no `transportSource`), so the default does not reach them.
- MO and WR stay one-shot by their pre-commitment.
- N1E still fails closed on #5798, because its backend gets an explicit transport with no `transportSource`, so the
  new dotted-name refusal is not on its path.

## Proof run
The full v3 gate on R-761's final head must pass all 16 legs (S1E is new), with update-gate outcome pass.

Also the gift-card campaign with no transport key:
- it resolves to serve (no fallback warning);
- 34 / 15 / 11;
- total, median and p90 reported against R760's one-shot (19.2 s) and serve (12.8 s).
