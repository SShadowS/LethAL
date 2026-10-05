# R-464 plan (r5: Opus r4 review fixes; on R-473; ready for review)

Base: master **1b149422** (R-473 merged on top of 34ddb963; IDENTITY_SCHEME 21). **R-464 takes
21 -> 22**, and lands after R-473. Worktree /work/lethal-wt/r464 (lethal/r464) merged to 1b149422,
parser rebuilt; no product change yet. The prototype is 1b149422 plus the same 3 files
(`/coord/handoff/R-464/scratch-copy/proto/`).

## r5 changes (Opus review of r4)
1. **Names in a comma-separated declaration list.** The `name :` scan now also matches the name
   followed by any `, <identifier>` run and then a single `:` (never `:=`, never `::`):
   `Rec, Dummy: Record U2`. Synthetic `syn/src/Sol4.al`, red first:
   - Opus's exact case (a procedure-local `#if CLEAN Rec, Dummy: Record U2; #endif`) was ALREADY
     refused by r4, through the index (`declaration-unknown`: the local is an ambiguous `#if` name).
   - The case only the text scan sees: an OBJECT-level `#if CLEAN var Rec, Dummy: Record U5;
     #endif` in table T6, then `Validate(Amount, 4)`: r4 emits `Rec.Amount := 4`; r5 refuses.
   - Controls: table T7 with a plain global `Dummy` emits `Rec.Amount := 5`; a call argument list
     `TransferLike(Q, Q)` does not trip the scan (`Q.Amount := 3` still emitted).
2. **`identifierTokens` uses `maskAlNonCode`** (strings kept, as before), instead of its regex
   comment strip. Corpus effect: none (see deltas).
3. **A table procedure named like the prefix refuses**, like a field: `procedure\s+<name>\s*\(` in
   the table or any project tableextension of it (same masked text scan). Not measured with alc,
   by ruling. Synthetic: `with R do begin Validate(Amount, 2)` where R's table W5 declares
   `procedure R(): Integer`: r4 emits `R.Amount := 2`; r5 refuses.
4. **Evidence ceiling stated:** the scan does not see subscribers to the GLOBAL trigger events
   (`OnDatabaseInsert` and the like on codeunit "Global Triggers"/"GlobalTriggerManagement") or any
   subscriber in a dependency app or a dependent app.
5. **(r5b, Opus) `#` lines inside a declaration list.** The `name :` scan now also blanks every
   line starting with `#` after masking, so `var Rec,` / `#if CLEAN` / `Other,` / `#endif` /
   `Dummy: Record U5;` still matches (all arms read together, which can only add refusals).
   Synthetic `Sol4.al` table T8 is red first. The list is wrapped in an outer `#if OUTER` so the
   index cannot see it: r5 emits `Rec.Amount := 6`; r5b refuses (`declaration-unknown`).
   **Site diff not re-run, because this fix cannot move a corpus site.** It only adds refusals,
   and only where a comma list contains a `#` line and ends in `name :`. A multi-line search of
   every corpus (BC.History, CDO, fixtures, examples) for an identifier and a comma followed by a
   `#` line finds 40 files. All 40 are permission lists (`tabledata X = rm,`) in permission sets,
   enums or `Permissions` properties. None of them ends a run in a single `:`, so none can match.
Prototype unit tests (engine, tier 1, tier 2) on 1b149422: 1,124 pass, 0 fail.

**Deltas r5 vs r4** (exact site diff on 1b149422, 95 labels, 0 exceptions):
- Mutant set: none. Tier-2 specs added 3,928, validate-to-assign removed 29, flips ceded 250 (all
  250 paired with a swap-modify-flag spec at the same call), 0 orphans, 13 retags (12 dropped, 1
  added), hang rows 0, fixtures unchanged. The r5 refusals (fixes 1 and 3) cost 0 corpus sites.
- What R-473 changes in R-464's picture: on the new base, 231 of the 250 ceded flips carry R-473's
  new skip tag (they sat on receivers that were unresolved before R-464). Section "R-473 rows" below.

