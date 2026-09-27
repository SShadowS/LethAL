# TSAL-441 pre-commitment: tree-sitter-al 4.3.0 -> 4.4.1

Written and committed at HEAD 03e276ce0ab9f0ca97cf1c861728bb582a10de4c before any census, tree diff,
cross-check or live run under a 4.4.1 build or an intermediate build. Nothing above OUTCOME changes
after a run.
Plan: docs/superpowers/plans/2026-09-27-TSAL-441-grammar-bump.md (r2).

## Grammars
| label | ref | use |
| --- | --- | --- |
| g430 | vendored at HEAD, sha256 c6e7fedb...f4d4 | before |
| g441 | released v4.4.1 asset, sha256 cd6e347e...d085ed099 | after, vendored |
| gLOCAL | local `tree-sitter build --wasm` at v4.4.1 | comparison only |
| g440, g209, per-commit builds | built only if an end-to-end delta needs attribution | instruments |

## Corpora (identity is the fingerprint)
| key | path | files | sha256 (first 16) |
| --- | --- | ---: | --- |
| do | U:/Git/do-rel2/Cloud | 417 | 9a8e8831449208cc |
| dc | U:/Git/DC/Cloud | 475 | dcad155c4ecdb38e |
| sentinel | U:/Git/BusinessCentral.Sentinel | 67 | 9363656ed52020e0 |
| bcf | U:/Git/BC.History/BusinessFoundation | 104 | a56a8435136fc21f |
| sysapp | U:/Git/BC.History/System Application | 1,718 | 7fae1831fda03a89 |
| baseapp | U:/Git/BC.History/BaseApp | 9,620 | 2afad2aa60b13958 |
| bc281 | `$S/bc281` (session scratchpad), extracted from `C:/bcartifacts.cache/sandbox/28.1.49838.50244/platform/Applications/BaseApp/Source/Base Application.Source.zip` (W1, zip sha256 0f30164a0f1f9c87...). Its app.json version is the build placeholder `$(app_currentVersion)`; the build is `28.1.49838.50244`, from the artifact directory and the sibling `Microsoft_Base Application_28.1.49838.50244.app`. Label **exploratory** (not upstream's `28.1.49838.50268`). All five of upstream's unhealthy file names are present, once each. | 8,024 | b019f94027818d93 |
Fixture targets: fixtures/sandbox-app, sandbox-data, sandbox-hang, sandbox-harden,
sandbox-coverage-probe.

## P1. Fixture trees (positioned nodes with ancestry, g430 vs g441)
Each node is compared as (file, start, end, kind, named, ancestor-kind path). Every node present
under only one grammar has `property` in its ancestor path (or is itself a `property`), and each
such change is #27's class: `table_relation_value` -> `identifier` for a bare value, or a
value-start contextual name now read as a name. Zero changed nodes outside a property.
Parse health, checked separately with the cross-check's `parseHealth` (ERROR nodes by type, MISSING
nodes by the parser's `isMissing` flag): 0 / 0 in every fixture file under both grammars.

## P2. Fixture sites (scripts/census-operator-sites.ts, pre-isMutableSite)
Every fixture target: 0 rows moved.

## P3. Fixture identities
For every fixture target: the `probe-fixture-hashes.ts` listing is BYTE-IDENTICAL, and the
full identity-key listing (selection.ts `serializeKey(identityKeyOf(m))` over the real manifest:
astHash, object, enclosing member, operator, operator major, source-order ordinal, with file and
startLine) is BYTE-IDENTICAL, raw count and deployed count included.
**sandbox-data, predicted unchanged:** 407 raw specs and every identity key as under 4.3.0, so
this bump moves none of GH-24's section 5 figures (301 / 68 / 18). The combined itest:tables
check after the GH-24 re-record and R-236c verifies this live; any difference there that is not
GH-24's or R-236c's is this bump's and a BLOCK.

## P4. Corpus sites, g430 -> g441 end to end
- do, sentinel, bcf: 0 rows moved.
- sysapp: 0 rows (8 asserterror assignment bodies change kind; no operator claims them).
- dc: rows move only in `CDCPurchContractCard.Page.al` and `CDCPurchContrArchCard.Page.al`
  (P1 cluster, #27), and each such row is declarative (dropped by `isMutableSite`).
- baseapp: the 34 `lethal.void-method-call` rows whose before-text starts with `[` (R284's
  fragments) REMOVED, all under `BaseApp/Test`, attributed to #26. Additions only at those 34
  restored calls, and only from operators that gate on call kind rather than statement slot;
  none from `void-method-call` or `remove-assignment` (R216's slot is still missing). 0 rows at the
  87 asserterror assignment bodies. 0 rows anywhere else.
- bc281, label **gate** (build `28.1.49838.50268`, upstream's snapshot): parse health 5 files with
  ERROR under g430 (`PostedSalesShipmentUpdate.Page.al`, `FinanceChargeMemo.Report.al`,
  `SalesPost.Codeunit.al`, `Check.Report.al`, `SalesShipment.Report.al`, matched by file name),
  0 under g441. Every moved census row lies in one of those five files and is attributed to one
  step-A commit by bisection or by its enclosing directive construct.
- bc281, label **exploratory** (any other 28.1.x build): no gating prediction. Its parse health
  under both grammars and its moved rows are measured, attributed and reported as a first
  measurement; nothing about it can pass or fail this bump.
- bc281 not found: not measured.

## P5. Unit suite
`bun test` under g441 before any test edit: the same pass / skip / fail counts as under g430 at
the same HEAD. The new `grammar-shapes.test.ts`: under g430 the seven upstream-fix cases FAIL
(#27's bare-value case on its bare-value assertion) and the R216 case passes; under g441 all
eight pass.

## P6. Cross-check re-run (scripts/probe-grammar-crosscheck.ts), g441, same seven corpora
Buckets as guarded / explained / UNEXPLAINED, section 6 layout of
docs/measurements/2026-09-27-gh06-grammar-crosscheck.md:
- fixtures, do, sentinel, bcf: identical to run 002 (do keeps C2: 3 + 2 unexplained).
- dc: comparable 475 (was 473), tree-sitter unhealthy 0 (was 2 files, 6 ERROR). Unexplained stays
  8 (C3). The two re-admitted files add 0 unexplained records.
- sysapp: assignment probe compiler-only 0 / 8 / 0 (was 0 / 0 / 8).
- baseapp: kinds compiler-only UNEXPLAINED 34 -> 0 and tree-sitter-only UNEXPLAINED 34 -> 0
  (C1a, C1b gone); call probe compiler-only UNEXPLAINED 56 -> 22 (C5 20 + C6 2), the 34 moving to
  explained; call probe tree-sitter-only UNEXPLAINED 34 -> 0; assignment probe compiler-only
  UNEXPLAINED 82 -> 10 (C5 8 + C7 2), the 72 moving to explained.
- Total unexplained: 261 -> 45 (do 5, dc 8, sysapp 0, baseapp 32). C2, C3, C5, C6, C7 unchanged.

## P7. Cross-check controls
- g430 on scripts/lib/al-kind-mapping-asserterror-index.al: compiler-only call_expression
  [147,170] and [192,238]; tree-sitter-only [154,170] and [199,238].
- g430 on al-kind-mapping-asserterror-assign.al: assignment probe compiler-only UNEXPLAINED at 125.
- g430 on al-kind-mapping-type-property.al: comparable 0, tree-sitter unhealthy 1, exit 2.
- g441 on asserterror-index: no kind delta; call probe compiler-only at 147 and 192
  explained-asserterror; 0 unexplained.
- g441 on asserterror-assign: assignment compiler-only at 125 explained-asserterror; 0 unexplained.
- g441 on type-property: comparable 1, agree, exit 0.
- Controls A and B (v3.2.1 linkprobe, v4.0.1 continue; grammar repo's checked-in wasm at the tag):
  exactly as run 002 section 3.
- census-fixture-mutants on a directory holding only asserterror-index.al, under g441: no row
  whose before-text starts with `[`.

## P8. Landing gates
- itest:bcdev: PASS, 3 / 12 / 4, groupedCalls 15, warmKills 0, screen `vacuous`, per-mutant equal.
- itest:alrunner: PASS, 3 / 12 / 4 on all four legs, per-mutant equal to one-shot.
- itest:chunked: PASS, both legs 17 / 7 / 2, control warmKills 9 / groupedCalls 33, chunked 5 / 57.
- No baseline is deleted, regenerated or edited.

A failed P1 to P4 stops the plan before the next dependent step: explain every row, file what is
new, and commit an AMENDMENT section to this spec, alone.

## OUTCOME

- **P1 MATCHED.** Zero changed nodes in any of the 40 fixture files under g430 vs g441 (the diff
  instrument was proven live first on a hand-written probe outside the fixtures: 22 changed nodes
  inside a property, 8 outside). Parse health (ERROR, MISSING) is 0/0 in every fixture file under
  both grammars. Zero value-start contextual-name hits across all 40 files.
- **P2 MATCHED.** `census-operator-sites.ts` moved 0 rows on all five fixture targets (sandbox-app,
  sandbox-data, sandbox-hang, sandbox-harden, sandbox-coverage-probe).
- **P3 MATCHED.** The `astSubtreeHash` listing and the full identity-key listing are byte-identical
  on every fixture target under both grammars. sandbox-data: 407 raw / 387 deployed specs,
  unchanged under both grammars.
- **P4 MISSED, see AMENDMENT 1.** Two clusters the prediction did not name, each explained by a
  single named upstream commit, so no new grammar bug: (a) dc gained a 7th
  `lethal.negate-conditional` row, in `.dependencies/DC/Page/CDCeOrderDocumentCard.Page.al` (step C,
  #27), a file the prediction's list missed; declarative, dropped by `isMutableSite`, no run
  changes. (b) BaseApp/Test gained 8 `lethal.toggle-blank-string` rows (step B, #28) at
  `asserterror` bodies assigning a string literal to a page field's `Value`, now parsed as an
  `assignment_statement`; these are real new mutants, not declarative no-ops. The predicted 34
  `lethal.void-method-call` removals under BaseApp/Test (step B, #26, R284's fragments) matched
  exactly, and do/sentinel/bcf/sysapp moved 0 rows, as predicted.
- **P5 MATCHED.** `bun test` under g441, before any test edit: 3775 pass / 7 skip / 0 fail,
  identical to g430 at the same HEAD. `grammar-shapes.test.ts` (Task 5): under g430, 1 pass / 7
  fail, every failure matching the brief's named assertion for #24, #25, #26, #27 and #28; the R216
  case is the 1 pass (unchanged on both grammars, since R216 is still open on both). Under g441: 8
  pass / 0 fail. Full suite after adding the file: 3783 pass / 7 skip / 0 fail.
- **P6 MATCHED.** Cross-check run 003
  (`docs/measurements/2026-09-27-gh06-grammar-crosscheck.md` section 10): fixtures, do, sentinel,
  bcf identical to run 002; dc comparable 475 (was 473), unhealthy 0 (was 2 files / 6 ERROR),
  unexplained 8, the two re-admitted files add 0 records; sysapp assignment compiler-only 0/8/0;
  baseapp kinds compiler-only and tree-sitter-only both 34 -> 0; baseapp call probe compiler-only
  56 -> 22 (the 34 moving to explained), tree-sitter-only 34 -> 0; baseapp assignment probe
  compiler-only 82 -> 10 (the 72 moving to explained). Total unexplained 261 -> 45 (do 5, dc 8,
  sysapp 0, baseapp 32).
- **P7 MATCHED.** Every control reproduced exactly: the v3.2.1 and v4.0.1 tag-wasm controls
  unchanged; the g430 asserterror-index, asserterror-assign and type-property controls unchanged;
  the g441 asserterror-index and asserterror-assign controls both explained-asserterror with 0
  unexplained; the g441 type-property control comparable 1, agree, exit 0; `census-fixture-mutants`
  on the asserterror-index-only directory under g441 plants no row whose before-text starts with
  `[`.
- **P8, landing gates.** Measured by the controller on the merged tree `b995f89` (includes master
  `bc62877`; Cronus28, lease attempt 053, released):
  - `lethal doctor`: all ok. Control app 1.0.0.20 (>= `MIN_CONTROL_VERSION` 1.0.0.20). alc
    18.0.41.45789. al-runner build: **v2.11.0**.
  - `itest:bcdev`: PASS, killed 3 / survived 12 / no-coverage 4, `baselineGreen`, protocol-invariant
    probes PASS.
  - `itest:chunked`: PASS, both legs 17 / 7 / 2, errors 0; control `warmKills` 9 / `groupedCalls`
    33; chunked leg `warmKills` 5 / `groupedCalls` 57.
  - `itest:alrunner`: PASS, 3 / 12 / 4 on all four legs, the `--server` and resource-selector legs'
    verdicts identical to the one-shot transport; build line "al-runner v2.11.0".
  - Unit suite on the merged tree: typecheck clean, `bun test` 0 fail / 7 skip over 3851 tests.
  - No baseline was deleted, regenerated or edited anywhere in this bump.
  - itest:tables: not run by this lane (ruling Q1); owed by the combined check after the GH-24
    re-record and R-236c, which must show 0 grammar-attributable differences (P3).
  - `itest:lease` and `itest:stale-publish` were not run for this bump, by ruling; neither pins a
    per-mutant baseline.

## AMENDMENT 1 (2026-09-27): P4 missed, both misses explained
Written after the Task 3 offline census (`.superpowers/sdd/2026-09-27-TSAL-441-grammar-bump/task-2-3-report.md`),
before any cross-check or live gate that depends on it.

- **P1 MATCHED.** Zero changed nodes in any fixture file under g430 vs g441 (the instrument was
  proven live first, on a hand-written probe outside the fixtures), and parse health is 0/0 in all
  40 fixture files under both grammars.
- **P2 MATCHED.** Zero census rows moved on any of the five fixture targets.
- **P3 MATCHED.** Hashes and full identity-key listings are byte-identical on every fixture target
  under both grammars, including sandbox-data's raw 407 / deployed 387 under both grammars.
- The released v4.4.1 asset equals the tag's checked-in wasm, and the local build (tree-sitter CLI
  0.27.0) is byte-identical to both.

**Deviation from the plan: the whole-BaseApp census cannot run in one pass.**
`census-operator-sites.ts` over BaseApp's 9,620 files aborts under g430 after about 20 s
(`RuntimeError: Aborted()` in web-tree-sitter) and writes nothing: the census keeps every parsed
tree alive for its one semantic context, and the wasm heap runs out. So baseapp was measured as two
halves instead, BaseApp/Source (8,020 files) and BaseApp/Test (1,600 files), each run twice under
g430 and stable at 0/0 only-in-A / only-in-B both times. The blind spot: a Tier-2 operator's claim
in a Test file that resolves a symbol declared in Source is judged without Source's declarations in
scope. Every moved row found end to end is from a Tier-1 operator, so this run does not exercise
that blind spot, but the instrument cannot rule it out. Filed as R292 (Job 2).

**P4 misses, each explained by a named upstream change, so no new grammar bug:**

(a) dc: 7 new `lethal.negate-conditional` census rows, all attributed to #27 (`551829e`),
    a value-start `Type = Type::<member>` comparison inside a page control's `Visible` or `Enabled`
    property value. One of the 7 is in `.dependencies/DC/Page/CDCeOrderDocumentCard.Page.al`, a file
    P4 did not name (P4 named only the two pages under `Modules/Purchase Contracts/Base/src/Pages/`).
    All 7 rows are dropped by `isMutableSite` (declarative), and the deployed-mutant listing is
    byte-identical under both grammars for the affected directories, so no run changes.
(b) baseapp/Test: 8 new `lethal.toggle-blank-string` rows, attributed to #28 (`209d038`), at an
    `asserterror` body that assigns a string literal to a page field's `Value`, which is now parsed
    as an `assignment_statement` (it was not a statement under g430). Files: `ItemTrackingTest` 4,
    `RTCAdminUserPermissionSet` 2, `TestJobQueue` 1, `ServiceDemandOverview` 1. These are real new
    mutants a run would plant, not a declarative no-op. `remove-assignment` and `void-method-call`
    gained nothing at these bodies, as predicted ([[R216]]'s statement-slot gap is still missing
    them).
    The 34 predicted `lethal.void-method-call` removals under BaseApp/Test are exact, and do,
    sentinel, bcf, sysapp all move 0 rows, as predicted.

No intermediate grammar was built: no moved row anywhere sits in directive code, and each cluster's
construct settles which single issue (#26, #27 or #28) it belongs to on its own.

bc281 (exploratory, build `28.1.49838.50244`): 0 unhealthy files under both grammars, including
upstream's five named files, which are present and clean even under g430 on this build; 0 census
rows moved. It gates nothing and this amendment changes no prediction about it.

**Revised predictions for later steps.** P6's dc and baseapp cross-check expectations in this spec
are UNCHANGED by this amendment: the census (this document) and the cross-check
(`probe-grammar-crosscheck.ts`) measure different things, one server's parse tree against a fixed
set of AL kind shapes it treats as sites, the other tree-sitter's output against the compiler's own
parse. A miss in one is not a prediction about the other.
