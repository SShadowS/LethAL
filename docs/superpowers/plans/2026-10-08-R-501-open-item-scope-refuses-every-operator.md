# R-501 plan (r3): one dispatch-level refusal for EVERY operator in open report-data-item code, plus a bounded item's only bound

Base: master `7489c1d3`. IDENTITY_SCHEME **31** (from the orchestrator; if R-502's 32 lands first, take the next
free number at merge, and a gap is fine). Evidence: `/coord/handoff/R-501/survey.md` (r1 and r2 kept; "r3"
section). Scripts, prototype diff and samples: `scratch/` (README). Reviews: `/coord/reviews/R-501-plan/`
`adversary-r1.md` and `adversary-r2.md` (REVISE, convergent).

## Changes since r2 (adversary r2)
| finding | r3 |
|---|---|
| 1 HIGH: the loop-skip / loop-truncate exemption is wrong | Deleted. One predicate, no list. Measured: loop-truncate 192 and loop-skip 50 more refused. 28 sampled: 2 certain hangs (loop-skip on the BOMLoop shape), 0 for loop-truncate. The "cannot hang on any input" comments in `empty-block.ts` and `loop-skip.ts` are scoped to the inner loop. |
| 2 MEDIUM: hang-refused wording names only R196 | Build step 6 rewords the three strings and their pins. |
| 3 LOW: "sound by construction" overstates | Reworded below; R500 named. |
| 4 LOW: production path checked only where the mirror flagged | Done for all 519 BC.History projects. The production hang-refused delta equals the mirror's H-added on every project (13,506). The spec deltas also match, except for 71 report-column sites that production never emits but the prototype counted as refused; the build fixes this (step 2). Unflagged projects of every other set have identical production keys (fixtures 19 of 19, examples 4 of 4, and 2 projects each of CDO, DC and DO). |
| 5 LOW: build gaps | Build steps 1, 4 and 9. |

## The rule
- **Where.** In `generateMutationSet`'s loop, the one place that calls `op.generate` and already asks
  `refusesHangCapable`.
- **What.** When an operator in `allOperators` targets a site and `openItemHangRefuses(node, ctx)` holds, the site is
  not generated. It goes to R447's `hang-refused` row under the same inactive-arm, `--operator` and `--lines`
  filters.
- **The predicate.** `openItemHangRefuses` lives in `loop-hazard.ts` and is exported from `@lethal/builtin-tier1`;
  the runner already depends on it. It holds when:
  - the site is in open-item code (`inOpenItemCode`, R487's scope); or
  - the site contains or lies inside the SetRange call that is a bounded `Integer` item's ONLY bound. That is the
    call R484's single-mention certificate accepts (`certifiedCall`), on an item without `MaxIteration`.

**Scope, stated exactly (not "sound by construction").** Within R487's open-item scope and the bound class, no
operator emits. Outside them nothing changes, and these stay EXCLUDED and filed as [[R500]]:
- code that runs before the item (OnPreReport, an earlier sibling);
- procedures in other objects: a codeunit `Helper.HasMore()` whose `exit(Buf.Next() <> 0)` feeds a Break is still
  mutated by `return-value`;
- table triggers reached through `Insert(true)`;
- items over ordinary tables, `Date` items, XMLport `Integer` elements;
- reportextensions outside the project;
- a `while`/`repeat` inside a bounded item's code (R196/R446/R480's loop rules only).
"Covers plug-in operators" was empty: `allOperators` is a fixed list today. The check covers whatever that list
holds, so a future registration point inherits it.

## Measured (exact dumps of every operator, all five sets, 7489c1d3 vs the prototype)
**BC.History: 13,506 specs move from emitted to hang-refused in the mirror dump (0.59% of 2,292,999). 0 changed,
0 appeared.** Production emits **13,435** fewer mutants. The other 71 are report-column expressions that production
never mutates: they are declarative, and `isMutableSite` drops them after `generate`. The prototype still counted
them as hang-refused, so the build checks mutability first (step 2).

| operator | refused | | operator | refused |
|---|---:|---|---|---:|
| void-method-call | 4,635 | | return-value | 144 |
| empty-block | 2,552 | | flip-filter-literal | 72 |
| negate-conditional | 2,296 | | swap-call-arguments | 64 |
| remove-not | 828 | | **loop-skip** | **50** |
| remove-setrange | 764 | | swap-find-direction | 46 |
| toggle-blank-string | 726 | | validate-to-assign | 34 |
| negate-guard | 593 | | remove-calcfields | 33 |
| conditional-boundary | 377 | | toggle-blank-temporal | 29 |
| **loop-truncate** | **192** | | swap-modify-flag | 29 |
| | | | remove-testfield | 24 |
| | | | swap-enum-member | 16 |
| | | | remove-commit | 2 |

- **Dropping the exemption costs 242:** loop-truncate 192 and loop-skip 50 (r2 13,264 -> r3 13,506; the r2 -> r3
  dump diff is exactly those 242).
- By project: BaseApp 12,889, Withholding Tax 345, SubscriptionBilling 114, Subcontracting 70, BankDeposits 64,
  Quality Management 14, Sustainability 10.
- CDO, DC, DO, fixtures and examples: identical. **No gate can move.**
- Production keys (the runner's own generation and numbering): 378 of 806,864 move (BaseApp 340, Withholding Tax 31,
  BankDeposits 4, Subcontracting 3; loop-truncate accounts for 5 of them). IDENTITY_SCHEME 31.
