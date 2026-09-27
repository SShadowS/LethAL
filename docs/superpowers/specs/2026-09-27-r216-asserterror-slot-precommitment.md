# R216 pre-commitment: `asserterror_statement.body` as a statement slot

Written and committed on top of HEAD 3a27c64 before any corpus census under the changed predicate.
Nothing above OUTCOME changes after a run.
Plan: docs/superpowers/plans/2026-09-27-R-216-asserterror-statement-slot.md (r3)

## Change under test
`asserterror_statement.body` added to SINGLE_STATEMENT_SLOTS (packages/engine/src/ast/tree-walks.ts).

## Instruments
census-operator-sites.ts before and after; probe-census-diff.ts (multiset, per operator);
scripts/r216-classify-gained.ts (multiset gained/lost; AST ancestry; the runner's deployment
checks isEnumeratedAl, validateSpec, isMutableSite, dedupeSpecs, canCarryMutationSelectorVar;
app role product / test / unknown, test = exact test-library dependency name or id, or any
Subtype = Test/TestRunner codeunit in the app).

The classifier was proven on the two committed repros (`scripts/lib/al-kind-mapping-asserterror-*.al`)
in four scratch layouts before this commit: `prod` (app.json, no test dependency) gave 4 product
deployable rows, exit 0; `testdep` (a `Library Assert` dependency) gave 4 test rows, exit 0; `testcu`
(no test dependency, one extra `Subtype = Test` codeunit in the same app) gave 4 test rows, exit 0;
`noapp` (no app.json) gave 4 unknown rows, exit 3. Every layout: lost 0, bad 0. Renaming the
dependency to `library assert` turned `testdep` back to product (exact match, no case folding). A row
planted outside any asserterror body was reported BAD, exit 1.

## Corpora
"Census inputs" hashes the list census-operator-sites.ts reads: every `.al` file, recursive,
`.dependencies` included, sorted, with the `fingerprintCorpus` algorithm. "Reference" is
`scripts/corpus-fingerprint.ts` (`corpusEntries`, which excludes `.dependencies`), for identity only.
No input holds a `Mutation*` file, so the census list equals the runner's `isEnumeratedAl` list.

| key | path | census-inputs files | census-inputs sha256 (first 16) | reference files | reference sha256 (first 16) |
| --- | --- | ---: | --- | ---: | --- |
| do | U:/Git/do-rel2/Cloud | 554 | f380b94036704699 | 417 | 9a8e8831449208cc |
| dc | U:/Git/DC/Cloud | 1135 | 57e93501bdbf9ab8 | 475 | dcad155c4ecdb38e |
| sentinel | U:/Git/BusinessCentral.Sentinel | 67 | 9363656ed52020e0 | 67 | 9363656ed52020e0 |
| bcf | U:/Git/BC.History/BusinessFoundation | 104 | a56a8435136fc21f | 104 | a56a8435136fc21f |
| sysapp | U:/Git/BC.History/System Application | 1718 | 7fae1831fda03a89 | 1718 | 7fae1831fda03a89 |
| baseapp-source | U:/Git/BC.History/BaseApp/Source | 8020 | bdfe9cb74e8b8196 | 8020 | bdfe9cb74e8b8196 |
| baseapp-test | U:/Git/BC.History/BaseApp/Test | 1600 | 044abf731c1e9f05 | 1600 | 044abf731c1e9f05 |

Fixture targets (census-operator-sites.ts, recursive): sandbox-app, sandbox-data, sandbox-hang,
sandbox-harden, sandbox-coverage-probe, examples/gift-card, examples/credit-limit.

## P1. Legality
`alc` on `asserterror Raise();` and `asserterror ;` in a codeunit with NO Subtype.
Predicted: compiles.
Basis: R216 recorded that `asserterror ;` compiles under alc 18.0.2668733, and nothing we have read
limits `asserterror` to test codeunits; the codeunit's subtype in that check was not recorded, which
is why Task 2 compiles it again with no Subtype.

## P2. Census
- LOST: 0 on every input. BAD (a gained row not at an asserterror body): 0. Either is a BLOCK.
- Every gained row is from one of the seven gated operators.
- Fixtures: 0 gained.
- do, dc: 0 gained, any role.
- sentinel: 0 gained.
- DEPLOYABLE PRODUCT gained, per corpus and operator: predicted 0 on every corpus.
- UNKNOWN: predicted 0 on every corpus (every BC.History half holds app.json files; do and dc
  gain nothing to classify). Any unknown row stops the lane (see P4).
