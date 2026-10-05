# R-457 plan r2: `run-trigger-forced` by edit, conservative rule
Evidence: `survey.md` §r2. Orchestrator rulings 1-3 applied. Simulated in a scratch copy; real bytes.
## Rule (one engine predicate, both operators)
`forceCanRaise(call, ctx, kind)` in `engine/src/semantic/trigger-skip.ts`, kind insert/modify/delete.
KEEPS the tag unless: the receiver's table resolves; its file arm is decided; `projectObserves` finds
no same-project subscriber to the kind's events, no tableextension `OnBefore/OnAfter<X>`, no
unindexed/`#if`-wrapped extension; and the table has no `On<X>`. Both trigger lookups count an
UNDECIDED member arm as present, and with no arm map every `#if` arm (`anyArm`: only "inactive" is
skipped). Any trigger body keeps it; no body is read. Reuse: `SKIP_KINDS` gains `insert`;
`projectObserves` takes `kind: RunTriggerKind` and an `armOf` defaulting to today's `rawArmOf(ctx)`,
so the skip path is untouched.

## Code
1. Stage 1, no behaviour change: widen `SKIP_KINDS` and `projectObserves`. PROVEN in simulation:
   complete deterministic spec dumps (every `MutationSpec` field, sorted keys, full before/after
   text and span) on 203 BC.History projects, CDO Cloud and Test, and 19 fixtures: 224 files,
   2,335,631 specs, identical to master; 20/20 manifests byte-identical; 0 failures. An unchanged
   copy dumped identically first, proving the dump deterministic. Repeat on the branch.
2. Stage 2: add `forceCanRaise` (exported, with `RunTriggerKind`); swap-modify-flag's
   `generateForced` tags through it. Its SCOPE (`resolveForcedTrigger`, which picks emitted sites)
   is unchanged, so no site or key moves. Delete `forcedTriggerCanRaise`, `RAISE_CAPABLE_METHODS`
   and the tier-2 `calleeName`.
3. flip-boolean-literal: `RUN_TRIGGER_ARGUMENTS` gains `Modify`/`Delete`/`Insert` (exactly 1
   argument, index 0) and a `kind` per entry. A `false` span-equal to the comment-aware argument of
   a `claimsRecordMethod` call gets `run-trigger-forced` when `forceCanRaise` holds; a `true` keeps
   R-452's skip path. Two-argument `Insert(false, X)`: exact count 1 refuses it, so it stays
   untagged (BC.History 4, CDO 0, fixtures 0); `Insert(true, X)`'s first argument stays orphaned by
   the cession (BC.History 13). Both go to a NEW roadmap item (adds sites, moves identity).
4. Widen the `run-trigger-forced` explanation (`platform-artifact-kills.ts`, `interface.ts`): covers
   the flip, says unreadable tables keep it, drops "provably raises". Fix the operator comment.
5. Roadmap: R165 notes `forcedTriggerCanRaise` was unsound (calls without parentheses, `with`,
   indirect calls, raising assignments, RunTrigger-reading subscribers) and was replaced. R457
   closes. File the `Insert` two-argument item.

