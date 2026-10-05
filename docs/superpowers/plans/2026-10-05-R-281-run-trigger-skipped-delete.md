# R-281 plan r2: tag `Delete(true) -> Delete(false)` kills, narrowed like R143 (evidence: survey.md)

## The numbers
- The shape is common. In Base Application, 139 of 286 `Delete(true)` sites have an `OnDelete`
  that deletes other rows. In CDO, 3 of the 13 sites whose table resolves.
- Most sites do not resolve (BC.History 1484 of 1797, CDO 76 of 89, mostly test apps). They keep the tag.
- Sites that lose the tag under r2: BC.History 81 (r1: 85), CDO 10, fixtures 0. Almost all have no OnDelete.

## Fix
1. Engine `interface.ts`: add `"run-trigger-skipped-delete"` to `PlatformKillMechanism`. Rewrite
   the stale text at :37 ("EVERY Insert mutant", out of date since R143) and the ruling at :43, citing R281.
2. Runner `platform-artifact-kills.ts`: add the explanation (the `Record` type forces it). The
   explanation states the cross-app limit: a subscriber or tableextension in another app (such as
   the test app) is not visible. Update "WHAT IT CANNOT SEE".
3. `forced-trigger-raise.ts`: add `deleteSkipCanRaise(node, ctx)`, reusing `resolveReceiverTable`,
   `resolveObject` and `findTableTrigger`. It returns TRUE (keep the tag) unless proven otherwise:
   - receiver or table not resolved, or the table's file arm is undecided (R378) -> true
   - the project has an OnBefore/OnAfterDeleteEvent subscriber for the table, or a tableextension
     of it with OnBeforeDelete/OnAfterDelete -> true
   - no `OnDelete` -> false
   - `OnDelete` has any live call that is not proven harmless -> true. A call is harmless only if
     (a) `claimsRecordMethod` claims it (a Record receiver, and the project declares no method of
     that name) and its name is on a non-writing allow-list (Get, Find*, Next, IsEmpty, Count,
     SetRange, SetFilter, Reset, CalcFields, TestField, FieldError, FieldCaption, TableCaption,
     Init), or (b) it is Modify/Delete on Rec/xRec/implicit, or (c) it is an UNQUALIFIED Error,
     Message or Confirm. Every other call keeps the tag: any write to another record ("writes",
     not "deletes"), DeleteAll/ModifyAll/DeleteLinks, Validate, and any project or codeunit call.
   - otherwise false.
4. `swap-modify-flag.ts` `generate`: pick the tag by method (Insert keeps its tag, Delete gets the
   new one, Modify stays untagged). No `OPERATOR_VERSION` bump (R138/R143 precedent).
Not measured, so stated plainly: whether RunTrigger changes how BC deletes record links, notes or media.

## Keys, schema, report
Mutant identity, operatorMajor, the report schema (`platformKillMechanism` is a plain `string`),
the Caveat list (the existing `platform-artifact-kills` is reused) and SessionReport fields: all
unchanged. Only itest:tables moves. Arm C (`DeleteWithTrigger`, killed) gains the tag:
`killedCount` 2 -> 3, and `byMechanism` becomes [run-trigger-skipped-delete,
run-trigger-skipped-insert, write-txn-codeunit-run]. Name it as an OVER-TAG: the kill is earned by
the test's own `Error`. Pre-commit before any gate; pin the new group BY MUTANT; no verdict moves.

## Tests (each red-checked, with the revert named)
1. `Child.DeleteAll()` in OnDelete -> tagged. Revert: return false whenever an OnDelete exists.
2. `Child.Delete()` on another record -> tagged. Revert: drop the Rec-only receiver check.
3. Only TestField, Error and Rec.Modify -> NOT tagged; no OnDelete -> NOT tagged. Revert: always true.
4. `Record Customer` (unresolved) -> tagged. Replaces the test at swap-modify-flag.test.ts:336,
   which must flip. Revert: unresolved returns false.
5. Unknown `CleanUp();` -> tagged. Revert: allow every call that is not a write method.
6. Shadowed name: the table declares its own `Reset`, or OnDelete calls `Mgt.Get()` on a codeunit
   -> tagged. Revert: match the bare name instead of using `claimsRecordMethod`.
7. Same-project delete subscriber, and a tableextension OnBeforeDelete, on a table with no OnDelete
   -> tagged. Revert: drop each check (one test per check).
8. `#if`: a write only in an inactive arm -> NOT tagged; in an active arm -> tagged; an undecided
   file -> tagged. Revert: stop skipping inactive calls, or drop the R378 check.
9. Insert tagging unchanged (R143 tests stay green); Modify(true) untagged. Revert: send Insert
   through the delete predicate.
Runner: one platform-artifact-kills test that groups a kill tagged by the Delete mechanism.

## Closing: a ruling, with no new fixture arm
The tag is syntactic and never moves a verdict. The measurement and unit tests close it, and arm C
puts a tagged Delete kill through itest:tables live (pre-committed 2 -> 3). Say plainly that the
duplicate-key mechanism for Delete stays UNMEASURED live. The orchestrator decides.

## Changes since r1
- F1: same-project subscriber and tableextension check added; probe 85 -> 81 drops, 0 cross-app; limit in explanation.
- F2: harmless calls need `claimsRecordMethod`; Error, Message and Confirm count only unqualified.
- F3: record links, notes and media stated as unmeasured.  F4: tests 2, 6 and 8 added.  F5: interface.ts :37/:43 rewrite.
- Kept: arm C named as an over-tag, "writes", only itest:tables moves, no schema move, close as a ruling.
