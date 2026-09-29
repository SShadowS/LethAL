# RUST-03 pre-commitment: native parser switch-over

Written and committed at 3383f6d, before any RUST-03 measurement is read. Nothing above OUTCOME
changes after a run. Plan: docs/superpowers/plans/2026-09-28-RUST-03-native-switch-over.md.
Carries forward: the RUST-01 pre-commitment's corpora table, its baseline table (WASM medians) and
AMENDMENTs 1 to 3; the RUST-02 gate reports (clang W2 8,957 MB, W3a 5,855 MB, identity equal).

Already seen before this file (so not predictions): RUST-02's native W2, W3a and W8 figures
(W8 clang 15,942 MB, WASM 17,798 MB). NOT yet seen: native W4, native W9, and any attribution.
A W2 or W3a win is a census win only. It is never reported as a W4 or product-wide win.

## Same-revision rule
Every WASM-against-native comparison runs both sides at one LethAL commit (the S3 base commit)
and one corpus revision, both recorded here before the run:
- LethAL S3 base commit: <filled in at S3.4 Step 0, in AMENDMENT form, before any S3.4 number>
- corpus revisions: `git -C <corpus> rev-parse HEAD` for BC.History, do-rel2, DC, Sentinel
RUST-02's W2 hash (153bac07...) was taken at another commit, and RUST-02 already recorded 33
row additions from commits in between. A difference against it is not by itself a parser
difference: it is explained against the same-revision WASM census before it is judged.

## Parser under test
clang build: clang-cl 23.1.2 (Windows), /O2, crate as RUST-02 (src/lib.rs sha256 221357a5...),
grammar pins as the plan's Global Constraints. MSVC is not a release build.

## Stage S0 (measurement only, no bar)
W4 and W8 on WASM and native, three runs each, plus a per-phase attribution of W8 and W4.
The attribution is a set of LEADS, not a measurement of retained bytes: post-GC RSS, object
counts and scaled small-corpus snapshots do not measure BaseApp's external typed arrays or its
transient peak. Each lead is reconciled with the phase peak RSS and the external memory figure.
No result in S0 changes a ceiling below. S4 fixes are a template until a reviewed amendment.

