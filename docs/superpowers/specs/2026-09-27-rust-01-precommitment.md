# RUST-01 pre-commitment: native parser vs WASM

Written and committed at HEAD b030751 (R-236c merged at 71b8df1; later commits on this branch are
roadmap files only) before any native parse, census, dump or run was read. Nothing above OUTCOME
changes after a run.
Design: docs/superpowers/specs/2026-09-27-rust-native-parser-design.md (r2).
Plan: docs/superpowers/plans/2026-09-27-RUST-01-native-parser.md (r2).

**Note, 2026-09-28, coordinator ruling:** identity captured from generated specs before
instrumentation, because instrumentation fails on dc, sysapp, bcf, sentinel and BaseApp (R297,
R298, R299). Mutant identity (astHash, codeunit, procedure or trigger, operator, ordinal) is fixed
at spec generation, which completes on all of them. The capture runs the product's own
`generateMutationSet` and `writeInstrumentedProject` loop, including `assignMutantIds`, the header
attribution and `assignIdentityOrdinals`, with only the instrumentation steps (the object-mix
refusal, `compileSchemataForFile`, the reach-grain components and the instrumented file write)
switched off, and the manifest written as NDJSON because whole BaseApp's manifest does not fit in
one JSON string. The switched-off listing was proven equal to the instrumented listing wherever
instrumentation succeeds (see Q2).

**Note, 2026-09-28, W6:** the live run is pending owner credential fix (q-20260927T221335-fb2ae128).
Cronus28 answered HTTP 401 `Authentication_InvalidCredentials` to the fixture config's user on
2026-09-27. W6's baseline and its ceiling are filled in by an AMENDMENT, committed alone, before
any native W6 run.

## Parsers
| label | what |
| --- | --- |
| wasm | web-tree-sitter 0.25.10 + vendored tree-sitter-al.wasm 4.4.1, sha256 cd6e347e...d085ed099 |
| native | napi-rs addon, tree-sitter =0.25.10 + tree-sitter-al =4.4.1, grammar inputs = the wasm's |

Native build facts recorded by Task 1 (no parse timed): loader variant B; offsets and columns in
UTF-16 code units; napi 3.13.0, napi-derive 3.6.9, napi-build 2.5.0, sha2 0.10.9; grammar sources
hash to upstream v4.4.1's parser.c `0b687fa1...158e22` and scanner.c `346052d7...b990a`.

## Corpora
All fingerprints equal TSAL-441's table.

| key | path | files | sha256 (first 16) |
| --- | --- | ---: | --- |
| do | U:/Git/do-rel2/Cloud | 417 | 9a8e8831449208cc |
| dc | U:/Git/DC/Cloud | 475 | dcad155c4ecdb38e |
| sentinel | U:/Git/BusinessCentral.Sentinel | 67 | 9363656ed52020e0 |
| bcf | U:/Git/BC.History/BusinessFoundation | 104 | a56a8435136fc21f |
| sysapp | U:/Git/BC.History/System Application | 1,718 | 7fae1831fda03a89 |
| bsrc | U:/Git/BC.History/BaseApp/Source | 8,020 | bdfe9cb74e8b8196 |
| btest | U:/Git/BC.History/BaseApp/Test | 1,600 | 044abf731c1e9f05 |
| baseapp | U:/Git/BC.History/BaseApp | 9,620 | 2afad2aa60b13958 |

Base Application project (W4): `U:/Git/BC.History/BaseApp/Source/Base Application`.
Fixture targets: fixtures/sandbox-app, sandbox-data, sandbox-hang, sandbox-harden,
sandbox-coverage-probe.

## Baseline (wasm, median of 3; wall s / peak MB)
| id | workload | result |
| --- | --- | --- |
| W1 | bench-parse BaseApp | parseMs 19,094, walkMs 11,995, nodes 31,135,464, peak 1,148 MB |
| W2 | census BaseApp whole | aborted after 21.26 s (`RuntimeError: Aborted()`, all three runs), peak 4,459 MB |
| W3a | census BaseApp/Source | 161.03 / 16,151 |
| W3b | census do-rel2/Cloud | 4.38 / 908 |
| W4 | run --dry-run Base Application | 414.33 / 16,810 / completes: 5,598 files, 782,911 sites, 748,994 deployed |
| W5 | run --dry-run sandbox-data | 0.36 / 307 |
| W6 | real run sandbox-data --only DataMain.Table.al, selector ids 79399/79398/79397 | pending owner credential fix (q-20260927T221335-fb2ae128) |
| A | bun test | 70.98 / 730 (one run: 3,971 pass, 7 skip, 0 fail) |

