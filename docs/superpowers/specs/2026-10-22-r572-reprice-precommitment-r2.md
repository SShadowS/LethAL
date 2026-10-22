# R-572 corpus re-price r2: pre-commitment

Written before any r2 corpus job, and committed to master by lethal-code before the run, on 2026-10-22. Paths, object and procedure names,
operators and counts only: no corpus source text.

**Supersedes** `docs/superpowers/specs/2026-10-21-r572-reprice-precommitment.md` (c03d5356). Its bch run on
950e69a3 STOPPED, and the investigation (`/coord/handoff/R-572/reprice/investigation.md`) found three things
that change what may be predicted:
1. **Over-refusal (a bug).** Item Jnl.-Post Line: 2,256 keys were refused as value-path writers because a
   wrapper's `var` parameter has the same name as a record global; b2bcbdc8 resolves a name to the global only
   when no parameter or local shadows it.
2. **Ordinals.** 34 ordinals moved in BaseApp, every one a same-tuple twin of a guard site refused alone by
   `r572-guard-writer`; r1's invariant "ordinals moved 0" was mis-stated for a rule that refuses single sites.
   b2bcbdc8 bumps `IDENTITY_SCHEME` to 41.
3. **Named hangs were named loosely.** All 19 "lost" keys were the analysis's substring match (Shop Calendar
   Management, Mfg. Create Inventory Put-away, Graph Client) or the nested FileOperations copy of File Management
   (R619, out of scope). Below, every named hang has its full identity.

## What runs
- **Branch** lethal/r572 at **b40c1b9d**: b2bcbdc8 (the approved code) plus census counters S3/S4, R604 text and
  a CHANGELOG line; no refusal logic changed. **Master**: the cached c03d5356 entries (dumper
  874d934e7cc5c941) in /coord/cache/dumps, the merge-base; no master re-dump.
- **Sets:** `bch`, `dc`, `do`, `cdo`, `fixtures`. Per set: the branch dump, a **G-off** dump (a scratch worktree at
  b2bcbdc8 whose only change is `r572GuardWriter = { on: false }`), the census
  (`scripts/r572-flag-census.ts` per project), and `/coord/handoff/R-572/reprice/tools/analyze.ts` (exact object
  matching, project scope, the corrected invariant 2). dc, do, cdo and fixtures also run the official
  `corpus-snapshot.ts diff`; bch uses the same `diffDumps` on kept dumps.
- One heavy job of mine at a time, in a flock slot; at most 2 container-wide. Evidence in
  /coord/handoff/R-572/reprice/r2/.

## How the ranges were derived (not padded)
Base: the 950e69a3 run (`reprice/<set>-analysis.txt`): bch 4,263 (G-off 3,893, guard-writer 370), dc 243 (211,
32), do 12, cdo 12, fixtures 0. Then what b2bcbdc8's shadowing fix changes, measured offline with production
code on the affected objects (tools in `reprice/tools/`, logs in `reprice/`; no corpus job):
- **Which objects can change.** `shadow-scan.ts` (one object file at a time): the objects with removed keys that
  hold a procedure declaring a parameter or local named like a global of its object: 31 in bch, 2 in dc, none
  needed for do/cdo (their only removal is CDO String Functions.CutAtSeperator, a chain member with no writer).
- **What their value-path slices do.** `probe-slices.ts` (each object file ALONE, old 950e69a3 vs new b2bcbdc8):
  slices shrink in 31 objects, and GROW in four (Item Jnl.-Post Line, Sales-Post, Azure AD Graph Impl., CDC
  Capture Engine), because b2bcbdc8 also carries a callee's globals two or more calls deep (950e69a3 dropped them).
- **What their refusals do.** `probe-affected.ts` (each object's file plus every file of its project that names
  it, so the loops reaching it are in the probe; old vs new): the refused procedures change in ONE object, Item
  Jnl.-Post Line, 52 -> 3 procedures, 2,256 -> 9 keys (**-2,247**), gaining none. It reproduces 966 of the other
  bch keys exactly. The DC probe (Capture Engine, Capture Management, Line Capture 2.0, Date Parser Management,
  Message Bus Socket, PC Approvals Bridge): identical refusals and writers old vs new.