## Ceilings (never raised after a native result; written here before any W4 measurement)
- W2: completes in one pass, peak <= 16,384 MB (AMENDMENT 1, re-confirmed on the final binary).
- W4: completes with no crash, peak <= 16,384 MB (the owner's 16 GB ruling, 2026-09-28; it
  replaces RUST-01's 8,192 MB for RUST-03). Over it: MISSED, no W4 memory win claimed, filed.
- W8: completes with no crash, peak <= 16,384 MB. A W8 memory win is claimed only at <= 8,192 MB.
- W9: completes with no crash, peak <= 16,384 MB, the patch audit shows the product manifest
  writer wrote the file, and a streaming check finds valid JSON with a row count equal to deployed.

## Switch gates (S3; any miss is a BLOCK on the switch commit)
Q1 structure: lockstep walk, 0 differing nodes on every file of every fixture, the grammar probe,
   do, dc, sentinel, bcf, sysapp and whole BaseApp; kind tables equal; flat links consistent.
Q2 identity (same-revision rule): census rows 0 moved, native against WASM at the S3 base commit,
   on every fixture and on do, dc, sentinel, bcf, sysapp, bsrc, btest; identity-key listings
   byte-identical on the same set; whole BaseApp identity listing byte-identical to the WASM
   materialized-capture listing taken at the S3 base commit, with a non-empty header (raw,
   deployed and skippedFiles all present, raw and deployed > 0) and over 1,000,000 lines.
   a66a270e... (RUST-02) is expected; a difference from it is explained, not judged alone.
   Native W2 completes in one pass; a difference from RUST-02's 153bac07... is explained row by
   row against the commits in between, and is not by itself a parser difference.
Q3 emission: every emitted file of all five fixtures byte-identical to the WASM capture pinned in
   fixture-emission.test.ts before the switch.
Q4 R-236c: its tests pass; the leak test in its native form passes and goes red when a parse
   result is retained; its ten-corpus census is identical, BaseApp refused 11,179.
Q5 unit suite: pass/skip/fail equal to the pre-switch HEAD plus the tests this plan adds, 0 fail.
Q6 live (control app 1.0.0.19 on every gate container): itest:bcdev 3 / 12 / 4, groupedCalls 15,
   warmKills 0, screen vacuous; itest:chunked both legs 17 / 7 / 2, control 9 / 33, chunked
   5 / 57; itest:alrunner 3 / 12 / 4 on all four legs; itest:tables with the figures frozen in
   tables.itest.ts at the switch commit, per-mutant equal, only if the owner has committed the
   pending tables re-record on master before S3.5 (else deferred, and the OUTCOME says so).
Q7 release: five targets build with clang, the provenance says clang, nativeInfo().target matches
   each job's platform and arch, every S2 job parses a fixture through the built addon directly,
   and after the switch every compiled binary parses fixtures/sandbox-data --dry-run with the same
   count lines as Windows source mode; notices pass, no DIRTY stamp, publish needs all five.

## Transfer-buffer decision (S1.4)
Variant "owned" replaces "external" only if, on W1 with NO event-loop turn (RUST-02 gate2 base
shape), its peak median is at least 20% lower, AND W2's peak median is not more than 5% higher,
AND nodes are equal. Otherwise external stays.

## OUTCOME
(filled in by S5)

## AMENDMENT 1 (S0 results, before any S4 fix)

Written after S0.2's runs and before any S4 code. Nothing above OUTCOME changes: the ceilings, the
switch gates and the transfer-buffer rule stand as committed. Evidence:
`.superpowers/sdd/rust-03/s0-2-report.md`.

Setup. Both parsers ran at one LethAL commit, e5bed71, on one corpus revision (BC.History
4d61fc58bc55dd0acb78f8b9b6ea54109b960785). Native is RUST-02's uncommitted switch diff applied in a
scratch worktree, with the clang addon (sha256 f852037b66d13008...). Whole-run peak and wall
figures come from `scripts/measure-peak.ts`, and medians are of 3 such runs. Phase peaks, heap,
external memory, heap capacity and object counts come from scratch phase markers in separate marked
runs (which force full garbage collections), and the per-class estimates come from heap snapshots
on sysapp and do, scaled by raw site count.

### W4: the product dry-run on the Base Application

| parser | peak MB (runs) | median peak MB | median wall s |
| --- | --- | ---: | ---: |
| WASM | 17,235 / 17,215 / 17,240 | 17,235 | 384.87 |
| native | 5,779 / 5,202 / 5,195 | 5,202 | 389.99 |

All six runs exit 0. The output is byte-identical across both parsers and all runs (788,619 lines,
782,940 sites, 749,020 deployed), and so is stderr, excluding each run's measure-peak line.

W4 against its 16,384 MB ceiling, on W4's own numbers: native peaks at 5,202 MB (median) and 5,779 MB
(highest run), under the ceiling in every run. WASM peaks above it in every run. This is a W4
measurement, taken on W4 directly. It is not inferred from W2, W3a or W8. S4.3 still judges W4 on the
final binary.

### W8: the whole-BaseApp spec-level identity capture

| parser | peak MB (runs) | median peak MB | median wall s |
| --- | --- | ---: | ---: |
| WASM (materialized capture) | 17,847 / 19,098 / 17,490 | 17,847 | 1,538.78 |
| native | 16,438 / 17,161 / 18,558 | 17,161 | 1,415.65 |

All runs exit 0. The native and WASM listings are byte-identical at e5bed71: sha256 eeb5e3e2...,
1,687,723 lines, header `raw 1775366 deployed 1687722 skippedFiles 73`. That is the same-revision
gate, and it holds.

The hash differs from RUST-02's a66a270e... at 71b8df1. If the sequential mutant ids are ignored,
63 rows were added and 37 removed, all in 12 files that contain `#if` blocks. The removed rows had an
empty procedure name. The added rows name the procedure (R301), or are new sites under
split-header procedures and `#if`-wrapped objects (R297, R298). All of these are commits between
71b8df1 and e5bed71, not a parser difference.

W8 is MISSED at S0 on both parsers: native 17,161 MB and WASM 17,847 MB (medians), against the
16,384 MB ceiling. No W8 memory win is claimed. The native median is only 3.8% below WASM, and the
peaks vary a lot from run to run (native 16.4 to 18.6 GB). S4.3 still judges W8 on the final
binary; that does not change this S0 result.

### Attribution at the p5 near-peak (every row is a LEAD, not a measured share)

W8 native. One marked run with full GCs at each phase. The table is taken at the p5 near-peak of
16,577 MB, reached in the manifest-row phase (p5). This is not the whole-run peak: the same run
later reached 16,597 MB at p6 (the manifest write), and the unmarked median is 17,161 MB. The
estimates, the sum, the remainder and the first percentage column all reconcile to the p5 near-peak
(16,577 MB); the second column only restates the same MB against the unmarked median. A second
marked run agrees, with a p5 peak of 15,385 MB.

| lead | estimate MB | % of p5 near-peak (16,577) | % of W8 median | reconciliation |
| --- | ---: | ---: | ---: | --- |
| E. p5 transient: the gap between the p5 phase peak and the p5 post-GC RSS. Lead: the manifest-row loop in `writeInstrumentedProject` (per mutant). Not a measured allocation of that loop | 5,120 | 30.9 | 29.8 | p5 phase peak minus p5 post-GC RSS (other run: 4,652) |
| F. GC capacity held free after a full GC | 3,597 | 21.7 | 21.0 | `heapCapacity` minus `heapSize` at p5; grows with churn in spec generation and p5 |
| A. MutationSpecs with their `before`/`after` wrappers, strings and closures | 2,369 | 14.3 | 13.8 | live cells p4 minus p2; fits inside p5's live cells (3,517); scaled sysapp/do snapshots give 1,805 to 1,932 B per raw site, within 13% of BaseApp |
| C. retained ParsedAL (flat arrays plus sources, 7,106 files) | 1,366 | 8.2 | 8.0 | `extra` at p4, against 30,094,265 nodes x 37 B = 1,062 MB plus 230 MB of sources: within 7% (other run 13%) |
| B. manifest rows, two live copies | 1,192 | 7.2 | 6.9 | 857 MB live-cell growth plus 335 MB external-memory growth from p4 to p5; +3,375,444 objects = 2 x rows |
| D. semantic context | 249 | 1.5 | 1.5 | live cells p2 minus p1 |
| runtime cells | 42 | 0.3 | | |
| sum of leads (at the p5 near-peak) | 13,935 | 84.1 | | |
| unexplained remainder (at the p5 near-peak) | 2,642 | 15.9 | | p5 post-GC RSS minus heap capacity; not allocated to any lead |

W4 native. One marked run, whole-run peak 5,392 MB:

| lead | estimate MB | % of W4 peak | % of W4 median 5,202 |
| --- | ---: | ---: | ---: |
| A. MutationSpecs with their wrappers | 900 | 16.7 | 17.3 |
| the dry-run's own summary and printing, after spec generation | 761 | 14.1 | 14.6 |
| C. retained ParsedAL (nodes x 37 plus sources: 694, +1%) | 699 | 13.0 | 13.4 |
| transient during spec generation | 563 | 10.4 | 10.8 |
| D. semantic context | 104 | 1.9 | 2.0 |
| runtime cells | 36 | 0.7 | 0.7 |
| sum of leads | 3,063 | 56.8 | |
| unexplained remainder (includes GC-held capacity, not read on this run) | 2,329 | 43.2 | |

WASM W4 shows where the W4 win comes from. There the WASM linear memory holds every tree (2.6 GB),
and the semantic phase adds 3.1 GB of cached wrapper objects. Native has neither. The WASM W8
capture uses a flat wrapper like native, and its leads match native's within 0.6 GB per row
(E 5,540, A 1,772, C 1,368, B 1,412).

### PROPOSED S4.2 targets (a template until this amendment is reviewed and committed)

A lead is a candidate if it is reconciled and estimated at 15% or more of the W8 or W4 peak. The
ceilings are not touched. None of these widens S4 into a two-pass redesign.

Correction to the S4.2 template before any S4.2 task opens: its Step 1 text "identity listing
a66a270e unchanged" and its Step 4 check "still has sha256 `a66a270e...`" must read `eeb5e3e2...`
(sha256 eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832, 1,687,723 lines), the
same-revision listing at e5bed71 on both parsers. a66a270e is RUST-02's listing at 71b8df1 and stays
context only.

- **S4.2a, lead E (31% of the W8 p5 near-peak).** Cut the per-mutant allocation in the manifest-row loop:
  compute line numbers from one line-start index per file, test the `local` prefix without taking a
  whole procedure's text, compute each gap block's id once per block rather than once per mutant,
  and stop building child arrays in parent walks. Predicted size after the fix: E at or below
  1,000 MB, and a W8 median peak at or below 13,000 MB. Also recorded, not gating: this loop is 90%
  of W8's wall time today.
- **S4.2b, lead F (22% of the p5 near-peak): a dependent remeasurement and decision gate, not a
  fix of its own.** F is garbage-collector capacity held free after collection, and it grows with
  churn, so the changes that should shrink it are S4.2a and S4.2c. S4.2b runs after both land: it
  re-reads F with the same phase markers (heap capacity minus heap size at p5) on one marked W8
  run, next to the 3 unmarked W8 and W4 runs that S4.2a and S4.2c already take. Its pre-committed
  prediction: F at or below 2,000 MB. Decision: if F is at or below 2,000 MB, S4.2b closes with no
  code. If it is above, S4.2b does not grow a fix inside RUST-03: the miss is recorded in the
  S5 OUTCOME and filed as a roadmap item (`docs/roadmap/R<nnn>.md`, next free id checked first),
  naming F's measured size and the p5 figures.
- **S4.2c, lead A (14% of the W8 p5 near-peak, 17% of the W4 peak).** Stop each spec's `after` node from
  pinning copied `children` and `namedChildren` arrays and a bound `childForFieldName` closure
  (`synthesizeAfter`), and keep one wrapper per spec site. Predicted size after the fix: A at or
  below 1,400 MB on W8 and at or below 550 MB on W4.

Not proposed, because each is under 15% of both peaks: C (8%), B (7%) and D (1.5%). B's second copy
is a cheap follow-up, and the W9 manifest write is S4.1's streamed writer. The unexplained remainder
is never a target by itself.

## AMENDMENT 2 (S1.4 transfer decision)

Measured 2026-09-28 at `e6562c72` with `scripts/measure-peak.ts`, runs interleaved (external,
owned, external, ...), one at a time. "external" is today's `parseFlat` (napi-rs typed arrays,
external buffers). "owned" is a scratch copy of the crate whose `parseFlatOwned` copies each of the
eight numeric arrays into an ArrayBuffer made by `napi_create_arraybuffer`. clang-cl 23.1.2 on
both.

