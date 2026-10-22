# R629 co-install probe

Question (R-629 step 1): does BC refuse two DIFFERENT apps (different app ids, neither depending on the
other) that declare the same object, as a nested module copy and its parent would?

Apps (publisher "LethAL Probe", codeunits only, ids 91500-91599, no tables):

| dir | app id | object |
|---|---|---|
| `a` | e00f085f-3882-4b67-9656-48d8b78fb760 | codeunit 91510 "R629 Probe" |
| `b1-same-id-same-name` | 463d4f86-5563-4038-8fc2-a3e386f4ccff | codeunit 91510 "R629 Probe" |
| `b2-same-name-other-id` | 746d68f0-65f7-4401-af1c-51b65bcb206a | codeunit 91511 "R629 Probe" |
| `b3-same-id-other-name` | 6eb8bc54-5bf7-471e-a94a-60fd55774516 | codeunit 91510 "R629 Probe Other" |

Each case publishes A, then one B, over the dev endpoint (which publishes and installs in one call),
records BC's answer, then removes B and A (uninstall, then the bound `Microsoft.NAV.unpublish` action)
and reads each id back.

**Status: MEASURED** on bc1, BC 28.4.53241.56590, 2026-10-22 (cases 1 and 2 at 07:11Z, case 3 alone at
07:13Z). An earlier attempt that day was refused the bc1 lease, before any server call.

| case | B | B's publish |
|---|---|---|
| 1 | same id, same name | REFUSED, HTTP 422: `The application object of type 'CodeUnit' with the ID '91510' is defined in multiple apps. ... The original extensions have been restored.` |
| 2 | same name, other id | ACCEPTED: both apps installed |
| 3 | same id, other name | REFUSED, HTTP 422, the same message |

The object ID alone blocks co-install; a shared name does not. After each case both apps were removed, and every
id was read back absent. Write-up: `docs/measurements/README.md` (section "R629") and
`/coord/handoff/R-629/probe/result.md`.

## Re-run
1. `bun scripts/bc-linux-setup.ts --server bc1 --write-config-only` (no server call).
2. Compile each dir offline, with no lease held:
   `"$LETHAL_ALC_DIR/alc" /project:scripts/r629-probe/<dir> /packagecachepath:/coord/cache/bc-symbols/bc1/<build dir> /out:/coord/handoff/R-629/probe/build/<dir>.app`
3. `bun /coord/handoff/R-629/probe/drive.ts` from the repo root. `R629_CASES=3` runs only the listed cases.
   It takes the bc1 lease, heartbeats, runs the cases, cleans up and releases. The log is
   `/coord/handoff/R-629/probe/drive.log`. The driver lives in /coord, outside the repo, because it imports
   the setup scripts by absolute path.
