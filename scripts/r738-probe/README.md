# R738 probe: what a real `lethal run` does with a tests app left stale by an altool publish

**Status: built and compiled offline only, run on NO server.** Plan: `/coord/handoff/R-738/plan.md`.

Question (R738): R728 measured that altool ACCEPTS a target upgrade that removes a member the installed tests app
calls. Does a real `lethal run` then refuse by name, or drop the test from the green set silently?

Invented AL, no tables, no loops (R164). Publisher `LethAL Probe`.

| App | Id | Objects | Builds |
|---|---|---|---|
| R738 Probe Target (P) | `9ab6e9c7-80ec-440d-b1d9-13bf0799890d` | 93790-93799 (93797-93799 reserved for LethAL's injected objects) | `target-v1/` = T1, published before the run: `Answer`, `Other`, `Scale(X)`. `target/` = the run's SOURCE (no `Answer`; `Scale(X, Y)`) |
| R738 Probe Tests (Q) | `e08e9874-95dd-4a77-b4d4-bb1fdee916d2` | 93800-93809 | `tests/`, 1.0.0.1, depends on P >= 1.0.0.1, compiled against T1 (it will not compile against `target/`). Tests: `TestAnswer`, `TestOther`, `TestScale`, `TestFails` (a genuine failure) |

Second id set for a possible re-run (NOT built; replace the ids in both `app.json` files, the `drive.ts` constants and
the tests' dependency block): target `ed1d8576-28e2-4c30-bff1-827dd234b9b1`, tests
`2dcfea83-366b-4775-9b7f-003247b39755`.

## Run

Build once, offline (System symbols from `/coord/cache/bc-symbols/<server>`, no server call). It compiles T1, Q
(against T1) and `target/` itself (against the shared symbol cache, to prove it compiles), into
`.kraken-local/r738-probe/` with `shas.json`. Do not rebuild after a pre-commitment records the hashes.

    bun scripts/r738-probe/drive.ts --build --server bc2

Under a lease on the server, after `bc-linux-setup.ts --server bc2` (it writes the config), from the worktree root:

    bun scripts/r738-probe/drive.ts --server bc2 --lane <lane> --step 1   # then 2, 3, cleanup
    bun scripts/r738-probe/drive.ts --server bc2 --lane <lane> --all

It refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. Apps are read by id only (R433). Each direct
call times out at 120 s. Each step prints one JSON line.

## Steps

1. Publish T1 then Q directly; read back installed 1.0.0.1.
2. Run LethAL as a child process (900 s timeout), stdout and stderr whole to `run-stdout.txt` / `run-stderr.txt`,
   exit code in the JSON line. The argv:
   `bun packages/runner/src/cli.ts run --project scripts/r738-probe/target --tests scripts/r738-probe/tests
   --backend bcdev --config fixtures/sandbox-app/lethal.config.<server>.json --selector-id 93797 --control-id 93798
   --table-id 93799 --db .kraken-local/r738-probe/run-<ms>.sqlite --out .kraken-local/r738-probe/report.json
   --progress-out .kraken-local/r738-probe/events.ndjson`
3. Read the rows of P and Q by id.
- `cleanup`: uninstall then unpublish Q, then every row of P (any version); read back absent; print what remained.

`--all` runs 1..3 then cleanup (cleanup also runs on failure, then the error is rethrown).

## Leftovers

- bc2 keeps installed-version records for P (at LethAL's minted version) and Q (1.0.0.1) until a restart (R605).
- The control app's registry and op rows from the run stay, harmless, until a restart.
- Check that bc2 has no quarantine record after the run.
