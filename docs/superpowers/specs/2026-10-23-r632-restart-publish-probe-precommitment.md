# R-632b pre-commitment: can a session see a BC restart or a publish between a crash and its resume? (nothing run)

Source: docs/roadmap/R632.md (and its 2026-10-22 note), coord task R-632b (owner go, 2026-10-23). This is a probe,
not a fix: its results go into R632, docs only. Committed to master by lethal-code before any server call.

## Where and how

- **Server:** `bc1` (192.168.2.157, dev 7049, OData 7048, API 7052), under a coord lease (`kraken coord lease bc1
  code`) taken only while bc1 is free and released at once. Never Cronus28 or Cronus284. **No restart is requested.**
- **The login** is read in-process from the gitignored `fixtures/sandbox-app/lethal.config.bc1.json` (written by
  `bc-linux-setup.ts --write-config-only`), and never printed.
- **The probe script** is `/coord/handoff/R-632b/probe.ts`. It reuses `HarnessVerifier.fetchLease()` (the
  `HarnessInfo` OData action, a POST that reads only) and plain automation-API GETs.

## Reading the code (not a measurement)

`serverGeneration` is the "LC Lease" row's `Server Generation`. It is minted by `EnsureLeaseSeeded` only when that
row does not exist, which happens on install or upgrade of LethAL Control into an empty database. It is also minted
by `ForceResetLease`. No acquire, release or run changes it. The bc servers keep their databases in memory, so a
restart empties them, the setup republishes Control, and a NEW generation is minted.

## Q1: serverGeneration

| Step | Prediction |
|---|---|
| 1a. `HarnessInfo` read twice, about 5 s apart | the same `serverGeneration` both times (a 32-character lowercase hex value) |
| 1b. coord lease released, re-taken, read again | the same value. The coord lease lives only in /coord and touches nothing in BC |
| 1c. A server restart (NOT run now: host-only, for the owner later) | after the setup re-run, a DIFFERENT value. That would confirm that a resume can detect a restart by comparing the generation recorded at the first guard ask |

## Q2: publish history

Throwaway app: `R632 Probe`, an object range from 91500, one empty codeunit, no dependencies, publisher `LethAL R632`.

| Step | Prediction |
|---|---|
| 2a. GET the automation API's `extensions` and `extensionDeploymentStatus` before the publish | `extensions` holds LethAL Control and the fixture apps, with no time field. `extensionDeploymentStatus` lists operations; whether it holds the setup's dev-endpoint publishes is NOT predicted (unknown) |
| 2b. Publish the probe over the dev endpoint (`altool publishapp`), then GET both again | `extensions`: one new installed row. `extensionDeploymentStatus`: unknown, recorded as found |
| 2c. Uninstall the probe through the automation API's `Microsoft.NAV.uninstall` action, then GET both again | `extensions`: the row shows `isInstalled false`. `extensionDeploymentStatus`: unknown, recorded |

**Cleanup.** BC on Linux here has no unpublish path, neither the dev endpoint nor BcContainerHelper. So the
uninstalled probe stays PUBLISHED on bc1 until the next restart, which empties the database. It is in its own id
range, with no dependents, so no gate fixture can see it. It is named here and in R632. If the uninstall action is
refused, the probe stays INSTALLED until the restart, and that is recorded.

## What is recorded

Every field value is recorded by NAME and VALUE, except the login. Times are recorded as returned. A field that
does not exist, or a call that is refused, is recorded by name. Nothing is retried into a result.
