# PR-128 pre-commitment (R1110): warn before publish when a dependency needs SQL Server Full-Text Search

Coord PR-128 (lethal-code, 2026-11-17). Found by PR-67: on `bc4`, Continia Customer Onboarding 30.0.0.0 was refused with HTTP 422
("Text optimized index cannot be created/queried because the SQL Server Full-Text Search component is not installed").

## What LethAL can see (measured, `/coord/handoff/PR-128/scan-app.ts`)
- **The package says it:** the field property `OptimizeForTextSearch` appears in the package's `SymbolReference.json`, so no
  source is needed. Customer Onboarding declares it on 3 fields:
  - `CTS-KYC Alternate Company Name`: `Name`;
  - `CTS-KYC Onboarding Company`: `Name` and `VAT Registration No.`.
- **The rest:** Continia Core and Connector App declare none, and those installed on bc4. DO's and DC's own sources declare none.
- **The server side cannot be read.** No call LethAL makes (the dev endpoint's publish and metadata, OData, the API's
  installed-apps read by id) reports whether the server's SQL has the Full-Text Search component. Only a publish shows it, which is
  not read-only. So the check is package-side, plus the installed state LethAL can already read.
- **Directness:** the needing app is usually NOT a direct dependency. On DO it comes in through Continia's own dependencies, so
  `server-dependencies` (R1087: direct only) cannot see it.

## The change
1. **Reading a package:** a pure helper reads a package's `SymbolReference.json` (through the existing package reader) and returns
   each table field with the property `OptimizeForTextSearch`, as app, table and field.
2. **A new doctor check `text-search-dependencies`** (only with `--project`, like `dependencies`):
   - it scans EVERY package in `packageCachePath` (not only the direct dependencies), and lists those that declare a
     text-optimized field;
   - for each such app it reads the installed versions on the server by id (`fetchInstalledVersions`, never a list of
     everything; R433), with doctor's existing server access.
   - **ok:** none found, or each one found is already installed on the server. Since its tables exist, the server's SQL supports
     it. The detail names them.
   - **failed:** one or more found are NOT installed. The detail names the app, the tables and fields, and says: "installing it
     needs SQL Server Full-Text Search on the server's SQL Server; LethAL cannot read whether it is there; without it the publish
     fails with HTTP 422 'Text optimized index cannot be created'".
   - **skipped:** no `--project`, no cache, or no server read.
   - A package that cannot be read is named, as `dependencies` does.
3. **`scripts/bc-continia-publish.ts --predict`** prints the same note for each app it would publish that declares a
   text-optimized field.

## Predictions (pre-committed)
1. **Unit tests, each red when its rule is reverted:**
   - the helper finds the property in a synthetic `SymbolReference.json`, and finds nothing in one without it;
   - the check scans non-direct packages too;
   - a found app that is installed passes; one not installed fails, naming its app, table and field and "Full-Text Search";
   - the check is skipped without `--project`;
   - the predict note names the app.
2. **Live, read-only, under a bc4 lease** (no publish): `lethal doctor --project <DO checkout copy> --config <PR-67's bc4 config>`
   with the Continia 30 packages in the cache:
   - `text-search-dependencies` FAILS, naming Continia Customer Onboarding and its 3 fields;
   - Core and Connector App are not named (installed, and no such fields).
3. **`itest:alrunner-v3`** is not touched (doctor only). Verify and CI.