- **What the probes could not reproduce:** 141 bch keys whose loops are reached through files that do not name the
  object. Of them, 38 are G-off keys (PeriodPageManagement 12, Azure AD Graph Impl. 26) whose slices shrink, so
  they may drop; the rest are guard-writer keys.
- **Guard-writer.** A guard site is refused only around a call into a refused procedure. The only refused set that
  changes is Item Jnl.-Post Line's, so only guard keys in objects whose files call Item Jnl.-Post Line can drop:
  39 keys (Item Jnl.-Post Batch 13, Mfg. Item Jnl.-Post Line 7, Sales-Post 11, Purch.-Post 8).
- **Upper edge for growth.** Azure AD Graph Impl.'s slices grow (one global); its keys not yet removed are 86. The
  Item Jnl.-Post Line, Sales-Post and CDC Capture Engine growth is in procedures that are not chain procedures
  (they had keys and none was removed), and the probes show no new refusal from them.

## Predictions: refused keys, branch minus master

| set | G-off (rules a/b) | guard-writer cost | total | derivation |
|---|---|---|---|---|
| bch | **1,608 to 1,732** | **331 to 370** | **1,939 to 2,102** | G-off: 3,893 - 2,247 = 1,646, minus up to 38 unverified shrinking keys, plus up to 86 (Azure AD Graph Impl. growth). Guard: 370 minus up to 39. |
| dc | **211** | **32** | **243** | the DC probe: identical old vs new |
| do | **12** | **0** | **12** | no affected object |
| cdo | **12** | **0** | **12** | no affected object |
| fixtures | **0** | **0** | **0** | |

A guard-writer cost outside its range is a **STOP** on its own. Added keys: **0** on every set.

## Invariants (each a STOP)
1. **Classes.** Every removed key sits in a procedure the census refuses for that project, or on a `GUARD-WRITER`
   site line (analyze.ts, exact names).
2. **Identity (corrected).** Tuples moved: **0**. An ordinal may move only as a same-tuple twin shift under the
   scheme bump (41): its new ordinal equals its master ordinal minus its refused lower twins (same file, same
   tuple), checked key by key; gate baselines read across the scheme by mutated-text hash. Any other key change
   (a tuple move, an unexplained ordinal, a kill-tag change) is a STOP. On 950e69a3 the check gives tuples 0,
   ordinals 34 / explained 34 (expected to fall with the guard keys above).
3. **G-off is a subset** of the branch's removals.
4. **Named hangs, by full identity: every master key in each procedure absent on the branch** (0 kept):

| project | object | procedure (master keys at c03d5356) |
|---|---|---|
| BaseApp/Source/Base Application | codeunit Create Inventory Put-away | CreateWarehouseActivityLine (86, two overloads 41 + 45), InsertWhseActivLine (53), InsertSNWhseActivLine (8), UpdateWhseActivHeader (20), MakeWarehouseActivityHeader (19), GetLocation (6) |
| BaseApp/Source/Base Application | codeunit Depreciation Calculation | GetDeprPeriod (51, two overloads 4 + 47) |
| BaseApp/Source/Base Application | codeunit Calendar Management | CalcTimeDelta (15), IsNonworkingDay (5) |
| BaseApp/Source/Base Application | codeunit Dimension Buffer Management | NextDimEntryNo (7) |
| BaseApp/Source/Base Application | codeunit File Management | AppendFileNameWithIndex (6); the nested `Modules/System/FileOperations` copy is R619, out of scope |
| BaseApp/Source/Base Application | codeunit Serv-Amounts Mgt. | InvoiceRounding (52) |
| System Application/Source/System Application, and its MicrosoftGraph project | codeunit Graph Client Impl. | GetNextPage (10 in each) |
| the same two projects | codeunit Graph Pagination Data, Graph Pagination Data Impl. | SetNextLink (2, 2), HasMorePages (2, 4) |
| System Application/Source/System Application, and its External File Storage project | codeunit File Pagination Data, File Pagination Data Impl. | IsEndOfListing (2, 2 in each) |
| Shopify/app/Shopify Connector | codeunit Shpfy Import Order | RetrieveOrderLinesJson (16) |
| Shopify/app/Shopify Connector | codeunit Shpfy Json Helper | GetValueAsBoolean (11, two overloads 8 + 3) |
| EDocumentConnectors/ForNAV/Source/E-Document Connector - ForNAV | codeunit ForNAV Inbox | GetDocsFromJson (10) |
| DC Cloud | codeunit CDC Capture Engine | GetNextBottom (26) |
| DC Cloud | codeunit CDC Capture Management | CaptureFromPos2 (84) |
| DO Cloud, CDO (do-lethal) Cloud | codeunit CDO String Functions | CutAtSeperator (12 each) |

