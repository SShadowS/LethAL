# R-371: how many tests a reachable-set digest turns new per helper edit

Measured 2026-09-30, offline, on master 4491a866 (branch lethal/r371). Raw output: `output.txt`.
Two rounds: r1 (below, first) and the "r2 re-measure" section at the end, which answers plan r2's
rulings (H:/lethal-coord/reviews/R-371-plan/rulings-r1.md). The r1 scripts are in commit eb250b2c
(`git show eb250b2c:scripts/r371-reach-measure/measure.ts`); the files here now hold r2.

## What was measured

For every discovered test, the walk collects every TEST-APP procedure the test can reach. The walk
is a copy of the Scanner in `packages/runner/src/testpage-scan.ts` (it is not exported), in
`walk.ts`, with three changes marked "R-371":

- a procedure's `[HandlerFunctions(...)]` handlers are walked too (the product walk does not follow
  them);
- every edge the walk does not follow is recorded by kind;
- the driver is `measure.ts`, not `analyzeTestPageSources`.

"Tests turned new" by an edit to procedure P is the number of tests whose reachable set holds P:
under a reachable-set digest, every one of them changes digest. Under today's per-method digest
(R-278) an edit to P turns new only a test whose OWN method is P, so 0 for every edit below (none
of the picked procedures is a test).

The five edits, picked among reached NON-test procedures, ranked by how many tests reach them:

1. the most-shared helper;
2. the helper at p90;
3. the helper at the median;
4. the most-shared procedure named by some `[HandlerFunctions]`;
5. the median "codeunit-local" helper: reached only by tests of its own codeunit (this set holds
   handlers too, and on DC and BaseApp the median pick is one).

Request size. `planVerify` adds every new test to every survivor's request and runs each new test
twice unmutated. With N new tests and S survivors that is at most S x N + 2N extra test executions
(fewer where a new test already covers a survivor, since a request never holds a test twice). The
multiplier against a baseline of one new test is N.

A "codeunit outside the test app" edge is a call into a codeunit the test app does not declare:
either the app under test (a test-app digest need not cover it) or a test library shipped in
another app (Library Assert, Library - Sales, ...), whose edits a test-app digest cannot see at
all. The split between them is a NAME heuristic (`/library|assert/i`), reported separately.

## Summary

