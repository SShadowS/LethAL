# R740 probe: what a real `lethal run` does when a DEPENDENCY's member is stale under an unchanged tests app

**Status: built and compiled offline only, run on NO server.** Plan: `/coord/handoff/R-740/plan.md`.

Question (R740): R738 refuses a baseline failure "Function ID <n> was called. The object with ID <id> does not
have a member with that ID." only when `<id>` is a TARGET object. What happens when the stale member belongs to a
library the tests call: the library upgraded (altool accepts it, R728) under a tests app that was not recompiled?

Invented AL, no tables, no loops (R164). Publisher `LethAL Probe`.

| App | Set 1 id | Set 2 id (NOT built) | Objects | Builds |
|---|---|---|---|---|
| R740 Probe Lib (L) | `916727ff-fac6-40f5-bc66-38800422d6d6` | `edbf191d-45cd-45dd-bd38-f9910c0d60a7` | 93820-93829 | `lib-v1/` = L1 (1.0.0.1): `Helper`, `Other`. `lib-v2/` = L2 (1.0.0.2): `Other` only |
| R740 Probe Target (P) | `157d4738-4e4d-410b-b1be-743a3ba29106` | `ef6468b3-8053-4383-a69a-8114dd06fd12` | 93830-93839 (93837-93839 reserved for LethAL's injected objects) | `target/` 1.0.0.1, no dependency on L: `Scale`, `Plus`. It is both published (step 1) and the run's SOURCE |
| R740 Probe Tests (Q) | `a2a9b0bb-7274-42ae-8eee-89f12b23a6f2` | `a3014e4e-2f3e-4185-8fce-0519bd133e3a` | 93840-93849 | `tests/` 1.0.0.1, depends on L >= 1.0.0.1 and P >= 1.0.0.1, compiled against L1 and P. Tests: `TestLib` (`Lib.Helper()` then `Scale`), `TestPlus`, `TestFails` (a genuine failure) |

For a re-run, replace the ids in the four `app.json` files (and the tests' dependency block) and in `drive.ts`.

## Run

Build once, offline (System symbols from `/coord/cache/bc-symbols/<server>`, no server call). It compiles L1, L2, P
and Q (against L1 and P) into `.kraken-local/r740-probe/` with `shas.json`. Do not rebuild after a pre-commitment
records the hashes.

    bun scripts/r740-probe/drive.ts --build --server bc2

Under a lease on the server, after `bc-linux-setup.ts --server bc2`, from the worktree root:

    bun scripts/r740-probe/drive.ts --server bc2 --lane <lane> --step 1   # then 2, 3, 4, cleanup
    bun scripts/r740-probe/drive.ts --server bc2 --lane <lane> --all

It refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. Apps are read by id only (R433). Each direct
call times out at 120 s. Each step prints one JSON line. Nothing is truncated: long texts go whole to files in
`.kraken-local/r740-probe/`.

## Steps

1. Publish L1, P, Q directly; read back installed 1.0.0.1.
2. Publish L2 THROUGH LethAL's deployer (`deployerFor`, `publish({appPath, sha256})`, as r728-probe's step 3). A
   throw is recorded as a fact (`threw`, full text in `error-2.txt`), not rethrown. Then read L, P, Q, and record
   which version `dev/packages` serves for L.
3. Needs L installed at 1.0.0.2 and Q installed at 1.0.0.1, else refuses (exit 2). Then runs LethAL as a child
   process (900 s timeout), stdout and stderr whole to `run-stdout.txt` / `run-stderr.txt`, exit code in the line.
   The argv:
   `bun packages/runner/src/cli.ts run --project scripts/r740-probe/target --tests scripts/r740-probe/tests
   --backend bcdev --config fixtures/sandbox-app/lethal.config.<server>.json --selector-id 93837 --control-id 93838
   --table-id 93839 --db .kraken-local/r740-probe/run-<ms>.sqlite --out .kraken-local/r740-probe/report.json
   --progress-out .kraken-local/r740-probe/events.ndjson`
4. Read the rows of L, P, Q.
- `cleanup`: uninstall then unpublish Q, then every row of P, then every row of L; read back absent.

`--all` runs 1..4 then cleanup (cleanup also runs on failure, then the error is rethrown).

## Reachability

The stale state exists only because a publish skipped recompiling the dependents (altool). The dev endpoint's
"ignore" dependency option is unmeasured here.

## Leftovers

- bc2 keeps installed-version records for L (at 1.0.0.2), P (at LethAL's minted version) and Q (1.0.0.1) until a
  restart (R605).
- The control app's registry and op rows from the run stay, harmless, until a restart.
- Check that bc2 has no quarantine record after the run.