The runs shared the machine with other sessions; W1's first run (parseMs 14,325) was faster than
the other two (19,094 and 19,504). W4 does not call `writeInstrumentedProject`, so it does not hit
R298's refusal of `BookingItems.Page.al`.

The 30 GB Bun observation: not reproduced; stays unattributed. `bun test` peaks at 730 MB. W6 is
pending. Leads for Task 10, not chased here: **W4 at 16,810 MB is the best lead on the 30 GB
observation** (the product's own dry-run path on one real app), then W3a at 16,151 MB, and the
whole-BaseApp identity capture at 17,798 MB (a scratch harness, not product use).

## Ceilings (set here, never raised after a native result)
W2: 8,192 MB (the recommended value). W4: 8,192 MB (the recommended value; WASM W4 already peaks
at 16,810 MB, so native W4 must roughly halve it to pass). W6: 110% of the WASM W6 peak, pending
owner credential fix (q-20260927T221335-fb2ae128), fixed by amendment before any native W6 run.

## Keep rule (D3, owner 2026-09-27; gates the switch-over commit)
Keep native only if W2 completes in one pass with peak <= the W2 ceiling. Otherwise revert and fix
R292 in TypeScript. W4 or W6 over its ceiling: no revert, no product memory win claimed, filed.

## Spike STOP (I4)
Native W1 parseMs (parse + flatten + transfer) <= 50% of 19,094 ms, that is <= 9,547 ms, and the
addon loads in dev and inside a --compile binary on Windows. Else STOP; take R292's TypeScript
route.

## Q1. Trees (Task 5)
Lockstep structural walk through ALSyntaxNode, every file of every fixture and corpus, BaseApp
included, field lookups on everywhere: 0 differing nodes, equal kind tables, consistent flat links.

## Q2. Sites, hashes, identities (Task 6, native vs these captures)
Census rows 0 moved on every fixture and on do, dc, sentinel, bcf, sysapp, BaseApp/Source,
BaseApp/Test. Hash listings byte-identical on every fixture. Full identity-key listings
(identityOrdinal included), taken from generated specs as the 2026-09-28 note says, byte-identical
on every fixture, on do, dc, sentinel, bcf and sysapp, and on the WHOLE BaseApp corpus (9,620
files) against the validated WASM capture: `raw 1,775,337 deployed 1,687,696 skippedFiles 73`,
sha256 a66a270e1530907e2b6c2b468b29f409fcd822b2ee92e02e6827bd083c59621b of the listing
(1,687,697 lines with the header line; the capture took 1,819.90 s and peaked at 17,798 MB).

How the capture was validated:
- The spec-level listing equals the instrumented listing, byte for byte, on the five fixtures and
  do (the corpora where instrumentation succeeds); the same patched tree with the switch off
  reproduces the instrumented listing on those six too.
- The NDJSON manifest gives the same listing as the JSON manifest on all ten corpora.
- The materialized capture (WASM parse, tree copied into arrays and freed) equals the normal WASM
  pipeline's spec-level listing, byte for byte, on all ten: sandbox-app, sandbox-data,
  sandbox-hang, sandbox-harden, sandbox-coverage-probe, do, dc, sentinel, bcf, sysapp.
- Whole BaseApp cannot be listed through the normal WASM pipeline: spec generation aborts with
  `RuntimeError: Aborted()` (R292). Its listing exists only through the validated capture.

Spec-level identity counts (normal WASM pipeline): do raw 38,391 / deployed 37,058; dc 102,583 /
97,131; sentinel 1,401 / 1,307; bcf 3,639 / 3,573; sysapp 77,285 / 75,826 (7 files skipped).
No waiver.

## Q3. R-236c scanner (Task 6)
errorOffsets element type at the merge: an object, `ErrorSite { readonly startIndex: number;
readonly text: string }` (testpage-scan.ts line 108), built from the RAW tree-sitter node (`type`,
`isMissing`, `hasError`, `startIndex`, `text`, `children`). Consumers: line 681 (`scanFile` calls
it on `tree.rootNode`), line 333 (`buildUnit`'s `damaged`, through `within`, line 130), line 690
(owner lookup, `within`), line 696 (`SWALLOWS_CODEUNIT.test(e.text)`), line 698 (the suspect
message uses `startIndex`). Kept unchanged. testpage-scan.test.ts passes unchanged. The census
over the ten listed corpora, timing removed, passes r236c-check.ts and is identical to this HEAD's.

r236c-check.ts expects BaseApp refused **11,179**, not the brief's 11,173: 11,173 is the third
run (census doc section 7); the merged commit's latest measurement, section 11 of
`docs/measurements/2026-09-27-r236c-testpage-census.md` (run at 7e52ed8), is 11,179 (section 8
added six). With the brief's figure the check failed on exactly that line; with 11,179 it passes.
All ten corpora: 0 loud errors, 0 threw.

## Q4. Whole BaseApp census (Task 6, first measurement, not a gate)
Completes; differences from the union of the halves are listed as R292's Tier-2 blind spot.

## Q5. Unit suite
Same pass / skip / fail counts as this HEAD (3,971 pass, 7 skip, 0 fail, 3,978 tests in 212
files), plus the tests this plan adds.

## Q6. Reported targets (not gating)
W1 native walkMs; W3a <= 70% of wasm wall and peak <= wasm peak; W5 <= 110% of wasm wall.

## Q7. Landing gates
- itest:bcdev: PASS, 3 / 12 / 4, groupedCalls 15, warmKills 0, screen `vacuous`, per-mutant equal.
- itest:chunked: PASS, both legs 17 / 7 / 2, control warmKills 9 / groupedCalls 33, chunked 5 / 57.
- itest:alrunner: PASS, 3 / 12 / 4 on all four legs, per-mutant equal to one-shot.
- itest:tables: deferred to the combined GH-24 / R-236c check (ruling), unless its baseline was re-recorded before Task 9, in which case PASS with the figures frozen in tables.itest.ts, per-mutant equal.

## Q8. Release (D1)
All five targets build in release CI, each parses fixtures/sandbox-data --dry-run on its own
platform with the same raw and deployed counts as Windows, provenance and notices checks pass, and
no release binary reports DIRTY.

## OUTCOME
(filled in by Task 10)

## Clarification 1 (2026-09-28, before any native timing, memory figure or corpus-scale native parse)
Committed alone. It changes no prediction and no ceiling.
- The header's "before any native parse ... was read" is exact only in this narrower form: before any
  native timing, memory figure, corpus-scale native parse, census, dump or run was read. Task 1 Steps 1
  to 8 had already run native smoke parses and one 38-node native versus WASM tree comparison, and the
  UTF-16 column fact came from that; none of it informs a ceiling (see "Native build facts").
- Why the spec-level capture is safe where instrumentation fails: the four steps the switch turns off
  (the object-mix refusal, compileSchemataForFile, the reach-grain step, the file write) only throw or
  produce output. None of them filters the id-assigned mutant list or changes any input of
  assignIdentityOrdinals (file, startIndex, mutantId, the identity tuple), and identityKeyOf does not
  read reachGrain. So on the refused corpora the listing still comes from the product's own spec,
  id and ordinal code; it describes parser identity, not what the product would instrument there.
- The capture patch scripts are kept beside the session ledger for Task 6, and the whole-BaseApp WASM
  listing (sha256 a66a270e1530907e2b6c2b468b29f409fcd822b2ee92e02e6827bd083c59621b) is kept in scratch
  until Task 6 is done.

## AMENDMENT 1 (2026-09-28, owner decision, before any native timing or memory figure was read)
Committed alone. The D3 keep ceiling for W2 (the whole-BaseApp census, 9,620 files, one pass) is
16,384 MB, replacing 8,192 MB. Owner decision relayed by the coordinator, made after seeing that WASM
already peaks at 16,151 MB on W3a (BaseApp/Source, a subset of W2) and 16,810 MB on W4. The keep rule
is otherwise unchanged: native is kept only if W2 completes in one pass at or under 16,384 MB. The W4
ceiling stays 8,192 MB (not a keep gate: over it means no revert, no product memory win claimed,
filed). The W6 ceiling stays pending the service-tier restart on Cronus28. This ceiling is never raised
after a native result.

## AMENDMENT 2 (2026-09-28, spike result: STOP)
Committed alone. Task 1's spike fails the pre-committed bar in "Spike STOP (I4)"; nothing above
OUTCOME changes. Per that section, the native route stops and R292 takes the TypeScript route.
- Probe D (the failed probe), same corpus and command shape as W1 (`U:/Git/BC.History/BaseApp`,
  9,620 files, via `scripts/measure-peak.ts`), native parse plus flatten plus transfer: parseMs
  34,515 / 34,541 / 29,122, median **34,515 ms** against the bar of <= 9,547 ms (50% of 19,094).
  Native is about 1.8x SLOWER than WASM, not 2x faster. nodes 31,135,464 on every run, equal to W1.
  Peak 1,900 to 1,906 MB, wall 30.29 to 35.70 s.
- Machine check, same session: one WASM W1 run gave parseMs 19,207, nodes 31,135,464, so conditions
  matched the baseline.
- Attribution (Rust only, no Node-API layer, `examples/split.rs`, same corpus): tree-sitter parse
  alone 21,867 ms, flatten 5,584 ms. The parse alone already exceeds WASM's 19,094 ms, so no binding
  or transfer work could meet the bar with this build (MSVC `cl`, `/O2` via the `cc` crate; clang
  was not available to compare).
- Probes A (dev load), B (UTF-16 columns, 0 of 38 nodes differ) and C (variant B builds and parses
  with the file hidden; variant A does not build) passed. Details in
  `.superpowers/sdd/2026-09-27-RUST-01-native-parser/task-1-steps1-8-report.md`.
- `packages/engine/native/` is deleted uncommitted.

## AMENDMENT 3 (2026-09-28, RUST-02, owner bar change, before any MSVC or clang number of RUST-02)
Committed alone, before any number from either build is read. RUST-02 retries the native parser with
two builds of the same crate: the MSVC build (RUST-01's, cl /O2 through the cc crate) and a clang
build (clang-cl 23.1.2, LLVM installed 2026-09-28). The owner's priority, relayed by the coordinator:
1) no crash, 2) lower peak memory, 3) speed. Speed no longer gates. The Spike STOP bar of AMENDMENT 2
(parse median at most 9,547 ms) is replaced for RUST-02 by the two gates below. Both builds are
measured against both gates.

