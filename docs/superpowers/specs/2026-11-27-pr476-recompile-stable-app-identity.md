# PR-476 (R1234): a recompile-stable test-app identity — design and pre-commitment r2

lethal-code, 2026-11-27. Written before any code.
- **r1** was d7cc46ec9.
- **r2** answers its spec-adversary (B1-B3, S1-S4, NITs) and replaces r1.

## Why (PR-475's measurement, corrected)

- Three alc builds of UNCHANGED `fixtures/sandbox-tests` give three `hashPackage` values. So R247/R495 refuse every
  `--resume` after a setup that recompiles (PR-468's live leg).
- **What moves:**
  - the NAVX header id (bytes 12-27);
  - **the header's zip length (bytes 28-35)**, which differs by 1 between builds (3073 / 3074 / 3073);
  - `NavxManifest.xml`'s `<Build … Timestamp="…">` VALUE;
  - the zip's entry times and deflate bytes.
  - PR-475's first compare missed the zip length (an empty slice; corrected in its findings).
- A content walk that leaves out the id and the zip length, and blanks only the Build Timestamp value, is EQUAL on
  all 3 builds (6beee117…, re-measured).

## The rule (B1, B2, S1): c2 ONLY for identities STORED and compared ACROSS sessions

- **Across sessions,** where a recompile between the two reads is normal and expected, the identity is c2:
  `runs.test_app_hash`, the baseline-snapshot key (R192), `--resume`'s R247/R495, history lending, and verify's
  recorded `testAppHash`.
- **Within one session,** nothing recompiles between two reads. A moved `hashPackage` is the ONLY signal that
  something was PUBLISHED meanwhile (R495's drift, R462/R686's re-read, the publish read-back). Every within-session
  comparison KEEPS `hashPackage`.
  - Otherwise c2 would hide a republish of the same source: a wrong diagnosis, or a kill measured during a reinstall
    kept (B1).
- So a session carries BOTH values for the served test app: `{ identity: package:c2:…, bytesHash: hashPackage }`.

## `appContentIdentity(buf)` (the "c2" form)

- **Shape gate:** only for bytes with `hashPackage`'s known NAVX shape (NAVX at 0 and 36, header length 40, version 2,
  the u64 at 28 = the bytes after the header). Any other shape, including a signed or wrapped package, gives the old
  form `package:<hashPackage>`, unchanged.
- **H (B3):** `sha256(bytes 0..12 ‖ bytes 36..headerEnd)`. The id (12..27) and the zip length (28..35) are left out;
  the shape gate already checked the length.
- **Every entry,** sorted by name bytes: `E <name>\t<uncompressedSize>\t<sha256(data)>`, via PR-457's
  `packageEntries`, whose refusals THROW (never a partial digest).
- **The ONE blanking:** in the entry named exactly `NavxManifest.xml`, the value of an attribute named exactly
  `Timestamp` (preceded by whitespace; so NOT `XTimestamp`) on an element named exactly `Build` is replaced by the
  empty string.
  - Exactly one `<Build` element carrying exactly one such attribute; otherwise NO blanking (fail closed).
  - Every other byte is hashed: the app id, name, publisher, version, dependencies, `CompilerVersion` (a different
    alc version changes c2, the fail-closed direction), runtime, targets, and every other attribute and element.
- **Form:** `package:c2:<hex>`.
  - It cannot collide with the old `package:<64 hex>`.
  - Suffixes (`|pending`, `|closed-world:…`, `|closed-world:revoked`) attach after it exactly as today.

## Every site, and its decision

| # | site | role | decision |
|---|---|---|---|
| 1 | `baseline-snapshot.ts testAppHashFor` | the served test app's identity: `runs.test_app_hash`, snapshot key | **c2** |
| 2 | `orchestrator.ts` test-app read (`testAppHash = package:${hashPackage(bytes)}`) | the same identity on the read path | **c2, by the SAME function as #1** (if the two ever differ, every bcdev session drifts at batch 0) |
| 3 | `verify.ts` recorded `testAppHash` (`package:${compiled.packageHash}`) | verify's stored identity | **c2, by the shared function**, never `package:${hex}` built by hand |
| 4 | `orchestrator.ts assertNoTestAppDrift` (R495, every batch) | within-session republish detection | **hashPackage**: the session's `bytesHash` from the proving read against each later read |
| 5 | the baseline-refusal re-read: `stale-test-app.ts testAppRefusal` (R462), `baselineFoundNoneRefusal` (R686) | within-session: was something published? | **hashPackage** |
| 6 | `test-app-publish.ts` `packageHash` and the read-back compare (≈ 287, ≈ 415) | publish confirmation | **hashPackage** (B2) |
| 7 | `baseline-snapshot.ts listOtherFiles` / `otherFilesDrift` (al-runner-v3 in-run proof, R608/R790) | within-run drift; also cost (a symbol package is 373 MB uncompressed) | **unchanged** (S1) |
| 8 | `orchestrator.ts` R498 source-less served-vs-file | the same build | **unchanged** |
| 9 | `digest-inputs.ts` `X` lines (R496 partners), `P content c1:` (System) | dependencies | **unchanged** |
| 10 | `artifact.ts` output and `artifact_sha256`; `named-mutants.ts` `appSha`; the al-runner-v3 built-app sha | per-run artifact, file integrity, cache key | **unchanged** |
| 11 | `closed-world.ts pendingIdentitiesOf` and the store's revocation | exact string match on stored identities | **unchanged code**: after this change a new client stores c2 only, so a flip revokes pending rows of the c2 form. Old-form pending rows of earlier clients are not revoked by a new client. They can never resume anyway (the identity differs), so this is harmless; stated. |