## Reported, NOT predicted
- Census per set: guard-writer sites and procedures, RE-OPEN rows, the R604 counters, `backstopCutOffs`.
- The `r572-guard-writer` keys by procedure; the ordinal shifts by object.
- The real / plausible / over-refusal reading of anything new against the investigation's table.

## Stop rule
A delta, a G-off part or a guard-writer cost outside its range, or any broken invariant, is a **STOP**: record
the evidence, investigate, never re-reason a range after the fact; a re-run needs a new pre-commitment.

## Results (added after the run, 2026-10-22; nothing above was changed)
Run on lethal/r572 b40c1b9d against the c03d5356 master entries, 01:41 to 04:03 UTC. Evidence:
`/coord/handoff/R-572/reprice-r2/` (per set: `<set>-analysis.txt`, `<set>-census.jsonl`).

| set | predicted total / G-off / guard-writer | measured total / G-off / guard-writer | |
|---|---|---|---|
| dc | 243 / 211 / 32 | 243 / 211 / 32 | exact match |
| do | 12 / 12 / 0 | 12 / 12 / 0 | exact match |
| cdo | 12 / 12 / 0 | 12 / 12 / 0 | exact match |
| fixtures | 0 / 0 / 0 | 0 / 0 / 0 | exact match |
| bch | 1,939-2,102 / 1,608-1,732 / 331-370 | 2,097 / **1,733** / 364 | **G-off missed by one key** |

bch guard-off 1,733 MISSED the pre-committed 1,608–1,732 by one key. Not re-pre-committed: the code is unchanged
and a re-run would reproduce it. Accepted by orchestrator ruling 2026-10-22, because all 87 extra keys are
classified over-broad (shpfy-classification.md), and a one-level carry would admit probe 37b, a real hang.

The 87 extra keys are in Shopify's `Shpfy Communication Mgt.` (`/coord/handoff/R-572/reprice-r2/
shpfy-classification.md`), refused through the value path's carry of callee globals two or more calls deep, which
this pre-commitment's derivation did not probe; filed as [[R628]]. The predicted Item Jnl.-Post Line drop
(-2,247) happened exactly.

**Invariants, every set:** added keys 0; invariant 1 (every removed key in R572's classes) 0 outside; invariant 3
(G-off a subset of the branch) 0 exceptions; invariant 2: tuples moved 0, ordinals moved 31 in bch (BaseApp),
**31 of 31 explained by refused lower twins** (same file and tuple), 0 elsewhere; invariant 4: every named hang
refused (0 kept), the nested FileOperations copy reported out of scope (filed as [[R629]]; this text's "R619"
was renumbered at the merge, because master had given R619 to another item).

**Census (reported):** guard-writer sites bch 258, dc 50, others 0; RE-OPEN rows bch 1, do 2, cdo 2;
`h2SplitQueue` 0 everywhere; `m1TouchViaWrapper` bch 9, dc 8; `m2ReachCutOff` bch 220, dc 27; `m3CopyShared`
bch 10; `m3RecRefByValue` 0; `s3AliasViaVarCallee` bch 16, dc 2; `s4WithGlobal` 0; `backstopCutOffs` 0
everywhere.

**Run note:** the official `corpus-snapshot.ts diff` refused to start for dc, do and cdo (its heavy-job guard
counted a parallel itest's process groups); the same `diffDumps` ran on the kept dumps. Per the orchestrator, a
guard's refusal is reported first in future, never worked around.