## R-473 rows that R-464 changes (row by row)
Every R-473 row R-464 touches is a sole-argument `Rec.Modify/Delete/Insert(true)` flip on a
receiver R-464 now resolves (page `Rec`, TableNo `OnRun` `Rec`, dataitem). R-464 resolves it, so
flip-boolean-literal CEDES the literal (R-459's `claimedRunTriggerSkip`) and swap-modify-flag
emits `...(false)` at the same call, tagged by its proof-based predicate
(`modifySkipCanRaise` / `deleteSkipCanRaise` / `insertSkipCanRaise`), as for any resolved
receiver. No R-473 row is retagged in place, and none is removed without a replacement.

| R-473 tag before | swap-modify-flag after | rows |
| --- | --- | --- |
| run-trigger-skipped-modify | run-trigger-skipped-modify | 144 |
| run-trigger-skipped-modify | untagged (skip proven harmless) | 12 |
| run-trigger-skipped-insert | run-trigger-skipped-insert | 39 |
| run-trigger-skipped-insert | untagged | 19 |
| run-trigger-skipped-delete | run-trigger-skipped-delete | 15 |
| run-trigger-skipped-delete | untagged | 2 |
| **total** | | **231** (BaseApp 113, CDO 1, other BC.History 117) |

All 231 rows, one per line (site, call, tag before, tag after):
`/coord/handoff/R-464/scratch-copy/r473rows.txt`. The 33 rows whose tag goes away:
- BaseApp, Insert, untagged after: BookingSyncSetup.Page :317; OfficeAdminCredentials.Page :139;
  PurchaseDocumentLineEntity.Page :980; SalesDocumentLineEntity.Page :951;
  AzureADAppSetupPart.Page :87; JobCreationWizard.Page :254; SalesQuote.Page :1237, :1286;
  CustomerReportSelections.Page :169; WorkflowEventConditions.Page :205;
  DocExchServiceSetup.Page :363; OCRServiceSetup.Page :343.
- CDO: Page 6175468 CDO Output Profile Conflicts :58 `Rec.Modify(true)`.
- AuditFileExport: AuditFileExportErrorHandl.Codeunit :21 Modify.
- EDocumentConnectors: LogiqConnectionSetup.Page :95 Insert.
- EDocument Core: EDocDeferralMatching :63, EDocGLAccountMatching :67, EDocHistoricalMatching :83
  (Modify).
- Intrastat: IntrastatReportSetupWizard.Page :236, :254 (Delete).
- PayPalPaymentsStandard: MSPayPalStandardSettings.Page :88 Insert.
- Quality Management: QltyInspectionGenRules.Page :74 Insert.
- SubscriptionBilling: UsageDataImportAPI.Page :41 Insert; CreateCustSubContract :15,
  CreateSubContractLine :15, CreateSubscriptionHeader :16, CreateSubscriptionLine :15 (Modify);
  ItemServCommitmentPackages.Page :114 Insert.
- System Application: CopilotCapEarlyPreview.Page :103, CopilotCapabilitiesGA.Page :103,
  CopilotCapabilitiesPreview.Page :103 (Modify).
- TestFramework: BCPTLines.Page :194 Insert.
- VATGroupManagement: VATGroupSubmissionLines.page :74 Insert.
These go through the same predicate as every resolved receiver; R-473's tag was the conservative
answer for an UNRESOLVED receiver (R-364's rule), which these no longer are.

### Evidence for the 33 untagged rows (r5b)
Same scans as the 12 (`evidence.ts`, masked text plus AST, every `#if` arm counted), run per corpus
by `ev33.sh`; output `/coord/handoff/R-464/scratch-copy/evidence33.txt`. **Tables NOT declared in
the project: 0** (every receiver table resolved and its triggers were read).

Modify and Delete, 14 rows: all clean. The trigger at stake is absent, and there is no
tableextension and no subscriber of the table in the project.

| site | call | table | trigger at stake | ext / subscribers |
| --- | --- | --- | --- | --- |
| CDO Page 6175468 :58 | Modify | CDO Output Profile Conflict | OnModify: none | none |
| AuditFileExportErrorHandl :21 | Modify | Audit File Export Line | OnModify: none (OnDelete only) | none |
| EDocDeferralMatching :63, EDocGLAccountMatching :67, EDocHistoricalMatching :83 | Modify | E-Document Purchase Line | OnModify: none (OnDelete only) | none |
| CreateCustSubContract :15 | Modify | Imported Cust. Sub. Contract | none | none |
| CreateSubContractLine :15, CreateSubscriptionLine :15 | Modify | Imported Subscription Line | none | none |
| CreateSubscriptionHeader :16 | Modify | Imported Subscription Header | none | none |
| CopilotCapEarlyPreview / CopilotCapabilitiesGA / CopilotCapabilitiesPreview :103 | Modify | Copilot Settings | none | none |
| IntrastatReportSetupWizard :236, :254 | Delete | Intrastat Report Setup | none | none |

Insert, 19 rows. NOTE: swap-modify-flag's Insert tag is R143's `insertSkipCanRaise`. It tags only
when `OnInsert` assigns a primary-key field DIRECTLY (the duplicate-key mechanism). It does not
read observers, and it does not follow calls (R143's documented limit 1). So "untagged" here means
"no direct key assignment", not "skipping is harmless".

| site | table | OnInsert | insert observers in the project |
| --- | --- | --- | --- |
| BookingSyncSetup.Page :317 | Booking Sync | none | none |
| WorkflowEventConditions.Page :205 | Workflow Rule | none | none |
| UsageDataImportAPI.Page :41 | Usage Data Import | none | none |
| MSPayPalStandardSettings.Page :88 | MS - PayPal Standard Account | none | `OnAfterInsertEvent` (MSPayPalStandardMgt) |
| BCPTLines.Page :194 | BCPT Line | none | `OnBeforeInsertEvent` (BCPTLine) |
| OfficeAdminCredentials.Page :139 | Office Admin. Credentials | Validate, DefaultEndpoint | none |
| AzureADAppSetupPart.Page :87 | Azure AD App Setup | Error only | none |
| CustomerReportSelections.Page :169 | Custom Report Selection | TestField | none |
| DocExchServiceSetup.Page :363 | Doc. Exch. Service Setup | TestField, telemetry, connection | none |
| OCRServiceSetup.Page :343 | OCR Service Setup | TestField, SetURLsToDefault, telemetry | none |
| LogiqConnectionSetup.Page :95 | Logiq Connection Setup | empty | none |
| ItemServCommitmentPackages.Page :114 | Item Subscription Package | TestPackageLinesInvoicedViaContracts | none |
| VATGroupSubmissionLines.page :74 | VAT Group Submission Line | TestField; `ID := CreateGuid()` (ID is not in the key) | none |
| PurchaseDocumentLineEntity.Page :980 | Purchase Line | many calls | 1 tableextension; `OnAfterInsertEvent` x3 and others |
| SalesDocumentLineEntity.Page :951 | Sales Line | many calls | `OnAfterInsertEvent` x5 and others |
| **SalesQuote.Page :1237** | **Sales Header** | **`InitInsert` -> `"No." := NoSeries.GetNextNo(...)`** | `OnBeforeInsertEvent`, `OnAfterInsertEvent` x5 |
| **SalesQuote.Page :1286** | **Sales Header** | same | same |
| **JobCreationWizard.Page :254** | **Job** | **`InitJobNo` -> assigns `"No."`** | none for insert |
| **QltyInspectionGenRules.Page :74** | **Qlty. Inspection Gen. Rule** | **`SetEntryNo` -> `Rec."Entry No." := ... + 1` (the key)** | none |

**FINDING (4 rows, unsafe direction).** SalesQuote :1237 and :1286, JobCreationWizard :254 and
QltyInspectionGenRules :74. Each `OnInsert` assigns the primary key INDIRECTLY, through a
procedure. So `Insert(false)` can leave the key blank, and a second insert raises a duplicate key:
exactly the platform kill `run-trigger-skipped-insert` exists to flag. R-473 tags these;
R-464 would drop the tag through R143's known limit 1. This is a pre-existing limit of
`insertSkipCanRaise` (resolved receivers such as `SalesHeader.Insert(true)` are already untagged
on master for the same reason), and R-464 extends it to 4 more rows.

Options, for the coordinator:
- (a) Accept, and file an R item: "insertSkipCanRaise misses indirect key assignment (R143
  limit 1), measured on 4 R-473 rows plus master's resolved receivers".
- (b) Keep R-473's tag where R-464 newly resolves the receiver and `OnInsert` calls any project
  procedure. This is a special case, not recommended.
- (c) Widen `insertSkipCanRaise` to tag whenever `OnInsert` calls a procedure of the table. That
  changes master's tags widely, so it belongs in its own item.
My recommendation: (a), filed at build time. R-464's prototype is unchanged.
The other 15 Insert rows: no key assignment in `OnInsert` (or no `OnInsert`), so R143's rule
untags them. On PayPal and BCPT, the insert-event subscribers still run under `Insert(false)`
(database events fire with the RunTrigger flag), so skipping the trigger does not skip them.

## r4 changes (sol r3)
1. **Scans use the engine's lexer.** `mayHaveField` (field names read from the text) and the
   `name :` declaration-shape scan now read `maskAlNonCode(text, { blankStringContents: true })`
   (`packages/engine/src/ast/mask.ts`), not regex comment stripping, which also stripped inside
   string literals. No new lexer. Synthetic `syn/src/Sol3.al`, red first: with
   `field(1; Amount; Decimal) { Caption = 'https://x'; } field(2; R; Integer) { }` on one line and
   `with R do begin Validate(Amount, 1); end;`, r3 emits `R.Amount := 1` (field R hidden); r4
   refuses. Control (same Caption, no field R): `Q.Amount := 2` still emitted. Prototype unit
   tests: 1,123 pass, 0 fail.
2. **Evidence re-run through the mask** (strings kept, because a subscriber's event name can be a
   string): `evidence.r4.txt` is byte-identical to r3's `evidence.txt`, and the self-check still
   finds all four planted shapes. **None of the 12 rows changes.**
3. **Cost accepted** (coordinator and sol): the 29 refused master sites plus 6 claims not taken.
   No bare-assignment fallback here; a roadmap item is in the close-out.

**Deltas r4 vs r3** (exact site diff on fd3f1c1d, 95 labels, 0 exceptions): **none.** Base and
proto site rows and generated texts are byte-identical to r3's on b912419d. All r3 figures stand.

## r3 record (base b912419d)
Before submitting: merge the latest master again and re-run the site diff on it.
Prototype copy that survives a restart: /coord/handoff/R-464/scratch-copy/ (`proto/` = the 3
changed files on b912419d: engine `semantic/receiver.ts` + `index.ts`, tier2
`validate-to-assign.ts`; tools; `syn/`; `evcheck/`).

## r3 changes
0. **Rebased on R-459; our orphan fix is DROPPED.** R-459 landed `claimedRunTriggerSkip` (engine),
   called by flip-boolean-literal's cession and by swap-modify-flag's `targets()`/`generate()`. Our
   `claimedRunTriggerFlag` is deleted; R-464 adds no run-trigger predicate. It needs no routing
   change: `claimedRunTriggerSkip` decides the receiver through `claimsRecordMethod`, which R-464's
   resolver already feeds. R-459 already restores the 3 QM `Rec.Insert(false, true)` second-literal
   flips and the master orphans (on b912419d vs 23ae24b2: BaseApp Source +30, Test +2, System
   Application +2, QM +3 flips). So r2's "30 flips restored" row and old test 6/11 (and sol r2
   minor #3) are R-459's, not ours; removed from this plan.
1. **Three-state declaration lookup** (sol r2 Important 1). `lookupDeclared` now has a three-state
   core: provably absent / a declaration / UNKNOWN (an `#if` name in a trigger header, an unindexed
   member, an R302 ambiguous name). `lookupVar` keeps mapping unknown to `null` (unchanged
   behaviour). For the prefix proof, "absent" additionally requires that no `name :` declaration
   shape appears (comments stripped) in the enclosing procedure/trigger or at object level outside
   other members; that catches declarations the index cannot see (`#if` arms, swallowed members).
   Prefix emitted only for: absent (implicit record, dataitem), or the SAME declaration as the
   `with` subject's. Anything else refuses.
2. **Unseen fields cannot capture a prefix** (sol r2 Important 2). Every record a bare name reaches
   at the site (with subjects, dataitems, implicit record) must have a table DECLARED in this
   project; otherwise refuse. Its field names are read by TEXT from the table and every project
   tableextension of it (indexed, wrapped whole in `#if`, or unparsed), so a field inside an `#if`
   arm counts; a field named like the prefix refuses. `lookupVar`'s globals guard is untouched.
   The refusal also moved into validate-to-assign's `targets()`, so a refused site is not a claim
   without a spec.
3. **Evidence re-done with AST + text scans** (sol r2 minor). See section 3; one finding changed.

**Synthetic, red first (`syn/src/Sol2.al`; outputs before -> r3):**
- `#if X Rec: Record U2 #endif` local in table T2: master and r2 emit `Rec.Amount := 1`; r3 refuses.
- `with Name do Validate("No.", 'X')`, Name a dependency `Record Customer`: r2 emits
  `Name."No." := 'X'`; r3 refuses (table not in project).
- `with R2 do Validate(Amount, 4)`, R2's table has `#if X field(3; R2; ...)`: r2 emits
  `R2.Amount := 4`; r3 refuses (field found by text).
- Controls still emit: `Rec.Amount := 3` (T2 procedure without the local), `Q.Amount := 2`.
- r2's cases stay refused (Sol.al), r1's emitted texts in All.al are unchanged.

## Deltas vs r2 (exact site diff, base b912419d vs proto r3; 95 labels; 0 exceptions)
Unchanged from r2: flips ceded 250, all 250 paired with a swap-modify-flag spec at the same call;
0 orphans; the 12 dropped + 1 added run-trigger tags (same sites); hang rows 0 changed; fixtures
(one tag on sandbox-probes `LangRefusalRunner`, no gate moves); B1 outcome.

| | BaseApp | CDO | other BC.History | total | r2 total |
| --- | --- | --- | --- | --- | --- |
| Tier-2 specs added | 3,131 | 15 | 782 | 3,928 | 3,934 |
| of which validate-to-assign added | 382 | 0 | 146 | 528 | 534 |
| validate-to-assign REMOVED (master's own) | 3 | 0 | 26 | 29 | 0 |
| flips restored by our fix | - | - | - | 0 | 30 (now R-459's) |

What the prefix refusals cost (reasons from `bareReceiverProof`, a scratch aid):
- New claims not taken: CDO 2 (`CDO Update Customer Setup` report, bare `Validate` in dataitem
  `Customer`, a dependency table); Intrastat 4 (`with` over a dependency-table subject).
- Master's own sites now refused, 29: Intrastat 23 and SAF-T 3 (bare `Validate` in a
  tableextension of a BaseApp table, so `Rec`'s table is not in the project); BaseApp 3
  (IntrastatSetup.Table :52, table not indexed; SalesHeader.Table :9036, :9048, a `Rec :`
  declaration shape visible in scope).
- **Is "refuse all validate-to-assign there" the price? No.** Only the BARE form is affected, and
  only where a reachable record's table is outside the project or a name is not provably absent.
  The qualified form (`Rec.Validate`, `Cust.Validate`) keeps its receiver text and is unaffected.
  In dependent apps the price is the bare form inside tableextensions of dependency tables and
  dataitems/with over dependency tables: CDO -2 (all of CDO's new bare ones), Intrastat -27,
  SAF-T -3; every other dependent app 0.

## 1. Resolver API (engine, `semantic/receiver.ts`)
- `recordScopesAt(node, symbols): RecordScope[]`, innermost first; `RecordScope = { kind,
  receiver, table, xRec, at? }` (`at` = the `with` statement). Kinds: `with` (subject resolved by
  the same resolver), `dataitem` (whole chain), `table`/`tableextension` (Rec, xRec), `page` with
  SourceTable (Rec, xRec), `pageextension` (table null, stays refused), `codeunit` TableNo `OnRun`
  only (Rec only), `requestpage` with SourceTable (reportextension: null), reportextension `modify`
  (null).
- `bareReceiverText(node, ctx)`: the innermost scope's spelling, only when proven (r3 rules above).

## 2. Call sites
- bare `claimsRecordMethod` / `resolveReceiverTable`: innermost scope (a `with` subject wins).
- `claimsSystemCall` rule 3: refuse when ANY scope's table declares the name.
- qualified `resolveReceiver`: after `lookupVar`, the first non-`with` scope spelled that way;
  table null -> unresolved; `receiverUnresolved` follows.
- `lookupVar` precise guard (unchanged since r1): a `with` subject's field beats any variable; an
  implicit record's field beats a GLOBAL only (never in table/tableextension); only project-declared
  fields count. `types.ts`' blanket guard not copied.
- validate-to-assign bare form: `bareReceiverText` in `targets()` and `generate()`.
- Run-trigger seam: R-459's `claimedRunTriggerSkip`, unchanged.
- Loop-hazard helpers stay separate (coordinator ruling).

## 3. The 12 dropped tags: evidence (r3 scans)
`evidence.ts` (output `evidence.txt`): receiver table through the r3 resolver; the table's
OnInsert/OnModify/OnDelete and the calls in them; then (a) AST: every `tableextension` node at any
depth whose `base_object` is the table by name or id; (b) text, comments stripped, any spacing,
quoted or unquoted, by name or id, every `#if` arm counted: `extends <table>` and
`[EventSubscriber(ObjectType::Table, Database::<table>, <event>`. Self-check `evcheck/`: a
same-line-brace `extends "AIT Log Entry" {`, an `#if`-wrapped `extends 50130`, an unquoted and a
spaced/quoted subscriber: all four found.
Result: in all 12 the table is in the project, the trigger at stake is absent, and no subscriber
names the table. ONE change vs r2: `Test Method Line` HAS a tableextension
(`TestInputMethodLine.TableExt.al`, missed by r2's scan); it declares no triggers (no
OnBefore/OnAfterModify), so `skipCanRaise` still finds no observer and the drop stands.

| site | call | table | trigger at stake | other triggers | extensions / subscribers |
| --- | --- | --- | --- | --- | --- |
| CDO Page 6175303 :32 | `Rec.DeleteAll(false)` force | CDO Payment Link MergeField | OnDelete: none | none | none |
| CDO Page 6175303 :37 | `Rec.Insert(false)` force | CDO Payment Link MergeField | OnInsert: none | none | none |
| fixture LangRefusalRunner :17 | `Rec.Insert(false)` force | Rec XRec Probe | OnInsert: none | OnModify | none |
| EDocOrderLineMatching.Page :388 | `Rec.Insert(false)` force | E-Document | OnInsert: none | OnDelete | none |
| ShpfyVariantImageExport :63 | `Rec.Modify(false)` force | Shpfy Variant | OnModify: none | OnDelete | none |
| ShpfyVariantImageExport :69 | `Rec.Modify(false)` force | Shpfy Variant | OnModify: none | OnDelete | none |
| SubBillingActivities.Page :247 | `Rec.Insert(false)` force | Subscription Billing Cue | OnInsert: none | none | none |
| CreateSubContractRenewal :15 | `Rec.ModifyAll(..., false)` force | Sub. Contract Renewal Line | OnModify: none | none | none |
| ItemServCommitmentPackages.Page :121 | `Rec.Delete(false)` force | Item Subscription Package | OnDelete: none | OnInsert | none |
| SustExciseJnlPost :36 | `Rec.DeleteAll(true)` skip | Sust. Excise Jnl. Line | OnDelete: none | OnInsert | none |
| AITLogEntries.Page :205 | `Rec.DeleteAll(true)` skip | AIT Log Entry | OnDelete: none | OnInsert | none |
| CommandLineTestTool.Page :395 | `Rec.ModifyAll(..., true)` skip | Test Method Line | OnModify: none | OnDelete | 1 tableextension, no triggers |

Ceiling unchanged: a subscriber or tableextension in ANOTHER app is not visible.
Added tag (unchanged): DeleteExpiredSalesQuotes.Report :41, bare `DeleteAll(true)` in dataitem
"Sales Header".

## 4. Tests (red per direction; each red-checked by reverting its one line)
1. Page SourceTable: qualified `Rec.Modify(true)` claimed, emits `Rec.Modify(false)`; pageextension
   bare and qualified still refused.
2. TableNo codeunit: `Rec.X` / bare `X` in `OnRun` claimed on the TableNo table; `xRec` in `OnRun`
   and `Rec` elsewhere unresolved.
3. `with` subject vs implicit `Rec`: `with R do begin Validate(Amount, 1)` emits `R.Amount := 1`
   (master: `Rec.Amount := 1`); swap-modify-flag tag follows R's table.
4. Dataitem chain: inner bare call -> `Line.Amount := 6`; qualified outer `Hdr.Validate` claimed;
   report procedure bare call refused.
5. lookupVar each direction (page global with/without the field; table global kept; outer dataitem
   field; with-subject field over a local; unknown table keeps the global).
6. tableextension field `modify(...)` trigger: bare `Validate` still claimed.
7. Tags: page `Rec.DeleteAll(true)` without/with a writing `OnDelete`.
8. Prefix proof, sol r1: local `Rec: Record U` in a table trigger -> no spec; nested `with` whose
   inner table has a field named like the subject -> no spec. Controls emit.
9. Prefix proof, sol r2: `#if`-only local `Rec` -> no spec; `with` over a dependency-table record
   -> no spec (and `targets()` false); `#if`-only field named like the subject -> no spec. Controls
   emit. Each red against r2's prototype (outputs above).
10. (r4) Sol's string-literal case (`Sol3.al`): refused, red against r3; the control emits.
(Old test 6 and 11 dropped: R-459's own tests cover the seam.)

## 5. Close-out
- CHANGELOG Fixed: wrong `Rec.` receiver inside `with` and under a local `Rec` (master emits it).
  Changed: claims in pages, TableNo `OnRun`, report dataitems and `with`; 12 dropped tags named;
  29 bare validate-to-assign sites now refused, with reasons.
- IDENTITY_SCHEME 22 and its test.
- Roadmap item to file at build time (the coordinator files it): **"Guarded bare fallback for
  refused validate-to-assign sites (35 sites)"**. These are the 29 master sites and 6 new claims
  that R-464 refuses because the synthesized receiver prefix cannot be proven (reason per site from
  `bareReceiverProof`). A bare `F := V` is NOT a safe default: an assignment's left side binds
  differently from Validate's field designator (a parameter, local, or table/tableextension global
  named like the field captures it; a page global alone does not, R294), and Validate's binding of
  a shadowed first argument was never measured (R136). To close: prove the field name's ASSIGNMENT
  binding at the site (explicit `with` first), measure the shadowing controls with `alc` and at
  runtime, then re-measure how many of the 35 come back.
- R464 `done (<commit>)`; note on R460.
- ROADMAP regenerate; line-citations test; typecheck; verify.ts; biome on touched files;
  mutation-red-checker per test; merge latest master and re-run the site diff; CI green both jobs.

## Open questions
None. Settled: dataitems in scope; the orphan fix is R-459's; hang helpers stay separate; the 29 + 6
refusals are accepted (r4), with the fallback deferred to the roadmap item above.