- The builder re-greps for `hashPackage(`, `testAppHash`, `test_app_hash` and `packageHash`. A site missing from
  this table STOPS the build: it is added here with a decision first.

## Old-form values in stores (S2)

- An old `package:<64 hex>` (with any suffix: `^package:[0-9a-f]{64}(\||$)`) never equals a c2 value.
- Every refusal path that compares a prior identity adds the sentence "the prior run's test-app identity is the
  pre-R1234 form (package:<hex>); a run made after R1234 records package:c2:…; re-run fresh" when the prior is
  old-form:
  - `assertSameTestApp`'s plain path;
  - the pending path (`pendingRefusal`) and the revoked path;
  - `--skip-known-survivors`.
- `TEST_APP_WHY` is reworded: a recompile that changes only the build timestamp no longer counts as a different test
  app; a different identity means different content, or a pre-R1234 prior.
- No migration. Mixed forms only ever refuse.

## Pre-committed tests (red both ways)

1. **Recompile-stable:** a repo fixture PAIR built from one invented package that differs ONLY in the header id, the
   zip length, the Build Timestamp value, the entry times and the deflate level → equal c2. `hashPackage` differs.
   - **Offline**, on PR-475's three real builds: c2 equal (one value); `hashPackage` three values.
2. **Each changes c2,** one test each: one character of AL source; `SymbolReference.json`; an added, removed or
   renamed entry; an uncompressed size; EACH other manifest attribute (app version, id, name, publisher, a
   dependency's version, `CompilerVersion`, runtime, a second `<Build>` attribute).
3. **Blanking scope (S3): PAIRS that differ ONLY in timestamp values must DIFFER in c2** for:
   - a manifest with two `<Build>` elements;
   - one with no `<Build>` but a `Timestamp` on `<App>`;
   - `XTimestamp="…"` on `<Build>`.
4. **Red checks:**
   - hashing bytes 28..36 → test 1 red;
   - not blanking → test 1 red;
   - blanking every attribute → test 2 (`CompilerVersion`) red;
   - a looser attribute regex → test 3 red.
5. **Within-session sites keep hashPackage (B1), the end-to-end case:** one session, two reads with the SAME c2 and a
   different `hashPackage`.
   - `assertNoTestAppDrift` throws `TestAppDriftedError`;
   - a baseline found-0 re-read gives `TestAppChangedError`, not R686's discovery refusal.
   - Red if either site compares c2.
6. **The publish read-back:** a read-back with the same c2 and a different `hashPackage` → not `accepted` (as today).
7. **Old form:** a prior run with `package:<hex>|closed-world:…` → the resume refuses with the R1234 sentence; the same
   for the pending and `--skip-known-survivors` paths.
8. **The fallback:** non-NAVX or signed bytes → `package:<hashPackage>`, as today.
9. **#2 and #1 agree:** a session's stored identity equals `testAppHashFor`'s for the same bytes.

## r2a (the delta review of r2; overrides the text above where they differ)

1. **(B4) `bytesHash` is a REQUIRED field of `TestAppIdentity`.**
   - Every builder sets it: the no-hook session (≈ 8780), the env-tool hook path (≈ 8689: `after.packageHash` as
     `package:<hashPackage>`), and al-runner's `source:` identity, where `bytesHash` = that same source identity, so
     al-runner's drift check is unchanged.
   - `assertNoTestAppDrift` compares `provenTestApp.bytesHash` against each read's `bytesHash`. It can never be
     skipped by an absent field.
   - **Test 5 runs once per builder:** the hook path, the no-hook path and al-runner. Each one's drift check fires
     when the bytes move.
2. **(S5) The re-read site's values:**
   - `batchTestAppReader` returns `{ identity, bytesHash }`;
   - `snapshotKey` gains `beforeBytes`;
   - R462's `before`, R686's `proven` and `after`, and the proof-withdrawal condition all use `bytesHash`.
   - `snapshotKey.testAppHash` stays c2 (`findBaselineSnapshot`, the snapshot write, `priorRestartSnapshot`).
   - The closed-world tag goes on both values or on neither; never on one only.
3. **(S6) A store guard:** `createRun`, `setRunTestAppHash` and `insertBaselineSnapshot` THROW on a value matching
   the old form when the session computed a c2 identity for a NAVX-shaped package.
   - Simpler and equivalent: a test that a session reading a NAVX-shaped package stores `package:c2:` in BOTH the run
     row and the snapshot row, plus a red check that storing `bytesHash` turns it red.
   - `bytesHash` keeps the `package:<hashPackage>` form that `testAppRefusal` and `baselineFoundNoneRefusal` require
     (`startsWith("package:")`).
4. **The old-form sentence** goes also on the env-tool resume's `TestAppRepublishedError` (≈ 8697-8720).
   - Its wording: "the prior run's test-app identity is the pre-R1234 form, or a package LethAL does not
     content-hash (signed or of unknown shape)".
   - **Test 7 adds:** a NEW-client run whose package fell back (signed) is refused WITHOUT the pre-R1234 claim being
     the only explanation, that is, the sentence names both causes.

## Gates

- `legs.ts` for the touched files: bcdev and lease at least, plus CI. The itests that assert
  `hashPackage(fresh) === compiled.packageHash` stay valid (#6 unchanged): test-app-publish, verify-agreement,
  verify-scale, verify.
- No committed baseline pins a `package:<hex>`, so no figure should move. A moved figure is a BLOCK.
