# R-572 corpus re-price: pre-commitment

Written before any corpus job ran, and committed to master by lethal-code BEFORE the run, on 2026-10-21. No corpus source text anywhere in this file or in the evidence: paths, procedure names,
operators and counts only.

## What runs

- **Branch:** lethal/r572 at **c098a627** (worktree /work/lethal-wt/r572). **Master side:** the entry
  `scripts/corpus-snapshot.ts` picks for merge-base(c098a627, origin/master), reused from the shared cache
  (/coord/cache/dumps) where valid, else dumped by `snapshot <set> --master`.
- **Sets** (corpus-snapshot.ts names): `bch` /work/src/BC.History, `dc` /work/src/DC (c895a7d), `do`
  /work/src/DO (b3b4459), `cdo` /work/src/do-lethal (5f2a71d), `fixtures` (the tree's own).
- **Per set:** `snapshot <set> --master`, then `diff <set> --branch /work/lethal-wt/r572`.
- **Guard-writer leg (G-off):** a scratch copy of the branch at c098a627 whose ONLY change is
  `export const r572GuardWriter = { on: false };`, diffed against the same master entry. The
  `r572-guard-writer` cost per set is (branch delta) minus (G-off delta), and it is reported key by key as
  the keys removed on the branch and present on G-off.
- **Census:** `bun scripts/r572-flag-census.ts` per project of every set, on the branch. It reports the
  `r572-guard-writer` sites and procedures (`guardWriterSites`, `guardWriterProcedures`, `GUARD-WRITER` rows) and
  the R604 counters (`r604`: `h2SplitQueue`, `m1TouchViaWrapper`, `m2ReachCutOff`, `m3CopyShared`,
  `m3RecRefByValue`).
- **Heavy jobs:** at most 2 container-wide; the tool takes its own slot. No other heavy job of mine runs in
  parallel with a dump. Evidence in /coord/handoff/R-572/reprice/.

## Predictions: refused-mutant delta, branch minus master (deployed identity keys REMOVED)

The base is measure.md's r3 production price (removed keys, added 0, tuples and ordinals moved 0): DC 211, DO
12, CDO 12, BC.History 1,696 (summed over the tool's projects; nested projects such as PowerBI inside BaseApp
and the System Application modules are their own projects, so their keys count in each, as in r3), fixtures 0.

What changed since r3, and its expected effect:
1. **Narrowing (a) + ruling 1** (invariant step, helper form, flag form; the zero-step refusal lifted only for a
   pure Record/RecordRef `Next(<step>)` step). measure.md estimated Reservation Management 52 and Item Tracking
   Management 98 leave BC.History (1,696 -> about 1,549). DC, DO, CDO: no loop of that shape in r3's reads, 0.
2. **Narrowing (b), plan r4** (value-path writers, fixpoint, guards on the path, record level, field
   arguments). measure.md's upper-bound estimate with the tracker writers dropped was about 1,093; adversary r3
   F6 says the PowerBI tracker writers (75, counted twice) STAY refused at record level, so about 1,243 is the
   centre. The F1 fixpoint and the F5 guards can add back writers r3's estimate dropped. DC: ApplyFieldRulesToWords
   (14) expected to leave. DO, CDO: CutAtSeperator has no writers, unchanged.
3. **Ruling 2 + review r1 H1** (`r572-guard-writer`: guards dominating a call into a refused procedure in the
   loop body, their feeds, `continue` guards, same-object guard helpers and writer wrappers). Not measured on any
   corpus; adds only. Its cost is the G-off difference.
4. **Flag-form `continue` guard:** can only re-refuse a loop (a) would otherwise skip; inside item 1's range.

| set | G-off delta (items 1, 2, 4) | guard-writer cost (item 3) | branch delta (total) | why the width |
|---|---|---|---|---|
| bch | **1,090 to 1,600** | **0 to 300** | **1,090 to 1,900** | (b)'s drop is estimated by procedure, not measured: between keeping every r3 writer (1,549 after (a)) and the r3 upper-bound estimate (1,093); item 3 is unmeasured |
| dc | **180 to 225** | **0 to 60** | **180 to 285** | 211 - 14 = 197, plus fixpoint/record-level re-adds; item 3 unmeasured |
| do | **12** exactly | **0 to 20** | **12 to 32** | CutAtSeperator's 12 are a pure `var` consumer chain; item 3 unmeasured |
| cdo | **12** exactly | **0 to 20** | **12 to 32** | as do |
| fixtures | **0** | **0** | **0** | no fixture loop is flagged (r3 census) |

**Added keys: 0 on every set** (R572 only refuses). **Hangs that must stay refused, per mutant, 0 lost** (every
key in these procedures absent from the branch dump), as plan r3/r4:
- BaseApp: put-away 192 (CreateWarehouseActivityLine, InsertWhseActivLine, InsertSNWhseActivLine 147;
  UpdateWhseActivHeader 20; MakeWarehouseActivityHeader 19; GetLocation 6), GetDeprPeriod 51, CalcTimeDelta and
  IsNonworkingDay 20, NextDimEntryNo 7, AppendFileNameWithIndex 6, Serv-Amounts Mgt. InvoiceRounding 55;
- DC: GetNextBottom 26, CaptureFromPos2 84;
- DO and CDO: CutAtSeperator 12 each;
- System Application and the rest of BC.History: IsEndOfListing, Shopify RetrieveOrderLinesJson and
  GetValueAsBoolean, Graph SetNextLink / HasMorePages / GetNextPage, ForNAV GetDocsFromJson.

## Invariants (each a STOP if broken)

1. **No mutant outside R572's refusal classes changes.** Every removed key sits in a procedure the branch's
   census names (`extraProcedures`, `guardWriterProcedures`) or inside a `GUARD-WRITER` site, attributed by file
   and procedure name. A removed key anywhere else is a STOP.
2. **Identity of every admitted mutant is unchanged:** for every key present on both sides, tuple moved 0,
   ordinal moved 0, kill tag unchanged; 0 keys added.
3. **The G-off leg removes a subset of the branch's removed keys** (the guard rule only adds refusals).
4. **The named hangs above: 0 lost.**

## Reported, NOT predicted
- The R604 census counters per set and project (shapes, not mutants; a 0 means the exact shape was not seen,
  never that the gap is absent).
- The `r572-guard-writer` keys and procedures per set, and its share of each set's deployed total.
- The real / plausible / over-refusal split of anything NEW against r3 (r3's split stands for the rest).

## Stop rule
A delta outside its predicted range on any set, or any broken invariant, is a **STOP**: report it with the
evidence, investigate, and do not re-reason a range or an invariant after the fact. A re-run needs a new
pre-commitment.