| Suite | Tests | % tests with an unfollowed edge | % reaching a library outside the test app | Reach of a non-test procedure: max / p90 / p50 | Tests turned new: edits 1 / 2 / 3 / 4 / 5 | Today (per-method) | Peak RSS | Time |
|---|---|---|---|---|---|---|---|---|
| DC (`U:/Git/DC/Test`) | 1,301 | 75.6% | 74.1% | 406 / 29 / 4 | 406 / 29 / 4 / 44 / 4 | 0 | 260 MB | 0.8 s |
| DO (`U:/Git/do-rel2/Test`) | 1,287 | 99.5% | 97.9% | 158 / 25 / 4 | 158 / 25 / 4 / 17 / 2 | 0 | 214 MB | 0.3 s |
| BaseApp (`U:/Git/BC.History/BaseApp/Test`, whole tree) | 40,291 | 99.4% | 99.1% | 5,734 / 19 / 3 | 5,734 / 19 / 3 / 125 / 2 | 0 | 2,597 MB | 15.6 s |
| sandbox-data-tests (fixture) | 68 | 77.9% | 5.9% (Library Assert, and the app's own Data Assert Ops matching the name rule) | 13 / 13 / 11 | 13 / 13 / 11 / none / 11 | 0 | 112 MB | 0.0 s |

Extra test executions per edit (S x N + 2N, upper bound):

| Suite | Edit 1 S=10 / S=100 | Edit 2 | Edit 3 | Edit 4 | Edit 5 |
|---|---|---|---|---|---|
| DC | 4,872 / 41,412 | 348 / 2,958 | 48 / 408 | 528 / 4,488 | 48 / 408 |
| DO | 1,896 / 16,116 | 300 / 2,550 | 48 / 408 | 204 / 1,734 | 24 / 204 |
| BaseApp | 68,808 / 584,868 | 228 / 1,938 | 36 / 306 | 1,500 / 12,750 | 24 / 204 |
| sandbox-data-tests | 156 / 1,326 | 156 / 1,326 | 132 / 1,122 | none | 132 / 1,122 |

Baseline (one new test): 12 at S=10, 102 at S=100.

## DC (Continia Document Capture tests)

145 files, 135 codeunits, 3,191 procedures; 1,301 tests, all walked, no parse errors. 458 tests
carry `[HandlerFunctions]`; 17 event subscriber procedures in the test app are never walked.

- Reach per test: p50 11, p90 41, max 65 test-app procedures.
- Unfollowed edges: 983 tests (75.6%). By kind: codeunit outside the test app 983 (75.6%), of
  which named like a library 964 (74.1%); with-statement receiver 181 (13.9%); `Codeunit.Run` 30
  (2.3%); a procedure in a non-codeunit test-app object 5; `BindSubscription` 5.
- Most common targets: `Assert` (841 tests), `Library - Variable Storage` (540),
  `Library - Purchase` (528), `Library - ERM` (426), `Library - Lower Permissions` (406),
  `Library - Random` (400), `Library - Utility` (397), then the app's own `CDC Capture Management`
  (347), `CDC Record ID Mgt.` (346), `CDC Approvals Bridge` (332).
- Sharing, over 2,528 reached procedures: p50 1, p90 18, p99 169, max 406. Over the 1,227 reached
  non-test procedures: p50 4, p90 29, p99 185, max 406.
- Top 10: `CDC Library - Permission.ResetPermissionLogging` 406,
  `CDC Library - DC.GetPurchDocCatCode` 390, `CDC Library - DC Document.CreateDocumentValue` 334,
  `CDC Library - DC Document.CreateDCDocument` 318, `CDC Library - DC.GetDocTypeForDCDocument` 318,
  `CDC Library - Purchase.CreateVendor` 267,
  `CDC Library - Document Pages.OpenDocumentListAndFindDocument` 221,
  `CDC Library - User Mgt..UpdateUserEmail` 205, `CDC Library - Permission.SetSuperPermission` 201,
  `CDC Library - Workflow.EnableDCWorkFlow2` 185.
- Edits: (1) `CDC Library - Permission.ResetPermissionLogging` 406; (2)
  `CDC Match (Test).AdjustRefDocument` 29; (3)
  `CDC Test Field Trans (Test).CreateTemplateFieldBasedOnTranslation` 4; (4)
  `CDC Storage Models.NotificationHandler` 44; (5)
  `CDC Register (Test).PurchaserTranslationModalPageHandler` 4.

## DO (Continia Document Output tests)

104 files, 103 codeunits, 1,695 procedures; 1,287 tests, all walked, no parse errors. 82 tests
carry `[HandlerFunctions]`; 31 event subscriber procedures in the test app are never walked.

- Reach per test: p50 2, p90 9, max 22.
- Unfollowed edges: 1,281 tests (99.5%): codeunit outside the test app 1,281, of which named like a
  library 1,260 (97.9%); `BindSubscription` 78 (6.1%); `Codeunit.Run` 20 (1.6%).
- Most common targets: `Library Assert` 794, `Assert` 466, `Any` 323, `Library - Sales` 238,
  `Library - Random` 129, then the app's `CDO Core Event Handler` 114,
  `CDO E-Document Response` 95.
- Sharing, over 1,638 reached procedures: p50 1, p90 5, p99 42, max 158. Over the 351 reached
  non-test procedures: p50 4, p90 25, p99 104, max 158.
- Top 10: `CDO Library - Setup.InitializeCDOSetup` 158,
  `CDO Library - Email Template.MockEmailTemplateLine` 152,
  `CDO Library - Features.GetProductCode` 108,
  `CDO Library - Email Template.MockEmailTemplateHeader` 104,
  `CDO Library - Features.DisableFeature` 85,
  `CDO Library - Email Template.MockSalesInvoiceEmailTemplate` 84,
  `CDO Library - Output Profile.MockOutputProfile` 75, `CDO Library - CDN.CreateSenderProfile` 73,
  `CDO Library - CDN.CreateCDNCustomerSetupForCustomer` 72,
  `CDO Library - Features.EnableFeature` 71.
- Edits: (1) `CDO Library - Setup.InitializeCDOSetup` 158; (2)
  `CDO Email Template Mgt Tests.Initialize` 25; (3)
  `CDO Library - Payment Link.VerifyPaymentLinkTemplate` 4; (4)
  `CDO Email Editor Page Tests.CancelEmailConfirmHandler` 17; (5)
  `CDO Set Handled On Posted Test.EnableChangeLogModificationFor` 2.

## BaseApp (Microsoft BaseApp tests)

The WHOLE `Test` tree, no subset: 1,600 files, 1,486 codeunits, 89,987 procedures; 40,291 tests,
all walked, no parse errors. 17,098 tests carry `[HandlerFunctions]`; 549 event subscriber
procedures in the test app are never walked.

- Time: read 1.8 s, parse 10.2 s, walk 3.6 s. Peak RSS 2,597 MB, of which 1,523 MB was reached by
  the end of parsing; the walk's per-test sets and the counting maps add about 1 GB before the
  garbage collector catches up. Most of the parse-phase figure is `readTestAppSources` holding
  every file's text plus the Unit/Proc facts.
- Reach per test: p50 10, p90 27, max 78.
- Unfollowed edges: 40,035 tests (99.4%): codeunit outside the test app 40,025, of which named like
  a library 39,946 (99.1%); `BindSubscription` 5,008 (12.4%); `Codeunit.Run` 2,052 (5.1%); a
  procedure in a non-codeunit test-app object 46; interface dispatch 44.
- Most common targets: `Library - Test Initialize` 31,767, `Assert` 28,910,
  `Library - ERM Country Data` 27,225, `Library - Random` 23,988,
  `Library - Variable Storage` 23,563, `Library - Inventory` 18,970, `Library - Utility` 18,621,
  `Library - Setup Storage` 18,066, `Library - Sales` 16,953, `Library - ERM` 14,763. These
  libraries live in a separate test-library app, not in this tree.
- Sharing, over 88,389 reached procedures: p50 1, p90 10, p99 70, max 5,734. Over the 48,098
  reached non-test procedures: p50 3, p90 19, p99 100, max 5,734.
- Top 10: `Library - Application Area.ClearApplicationAreaCache` 5,734,
  `Library - Application Area.DisableApplicationAreaSetup` 5,732,
  `Library - Application Area.CreateFoundationSetupForCurrentCompany` 3,197,
  `Library - Application Area.EnableFoundationSetupForCurrentCompany` 3,195,
  `Library - Application Area.EnableFoundationSetup` 3,194,
  `Library - Lower Permissions.PushPermissionSetInternal` 2,316,
  `Library - Lower Permissions.PushPermissionSet` 2,315,
  `Library - Lower Permissions.OnAfterPushPermissionSet` 2,315,
  `Library - Report Dataset.GetFileName` 1,526,
  `Library - Report Dataset.GetParametersFileName` 1,524.
- Edits: (1) `Library - Application Area.ClearApplicationAreaCache` 5,734; (2)
  `SCM Warehouse Management II.CreateItemTrackingLine` 19; (3)
  `ERM Dimension Purchase.CreateSalesOrderPurchasingCode` 3; (4)
  `Bank Pmt. Appl. Algorithm.MessageHandler` 125; (5)
  `WF Demo Purch Rtrn Order Appr..MessageHandlerValidateMessage` 2.

## sandbox-data-tests (control)

1 file, 1 codeunit, 73 procedures; 68 tests. No handlers, no subscribers.

- Reach per test: p50 1, p90 3, max 4.
- Unfollowed edges: 53 tests (77.9%), all calls into the app under test (`Data Ops` 10,
  `Data Filter Ops` 8, ...) plus `Library Assert` in 3 (the name rule also counts the app's own `Data Assert Ops`, giving 4 tests, 5.9%).
- Only 5 non-test procedures: `Data Tests.ClearRelated` 13, `Data Tests.AddRelated` 13,
  `Data Tests.ResetMain` 11, `Data Tests.DeleteMain` 4, `Data Tests.ResetTriggerProbe` 3. With so
  few helpers the p90 and median picks are the top of the list.

## Reading

- The distribution is very skewed. A median helper edit turns 2 to 4 tests new on every real
  suite, and a p90 edit 19 to 29, which at S=100 is a 2k to 3k extra-execution verify. The top of
  the tail is the problem: a shared setup helper turns 158 (DO), 406 (DC) or 5,734 (BaseApp) tests
  new, which at S=100 is 16k, 41k and 585k extra test executions. A reachable-set digest would
  need a cap or a refusal above some N, not only a digest change.
- The most-shared procedures are all set-up or permission helpers, not assertion helpers: the
  assertion libraries (`Assert`, `Library Assert`) and the Microsoft test libraries are OUTSIDE
  every one of these test apps. So on DC, DO and BaseApp, the "strengthen a shared assertion
  helper" case R371 describes is mostly invisible to a TEST-APP reachable digest too: 74% to 99% of
  tests reach a library in another app, and the walk stops there.
- Handlers matter: a handler edit turns 17 (DO), 44 (DC) and 125 (BaseApp) tests new; the product
  walk does not follow `[HandlerFunctions]` today, so a digest built on it unchanged would miss
  every one of them.
- Other unfollowed kinds are small but not zero: `BindSubscription` (subscribers of a bound
  codeunit, 6.1% of DO, 12.4% of BaseApp), `Codeunit.Run` (1.6% to 5.1%), with-statement
  receivers (13.9% of DC), interface dispatch (44 BaseApp tests).
- Cost of the walk is not the obstacle: under a second on DC and DO, 15.6 s on the whole of
  BaseApp. RAM is: 2.6 GB peak on BaseApp, most of it the source texts and parse facts that
  `planVerify` already holds today for the TestPage scan.

# r2 re-measure

Measured 2026-09-30, same worktree, after plan r1's rulings (C1 object parts, C2 fail closed and
subscribers, C3 dependencies, I4 with-receivers). Re-run, one process per suite:

```
bun scripts/r371-reach-measure/measure.ts <label> <test-dir> <symbol-packages-dir | ->
bun scripts/r371-reach-measure/deps.ts    <label> <test-dir> <symbol-packages-dir | ->
```

Symbol packages used: DO `U:/Git/do-rel2/Test/.alpackages` (20 packages); sandbox-data-tests
`U:/Git/LethAL-wt/lane-bugs/fixtures/sandbox-data-tests/.alpackages` (8 packages; the folder is
gitignored and absent in the r371 worktree, so the one in the lane-bugs worktree was read, read-only).
DC has no `.app` files anywhere under `U:/Git/DC` (both `.alpackages` folders are empty), and
BaseApp's Test tree has none, so on those two an object is EXTERNAL when the test app does not
declare it ("not in the test app" mode). BaseApp's tree is 35 test apps (35 `app.json`); as in r1
it is measured as one test app, so a call between two of its apps is FOLLOWED.

## Summary

"Fallback" is the share of tests with at least one UNFOLLOWED edge, which would take the broad
(whole-test-app) digest. "Relaxed" is the same with BindSubscription not counted as UNFOLLOWED,
since every subscriber codeunit is folded into every digest anyway (C2). It is shown for the
ruling; the strict figure is the one the rules as written produce.

"Procedure edit": each test-app procedure (and trigger) in turn, uniform. N = tests reaching it
(outside the fallback) + every fallback test, or every test when the procedure sits in a
subscriber codeunit. "Object edit": each test-app object in turn (a global, header or trigger
edit), N = tests reaching the object (outside the fallback) + every fallback test, or every test
for a subscriber codeunit.

| Suite | Tests | Fallback strict / relaxed | Subscriber share (procs / chars) | Procedure edit p50 / p90 / max, P(N>50), strict | same, relaxed | Object edit p50 / p90 / max, P(N>50), strict | same, relaxed | Peak RSS, time |
|---|---|---|---|---|---|---|---|---|
| DC | 1,301 | 3.3% (43) / 2.9% (38) | 6.0% / 2.9% | 44 / 71 / 1,301, 19.6% | 39 / 66 / 1,301, 15.9% | 51 / 284 / 1,301, 53.8% | 46 / 279 / 1,301, 42.8% | 290 MB, 0.8 s |
| DO | 1,287 | 6.9% (89) / 0.9% (11) | 9.9% / 9.8% | 90 / 199 / 1,287, 100% | 12 / 163 / 1,287, 10.9% | 107 / 1,287 / 1,287, 100% | 29 / 1,287 / 1,287, 22.1% | 671 MB, 0.6 s |
| BaseApp | 40,291 | 15.8% (6,382) / 3.9% (1,570) | 14.6% / 15.4% | 6,383 / 40,291 / 40,291, 100% | 1,571 / 40,291 / 40,291, 100% | 6,395 / 40,291 / 40,291, 100% | 1,587 / 40,291 / 40,291, 100% | 2,782 MB, 17.2 s |
| sandbox-data-tests | 68 | 0% / 0% | 0% / 0% | 1 / 1 / 13, 0% | same | 68 / 68 / 68, 100% (one object) | same | 591 MB, 0.4 s |

p99 is the "all tests" value on every real suite (the subscriber codeunits). Plainly: on DC one
ordinary procedure edit turns more than 50 tests new about one time in five (19.6%), and one
global/header/trigger edit about one time in two (53.8%). On DO the strict fallback alone is 89
tests, so every edit exceeds 50. On BaseApp every edit exceeds 50 under either definition.

## The classifier's cases (walk.ts)

FOLLOWED (the test keeps its reachable digest):

1. A bare call matching a procedure of the calling codeunit by name and argument count (every
   same-arity overload is walked).
2. `this.Name(...)` matching a procedure of the calling codeunit.
3. A member call on a variable (parameter, local, global, named return value, array element,
   chained return value, either side of a ternary) whose declared type is a test-app codeunit:
   every candidate codeunit by name or id; a matching procedure is walked; `.Run()` walks the
   codeunit's OnRun trigger; any other member (a built-in) reaches the object.
4. A handler named in `[HandlerFunctions(...)]` and found in the same codeunit.
5. `Codeunit.Run(Codeunit::X)` for a test-app codeunit X (its OnRun trigger is walked).
6. A member on a Record/Page/TestPage/Report/TestRequestPage/Query/XmlPort variable of a test-app
   object that is neither one of that object's declared procedures nor a trigger-capable call on
   an object with code (case 16): the object is reached. The same for `Page.Run(Page::X)` and the
   other object runs by name.
7. A bare call inside a `with` that its own codeunit does not declare, when every enclosing
   with-target is a declared variable of a known type: classified by cases 3, 6, 8 or 15 to 17 on
   those types (I4).

EXTERNAL (the test keeps its reachable digest; the dependency is covered by C3's package identity):

8. A member on a variable of a codeunit or other object the test app does not declare (and no
   test-app extension answers the member), when a dependency symbol package declares it by name
   or id (DO, sandbox). With no symbol packages (DC, BaseApp): whenever the test app does not
   declare it.
9. An object run by name (`Codeunit.Run(Codeunit::X)`, ...) of such an object.

Not a call edge (nothing to classify): a bare name outside any `with` with no procedure of that
name in its own codeunit (a built-in function: only a built-in compiles there); a method of a
built-in type (Text, JsonObject, an Enum value, ...); a member of an undeclared root name other
than an object run (Database, Session, ...; the same rule as the product scan); a Variant's own
`Is*` type tests; a RecordRef/FieldRef method that cannot run a trigger; a literal receiver.

UNFOLLOWED (the test takes the broad fallback):

10. BindSubscription/UnbindSubscription.
11. An object run by id or by variable (`Codeunit.Run(50100)`, `Codeunit.Run(Id)`, `PAGE.RUNMODAL(0, Rec)`).
12. Interface dispatch (any member on an Interface-typed receiver).
13. A Variant receiver, any member other than its `Is*` type tests.
14. A RecordRef/FieldRef call that can run a trigger (Insert, Modify, Delete, DeleteAll, ModifyAll, Validate, Rename).
15. A call to a procedure declared in a non-codeunit test-app object (table, page, report, extension): the walk does not enter those.
16. A trigger-capable call (record Insert/Modify/Delete/DeleteAll/ModifyAll/Validate/Rename; page or report Run/Open/Trap/SaveAs/Execute/Print) on a non-codeunit test-app object, or a test-app extension of one, whose code makes any call: its triggers are not walked.
17. An object declared nowhere visible: not in the test app and not in any dependency symbol package (symbols mode only).
18. A receiver expression of a shape the walk does not model.
19. A `with` target whose type is unknown (not a declared variable, or of an unmodelled shape).
20. A handler named in `[HandlerFunctions]` but not found in its codeunit.

Unfollowed kinds that fired, in tests (tests where it is the only kind):

| Kind | DC | DO | BaseApp |
|---|---|---|---|
| BindSubscription | 5 (5) | 78 (78) | 5,057 (4,812) |
| RecordRef/FieldRef trigger-capable | 32 (32) | 6 (6) | 1,054 (951) |
| object run by id or variable | 1 (1) | 0 | 320 (222) |
| trigger-capable call on a test-app object with code | 0 | 0 | 180 (33) |
| procedure in a non-codeunit test-app object | 5 (5) | 0 | 46 (1) |
| interface dispatch | 0 | 0 | 44 (44) |
| object declared nowhere visible | 0 | 5 (5) | n/a (no symbols) |

Most common targets: DC `RecordRef.DELETEALL` (32 tests), `"CDC Test Parameters Helper".AddParameter`
and `.GetParameterValue` (5 each, a test-app table's procedures); DO BindSubscription in
`CDO Events Tests` (23) and `CDO eDoc Batch Dispatch Tests` (21), `RecordRef.Modify` (6); BaseApp
BindSubscription in `Library - CRM Integration` (826) and `API Mock Events` (349), `FieldRef.Validate`
(772), `RecordRef.Insert` (363). DO's five "declared nowhere visible" are all calls on codeunit
`CDO Set Handled On Posted Docs`: the app's source under `U:/Git/do-rel2/Cloud` declares it, the
local symbol package (Continia Document Output 28.4.0.333577) does not. That is a stale local symbol
package, and failing closed did what it should.

A first r2 run counted a Variant's `Is*` calls as UNFOLLOWED; that put 1,362 BaseApp tests on the
fallback (`ExpectedValue.IsDecimal` and its siblings in 1,258). They are type tests, not calls, so
case 13 now excludes them. `output.txt` holds only the corrected run.

## With-receivers (I4)

Bare-call sites inside a `with` that their own codeunit does not declare (the only sites where the
with-target decides the callee): DC 7, all 7 resolve through the target's declared type. DO,
BaseApp and sandbox-data-tests have none. r1's "181 DC tests with a with-statement receiver" were
these 7 sites reached by 181 tests. No with-edge is left UNFOLLOWED on any suite.

## Subscribers (C2)

| Suite | Subscriber codeunits (manual / automatic) | [EventSubscriber] procedures | Codeunits named in BindSubscription (holding subscribers) | Procedures in subscriber codeunits | Chars in subscriber codeunits |
|---|---|---|---|---|---|
| DC | 8 (3 / 5) | 17 | 2 (2) | 199 of 3,311 (6.0%) | 2.9% |
| DO | 13 (11 / 2) | 31 | 11 (11) | 169 of 1,703 (9.9%) | 9.8% |
| BaseApp | 176 (168 / 8) | 549 | 157 (154) | 13,384 of 91,474 (14.6%) | 15.4% |
| sandbox-data-tests | 0 | 0 | 0 | 0 | 0 |

The procedure share is the chance a uniformly random procedure edit touches a subscriber codeunit
and so turns EVERY test new. Manual binding is read from `EventSubscriberInstance = Manual` in the
codeunit text. The whole codeunit is counted, since the ruling folds whole subscriber codeunits
in, and many of these are TEST codeunits that bind themselves as subscribers.

## Object parts (C1)

Reached objects per test (codeunits plus non-codeunit test-app objects, including the test's own
codeunit): DC avg 4.2 (p50 4, p90 8, max 12); DO avg 1.9 (1 / 4 / 9); BaseApp avg 1.5 (1 / 2 / 7);
sandbox-data-tests 1.0.

Tests reaching an object: DC p50 10, p90 184, p99 412, max 486 (`CDC Library - DC Document`; a
test-app tableextension `CDC Vendor Test` is reached by 412); DO 16 / 46 / 229 / 229
(`CDO Library - Setup`); BaseApp 17 / 79 / 279 / 5,738 (`Library - Application Area`).

The five r1 edits, re-picked on the r2 walk, as a procedure edit and as a global/header/trigger edit
to the same procedure's object (all tests, before the fallback and subscribers are added):

| Suite | Edit | Procedure | Procedure level | Object level |
|---|---|---|---|---|
| DC | 1 | CDC Library - Permission.ResetPermissionLogging | 406 | 406 |
| DC | 2 | CDC Match (Test).AdjustRefDocument | 29 | 34 |
| DC | 3 | CDC Test Field Trans (Test).CreateTemplateFieldBasedOnTranslation | 4 | 8 |
| DC | 4 | CDC Storage Models.NotificationHandler | 44 | 54 |
| DC | 5 | CDC Register (Test).PurchaserTranslationModalPageHandler | 4 | 59 |
| DO | 1 | CDO Library - Setup.InitializeCDOSetup | 158 | 229 |
| DO | 2 | CDO Email Template Mgt Tests.Initialize | 25 | 25 |
| DO | 3 | CDO MergeFieldFinder Tests.CreateSalesperson | 4 | 21 |
| DO | 4 | CDO Email Editor Page Tests.CancelEmailConfirmHandler | 17 | 18 |
| DO | 5 | CDO Set Handled On Posted Test.EnableChangeLogModificationFor | 2 | 5 |
| BaseApp | 1 | Library - Application Area.ClearApplicationAreaCache | 5,734 | 5,738 |
| BaseApp | 2 | SCM Warehouse Management II.ItemTrackingLinesPageHandler | 19 | 92 |
| BaseApp | 3 | ERM Dimension Priority.CreateServiceContract | 3 | 32 |
| BaseApp | 4 | Bank Pmt. Appl. Algorithm.MessageHandler | 125 | 148 |
| BaseApp | 5 | WF Demo Purch Rtrn Order Appr..MessageHandlerValidateMessage | 2 | 12 |
| sandbox | 1-3, 5 | Data Tests.AddRelated / ResetMain | 13 / 11 | 68 |

An object-level edit to a TEST codeunit turns every test in it new, which is why the object column
grows most for helpers that live in test codeunits (edits 3 and 5).

## Dependencies (C3)

Sizes are the local `.app` files in the symbol-packages folder: a PROXY for what bcdev would
download per run, not a measured download.

**DC** (`Test/app.json`; implicit `application` 26.0.0.0 and `platform` 26.0.0.0). Non-Microsoft,
all Continia Software 27.x: Continia Approvals, Continia Business Foundation, Continia Connector
App, Continia Core, Continia Core Internal Activation App, Continia Core SMTP Connector, Continia
Delivery Network, Continia Document Capture, Continia Online Connector, Continia System
Application (10). Microsoft 23.0.0.0: Any, Email - SMTP API, Library Assert, Library Variable
Storage, Permissions Mock, System Application Test Library, Test Runner, Tests-TestLibraries (8).
No local packages, so no transitive closure and no sizes. Ids are in `output.txt`.

**DO** (`Test/app.json`; implicit `application`/`platform` 28.0.0.0). Closure over the 20 local
packages, all 20 in it:

| Publisher | Name | Version | Direct / transitive | Bytes |
|---|---|---|---|---|
| Continia Software | Continia Document Output | 28.4.0.333577 | direct | 8,248,067 |
| Continia Software | Continia Delivery Network | 28.4.0.334646 | direct | 3,847,269 |
| Continia Software | Continia Core | 28.4.0.302270 | direct | 2,346,272 |
| Continia Software | Continia System Application | 28.4.0.305675 | direct | 235,859 |
| Continia Software | Continia Connector App | 28.4.0.305675 | transitive | 55,856 |
| Continia Software | Continia Core Internal Activation App | 28.0.0.218906 | direct | 29,071 |
| Microsoft | Base Application | 28.0.46665.48632 | transitive | 46,321,577 |
| Microsoft | System Application | 28.0.46665.48632 | transitive | 15,985,079 |
| Microsoft | System | 28.0.48590.0 | transitive | 4,343,823 |
| Microsoft | Business Foundation | 28.0.46665.48632 | transitive | 477,026 |
| Microsoft | Application Test Library | 28.0.46665.48632 | transitive | 322,118 |
| Microsoft | Tests-TestLibraries | 28.0.46665.48632 | direct | 308,273 |
| Microsoft | System Application Test Library | 28.0.46665.48632 | direct | 191,513 |
| Microsoft | Test Runner | 28.0.46665.48632 | direct | 109,508 |
| Microsoft | Library Assert | 28.0.46665.48632 | direct | 24,209 |
| Microsoft | Library Variable Storage | 28.0.46665.48632 | transitive | 21,997 |
| Microsoft | Any | 28.0.46665.48632 | direct | 21,843 |
| Microsoft | Business Foundation Test Libraries | 28.0.46665.48632 | transitive | 21,496 |
| Microsoft | Permissions Mock | 28.0.46665.48632 | direct | 20,904 |
| Microsoft | Application | 28.0.46665.48632 | transitive | 18,903 |

Non-Microsoft total 14.1 MB (6 packages), Microsoft 65.0 MB (14). Read and SHA-256 one at a time,
in a fresh process: the six non-Microsoft ones 9 ms, RSS 74 MB at start and 89 MB peak; all 20,
53 ms, 74 to 131 MB. Under C3 only the six non-Microsoft ones are hashed.

**BaseApp** (35 `app.json`; versions are build-template tokens such as `$(app_minimumVersion)`),
all Microsoft: Any (5 apps), Application Test Library (2), Business Foundation Test Libraries (12),
Library Assert (8), Library Variable Storage (31), Permissions Mock (2), System Application Test
Library (25), Tests-TestLibraries (32, itself one of the apps in this tree). No non-Microsoft
dependency, no local packages.

**sandbox-data-tests**: LethAL Sandbox Data 1.0.0.10 (non-Microsoft, the app under test, 55,571
bytes), Library Assert 28.0.46665.49944 (23,982), and System 28.0.50283.0 (633,034, transitive
through the app's `Platform`). Read and SHA-256: 0 ms, RSS 74 to 75 MB.

## RSS and time

| Suite | Symbols | Parse | Walk | Peak RSS (after symbols / after parse) |
|---|---|---|---|---|
| DC | none | 0.5 s | 0.3 s | 290 MB (88 / 209) |
| DO | 0.4 s | 0.2 s | 0.1 s | 671 MB (592 / 644) |
| BaseApp | none | 11.3 s | 5.9 s | 2,782 MB (89 / 1,588) |
| sandbox-data-tests | 0.4 s | 0.0 s | 0.0 s | 591 MB (579 / 588) |

Reading the dependency symbol packages to classify EXTERNAL positively costs about 500 MB, almost
all of it Base Application's `SymbolReference.json` (parsed one package at a time, names kept).

## Reading (r2)

- Failing closed costs little on DC (3.3% of tests on the fallback) and a lot on BaseApp (15.8%).
  On DO the fallback is almost entirely BindSubscription (78 of 89). If BindSubscription stops
  counting as UNFOLLOWED because subscriber codeunits are already in every digest, DO falls to
  0.9% and BaseApp to 3.9%.
- The subscriber rule is the larger cost. 6% (DC), 10% (DO) and 15% (BaseApp) of procedure edits
  land in a subscriber codeunit and turn EVERY test new. That alone sets p99 to "all tests" on
  every real suite.
- On DC, routine edits still exceed the cap of 50: one procedure edit in five (19.6%, strict), and
  one object-level edit in two (53.8%). On DO every edit exceeds 50 under the strict rule (10.9%
  relaxed). On BaseApp every edit exceeds 50 under either rule, because the fallback alone is
  1,570 to 6,382 tests.
- Object-level digests (C1) add few objects per test (1.5 to 4.2), but an edit to a test
  codeunit's globals or header turns all of its tests new, which drives the object column's p90.
