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
