# BC.History on al-runner v3: what has run, what is left, what is blocked (R-962, 2026-11-13; final tally R-969, 2026-11-14)

## Final tally (R-969, 2026-11-14)

| state | test projects | [Test] methods |
|---|---:|---:|
| run on v3 | 143 | 7,866 |
| not run, runnable | 0 | 0 |
| not run, blocked | 33 | 40,993 |

**BC.History outside BaseApp is done.** R-969 ran the 54 projects the table "Not run, runnable" below lists (pre-commitment
076381b1, al-runner edge-c8fe56e05), so every test project outside BaseApp has now run on v3. What is left is blocked:
- **BaseApp's 32 `Tests-*` slices, 40,980 tests (99.97% of the tests not run):** they test Base Application itself, which al-runner
  cannot compile today (upstream #7920 and #7914). The hunt moves there once those are fixed, or to other corpora.
- **OnPrem Permissions (13 tests):** its app holds only permission sets; there is nothing to mutate.

Three runs stopped at their hour and can be resumed: Email (1,632 of 3,934 mutants left out), E-Document Connector - Avalara (781 of
1,785) and E-Document Connector - SignUp (107 of 710). The tables below are as R-962 measured them; the 54 "runnable" rows are the
ones R-969 ran.

Coord task R-962. Names and counts only, no source text. Regenerate with `/coord/handoff/R-962/inventory.py` (inputs in the same
folder); batches that run later should mark their projects there.

## Method

- **Test projects.** Every `app.json` under `/work/src/BC.History` with at least one `[Test]` in its own folder (nested projects
  not counted twice): 176 (`corpus.py`).
- **Run on v3.** A test project counts as run when an al-runner-v3 report sits in a handoff folder that holds a copy of it (by app
  name, `ran.py`), or when a batch pre-commitment names it (R-915's four large apps, R-882's Service Declaration). R-882..R-964.
- **Runnable.** A fresh hunt over every not-run project outside BaseApp's `Tests-*`, with its dependency closure (230 projects,
  R-927's driver, the Windows BC 28.4 service folder as probing path): every one of them, and every app they test, builds and
  instruments (the hunt's own selector-id pick clashed with a dependency's codeunit for nine; a run takes ids from the spare range
  1999990000-1999990010 instead, as batch 10 did). The closure is cached as `bch-notrun-closure@d9fad4a0933b+25661207`, so a batch
  from this list needs no pool build.
- **Blocked.** BaseApp's 32 `Tests-*` slices test Base Application itself, which al-runner cannot compile today (upstream #7920 and
  #7914); OnPrem Permissions' app holds only permission sets, so there is nothing to mutate.

## Summary (after batches 10 and 11)

| state | test projects | [Test] methods |
|---|---:|---:|
| run on v3 | 89 | 7,515 |
| not run, runnable | 54 | 351 |
| not run, blocked | 33 | 40,993 |

**BC.History outside BaseApp is nearly used up.** The 54 runnable projects left hold 351 tests between them, most of them small
System Application modules (median 6 tests); two or three more batches would cover them all, at a far lower yield of findings per
run than the batches so far. 99.1% of the tests not yet run (40,980 of 41,344) sit in BaseApp's `Tests-*` slices and wait on #7920
and #7914. Two runs stopped at their hour and can be resumed: Email (1,632 of 3,934 mutants left out) and E-Document Connector -
Avalara (781 of 1,785; its serve warm-up fell back to one-shot, upstream #8001 item 3).

## Not run, runnable (54)

| test project | [Test] | note |
|---|---|---|
| EDocumentConnectors/B2Brouter/Test/E-Document Connector - B2Brouter Tests | 20 | spare-range selector ids (R888) |
| BankAccRecWithAI/Test/Bank Account Reconciliation With AI Tests | 15 |  |
| System Application/Test/System Application Test/Azure AD Graph | 15 | #7934 (MockGraphQuery) expected |
| System Application/Test/System Application Test/Cues and KPIs | 15 |  |
| System Application/Test/System Application Test/Azure AD Licensing | 13 | #7934 (MockGraphQuery) expected |
| System Application/Test/System Application Test/Business Chart | 13 |  |
| System Application/Test/System Application Test/Date and Time | 12 |  |
| System Application/Test/System Application Test/Geolocation | 11 |  |
| System Application/Test/System Application Test/Tenant License State | 11 |  |
| TestFramework/performancetoolkit/Performance Toolkit Tests | 11 |  |
| EDocumentConnectors/Logiq/Test/E-Document Connector - Logiq Tests | 10 |  |
| System Application/Test/System Application Test/Record Link Management | 9 |  |
| System Application/Test/System Application Test/XmlWriter | 9 |  |
| Email - Microsoft 365 Connector/Test/Email - Microsoft 365 Connector Tests | 8 |  |
| System Application/Test/System Application Partner Test/AI | 8 |  |
| System Application/Test/System Application Test/Azure Key Vault | 8 |  |
| System Application/Test/System Application Test/System Initialization | 8 |  |
| System Application/Test/System Application Test/User Selection | 8 |  |
| DataArchive/Test/Data Archive Tests | 7 |  |
| System Application/Test/System Application Test/User Login Times | 7 |  |
| ContosoCoffeeDemoDataset/Test/Contoso Coffee Demo Dataset Tests | 6 | spare-range selector ids (R888) |
| EDocumentConnectors/SignUp/Test/E-Document Connector - SignUp Tests | 6 |  |
| Email - Outlook REST API/Test/Library Outlook REST API | 6 |  |
| RecommendedApps/Test/Recommended Apps Tests | 6 |  |
| System Application/Test/System Application Test/Environment Information | 6 | spare-range selector ids (R888) |
| System Application/Test/System Application Test/Record Selection | 6 |  |
| System Application/Test/System Application Test/Secrets | 6 |  |
| System Application/Test/System Application Test/XML Validation | 6 |  |
| TestFramework/performancetoolkit/Performance Toolkit Samples | 6 |  |
| EDocumentConnectors/ForNAV/Test/E-Document Connector - ForNAV Tests | 5 |  |
| System Application/Test/System Application Test/Auto Format | 5 |  |
| System Application/Test/System Application Test/Filter Tokens | 5 |  |
| System Application/Test/System Application Test/Headlines | 5 |  |
| System Application/Test/System Application Test/Time Zone Selection | 5 |  |
| Email - Current User Connector/Test/Email - Current User Connector Tests | 4 | spare-range selector ids (R888) |
| System Application/Test/System Application Test/Confirm Management | 4 |  |
| System Application/Test/System Application Test/Date-Time Dialog | 4 |  |
| System Application/Test/System Application Test/Field Selection | 4 |  |
| System Application/Test/System Application Test/Page Action Provider | 4 |  |
| System Application/Test/System Application Test/Vs Code Integration | 4 |  |
| SustainabilityCopilotSuggestion/Test/Sustainability Copilot Tests | 3 |  |
| System Application/Test/System Application Test/Camera and Media Interaction | 3 |  |
| System Application/Test/System Application Test/Caption Class | 3 |  |
| System Application/Test/System Application Test/Client Type Management | 3 |  |
| System Application/Test/System Application Test/Encoding | 3 |  |
| EDocumentConnectors/Pagero/Test/E-Document Connector - Pagero Tests | 2 |  |
| System Application/Test/System Application Test/Advanced Settings | 2 |  |
| System Application/Test/System Application Test/Azure Storage Services Authorization | 2 |  |
| System Application/Test/System Application Test/Navigation Bar Subscribers | 2 |  |
| System Application/Test/System Application Test/SharePoint Authorization | 2 |  |
| System Application/Test/System Application Test/Video | 2 |  |
| BusinessFoundation/Test/Business Foundation Tests/NoSeriesCopilot | 1 | spare-range selector ids (R888) |
| ExternalEvents/test/_Exclude_Business_Events_Test | 1 |  |
| System Application/Test/System Application Test/User Details | 1 |  |

## Not run, blocked (33)

All 32 BaseApp slices are blocked by the same cause: they test Base Application itself (upstream #7920 and #7914).

| test project | [Test] |
|---|---:|
| BaseApp/Test/Tests-ERM | 9,597 |
| BaseApp/Test/Tests-SCM | 8,633 |
| BaseApp/Test/Tests-Misc | 3,219 |
| BaseApp/Test/Tests-SCM-Service | 1,937 |
| BaseApp/Test/Tests-SCM-Assembly | 1,777 |
| BaseApp/Test/Tests-Job | 1,308 |
| BaseApp/Test/Tests-SCM-Manufacturing | 1,233 |
| BaseApp/Test/Tests-VAT | 1,231 |
| BaseApp/Test/Tests-Workflow | 1,073 |
| BaseApp/Test/Tests-SMB | 1,028 |
| BaseApp/Test/Tests-CRM integration | 987 |
| BaseApp/Test/Tests-Dimension | 982 |
| BaseApp/Test/Tests-SINGLESERVER | 887 |
| BaseApp/Test/Tests-General Journal | 831 |
| BaseApp/Test/Tests-Marketing | 736 |
| BaseApp/Test/Tests-Report | 713 |
| BaseApp/Test/Tests-Bank | 671 |
| BaseApp/Test/Tests-Prepayment | 579 |
| BaseApp/Test/Tests-Cost Accounting | 565 |
| BaseApp/Test/Tests-Fixed Asset | 460 |
| BaseApp/Test/Tests-Cash Flow | 401 |
| BaseApp/Test/Tests-Data Exchange | 399 |
| BaseApp/Test/Tests-Rapid Start | 387 |
| BaseApp/Test/Tests-Resource | 355 |
| BaseApp/Test/Tests-Integration | 340 |
| BaseApp/Test/Tests-Reverse | 198 |
| BaseApp/Test/Tests-Physical Inventory | 157 |
| BaseApp/Test/Tests-Permissions | 112 |
| BaseApp/Test/Tests-Graph | 77 |
| BaseApp/Test/Tests-User | 73 |
| BaseApp/Test/Tests-Monitor Sensitive Fields | 19 |
| BaseApp/Test/Tests-Upgrade | 15 |

And `Onprem Permissions/Test/OnPrem Permissions Tests` (13 tests): its app holds only permission sets, nothing to mutate.

## Run on v3 (89)

| test project | [Test] | task |
|---|---|---|
| APIV2/Test/_Exclude_APIV2_ Tests | 771 | R-962 |
| Quality Management/Test/Quality Management-Tests | 747 | R-915 |
| SubscriptionBilling/Test/Subscription Billing Tests | 727 | R-915 |
| Sustainability/Test/Sustainability Tests | 526 | R-925 |
| APIV1/Test/_Exclude_APIV1_ Tests | 478 | R-964 |
| Shopify/test/Shopify Connector Test | 384 | R-915 |
| EDocument Core/Test/E-Document Core Tests | 329 | R-915 |
| Subcontracting/Test/Subcontracting-Tests | 231 | R-914 |
| System Application/Test/System Application Test/Email | 226 | R-962 (1,632 of 3,934 mutants left out at the hour) |
| PEPPOL/Test/PEPPOL Tests | 151 | R-913 |
| EDocumentConnectors/Avalara/Test/E-Document Connector - Avalara Tests | 149 | R-962 (781 of 1,785 left out at the hour) |
| PowerBIReports/Test/PowerBI Reports Tests | 118 | R-962 |
| System Application/Test/System Application Test/Guided Experience | 115 | R-932 |
| System Application/Test/System Application Test/Retention Policy | 113 | R-928 |
| Intrastat/Test/Intrastat Core Tests | 111 | R-902 |
| SalesLinesSuggestions/Test/Sales Lines Suggestions Tests | 104 | R-927 |
| BusinessFoundation/Test/Business Foundation Tests/NoSeries | 90 | R-962 |
| VATGroupManagement/Test/VAT Group Management Tests | 83 | R-902, R-911 |
| BankDeposits/Test/_Exclude_Bank Deposits Tests | 75 | R-911 |
| EDocumentConnectors/Continia/Test/E-Document Connector - Continia Tests | 74 | R-964 |
| System Application/Test/System Application Test/Barcode | 73 | R-962 |
| System Application/Test/System Application Test/SharePoint | 71 | R-928 |
| Withholding Tax/Test/Withholding Tax Tests | 71 | R-914 |
| System Application/Test/System Application Test/Cryptography Management | 68 | R-932, R-953 |
| ServiceDeclaration/Test/Service Declaration Tests | 61 | R-882 |
| System Application/Test/System Application Test/URI | 61 | R-940 |
| Email - SMTP Connector/Test/Email - SMTP Connector Tests | 60 | R-925, R-927 |
| System Application/Test/System Application Test/AI | 58 | R-940 |
| System Application/Test/System Application Test/MCP | 58 | R-928 |
| FieldServiceIntegration/Test/Field Service Integration Test | 55 | R-925 |
| EnforcedDigitalVouchers/Test/Enforced Digital Vouchers Tests | 50 | R-913 |
| System Application/Test/System Application Test/Rest Client | 50 | R-928 |
| System Application/Test/System Application Test/Data Classification | 38 | R-962 |
| ExcelReports/Test/Dynamics BC Excel Reports Tests | 36 | R-925 |
| PaymentPractices/Test/Payment Practices Tests | 36 | R-881, R-911 |
| System Application/Test/System Application Test/Record Reference | 33 | R-940 |
| System Application/Test/System Application Test/Azure AD Plan | 32 | R-928 |
| System Application/Test/System Application Test/Word Templates | 32 | R-962 |
| PlanConfiguration/Test/_Exclude_PlanConfiguration_ Tests | 31 | R-964 |
| System Application/Test/System Application Test/MicrosoftGraph | 31 | R-932 |
| System Application/Test/System Application Test/BLOB Storage | 30 | R-940 |
| System Application/Test/System Application Test/Performance Profiler | 30 | R-928 |
| System Application/Test/System Application Test/Permission Sets | 30 | R-932 |
| PayPalPaymentsStandard/Test/PayPal Payments Standard Tests | 29 | R-913 |
| System Application/Test/System Application Test/Recurrence Schedule | 29 | R-964 |
| SalesAndInventoryForecast/Test/Sales and Inventory Forecast Tests | 28 | R-925 |
| System Application/Test/System Application Test/External File Storage | 28 | R-928, R-940 |
| SAF-T/Test/SAF-T Tests | 27 | R-914, R-926 |
| System Application/Test/System Application Test/Language | 27 | R-932 |
| System Application/Test/System Application Test/Extension Management | 26 | R-932 |
| System Application/Test/System Application Test/Image | 26 | R-964 |
| MasterDataManagement/Test/_Exclude_Master_Data_Management_Tests | 24 | R-914 |
| System Application/Test/System Application Test/Azure AD User Management | 24 | R-953 |
| System Application/Test/System Application Test/Edit in Excel | 23 | R-932 |
| System Application/Test/System Application Test/Pdf | 23 | R-964 |
| System Application/Test/System Application Test/Password | 22 | R-940 |
| System Application/Test/System Application Test/Azure AD User | 21 | R-964 |
| System Application/Test/System Application Test/Data Administration | 21 | R-964 |
| ErrorMessagesWithRecommendations/Test/Error Messages with Recommendations Tests | 20 | R-913 |
| System Application/Test/System Application Test/Azure Blob Services API | 20 | R-932 |
| System Application/Test/System Application Test/Feature Key | 19 | R-953 |
| System Application/Test/System Application Test/Page Summary Provider | 19 | R-940 |
| System Application/Test/System Application Test/Security Groups | 19 | R-940 |
| System Application/Test/System Application Test/User Permissions | 19 | R-961 |
| EssentialBusinessHeadlines/Test/Essential Business Headlines Test | 18 | R-925 |
| StatisticalAccounts/Test/Statistical Accounts Tests | 18 | R-902 |
| System Application/Test/System Application Test/Json | 18 | R-953 |
| System Application/Test/System Application Test/Regex | 18 | R-953 |
| System Application/Test/System Application Test/Translation | 18 | R-953 |
| System Application/Test/System Application Test/Document Sharing | 17 | R-961 |
| System Application/Test/System Application Test/Privacy Notice | 16 | R-953 |
| System Application/Test/System Application Test/Web Service Management | 16 | R-953 |
| DataSearch/Test/Data Search Tests | 14 | R-913 |
| EU3PartyTradePurchase/test/EU 3-Party Trade Purchase Tests | 14 | R-902 |
| EmailLogging/Test/_Exclude_Email Logging Using Graph API Tests | 14 | R-914 |
| System Application/Test/System Application Test/SFTP Client | 14 | R-953 |
| LatePaymentPredictor/Test/Late Payment Prediction Tests | 13 | R-925 |
| System Application/Test/System Application Test/Base64 Convert | 13 | R-961 |
| System Application/Test/System Application Test/User Settings | 13 | R-961 |
| ExciseTaxes/Test/Excise Taxes Tests | 12 | R-913 |
| ReviewGLEntries/Test/_Exclude_Review_General_Ledger_Entries_Tests | 12 | R-925 |
| System Application/Test/System Application Test/Upgrade Tags | 12 | R-961 |
| System Application/Test/System Application Test/Azure File Services API | 11 | R-940 |
| System Application/Test/System Application Test/Data Compression | 10 | R-961 |
| System Application/Test/System Application Test/Telemetry | 9 | R-961 |
| AuditFileExport/Test/Audit File Export Tests | 7 | R-913 |
| System Application/Test/System Application Test/AppSource Gallery | 7 | R-961 |
| SimplifiedBankStatementImport/Test/Simplified Bank Statement Import Test | 6 | R-902 |
| Email - SMTP API/Test/Email - SMTP API Tests | 4 | R-927 |
