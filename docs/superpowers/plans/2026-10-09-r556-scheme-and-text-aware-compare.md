# R-556 plan r2 (lethal-preproc, 2026-10-09)

**r2 (opus plan review r1, `review-opus-plan-r1.md`, all adopted). Supersedes r1 below where they differ.**
1. **Redaction marker is not text.** `normalizeForComparison` gives NO hash when `mutatedText` is `REDACTION_MARKER`
   or not a string; `freezeStageTo` REFUSES a report with any marker row (hashes from a redacted report are never
   right). `scripts/report-diff.ts` inherits the rule. Red tests: freeze refuses a marker row; compare against a
   redacted report is UNVERIFIED for those rows, never DIFFERENT.
2. **Twins across a scheme change.** When the two sides' schemes differ (or either is unrecorded), a row is
   hash-VERIFIED only if its hash is unique within its tuple group (the key without `|ordinal`); other rows are
   UNVERIFIED and counted in the statement. Same scheme: hashes compare row by row. No refusal for gates or campaigns.
3. **One reader, one shape.** `readGateBaseline(path)` (baseline-guard.ts) returns `{ identityScheme?, entries }` and
   accepts the legacy bare array or the object `{ identityScheme?, coverageMode?, entries }` (the stage shape, reused);
   it refuses a missing/empty `entries` or any other shape. Routed through it: `compareWithCommitted`,
   `verify.itest.ts`, `test-app-publish.itest.ts`, `verify-agreement.itest.ts`, `verify-scale.ts` `verdictDiffs`,
   `scripts/c0204b-live-probe.ts`, `scripts/r193-r197-baseline-proof.ts`, and `harden-fixture.test.ts`.
   `parseStageBaseline` accepts an optional integer `identityScheme`. A new gate record writes the object form.
4. **Minors:** the hash is the last tie-break in `recordOrder`/`sortedForDisk` (not printed); a gate whose baseline has
   hashes REFUSES an actual row without one (the check cannot switch itself off); the legacy seeds in
   `campaign-subcommands.test.ts` strip the hash (legacy path stays tested); the difference reads "mutated text differs
   under an unchanged key" (neutral; `\r\n` normalized to `\n` before hashing); `freezeStageTo` over an existing stage
   gets the same identity statement; `campaign-compare` schema regenerated with the new `identity` block and
   `schemas.test.ts` updated; `identical`'s doc says "verdicts, and mutated text where both sides record a hash";
   `CAMPAIGN_COMPARE_SCHEMA_VERSION` stays 1 (an added field; the meaning widens only where hashes exist, stated);
   agentflow note recorded in R556.
5. **R556 status:** the mechanism lands; R556 stays OPEN ("mechanism landed, records pending") until the gates are
   re-recorded and the stages re-frozen (each pre-committed, R332; a stage re-freeze needs a fresh live run). Those are
   filed as their own item(s).

---

(r1 text, kept for the record)

# R-556 plan r1 (lethal-preproc, 2026-10-09)

Claim: run 001, token eecd48d8-dff8-4a19-839a-5f0be0021b90. Branch `lethal/r556` from master 9ff74df7. Measured:
`step1.md`.

## The idea
The danger is a mutant that CHANGED under an unchanged key (the replacement differs: a pair change). The scheme number
says "keys may mean different things now"; a per-mutant HASH of the mutated text says "this key is still this mutant".
With both recorded, a compare can tell the cases apart without guessing:
- key equal, text hash equal: the same mutant, whatever the scheme -> verified as today;
- key equal, text hash different: a different mutant under the same key -> a per-mutant DIFFERENCE, named;
- hash absent on either side (every legacy baseline): text UNVERIFIED, said in one line, never a refusal;
- scheme recorded on both sides and different: "identity scheme changed" -> each key is verified only by its hash; with
  no hash: "identity scheme changed, UNVERIFIED" (the R355 pattern), not a refusal, because keys of unchanged mutants
  are still comparable and a refusal would fail every gate after every scheme bump.
The hash is `sha256(mutatedText)` (hex, first 16 chars is enough for this purpose; full 64 to be safe and simple) — never
the text, so a committed stage baseline publishes no source (the public-repo rule).

## Change
1. `mutant-equality.ts`: `NormalizedMutant` gains OPTIONAL `mutatedTextSha256?: string`; `normalizeForComparison`
   fills it from `m.mutatedText` (absent when the report has no text, e.g. a REDACTED committed report).
   `diffMutants` compares it only when BOTH sides have it (a mismatch is a difference naming the key and "mutated text
   changed under an unchanged key"), and reports, separately, how many keys it could not check.
2. Itest gates (`baseline-guard.ts` `compareWithCommitted`/`writeBaselineOnce`): a NEW record writes the file as
   `{ "identityScheme": IDENTITY_SCHEME, "mutants": [rows with mutatedTextSha256] }`; the reader accepts that and the
   legacy bare array. Compare: as above; a legacy baseline prints one line "<label>: baseline predates R556 (no
   identity scheme, no mutated-text hash): a mutant changed under an unchanged key is UNVERIFIED" and passes as today.
   A recorded scheme different from the build's prints "identity scheme changed (N -> M)" and relies on the hashes.
3. `campaign freeze`: the stage baseline records `identityScheme` (from the report) and per-row hashes (from the run's
   UNREDACTED report, which freeze reads before redaction; freeze refuses a report whose mutants carry no text?
   -> no: a hash is simply absent, and compare says UNVERIFIED). `campaign compare`: the same three-way rule, in
   `CampaignCompareResult` as a new `identity` block shaped like R355's `coverage` (`verified` + `statement`), and on
   the console. `CAMPAIGN_COMPARE_SCHEMA_VERSION` unchanged (an added field, per schemas/README).
4. No baseline or stage is re-recorded by this item. Re-freezing (to gain hashes) is a later, deliberate, pre-committed
   R332 step per gate, filed as an item, not done here.

## Tests (a red per direction)
- diffMutants: same key + same hash -> no difference; same key + different hash -> a difference naming "mutated text";
  hash on one side only -> no difference, counted unverified. Red: drop the hash compare -> the different-hash test
  red; compare when one side lacks it -> the one-sided test red.
- Gate: a legacy array baseline still passes and prints the UNVERIFIED line (red if the reader requires the object);
  an object baseline with a changed hash fails naming the key (red if hashes are not compared); a recorded scheme that
  differs prints "identity scheme changed" (red if not read).
- Campaign: freeze writes scheme + hashes; compare on a legacy stage prints the statement; a hash mismatch is DIFFERENT;
  a scheme mismatch without hashes is "identity scheme changed, UNVERIFIED" with `identity.verified: false`.
- The pair-change case end to end: a report pair with one key whose mutatedText differs -> DIFFERENT (R340's shape).

## Open for the review
- Should a gate REFUSE when the scheme differs and the baseline has hashes that all match? (Proposed: no; the hashes
  prove identity.)
- Should a redacted committed report (text removed) be refused by `campaign compare` when the stage has hashes?
  (Proposed: compare verdicts, mark text UNVERIFIED for those rows, say so.)