| workload | variant | peak MB (3 runs) | median | wall s (3 runs) | nodes / rows |
| --- | --- | --- | ---: | --- | --- |
| W1, gate2 base shape, no event-loop turn | external | 1,917 / 1,925 / 1,921 | 1,921 | 14.62 / 16.01 / 13.84 | 31,135,464 |
| W1, gate2 base shape, no event-loop turn | owned | 1,252 / 1,255 / 1,255 | 1,255 | 14.24 / 13.81 / 13.88 | 31,135,464 |
| W2, census over BaseApp, scratch `parser.ts` | external | 9,674 / 10,102 / 9,901 | 9,901 | 79.09 / 84.58 / 190.46 | 1,784,261 rows, sha256 153bac07... |
| W2, census over BaseApp, scratch `parser.ts` | owned | 9,980 / 9,987 / 9,627 | 9,980 | 78.99 / 82.36 / 149.91 | 1,784,261 rows, sha256 153bac07... |

The rule, applied: W1 peak median is 34.7% lower (1,255 against 1,921; the bar is at least 20%);
W2 peak median is 0.8% higher (9,980 against 9,901; the bar is not more than 5%); nodes are equal
on W1 (31,135,464 both) and W2's output is byte-identical (sha256
`153bac07df02e98fac91905171f954ae6201a881251909fa416b56172fb9fb9f` on all six runs). All three
hold, so **"owned" replaces "external"** as the only `parseFlat`. The third W2 pair's wall times
are slow on both sides (machine noise); wall is recorded, never gating.

## Clarification to AMENDMENT 2 (2026-09-28)

AMENDMENT 2 names `scripts/measure-peak.ts`; the S1.4 brief and report name RUST-02's `gate2.ts`.
Both were used, one wrapping the other: `measure-peak.ts` spawned the workload and reported its peak
RSS and wall time. The commands, from the worktree root at `e6562c72`:

- W1, external: `bun scripts/measure-peak.ts bun $S/gate2.ts U:/Git/BC.History/BaseApp <vendor lethal-parser.win32-x64.node> base`
- W1, owned: `bun scripts/measure-peak.ts bun $S/gate2.ts U:/Git/BC.History/BaseApp $S/owned.node owned`
- W2, both: `bun scripts/measure-peak.ts bun scripts/census-operator-sites.ts U:/Git/BC.History/BaseApp <out.json>`,
  run inside a scratch worktree whose `parser.ts` loaded `LETHAL_NATIVE_NODE` and called
  `LETHAL_NATIVE_FN` (`parseFlat` from the vendor .node for external, `parseFlatOwned` from
  `$S/owned.node` for owned), with `wrapRoot = wrapFlatRoot`.

`$S/gate2.ts` is RUST-02's `$R2/gate2.ts` with one change: the variant `owned` calls
`b.parseFlatOwned(s)` where `base` calls `b.parseFlat(s)`. Everything else, including the base
shape (all sources read first, no `Bun.gc`, no event-loop turn), is unchanged. `$S/owned.node` is
the scratch crate `$S/crate-owned` (this crate plus `parseFlatOwned`), built with clang-cl 23.1.2.

## AMENDMENT 3 (S3 revisions)

Recorded at S3.4 Step 0, before any S3.4 number is read. It fills in the Same-revision rule's two
placeholders and changes nothing above OUTCOME.