- TEST gained, reported, predictions as lower bounds only: bcf void-method-call >= 35 (R216);
  sysapp remove-assignment 8 (C4); BaseApp/Test remove-assignment 72 (C4) and
  void-method-call >= 34 (R283's calls).
- Existing rows inside asserterror bodies (the operators of plan fact 2, and the 8
  toggle-blank-string rows): unchanged, which LOST 0 already implies.

## P3. Gates
No fixture product code holds an asserterror statement (grep, comments only). P2's
fixture line (0 census rows gained or lost, recursive) establishes that no operator gains or
loses a site on any fixture, so no deployed mutant can be added or removed. It does NOT prove
the emitted text of existing mutants is unchanged; that text changes only for mutants inside an
asserterror body, and fixture product code has none. Predicted: no gate figure moves, and no live
gate runs for this change.

## P4. Stop rule (decided now, before the numbers)
Deployable product site = a gained row the classifier reports as `product` AND `deployable`.
No hand review changes a role: the classifier's rule is the ruling.
- UNKNOWN STOP: any `unknown` row on any corpus. Return to the coordinator with those rows
  listed (object, file, line, operator). Unknown never counts as product.
- STOP (a): P1 shows alc refuses asserterror outside a test codeunit. Close R216: "not
  admitted: alc refuses asserterror in a non-test codeunit, so no product code can hold the site".
- STOP (b): 0 deployable product sites on every corpus. Close R216: "not admitted: measured 0
  deployable product sites on <corpora and fingerprints>; the <n> gained sites are all in test
  code, which LethAL does not mutate; reopen if a target app holds asserterror in product code".
- CONTINUE: >= 1 deployable product site. If every such site is in a Microsoft BaseApp or
  System Application product object, return to the coordinator BEFORE Task 5; that is CONTINUE
  evidence, not yet an admission.
The reason for STOP is only the measured absence of deployable product sites. It is not a claim
that the sites carry no information: validate-to-assign's rewrite can.

## OUTCOME
Run 2026-09-27 on HEAD 9c9d741 (branch lethal/r216). The predicate change was applied in the working
tree only, for the AFTER census and the classifier, then removed with an exact edit;
`git diff --quiet -- packages/engine/src/ast/tree-walks.ts` exited 0 afterwards.

### P1. Legality: MATCHED
alc from the AL extension 18.0.2732683 (compiler 18.0.41.45789; newer than the 18.0.2668733 R216
used), runtime 16.0, symbols `Microsoft_System_28.0.47067.0.app`.
- Probe (no Subtype): `asserterror Raise();` and `asserterror ;` compile. Exit 0, `.app` written,
  no diagnostic.
- Control (`Subtype = Test;`, same body): exit 0, `.app` written, no diagnostic.
So alc accepts `asserterror`, including an empty body, in a codeunit that is not a test codeunit.
STOP (a) does not apply.

### Stability (R218)
BEFORE twice on BaseApp/Test: 977451 rows both times, 0 only-in-A, 0 only-in-B.

### Inputs read
Census file counts equal the pre-committed census-inputs counts on every corpus: do 554, dc 1135,
sentinel 67, bcf 104, sysapp 1718, baseapp-source 8020, baseapp-test 1600. Fixtures: sandbox-app 2,
sandbox-data 32, sandbox-hang 1, sandbox-harden 2, sandbox-coverage-probe 3, gift-card 4,
credit-limit 5. Every census, diff and classifier run exited 0.

### P2. Census, per input
Gained / lost / bad / unknown, then gained rows by role, deployability and operator.

| input | BEFORE rows | gained | lost | bad | unknown | deployable product | test |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sandbox-app | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| sandbox-data | 413 | 0 | 0 | 0 | 0 | 0 | 0 |
| sandbox-hang | 40 | 0 | 0 | 0 | 0 | 0 | 0 |
| sandbox-harden | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| sandbox-coverage-probe | 86 | 0 | 0 | 0 | 0 | 0 | 0 |
| gift-card | 64 | 0 | 0 | 0 | 0 | 0 | 0 |
| credit-limit | 46 | 0 | 0 | 0 | 0 | 0 | 0 |
| do | 38583 | 0 | 0 | 0 | 0 | 0 | 0 |
| dc | 103205 | 0 | 0 | 0 | 0 | 0 | 0 |
| sentinel | 1422 | 1 | 0 | 0 | 0 | 0 | 1 |
| bcf | 3643 | 35 | 0 | 0 | 0 | 0 | 35 |
| sysapp | 78504 | 305 | 0 | 0 | 0 | 0 | 305 |
| baseapp-source | 791762 | 0 | 0 | 0 | 0 | 0 | 0 |
| baseapp-test | 977451 | 7505 | 0 | 0 | 0 | 0 | 7505 |

Test rows per operator (no product row and no unknown row exists on any input, deployable or not):
- sentinel: void-method-call 1 deployable. The one row is `AnalysisNotSchedTestSESTM`
  (a `Subtype = Test` codeunit in app `BusinessCentral.Sentinel.Test`),
  `BusinessCentral.Sentinel.Test/src/AnalysisNotScheduled.Test.Codeunit.al` line 79.
- bcf: void-method-call 35 deployable.
- sysapp: void-method-call 295, remove-assignment 8, validate-to-assign 2; all deployable.
- baseapp-test: void-method-call 6108 deployable and 9 not-deployed, validate-to-assign 1307,
  remove-assignment 72, remove-testfield 6, remove-commit 3; all of the last four deployable.

Product rows, by object name: none, on every input. Unknown rows: none, on every input.
Deployable product sites: 0 on every input.

Prediction lines:
- LOST 0 on every input: MATCHED. BAD 0: MATCHED.
- Every gained row from one of the seven gated operators: MATCHED (five of them appear:
  void-method-call, remove-assignment, validate-to-assign, remove-testfield, remove-commit).
- Fixtures 0 gained: MATCHED.
- do, dc 0 gained: MATCHED.
- sentinel 0 gained: MISSED. 1 gained, a test row (above). The plan's grep facts covered do and
  dc only; sentinel's test app holds `asserterror` with a call body.
- Deployable product gained 0 on every corpus and operator: MATCHED.
- Unknown 0 on every corpus: MATCHED.
- bcf void-method-call >= 35: MATCHED (35).
- sysapp remove-assignment 8: MATCHED (8).
- BaseApp/Test remove-assignment 72: MATCHED (72).
- BaseApp/Test void-method-call >= 34: MATCHED (6117).
- Existing rows inside asserterror bodies unchanged: MATCHED (lost 0 on every input).

### P3. Gates: MATCHED
0 census rows gained or lost on all seven fixture targets, so no deployed mutant is added or
removed on any fixture. No live gate was run, as predicted.

### Decision
Decision: STOP (b). 0 deployable product sites on every input (seven fixture targets, do, dc,
sentinel, bcf, sysapp, BaseApp/Source, BaseApp/Test; fingerprints in the Corpora table). All
7,846 gained sites are in test apps (sentinel 1, bcf 35, sysapp 305, BaseApp/Test 7,505), which
LethAL does not mutate. P1 shows alc accepts asserterror in a codeunit with no Subtype, so the
reason is the measured absence of product sites, not legality. Reported to the coordinator
before any roadmap change, per its stop instruction.

[Correction 2026-09-27, after review R-216-001 r1: "LethAL does not mutate" in the Decision above
is too broad. It holds for a run targeting a product app. The scoped claim: 0 deployable PRODUCT
sites on these inputs; the 7,846 gained sites are in test apps, which a run targeting a product app
does not mutate (a run targeting a test project would enumerate them).]

[Classifier re-run 2026-09-27: after the run, `scripts/r216-classify-gained.ts` was tightened so a
test-library dependency counts only when its `publisher` is exactly `Microsoft` (retained test
`scripts/r216-classify-gained.test.ts`). Re-run on the saved census rows of all fourteen inputs, each
output byte-identical to the original, so no count moved: sandbox-app, sandbox-data, sandbox-hang,
sandbox-harden, sandbox-coverage-probe, gift-card, credit-limit, do, dc and baseapp-source gained 0;
sentinel 1 test; bcf 35 test; sysapp 305 test; baseapp-test 7,505 test; product 0 and unknown 0
everywhere.]
