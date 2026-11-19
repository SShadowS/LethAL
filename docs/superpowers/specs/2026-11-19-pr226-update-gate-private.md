# PR-226 design and pre-commitment: the al-runner update gate gates a local build privately (`--root`, `--local-candidate`)

Coord PR-226 (lethal-code, 2026-11-19). The owner's ruling, q-20261119T144716-dff42cde, option (1): add `--root` and
`--local-candidate` to `scripts/al-runner-v3-update.ts` through the normal reviewed landing. Then lethal-bugs gates
perf-combined (2bb4b686) into `/coord/handoff/PR-217` only, and runs PERF-10 on it. A gate fail is a finding for alrunner,
raised before any run.

## 1. Why it is needed
Today every gate path uses the fixed root `/work/tools/al-runner-v3` (`ROOT`), gates only upstream builds (a download
checked against SHA256SUMS), writes the ledger and `.gated`, may move `current`, and publishes ledger rows to master
(`publishToMaster`). A private fork build cannot be gated without touching the shared install.

## 2. The change
- **The command:**
  `bun scripts/al-runner-v3-update.ts --root <dir> --local-candidate <binary or folder with al-runner>`.
  The two flags come TOGETHER: either one alone is refused by name.
- **Refused by name:**
  - a `--root` that resolves (realpath of its nearest existing ancestor) to `/work/tools` or anywhere under it;
  - the flags combined with `--regate`, `--edge`, `--edge-rejudge`, `--refresh-rows` or `--pin-digests`;
  - a `--local-candidate` that is not an executable file (or a folder holding an executable `al-runner`).
- **What a private gate does** (`privateGateOnce`):
  1. It takes the gate lock in `<root>/.gate.lock`, and uses its OWN LethAL worktree, `<root>/gate-worktree`, never the
     shared `GATE_WORKTREE`. A new optional dep `gateWorktree`, default `GATE_WORKTREE`, is used by `runGate` and by the
     lock's orphan check. So it never shares a checkout with the daily update.
  2. It READS the shared `current` (its `.gated`, read-only) from `/work/tools/al-runner-v3`. The candidate is judged as
     an edge candidate is: at `current`'s `lethalCommit`, against `pinRootOf(current)` (LETHAL_V3_PIN_FROM). K runs on the
     candidate, and T and CDO run as in every gate.
  3. It runs `gateOne(deps with root = <root>, "local-<sha12>", current's gated, { binary, binarySha256, privateGate: true })`.
  4. `privateGate` behaves like `refreshRow` for writes:
     - no `failed/`, no `held/`, no build folder, no ledger row, no `.gated`, no `current`, no sidecar, no upstream
       repros;
     - it keeps the receipt, `gate.log` and the other files under `<root>/private/<tag>@<commit>/`.
     - Its pass check: the receipt's `pinApplied` must equal `pinRootOf(current)`, or the outcome is infra-fail.
  5. No download, no `listReleases`, no `publishPending`, no `publishToMaster`, no push, no `gated-builds.published`.
  6. It prints the outcome (`pass`, `gate-fail`, `held`, `infra-fail`) and the receipt folder. Exit 0 only on `pass`.
- **The defaults are unchanged.** Without the flags: root `/work/tools/al-runner-v3`, worktree `GATE_WORKTREE`,
  candidates only from upstream with SHA256SUMS, and the push to master only on the daily path, as today.

## 3. Tests (red-first, each red-checked both ways)
- **D1:** `realDeps()` with no argument has root `ROOT` and `gateWorktree` `GATE_WORKTREE`.
- **D2:** with no flags, the CLI argument reader returns the default mode, and the daily path still calls `publishPending`
  (a fake counts it).
- **D3:** a default candidate still comes from `download`, with SHA256SUMS checked; `privateGate` is off.
- **P1 (pass), P2 (gate-fail), P3 (held), P4 (infra-fail),** on fake deps with a temporary private root and a fake shared
  root:
  - the shared root's tree is byte-identical before and after;
  - the private root holds no `gated-builds.jsonl`, no `current`, no `.gated`, no `failed/` and no `held/`;
  - `download`, `listReleases`, `publishEntries` and `commitOrder` are never called;
  - the receipt is under `<root>/private/`.
- **P5:** the gate runs at `current`'s `lethalCommit`, with `LETHAL_V3_PIN_FROM` = `pinRootOf(current)` and the candidate
  variables set.
- **P6:** a pass whose receipt applied another pin is infra-fail.
- **R1-R4 (refusals):** `--root` alone; `--local-candidate` alone; a root under `/work/tools` (a symlink into it included);
  the flags with `--regate`.
- **W1:** the private path's `runGate` and lock orphan check use `<root>/gate-worktree`, never `GATE_WORKTREE`.

## 4. Gates
- The script's own unit tests and VERIFY, plus CI.
- No v3 gate run is needed for the change itself: the default path's code is untouched beyond the `gateWorktree` default.
- The private gate's first real use is lethal-bugs' gate of perf-combined into `/coord/handoff/PR-217`.