- LethAL S3 base commit: `37190d50aee7f555c59e2e3d3919e1a482595a57` (HEAD before the S3.2 edits).
  The WASM side runs in a scratch worktree at exactly this commit. The native side is this commit's
  child (this amendment, a docs-only commit) plus the uncommitted S3.2 and S3.3 switch; no file
  outside this document differs from `37190d5` apart from the switch itself.
- Corpus revisions (`git -C <corpus> rev-parse HEAD`):
  - BC.History (bcf, sysapp, bsrc, btest, BaseApp): `4d61fc58bc55dd0acb78f8b9b6ea54109b960785`
  - do-rel2 (do): `5f2a71d36215a83fa4a554de90637f151521feb5`
  - DC (dc): `5d1bf414225459aff9e447158b139c6d1702bcc7`
  - BusinessCentral.Sentinel (sentinel): `49af76ae53e96e3eee81eae445252767c2e94e6b`
  Untracked files present at that time, none inside a scanned directory: BC.History `.tmp/`,
  `SubscriptionBilling/Source/Subscription & Recurring Billing/`, `parsed.txt`; do-rel2
  `.promotion-state.json`; DC `Cloud/CLAUDE.md`, `Cloud/Description3_Capture_Solution.md`;
  Sentinel `.caltestrunner/`.
- Native addon under test: `lethal-parser.win32-x64.node`, sha256
  `19f5d477c475df3126791fec516d0a9ed8151f9fd8a1b9d96f3fb425e36aa767`, built at `37190d5` with
  clang-cl 23.1.2 by `scripts/build-native-parser.ts`.

The corpus revisions are re-read after the last native run. A moved corpus voids the comparison,
and it is re-run.

## AMENDMENT 4 (S4.2a prediction)

Recorded before any S4.2a code. It changes nothing above OUTCOME.

- Item: AMENDMENT 1's lead E, the per-mutant allocation in the manifest-row loop of
  `writeInstrumentedProject` (`packages/schemata/src/project.ts`). The change: line numbers from one
  line-start index per file instead of a scan from offset 0 per call; the `local` scope prefix
  tested without taking a whole procedure's text; each gap block's id computed once per block
  rather than once per mutant; no child arrays built in the loop's parent walks. B's second copy
  of the manifest rows (the spread copy in `assignIdentityOrdinals`) is cut in the same loop, as
  the orchestrator asked; it is not part of the E prediction.
- Predicted W8 median peak after the fix (3 runs, `scripts/measure-peak.ts`): at or below
  13,000 MB. Predicted E after the fix: at or below 1,000 MB, read as in AMENDMENT 1 (the p5 phase
  peak minus the p5 post-GC RSS) on one marked W8 run with the S0.2 phase markers. Both are
  AMENDMENT 1's figures, unchanged: 17,161 MB minus the 4,120 MB E should lose is about 13,000 MB.
- Predicted W4 median peak after the fix (3 runs): unchanged, at or below 5,779 MB (AMENDMENT 1's
  highest native W4 run). Derivation: W4 is `run --dry-run`, which runs `dedupeSpecs` and prints; it
  never calls `writeInstrumentedProject`, so the loop is not on W4's path, and AMENDMENT 1's W4
  attribution has no lead E row. The change is confined to `project.ts`, so W4's code path is
  byte-for-byte the same and the predicted saving on W4 is 0 MB.
- The before figures are re-measured at `d945e6f` (the native switch, S3.1 and S4.1 have landed
  since `e5bed71`) with the same harness, 3 runs each, so the before and after sit on one revision
  of everything except the fix. The verdict is against the bounds above, not against the before runs.
- Identity listing eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832
  (1,687,723 lines) unchanged, on the whole BaseApp with the S0.2 capture harness, and
  `fixture-emission.test.ts` unchanged.
- Recorded, not gating: the loop is 90% of W8's wall time today; the W8 wall medians before and
  after are reported next to the peaks.

## AMENDMENT 5 (S4.2a result)

The fix is `167f540c` (AMENDMENT 4's item, and B's second row copy). Before is `d945e6f`, after is
`167f540c`, each with the S0.2 capture harness (`cap-project.diff`, ported by hand onto the fixed
tree: the same 18 changed lines, checked with `diff`) and the unmarked `spec-keys.ts`. Native addon
sha256 `19f5d477...` on both. BC.History `4d61fc58...`, unchanged. One heavy run at a time.

| workload | before, `d945e6f` (peak MB / wall s) | median | after, `167f540c` | median | predicted | result |
| --- | --- | ---: | --- | ---: | --- | --- |
| W8 | 19,532 / 17,539 / 18,780; 1,573 / 1,571 / 1,704 s | **18,780** (1,573 s) | 16,865 / 16,799 / 15,731; 176 / 189 / 186 s | **16,799** (186 s) | at or below 13,000 | **MISSED** |
| W4 | 5,316 / 5,302 / 5,386; 465 / 463 / 452 s | **5,316** (463 s) | 5,383 / 5,384 / 5,298; 463 / 481 / 458 s | **5,383** (463 s) | at or below 5,779 | **MET** |

- Lead E, on one marked W8 run at `167f540c` (S0.2 phase markers): p5 phase peak 14,768 MB, p5
  post-GC RSS 8,933 MB, so E = **5,835 MB** against a predicted 1,000 or less: **MISSED**. It did
  not shrink (AMENDMENT 1: 5,120). p5 now takes 38 s instead of about 1,350 s, so the loop's
  CPU cost went, but its transient memory did not.
- B: from p4 to p5 the `Object` count rises by 1,687,722, one per manifest row (AMENDMENT 1: twice
  that). The second copy is gone.
- W8 wall (recorded, not gating): 1,573 s to 186 s median, 8.5 times faster.
- W4 is unchanged, as predicted: the dry-run does not run the loop. All six W4 outputs are
  byte-identical (788,619 lines, sha256 `f31530b0...`).
