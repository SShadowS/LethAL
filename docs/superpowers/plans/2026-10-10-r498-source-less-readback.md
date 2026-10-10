# R-498 plan r2: prove a source-less hook read-back by byte equality (lethal-preproc, 2026-10-10)

**r2 changes** (opus plan review r1, `review-opus-plan-r1.md`; these override r1 where they differ):
- **Q1:** a source-less read-back with no `publishApps` test-app file is proven by the installed checks alone, as
  `published` is (H5). **Q2:** bytes, not manifest: an unbumped skipped publish keeps the manifest over a
  different body.
- **The byte check compares** `sha256(sources.pkg)` with the `local` bytes `proveReadBack` re-reads for its
  identity check, one source.
- **Read-back digest site:** `readBackDeps` "why" is checked BEFORE `source-less`, so a lost identity names its
  dependency reason. New test **H8**: source-less, proven, dependencies unreadable. It asserts the dependency
  reason is named and `testAppProven` is false.
- **H3** asserts the `why` names the identity or version difference; without that it would pass through the
  byte check.
- **New test H9:** served WITH source against a source-less `publishApps` file stays unproven.
- **`digestsOf`'s branch** becomes exhaustive (`not-published` is the disk path, `published` the package, anything
  else throws), and `Exclude<>` keeps out both `unavailable` and `source-less`.
- **Scope, stated in R498 and the agent guide:** byte equality was measured on the dev-endpoint (`altool`)
  route. The hook publishes through the env tool's own publish command (`makeEnvToolPublisher`). If that route
  repackages, served != file and the run stays unproven: safe, but no gain there.

---


Branch `lethal/r498` from master b16ed704. Step 1 (R14 re-check) is done in ca30d53f.

## Measured (`measure.md`)
- The dev endpoint serves back EXACTLY the published bytes on all four variants, including V3, a package
  published WITHOUT `.al` (0 `publishedAlSources`).
- `resourceExposurePolicy` never strips source. So a source-less read-back means the published FILE had none,
  as with a runtime package.
- So for R498's case, "served bytes == the `publishApps` file's bytes" is available evidence.

## Today (orchestrator.ts)
- `reportPublishedTestApp` returns `sources: { kind: "unavailable", why: "... carries no AL source ..." }` when the
  package parses but has no `.al`. It drops the bytes.
- `proveReadBack` returns `{ why }` for `unavailable` before any check. So a hook session with a source-less test
  app is never proven, and it never resumes, skips or reuses (R498).
- A non-hook source-less session is proven by R495's `provenWithoutHook` (tests T10 and T10b).

## Change
1. **A new `PublishedTestSources` variant** `{ kind: "source-less"; pkg: Uint8Array; why: string }`, returned by
   `reportPublishedTestApp` where it returns the no-`.al` `unavailable` today. Same `why` text, and the bytes are
   kept.
2. **`proveReadBack` takes `source-less` like `published`** through its existing checks:
   - `readAppIdentity(sources.pkg)`;
   - `checkInstalled` for the test app and for every app the hook published;
   - the identity and version equality with the `publishApps` file.

   Then, in place of the `.al` source-set equality (which has nothing to compare), it requires
   **`sha256(sources.pkg) === sha256(publishApps file)`**. On a mismatch the `why` says the served package's bytes
   differ from the file's. The source-set check for `published` is unchanged.
   - **With no `publishApps` file that is the test app** (`publishes.testApp === undefined`): today a `published`
     read-back is proven by the installed checks alone. `source-less` gets the same. This is the one decision for
     review (open question 1).
3. **Digests are unchanged.** A source-less read-back has no `.al` to digest. Every consumer that reads
   `unavailable` as "no digests" reads `source-less` the same way, with the same single `test-digests-unavailable`
   warning and its "carries no AL source" text:
   - `testAppIdentity`;
   - the read-back digest site after the hook;
   - `digestsOf`'s parameter type, which excludes both.

   So a proven source-less hook run records its identity and dependency fingerprint (R496 reads the deps from the
   served package's manifest, which is already source-independent), but no digests and no `D` part, exactly like
   a non-hook source-less run (T10).
4. **The exhaustive narrowings** over `PublishedTestSources` are updated (all in orchestrator.ts; the reviewer
   should check for others): `reportPublishedTestApp`, `testAppIdentity`, `digestsOf`, `proveReadBack`, and the
   read-back site's `readBack.kind === "unavailable"`.

## Tests (in the R492 hook harness in `orchestrator.test.ts`; each red-checked per direction)
- **H1:** hook, source-less, served bytes == `publishApps` file → proven, `testAppProven` true, deps recorded; a
  consumer `--resume` / skip / reuse lends. (Revert the new branch: unproven, red.)
- **H2:** hook, source-less, same identity and version, served bytes != file bytes → unproven, with a `why` naming
  the bytes; lends nothing. (Drop the byte check: proven, red.)
- **H3:** hook, source-less, identity or version differs from the file → unproven (the existing check, now
  reached for source-less). (Skip it for source-less: red.)
- **H4:** hook, source-less, served version not installed → unproven (`checkInstalled`). (Skip it: red.)
- **H5:** hook, source-less, no `publishApps` file is the test app → proven (pins open question 1, whichever way
  the review rules).
- **H6:** a proven source-less hook run records NO digests, and exactly one `test-digests-unavailable` warning
  containing "carries no AL source".
- **H7:** a source-ful hook read-back whose bytes differ but whose `.al` set is equal stays proven. The byte check
  must not leak into the `published` path.
- The existing T10, T10b and the R492 tests stay green unchanged.

## Live
No gate runs a hook session on the container: envtool is host-only. The live fact this change rests on (served ==
published, for a package without `.al`) is the R-498 measurement itself. Unit tests carry the rest.

## Docs
`docs/using-lethal-from-an-agent.md`'s note on hook sessions, if it says source-less is unproven, is updated. R498
becomes `done (<commit>)`, and the CHANGELOG gets an entry.

## Open questions for review
1. Should source-less with no `publishApps` test-app file be proven by the installed checks alone, as `published`
   is today?
2. Is `sha256` of the whole package the right equality, rather than manifest equality? Bytes are stricter, and
   the measurement shows bytes are equal, so I chose bytes.
