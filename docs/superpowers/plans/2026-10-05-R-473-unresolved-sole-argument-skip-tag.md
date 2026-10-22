# R-473 plan: tag the unresolved sole-argument `true` flip on Modify/Delete/Insert
Evidence: `survey.md` next to this file.

## The gap (confirmed)
When `X.Modify(true)`, `X.Delete(true)` or `X.Insert(true)` has a receiver `X` that does not
resolve, `swap-modify-flag` does not claim it, so `flip-boolean-literal` flips the `true` to
`false`. Its table rows for these three methods have `skip: null`, so that flip carries no
`run-trigger-skipped-*` tag. Shown on a probe: master untagged, prototype tagged.

## The change (tag only)
In `packages/builtin-tier1/src/flip-boolean-literal.ts`, give the count-1 rows of
`RUN_TRIGGER_ARGUMENTS` for `Modify`, `Delete` and `Insert` a `skip`:
`modifySkipCanRaise` / `deleteSkipCanRaise` / `insertSkipCanRaise`, tags
`run-trigger-skipped-modify` / `-delete` / `-insert`. `runTriggerTag` already returns `skip.tag`
for an unresolved receiver (R-364, R460), so no logic changes. Update the row comment and the
operator doc ("they have no `skip`" is no longer true).
On a resolved receiver nothing changes: a claimed sole `true` is ceded to `swap-modify-flag`
(`claimedRunTriggerSkip`), so this operator never sees it. A resolved non-record receiver (a
codeunit's `Modify(true)`) is neither claimed nor unresolved and stays untagged.
No new mutants, none removed, no owner change, no version bump (as R457 and R460).

## Why not let `swap-modify-flag` claim unresolved receivers
That moves every such site from Tier 1 to Tier 2: 1116 BC.History sites change operator name, so
their identity keys change (scheme bump to 23) and their history is lost. It is also unsound: an
unresolved receiver may be a codeunit with a `Modify(Boolean)` procedure, and `claimsRecordMethod`
refuses it for exactly that reason (rule 4). Tagging is a screen, where over-tagging is the safe
direction; claiming is not. Recommend tag only.

## Measured (complete dumps, master vs prototype, every operator)
- Added 0, removed 0, changed other than the tag 0, identity keys moved 0, on every set.
- Newly tagged (modify / delete / insert): fixtures 0/0/0, examples 0/0/0, CDO 1/0/0,
  BC.History 879/130/107 (1116 in 57 projects).
- `IDENTITY_SCHEME` stays. Not 23.

## Gates
No fixture mutant changes, so `itest:tables`' `platformArtifactKills` and every other gate pin
stay. No pre-commitment needed. No live gate needs a re-run for this change.

## Tests (each with the revert that turns it red)
1. Unresolved receiver is tagged. In `flip-boolean-literal.test.ts`, beside F9/F10: a wrapped
   (`#if`) caller with `Par.Modify(true); Par.Delete(true); Par.Insert(true);` on a `Par` with no
   triggers gives the three skip tags by kind. Revert: put `skip: null` back on the three rows
   (all three go untagged). Also update `r459-run-trigger-seam.test.ts` "Par.Modify(true) on an
   unresolved receiver" to expect `flip false run-trigger-skipped-modify` (it pins today's gap).
2. Resolved receivers do not gain a tag. Same test: the same body from an indexed caller on that
   `Par` gives NO flip (ceded) and `swap-modify-flag`'s three mutants stay untagged (no triggers,
   insert key not assigned); and `Mgt.Modify(true); Mgt.Delete(true); Mgt.Insert(true);` on a
   codeunit receiver that resolves stays flipped and untagged. Revert: drop the
   `receiverUnresolved` check in `runTriggerTag` (tag every unclaimed `true`): the codeunit
   control goes red.
3. `swap-modify-flag`'s claimed sites are unchanged. Existing conformance cases "CEDES Modify's /
   Insert's run-trigger flag" and the R459 seam test (one owner per literal) cover it; no new
   test. Revert to check: make `isCededRunTriggerFlag` return false (flip duplicates the claimed
   literal; those cases go red).

## Steps
1. Edit rows and comments; add tests 1-2, update the seam test; red-check each revert.
2. typecheck, clean dist, `bun scripts/verify.ts`; re-run the fixtures/CDO dump diff.
3. Mark R473 done with the counts.

## Landing order with R-464 (agreed with lethal-bugs; sol r1 finding 4)
R-473 lands on master without waiting. R-464 (planned; scheme 22) resolves more implicit-Rec receivers, which shrinks
the unresolved set. Whichever lands SECOND merges the other and re-runs its exact site diff on top, row by row. sol r1:
SOUND (/coord/reviews/R-473-plan/sol-plan-r1.md).
