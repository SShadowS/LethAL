# R-624 plan r2: one strict reader for the dev endpoint's resident package

r2 applies the Opus plan review (`review-plan-opus.md`, ADOPT with fixes): I1 (drop itest:bcdev), I2 (read-only
live runs that reach every changed reader), I3 (measure BC's answer for an absent app FIRST), I4 (the Continia test
on the reader itself), I5 (one fetch helper for every dev-endpoint call in `bc-app-content.ts`), M1-M6.

Task R-624 (lane bugs, run 001). Roadmap item `docs/roadmap/R624.md`. Base: master d5a8288a. Branch `lethal/r624`,
worktree `/work/lethal-wt/r624`.

## The defect

`residentPackage` in `scripts/bc-linux-setup.ts` returns `null` ("the server holds none") for every non-2xx answer
except 401/403. R599 added a strict twin, `strictResidentPackage` in `scripts/bc-app-content.ts` (only 404 is
absent, via `packageStatus`), and moved the fixture decisions onto it. These callers still use the lenient one:

| Caller | What a 5xx does today |
|---|---|
| `downloadSymbols` (setup's and `bc-republish.ts`'s compiles, `alpackages` mode) | throws "holds no Microsoft X" (misnamed cause) |
| the default `downloadSymbol` in setup's real deps (the shared cache fill) | same, misnamed |
| `residentVersion` -> `realContiniaOps` -> `decideContinia` | **reads absent, so the Continia app is PUBLISHED** |
| `bc-republish.ts` compile: a LethAL dependency outside the named apps | throws "neither built nor on" (misnamed) |
| `bc-republish.ts` `alpackages`: non-Microsoft dependency | throws "holds no" (misnamed) |
| `ensureApp` (only `scripts/r594/cdo-publish.ts`) and cdo-publish's own four reads | reads absent, so it **publishes** |

## The fix (root cause, one place)

1. ONE reader. Keep the name `residentPackage` (every importer keeps its line) and define it once, in
   `bc-app-content.ts`, with the strict rule: 2xx -> the bytes; 404 -> `null`; 401/403 -> the existing
   server-named login error; anything else -> throws, naming the server, publisher/name and the HTTP status.
   `bc-linux-setup.ts` re-exports it (as it already re-exports the moved names). `strictResidentPackage` is
   deleted, and its three call sites (`bc-app-content.ts`'s fixture reads, `bc-republish.ts`'s before/after
   read-back) call `residentPackage`. `packageStatus` stays (control's rule, tested) and the reader uses it after
   the 401/403 branch.
2. A test seam. `Conn` gains an optional `fetch?: FetchFn`, and ONE helper (`c.fetch ?? bcFetch`) is used by every
   dev-endpoint call in `bc-app-content.ts` (the reader, `publishBytes`, `apiJson`), so a fake Conn can never send a
   real request (I5). Production never sets it: all three production Conns are written out with only `server` and
   `authorization`. (`bcFetch` captures the global `fetch` at module load, so patching `globalThis.fetch` would not
   reach it.)
3. The 401/403 message becomes the server-named one for the fixture and control reads too (M3): intended, no test
   or doc pins the old text.
4. Comments brought up to date in the same diff (M4): `bc-app-content.ts`'s header, `ServerOps.resident`,
   `ContiniaOps.residentVersion`, `ensureApp`'s doc, R624.md's "To close" line.
5. Out of scope, stated in the submit note (M6): `fetchPublishedAppPackage` in `packages/runner/src/bcdev-backend.ts`
   is lenient on purpose and documented so.

## Step 0, before any code: measure BC's answer for an absent app (I3)

Setup now depends on "absent = 404" (fresh server: every fixture absent; Continia on a server without it), and no
log records it: R594's "all absent" went through the lenient reader. Under a bc3 lease, with a small script in
`scripts/` that reads the login inside itself and prints only the status: one `dev/packages` read for
publisher `LethAL`, name `R624 No Such App` (cannot exist), and one for publisher `Microsoft`, name
`R624 No Such App`. Expected: **404 for both**. Anything else is a BLOCK: report it, and the rule is the owner's.
Log: `/coord/handoff/R-624/live/0-absent-status.log`.

No behaviour changes on a healthy server: a 2xx and a 404 read exactly as before.

## Tests (`scripts/bc-app-content.test.ts`, `bc-linux-setup.test.ts`)

Each with a fake `Conn.fetch`, and each red-checked by restoring the lenient line (`if (!res.ok) return null;`) in
the one reader, single revert, log in `/coord/handoff/R-624/red-unit/`:
- the reader: 200 -> bytes, 404 -> null, 401 and 403 -> the login error, 500 / 502 / 503 -> throws naming the status.
- `downloadSymbols`: a 500 for System throws an error containing `HTTP 500` and NOT `holds no` (M2: the lenient
  code also throws, so only the message separates them).
- Continia (I4): `realContiniaOps(c500).residentVersion(...)` rejects naming HTTP 500; `realContiniaOps(c404)`
  resolves `null`. Plus the end-to-end unsafe direction: a fake serving the pinned Microsoft packages with 2xx and
  answering 500 for ONE Continia app; `decideContinia` must throw, where the lenient revert puts that app in
  `toPublish` (asserted red).
- the shared cache's real `downloadSymbol`: a 500 stops the fill with an error containing `HTTP 500` and not
  `holds no`, and no cache directory is sealed.
- one 401 through `realOps` gives the server-named login error (M3).
- routing (M1): among the setup scripts, `devPackagesUrl(` is called only in `bc-app-content.ts` (the r372 probe
  excluded), so a second reader cannot come back unnoticed.

`bc-republish.ts`'s two in-`main` dependency reads have no injectable driver; they are covered by the routing test
(they call the one reader). Stated, not hidden.

## Checks

typecheck, `bun scripts/verify.ts`, biome on touched files, the three `bun build --target=bun` link checks,
roadmap-index + line-citations, both CI jobs.

## Live (after CI green, on the final head; leases as always)

All read-only, on bc3, each tool under its own lane-bugs lease. A short pre-commitment (committed to master before
the runs) fixes the expected lines, compared line by line. Its rule: **every decision and every read value is
unchanged** from the same command on master d5a8288a, run first as the control under the same lease conditions.
1. setup `--predict` (every fixture and control read).
2. setup `--predict --with-continia --accept-build <bc3's R594 build, from servers.md>`: reaches `residentVersion`
   through `decideContinia`, the reader that acts on a wrong answer (I2).
3. `bc-republish.ts republish --predict` on a fixture with a non-Microsoft dependency (reaches its in-`main`
   dependency read), and its `alpackages` mode into a scratch directory if that writes nothing in the repo.
4. `cdo-publish.ts --check-only`, only if it is confirmed read-only by reading its code first; otherwise not run, and
   said so.

**No itest (I1):** nothing under `packages/` imports these scripts, so no gate runs the changed code; the read-only
runs above are the live proof. Not run: any Continia or cdo publish (bc3's Continia stack is the R594 oracle).

## Roadmap

R624 `done (<commit>)` in the branch. Nothing else expected.
