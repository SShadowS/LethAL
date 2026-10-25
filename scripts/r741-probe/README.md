# R741 probe: which object id BC names for a stale member the target added through an extension

**Status: run twice on bc2, 2026-10-24** (`/coord/handoff/R-741/measure.md`): run 1 with id set 1, run 2 (the live
proof of R749) with set 2, which `drive.ts` and the `app.json` files now carry. A re-run needs a third id set: bc2 keeps
both sets' records until a restart. Pre-commitment:
`docs/superpowers/specs/2026-10-24-r741-extension-member-id-precommitment.md` and its addendum 1.

Question (R741): R738 refuses "Function ID <n> was called. The object with ID <id> does not have a member with that
ID." when `<id>` is one of the target's declared objects. When the stale member is a procedure the target added
through a `tableextension` or `pageextension`, does BC name the extension's own id (R738 then refuses, as it should)
or the BASE object's id (R740's dependency refusal then fires, with the cause misattributed)?

Invented AL, one table (the base app's), no loops (R164). Publisher `LethAL Probe`.

| App | Set 1 id | Set 2 id (NOT built) | Objects | Builds |
|---|---|---|---|---|
| R741 Probe Base (B) | `35e61124-0818-4a55-bb52-a59e866d2f43` | `28c577b9-5e6a-4735-add0-bd6c3f451ea6` | table 93850 `R741 Base`, page 93851 `R741 Base Card` | `base/` 1.0.0.1 |
| R741 Probe Target (P) | `7eafd7d0-28ea-4943-862f-61dc273065b9` | `15fda437-a323-4426-8a43-1e24acfb18b2` | tableextension 93860, pageextension 93861 (93867-93869 reserved for LethAL's injected objects) | `target-v1/` = T1, published before the run: `Answer`, `Other(X)` on the table, `PageAnswer`, `PageOther(X)` on the page. `target/` = the run's SOURCE, without `Answer` and `PageAnswer` |
| R741 Probe Tests (Q) | `ef054a8e-e34c-4102-a551-200b153aaea5` | `87ce8474-9f15-4641-bbed-b8d6ae3c0103` | codeunit 93870 | `tests/` 1.0.0.1, against B and T1. Tests: `TestTableAnswer`, `TestTableOther`, `TestPageAnswer`, `TestPageOther`, `TestFails` (a genuine failure) |

For a re-run, replace the ids in the four `app.json` files (and the dependency blocks) and in `drive.ts`.

## Run

Build once, offline (System symbols from `/coord/cache/bc-symbols/<server>`, no server call). It compiles B, T1, Q
(against B and T1) and `target/` (against B, to prove it compiles) into `.kraken-local/r741-probe/` with `shas.json`.
Do not rebuild after a pre-commitment records the hashes.

    bun scripts/r741-probe/drive.ts --build --server bc2

Under a lease on the server, after `bc-linux-setup.ts --server bc2`, from the worktree root:

    bun scripts/r741-probe/drive.ts --server bc2 --lane <lane> --all

It refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. Apps are read by id only (R433). Each direct
call times out at 120 s. Each step prints one JSON line.

## Steps

1. Publish B, T1, then Q directly; read back installed 1.0.0.1.
2. Build `.kraken-local/r741-probe/pkgcache/` (the shared symbol cache's `.app` files plus B, which the target
   depends on and the shared cache lacks) and write `.kraken-local/r741-probe/run.config.json`, the sandbox-app config
   with only `bcdev.packageCachePath` changed (mode 600, never printed, removed by cleanup). Then run LethAL as a child
   process (900 s timeout), stdout and stderr whole to `run-stdout.txt` / `run-stderr.txt`, exit code in the JSON
   line. The argv:
   `bun packages/runner/src/cli.ts run --project scripts/r741-probe/target --tests scripts/r741-probe/tests
   --backend bcdev --config .kraken-local/r741-probe/run.config.json --selector-id 93867 --control-id 93868
   --table-id 93869 --db .kraken-local/r741-probe/run-<ms>.sqlite --out .kraken-local/r741-probe/report.json
   --progress-out .kraken-local/r741-probe/events.ndjson`
3. Read the rows of B, P and Q by id.
- `cleanup`: uninstall then unpublish Q, then every row of P, then B; read back absent.

`--all` runs 1..3 then cleanup (cleanup also runs on failure, then the error is rethrown).

## Leftovers

- bc2 keeps installed-version records for B and Q (1.0.0.1) and P (LethAL's minted version) until a restart (R605),
  and the base table's schema.
- The control app's registry and op rows from the run stay, harmless, until a restart.
