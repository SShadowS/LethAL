# R-452 plan r2: tag a skipped OnModify, the ModifyAll/DeleteAll RunTrigger flips, and close R-281's under-tags
Evidence: `survey.md` beside this file (r1 section, then "r2"). **Scope widens:** R452.md also covers the post-merge R-281 findings 1-3 (`/coord/reviews/postmerge-2026-10-05/sol-R-259-R-281.md`) and its three weak tests.

## Numbers (probe; no `#if` arm map, so a probe output and not a production total; comment-aware arguments)
| site | BC.History: total / drop now / drop under rule D | CDO | fixtures |
|---|---|---|---|
| `Delete(true)` (live R-281) | 1797 / 13 / 13 | 89 / 10 / 10 | 1 / 0 / 0 |
| `Modify(true)` | 22644 / 123 / 123 | 45 / 10 / 10 | 4 / 3 / 3 (+1 grammar-probe tagged) |
| `ModifyAll(F,V,true)` flip | 196 / 8 / 8 | 0 | 0 |
| `DeleteAll(true)` flip (R-281 missed) | 900 / 54 / 54 | 13 / 4 / 4 | 0 |

- **Rule D** = no `Modify`/`Delete` is harmless, plus the two parenthesis-less fixes. Every site that drops the tag has no trigger at all, so rules B, C and D remove 0 drops.
- Live `deleteSkipCanRaise` agrees with the probe on all 2914 delete-kind sites. R281.md's "81 drops" predates its review fixes; the live number is 13.

## Rulings
- **Tag both true -> false flips** (`ModifyAll` argument 3, `DeleteAll` argument 1). The flip's false -> true direction is R165's forced class: file it before submit, and do not build it here.
- **Rule D for both triggers** (sol finding 1 and post-merge finding 1). Own record is not own row, and a RunTrigger=true write runs a trigger nobody read.
  - So no `Modify`/`Delete` call is ever harmless. `OWN_ROW_WRITES` and `onOwnRecord` are deleted.
  - Removes 0 drops on all corpora. **R-281's Delete detector does have this under-tag** (`xRec.Get(X); xRec.Delete()`, `Rec.Modify(true)` in `OnDelete`). No corpus site hits it.
- **Parenthesis-less calls (post-merge finding 2):**
  - `procedureNamesOn` also collects every `name` field of `preproc_split_procedure` and `_preamble`.
  - A bare `X.Y` is a field read only when X is `Rec`/`xRec` and Y is a field of the trigger's OWN table. Anything else keeps the tag.
  - Removes 0 drops.
- **Cross-app observers (post-merge finding 3): keep it as the stated limit, and file it.**
  - Measured over each whole corpus: of the drops, one BC.History `Modify` site (`No. Series`, NoSeriesCopilotImpl.Codeunit.al:95) is observed by a TEST app's `OnAfterModifyEvent` subscriber. That subscriber only clears a cache and never reads RunTrigger. Delete, ModifyAll and DeleteAll: 0. CDO 0, fixtures 0.
  - The cost of reading the test app: `generateMutationSet` has no `testDir`, though the session has `cfg.testDir`. It would need a new option and a context field. The manifest would then depend on test sources (digest inputs, `--dry-run`, census and itest callers all change), and a run and a dry-run would disagree.
  - The cost is too high for 1 measured site. Name the limit in the explanation, which already says so.
  - Reasoned, not measured: table events fire whatever RunTrigger is, so only a subscriber that reads RunTrigger changes behaviour. That is why the limit is narrow.
- **Named arguments:** AL has none (alc 18: AL0104 on `RunTrigger := true`). So the literal must be span-equal to the argument.

## Commits
1. **Pure move to `@lethal/engine`.** Move the skip half of `forced-trigger-raise.ts` (`deleteSkipCanRaise`, `isHarmlessTriggerCall`, private helpers) and tier2 `mutate-helpers`' `argumentNodes`, `countArguments`, `exactArguments` and `soleArgument`.
   - Tier-2 re-exports them all, and engine imports no builtin.
   - Proof: the relocation diff, plus before/after dumps of every spec of every operator on BC.History, CDO and fixtures (file, span, operator, after-text, mechanism; Insert and forced included). The dumps must be identical, and the 19 fixture manifests byte-identical.
2. **Rule D and the parenthesis-less fixes** (for Delete, the only kind that exists yet). Expected change on the corpora: 0 mutants.
3. **Generalise** to `skipCanRaise(node, ctx, kind)`, with per-kind events, extension triggers, table trigger and text regex. `kind` goes into the call scan. The two wrappers remain.
4. **Tag.**
   - Add `run-trigger-skipped-modify` and its explanation. Widen the Delete text to `DeleteAll(true)`.
   - `swap-modify-flag` tags `Modify`. `flip-boolean-literal` tags a `true` span-equal to `exactArguments(call,3)[2]` of a `ModifyAll`, or `exactArguments(call,1)[0]` of a `DeleteAll`, claimed by `claimsRecordMethod`.
   - Update the comments (flip's "never reaches them", tables.itest's "a `Modify` site ... no mechanism").
5. **Weak tests** (each red-checked on its revert):
   - **(a)** "own Reset" also falls to `tableProcedures`. Replace it with `Other.Reset()` where `Other` is a Record of a SECOND project table that declares `Reset`. Revert: skip `claimsRecordMethod` in the non-writing branch.
   - **(b)** orchestrator.test.ts "a probe that ends in ... is unknown, never notKilled" (3 cases): give each scripted answer a clean `attestation: { observedAny: true, identityMismatch: false }`. Revert: the attempted-set completeness guard.
   - **(c)** verify.test.ts "a target sibling is probed too": `recordingWorld` must record rows only for the requests production sends in `cfg`, not for its own scripted `res.probes`. Revert: production's probe-request construction.