Gate (ii), parse only, first. One pass over all of `U:/Git/BC.History/BaseApp` (9,620 files) through
the native parse call alone, with no census. STOP only if it crashes or its peak exceeds 16,384 MB.
Node counts must equal the WASM parse of the same files (31,135,464 on W1's input). The peak is
recorded against WASM W1's 1,148 MB. Before judging, the cheap layout shrinks are tried (typed arrays,
dropping fields not needed until later, freeing per file). A peak above 1,148 MB is NOT a stop by
itself.

Gate (i), the census, if (ii) passes. A minimal FlatNode implementing ALSyntaxNode and a switch of the
engine's parse interface to native, both uncommitted until GO. GO requires, for at least one build:
native completes W2 (the census over whole BaseApp, 9,620 files) in ONE pass with no crash; its peak
is at most 16,384 MB; nodes equal; and the identity listing equals the WASM spec-level listing
(sha256 a66a270e1530907e2b6c2b468b29f409fcd822b2ee92e02e6827bd083c59621b). The native peak on W3a
(BaseApp/Source, the half WASM completes) is compared with WASM's 16,151 MB: lower is the owner's
memory win and is reported beside the verdict; a GO whose W3a peak is not lower is reported as GO
without a memory win, for the owner to decide.

Recorded, not gating: parse medians over 3 runs and the Rust-only parse time, for each build, with
the compiler, its version and flags.

