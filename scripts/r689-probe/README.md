# R689 probe: what BC records for a test codeunit whose OnRun raises during suite discovery

**Status: built and compiled offline only, run on NO server.** Pre-commitment:
`docs/superpowers/specs/2026-10-25-r689-onrun-discovery-precommitment.md`.

Question (R689): when a test codeunit's `OnRun` raises, BC's suite discovery (`SelectTestMethodsByRange`) lists none
of its methods, and LethAL Control answers only "found 0". Does BC record the error anywhere (the codeunit's own
`Test Method Line`), and can LethAL read it without changing LethAL Control?

Invented AL, no tables, no loops (R164). Publisher `LethAL Probe`.

| App | Set 1 id | Set 2 id (NOT built) | Objects |
|---|---|---|---|
| R689 Probe Target (P) | `b3bda25b-cff0-435a-b6b3-1331dd8f7862` | `f43911b4-e08f-4e5e-9c41-7d39bc745544` | codeunit 93880 (93887-93889 reserved for LethAL's injected objects) |
| R689 Probe Tests (Q) | `09518c22-cda3-4945-9d08-1d6c6ce4bc65` | `22a60588-baef-4df2-9262-4d75609af0e0` | 93890 "R689 Throwing Tests" (OnRun raises `R689 onrun boom 93890`), 93891 "R689 Plain Tests" |
| R689 Probe Reader (R) | `2565f0ea-4068-4c22-8ddf-a3e6fb3cdfe0` | `05925c49-e757-45fa-88e9-b2f336470455` | 93900 "R689 Reader" (web service `R689Reader`), 93901 its install codeunit, 93902 discovery inside `Codeunit.Run` |

The reader is a measuring tool: `Discover`, `ControlSuites`, `WebServices` and `DeleteOwn` (see the pre-commitment).
For a re-run, replace the ids in the three `app.json` files (and Q's dependency block) and in `drive.ts`.

## Run

Build once, offline. It uses System from `/coord/cache/bc-symbols/<server>`, plus the Test Runner symbols from
`fixtures/sandbox-coverage-probe/.alpackages` (gitignored) for the reader. Do not rebuild after a pre-commitment records
the hashes.

    bun scripts/r689-probe/drive.ts --build --server bc2

Under a lease on the server, after `bc-linux-setup.ts --server bc2`, from the worktree root:

    bun scripts/r689-probe/drive.ts --server bc2 --lane <lane> --all

It refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. Apps are read by id only (R433). Each direct call
times out at 120 s, and the LethAL run at 900 s. Every answer goes whole to `.kraken-local/r689-probe/`.

## Leftovers

The server keeps installed-version records for P (LethAL's minted version), Q and R (1.0.0.1), and LethAL Control's
LC suite rows, until a restart (R605). Cleanup's `DeleteOwn` removes the reader's suite R689D and its Tenant Web
Service row. If step 1's absent-check refuses, `--all` still cleans up, which removes only this probe's own app ids.