6. **Roadmap.**
   - Widen and close R452.
   - File the forced flip and the cross-app limit (with the 1-site measurement).
   - Note on R281: rule D, the parenthesis-less fixes, and that the live drop count is 13.

**Schema / keys / Caveats / SessionReport:** none move.
**Gate:** nothing moves. `killedCount` stays 3, and byMechanism is unchanged.
- M0165 (DataMain.Table.al:75) and M0208 (DataOps.Codeunit.al:69) stay untagged: Data Main's `OnModify` only bumps its own field.
- M0132 Delete stays tagged. Chunked M0016 is untagged.
- Proven offline by diffing EVERY fixture manifest after commits 2 and 4. Only `platformKillMechanism` may differ: pinned fixtures not at all, and grammar-probe's `Other.Modify(true)` (ProbeTable.Table.al:50, unpinned) gains `run-trigger-skipped-modify`.
- So no pre-commitment is needed.

## Tests (mutation-red-checker on each; the revert is after the arrow)
- **Delete, rule D.** T1 `xRec.Get('X'); xRec.Delete()` -> tag; T2 `Rec.Modify(true)` in OnDelete -> tag; T3 OnModify `Rec."No." := 'X'; Rec.Modify()` and `Rec.Delete()` -> tag (revert for T1-T3: restore `OWN_ROW_WRITES`). T4 split-header `CleanUpChildren` used as a value -> tag (revert: raw `procedure` only). T5 `if Mgt.Flag then`, field `Flag` on another table -> tag (revert: any-table field set).
- **Modify.** M1 unresolved -> tag (drop the Modify arm). M2 own-field assignments and `xRec` comparisons -> none; M3 no OnModify -> none (always tag). M4 `Child.DeleteAll()` -> tag (skip the scan). M5 `Error` only / `TestField` only -> none (treat as unproven). M6 `Validate` -> tag (allow-list it). M7 `with Kid do Modify()` -> tag. M8 `OnBeforeModifyEvent` / `OnAfterModifyEvent` subscriber -> tag, `OnAfterDeleteEvent` only -> none (delete set / union). M9 the same for tableextension triggers. M10 `CleanUp;` and `if CheckIt then` -> tag. M11 `#if` inactive / active / undecided -> none / tag / tag.
- **Flips.** F1 `ModifyAll(F,1,true)`, harmful OnModify -> modify tag (wrong kind / never tag); F2 harmless -> none. F3 `ModifyAll(Flag,true,true)`: value literal none, RunTrigger literal tagged. F4 `/* c */` before argument 3 -> tag, `ModifyAll(F,/* c */ true,false)` -> none (F3-F4 revert: raw `namedChildren` index). F5 `(true)` -> none (accept descendants). F6 `false` -> none. F7 `DeleteAll(true)` harmful / harmless / commented -> tag / none / tag. F8 codeunit or project-procedure `ModifyAll`/`DeleteAll` -> none (drop `claimsRecordMethod`). P1 report group and explanation for the modify mechanism.

## Changes since r1 (sol plan findings)
1. Own record is not own row: rule D for both triggers (R-281 has the under-tag). Removes 0 drops. Commit 2; T1-T3.
2. Arguments come from `exactArguments`, span-equal, with pinned counts. There are no named arguments (AL0104). measure.ts was fixed and re-run: no count changed. F3-F5, F7.
3. Commit 1 is a pure move with Tier-2 re-exports, proven by spec dumps on all corpora and identical manifests.
4. The probe's scope is labelled, and it was re-run after fix 2.
5. sol's cases were added, with Error/TestField kept apart from Validate. The manifest diff names grammar-probe.

## Changes since r2 (sol r2, /coord/reviews/R-452-plan/sol-plan-r2.md)
- s2-1 HIGH: a bare `Rec.Y`/`xRec.Y` counts as a field read only when the receiver's BINDING is the trigger's
  own implicit Rec/xRec: resolve it through the engine's var-ref resolution. A local or parameter that
  shadows the name, or a binding that cannot be resolved, keeps the tag. First check with Linux alc whether AL even
  allows a local named `Rec` in a table trigger. Record the compiler result, and pin the shadowing case in a test either way.
- s2-2: the `with` tests use an otherwise allow-listed name (`with Kid do Reset()`, where Kid's table declares a
  writing `Reset`), so removing the `with` guard turns them red. The existing Delete test that expected
  `Rec.Modify()` to be harmless is flipped. A separate drop control with only Error/TestField stays.
- s2-5: the explanation states the cross-app limit as a scope boundary: one cross-project observer
  match, not a demonstrated under-tag. It never claims that absent local observers prove harmlessness.
- s2-6:
  - add a `DeleteAll(false)` / `ModifyAll(..., false)` no-tag control;
  - add one rejection test per write/transaction/Run method (Insert, Rename, ModifyAll, DeleteAll, Validate, LockTable,
    Commit, Codeunit.Run, Report.Run, Page.Run), each run separately;
  - never combine calls that each keep the tag on their own;
  - correct the survey wording: the BC.History drops include one harmless Modify trigger, and the fixtures include three triggers.
