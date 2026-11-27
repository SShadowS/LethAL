# PR-476 (R1234): a recompile-stable test-app identity — design and pre-commitment r1

lethal-code, 2026-11-27. Written before any code.

## Why (PR-475's measurement)

- Three alc builds of UNCHANGED `fixtures/sandbox-tests` give three `hashPackage` values. So R247/R495, which
  compare the served test app's `package:<hashPackage>`, refuse any resume after a setup that recompiles (PR-468's
  live leg hit this).
- **What moves:**
  - the NAVX header id (bytes 12-27, already zeroed);
  - `NavxManifest.xml`'s `<Build … Timestamp="…">` VALUE;
  - the zip's entry times and deflate bytes.
- Every entry's other content is byte-identical.
- PR-457's content walk (`packageEntries`) with ONLY that value blanked gives equal digests on all 3 builds.

## The new identity: `appContentIdentity(buf)` (the "c2" form)

- **The header:** `H sha256(header bytes 0..12 ‖ 16 zero bytes ‖ header bytes 28..headerEnd)`, when the bytes carry
  `hashPackage`'s known NAVX shape. Any other shape falls back to `hashPackage` (unchanged), and so does a signed
  package; the fallback is named in the form, see below.
- **Every entry, sorted by name bytes:** `E <name>\t<uncompressedSize>\t<sha256(data)>`, using PR-457's
  `packageEntries`. That walker's refusals (duplicate name, encryption, unknown method, size mismatch) THROW, never a
  partial digest.
- **The one exception:** in the entry named exactly `NavxManifest.xml`, the value of the `Timestamp` attribute of the
  `<Build>` element is replaced by the empty string BEFORE its sha.
  - The match is exact: one `<Build` element, one `Timestamp="…"` attribute. Zero or several matches means NO
    blanking, so the digest moves and the check fails closed.
  - Every other byte of the manifest (app id, name, publisher, version, dependencies, `CompilerVersion`, runtime,
    targets, every other attribute) is hashed.
- **The form string:** `package:c2:<sha256 of the lines joined by \n>`.
  - The old form `package:<64 hex>` and the new one cannot collide, so a stored value always names its scheme.
  - The fallback (an unknown shape) stays `package:<hashPackage>`, the old form, so an unknown shape behaves exactly
    as today.

## Every place LethAL fingerprints an .app, and what changes

| # | site | what it identifies | change |
|---|---|---|---|
| 1 | `testAppHashFor` (baseline-snapshot.ts) | the served test app: the R247/R495 identity, `runs.test_app_hash`, the baseline-snapshot key (R192) | **c2** |
| 2 | orchestrator.ts test-app read (`testAppHash = package:${hashPackage(bytes)}`) | the same identity on the read path | **c2** (the same function as #1) |
| 3 | test-app-publish.ts `packageHash` (compiled) and the read-back compare | the test app LethAL publishes, and the key a session compares | **c2** for the key, so #1-#3 agree; the read-back compare uses the same function on both sides |
| 4 | baseline-snapshot.ts `listOtherFiles` / `otherFilesDrift` (R608) | non-.al files in a tree (for example `.alpackages` symbol `.app`s) whose drift stops a snapshot reuse | **c2 for files that parse as a NAVX package**, raw `hashPackage` for others; a recompiled but unchanged symbol package no longer counts as drift |
| 5 | orchestrator.ts R498 source-less compare (`served` vs `published` `hashPackage`) | that a SOURCE-LESS served package IS the publishApps file | **unchanged**: the same build is compared, nothing is recompiled in between, and R932 rejected content hashing for source-less packages |
| 6 | digest-inputs.ts `X <dep> sha256(bytes)` (R496 partner dependencies) | partner apps served by BC | **unchanged**: measured byte-equal across restarts (21 of 22; System is PR-457's content line); never recompiled by LethAL's setup |
| 7 | digest-inputs.ts `P content c1:` (PR-457) | System | **unchanged** |
| 8 | artifact.ts content-addressed output and `artifact_sha256` | LethAL's own instrumented target, per run | **unchanged**: not compared across runs as an identity |
| 9 | named-mutants.ts `appSha` and the al-runner-v3 built-app sha | a recorded file's integrity; a cache key | **unchanged** |

- The builder re-greps for any site this table misses: `hashPackage(`, `sha256(` over `.app` bytes, `test_app_hash`,
  `testAppHash`, `packageHash`. Any new site is added here, with its decision, BEFORE code.

## Old-form values in existing stores

- `runs.test_app_hash` and the snapshot keys recorded before this change hold `package:<hex>`.
- After it, the same server's test app identifies as `package:c2:<hex>`. They never compare equal.
  - So the first `--resume` across this change REFUSES by name (R247/R495, fail-closed). The message adds: "the
    prior run's test-app identity is the pre-R1234 form; re-run fresh".
  - Snapshot reuse misses once (a cost, never a wrong verdict).
- No migration: an old-form value cannot be recomputed without the old bytes.
- Old-form values are never silently treated as equal.

## Pre-committed tests (red both ways)

1. **Recompile-stable:** the three builds of PR-475 (or, in the repo, a fixture pair built from one invented package
   with ONLY the Build Timestamp value, the header id, the zip entry times and the deflate level different) → equal
   c2.
2. **Each of these changes c2**, one test each:
   - (a) one character of AL source in an `.al` entry;
   - (b) `SymbolReference.json` content;
   - (c) an added, removed or renamed entry;
   - (d) a different uncompressed size;
   - (e) EACH other manifest attribute: app version, id, name, publisher, a dependency's version, `CompilerVersion`,
     runtime, and a second attribute of `<Build>`;
   - (f) a `Timestamp` attribute on an element other than `<Build>`;
   - (g) two `<Build>` elements, or none (no blanking → it differs from the blanked one).
3. **Red checks:**
   - blanking every attribute instead of only `Timestamp` → (e) goes red;
   - not blanking → test 1 goes red;
   - the header id not zeroed → test 1 goes red.
4. **Sites #1-#4 use c2; sites #5-#9 are byte-for-byte unchanged:** a call-site test per row, or a source guard.
5. **Old form:** a store whose prior run has `package:<hex>` → the resume refuses with the R1234 sentence; snapshot
   reuse finds no hit.
6. **The fallback:** non-NAVX or signed bytes → `package:<hashPackage>`, as today.

## The offline pre-commitment on PR-475's real builds

- `appContentIdentity` of `/coord/handoff/PR-475/apps/tests-{1,2,3}.app` → **one value** (PR-475's C2 was c9338160…;
  the build's form adds the size and name lines exactly as PR-457 does, so the value may differ, but all three must
  be EQUAL).
- `hashPackage` of the same three stays three values (the old form is unchanged).

## Gates and the live leg

- **Gates:** `legs.ts` for the touched files (bcdev and lease at least), plus CI.
- **Gate baselines:** no committed itest baseline or test pins a literal `package:<hex>` (grep, 2026-11-27). The
  gates compute the hash at runtime, so no figure should move. A moved figure is a BLOCK.
- **PR-468's positive live leg** then becomes possible through setup's recompile. It stays R1229's follow-up and
  needs no owner restart unless the orchestrator asks.
