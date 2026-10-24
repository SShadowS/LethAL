# R707 probe: an installed dependent after its target's signature changes

**Status: built and compiled offline only. It has run on NO server yet.**

Two invented AL apps, no tables. Publisher `LethAL Probe`.

| App | Id | Object ids |
|---|---|---|
| R707 Probe Target (A) | `e390149d-8472-4ab1-b1ea-3e10a42156bb` | 93700-93709 |
| R707 Probe Dependent (B) | `76068df3-2038-49cd-b992-51ea13158bda` | 93710-93719 |

B (1.0.0.1) depends on A >= 1.0.0.1. Its codeunit "R707 Dep API" has `Call(): Integer`, which returns
`Target.Answer()`. Its Install codeunit registers it as web service `R707Dep` (Tenant Web Service).

A builds: `A1` (1.0.0.1, `Answer()` returns 1); `A1s` (1.0.0.1, SAME version, `Answer(X)` returns X + 1, no
zero-argument `Answer`); `A2r` (1.0.0.2, `Answer` removed, `Other()` instead); `A3` (1.0.0.3, `Answer()`
returns 3). B is compiled against A1.

## Run

Build once, offline (System symbols from `/coord/cache/bc-symbols/<server>`, no server call):

    bun scripts/r707-probe/drive.ts --build --server bc2

Output goes to `.kraken-local/r707-probe/` (gitignored), with `shas.json`. **Do not rebuild after the
pre-commitment records the hashes**: every alc build gets a fresh header id, so the sha256 changes.

Under a lease on the server, from the worktree root:

    bun scripts/r707-probe/drive.ts --server bc2 --lane <lane> --step 1   # then 2, 3, 4, 5, cleanup
    bun scripts/r707-probe/drive.ts --server bc2 --lane <lane> --all

It refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. The login is read inside the process and
never printed. Each step reads state first and refuses if it is not what the step expects. Each prints one
JSON line of facts. Every call times out at 120 s. Apps are read by id only (R433).

## Steps

1. Publish A1, then B. Read each back.
2. Call `R707Dep_Call` over OData. Expect HTTP 200, value 1. A 404 means the probe is wrong: the step refuses.
3. Publish A1s in place (same version, changed signature) with B installed. Record status and body, read A and
   B back, call B again.
4. Publish A2r (an upgrade that removes `Answer`). Same records.
5. Publish A3 (`Answer` restored). Same records.
- `cleanup`: uninstall and unpublish B, then A. Read back absent. BC keeps its installed-version record
  (1.0.0.3 here) until a restart: say so in the submit note.

## Does `bc-republish.ts` compile a target's installed dependents?

**No.** `republish` calls `publishOrder(apps, all)` and loops over that order to compile. `publishOrder` is
`republishPlan(requested, all).publish.filter((d) => requested.includes(d))`. `republishPlan` does close the
set over dependents (its `added` list), but `publishOrder` throws them away, so only the requested apps are
compiled and published (R599 did this on purpose). A dependent's source is therefore never compiled against
the new target. Only a requested dependent compiles, against the target's fresh build when both are
requested, else against the resident package (`residentPackage`).
