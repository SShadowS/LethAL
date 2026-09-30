# R-372: record the digest of the test body the server RUNS, not the one on disk (short plan)

**Problem.** R-278 digests each test from the source on disk. On bcdev the server runs the
PUBLISHED test app, which may be older. So an edited test that was not republished runs its old
body, but the run records the new body's digest. A later `lethal verify` then reads the edit as
already measured, which is the unsafe direction.

## 1. Measure first: does the package R139 check 2 downloads carry the test source?

`reportPublishedTestApp` (orchestrator.ts) downloads the test app through
`BcDevMcpBackend.fetchPublishedAppPackage`, which calls the dev endpoint's `/packages` (the SYMBOL
package). `parsePublishedApp` already reads every `.al` entry in it. Whether that package carries any
source depends on the test app's `resourceExposurePolicy`, and I will measure that rather than
assume it.

**Measurement (one Cronus28 lease; I tell the orchestrator before taking it).** Use a scratch copy
of `fixtures/sandbox-tests` under a scratch name, id range and version, so the committed tests app
on the container is never touched. Build and publish it four times through the dev endpoint, then
fetch it with the same `devPackagesUrl` read, and record which `.al` entries come back and whether
their text is byte-equal to the source:

| case | allowDownloadingSource | includeSourceInSymbolFile |
| --- | --- | --- |
| A | true | true (every committed fixture) |
| B | true | false |
| C | false | true |
| D | no `resourceExposurePolicy` at all (BC's defaults) |

The same script checks one more thing, the reason this item exists: publish version 1, edit one
test's body on disk without republishing, and confirm the downloaded source still holds the OLD
body. When the run ends, unpublish the scratch app. The script and its output are committed under
`scripts/r372-package-source-probe/` and cited on the roadmap item. The prediction, written down
before the run: A carries full source; one of B, C or D does not.

## 2. Choice: (a) digest the published source, with NULL plus a warning when the source is absent

- **Package carries source:** R-278's digest runs over the published package's `.al` entries,
  through the same `testDigestsOfSources` with the same `tests` list. That is exactly the body the
  server runs, so an unpublished edit is recorded as the OLD digest, and verify, which republishes
  from disk, sees a different digest and treats the test as new. This is safe, and it keeps verify
  usable on that run.
  - A test discovered on disk but absent from the published source makes `testDigestsOfSources`
    throw `TestDigestError`. The run records NULL and warns `test-digests-unavailable`, next to
    check 2's existing `published-test-app-mismatch` warning (R-278's rule: every test or none).
- **Package read but carrying no source (found by the measurement):** record NULL and warn
  `test-digests-unavailable`, naming the cause (the published test app exposes no source; set
  `includeSourceInSymbolFile`, or whichever flag the measurement shows is needed). Verify then
  refuses that run by name. We never record a digest for a body we did not see the server hold.
- **Package read failed** (`null`, or `parsePublishedApp` threw): record NULL plus the warning.
  Check 2 already warns `published-test-app-unreadable`.
- **Why not (b)**, refusing or recording NULL when the published and on-disk digests differ: it
  throws away the run's verify use in exactly the case where (a) records the right answer, and it
  would need two digest passes instead of one.
- Check 2's name and version warning is unchanged. It still reports and never refuses; only the
  digest source moves.

## 3. al-runner and env-tool

- **al-runner:** `fetchPublishedAppPackage` is absent, nothing is published, and the source on disk
  is what runs. R-278's on-disk digest stays; no change.
- **env-tool (bcdev with no dev server named, `fetchPublishedAppPackage` returns `undefined`):**
  this path publishes the test app itself. The build confirms, by reading the env-tool publish
  path, that the app it publishes is compiled from the test source on disk during this run. If it
  is, the on-disk digest is right and stays. If it can publish a prebuilt `.app`, record NULL plus
  the warning, and file an item; do not build more here.

## 4. RAM

The package is already downloaded once. `reportPublishedTestApp` will hand back the package's `.al`
entry texts (path and text) with the hash it already returns. `runSession` digests them right away
and lets them go; the bytes are not kept past that function. No second download, and the on-disk
sources are still read once (the TestPage scan needs them). On bcdev, two copies of the sources
exist only for the length of one digest call.

## Tests (red-checked)

- **runSession on a fake bcdev backend** whose published package holds test `K` at an OLD body while
  disk holds a NEW body: the recorded digest equals the old body's. Then verify's `planVerify`
  against the disk puts `K` in `newTests`.
  - Red-check: digesting the disk source again makes both go red.
- **Package with no `.al` entries:** the run completes, the column is NULL, and it warns
  `test-digests-unavailable` with the no-source cause.
  - Red-check: falling back to the disk digests goes red.
- **Package missing a discovered test:** NULL plus the warning.
- **Unreadable package:** NULL plus the warning.
- **al-runner:** unchanged, still records the disk digests (an existing test, re-asserted).

**Live leg:** the probe in section 1 is the live evidence about the package. The code path is unit
tested against a fake that serves the measured package shapes. `itest:agreement` is re-run at the
end, because its source run is bcdev and its digests now come from the published package; I tell
the orchestrator before leasing.

## Tasks

1. The probe script, run once live, with the results written into this plan.
2. `reportPublishedTestApp` returns the package's source entries; `runSession` digests the
   published source on bcdev, and records NULL plus a named warning when it cannot. Tests and
   red-checks.
3. The env-tool confirmation (section 3).
4. `itest:agreement` live. Close R372; update the CHANGELOG entry and the agent guide line if R-278
   wrote "on disk".
