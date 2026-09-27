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
(Filled in after the runs.)
