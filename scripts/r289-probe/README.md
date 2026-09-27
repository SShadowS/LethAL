# R289 probe P1: sidecar and container collector

Two monitors that run BESIDE the real `itest:hang` gate, so the gate's hang can be put on one
timeline. The predictions, the reading rules and the stop rule are pre-committed in
`docs/superpowers/specs/2026-09-27-r289-probe-precommitment.md`; this folder only collects.

**Wedge risk: yes.** The gate they run beside wedged Cronus28 on 2026-09-26. Run only under
`coord lease <container> <lane>`, one run at a time, and never restart the container or its server.

## Scripts

- `sidecar.ts --container <name> --config <fixture>/lethal.config.<x>.json --out <file> [--stop-file <path>] [--seconds <n>]`
  Every 2 s, in parallel, each with a 10 s timeout: `GET $metadata`, `GET Company` (both with the
  tenant query only), `POST LethALControl_RegisteredArtifact` (no lock) and
  `POST LethALControl_RenewLease` with a bogus lease (takes the `LC Lease` lock, changes nothing,
  answers `renewed: false`). One NDJSON line per call: `{ probe, sentAt, endAt, ms, status?, error?, timedOut, value? }`,
  times are local `Date.now()`. A probe whose previous call is still open logs
  `{ probe, sentAt, skipped: "previous still open" }` instead of sending.
- `container.ps1 -Container <name> -Config <same config> -Out <file> [-Parts sql,service,stats,sessions] [-StopFile <path>] [-Seconds <n>]`
  Every 5 s: SQL requests (`sys.dm_exec_requests`, blocking session, wait type and resource),
  the NST service status, `docker stats`, and `Get-NAVServerSession`. Each line carries host
  `sentAt`/`endAt` epoch ms. A failed SQL collection is written as `{ sql: "failed", error }`.
  On exit it dumps the container's Application event log (Dynamics sources) for the run window,
  stamped with the container's clock.

Both read the server from the gate's own config (the sidecar through the runner's `odataBaseUrl`,
the same call `hang.itest.ts` makes) and REFUSE to start unless its host equals `--container`.
Credentials, company and tenant come from the same file.

Ceiling: inside one `container.ps1` tick the parts run in series. A `Get-NAVServerSession` that
hangs on a wedged server stalls that instance's later ticks, so for P1 run two instances: one with
`-Parts sql,service,stats` and one with `-Parts sessions`, each with its own `-Out`.

## One P1 run

```bash
S=<scratchpad>/r289; R=1; rm -f $S/stop
bun scripts/r289-probe/sidecar.ts --container Cronus284 --config fixtures/sandbox-hang/lethal.config.cronus284.json \
  --out $S/p1-$R-sidecar.ndjson --stop-file $S/stop &
pwsh -NoProfile -File scripts/r289-probe/container.ps1 -Container Cronus284 -Config fixtures/sandbox-hang/lethal.config.cronus284.json \
  -Out $S/p1-$R-container.ndjson -Parts sql,service,stats -StopFile $S/stop &
pwsh -NoProfile -File scripts/r289-probe/container.ps1 -Container Cronus284 -Config fixtures/sandbox-hang/lethal.config.cronus284.json \
  -Out $S/p1-$R-sessions.ndjson -Parts sessions -StopFile $S/stop &
LETHAL_ITEST_HANG=1 LETHAL_R289_TRACE=$S/p1-$R-trace.ndjson LETHAL_ITEST_CONFIG=lethal.config.cronus284.json \
  bun run itest:hang 2>&1 | tee $S/p1-$R-gate.log
touch $S/stop; wait
bun packages/runner/src/cli.ts doctor --config fixtures/sandbox-hang/lethal.config.cronus284.json
```
