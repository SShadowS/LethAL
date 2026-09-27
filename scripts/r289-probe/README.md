# R289 probe P1: sidecar and container collector

Two monitors that run BESIDE the real `itest:hang` gate, so the gate's hang can be put on one
timeline. The predictions, the reading rules and the stop rule are pre-committed in
`docs/superpowers/specs/2026-09-27-r289-probe-precommitment.md`; this folder only collects.

**Wedge risk: yes.** The gate they run beside wedged Cronus28 on 2026-09-26. Run only under
`coord lease <container> <lane>`, one run at a time, and never restart the container or its server.

## Scripts

- `sidecar.ts --container <name> --config <fixture>/lethal.config.<x>.json --user <sidecar BC user> --password <its password> --out <file> [--stop-file <path>] [--seconds <n>]`
  (or `--creds <gitignored json file with {"user":..,"password":..}>` instead of `--user`/`--password`).
  Every 2 s, each with a 10 s timeout: `GET Company` (tenant query only),
  `POST LethALControl_RegisteredArtifact` (no lock) and `POST LethALControl_RenewLease` with a bogus
  lease (takes the `LC Lease` lock, changes nothing, answers `renewed: false`). At most
  `MAX_CONCURRENT` (2) of these run at once, enforced in code by `pickProbesToRun` (round-robin, so
  the cap does not starve the same probe every tick; see `sidecar.test.ts`): never all three
  together. `$metadata` is NOT probed: see "Why no $metadata" below. One NDJSON line per call:
  `{ probe, sentAt, endAt, ms, status?, error?, timedOut, value? }`, times are local `Date.now()`. A
  probe whose previous call is still open logs `{ probe, sentAt, skipped: "previous still open" }`;
  one skipped by the concurrency cap logs `{ probe, sentAt, skipped: "concurrency cap" }`. Neither
  sends a request that tick.

  The sidecar authenticates as a SEPARATE BC user, never the gate config's. It refuses to start if
  `--user` (or the creds file's `user`) equals the gate config's `bcdev.username`. Keep the creds
  file out of git: this repo's `.gitignore` covers `scripts/r289-probe/sidecar-creds.*.json`, so name
  it that way.
- `container.ps1 -Container <name> -Config <same config> -Out <file> [-Parts sql,service,stats,sessions] [-StopFile <path>] [-Seconds <n>]`
  Every 5 s: SQL requests (`sys.dm_exec_requests`, blocking session, wait type and resource),
  the NST service status, `docker stats`, and `Get-NAVServerSession`. Each line carries host
  `sentAt`/`endAt` epoch ms. A failed SQL collection is written as `{ sql: "failed", error }`.
  On exit it dumps the container's Application event log (Dynamics sources) for the run window,
  stamped with the container's clock.

Both read the server from the gate's own config (the sidecar through the runner's `odataBaseUrl`,
the same call `hang.itest.ts` makes) and REFUSE to start unless its host equals `--container`.
Company and tenant come from the same file; the sidecar's own credentials never do.

### Why no $metadata

The P1 dry runs on 2026-09-27/28 found `GET $metadata` a bad probe: it answers headers fast, then
the body stalls short of complete (65,262 bytes, never finishing) and holds the connection until the
sidecar's own 10 s timeout. Held often enough, it can use up one of the SAME BC user's 5 concurrent
OData V4 slots (BC throttles per user; event 705 "Request was throttled" was seen at 5 running, 6
waiting). A probe meant to watch for throttling must not risk causing it. See the pre-commitment
spec's ADDENDUM (`docs/superpowers/specs/2026-09-27-r289-probe-precommitment.md`) and
`docs/measurements/2026-09-27-nst-wedge-incidents.md`.

Ceiling: inside one `container.ps1` tick the parts run in series. A `Get-NAVServerSession` that
hangs on a wedged server stalls that instance's later ticks, so for P1 run two instances: one with
`-Parts sql,service,stats` and one with `-Parts sessions`, each with its own `-Out`.

## One P1 run

```bash
S=<scratchpad>/r289; R=1; rm -f $S/stop
bun scripts/r289-probe/sidecar.ts --container Cronus284 --config fixtures/sandbox-hang/lethal.config.cronus284.json \
  --creds scripts/r289-probe/sidecar-creds.cronus284.json \
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