- Hand-read: 194 sites, 22 hang-capable, all 22 refused. By round:
  - r1: 99 sites, 14 hang-capable.
  - r2: 67 sites, 6 hang-capable.
  - r3: 28 sites of loop-skip and loop-truncate, at least 3 per stratum. 2 hang-capable: loop-skip on
    `while BomComponent[Level].Next() = 0 do ...` freezes the BOMLoop's only cursor step, which is a certain hang.
    loop-truncate: 0 of 15.

## Recommendation: this rule
- **One predicate, no operator list.** r1 listed six operators, r2 found thirteen more, and r2's two-operator
  exemption was itself a hang. Report code is refused whatever the operator.
- **Not (b), "exit-related only".** It misses the Break-less CopyLoop: 439 void-method-call and 162 empty-block
  specs on the item's own SetRange, plus remove-setrange 268 and flip-filter-literal 22.
- **Not (c), a ruling.** Two grounds:
  1. Cost. `--stop-hung-sessions` is off by default, and then a hang strands the container: quarantine,
     `container-needs-recycle`, about ten minutes per hang.
  2. Verdict, even with the flag on. `timeout-killed` is a kill that no assertion produced: it records that the
     engine walked 2^31 `Integer` rows, not that a test checked the report.
- **Cost:** 13,506 report-code mutants on BC.History, 0 on every customer corpus. Most of them terminate: the
  over-refusal R484 and R487 accepted.

## Build (next run)
1. **`loop-hazard.ts`.**
   - `certified` returns the call (`certifiedCall`); add `onlyBoundCall`, `altersBoundCall` and
     `openItemHangRefuses`, with NO environment read (the prototype's `R501_MODE` goes).
   - Export the predicate from `builtin-tier1`'s index.
   - Update the header: R501 closed, the bound class, the R500 exclusions.
2. **`orchestrator.ts`.** The one dispatch check (`scratch/r3-prototype.diff`), with one change from the prototype:
   refuse and count only a site that is mutable (`isMutableSite(node)`); a declarative site keeps its normal path
   (dropped and tallied as non-executable). The production-vs-mirror check found the prototype counting 71 report-
   column sites as hang-refused that production never emits (BaseApp 67, Withholding Tax 4). After the fix,
   `hrcheck` must show equal spec deltas on every project and a hang-refused delta of 13,435.
3. **Comments.** Scope "cannot hang on any input" to the inner loop in `empty-block.ts` and `loop-skip.ts` (done in
   the prototype).
4. **Honest semantics.**
   - No operator's `requiresSemantic` changes, because the check is not in an operator.
   - The helper's doc names what it reads: the symbol table, for `modifiedItemOpen`; `ctx.files`, for
     `reportExtended`.
   - A context without `files` answers "extended", the safe direction.
5. **Unit tests.** Each test has a `MaxIteration` twin and a non-report (codeunit) twin. Shapes:
   - void-method-call on an unbraced `then CurrReport.Break()`;
   - empty-block of a whole OnAfterGetRecord, and of a callee body;
   - negate-guard;
   - a reportextension `modify(D)` block;
   - a column;
   - Tier-2 remove-setrange on a CopyLoop's own SetRange;
   - **loop-truncate and loop-skip refused** in an open item (the prototype test does loop-truncate);
   - the bound class, through **both `certifiedCall` branches**: an unqualified `SetRange(Number, 1, 3)` and an
     `Item.SetRange(...)`. Cover void-method-call, remove-setrange and empty-block (contains), and the **inside**
     direction: an operator on a literal argument, if any operator claims one there; otherwise state that none does,
     with a test that pins it. Twins: a `MaxIteration` item, a view-bounded item, and a SetRange on another record,
     all of which emit.
6. **Wording.** Reword the three hang-refused strings to name both causes: R196 (a loop-condition write) and R501
   (open report data-item code, or a bounded item's only bound). They are:
   - the `report.ts` HANG-REFUSED banner;
   - the barren-`--operator` nuance in `generateMutationSet`;
   - the row text in `mutation-elements.ts`.
   Update their pins in `mutation-elements.test.ts` and `r447-hang-refused.test.ts`, and the doc in
   `excluded-sites.ts` (the `hang-refused` reason). There is no schema ripple.
7. **Red-checks.** One red test per direction (R-427):
   - drop the check (the refused test goes red);
   - widen it to every report (a twin goes red);
   - drop the bound half;
   - drop each `certifiedCall` branch.
8. **Orchestrator-level test.** Refusals land in R447's row, and `--operator` and `--lines` filter them
   (`r501-dispatch.test.ts` is the start; 14 pass with R447's suite).
9. **Scheme.** IDENTITY_SCHEME 31 with its comment. **`--resume` and skip-known-survivors refuse across the bump**
   (R325: `--resume` names the old scheme and carries nothing; history and equivalence marks of another scheme
   are not applied), so the first run after the build starts fresh.
10. **Verify.** Re-dump all five sets against these counts (13,506 mirror / 13,435 production / 0 elsewhere), and
    re-run `keydiffprod` and `hrcheck`. Add a unit test that a report column's source expression in an open item is
    NOT counted hang-refused.
    R501 closed with the counts; regenerate the roadmap index; `verify.ts` in a real worktree before merge.
    `itest:hang` is optional: no fixture moves.