## Measured under the new rule (BC.History / CDO / fixtures)
- flip `false` RunTrigger flips tagged/dropped: 1431/191, 331/8, 24/28 (r1's rule: 46/0/0).
- swap-modify-flag forward mutants: 2507/66/1, now ALL tagged (was 1050/35/0), since every claimed
  site has a trigger. That tag is now blanket by construction: the rule's stated price.
- R-452 skip tags: unchanged (no other transition; 0 non-tag differences).

## Gate (actual manifest diff, 20/20 runs, 0 failures)
18 byte-identical, chunked's among them. sandbox-data gains the tag on M0034 M0045 M0056 M0065
M0223 M0362 (flips) and M0186 (R165's forward `Main.Modify()`); sandbox-data-tests gains 18 (no gate
mutates it). None loses one. **itest:tables MOVES:** M0223 (`Data Ops.InsertWithoutTrigger`) is
KILLED by `InsertWithoutTriggerKeepsAmount`, so `platformArtifactKills` 3 -> 4 and `byMechanism`
gains `run-trigger-forced` = [M0223], a named OVER-TAG (the test's own `Error`). The other six are
survived or no-coverage, not counted. No verdict moves; the baseline holds no mechanism, so no
re-record. Pre-commit, update `tables.itest.ts` (count, sorted list, membership), run it live.
Keys: tag only. `IDENTITY_SCHEME` stays 13; no version, schema, Caveat or SessionReport change.

## Tests (each red-checked on its named revert; a negative asserts the flip, same edit, no tag)
- Keeps (revert: return false at that step), one shape per test, no other raise in it: unresolved
  base-app table; undecided table file; undecided member-level `On<X>`; extension `OnAfter<X>`
  only; unindexed `#if`-wrapped extension; subscriber `if RunTrigger then Error`; `On<X>` holding
  only `Check;` (no parentheses), only a `with`, only an assignment.
- Contrast: `OnModify` with only `TestField` -> forced tagged, skipped untagged. F1/F7 stay.
- Drops (revert: always tag): resolved, no trigger, no observer. Kind (revert: ModifyAll -> delete):
  `ModifyAll(..., false)` with only `OnDelete` -> no tag.
- Positions: `Mgt.ModifyAll(1, 2, false)`; table procedure `DeleteAll(Run)`; the value in
  `ModifyAll(Flag, /* c */ false, false)`; `(false)`; `Insert(false, true)`. Reverts: drop
  `claimsRecordMethod`; raw-children index; accept a descendant; drop the exact count.
- swap-modify-flag forward tagged on a harmless-trigger table (revert: old recogniser). Update F4,
  F6, R378 A3, its pin and the A2/A3 undecided case (the 5 the simulation turns red).

## Changes since r1
1. Recogniser deleted; conservative cut for both operators. 2. Observers and undecided arms
(member arms too) keep the tag. 3. Unresolved tables keep it. 4. `Insert(false, true)` filed
separately, handling stated (Code 3). 5. Complete dumps, real manifest bytes, scripts exit 1 on
failure/missing output, per-shape tests with reverts. 6. Keys 13, tag only; text fixed.

## Changes since r2 (sol r2, /coord/reviews/R-457-plan/sol-plan-r2.md: the rule and the gate prediction hold)
- Pin each kind (Insert/Modify/Delete) separately for its base trigger, its tableextension trigger and BOTH event names
  (OnBefore…Event, OnAfter…Event). Add wrong-kind drop controls, Insert vs Modify above all. Each is a separate red-checked test.
- Drop controls: a table with only a field `OnValidate`, and one with only `OnRename`, drop the tag. Boolean arguments of
  Rename/Validate stay ordinary flips with no tag.
- `anyArm`: test it with no-arm-map conditional-trigger cases plus evaluated active/inactive trigger-declaration
  controls. The undecided-member case alone also hits the file-level guard, so it cannot red-check `anyArm`.
- `verdicts.ts` builds the full identity key (hash, object, procedure/trigger, operator, major, ordinal) and fails
  unless exactly one baseline row matches each tagged mutant. Re-run it on the real branch.
- The "preparation stage" is labelled behaviour-neutral, not a pure move. Repeat the dump and manifest checks on the actual branch.
  Remove the stale "PROVABLY raises" comments (including `generateForced`). The report text keeps the other-app observer limit.
- Gate (confirmed by sol against the baseline): itest:tables platformArtifactKills 3 -> 4. The forced group is exactly M0223
  (`Data Ops.InsertWithoutTrigger`, ordinal 1, killed, an over-tag). M0034, M0045, M0056, M0065 and M0362 (survived) and M0186
  (no-coverage) gain the tag without moving the count. To be pre-committed before the live run.