- Identity listing: all seven W8 listings (3 before, 3 after, 1 marked) are sha256
  eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832, 1,687,723 lines, header
  `raw 1775366 deployed 1687722 skippedFiles 73`. Unchanged. `fixture-emission.test.ts` passes
  unchanged, and the fixed tree's listings for the five fixtures, do, sysapp, dc, sentinel and bcf
  are byte-identical to S3's.
- A lead, not a measured share (one probe run, not a fix): the same marked W8 run with
  `astSubtreeHash` replaced by an empty string had a p5 phase peak of 12,287 MB over a post-GC RSS
  of 9,068 MB, a transient of 3,219 MB. So the per-mutant subtree hash accounts for about 2.6 GB of
  the remaining E, and about 3.2 GB is still unattributed. The prediction is not revised.

## Clarification to AMENDMENT 5 (2026-09-29)

AMENDMENT 4's fourth item, "no child arrays built in the loop's parent walks", was a measured
no-op, and `167f540c` changed nothing for it. On the native wrapper (`FlatNode`), `parent` is a
stored field, so the loop's parent walks (`enclosingProcedureLike`, `triggerNameOf`,
`enclosingMemberOf`, `gapBlockOf`) build no arrays. The only child-array reads left in the loop
are the split-header procedure paths (`splitIsLocal`, `procedureLikeNameNode`), which are rare.
AMENDMENT 5's figures are unchanged by this note.

## AMENDMENT 6 (S4.2c prediction)

Recorded before any S4.2c code. It changes nothing above OUTCOME.

- Item: AMENDMENT 1's lead A, the spec's `after` node. `synthesizeAfter` (one copy in
  `packages/builtin-tier1/src/mutate-helpers.ts`, one in `packages/builtin-tier2/src/mutate-helpers.ts`)
  builds a plain object that copies `before.children` and `before.namedChildren` (each read builds a
  fresh array of fresh `FlatNode` wrappers on the native tree), both position objects and a bound
  `childForFieldName` closure. The change: the `after` node holds only `before` and its own text and
  reads every other member through `before` when asked, so a spec site keeps one wrapper (`before`)
  and pins no child arrays and no closure. Every member of `ALSyntaxNode` reads the same value as
  before; only `text` differs from `before`, as today.
- Predicted A after the fix, read as in AMENDMENT 1 (live cells, heap minus extra, at p4 minus p2 on
  one marked W8 run; at p3 minus p2 on one marked W4 run): at or below 1,400 MB on W8 and at or below
  550 MB on W4. These are AMENDMENT 1's figures, unchanged. The same-revision A before is read on the
  S4.2a marked tree (`167f540c`, whose source differs from `b4213f23` only by two `export` keywords):
  1,629 MB on W8 (AMENDMENT 5's marked run), and one marked W4 run taken for this item.
- Predicted W8 median peak after the fix (3 runs, `scripts/measure-peak.ts`): at or below
  15,850 MB. Predicted W4 median peak (3 runs): at or below 5,030 MB. Derivation: the saving A should
  lose, by AMENDMENT 1 (2,369 to 1,400 on W8, about 970 MB; 900 to 550 on W4, 350 MB), taken off
  AMENDMENT 5's same-revision medians (W8 16,799, W4 5,383): 16,799 - 950 and 5,383 - 350. A check
  from the scaled sysapp snapshot gives the same size: per spec site the fix drops about 4.5
  `FlatNode` wrappers (61 B each), two arrays, one closure (92 B), two position objects and most of
  a 14-field object, about 600 B, so about 1,000 MB over W8's 1,775,366 raw sites and about 470 MB
  over W4's 782,940. A lives through both peaks (p5 on W8, the dry-run's printing on W4), so the
  whole-run peak should fall by about the same amount. The W8 runs spread 1.1 GB at S4.2a, so the W8
  verdict can be decided by noise; that is recorded, not a reason to widen the bound.
- Identity listing eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832
  (1,687,723 lines) unchanged, on the whole BaseApp with the S0.2 capture harness, and
  `fixture-emission.test.ts` unchanged. The W4 dry-run output unchanged (sha256 `f31530b0...`,
  788,619 lines).

## AMENDMENT 7 (S4.2c result)

