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

## 5. Amendment 1 (2026-11-19, before the build): a pass writes a real `.gated` under `<root>` (the orchestrator)
**The gap.** The owner wants PERF-10 to RUN on the privately gated build. `lethal run` accepts an al-runner build only
when a `.gated` beside the binary names its sha256 and version (`checkGated` in `al-runner-v3-pin.ts`). With no `.gated`,
it accepts only a release the shipped manifest lists. Receipts alone would leave PERF-10 refused, as before.

**The change to §2 step 4:**
- **On a `pass`,** the private gate copies the candidate into `<root>/builds/<tag>/al-runner` and writes the gate's own
  `.gated` beside it.
  - It is the same record a normal pass builds: version, binarySha256, the commit it was gated at, `readingsFrom` =
    the pin it was judged by, the warn and batch facts, and `gatedAt`. It is written by the gate code, never by hand.
  - It names the private copy's own sha256 (equal to the candidate's).
- **Nowhere else.** Never under `/work/tools`, never `current`, never the ledger or the manifest, never a push.
- **A `gate-fail`, `held` or `infra-fail` writes no `.gated`** and no build folder: receipts only, under
  `<root>/private/`.

**Tests added to §3:**
- **G1:** a pass writes `<root>/builds/<tag>/.gated` and the binary copy there, and nothing outside `<root>`.
- **G2:** a gate-fail, a held and an infra-fail each write no `.gated` anywhere.
- **G3:** `checkGated` accepts the private copy on that `.gated` (sha256 and version match). It still refuses the same
  binary with no `.gated` beside it, and refuses a `.gated` whose sha256 differs.
- Each is red-checked both ways.

## 6. Amendment 2 (2026-11-19, before the build): the Opus spec-adversary review, and the orchestrator's PERF-10 ruling
The review (`/coord/handoff/PR-226/spec-review.md`) found two BLOCKs and six should-fixes in §2. Each is fixed here. Where
this section and §2 or §5 differ, this section decides.

**BLOCK 1: the al-runner cache.** The gate's itest defaults `LETHAL_ALRUNNER_V3_CACHE` to
`/work/tools/al-runtime-rs/cache` (measured: 162 `compile/` entries written there on 2026-11-19), so a private gate would
write under /work/tools.
- The private gate sets `LETHAL_ALRUNNER_V3_CACHE=<root>/cache` in the gate's env.
- Before the first gate, it seeds that folder by copying the shared cache (`cp -a`, read-only on the source), so the gate
  runs on the artifacts the pre-commitment measured.
- **P5 asserts the cache variable is under `<root>`.** P1-P4 assert the fake gate was given it.

**BLOCK 2: the CLI.** Today the CLI is a chain of `process.argv.includes(...)` ending in `dailyOnce`, which pushes. So
`--root=x` (an unknown spelling) or a mode flag after the new ones would reach the edge or daily path.
- One strict argument reader (`parseUpdateArgs`) runs BEFORE every branch and is the only dispatcher.
- It refuses by name:
  - any argument it does not know, including `--root=` and `--local-candidate=` forms;
  - a flag value that starts with `-`, or a missing value;
  - `--root` or `--local-candidate` alone;
  - either of them with any mode flag (`--regate`, `--edge`, `--edge-rejudge`, `--refresh-rows`, `--pin-digests`).
- With no argument it returns the default (daily) mode, and each existing mode parses as today.
- **Tests:** `--root=x`, `--root x --local-candidate y --edge`, `--root --local-candidate y`, and an unknown flag are each
  refused, and NO daily, edge or other mode runs (fakes count the entries). Each existing mode still parses to its
  mode.

**The private run, as built:**
1. **Environment.** It refuses by name when its own environment sets any `LETHAL_ITEST_V3_*` (except `_CDO`), any
   `LETHAL_ALRUNNER_V3_*`, or `LETHAL_V3_PIN_FROM`. The lane's shell must not choose the gate's legs, pin or cache.
2. **Load.** It runs only under `scripts/heavy-slot.sh --peak gate` (the instructions say so). It calls
   `skippedForTheDay`, so the memory and heavy-job checks see it as they see the daily gate.
3. **Lock and log.** It takes `<root>/.gate.lock`, uses `<root>/gate-worktree` (the lock's orphan check and its message
   name that worktree), and logs to `<root>/private/update.log`, never the daily logs.
4. **Reading `current`.** `readCurrentGated` takes the SHARED root (`/work/tools/al-runner-v3`, a parameter, read-only),
   never `deps.root`.
   - The missing legs are computed read-only, as `gatedWithAllLegs` does. When legs are missing, the candidate is judged
     at this script's own commit (`{...current, lethalCommit: self}`), under the same conditions as the edge path's
     fallback. When `self` cannot serve, it is refused by name.
   - The re-gate of `current` is never called.
5. **One folder per run:** `<root>/private/<tag>@<commit>-<nonce>/`, so an old pass receipt can never sit beside a new
   result.
   - The tag is `local-<sha256[:12]>` of the candidate's bytes, so two builds of one commit never share it.
6. **The pass check** compares the receipt's `pinApplied` with `pinRootOf(gated)` for both the private and the refresh
   path. For refresh this is the same value, because its `gated` always carries `readingsFrom`. Tests P1 and P6 use a
   `current` with NO `readingsFrom`.
7. **On a pass** (amendment 1): copy the candidate to `<root>/builds/<tag>/al-runner` (mode 755), check the copy's sha256
   against the receipt's, and write the gate's own `.gated` beside it. On any other outcome: no `.gated`, no build folder.

**Which file PERF-10 points LethAL at** (the orchestrator's ruling, option (a)):
- **`<root>/builds/<tag>/al-runner`, the gated copy of the real binary.** It is the only file a private pass admits.
  `checkGated` hashes the exact path LethAL runs, so a wrapper is never the gated build.
- **The P-core pinning needs no wrapper:** run the whole `lethal run` under `taskset -c 0-11`, and every child daemon
  inherits it.
- **perf counts** come from outside (for example a watcher that attaches `perf stat` to new `al-runner serve` pids).
- **Full daemon stderr beyond LethAL's 64 KB** is not available without a LethAL change.
- **Option (c)**, `alRunnerV3.launcher` (a command prefix, with `path` still the hashed real binary), is filed as its own
  roadmap item, not built here.
- **Option (b)**, gating a wrapper script, is refused. A record that hashes a script and trusts it for a binary it does
  not hash is the weakness the owner refused.

**Nits:**
- R3 also tests `/work/toolsx` as ACCEPTED, so a plain `startsWith("/work/tools")` is caught.
- The instructions say to remove `<root>/gate-worktree` with `git worktree remove` before cleaning the handoff folder.
- K runs because the candidate path keeps `candidate: true` (`regateAt` undefined); a test asserts the receipt is read
  as a candidate.
