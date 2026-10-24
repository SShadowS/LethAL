# R623 + R605 probe: dev-endpoint publish behaviour

**Status: built and compiled offline only. It has run on NO server yet.**

Two invented AL apps, no tables (so no schema ghosts). Publisher `LethAL Probe`.

| App | Id | Ids used |
|---|---|---|
| R623 Probe Target (A) | `3543fecd-9a43-4256-a10d-8d6df316c223` | 91800-91809 |
| R623 Probe Dependent (B) | `5ea135b0-2061-4c4c-9be0-d3c8a17a9182` | 91810-91819 |

B depends on A >= 1.0.0.1. A has five builds: `tX1` (1.0.0.1, returns 1), `tY1` (1.0.0.1, returns 2:
same version, other content), `t5` (1.0.0.5), `t2` (1.0.0.2), `t6` (1.0.0.6).

## Run

Build once, offline (uses the System symbols already in `/coord/cache/bc-symbols/<server>`, no server call):

    LETHAL_ALC_DIR=<alc dir> bun scripts/r623-probe/drive.ts --build --server bc2

Builds go to `.kraken-local/r623-probe/` (gitignored) with `shas.json`. **Do not rebuild after the
pre-commitment records the hashes**: every alc build gets a fresh header id, so the sha256 changes.

Then, under a lease on the server, from the worktree root:

    bun scripts/r623-probe/drive.ts --server bc2 --lane <lane> --step 1   # then 2, 3, 4, 5, 6, cleanup
    bun scripts/r623-probe/drive.ts --server bc2 --lane <lane> --all

The run refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. The login is read inside the
process and never printed. Every step reads the state back first and refuses if it is not the state the
step expects. Each prints one JSON line of facts. Every call times out at 120 s. Apps are read by id only.

## Steps

R623 (same-version publish of a target under an installed dependent):
1. Publish A `tX1`, then B. Read each back: rows, version, isInstalled, packageId, and which built file the
   resident bytes equal.
2. Publish A `tY1` (same version, other content) in place with B installed. Records HTTP status and body,
   then A and B read back.

R605 (publish below the installed-version record):
3. Publish A `t5` (1.0.0.5, an upgrade) with B installed. Records result and B's state.
4. Uninstall and unpublish B, then A, through the automation API (`Microsoft.NAV.uninstall`, then
   `Microsoft.NAV.unpublish`). Read each back: absent?
5. Publish A `t2` (1.0.0.2). Predicted: 422 "a newer version 1.0.0.5 was already installed". Refuses to run
   unless step 3 was accepted.
6. Publish A `t6` (1.0.0.6), above the record. Read back.

`cleanup`: uninstall and unpublish B, then A, and read back that both are absent. BC keeps its
installed-version record (1.0.0.6, or the highest one published) on the server until a restart. State this
in the submit note.
