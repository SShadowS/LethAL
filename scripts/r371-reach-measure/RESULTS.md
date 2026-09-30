# R-371: how many tests a reachable-set digest turns new per helper edit

Measured 2026-09-30, offline, on master 4491a866 (branch lethal/r371). Raw output: `output.txt`.
Re-run: `bun scripts/r371-reach-measure/measure.ts <label> <test-dir>`, one process per suite.

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
