# PR-457 (R1230): hash the served System package by content — pre-commitment

lethal-code, 2026-11-26. Ruling (orchestrator): build now, fingerprinting each entry by the sha256 of its uncompressed
bytes, not its CRC-32, so R496's guard does not get weaker.

## Measured (R1230, `/coord/handoff/PR-456/probes/`)

- **Three downloads** of System 29.0.57585.0 from bc4 (2026-11-05, 2026-11-14, 2026-11-26): each 5,004,132 bytes, with
  three different sha256.
- **The same content:** the same 486 zip entries with the same names, CRC-32s and sizes, and the same 40-byte NAVX
  header. Only every entry's DOS date and time differ: BC re-zips System on each request.
- **Partner apps** (Continia) are served back byte for byte, so their `X` lines are not changed.

## The change (digest-inputs.ts, `dependencyFingerprint`)

- **The `P` line** becomes `P content <hex>`, where hex = sha256 of these lines, joined by "\n":
  - `H <sha256 of the bytes before the zip's first local header>`, the NAVX header;
  - for each zip entry, sorted by entry name (UTF-8 byte order), the line `E <name>\t<uncompressed size>\t<sha256 of
    the uncompressed bytes>`.
- **The digest runs on the app** `openPackage` already reads, after `unwrapSymbolPackage`. If a Ready-to-Run wrapper was
  unwrapped, a line `W <sha256 of the wrapper bytes outside the embedded app>` is added. A wrapper therefore still
  counts, but its zip timestamps do not.
- **It fails loudly** (`DependencyUnreadableError`, naming System) on:
  - a duplicate entry name;
  - an entry that cannot be inflated;
  - a size that differs from the central directory's;
  - an encrypted or unsupported compression method.
  - Never a partial digest.
- **Uses the existing zip reader** (`app-package.ts`, `listPackageEntries` and `readPackageEntry`). No new dependency.
  - The entries are inflated one at a time, and each is dropped after it is hashed: System has 486 entries in a 5 MB
    package.
- **Only System changes.** `X` lines (partner and transitive apps) stay as `sha256(bytes)`. `M` lines and the control
  line are untouched.
- **Old digests.** A store recorded before this change holds a raw-bytes `P` digest, so `--resume` of such a run
  refuses once through R496 (no back-compat before release). The refusal text is unchanged.

## Red tests (each red with its fix reverted, both directions)

The fixtures are SYNTHETIC packages (a NAVX-style header plus a zip built in the test). The real System files are
Microsoft binaries and are never committed.
1. **Equal content, two different zips → the SAME digest:** different DOS timestamps, a different entry order in the
   archive, a different compression level.
2. **An entry's bytes edited** (same name, same size) → a different digest.
3. **An entry added** → a different digest.
4. **An entry removed** → a different digest.
5. **An entry renamed** → a different digest.
6. **The header** (the bytes before the zip) changed → a different digest.
7. **A duplicate name, or a corrupt entry** → `DependencyUnreadableError`, never a digest.
8. **A partner `X` line** is still raw bytes: re-zipping a partner package changes its line.
9. **`dependencyFingerprint` end to end** with a fake `bytesMode` whose `readSystem` returns two re-zips of one content →
   equal fingerprints.

## Real-file check (handoff only, not committed)

- `/coord/handoff/PR-457/real-system.ts` computes the new `P` digest of the three real downloads.
- Pre-committed: all three EQUAL. Changing one entry's bytes in a scratch copy gives a different digest.

## Gates

- legs.ts for digest-inputs.ts: expected the BC legs that read the fingerprint (bcdev, lease, ...) plus the v3 gate.
- The gates record `test_app_deps` fresh on each run, so no frozen figure moves.
