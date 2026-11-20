# PR-255 pre-commitment: gate a locally built upstream MAIN commit as `current`

Lane lethal-bugs, coord PR-255, 2026-11-20. Owner's ruling (q-20261120T084258-a6351212): "gate a recent upstream main build as
current yourself; no upstream request for an edge cut. Use your gate with its known-loss rules (O1 / #8239 and the by-value
SetFilter set-aside, both rule-3-correct on main), and take stop-after-first-failure (#8484, field stopAfterFirstFailure) with it."
Committed before any code. Part 2 (the expected leg changes) is an amendment written from the private gate's receipts, before the
real gate runs.

## Why
Upstream's `edge` tag has not moved since 4ebfe7913 (2026-11-15). Main is 660 commits ahead, and #8484 (f7b156fb4, the
second-largest DO speed lever, R1146) reaches `current` only through a main build.

## The build
- **Upstream main commit:** 9835579c66843ef7442d449b18f395087ed106f6, the merge of train-261120k (#8559), 2026-11-20 08:51Z.
  - Upstream's push checks passed (corpus, merge push check). Tests run on each train's pull request.
  - It contains f7b156fb4 (#8484), f9116dc96 (the O1 partner-login refusal, #8239), b805a9561 (#8244) and d0155ce2e (#8166).
- **Built here** with upstream's own recipe, `cargo build --release --locked -p alrunner-cli`, plus
  `ALRUNNER_VERSION_SUFFIX=+main.20261120`.
  - It is a glibc build, as perf-combined was. Edge is musl, and the container has no musl target.
  - The version reads `al-runner 3.0.0-alpha.14+main.20261120 (9835579c6)`.
  - The clone and build are at /coord/handoff/PR-255/.

## The code path (part 1), the smallest one
`bun scripts/al-runner-v3-update.ts --main <binary>` gates ONE local binary of an upstream main commit through `gateOne`, as an
edge candidate is gated, with these differences:
1. **No download.** The binary is the local file, and its sha256 is taken once and checked at the gate (as `--edge-rejudge`'s
   custody check does).
2. **The version must read `+main.YYYYMMDD (<hex>)`.** Anything else (an edge, a release, a fork, no commit) is refused by name
   before any gate, and nothing is written.
3. **It moves `current` only FORWARD,** by the same `commitOrder` check as edge: behind or diverged means no move, "a person decides".
   It is deferred when `current` is in use (`inUse`), as edge is.
4. **Folder:** `<root>/main-<commit>/` (al-runner, sidecar, .gated, gate.log, receipt). **Ledger row:** id `main-<commit>`,
   `track: "main"`, a new track. It is the record of what `current` was, as `edge` is, never the manifest. `GatedBuildEntry`'s
   strict parse accepts "main" and nothing else new.
5. **Failure handling:** `failed/`, `held/` and infra counting work as for edge.
6. **Unchanged:** the daily run (no flag) and `--edge`, `--regate`, `--edge-rejudge`, `--root --local-candidate`. The daily run
   never builds or gates a main commit.
7. **After `current` is a main build,** the edge track sees edge 4ebfe7913 as behind and does nothing: `current` never moves
   back to edge.

## PR-235's run is safe
The move writes `<root>/main-<commit>/` and swaps the `current` link atomically. It never writes edge-4ebfe7913's folder or its
`.gated`. code's PR-235 runs that binary by its versioned path. A test asserts the old build's folder is byte-identical after a move.

## Tests (red first)
- **Daily and edge unchanged:** the existing al-runner-v3-update tests pass unchanged, and a run with no flag never gates a main
  build.
- **`--main` refusals:** an `+edge` version, a release version, and a version with no commit are each refused by name, with
  nothing written.
- **A pass:** it writes `main-<commit>/`, a ledger row `main-<commit>` with track `main`, and moves `current` forward. A
  behind/diverged commit is not moved. The old build's folder is unchanged.
- **The strict parse:** it accepts `track: "main"` and still refuses any other track.

## Order
1. Build.
2. Private gate (`--root /coord/handoff/PR-255/root --local-candidate`, receipts only) to measure every leg.
3. Amendment: every expected leg change and the hand pin this exact binary needs (O1's partnerLoginRefusal, PR-233's rule, and any
   other moved reading, each named). An unexpected one means stop and report.
4. The code above.
5. Review, VERIFY, CI, merge.
6. `--main` with the real root.
7. Report.

Any difference the amendment did not pre-commit is a BLOCK, and `current` does not move.
