# PR-457 (R1230): hash the served System package by content — pre-commitment r2

lethal-code, 2026-11-26.
- **Ruling (orchestrator):** build now, fingerprinting each entry by the sha256 of its uncompressed bytes, not its
  CRC-32, so R496's guard does not get weaker.
- **r1** was 8b52687a4.
- **r2** answers its spec-adversary: B1 and S1-S5, plus NITs N1-N5. The "r2 changes" section takes precedence.

## r2 changes (spec-adversary)

- **(S1) No W line.** The content digest runs on the SERVED buffer, BEFORE `unwrapSymbolPackage`.
  - A plain package is unchanged by this.
  - A wrapper's entries, the inner `.app` included, are hashed raw. That is conservative: an unstable line only
    refuses. R820 records that System is not a wrapped app (bc4 served 5 of 5 plain).
- **(S2) One new export in `app-package.ts`, `packageEntries(buf)`.**
  - It walks the central directory ONCE, yielding `{name, flags, method, uncompressedSize, localOffset}`, and
    inflates entries one at a time, with `maxOutputLength = uncompressedSize + 1`.
  - It throws on:
    - a duplicate name;
    - the encryption flag (gp bit 0);
    - a method other than 0 or 8;
    - an inflate error;
    - an inflated or stored length ≠ `uncompressedSize`;
    - the EOCD total-entries count ≠ the number of entries walked;
    - a name with a control character (N2).
  - Every reader throw becomes `DependencyUnreadableError` naming System. Zip64 and data descriptors fail loudly or
    work as today (CD sizes).
- **(N1) H** = bytes `[0, baseOffset + min(localHeaderOffset))`, taken from the central directory, never a signature
  search. **(N3)** Entries are sorted by raw UTF-8 bytes (`Buffer.compare`), never `localeCompare`.
- **(S3) The stored line is `P content c1:<hex>`.**
  - The R496 resume refusal and `lethal verify`'s dependency cause add: "or LethAL changed how it fingerprints System
    (R1230): a store recorded before it refuses once; start a fresh run" (CAUSE_WORDS.subscriber's precedent).
  - It misses ONCE in each consumer: `--resume`, `--resume-run`, `priorSurvivorKeys` (a silent non-match),
    `findBaselineSnapshot` (a fresh baseline), and `lethal verify` (every test new, which may trip
    `--max-new-tests`).
  - `folder` and `declared` mode stores (al-runner, al-runner-v3) have no P line, so they are unaffected.
- **(B1) Test 9b:** a fake `readSystem` returns a re-zip with ONE entry's bytes changed, and the fingerprint must
  DIFFER. It is red-checked by wiring the wrong buffer (the control package's) into P.
- **(S4) The tests:**
  - the fixtures gain deflated entries, settable DOS time and date, and a NAVX-style header;
  - test 1 includes a stored-vs-deflated pair and two deflate levels of equal content;
  - test 2 runs on a deflated entry;
  - ONE red test per error branch;
  - test 10: two entries swap contents → a different digest.
- **(S5) The X lines stay on raw bytes** (the stronger guard; unstable only refuses).
  - The claim is narrowed: ONE partner app (Continia Core) was measured byte-stable; the other 6 Continia apps and all
    Microsoft X lines (Application, Base, System Application, ...) are NOT measured.
  - So R1230 alone does not unblock R1229. R1229's checklist gains a LINE-BY-LINE fingerprint diff across the next
    restart: the line set, not only the final hash.
- **(N4) "BC re-zips System per request" is NOT measured.** The data shows a different zip per bc4 instance, across
  restarts. Gates' pre-lease and under-lease fingerprints match within an instance.
- **(N5) The real-file check** also asserts 486 E lines, and that one entry's sha256 equals an independent extractor's
  (`unzip -p … | sha256sum`).
- R496's limit is unchanged: binary-only platform updates were never in the fingerprint.

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
