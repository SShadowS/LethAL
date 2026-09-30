# R-372 probe: what the dev /packages download carries per resourceExposurePolicy

**Prediction, written before the run (2026-09-30):** A carries full source; one of B, C or D does not.

**Result: the prediction was WRONG.** All four cases carry the full test source.

- Date: 2026-09-30. Container: Cronus28, BC 28.4.53241.53758-DK, instance BC, tenant default.
- Compiler and publisher: AL extension `ms-dynamics-smb.al-18.0.2732683`, alc 18.0.41.45789, its bundled `altool publishapp` (dev endpoint, UserPassword, ForceSync).
- Scratch app: "LethAL R372 Probe" by LethAL, id `5d0c3b7e-8a51-4f7e-9c2b-372a0f0e7a11`, ids 79900..79909, runtime 13.0, no dependencies. One test codeunit, two `[Test]` procedures.
- Download: `devPackagesUrl` imported from `packages/runner/src/bcdev-backend.ts`, the same URL R139 check 2 reads, with Basic auth. Entries listed with `listPackageEntries`, read with `readPackageEntry`. Equality normalizes CRLF (and a leading BOM) only.
- Re-run: `bun scripts/r372-package-source-probe/run.ts` from the repo root. Raw output: `output.txt`.

| case | allowDownloadingSource | includeSourceInSymbolFile | version | HTTP | bytes | `.al` entries (downloaded) | equal to disk source? | `.al` entries (local .app) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | true | true | 1.0.0.1 | 200 | 2690 | 1 (`src/src/R372Probe.Codeunit.al`) | yes | 1, equal |
| B | true | false | 1.0.0.2 | 200 | 2693 | 1 | yes | 1, equal |
| C | false | true | 1.0.0.3 | 200 | 2695 | 1 | yes | 1, equal |
| D | (no `resourceExposurePolicy` key) | | 1.0.0.4 | 200 | 2635 | 1 | yes | 1, equal |

In every case the downloaded package had the same byte size and the same seven entries as the
locally compiled `.app`. For 1.0.0.5 the bytes were compared directly: the download is
BYTE-IDENTICAL to the `.app` that was published (same SHA-256). So on this server the dev
`/packages` read returns the uploaded package as it was, not a symbol file rebuilt under the
policy, and `alc` 18.0 puts the source in the `.app` whatever the flags say. The flags did not
change what this read sees.

## Unpublished-edit check (used CASE A flags: allowDownloadingSource true, includeSourceInSymbolFile true)

Published 1.0.0.5 with `ProbeAlpha` body `X := 1;`, then changed the disk source to `X := 2;`
without republishing, and downloaded again.

| downloaded entry vs | result |
| --- | --- |
| original body (`X := 1`) | EQUAL |
| edited disk body (`X := 2`) | DIFFERENT |

The downloaded source holds the OLD body, as expected. The disk source was restored afterwards.

## Cleanup

`UnPublish-BcContainerApp -containerName Cronus28 -name 'LethAL R372 Probe' -publisher LethAL
-unInstall` (docker context desktop-windows, which was also the context before). Only 1.0.0.5 was
resident (each dev publish replaced the previous version). `Get-BcContainerAppInfo` afterwards
returns no app with that name.

## Caveat

This measured one server build and one compiler. Whether the flags would matter for a package
compiled by an older `alc`, or for a SaaS environment's dev endpoint, was not measured.
