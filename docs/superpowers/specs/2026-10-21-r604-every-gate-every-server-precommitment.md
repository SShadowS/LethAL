# R-604 pre-commitment: every BC gate proven on every bc server (2026-10-21, lethal-preproc)

Written BEFORE any republish or proof run. The rule (orchestrator, 2026-10-21; `docs/gates/servers.md` §"Proof that
the gates reproduce here"): a gate runs on a server only after its frozen figures reproduced per mutant on THAT
server, under the current fixtures. Master c03d5356; control app per the setup script's pinned build.

## Step 1: republish bc3's four stale apps (R599)
`Sandbox App`, `Sandbox Hang`, `Sandbox Names` and `Sandbox Names Tests` on bc3 are republished from the current
fixture builds through the automation API:
1. uninstall;
2. the bound `Microsoft.NAV.unpublish` action on the extension (measured by R-389 on bc3);
3. publish over the dev endpoint, test apps after their targets.

This is done under a coord lease on bc3 by a committed `scripts/` tool. **Predicted:** afterwards each of the four is
resident at its `app.json` version, and the tool's read-back shows the published package's content hash equals the
local build's. A failure in any step stops R-604 for bc3, reported as it is; it is never worked around.

## Step 2: the missing gate-server pairs
Taken from `servers.md`'s proof table at c03d5356:

| Server | Gates to prove |
|---|---|
| bc1 | `itest:chunked`, `itest:hang`, `itest:harden`, `itest:agreement` |
| bc2 | `itest:bcdev`, `itest:bcdev-wrapped`, `itest:bcdev-names`, `itest:tables`, `itest:verify`, `itest:verify-scale`, `itest:stale-publish`, `itest:testapp`, `itest:lease` |
| bc3 | every gate above except `itest:hang`, which is already proven there |

`itest:envtool` (host-only) and the al-runner gates (no BC server) are out of scope.

**How they run.**
- One gate per server at a time, under that server's coord lease. At most one gate per server; the three servers
  run in parallel. Back off when `free -g` shows under 10 GB available.
- Each gate is selected with `LETHAL_ITEST_CONFIG=lethal.config.<server>.json`, and its `[itest target]` first
  line must name that server.
- Each gate compares with its committed baseline. NO baseline is re-recorded.

**Predicted for every pair:**
- the gate PASSES with every frozen figure unchanged;
- per-mutant verdicts are equal to the committed baseline (and to the pre-committed tables where the gate has
  them);
- `itest:tables` has exactly its one named expected baseline failure.

**Failure rules.**
- A verdict difference, a figure difference or any other failure is a BLOCK for THAT pair, reported as it is with
  its log. That pair stays out of the proof table.
- It is not re-run on another server to make the table look full.
- **bc3** carries the Continia stack (and the R594 CDO oracle for `itest:bcdev`). If a bc3 result differs only
  because of that stack, it is reported as a server difference, not a pass.

## Step 3
`docs/gates/servers.md`'s proof table is updated with exactly the pairs that passed, each citing its log in
`/coord/handoff/R-604/`. The runbook's "Proof is PER SERVER" bullet is updated to match (in the same branch, or
handed to the orchestrator if it owns that file).
