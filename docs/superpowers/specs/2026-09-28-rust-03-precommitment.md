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