## RESULT (RUST-02, 2026-09-28)

Full figures: `docs/measurements/2026-09-28-rust-02-native-parser-gates.md`.

**Gate (ii): PASS, both builds.** One pass over whole BaseApp (9,620 files) through the native parse
call alone: no crash, nodes equal WASM (31,135,464) on every run, peak far under the 16,384 MB
ceiling (base peak about 1,906 MB msvc, 1,908 MB clang). The best layout, a harness-only change that
yields the event loop every 100 files, gets both builds under WASM W1's own 1,142 MB peak (827 MB
clang, 835 MB msvc): the base peak is dead transferred typed arrays that Bun frees only on an
event-loop turn, not a crate cost.

**Gate (i): GO, both builds, with a memory win.** The whole-BaseApp census (W2) completes in one
pass on each build with no crash, peak 8,957 MB clang and 8,792 MB msvc against the 16,384 MB
ceiling, nodes equal, and the identity listing byte-identical to the pre-committed WASM capture
(sha256 `a66a270e...`). W3a (BaseApp/Source) peaks at 5,855 MB clang and 5,502 MB msvc against
WASM's 16,151 MB, about a third: the owner's memory win, on both builds. `bun test` under native is
4,081 pass / 7 skip / 1 fail on each build (WASM at the same HEAD: 4,082 / 7 / 0); the one failing
test pins WASM's own `Tree.delete()` mechanism and needs a native form as part of any switch-over,
not a correctness regression in the parser.

Clang is faster throughout (W2 wall 100.05 s against msvc's 129.78 s, Rust-only parse 2.65x faster)
with no memory cost, so clang is preferred if one build is chosen for RUST-03. Speed was recorded
only; it did not gate either verdict, by the amended bar above.

The crate, the `FlatNode` layer and the native-parser switch stay uncommitted in the working tree.
RUST-03 is the switch-over decision: the loader (grammar pin, staleness check, `--compile`
embedding), the one differing unit test, and W4/W6, none of which this session measured.