The fix is `7cf75051` (AMENDMENT 6's item): `synthesizeAfter` in both tiers now returns the engine's
`withText(before, text)`, which holds `before` and the text and reads every other member through
`before`. After is `7cf75051` with the S0.2 capture harness (`cap-project.diff` ported by the same
script as S4.2a; the ported `project.ts` differs from S4.2a's only by `167f540c..b4213f23`'s two
`export` keywords). Before is S4.2a's after tree (`167f540c`), re-run in the same session after the
after runs. Native addon sha256 `19f5d477...` on both. BC.History `4d61fc58...`. One heavy run at a
time. Harness under `U:/rust03-s42c/`.

| workload | before, `167f540c` (peak MB) | median | after, `7cf75051` (peak MB) | median | predicted | result |
| --- | --- | ---: | --- | ---: | --- | --- |
| W8 | 17,669 / 17,264 / 16,962 | **17,264** | 11,202 / 11,778 / 12,207 | **11,778** | at or below 15,850 | **MET** |
| W4 | 5,360 / 5,304 / 5,387 | **5,360** | 4,737 / 4,524 / 5,043 | **4,737** | at or below 5,030 | **MET** |

- Lead A on W8 (live cells, heap minus extra, p4 minus p2, one marked run each): before 1,629 MB
  (AMENDMENT 5's marked run at `167f540c`: 1,920 minus 291), after **410 MB** (701 minus 291), against
  at or below 1,400: **MET**. Objects at p4: 37,964,548 before, 17,989,154 after.
- Lead A on W4 (live cells, p3 minus p2, one marked run each): before 780 MB (920 minus 140, marked
  run on the `167f540c` tree taken for this item), after **238 MB** (378 minus 140), against at or
  below 550: **MET**.
- The whole-run peaks fell by much more than A's live cells did (W8 median by 5,486 MB, W4 by
  623 MB). On the marked W8 runs, heap capacity at p5 fell from 7,474 to 4,767 MB and the p5 transient
  (E) from 5,835 to 4,038 MB. That is recorded, not attributed: the fix removed about 20 million
  live objects, and both GC-held capacity and the p5 transient move with the live set.
- Identity listing: all seven W8 listings (3 after, 1 marked, 3 before) are sha256
  eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832, 1,687,723 lines, header
  `raw 1775366 deployed 1687722 skippedFiles 73`. Unchanged. All eight W4 outputs are sha256
  `f31530b0...` (788,619 lines). `fixture-emission.test.ts` passes unchanged, and the fixed tree's
  listings for the five fixtures, do, sysapp, dc, sentinel and bcf are byte-identical to S3's.
- The W4 after runs spread 519 MB (4,524 to 5,043); the highest is 13 MB above the W4 bound. The
  verdict is on the median, as committed.

## AMENDMENT 8 (S4.2d prediction)

Recorded before any S4.2d code. It changes nothing above OUTCOME. Evidence:
`.superpowers/sdd/rust-03/probe-e-report.md` (marked W8 runs at `ccb3350f`, 2026-09-29). Reviewed
by the orchestrator (`H:/lethal-coord/reviews/RUST-03-A8/review-r1.md`) before commit.

### Item

`astSubtreeHash` (`packages/engine/src/ast/hash.ts`), called once per mutant from the manifest-row
loop in `writeInstrumentedProject` (`packages/schemata/src/project.ts`, its only product caller).
Today each level of the walk joins its parts into a new string, the whole subtree's canonical string
is encoded to UTF-8 and hashed with BLAKE3, and `namedChildren` is read twice per node, each read
building a fresh array of fresh wrappers (42.8 M wrappers and 23.3 M arrays over 23.1 M visited
nodes on W8).

The change: one pre-order walk that encodes the same canonical fragments, in the same order, into one
reusable byte buffer, and feeds full buffers to noble's incremental `blake3.create().update()`. No
canonical string and no per-level string is built. A fragment is never split across a flush: each
fragment is encoded whole with `TextEncoder.encodeInto`, and if it does not fit in the space left the
buffer is flushed first (a fragment larger than the whole buffer is encoded on its own and fed
directly). So a surrogate pair is never encoded in halves, and the bytes fed to BLAKE3 are the UTF-8
of the same finished string the current code hashes.

On a native `FlatNode` the walk reads the flat tree by index inside
`packages/engine/src/ast/syntax-node.ts`, following `childCount` / `nextSibling` and `FLAG_NAMED`,
and using the same `kind` string, the same text (`source.slice(startIndex, endIndex)`) and the same
child `fieldName` that `FlatNode` exposes. It does not use a field-target test and does not walk
anonymous children. Any other node (a `TextOverride` from `withText`, the WASM reference wrapper)
takes a generic walk over the `ALSyntaxNode` API that reads `namedChildren` once per node and keeps
each wrapper's `fieldName` and child order. For the current wrappers, whose getters are stable, one
read is equivalent to two; nothing is claimed for a caller that supplies changing getters.

### The serialization contract (unchanged; the fix must reproduce it byte for byte)

- Only named children are visited, in their existing order. Anonymous children are ignored.
- An identifier is handled before any child inspection. If its `fieldName` is `member` or
  `function`, it emits `(name <text>)` and is NOT added to the numbering. Any other identifier emits
  `(identifier #<n>)`, where `n` is assigned `0, 1, 2, ...` on the first occurrence of each exact,
  case-sensitive text in pre-order, and a repeated text reuses its number. `n` is written as
  JavaScript's decimal integer interpolation writes it.
- An integer, decimal, text or boolean literal emits `(<kind> <text>)`, even if it has named
  children.
- Any other node with no named children, including a named operator leaf, emits `(<kind> <text>)`.
- Any other node emits `(<kind>`, then for each named child a space and that child's serialization,
  then `)`. Its own text is not used.
- No normalization of any kind: whitespace, newlines, CRLF, case and Unicode are hashed as they are.
  `isMissing` and `hasError` are not serialized; ERROR and MISSING nodes follow the rules above.
- The digest is the lowercase hex of BLAKE3 over the UTF-8 bytes of that string.

### Scope

Nothing else joins S4.2d. No other named cost in the loop reached 15% of the W8 peak: identity
ordinals about 240 MB and the gap walk none measurable, both inside the 945 MB run-to-run spread of E
on the unchanged tree. The unattributed remainder (about 2,150 MB) is not one named cost and is not a
target.

### Predictions

Probe figures (leads, marked W8): E on the unchanged tree 4,064 / 4,197 / 5,009 MB (median 4,197);
with the hash call stubbed to `""` 2,367 / 2,398 MB (median 2,383). The stub's median saving is
4,197 - 2,383 = 1,814 MB. The fix cannot remove everything the stub removed: it keeps the live 64-hex
hash strings, the buffer, the digest objects, and the generic walk where it runs. That is allowed for
at about 500 MB (an allowance, not a measured cost), so the expected saving is about 1,314 MB.

- E after the fix, read as in AMENDMENT 1 (p5 phase peak minus p5 post-GC RSS, one marked W8 run):
  at or below 2,900 MB. This is a RISKY prediction: the expected E is 2,383 + 500 = 2,883, 17 MB
  under the bound, the 500 MB is not measured, and E on the unchanged tree ranged over 945 MB. The
  result is reported as measured, and the bound is never widened after it.
  Same-revision before: the probe's 4,197 MB median at `ccb3350f`. The S4.2d base is the master merge
  `d10f518a`, and `git diff ccb3350f d10f518a` is empty under `packages/engine` and
  `packages/schemata`.
- W8 median peak after the fix (3 unmarked runs, `scripts/measure-peak.ts`): at or below 10,500 MB.
  Derivation: AMENDMENT 7's median 11,778 minus the expected E saving of 1,314 is 10,464, rounded up to
  10,500. The probe also saw the marked whole-run peak fall by about 2.8 GB with the stub, part of it
  post-GC RSS; the stub cannot measure that part for this fix, so it is not taken into the bound. The
  W8 runs spread about 1 GB, so the verdict can be decided by noise; that is recorded, not a reason
  to widen the bound.
- W4, an unchanged-path check: the dry-run never reaches `writeInstrumentedProject`, and
  `astSubtreeHash` has no other product caller. The three-run median (at or below 5,030 MB,
  AMENDMENT 6's bound, unchanged) and the output hash (sha256 `f31530b0...`, 788,619 lines,
  unchanged) decide it together. AMENDMENT 7's W4 runs spread 4,524 to 5,043 MB, so a single run
  above the bound is not a miss.
- Recorded, not gating: the p5 phase took 13 s with the stub against 35 to 39 s on the unchanged
  tree.

### Guards

If any guard fails, S4.2d is DROPPED: it is not patched, no new baseline is accepted, and the drop is
recorded in the S5 OUTCOME (orchestrator ruling, 2026-09-29).

1. A golden test, committed alone before any S4.2d code and shown green on the unchanged
   implementation. Its values are literal hex hashes captured from the current implementation. It
   covers both the flat path (native `FlatNode`) and the generic path, with:
   - identifiers in `member` and in `function` position;
   - numbering first use and reuse, interleaved with names;
   - all four literal kinds;
   - an ordinary named leaf, including an operator;
   - named versus anonymous children;
   - a non-leaf whose own text must be ignored;
   - exact text cases: empty text, CRLF, non-ASCII, a lone surrogate, and a surrogate pair placed
     exactly across the buffer-flush boundary;
   - ERROR and MISSING nodes;
   - a `withText` leaf, so its replacement text is actually hashed.
   If any pinned literal changes after the fix, S4.2d is dropped.
2. A corpus differential, run after the fix: the unchanged implementation (kept as a reference
   function in the test code, not in the product) against the new one on every named node of every
   `.al` file under `fixtures/` (all fixture projects and their test apps) and of one real corpus
   (BC.History `4d61fc58...`, the `sysapp` subset), through both the flat and the generic path, with
   zero differences.
3. Identity listing eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832
   (1,687,723 lines, header `raw 1775366 deployed 1687722 skippedFiles 73`) byte for byte on the
   whole BaseApp with the S0.2 capture harness, on every W8 run. The listing includes `astHash`, so
   one moved byte anywhere drops S4.2d. `fixture-emission.test.ts` unchanged, and
   `fixtures/sandbox-harden/lethal.equivalent.json`'s mark still matches.

## AMENDMENT 9 (S4.2d result)

The fix is `cd717f60` (AMENDMENT 8's item): `astSubtreeHash` walks the subtree once in pre-order,
encodes the canonical fragments into one reusable 4,096-byte buffer (text with
`TextEncoder.encodeInto`, fixed fragments such as kind names and brackets encoded once by the same
encoder and copied), flushes before a fragment that does not fit, feeds a fragment larger than the
buffer on its own, and hashes with noble's `blake3.create().update()`. A native `FlatNode` is walked
by index inside `syntax-node.ts` (`walkNamedFlat`); any other node reads `namedChildren` once. After is
`9d9495b7` (the fix plus test-only commits) with the S0.2 capture harness, ported by the same
scripts as S4.2c. Before, as drift control in the same session, is `e71e809f` (the S4.2d base) for
the unmarked runs and the probe's `base` tree (`ccb3350f`, no product difference) for one marked
run. Native addon sha256 `19f5d477...` on all. BC.History `4d61fc58...`. One heavy run at a time.
Harness under `U:/rust03-s42d/`.

### Guards

| guard | result |
| --- | --- |
| 1. golden test (`815b9db8`, 45 literal hashes, flat and generic paths) | green on the unchanged code, then green UNCHANGED after the fix; no literal changed |
| 2. corpus differential, old reference against new, flat, generic and `withText` paths | `fixtures/`: 68 files, 22,535 nodes (14,863 named), 0 differences. BC.History `sysapp` (`System Application`): 1,718 files, 1,574,911 nodes (983,706 named), 0 differences |
| 3. identity listing on every W8 run | all 8 listings (3 after, 1 marked after, 3 before, 1 marked before) sha256 eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832, 1,687,723 lines, header `raw 1775366 deployed 1687722 skippedFiles 73`. `fixture-emission.test.ts` unchanged and green; `fixtures/sandbox-harden/lethal.equivalent.json`'s mark still matches (`harden-fixture.test.ts` green) |

No guard failed. S4.2d is not dropped.

### Predictions

| prediction | bound (AMENDMENT 8) | measured | result |
| --- | --- | --- | --- |
| E, the risky prediction (one marked W8 run: p5 phase peak minus p5 post-GC RSS) | at or below 2,900 MB | **4,377 MB** (10,596 minus 6,219) | **MISSED** |
| W8 median peak (3 unmarked runs) | at or below 10,500 MB | 14,280 / 11,414 / 12,179: **12,179 MB** | **MISSED** |
| W4 median peak (3 runs) and output hash | at or below 5,030 MB, sha256 `f31530b0...` | 4,517 / 4,741 / 5,068: **4,741 MB**; all 3 outputs sha256 `f31530b0...`, 788,619 lines | **MET** |

Same-session drift control, recorded, not gating:

| workload | before, unchanged | after, `9d9495b7` |
| --- | --- | --- |
| W8 unmarked peaks MB | 11,468 / 13,142 / 12,087 (median **12,087**) | 14,280 / 11,414 / 12,179 (median **12,179**) |
| W8 marked: p5 phase peak / p5 post-GC RSS / E MB | 10,328 / 6,449 / **3,879** | 10,596 / 6,219 / **4,377** |
| W8 marked: heap capacity at p5 MB | 5,222 | 5,195 |
| W8 marked: p4 to p5 duration s | 36 | 32 |

- The fix did not move E or the W8 peak. Before and after differ by less than their own run-to-run
  spread (the unmarked W8 runs spread 2,866 MB after and 1,674 MB before; E on the unchanged tree
  was 4,064 to 5,009 in the probe and 3,879 here). The probe's stub, which removed the hash call,
  its live 64-hex strings and the digests, lowered E to about 2,383 MB; removing only the canonical
  string, the per-level strings and the child wrappers and arrays does not reproduce that. What the
  stub removed beyond this fix is not attributed here.
- The p5 phase got about 4 s faster (36 to 32 s), far less than the stub's 13 s.
- W4's third run (5,068 MB) is above the W4 bound; the verdict is on the median, as committed.

## AMENDMENT 10 (S4.2b gate and S4.3 ceilings)

Measured on the final S4 tree, `5e8a537d` (S4.2a and S4.2c in, S4.2d reverted). Native addon
sha256 `19f5d477c475df3126791fec516d0a9ed8151f9fd8a1b9d96f3fb425e36aa767`, a release build (the
build script always passes `--release`) with clang 23.1.2 (`x86_64-pc-windows-msvc`), built at
`95d31e6a`; `packages/engine/native` and its `Cargo.lock` are unchanged from there to `5e8a537d`.
BC.History `4d61fc58...`. One heavy run at a time, nothing else heavy on the machine. Every peak is
`scripts/measure-peak.ts`; every verdict is on the median of 3 runs, as committed. Harness under
`U:/rust03-s43/`; evidence in `.superpowers/sdd/rust-03/s4-3-report.md`.

### S4.2b: lead F, re-read

One marked W8 run, the same phase markers as S0.2 (a full GC at each marker). At p5: heap capacity
5,267 MB, heap size 3,037 MB, so **F = 2,230 MB**, against the pre-committed bound of at or below
2,000 MB: **MISSED**. S4.2b grows no fix inside RUST-03; the miss is recorded here and in the S5
OUTCOME, and filed as a roadmap item by the controller. The p5 figures, for that item: p5 phase peak
10,663 MB, p5 post-GC RSS 6,454 MB (so E = 4,209 MB), external memory 1,658 MB, 25,518,099 objects;
the marked run's whole peak 10,664 MB. For context only: S4.2c's marked run read F at 1,728 MB and
S4.2d's marked runs at 2,157 (fixed tree, since reverted) and 2,205 (unfixed tree) MB. The listing of
the marked run is the identity listing below.

### S4.3 ceilings

| workload | peaks MB (3 runs) | median peak MB | ceiling MB | result | median wall s |
| --- | --- | ---: | ---: | --- | ---: |
| W2, census over whole BaseApp, one pass | 10,112 / 10,217 / 9,300 | **10,112** | 16,384 | **MET** | 89.63 |
| W4, product dry-run on the Base Application | 4,549 / 5,001 / 5,045 | **5,001** | 16,384 | **MET** | 493.72 |
| W8, spec-level identity capture | 11,798 / 11,300 / 11,936 | **11,798** | 16,384 | **MET** | 182.80 |
| W9, W8's harness with the product manifest writer on | 10,209 / 9,969 / 9,910 | **9,969** | 16,384 | **MET** | 158.56 |

- Every run exits 0. No run crashed.
- **No W8 memory win is claimed.** The W8 median, 11,798 MB, is above the 8,192 MB a win needs. It
  is under the ceiling, and it is 5,363 MB below S0's native median (17,161) and 6,049 MB below S0's
  WASM median (17,847), but a win was pre-committed only at 8,192 MB or below.
- W4 is judged on W4's own runs, not on W2 or W8. W2 is a census result only and is never a W4 or
  product-wide result.
- W9 is judged on W9's own runs. It completes where WASM died at 13.0 GB in `JSON.stringify` (R311).
- Speed, recorded, not gating: W1 parse 15,051 / 15,378 / 15,435 ms (median **15,378 ms**, 9,620
  files, 31,135,464 nodes, peak about 934 MB); W2 wall median 89.63 s; W4 wall median 493.72 s.
  W4's wall is about 104 s above S0's native median (389.99 s); that is recorded, not explained here.

### W9 audit and streaming check

- **Patch audit: PASS**, before any W9 number (`U:/rust03-s43/w9-patch-audit.txt`). The harness
  differs from product code in `project.ts` only, by four hunks: W8's three SPEC_ONLY switches
  (they turn off the object-mix refusal, the instrumented AL and its file write, and the reach
  grain, so rows carry no `reachGrain`), one line printing `W9: deployed <n>` after the rows are built
  (instrumentation, outside the writer), and the one EXEMPT marker line as the first statement of
  `writeManifestJson`. With the marker removed, the harness's `writeManifestJson` and its call site
  are byte-identical to `5e8a537d` (`cmp`, exit 0 on both). W8's NDJSON substitute is not present
  (`grep -in ndjson` over the harness diff prints nothing). Each W9 run's stderr holds the marker
  exactly once, naming `<target>\mutant-manifest.json`.
- **Streaming check: PASS on all 3 W9 manifests.** `@streamparser/json` 0.0.26 (`JSONParser`,
  `paths: ["$.mutants.*"]`, `keepStack: false`, fed from `fs.createReadStream`), installed only in
  scratch. Each manifest: 1,512,104,535 bytes, the parser reaches the end with no error and no
  trailing data, top-level keys `selectorIds`, `artifactId`, `mutants` in that order, 1,687,722 rows
  equal to the run's own `deployed` 1,687,722, and no `mutant-manifest.json.partial` left. Before
  BaseApp, the check passed the sandbox-app manifest (19 rows) and failed all five broken copies:
  truncated by one byte, a comma removed between two rows, a trailing comma after the last row, a bad
  token `tru`, and an extra `}` appended. The sandbox-app manifest holds no `true`, so the bad token
  replaced a number (`"identityOrdinal": 0` became `tru`). Truncating the last byte removes only the
  final newline, which is still valid JSON; the check fails it on its end-of-file test (the product
  writes `JSON.stringify(...)` plus a newline, so the file must end `\n}\n`), not in the parser.

### Identity

All 4 W8 listings (3 unmarked, 1 marked) are sha256
eeb5e3e2987cc0c76913470f5ad755cd711aebdaa955de685ce82ffef98a0832, 1,687,723 lines, header
`raw 1775366 deployed 1687722 skippedFiles 73`, byte-identical to each other. All 3 W4 outputs are
sha256 `f31530b0521ddfc15df717586313b2b354ffb3b7f94cd4b1d21e7d8443acd2c9`, 788,619 lines. All 3 W2
outputs are sha256 `153bac07df02e98f...`, equal to RUST-02's and S3's W2. The harness smoke (the
`System Application` listing) is byte-identical to S3's. Unchanged throughout.
