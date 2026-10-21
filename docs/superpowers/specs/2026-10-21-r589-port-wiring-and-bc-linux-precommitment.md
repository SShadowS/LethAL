# R-589 pre-commitment: the port wiring changes no Cronus28 verdict, and bc1-bc3 reproduce itest:bcdev

Committed by lethal-code, 2026-10-21, before any live gate run of the R-589 code.
Code under test: branch `lethal/r589` at 69a7f009 (folds R591 in: `configuredOdataBaseUrl`,
`odataUrlsOf` with the optional `apiBaseUrl`, `devPortOf`, `altoolServerArgs`).

## The claim

With the port wiring in place, every Cronus28 BC gate gives **the same verdict per mutant as its
committed baseline**, keyed by the baseline's identity key, and the same pinned counters. Any
difference in a verdict, in a killing test where the gate pins one, or in a pinned counter is a
BLOCK and is recorded, never reinterpreted.

## Why no change is predicted

Cronus28's configs name no `port` and no `baseUrl`. For that shape the change is, by construction:
- OData: `configuredOdataBaseUrl` returns `odataBaseUrl(server, instance)`, the URL the itests built
  before (`http://cronus28:7048/BC`).
- bc-dev-mcp: `devPortOf` adds nothing, so the backend config is byte-identical.
- API reads (companies, extensions): with no `apiBaseUrl` they go to the OData root, as before
  (`http://cronus28:7048/BC/api/...`).
- altool: `altoolServerArgs` returns `["--server", server]` with no `--port`, so the argv is
  identical (pinned exactly in `packages/runner/tests/port-wiring.test.ts`).

So the live run checks that nothing else moved (the unit tests already pin the three planes). A
pass here says nothing about bc1-bc3; their proof is R589 step 4, pre-committed separately.

## The gates, with the figures to reproduce

Figures are the committed baselines' (`packages/runner/itest/*.baseline.json`, counted
2026-10-21 at 4a3937e6) and, where CLAUDE.md pins more, CLAUDE.md's counters.

| gate | baseline | per-mutant figure | also pinned |
|---|---|---|---|
| `itest:bcdev` | `bcdev.baseline.json` | killed 3 / survived 12 / no-coverage 4 (19) | `groupedCalls` 15; `warmKills` 0, every kill at `killPosition` 1; zero `session-reused`; `assertionScreen.discrimination` `vacuous` |
| `itest:tables` | `tables.baseline.json` | killed 314 / survived 70 / no-coverage 22 (406) | CLAUDE.md's prose still says 301 / 68 / 18 over 387, `groupedCalls` 382, `warmKills` 13: **stale**, the committed baseline is the authority. Also: exactly one expected baseline failure, `Data Tests.PageActionComputesNonZero`; `untargetedTriggerCount` 0; `platformArtifactKills.killedCount` 2; `declarativeSites` 1 in 1 file; discrimination `partial`; the gate's own `groupedCalls` / `warmKills` / named warm positions as asserted in the itest |
| `itest:chunked` | none (differential) | both legs 17 / 7 / 2, every verdict and `killingTest` identical | control `warmKills` 9 / `groupedCalls` 33; chunked leg 5 / 57 |
| `itest:hang` | `hang.single.baseline.json` | killed 24 / survived 9 / timeout-killed 5 (38) | the gate's own hang-refusal assertions |
| `itest:harden` | `harden.baseline.json` | killed 16 / survived 5 (21) | the gate's own planted-survivor assertions |
| `itest:bcdev-names` | `bcdev.names.baseline.json` | killed 36 / 0 / 0 | killing test per row, as pre-committed for R557 |
| `itest:bcdev-wrapped` | `bcdev.wrapped.baseline.json` | killed 60 / survived 38 / no-coverage 0 (98) | both legs (fenced, procedure) equal |
| `itest:verify`, `itest:agreement`, `itest:verify-scale` | none | the gate passes | their own assertions |
| `itest:testapp`, `itest:stale-publish`, `itest:lease` | none | the gate passes | their own assertions |

`itest:envtool` and `itest:alrunner` are not affected (no `ContainerDeployer`/OData change on their
path beyond `odataCfgFor`, whose output is unchanged for a config without `baseUrl`) and are not
part of this claim.

## Minimum run

`itest:bcdev` and `itest:tables` on Cronus28 (they cover the OData, dev-endpoint and altool planes on
both fixture shapes). The rest at the orchestrator's choice; each one that runs is held to its row.

## bc1, bc2 and bc3 (BC 28.4 on Linux, W1)

`scripts/bc-linux-setup.ts` set up bc1 before this run. Login worked, the control app 1.0.0.22 and the sandbox
app, data, hang and harden pairs are published, and `lethal doctor` passes on all four configs. The company is
"CRONUS International Ltd." and the localization is W1, where Cronus28 is DK.

**Prediction.** `itest:bcdev`, run against each server's config, gives the SAME verdict per mutant as
`bcdev.baseline.json` (3 / 12 / 4 over 19), with the same pinned counters. The fixture's AL does not depend on
localization.

**Any verdict difference is a BLOCK.** It is recorded per mutant (company, localization, or a BC-on-Linux behaviour
difference) and reported to the orchestrator, never reinterpreted and never re-recorded.

bc2 and bc3 are held to the same row once their setup passes `doctor`.

## Results (added 2026-10-21, after the runs; the claim above is unchanged)

- **bc1, bc2, bc3: PASS.** `itest:bcdev` gave 3 / 12 / 4, per mutant equal to `bcdev.baseline.json`, and the
  protocol-invariant probes passed. The final runs: bc1 and bc3 at f17a41d9, bc2 at 80ebe83f. Each log's first
  line names its target. Logs: `/coord/handoff/R-589/runs/`.
- **Cronus28 rows: NOT RUN** (environment). Cronus28 has been unreachable since about 14:16Z, at its new address
  172.23.18.89. These rows did not pass, and they are not claimed. On the orchestrator's ruling, R-583's Cronus28
  BC phase runs `itest:bcdev` and `itest:tables` under master's code with this change merged, and so stands in for
  them. A difference there is a BLOCK on master.
