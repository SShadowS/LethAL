# R-474 plan r2: rule 2 carries only into an unchanged member

Evidence: `survey.md` (sections 3 and 5). Prototype and tests: scratchpad `r474/proto/`.

## The hole
Rule 2 of `carryRecord` (selection.ts) carries a verdict across a source change, matching on
(file, tuple) for a mutant that is a singleton in its file in both runs. The tuple hashes only the
statement. Sol's sequence (insert `exit(1);` before an unchanged `X := X + 1;`, resume) carries
run 1's `killed` onto a now-unreachable mutant. Reproduced on master for resume (false kill) and
for history (a `survived` skipped after the `exit(1);` is removed).

## Measured (mutant-site pairs; a structural proxy, see survey §5)
Rule-2 site pairs whose member changed: 0.03-0.74% across one CDO PR, 0.24-3.45% across one BC
minor release, up to 6.6% across a month of CDO. The text hash refuses 128 more site pairs than
the AST hash, out of about 3.3 million. The proxy's sites contain production's on all six apps
reconciled (production is 96.5-99.6% of them); BaseApp was not reconciled.

## The cut
1. Rule 2 also requires an equal `memberHash` on both sides. Rule 1 is unchanged.
2. `memberHash` = SHA-256 of the member's RAW source text (no normalisation, so identifiers,
   literals, directives, comments and spacing all count; a formatting-only edit re-runs, which is
   cheap). The span runs from the member's first attribute to its end, including
   attribute-only `#if` wrappers and S11's outer run: the widened `attributeRun` of
   testpage-scan.ts, MOVED to engine (one copy, used by both runner and schemata). Member =
   `enclosingMemberOf` (procedure-like, else trigger); `""` at object level. Cached per member.
3. Storage: optional `MutantManifestEntry.memberHash` and nullable `mutants.member_hash TEXT`
   (the existing ALTER list in `migrate`). A NULL row stays in the by-key index (rule 1 carries)
   and is not a rule-2 site (rule 2 carries nothing). A manifest without the field records NULL;
   no hash is ever invented.
4. Read in `mutantVerdicts` -> `buildResumeIndex` (`carryableBySite` keyed by
   `memberSiteOf(twinSiteOf(file, tuple), hash)`) and `priorSurvivorKeys` (`sites`). Twin facts
   (`twin_tuples`) unchanged. `verify` resolves stored manifest entries and records through the
   shared `record` path, so it writes the hash through.
5. Keys do not move: statement `astHash`, tuples, ordinals, `serializeKey` untouched; no
   IDENTITY_SCHEME bump, no baseline re-record. What DOES change: the manifest's bytes, hence its
   SHA-256 and the installed-payload digests. Update the byte captures, characterization
   snapshots and generated stream schema; never rewrite historical bundles.

## Residual (stated in R474 when it closes)
Rule 2 still carries across edits outside the member: callers (one changed to bypass it),
callees, globals and their initialisation, table definitions and properties, other triggers and
subscribers, and the `#if` context around the member (equal build symbols do not mean unchanged
surrounding source). Rule 1 admits none of these: any edit changes the generation hash.
Decision: NO enclosing-object "outside-members" hash. Measured, it refuses 0.4-28% of site pairs
(about the per-file cut's 0.4-35%, and 100% on an object-id renumbering) against the member
hash's 0.03-6.6%, and it still misses every cross-object effect. No equally cheap guard closes
callers and subscribers.

## Tests (r474-context.test.ts; all below but verify written and red-checked in the prototype)
- Sol's sequence (resume) and its reverse (history). RED when the hash is ignored.
- Global swap `if GA` -> `if GB`; receiver swap `ServiceA.Done()` -> `ServiceB.Done()`. RED under
  `astSubtreeHash`.
- `[EventSubscriber]` retargeted; the same inside `#if not CLEAN24`. RED without attributes;
  the wrapped one RED without the `#if` wrapper.
- Trigger member (`exit;` before S in `OnInsert`). RED when the hash is ignored.
- Control: an edit in another member still carries; rule 1 with NULL rows still carries
  (RED when the check leaks into rule 1).
- History NULL: no edit -> known-survivor (rule 1); edit elsewhere -> runs. Migration: a store
  whose `member_hash` was dropped (store.test.ts's DROP COLUMN pattern) reopens with NULLs; rule 1
  carries, rule 2 does not. Fail closed. All three RED when NULL reads as a wildcard.
- Manifest without `memberHash`: `carryRecord` refuses rule 2, the row records NULL.
- To write: verify write-through (source manifest's hash carried; none in it gives NULL).

## Changes since r1
1. Raw-text SHA-256 replaces `astSubtreeHash`; re-measured on the same 22 pairs (+128 site
   pairs refused); global and receiver swaps added and red-checked under the AST hash.
2. The span now includes attributes and attribute-only `#if` wrappers via testpage-scan's
   `attributeRun`, moved to engine; two attribute tests, red-checked both ways.
3. "Same class as rule 1" deleted; residuals listed plainly; outside-members hash measured and
   rejected.
4. Tests added: migration, history NULL rule 1 vs rule 2, manifest without `memberHash`;
   verify write-through planned.
5. Counts are named mutant-site pairs and a proxy, reconciled with production on six apps;
   attribute and trigger cases added and red-checked. Manifest SHA-256 and payload digests change.

## Build notes from sol r2 (SOUND as a plan, /coord/reviews/R-474-plan/sol-plan-r2.md)
- The verify write-through test is a LANDING requirement.
- `attributeRun`: move the FULL original into the engine, keeping runner `memberRun`'s policy (widen for tests, narrow
  for non-tests, `andTrivia`, attribute order, `conditional`, S11 pieces, digest normalisation). Do not substitute the
  prototype's simplified helper. Prove the move neutral with the testpage-scan and test-digest suites, unchanged.
- Fix §5's wording: the 22 pairs total 1,973,516 mutant-site pairs, not "about 3.3M". Production is NOT a strict subset
  (12 production sites are missing from the proxy).
- Cache the member hash per member, not per mutant.
- CRLF/LF checkout differences hash differently: a SAFE false refusal, stated in R474's closing note.
