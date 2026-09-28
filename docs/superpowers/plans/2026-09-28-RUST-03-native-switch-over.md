# RUST-03: Switch the Parser to the Native Addon, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native Rust (napi-rs) tree-sitter-al addon, built with clang, LethAL's only product parser. Every tree, site, hash, identity key and emitted file must stay byte-identical to the WASM path. The five release targets must be built and parse-tested in CI before any release, and `lethal run --dry-run` on the Base Application must complete under a ceiling that is committed before it is measured.

**Architecture:** RUST-02 left an uncommitted working tree in `U:/Git/LethAL-wt/rust-02`: the crate (`packages/engine/native/`), a minimal `FlatNode`, a scratch loader (`LETHAL_NATIVE_NODE`) and the parse switch. This plan lands that work in six stages. Each stage lands on its own and leaves master green:

- **S0:** the pre-commitment, then Task 0's memory measurement and attribution.
- **S1:** the crate, the real loader and `FlatNode`. WASM is still the product parser.
- **S2:** release CI for five targets.
- **S3:** the equivalence proof, the switch and the R-236c leak test.
- **S4:** memory work on the spec-generation path.
- **S5:** the OUTCOME and the roadmap.

WASM stays in the repo only as the reference instrument (`parser-wasm.ts`). The product has no WASM fallback.

**Tech Stack:** Bun 1.3.14, TypeScript. Rust 1.96 and cargo. `napi` 3, `napi-derive` 3, `napi-build` 2, `tree-sitter =0.25.10`, `tree-sitter-al =4.4.1`, `sha2`. clang from LLVM 23.1.2 on all five targets (`clang-cl` on Windows). GitHub Actions. Cronus28 for the live gates.

**Spec:** `docs/superpowers/specs/2026-09-27-rust-native-parser-design.md` (r3). It is the base design. The RUST-01 plan `docs/superpowers/plans/2026-09-27-RUST-01-native-parser.md` holds code this plan reuses word for word: Tasks 2 to 5 and Task 8. The pre-commitment `docs/superpowers/specs/2026-09-27-rust-01-precommitment.md` has AMENDMENTs 1 to 3. AMENDMENT 3 is `b605cf4`, on branch `lethal/rust-02`. The RUST-02 evidence is in `U:/Git/LethAL-wt/rust-02/.superpowers/sdd/rust-02/gate-i-report.md` and `gate-ii-report.md`. Also read roadmap items R292, R311 and R314.

## Global Constraints

- **The owner's priorities, in this order:** 1) never crash, 2) lower peak RAM, 3) speed. Speed is recorded but never gates.
- **The owner's fixed decisions:** all five targets (`win32-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`) are built and parse-smoke-tested in release CI. This is mandatory before any release. Only CI-built release artifacts ship, and no `.node` file is ever committed. The build uses clang from LLVM 23.1.2 on every target, macOS included, and CI checks each target's compiler and target triple (Task S2.1).
- **No silent WASM fallback in product code.** A missing or mismatched binary throws a typed error that names the platform and the fix. `parser-wasm.ts` is imported only by `scripts/` and by the equivalence tests. It is never imported by `packages/*/src` outside `packages/engine/src/ast/parser-wasm.ts` itself (Task S1.3 adds a test for this).
- **The R-236c tree-leak test is adapted, never deleted or weakened** (Task S3.3).
- **Pre-commitments are committed ALONE, before the numbers they judge.** Nothing above `## OUTCOME` in `docs/superpowers/specs/2026-09-28-rust-03-precommitment.md` changes after a run. A failed prediction gets an `## AMENDMENT`, committed alone. A ceiling is never raised after a native result.
- **Ceilings:** W4 is 16,384 MB. This is the owner's 16 GB ruling, and it replaces RUST-01's 8,192 MB for RUST-03. S0.1 writes it into the pre-commitment BEFORE any W4 measurement, and S4.3 judges W4 against it. The D3 W2 ceiling of 16,384 MB (AMENDMENT 1) is carried forward.
- **Wins are claimed only where they were measured.** A W2 or W3a win is a census win. It is never called a W4 win or a product-wide win. W4 and W9 are judged on their own numbers.
- **Same-revision rule.** Every WASM-against-native comparison uses the same LethAL commit and the same corpus revision on both sides. An old reference hash taken at a different commit is context, not a gate: a difference against it is explained before it is judged, and is not by itself a parser difference.
- **Pins:** grammar inputs `parser.c:0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22;scanner.c:346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a`. Kind table sha256 `65dca121ad7b431ee3427e7c0762eba34b90c4ca9dbd5d11593ea91c126f7d45`. ABI 15. tree-sitter 0.25.10. Grammar 4.4.1. All from RUST-02 gate (ii).
- **Reference numbers:** whole-BaseApp identity listing sha256 `a66a270e1530907e2b6c2b468b29f409fcd822b2ee92e02e6827bd083c59621b` (1,687,697 lines, header `raw 1775337 deployed 1687696 skippedFiles 73`). Node count on W1's input: 31,135,464.
- **The -O3 finding:** clang `/clang:-O3` gives a binary byte-identical to `/O2`. Do not add it.
- **Conventions:** no `!` non-null assertions. Respect `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Typed errors extend `Error` directly. Plain English, no em dashes, in every file and commit message.
- **Build loop:** `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Run biome only on the files you touched.
- **Local builds share one cargo target directory:** `export CARGO_TARGET_DIR=C:/Users/SShadowS/.cache/lethal-native-target/clang`.
- **Baselines:** no baseline is deleted, regenerated or edited. A differing verdict, row, hash or key is a BLOCK.
- **Roadmap:** file items the moment you find them. Run `ls docs/roadmap/` immediately before writing one: R312 and R313 are taken on another worktree, and HEAD moves.
- **Branch:** work in worktree `U:/Git/LethAL-wt/rust-03`, on branch `lethal/rust-03`, cut from `lethal/rust-02` (so AMENDMENT 3, `b605cf4`, comes along) and rebased on master first. Each stage is merged to master on its own.
- **Shell preamble, re-declared in every fresh shell:**

```bash
S=<session scratchpad>/rust03; mkdir -p "$S"; cd /u/Git/LethAL-wt/rust-03
R2=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/rust02
declare -A C=([do]="U:/Git/do-rel2/Cloud" [dc]="U:/Git/DC/Cloud" [sentinel]="U:/Git/BusinessCentral.Sentinel" [bcf]="U:/Git/BC.History/BusinessFoundation" [sysapp]="U:/Git/BC.History/System Application" [bsrc]="U:/Git/BC.History/BaseApp/Source" [btest]="U:/Git/BC.History/BaseApp/Test")
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
BAPP="U:/Git/BC.History/BaseApp/Source/Base Application"
BASEAPP="U:/Git/BC.History/BaseApp"
export CARGO_TARGET_DIR=C:/Users/SShadowS/.cache/lethal-native-target/clang
```

## Workloads (ids used throughout)

| id | workload |
| --- | --- |
| W1 | `bun scripts/bench-parse.ts "$BASEAPP"`: parse only, 9,620 files |
| W2 | `bun scripts/census-operator-sites.ts "$BASEAPP" <out>`: the census over whole BaseApp in one pass |
| W3a | `bun scripts/census-operator-sites.ts "${C[bsrc]}" <out>` |
| W4 | `bun packages/runner/src/cli.ts run --project "$BAPP" --dry-run`: the product dry-run on the Base Application |
| W8 | the spec-level identity capture over whole BaseApp (`$R2/cap-wt` harness: `generateMutationSet`, ids and ordinals, with the manifest written as NDJSON). This is the "spec-generation path" RUST-02 measured at 15,942 MB native (clang) against 17,798 MB for WASM. |
| W9 | the same harness as W8, but with the product's own `writeInstrumentedProject` manifest write left ON. This is the R311 path: WASM died at 13.0 GB in `JSON.stringify`. W8's patch swaps in an NDJSON manifest and turns off parts of instrumentation, so "left ON" is proven, not assumed: the W9 patch audit in S4.3 Step 1 lists every hunk that differs from product code and shows the product manifest writer (`writeManifestJson` after S4.1) is the code that wrote the file. |

Every figure is taken with `bun scripts/measure-peak.ts <cmd>` and reported as the median of 3 runs (peak MB and wall s), unless a step says otherwise.

## Review Focus

1. **A fresh clone, or a release target with no `.node` file.** Expected: `NativeParserMissingError` naming the platform key, the expected path and `bun scripts/build-native-parser.ts`. Never a WASM parse, and never a bare `require` stack trace. Pinned by S1.3 (`loadBindingFor("linux-riscv64")`) and by S2.2 (the per-target compiled-binary smoke test).
2. **A stale local build** (someone edits `lib.rs` without rebuilding). Expected: in source mode, `initParser()` itself throws `NativeParserStaleError` with the rebuild command, so a developer cannot run a stale addon even without running the tests. A binary built for another platform throws `NativeParserPinError` on `target`. Pinned by S1.3's loader tests, which are red-checked.
3. **Non-ASCII, BOM, CRLF, broken and empty files.** Expected: offsets, points, ERROR/MISSING nodes and text equal to WASM, and the R-236c scanner still refuses a test that reaches a damaged codeunit. Pinned by the S1.1 Rust tests and the S3.1 snippet tests.
4. **Memory in a synchronous loop that discards results** (`line-map.ts`, `al-runner-coverage.ts`). Expected: the peak does not climb with file count. Pinned by S1.4's measured decision and by S3.3's leak test.
5. **A whole-BaseApp-sized run.** Expected: W4, W8 and W9 finish with no crash, under their ceilings, or the excess is filed. Never a silent partial manifest. Pinned by S4.1 (the streaming manifest is byte-identical to `JSON.stringify`, and a failed write leaves no file that looks whole) and by the S4.3 measurements, where W9's patch audit proves the product writer ran.

---

## Stage S0: pre-commitment and measurement (lands alone)

### Task S0.1: Write and commit the RUST-03 pre-commitment, alone

**Files:**
- Create: `docs/superpowers/specs/2026-09-28-rust-03-precommitment.md`

- [ ] **Step 1: Set up the worktree.**

```bash
cd /u/Git/LethAL && git worktree add -b lethal/rust-03 /u/Git/LethAL-wt/rust-03 lethal/rust-02
cd /u/Git/LethAL-wt/rust-03 && git rebase master && bun install --frozen-lockfile
git log --oneline -1 --grep "amendment 3"   # expect b605cf4 (or its rebased copy)
```

- [ ] **Step 2: Write the file** with exactly this content. Fill in `<HEAD>` from `git rev-parse --short HEAD`.

```markdown
# RUST-03 pre-commitment: native parser switch-over

Written and committed at <HEAD>, before any RUST-03 measurement is read. Nothing above OUTCOME
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
```

- [ ] **Step 3: Commit it alone.**

```bash
git add docs/superpowers/specs/2026-09-28-rust-03-precommitment.md
git commit -m "spec(RUST-03): pre-commitment, ceilings and switch gates, before any RUST-03 number"
```

### Task S0.2: Measure W4 and W8, WASM against native, and attribute the memory

**Files:** none in the repo. Everything goes under `$S`. The results go into an AMENDMENT in S0.3.

This task answers two questions. Does the product dry-run path gain memory from the native parser? And where do W8's 15.9 GB go?

- [ ] **Step 1: Make a native tree for measuring.** Copy RUST-02's uncommitted files into a scratch worktree at this HEAD. Do not put them in the RUST-03 worktree:

```bash
git worktree add "$S/nat-wt" HEAD && (cd /u/Git/LethAL-wt/rust-02 && git diff) > "$S/rust02.diff"
(cd "$S/nat-wt" && git apply "$S/rust02.diff" && cp -r /u/Git/LethAL-wt/rust-02/packages/engine/native packages/engine/ && cp /u/Git/LethAL-wt/rust-02/packages/engine/src/ast/{native-parser,parser-wasm}.ts packages/engine/src/ast/ && bun install --frozen-lockfile)
git worktree add "$S/wasm-wt" HEAD && (cd "$S/wasm-wt" && bun install --frozen-lockfile)
export LETHAL_NATIVE_NODE="$R2/clang/lethal.node"
sha256sum "$LETHAL_NATIVE_NODE"   # expect f852037b66d13008...
```

- [ ] **Step 2: W4 on both parsers, 3 runs each.**

```bash
for t in wasm nat; do for r in 1 2 3; do (cd "$S/$t-wt" && bun /u/Git/LethAL-wt/rust-03/scripts/measure-peak.ts bun packages/runner/src/cli.ts run --project "$BAPP" --dry-run > "$S/w4-$t-$r.out" 2> "$S/w4-$t-$r.err"); tail -1 "$S/w4-$t-$r.err"; done; done
diff <(grep -vE "ms|seconds" "$S/w4-wasm-1.out") <(grep -vE "ms|seconds" "$S/w4-nat-1.out") && echo "W4 output identical"
```

Expected: every run exits 0. WASM is near 16,810 MB and 414 s. Record the native medians. A differing W4 output is a Q2-class finding: record the first differing line and STOP for the owner.

- [ ] **Step 3: Rebuild W8's harness at this HEAD.** RUST-02 ran the capture from `$R2/cap-wt` at 71b8df1. Re-create it on top of `$S/nat-wt`: apply RUST-01's capture patch, `$R2/cap-wt.diff`, which adds `RUST01_SPEC_ONLY` to `project.ts` and the NDJSON manifest, and copy `$R2/cap-wt/spec-keys.ts`. If the patch does not apply at this HEAD, port it by hand. The rules come from Clarification 1 of the RUST-01 pre-commitment: it turns off only the object-mix refusal, `compileSchemataForFile`, the reach-grain step and the file write.

Build the WASM side at the SAME S0 HEAD (same-revision rule): apply the same patch, plus RUST-01's materialized-capture parse from `$R2/cap-wt.diff`, to `$S/wasm-wt`, giving `$S/wasm-cap-wt`. `$R2/cap-wt` at 71b8df1 is NOT used for any S0 number. Check that the two harness diffs differ only in the parse hunk: `diff <(cd "$S/nat-wt" && git diff) <(cd "$S/wasm-cap-wt" && git diff)` shows only parser lines.

Then validate both on sandbox-app, before any BaseApp run: the native and WASM listings at this HEAD must be byte-identical, with a non-empty header (`raw` and `deployed` above 0) and a line count of `deployed` plus 1. Compare them with RUST-02's 71b8df1 listing (`$R2/ids-*`) too, but only as context: a difference there is explained by the commits in between, not treated as a harness failure.

- [ ] **Step 4: Add phase markers to the scratch harness only.** In `$S/nat-wt` and in a matching WASM harness worktree, `$S/wasm-cap-wt` (the same patch on `$S/wasm-wt`), insert this after each phase of `generateMutationSet`: after Pass 1 (parse), after `buildSemanticContext`, after spec generation, after dedupe and id assignment, and after the manifest write. Insert it into `spec-keys.ts` as well:

```ts
// scratch only: RUST-03 S0.2 phase attribution
import { heapStats } from "bun:jsc";
export function phase(name: string): void {
  // Peak-so-far BEFORE the forced GC: maxRSS is monotonic, so if it rose since the previous
  // marker, this phase set a new process peak and peakSoFarMb is that phase's peak.
  const peakSoFarMb = Math.round(process.resourceUsage().maxRSS / 1024);
  Bun.gc(true);
  const h = heapStats();
  const top = Object.entries(h.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.error(JSON.stringify({ phase: name, peakSoFarMb, rssMb: Math.round(process.memoryUsage().rss / 2 ** 20), heapMb: Math.round(h.heapSize / 2 ** 20), extraMb: Math.round(h.extraMemorySize / 2 ** 20), objects: h.objectCount, top }));
}
```

`scripts/measure-peak.ts` reports ONE whole-run `maxRSS`, read after the child exits. It never samples phases. The phase-tagged figure comes from `peakSoFarMb` above instead: the process's own `maxRSS` read at each marker. First check it is in KB on Windows as it is for `measure-peak.ts`: the last marker's `peakSoFarMb` must be within 5% of the same run's whole-run `peak_mb`. If it is not, drop phase peaks and call every figure a whole-run peak.

- [ ] **Step 5: Run W8 on both, with markers, 1 run each.** Then run W8 without markers, 3 runs each, for the peaks. The markers force full GCs, so their run is only for attribution.

```bash
for t in nat wasm-cap; do (cd "$S/$t-wt" && RUST01_SPEC_ONLY=1 bun /u/Git/LethAL-wt/rust-03/scripts/measure-peak.ts bun spec-keys.ts "$BASEAPP" "$S/w8-$t.txt" 2> "$S/w8-$t-phases.err"); done
cmp "$S/w8-nat.txt" "$S/w8-wasm-cap.txt" && echo "W8 listings identical at this HEAD"
sha256sum "$S/w8-nat.txt"   # RUST-02 at 71b8df1 was a66a270e... (context only)
```

On WASM, W8 needs the materialized-capture parse (RUST-01 capture-wt). The normal WASM pipeline aborts (R292). Use `$S/wasm-cap-wt`, built and validated at this S0 HEAD in Step 3, with the markers added. The gate is native equal to WASM at the same HEAD. If the hash differs from `a66a270e...`, explain it by the commits since 71b8df1; it is not by itself a finding.

- [ ] **Step 6: Take one heap snapshot at the peak phase, on a smaller corpus.** Whole BaseApp is too large to snapshot. Use sysapp (1,718 files) and do (417 files). Write `Bun.generateHeapSnapshot()` to `$S/snap-<corpus>.json` at the phase where W8's RSS peaked. Summarize the retained size by constructor name with a scratch script (`$S/snap-top.ts`: sum `self_size` by node name, top 25). Scale by the site count (sysapp 77,285 raw, BaseApp 1,775,337 raw) to check which object classes account for W8's peak.

- [ ] **Step 7: Write the attribution table** into `$S/attribution.md`. For each phase: post-GC RSS, JS heap, extra (external) memory, and the top object types, for native and for WASM. Add the phase peak: the phase's `peakSoFarMb` where it rose during that phase, else "below an earlier peak". Put it next to the post-GC figure, because a transient peak between two markers is invisible to a post-GC reading. The unmarked runs give only the WHOLE-RUN peak from `measure-peak.ts`, and are labelled that way. The marked run's GCs change the timing, so its phase peaks may sit below the unmarked whole-run peak; report both, never mix them.

Label every row a LEAD, not a measured share. Object counts and `self_size` sums scaled from sysapp and do do not measure BaseApp's retained bytes, and they miss external typed arrays entirely. For each lead, reconcile it before it counts:
  - its estimated bytes must fit inside the phase's (peak RSS minus JS heap) or JS heap, whichever holds that kind of object;
  - external typed arrays (the flat trees) are estimated from `extraMb` and from node count times about 37 bytes, and the two must agree within 25%, or the gap is reported as unexplained;
  - the sum of leads is shown against the phase peak, with the unexplained remainder as its own row. The remainder is never allocated to any lead and never becomes an S4 target by itself.

The verdict names the three largest LEADS at the peak, each with its estimate and its reconciliation. The expected candidates are: the retained `ParsedAL`s (sources plus flat arrays), the semantic context, the `MutationSpec` objects with their `before` nodes and texts, and the manifest rows.

- [ ] **Step 8: Clean up** the scratch worktrees: `git worktree remove --force` on `$S/nat-wt`, `$S/wasm-wt` and `$S/wasm-cap-wt`. Also remove RUST-02's `$R2/cap-wt` and `$R2/head-wt` (RUST-02 concern 6), after S3.2 no longer needs them. Record this in the S5 OUTCOME.

### Task S0.3: AMENDMENT with S0 results (committed alone)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-rust-03-precommitment.md` (append only)

- [ ] **Step 1: Append** `## AMENDMENT 1 (S0 results, before any S4 fix)`. Include the W4 and W8 medians for WASM and native, and the attribution table from S0.2 Step 7, with every row labelled a lead. Then PROPOSE the S4 targets: every reconciled lead estimated at 15% or more of the W8 or W4 peak is a candidate S4.2 sub-task, with a predicted size after the fix. The ceilings are not touched. State W4 against its 16,384 MB ceiling on its own numbers, not inferred from W2, W3a or W8.
- [ ] **Step 2: Review, then commit alone.** Send AMENDMENT 1 for review (the lane's reviewer) before committing it. The S4.2 sub-tasks it proposes stay a template until the reviewed amendment is committed. Do not widen S4 into a two-pass redesign from this attribution: that is its own plan (open question 1). Then: `git commit -m "spec(RUST-03): amendment 1, S0 memory leads for W4 and W8, WASM and native, reviewed"`.
- [ ] **Step 3: File** a roadmap item for anything S0 found that this plan will not fix, for example a retained structure that is not the parser's. Re-check the free id first. Then run `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, and commit.

---

## Stage S1: crate, loader and FlatNode, with WASM still the product parser (lands on its own)

At the end of S1, master builds the native addon in CI and tests it. The product still parses with WASM. `bun test` counts rise only by the tests S1 adds.

### Task S1.1: Land the crate, built with clang, with grammar check, provenance and notices

**Files:**
- Create: `packages/engine/native/{Cargo.toml,Cargo.lock,build.rs,.cargo/config.toml,src/lib.rs,examples/split.rs}` (copied from `U:/Git/LethAL-wt/rust-02/packages/engine/native/`)
- Create: `scripts/check-native-grammar.ts`, `scripts/build-native-parser.ts`, `scripts/native-notices.ts`, `scripts/native-notices.test.ts`, `packages/engine/native/THIRD-PARTY-NOTICES.md` (generated)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `grammarInputs(): string` and `cargoPackages()` (from `check-native-grammar.ts`). `bun scripts/build-native-parser.ts [--test]` writes `packages/engine/vendor/native/lethal-parser.<key>.node` and `.provenance.json`. `nativeInfo().cCompiler: string` (new). `spdxAllowed(expr): boolean`.

- [ ] **Step 1: Copy the crate** and check it is RUST-02's:

```bash
cp -r /u/Git/LethAL-wt/rust-02/packages/engine/native packages/engine/ && rm -rf packages/engine/native/target
sha256sum packages/engine/native/src/lib.rs   # expect 221357a5...
```

- [ ] **Step 2: Write the Rust tests.** Append the `#[cfg(test)] mod tests` block from the RUST-01 plan, Task 2 Step 1 (lines 904 to 958), to `src/lib.rs`, word for word. Then add `tests/tree_freed.rs`. It is an integration test, so it runs in its own process: it proves each call frees its tree inside the call. It counts C heap bytes through tree-sitter's allocator hook.

```rust
//! RUST-03: the native half of R-236c's "every tree released" intent. The tree must be freed
//! inside parse_units, so tree-sitter's live C allocations return to the same level after every
//! call. Own process (integration test), because set_allocator is global.
use std::alloc::{alloc, dealloc, realloc as sys_realloc, Layout};
use std::sync::atomic::{AtomicIsize, Ordering};

static LIVE: AtomicIsize = AtomicIsize::new(0);
const HDR: usize = 16;

unsafe extern "C" fn m(n: usize) -> *mut std::ffi::c_void {
    let p = alloc(Layout::from_size_align_unchecked(n + HDR, HDR));
    *(p as *mut usize) = n;
    LIVE.fetch_add(n as isize, Ordering::SeqCst);
    p.add(HDR) as *mut _
}
unsafe extern "C" fn c(k: usize, n: usize) -> *mut std::ffi::c_void {
    let p = m(k * n) as *mut u8;
    std::ptr::write_bytes(p, 0, k * n);
    p as *mut _
}
unsafe extern "C" fn f(p: *mut std::ffi::c_void) {
    if p.is_null() { return; }
    let base = (p as *mut u8).sub(HDR);
    let n = *(base as *mut usize);
    LIVE.fetch_sub(n as isize, Ordering::SeqCst);
    dealloc(base, Layout::from_size_align_unchecked(n + HDR, HDR));
}
unsafe extern "C" fn r(p: *mut std::ffi::c_void, n: usize) -> *mut std::ffi::c_void {
    if p.is_null() { return m(n); }
    let base = (p as *mut u8).sub(HDR);
    let old = *(base as *mut usize);
    let q = sys_realloc(base, Layout::from_size_align_unchecked(old + HDR, HDR), n + HDR);
    *(q as *mut usize) = n;
    LIVE.fetch_add(n as isize - old as isize, Ordering::SeqCst);
    q.add(HDR) as *mut _
}

#[test]
fn every_call_frees_its_tree() {
    unsafe { tree_sitter::set_allocator(Some(m), Some(c), Some(r), Some(f)) };
    let src: Vec<u16> = "codeunit 50100 X { procedure P() begin if true then exit; end; }".encode_utf16().collect();
    lethal_parser::parse_units(&src); // warm: the thread-local parser allocates once
    let base = LIVE.load(Ordering::SeqCst);
    for _ in 0..1000 {
        let flat = lethal_parser::parse_units(&src);
        assert!(flat.kind.len() > 1);
        assert_eq!(LIVE.load(Ordering::SeqCst), base, "a parse left C memory allocated");
    }
}
```

The crate is `cdylib` plus `rlib`, so the integration test links against the rlib. If `tree_sitter::set_allocator` does not exist in 0.25.10 with this signature, check `cargo doc -p tree-sitter` and adapt the four hook signatures to the ones it exposes. If there is no hook at all, record that in the S1 report and rely on S3.3's JS test alone. Do not drop the JS test in either case.

- [ ] **Step 3: Write `scripts/check-native-grammar.ts`** word for word from the RUST-01 plan, Task 2 Step 2 (lines 963 to 1014). Run `bun scripts/check-native-grammar.ts`. Expected output: `parser.c:0b687f...;scanner.c:346052...`, exit 0.

- [ ] **Step 4: Embed the C compiler in the binary.** In `build.rs`, after the `LETHAL_TARGET` line, add:

```rust
    // RUST-03: which C compiler built the grammar, from the same CC cc-rs will use.
    println!("cargo:rerun-if-env-changed=CC");
    let cc = env::var("CC").unwrap_or_else(|_| panic!("CC is not set: build with `bun scripts/build-native-parser.ts`, which selects clang"));
    let v = Command::new(&cc).arg("--version").output().unwrap_or_else(|e| panic!("cannot run {cc} --version: {e}"));
    let banner = String::from_utf8_lossy(&v.stdout).lines().next().unwrap_or("").trim().to_string();
    println!("cargo:rustc-env=LETHAL_C_COMPILER={banner}");
```

In `lib.rs`, add `pub c_compiler: String,` to `NativeInfo` and `c_compiler: env!("LETHAL_C_COMPILER").to_string(),` to `native_info()`.

- [ ] **Step 5: Write `scripts/build-native-parser.ts`.** Start from the RUST-01 plan, Task 2 Step 4 (lines 1020 to 1076), with three changes:
  - It selects clang.
  - It drops the `cCompiler` probe from the provenance, because `nativeInfo().cCompiler` now carries it.
  - It writes into `CARGO_TARGET_DIR` as given.

  Replace the line `const env = { ...process.env, LETHAL_GRAMMAR_INPUTS: grammarInputs() };` with:

```ts
/** RUST-03: clang on every target. clang-cl on Windows (MSVC ABI), clang elsewhere. LLVM_BIN may
 *  point at a specific install; otherwise PATH. The build refuses a compiler that is not clang. */
function clangCc(): string {
  const exe = process.platform === "win32" ? "clang-cl.exe" : "clang";
  const cc = process.env.LLVM_BIN !== undefined ? join(process.env.LLVM_BIN, exe) : exe;
  const v = Bun.spawnSync([cc, "--version"]);
  const banner = v.stdout.toString().split("\n")[0] ?? "";
  if (v.exitCode !== 0 || !/clang version/.test(banner)) {
    throw new Error(`build-native-parser: ${cc} is not a working clang (${banner || v.stderr.toString().trim()}). Install LLVM 23.1.2 or set LLVM_BIN.`);
  }
  return cc;
}
const cc = clangCc();
const env = { ...process.env, CC: cc, LETHAL_GRAMMAR_INPUTS: grammarInputs() };
```

Also delete the `const cc = Bun.spawnSync(...)` line and the `cCompiler:` field in the provenance object, because `nativeInfo` now includes it.

- [ ] **Step 6: Run the Rust tests, then red-check them.**

```bash
bun scripts/build-native-parser.ts --test
```

Expected: 6 unit tests plus 1 integration test pass. Red-check 1: change `/ 2` to `/ 1` on `end_byte`, and confirm `offsets_are_utf16_code_units` fails, then restore. Red-check 2: in `parse_units`, `std::mem::forget(tree)` instead of letting it drop (return `flatten(&tree)` first), and confirm `every_call_frees_its_tree` fails, then restore.

- [ ] **Step 7: Build and check.** Add these lines to `.gitignore`:

```
packages/engine/native/target/
packages/engine/vendor/native/*.node
packages/engine/vendor/native/*.provenance.json
```

Then build and check:

```bash
bun scripts/build-native-parser.ts
bun -e 'const b=require("./packages/engine/vendor/native/lethal-parser.win32-x64.node"); const i=b.nativeInfo(); console.log(i.cCompiler, i.kindTableSha256, i.languageAbi)'
git status --porcelain | grep -E "\.node|provenance" && echo "LEAK: binary tracked" || echo "no binary tracked"
```

Expected: `clang version 23.1.2 ...`, `65dca121...`, `15`, and `no binary tracked`.

- [ ] **Step 8: Notices.** Write `scripts/native-notices.test.ts` and `scripts/native-notices.ts` word for word from the RUST-01 plan, Task 2 Steps 7 and 8 (lines 1099 to 1214). Then run `bun test scripts/native-notices.test.ts`: 11 pass. Red-check: make `andExpr` combine with `||`, and confirm the `AND` cases fail, then restore. Then run `bun scripts/native-notices.ts && bun scripts/native-notices.ts --check`, which should exit 0. A refused license means STOP and ask. Never widen the allowlist.

- [ ] **Step 9: Commit.**

```bash
bunx biome check scripts/check-native-grammar.ts scripts/build-native-parser.ts scripts/native-notices.ts scripts/native-notices.test.ts
git add .gitignore packages/engine/native scripts/check-native-grammar.ts scripts/build-native-parser.ts scripts/native-notices.ts scripts/native-notices.test.ts
git commit -m "feat(RUST-03): native tree-sitter-al addon, clang build, grammar check, embedded provenance incl. C compiler, notices"
```

### Task S1.2: CI builds the addon with clang before the unit suite

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Insert this before `Typecheck`:**

```yaml
      - uses: dtolnay/rust-toolchain@1.96.0
      - name: LLVM 23.1.2 (clang-cl builds the grammar)
        uses: KyleMayes/install-llvm-action@v2
        with:
          version: "23.1.2"
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            packages/engine/native/target
          key: native-${{ runner.os }}-${{ hashFiles('packages/engine/native/Cargo.lock', 'packages/engine/native/src/**', 'packages/engine/native/build.rs') }}
      - name: Build the native parser (grammar check, clang, provenance)
        shell: bash
        run: CARGO_TARGET_DIR=packages/engine/native/target LLVM_BIN="$LLVM_PATH/bin" bun scripts/build-native-parser.ts
      - name: Native Rust tests
        shell: bash
        run: CARGO_TARGET_DIR=packages/engine/native/target LLVM_BIN="$LLVM_PATH/bin" bun scripts/build-native-parser.ts --test
      - name: Native notice inventory is current
        run: bun scripts/native-notices.ts --check
```

`LLVM_PATH` is set by the install action. If the action does not publish 23.1.2 for Windows, install it with `choco install llvm --version=23.1.2 -y` and set `LLVM_BIN: C:/Program Files/LLVM/bin`. Record which one worked.

- [ ] **Step 2: Push the branch, and confirm CI is green** with the log line `clang version 23.1.2`. Commit: `ci(RUST-03): build and test the native parser with clang before the unit suite`.

### Task S1.3: WASM becomes the reference module; `isMissing` / `hasError`; the real loader (not yet wired)

**Files:**
- Create: `packages/engine/src/ast/parser-wasm.ts`, `packages/engine/src/ast/native-parser.ts`
- Modify: `packages/engine/src/ast/parser.ts`, `packages/engine/src/ast/syntax-node.ts`, `packages/builtin-tier1/src/mutate-helpers.ts`, `packages/builtin-tier2/src/mutate-helpers.ts`, `packages/schemata/src/compile.ts`, `packages/schemata/tests/dedup.test.ts`, `scripts/build-binary.ts`
- Modify (imports only): `scripts/lib/grammar-crosscheck.ts`, `scripts/lib/grammar-crosscheck.test.ts`, `scripts/probe-grammar-corpus.ts`, `scripts/probe-grammar-crosscheck.ts`, `scripts/r159-remainder-census.ts`, plus anything Step 1 finds
- Test: `packages/engine/tests/ast/native-binding.test.ts`, `packages/engine/tests/ast/no-wasm-in-product.test.ts`

**Interfaces:**
- Produces:
  - `ALSyntaxNode.isMissing` and `ALSyntaxNode.hasError` (both `boolean`).
  - From `parser-wasm.ts`: `initWasmParser()`, `parseALWasm(source): Tree`, `wrapWasmRoot(tree): ALSyntaxNode`, `wasmLanguage(): Language`.
  - From `native-parser.ts`: `NativeInfo` (with `cCompiler`), `NativeBinding`, `NativeParserMissingError`, `NativeParserPinError`, `NativeParserStaleError`, `GRAMMAR_PIN`, `EXPECTED_TARGET`, `localBindingSourceSha256(crateDir)`, `loadBindingFor(key)`, `initNativeParser()`, `parseALNative(source): ParsedAL`, `nativeInfo()`, `liveParseResults(): number`, `parsesSinceStart(): number`.
  - Init checks, in order: grammar pins, then `nativeInfo().target` against `EXPECTED_TARGET[process.platform-process.arch]`, then (source mode only) `bindingSourceSha256` against the local crate. No WASM fallback on any failure.
  - From `syntax-node.ts`: `FlatTree`, `ParsedAL`, and `FLAG_*`.
- `parser.ts` stays on WASM in S1.

- [ ] **Step 1: Search every caller.**

```bash
grep -rnE "parseAL|initParser|wrapRoot|rootNode|descendantsOfType|hasError|isMissing|\.delete\(\)|web-tree-sitter|ReturnType<typeof parseAL>" --include=*.ts packages scripts | grep -v node_modules | grep -v /dist/ > "$S/callers.txt"; wc -l "$S/callers.txt"
```

Classify every line in the task report into one of three groups:
  - **Ordinary:** `wrapRoot(parseAL(...))`, or `parseAL` followed immediately by `wrapRoot`, as in `operator-sdk/src/conformance.ts`. These stay unchanged.
  - **Grammar instrument:** these move to `parser-wasm`.
  - **Product raw-tree use:** these are ported in S3. `runner/src/testpage-scan.ts` and its test are expected here.

An unclassified line blocks the task.

- [ ] **Step 2: `parser-wasm.ts` and the interface fields.** Apply RUST-02's versions:

```bash
cp /u/Git/LethAL-wt/rust-02/packages/engine/src/ast/parser-wasm.ts packages/engine/src/ast/
```

Then check that it holds today's `parser.ts` body renamed (`initWasmParser`, `parseALWasm`), `WrappedNode` as `wrapWasmRoot` with `isMissing` / `hasError`, and the header line "Reference only since RUST-01 ...". Add `wasmLanguage()` as in the RUST-01 plan, Task 3 Step 2 (lines 1249 to 1256), if it is missing.

In `syntax-node.ts`:
  - Add `isMissing` and `hasError` to `ALSyntaxNode`, plus the `FlatTree`, `ParsedAL` and `FLAG_*` declarations (RUST-02's diff).
  - Remove `WrappedNode` and the `web-tree-sitter` import.
  - For S1, add `export { wrapWasmRoot as wrapRoot } from "./parser-wasm";`.

`parser.ts` becomes this one re-export:

```ts
// The engine's parse entry point. Backed by the WASM reference until the RUST-03 switch (S3.4).
export { initWasmParser as initParser, parseALWasm as parseAL } from "./parser-wasm";
```

Also apply RUST-02's synthetic-node hunks (the `synthesizeAfter` functions in both tiers copy `isMissing` and `hasError` from `before`; `insertionNodeAt` and the dedup fake set `false`), and the instrument import changes. Take them from `$S/rust02.diff`.

- [ ] **Step 3: Nothing moved.** Run `bun run typecheck && rm -rf packages/*/dist && bun test`. Expected: counts equal to the S0.1 HEAD. Record the pass/skip/fail line.

- [ ] **Step 4: Write the failing tests.** For `packages/engine/tests/ast/native-binding.test.ts`, use the RUST-01 plan, Task 3 Step 6 (lines 1301 to 1354), with these changes:
  - Replace the test's own `bindingSourceSha256` helper with `localBindingSourceSha256` from `native-parser.ts`, so the loader and the test share one definition of the hash. It covers `["Cargo.toml", "Cargo.lock", "build.rs", "src/lib.rs"]`, as `build.rs`'s `SOURCES`.
  - Add these loader tests. They use a fake binding, so they need no rebuild. To make that possible, split `checkedBinding()` so its checks live in an exported `checkBinding(b: NativeBinding, key: string, crateDir: string | null): void` (null means compiled mode, no staleness check), and have `checkedBinding()` call it:

```ts
  const real = () => nativeInfo();
  const fake = (over: Partial<NativeInfo>): NativeBinding => ({
    parseFlat: () => { throw new Error("not called"); },
    nativeInfo: () => ({ ...real(), ...over }),
  });
  const crate = join(import.meta.dir, "..", "..", "native");
  const key = `${process.platform}-${process.arch}`;

  it("source mode refuses an addon built from other crate sources", () => {
    expect(() => checkBinding(fake({ bindingSourceSha256: "0".repeat(64) }), key, crate)).toThrow(NativeParserStaleError);
  });
  it("compiled mode does not read the crate", () => {
    expect(() => checkBinding(fake({ bindingSourceSha256: "0".repeat(64) }), key, null)).not.toThrow();
  });
  it("refuses an addon built for another platform or arch", () => {
    expect(() => checkBinding(fake({ target: "aarch64-unknown-linux-gnu" }), "win32-x64", crate)).toThrow(NativeParserPinError);
  });
  it("the real addon passes every check", () => {
    expect(() => checkBinding(loadBindingFor(key), key, crate)).not.toThrow();
  });
```
  - Add this test:

```ts
  it("was built by clang (release rule)", () => {
    expect(nativeInfo().cCompiler).toMatch(/clang version/);
  });
```

  - Add this test, which pins the counter S3.3 relies on:

```ts
  it("counts live parse results and releases them after GC", async () => {
    await initNativeParser();
    const before = liveParseResults();
    const t0 = parsesSinceStart();
    (() => {
      for (let i = 0; i < 200; i++) parseALNative("codeunit 50100 X { }");
    })();
    expect(parsesSinceStart() - t0).toBe(200); // monotonic: a GC during the loop cannot lower it
    expect(liveParseResults()).toBeGreaterThanOrEqual(before + 1);
    for (let k = 0; k < 20 && liveParseResults() > before + 5; k++) {
      Bun.gc(true);
      await new Promise((r) => setImmediate(r));
    }
    expect(liveParseResults()).toBeLessThanOrEqual(before + 5);
  });
```

  Import `liveParseResults`, `parsesSinceStart`, `checkBinding`, `loadBindingFor`, `NativeParserStaleError`, `NativeParserPinError`, `NativeInfo` and `NativeBinding` too.

Then write `packages/engine/tests/ast/no-wasm-in-product.test.ts`:

```ts
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

// RUST-03: WASM is a reference instrument. No product source may import it, so a missing native
// binary can never be papered over by a silent WASM parse.
it("no product source imports parser-wasm or web-tree-sitter", () => {
  const root = join(import.meta.dir, "..", "..", "..", "..");
  const hits: string[] = [];
  for (const f of new Glob("packages/*/src/**/*.ts").scanSync(root)) {
    if (f.replaceAll("\\", "/").endsWith("engine/src/ast/parser-wasm.ts")) continue;
    const text = readFileSync(join(root, f), "utf8");
    if (/from\s+["'][^"']*(parser-wasm|web-tree-sitter)["']/.test(text)) hits.push(f);
  }
  expect(hits).toEqual([]);
});
```

This test FAILS in S1 on purpose, because `parser.ts` and `syntax-node.ts` still re-export WASM. Mark it `it.todo` in S1, with the comment `// becomes it() in S3.4, the switch`. S3.4 flips it to `it`.

- [ ] **Step 5: Write `native-parser.ts`.** It uses loader variant B: RUST-01 Probe C proved variant A fails to build under `--compile` (R314).

```ts
/**
 * RUST-03: loads the native tree-sitter-al addon and checks it against the pinned grammar.
 * No WASM fallback: a missing or mismatched binary throws (design section 7).
 * Loader variant B (R314): `bun build --compile` embeds the .node only through a require whose
 * path is a template over a build-time define; source mode resolves the running platform's key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlatTree, ParsedAL } from "./syntax-node";

export interface NativeInfo {
  readonly bindingSourceSha256: string;
  readonly grammarInputs: string;
  readonly grammarVersion: string;
  readonly treeSitterVersion: string;
  readonly languageAbi: number;
  readonly kindTableSha256: string;
  readonly rustcVersion: string;
  readonly target: string;
  readonly cCompiler: string;
}

export interface NativeBinding {
  parseFlat(source: string): FlatTree;
  nativeInfo(): NativeInfo;
}

export const GRAMMAR_PIN = {
  grammarVersion: "4.4.1",
  treeSitterVersion: "0.25.10",
  languageAbi: 15,
  kindTableSha256: "65dca121ad7b431ee3427e7c0762eba34b90c4ca9dbd5d11593ea91c126f7d45",
  grammarInputs:
    "parser.c:0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22;scanner.c:346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a",
} as const;

export class NativeParserMissingError extends Error {
  constructor(
    readonly platformKey: string,
    cause: unknown,
  ) {
    super(
      `LethAL's native AL parser has no binary for ${platformKey}. Expected packages/engine/vendor/native/lethal-parser.${platformKey}.node; build it with \`bun scripts/build-native-parser.ts\` (needs Rust and LLVM clang), or use a release binary.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "NativeParserMissingError";
  }
}

export class NativeParserPinError extends Error {
  constructor(field: string, expected: string, actual: string) {
    super(
      `LethAL's native AL parser reports ${field} ${actual}, but the engine is pinned to ${expected}. Rebuild it with \`bun scripts/build-native-parser.ts\`.`,
    );
    this.name = "NativeParserPinError";
  }
}

export class NativeParserStaleError extends Error {
  constructor(built: string, local: string) {
    super(
      `LethAL's native AL parser was built from sources with sha256 ${built}, but packages/engine/native now hashes to ${local}. Rebuild it with \`bun scripts/build-native-parser.ts\`.`,
    );
    this.name = "NativeParserStaleError";
  }
}

/** Platform key -> the Rust target triple the addon must report (build.rs LETHAL_TARGET). */
export const EXPECTED_TARGET: Readonly<Record<string, string>> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

/** The same hash build.rs computes over SOURCES: name, "\n", text without "\r", "\n", per file.
 *  Exported so native-binding.test.ts uses the one definition. */
export function localBindingSourceSha256(crateDir: string): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of ["Cargo.toml", "Cargo.lock", "build.rs", "src/lib.rs"]) {
    h.update(`${f}\n${readFileSync(join(crateDir, f), "utf8").replaceAll("\r", "")}\n`);
  }
  return h.digest("hex");
}

declare const __LETHAL_NATIVE_KEY__: string;

export function loadBindingFor(key: string): NativeBinding {
  try {
    const loaded: unknown =
      typeof __LETHAL_NATIVE_KEY__ !== "undefined"
        ? require(`../../vendor/native/lethal-parser.${__LETHAL_NATIVE_KEY__}.node`)
        : require(`../../vendor/native/lethal-parser.${key}.node`);
    if (loaded === undefined || loaded === null) throw new NativeParserMissingError(key, undefined);
    return loaded as NativeBinding;
  } catch (cause) {
    if (cause instanceof NativeParserMissingError) throw cause;
    throw new NativeParserMissingError(key, cause);
  }
}

let binding: NativeBinding | null = null;

function checkedBinding(): NativeBinding {
  if (binding !== null) return binding;
  const key = `${process.platform}-${process.arch}`;
  const b = loadBindingFor(key);
  checkBinding(b, key, typeof __LETHAL_NATIVE_KEY__ === "undefined" ? join(import.meta.dir, "..", "..", "native") : null);
  binding = b;
  return b;
}

/** Every init check. crateDir null = compiled mode (the release binary has no crate on disk and
 *  was checked in CI); otherwise source mode, which also refuses a stale build. */
export function checkBinding(b: NativeBinding, key: string, crateDir: string | null): void {
  const info = b.nativeInfo();
  for (const k of ["grammarVersion", "treeSitterVersion", "languageAbi", "kindTableSha256", "grammarInputs"] as const) {
    if (info[k] !== GRAMMAR_PIN[k]) throw new NativeParserPinError(k, String(GRAMMAR_PIN[k]), String(info[k]));
  }
  // The compiled binary embeds its own key, so loadBindingFor ignores `key` there: check that the
  // addon was built for the platform and arch this process is actually running on.
  const want = EXPECTED_TARGET[key];
  if (want === undefined || info.target !== want) throw new NativeParserPinError("target", want ?? `a supported target for ${key}`, info.target);
  // Source mode only: refuse an addon built from other crate sources, so a developer cannot run a
  // stale build without running the tests. A missing crate file throws from readFileSync (loud).
  if (crateDir !== null) {
    const local = localBindingSourceSha256(crateDir);
    if (info.bindingSourceSha256 !== local) throw new NativeParserStaleError(info.bindingSourceSha256, local);
  }
}

export function initNativeParser(): Promise<void> {
  checkedBinding();
  return Promise.resolve();
}

export function nativeInfo(): NativeInfo {
  return checkedBinding().nativeInfo();
}

// RUST-03 (S3.3): how many parse results are still reachable. A diagnostic, not a cache: the
// registry holds no reference to what it watches.
// parsesSinceStart is monotonic: it never falls, so a test can read "the scan really parsed n
// files" without racing a GC that finalizes results during the scan.
let live = 0;
let total = 0;
const released = new FinalizationRegistry<undefined>(() => {
  live--;
});

export function liveParseResults(): number {
  return live;
}

export function parsesSinceStart(): number {
  return total;
}

export function parseALNative(source: string): ParsedAL {
  if (binding === null) throw new Error("native parser not initialized, call initParser() first");
  const parsed: ParsedAL = { source, flat: binding.parseFlat(source) };
  live++;
  total++;
  released.register(parsed, undefined);
  return parsed;
}
```

In `scripts/build-binary.ts`, add `--define=__LETHAL_NATIVE_KEY__=${JSON.stringify(key)}` for each target, next to the existing `__LETHAL_BUILD_*__` defines. Map `key` from each `BuildTarget`: `bun-windows-x64` to `win32-x64`, `bun-linux-x64` to `linux-x64`, `bun-linux-arm64` to `linux-arm64`, `bun-darwin-x64` to `darwin-x64`, and `bun-darwin-arm64` to `darwin-arm64`. Add the key as a field `nativeKey` on each `TARGETS` entry, not as a separate map.

- [ ] **Step 6: Run the tests.** `bun test packages/engine/tests/ast/native-binding.test.ts`: 10 pass.
  - Red-check the init-time staleness check: add a comment line to `src/lib.rs` without rebuilding, and confirm `bun -e 'await (await import("./packages/engine/src/ast/native-parser.ts")).initNativeParser()'` throws `NativeParserStaleError` with the rebuild command. Then remove the line.
  - Red-check the check itself: delete the `if (crateDir !== null)` block, confirm "source mode refuses an addon built from other crate sources" fails, then restore.
  - Red-check the target check: delete the `EXPECTED_TARGET` comparison, confirm "refuses an addon built for another platform or arch" fails, then restore.
  - Red-check the counters: comment out `live++`, confirm the counter test fails, then restore. Comment out `total++`, confirm it fails, then restore.

- [ ] **Step 7: Commit.**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/engine/src/ast packages/engine/tests/ast scripts/build-binary.ts <the files from Step 1>
git add packages/engine/src/ast packages/engine/tests/ast packages/builtin-tier1/src/mutate-helpers.ts packages/builtin-tier2/src/mutate-helpers.ts packages/schemata/src/compile.ts packages/schemata/tests/dedup.test.ts scripts/build-binary.ts <the files from Step 1>
git commit -m "refactor(RUST-03): WASM parser is a reference module; isMissing/hasError on ALSyntaxNode; native loader (variant B) with pin and live-result counter"
```

### Task S1.4: FlatNode, and the transfer-buffer decision

**Files:**
- Modify: `packages/engine/src/ast/syntax-node.ts`, and `packages/engine/native/src/lib.rs` only if Step 5 keeps "owned"
- Test: `packages/engine/tests/ast/flat-node.test.ts`

**Interfaces:**
- Consumes: `FlatTree`, `ParsedAL`, `FLAG_*`.
- Produces: `wrapFlatRoot(parsed: ParsedAL): ALSyntaxNode`.

- [ ] **Step 1: Write the failing test** word for word from the RUST-01 plan, Task 4 Step 1 (lines 1526 to 1582). Then add one case for every `ALSyntaxNode` member that the plan's test does not touch, so every member is covered:

```ts
  it("covers every ALSyntaxNode member", () => {
    const [x, plus] = root.children;
    expect(root.kind).toBe("r");
    expect(root.startPosition).toEqual({ row: 0, column: 0 });
    expect(x?.startPosition).toEqual({ row: 0, column: 0 });
    expect(x?.endPosition).toEqual({ row: 0, column: 1 });
    expect(plus?.fieldName).toBeNull();
    expect(plus?.hasError).toBe(false);
    expect(x?.namedChildren).toEqual([]);
    expect(x?.childForFieldName("left")).toBeNull();
  });
```

Check that the list is complete: `grep -n "readonly\|(" packages/engine/src/ast/syntax-node.ts` inside `interface ALSyntaxNode`. Every member must appear in some assertion.

- [ ] **Step 2: Run it:** it FAILS, because `wrapFlatRoot` is not exported.
- [ ] **Step 3: Implement it.** Paste the `at` helper, `FlatNode` and `wrapFlatRoot` from RUST-02's `syntax-node.ts` diff, which matches the RUST-01 plan, Task 4 Step 3. In S1, `wrapRoot` stays the WASM re-export.
- [ ] **Step 4: Run it:** 6 pass. Red-check: make `childNodes` ignore `namedOnly`, and confirm the named-children test fails, then restore.

- [ ] **Step 5: The transfer-buffer decision.** This follows the pre-committed rule in the RUST-03 pre-commitment. RUST-02 gate (ii) found that napi-rs typed arrays are external buffers. Bun frees them only when the event loop turns, so a synchronous loop that throws results away carries about 1.2 GB of dead arrays over BaseApp. The "owned" variant copies each array into an `ArrayBuffer` that the JS engine allocates, so it is freed by a GC sweep, with no finalizer and no loop turn. Build it as a SCRATCH copy of the crate first (`$S/crate-owned`, never in the worktree), exporting `parseFlatOwned`:

```rust
use napi::{bindgen_prelude::*, sys, Env, JsUnknown};

/// Copy `bytes` into an ArrayBuffer the JS engine owns (napi_create_arraybuffer), then view it.
fn owned_view(env: &Env, bytes: &[u8], ty: sys::napi_typedarray_type, elem: usize) -> Result<sys::napi_value> {
    unsafe {
        let mut data = std::ptr::null_mut();
        let mut ab = std::ptr::null_mut();
        check_status!(sys::napi_create_arraybuffer(env.raw(), bytes.len(), &mut data, &mut ab))?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data as *mut u8, bytes.len());
        let mut view = std::ptr::null_mut();
        check_status!(sys::napi_create_typedarray(env.raw(), ty, bytes.len() / elem, ab, 0, &mut view))?;
        Ok(view)
    }
}
```

`parseFlatOwned(env, source)` builds the same object as `parse_flat`, field by field, with `owned_view` for the eight numeric arrays: `kind` and `field` as `uint16`, `flags` as `uint8`, `childCount`, `startIndex`, `endIndex` and `points` as `uint32`, and `nextSibling` as `int32`. It returns it as a `JsUnknown`. If the napi-rs 3 API names differ (`env.raw()`, `JsUnknown`), use its equivalents. The semantics must stay: engine-owned memory plus a copy.

Measure with `$R2/gate2.ts`: the base shape, with no yield. Run 3 each for "external" (current) and "owned", on W1's input. Then W2, 3 each, through a scratch `parser.ts` pointing at each variant. Apply the rule exactly. If "owned" wins, move it into `src/lib.rs` as the only `parseFlat`, re-run S1.1 Step 6 and S1.3 Step 6, and record the numbers. Otherwise leave the crate unchanged and record why. In both cases, append the result to the pre-commitment as `## AMENDMENT 2 (S1.4 transfer decision)` and commit it alone.

- [ ] **Step 6: Commit** FlatNode, plus the crate change if "owned" was kept:

```bash
bunx biome check packages/engine/src/ast/syntax-node.ts packages/engine/tests/ast/flat-node.test.ts
git add packages/engine/src/ast/syntax-node.ts packages/engine/tests/ast/flat-node.test.ts
git commit -m "feat(RUST-03): FlatNode, the ALSyntaxNode over a native flat tree, every member tested"
```

### Task S1.5: Pin all five fixtures' emitted output under WASM (for Q3)

**Files:**
- Modify: `packages/runner/tests/fixture-emission.test.ts`

- [ ] **Step 1: Extend the test** from `sandbox-app` alone to all five fixtures (`$F`). Keep the same fixed artifact id and the same "every emitted file except `app.json`, by sha256" rule. Structure it as `const PINNED: Record<string, { selectorIds: {...}; hashes: Record<string, string> }>`, keyed by fixture, and use one `test()` per fixture. Keep sandbox-app's existing selector ids (79199 / 79198 / 79197) and hashes unchanged.

  Selector ids are chosen PER FIXTURE, inside that fixture's own `app.json` `idRanges`, so the emitted output is output a real run could produce. Take the top three ids of each range (selector = `to`, control = `to - 1`, table = `to - 2`):

  | fixture | idRanges | selectorId / controlId / tableId |
  | --- | --- | --- |
  | sandbox-app | 79000-79199 | 79199 / 79198 / 79197 (existing) |
  | sandbox-data | 79300-79399 | 79399 / 79398 / 79397 |
  | sandbox-hang | 79400-79449 | 79449 / 79448 / 79447 |
  | sandbox-harden | 79500-79549 | 79549 / 79548 / 79547 |
  | sandbox-coverage-probe | 79320-79329 | 79329 / 79328 / 79327 |

  Re-read each `app.json` before writing the table; the ranges above were read on 2026-09-28. Then check that no id is already declared by the fixture: `grep -rnE "\b(<the three ids>)\b" fixtures/<f>/src` must print nothing. If one is taken, step down to the next free id in the range and record it. Add one assertion per fixture that the three ids lie inside that fixture's `idRanges`, read from its `app.json` at test time.
- [ ] **Step 2: Capture the four new fixtures' hashes under WASM** (this HEAD is still WASM). Temporarily print the computed map, paste it into `PINNED`, and remove the print. The file comment says: "RUST-03 Q3: captured under WASM at <HEAD>; the native switch must leave every value unchanged."
- [ ] **Step 3: Red-check.** Edit one byte of `fixtures/sandbox-data/src/*.al` in the working tree, and confirm that fixture's test fails, then restore with `git checkout -- fixtures/sandbox-data/src`.
- [ ] **Step 4: Commit:** `test(RUST-03): pin every fixture's emitted files, captured under WASM, for the native switch`. Then merge S1 to master (fast-forward or merge commit, as the lane rules require) once CI is green.

---

## Stage S2: release CI for five targets (lands before the switch)

S2 lands before S3, so no release can ever carry a native parser that was not built and parse-tested on every target.

### Task S2.1: The compiler for each target, decided in CI

Decision, recorded in `docs/releasing.md` and checked by CI:

| target | runner | runner arch | expected `nativeInfo().target` | C compiler | how it is installed |
| --- | --- | --- | --- | --- | --- |
| win32-x64 | windows-latest | x64 | `x86_64-pc-windows-msvc` | clang-cl, LLVM 23.1.2 | `KyleMayes/install-llvm-action@v2` version 23.1.2 (else `choco install llvm --version=23.1.2`) |
| linux-x64 | ubuntu-22.04 | x64 | `x86_64-unknown-linux-gnu` | clang, LLVM 23.1.2 | the same action |
| linux-arm64 | ubuntu-22.04-arm | arm64 | `aarch64-unknown-linux-gnu` | clang, LLVM 23.1.2 | the same action (it ships aarch64 Linux builds) |
| darwin-x64 | macos-13 | x64 (Intel) | `x86_64-apple-darwin` | clang, LLVM 23.1.2 | the same action, with `SDKROOT="$(xcrun --show-sdk-path)"` exported for cc-rs |
| darwin-arm64 | macos-14 | arm64 (Apple Silicon) | `aarch64-apple-darwin` | clang, LLVM 23.1.2 | the same action, with `SDKROOT` as above |

GitHub's `macos-14` runners are Apple Silicon (arm64); `macos-13` is Intel (x64). Every job builds natively for its own runner's arch, because `build-native-parser.ts` names the addon from `process.arch`. So a runner on the wrong arch would produce a wrongly named, wrongly built addon. Two checks make that fail loudly rather than trusting the mapping: the job asserts `process.arch` equals the key's arch before building, and asserts `nativeInfo().target` equals the table's triple after building.

LLVM 23.1.2 is pinned on all five targets, macOS included, so one compiler version builds every release binary. If the install action does not publish 23.1.2 for a macOS arch, use the LLVM release tarball for that arch from the LLVM GitHub release, and record which one worked.

The CI check: each matrix job reads `nativeInfo()` from the built `.node`. `cCompiler` must match `clang version 23.1.2` on every target (and must NOT match `Apple clang`), and `target` must equal the table's triple. A mismatch fails the job.

### Task S2.2: Restructure `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml`, `docs/releasing.md`, `packages/runner/src/cli.ts` (the hidden `native-check` subcommand)
- Create: `scripts/native-parse-smoke.ts`

- [ ] **Step 1: Four jobs, in order.** Use the job bodies from the RUST-01 plan, Task 8 Step 2 (lines 2148 to 2258): `native-parser` (5-target matrix) runs first, then `build` (Windows: typecheck, tests, `build:binaries`, sign and verify, which publishes nothing), then `smoke` (a 5-target matrix on the compiled binaries), then `publish` (the only job that creates the draft release). Make these changes to it:
  - In `native-parser`, each matrix entry carries `key`, `runner`, `arch` (`x64` or `arm64`) and `triple` from the S2.1 table, plus `parse_expect` (below). After checkout and setup-bun, add `dtolnay/rust-toolchain@1.96.0` and the LLVM 23.1.2 install on every target. On macOS, also export `SDKROOT`. Pass `LLVM_BIN` on every target. Before the build, assert the runner arch; after it, assert the compiler, the target, and a real parse through the addon:

```yaml
      - name: The runner is the arch this key needs
        shell: bash
        run: test "$(bun -e 'console.log(process.arch)')" = "${{ matrix.arch }}"
      # (build step here)
      - name: The addon was built by the pinned compiler, for this target
        shell: bash
        run: |
          bun -e '
            const b = require("./packages/engine/vendor/native/lethal-parser.${{ matrix.key }}.node");
            const i = b.nativeInfo();
            console.log(i.cCompiler, i.target);
            if (!/^clang version 23\.1\.2/.test(i.cCompiler)) throw new Error("compiler " + i.cCompiler);
            if (i.target !== "${{ matrix.triple }}") throw new Error("target " + i.target);'
      - name: The addon parses a fixture (WASM is still the product parser until S3)
        shell: bash
        run: bun scripts/native-parse-smoke.ts fixtures/sandbox-data/src --expect "${{ matrix.parse_expect }}"
      - name: Native Rust tests on this platform
        shell: bash
        run: bun scripts/build-native-parser.ts --test
```

  `scripts/native-parse-smoke.ts` (new, about 20 lines) calls `initNativeParser()` and `parseALNative` directly, not `parseAL`, on every `.al` file under the given directory. It prints `files <n> nodes <total> errors <files with hasError>` and exits 1 if `n` is 0, if `nodes` is 0, if `--expect` is missing or empty, or if the line differs from the `--expect "<line>"` value. `--expect` is REQUIRED, so a workflow that forgets it fails rather than passing on "nonzero". Each matrix entry carries its own `parse_expect` field, and the step passes it, as shown above. Take the value from a local Windows run and write it into all five entries. The parse does not depend on the platform, so all five should hold the same line; a target that needs a different one is a finding to explain, not a value to paste. Red-check it once on the branch: set one entry's `parse_expect` to a wrong node count, confirm that job fails with both lines printed, then restore. Record the failing run's id. This is the explicit addon parse: until S3 the product `--dry-run` never calls the addon, so a green product smoke says nothing about the native parser.

  - `build` downloads all five `native-*` artifacts BEFORE typecheck, and runs the missing-file loop and the clean-tree (`DIRTY`) check from RUST-01 lines 2185 to 2195.
  - `smoke` sets `COUNTS` to the exact regex of the raw and deployed count lines from a local `bun packages/runner/src/cli.ts run --project fixtures/sandbox-data --dry-run`. Read the real output and write the regex from it. Run the compiled binary from a directory that has no `packages/` tree, so it cannot resolve a `.node` from disk. The smoke runs the explicit addon parse too, because before S3 `--dry-run` parses with WASM and never touches the embedded addon: add a hidden `lethal native-check` subcommand that calls `initNativeParser()` and `parseALNative` on a fixed built-in AL snippet and prints `native <target> <cCompiler> nodes <n>`. The smoke job runs it on each compiled binary and checks `target` against the S2.1 triple and `n` against the value from a local run. A missing embedded addon makes it exit non-zero with `NativeParserMissingError`, which fails the job.

  `packages/runner/src/cli.ts` validates and dispatches in separate layers, so the subcommand is wired through each one explicitly:
  - **`VALID_SUBCOMMANDS`:** add `"native-check"`. Add a `HIDDEN_SUBCOMMANDS: ReadonlySet<string> = new Set(["native-check"])` next to it, and filter it out of the list that `requireKnownSubcommand`'s "unknown subcommand ... expected one of" message prints, so it is not advertised there either. It is NOT added to `SUBCOMMANDS_TAKING_POSITIONALS`, so a stray positional is refused.
  - **`CliConfig` union:** add `export interface NativeCheckCliConfig { readonly mode: "native-check" }` and add it to the union.
  - **`parseCliConfig`:** right after `requireKnownSubcommand` and `refuseFlagsThisSubcommandDoesNotOwn`, `if (subcommand === "native-check") return { mode: "native-check" };`. It accepts no flags: make `refuseFlagsThisSubcommandDoesNotOwn` refuse every flag for it (read how that function lists owned flags and give it an empty set). It must return before any branch that reads `--project`, so it can never fall through to the run or dry-run path.
  - **`main()`:** `if (parsed.mode === "native-check") { await initNativeParser(); const p = parseALNative(SNIPPET); const i = nativeInfo(); console.log(\`native ${i.target} ${i.cCompiler} nodes ${p.flat.kind.length}\`); return 0; }`, placed next to the `version` branch, before `dry-run`.
  - **Help:** not listed in `helpText`. If a test asserts every `VALID_SUBCOMMANDS` entry appears in help, exempt `HIDDEN_SUBCOMMANDS` there by name, not by loosening the test.

  CLI tests, in `packages/runner/tests/cli.test.ts`:
  - `parseCliConfig(["native-check"])` equals `{ mode: "native-check" }`.
  - `parseCliConfig(["native-check", "--project", "x"])` throws (no fallthrough), and so does `parseCliConfig(["native-check", "extra"])`.
  - `helpText(...)` does not contain `native-check`, and the unknown-subcommand message does not list it.
  - Source mode: spawning `bun packages/runner/src/cli.ts native-check` exits 0 and prints a line matching `^native \S+ clang version 23\.1\.2.* nodes [1-9]\d*$`.
  - Missing addon: spawn the same with the vendor `.node` hidden (copy the repo's `packages/` to a temp dir without `packages/engine/vendor/native/*.node`, or point the loader at a missing key through an existing test seam if one exists). It must exit non-zero, and stderr must name `NativeParserMissingError`'s platform key and `bun scripts/build-native-parser.ts`, with no WASM parse.
  - Red-check: make the `native-check` branch in `parseCliConfig` return nothing and fall through, and confirm the `--project` test fails, then restore.
  - `publish` `needs: smoke` and is the only job that uses `softprops/action-gh-release`. It attaches the binaries, every `.provenance.json` and `THIRD-PARTY-NOTICES.md`.

- [ ] **Step 2: Check the structure.**

```bash
grep -c "action-gh-release" .github/workflows/release.yml   # expect 1
grep -n "needs:" .github/workflows/release.yml             # build<-native-parser, smoke<-build, publish<-smoke
```

- [ ] **Step 3: Prove the Windows binary locally.** Follow the RUST-01 plan, Task 8 Step 3 (lines 2264 to 2272): hide the vendor `.node`, run the compiled exe from `$S/bin`, and check that its dry-run output is identical to source mode. Record the new exe size.

- [ ] **Step 4: Update `docs/releasing.md`.** Cover:
  - the compiler table above;
  - that the native parser is built per target in CI and embedded through the define-keyed require;
  - that no release ships unless all five `native-parser` and `smoke` jobs pass;
  - the attachments;
  - that building from source now needs Rust 1.96 and LLVM 23.1.2 (`bun scripts/build-native-parser.ts`);
  - the reproducibility result: build twice from clean with `rm -rf "$CARGO_TARGET_DIR"`, and record whether the `.node` sha256 values match. If they do not, state the limit: "reproducible in behaviour, not bytes".

- [ ] **Step 5: Exercise the workflow without releasing.** A pre-release tag does not work: `release.yml` fires only on a version tag, and its "Tag must match the version in package.json" step refuses `v<version>-rust03.1`. Turning `publish` off on a branch does not work either, because a branch push never triggers the workflow. So the trial is a manual run that actually executes every job except publish:
  - Add a `workflow_dispatch:` trigger next to the tag trigger, with no inputs.
  - Guard the tag check with `if: github.event_name == 'push'`. On a dispatch run, a replacement step prints `package.json`'s version and checks it is non-empty, so the version stamp is still exercised.
  - Guard `publish` with `if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')`. A dispatch run can then never create a release. `changelog-section.ts` runs only inside `publish`, so it is skipped too.
  - GitHub dispatches a workflow only if a `workflow_dispatch` trigger exists in that workflow on the DEFAULT branch. So first land a small commit on master that adds ONLY the trigger and the two guards (it publishes nothing, so it is safe alone). Then run `gh workflow run release.yml --ref lethal/rust-03`, which uses the branch's version of the file.
  - The `build` job binds to the `release` GitHub environment (for the signing OIDC subject). If that environment restricts deployment branches or tags, or needs a reviewer, a branch dispatch waits or is refused at `build`, and the five `smoke` jobs never start. Check first with `gh api repos/SShadowS/LethAL/environments/release` (look at `deployment_branch_policy` and `protection_rules`). If it blocks, ask the owner to approve the run in the Actions UI, or to allow `lethal/rust-03` for this trial. Never remove the environment, and never make signing optional to get around it. Signing steps already skip when `AZURE_SIGNING_ACCOUNT` is unset; they must not be edited for the trial.
  - Check that the run executed: `gh run list --workflow release.yml --limit 1` shows `workflow_dispatch`, and `gh run view <id> --json jobs` lists all TEN matrix jobs (five `native-parser`, five `smoke`) with conclusion `success`, `build` as `success`, and `publish` as `skipped`. A job left `waiting` or `queued` is not a pass. Confirm with `gh release list` that no release or draft was created.

  Record each target's `native-parser` and `smoke` result. Any failing target blocks S3 from merging to master. Commit: `ci(RUST-03): five-target release matrix, clang per target checked, addon parse per job, dispatch trial that cannot publish`.

---

## Stage S3: equivalence proof, switch and R-236c (the switch lands only if every Q holds)

### Task S3.1: The lockstep structural proof (Q1)

**Files:**
- Create: `scripts/lib/parser-equivalence.ts`, `scripts/lib/parser-equivalence.test.ts`, `scripts/probe-parser-equivalence.ts`

- [ ] **Step 1:** Write all three files word for word from the RUST-01 plan, Task 5 Steps 1, 3 and 5 (lines 1703 to 1776, 1782 to 1910, and 1916 to 1962). Before using `ENGINE_FIELD_QUERIES`, refresh it from `grep -rhoE 'childForFieldName\("[a-z_]+"\)' packages/*/src | sort -u`. Any name missing from the list gets added.
- [ ] **Step 2:** Run `bun test scripts/lib/parser-equivalence.test.ts`: 10 pass. A snippet diff is a real finding: fix the Rust side, rebuild and re-run. Never loosen the comparison.
- [ ] **Step 3: Run Q1 on everything,** in the foreground, and record the times.

```bash
for f in $F grammar-probe; do bun scripts/probe-parser-equivalence.ts "fixtures/$f"; done
mkdir -p "$S/controls" && cp scripts/lib/al-kind-mapping-*.al "$S/controls/" && bun scripts/probe-parser-equivalence.ts "$S/controls"
for k in do dc sentinel bcf sysapp; do bun scripts/probe-parser-equivalence.ts "${C[$k]}"; done
bun scripts/measure-peak.ts bun scripts/probe-parser-equivalence.ts "$BASEAPP"
```

Expected: every line shows `differingFiles 0` and `tablesEqual true`, with exit 0. The BaseApp run holds one file's WASM tree at a time, because the probe deletes each one, so R292 does not apply to it. Any difference is a BLOCK: write an AMENDMENT, commit it alone, fix, and re-run the whole step.

- [ ] **Step 4: Commit:** `test(RUST-03): lockstep structural equivalence, Q1 holds on every file incl. whole BaseApp`.

### Task S3.2: The switch in the working tree (not committed until S3.5)

**Files:**
- Modify: `packages/engine/src/ast/parser.ts`, `packages/engine/src/ast/syntax-node.ts`, `packages/engine/tests/ast/parser.test.ts`, `packages/engine/tests/ast/no-wasm-in-product.test.ts`, `packages/runner/src/testpage-scan.ts`, plus every product raw-tree caller S1.3 Step 1 classified

- [ ] **Step 1:** Change `parser.ts` to:

```ts
// The engine's parse entry point: native since RUST-03. parser-wasm.ts is a reference instrument only.
export { initNativeParser as initParser, parseALNative as parseAL } from "./native-parser";
```

In `syntax-node.ts`, replace the WASM re-export with `export const wrapRoot = wrapFlatRoot;`. Flip `no-wasm-in-product.test.ts` from `it.todo` to `it`.

- [ ] **Step 2:** Rewrite `parser.test.ts` from RUST-02's diff (the same three tests, read through `wrapRoot`).
- [ ] **Step 3: Port `testpage-scan.ts`** from RUST-02's diff:
  - `errorOffsets(root: ALSyntaxNode): ErrorSite[]` keeps the element type `ErrorSite { startIndex, text }` unchanged, and keeps the rule (nothing when the root has no error; otherwise every ERROR or MISSING node over ALL children).
  - `scanFile` takes `parsed`.
  - The `tree.delete()` calls and the `TsNode` alias are removed.

  First check the precondition: `grep -n "interface ErrorSite" -A4 packages/runner/src/testpage-scan.ts` still shows `{ startIndex; text }`.
- [ ] **Step 4: Port every other product raw-tree caller** from S1.3's list, if there are any. Each one gets a test that passes before and after.
- [ ] **Step 5:** Run `bun run typecheck`. Exactly one error is expected: `testpage-scan.test.ts` calls `delete`. S3.3 fixes it. Any other error is an unclassified caller: classify it and port it.

### Task S3.3: The R-236c leak test in native form (adapted, never weakened)

**Files:**
- Modify: `packages/runner/tests/testpage-scan.test.ts` (the `describe("memory: every parse tree is released once its facts are read")` block only)

The intent is the same as before: no file's parse result stays alive after its facts are read. The WASM mechanism, one `Tree.delete()` per file, has no native equivalent, so the check moves to what "alive" means now, on two layers:

- **The native tree:** S1.1's `every_call_frees_its_tree` Rust test proves the C tree is freed inside every call.
- **The JS parse result:** after the scan, garbage collection must be able to reclaim every `ParsedAL`. If the scanner, or anything it builds (a `Unit`, a `Site`, an `ErrorSite`), keeps a reference to a parse result or to one of its `FlatNode`s, then `liveParseResults()` stays near 3,000.

The test keeps the observation hook-free in the scanner: the counter lives in the loader and counts every parse. It still pins a correct verdict for the call that crosses into the last file after the scan.

- [ ] **Step 1: Replace the test body.** Keep the file-building loop, the `analyze(...)` call and its three assertions exactly as they are. Replace only the prototype patching and the `deletes` count:

```ts
  // RUST-03: native form of R-236c's leak test. BaseApp (9,620 files) aborted inside
  // web-tree-sitter when every tree was kept. The native tree is freed inside each parse call
  // (proven in packages/engine/native/tests/tree_freed.rs); what can still leak is the JS parse
  // result, if a fact extracted from a file keeps its ParsedAL or a FlatNode reachable. So: after
  // the scan, garbage collection must be able to reclaim every parse result. The bound (<= 16 of
  // 3,000) allows for JSC's conservative stack scanning, which can pin a handful; retaining the
  // results, the failure this pins, leaves about 3,000.
  test("3,000 files: every parse result released, and a cross-file opening call still refused", async () => {
    const files: Src[] = [];
    const n = 3000;
    // (unchanged: the loop that fills `files`)
    await initParser();
    const before = liveParseResults();
    const parsedBefore = parsesSinceStart();
    const got = analyze(/* unchanged arguments */);
    expect(got.errors).toEqual([]);
    expect([...got.refused.keys()]).toEqual(["50100::Opens"]);
    // The scan really parsed n files. Monotonic, so a GC during the scan cannot make this flake.
    expect(parsesSinceStart() - parsedBefore).toBeGreaterThanOrEqual(n);
    for (let k = 0; k < 50 && liveParseResults() - before > 16; k++) {
      Bun.gc(true);
      await new Promise((r) => setImmediate(r));
    }
    expect(liveParseResults() - before).toBeLessThanOrEqual(16);
  });
```

Import `initParser`, `liveParseResults` and `parsesSinceStart` from `@lethal/engine`. If they are not exported from the engine index, export them from `packages/engine/src/index.ts` next to `parseAL`. Rename the `describe` to "memory: every parse result is released once its facts are read". Keep the header comment, updated as above.

The "really parsed n files" check uses the monotonic `parsesSinceStart()` from the outset, never `liveParseResults()`: JSC may finalize results during the 3,000-file scan, so a live count read before the forced GC is unstable. The post-GC live bound (<= 16) is the leak check and stays. The Rust allocator test (S1.1) separately guards that the native tree is freed.

- [ ] **Step 2: Run it** 5 times in a row: `for i in 1 2 3 4 5; do bun test packages/runner/tests/testpage-scan.test.ts -t "memory" || break; done`. It must pass all 5 times.
- [ ] **Step 3: Red-check.** Make the scanner retain the results. In `analyzeTestPageSources`, change the loop body to `const p = parseAL(f.text); kept.push(p); scanFile(f.path, p, units, suspect);`, with `const kept: unknown[] = []` declared outside the loop and returned in a field the test does not read (`(globalThis as any).__kept = kept` is also fine for the red-check). Confirm the memory test FAILS, with about 3,000 live, then restore and confirm it is green. Report both outputs. Use the `mutation-red-checker` subagent.
- [ ] **Step 4:** Run `bun run typecheck && rm -rf packages/*/dist && bun test`. Expected: 0 fail, and counts equal the S1 end count plus S3.1's tests (Q5).

### Task S3.4: Q2 to Q4 on the switched working tree

- [ ] **Step 0: Pin the revisions (same-revision rule).** Record the S3 base commit (`git rev-parse HEAD` before the S3.2 edits; the WASM side runs in a scratch worktree at exactly that commit) and each corpus's revision (`git -C <corpus> rev-parse HEAD` for BC.History, do-rel2, DC and Sentinel). Append them to the pre-commitment as `## AMENDMENT <n> (S3 revisions)` and commit it alone, before any S3.4 number. Neither the LethAL commit nor any corpus may move between the WASM run and the native run. Re-check the corpus revisions after the last native run; a moved corpus voids the comparison and it is re-run.
- [ ] **Step 1: Q3, emission.** `bun test packages/runner/tests/fixture-emission.test.ts` passes UNCHANGED. The S1.5 hashes were captured under WASM.
- [ ] **Step 2: Q4, the R-236c census.** Run the RUST-01 plan's Task 6 Step 5 command (lines 2071 to 2075), against a WASM census captured the same way at the S3 base commit, on the same corpus revisions (`$S/r236c-census-wasm.txt`, from the scratch worktree at that commit). Expected: the check passes (BaseApp refused 11,179) and the output says `r236c census identical`.
- [ ] **Step 3: Q2, census rows and hashes.** For each fixture, and for do, dc, sentinel, bcf, sysapp, bsrc and btest, compare against WASM censuses and hash listings taken at the S3 base commit in a scratch worktree:

```bash
for f in $F; do
  bun scripts/census-operator-sites.ts "fixtures/$f/src" "$S/census-native-$f.json"
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-native-$f.txt"
  bun scripts/probe-census-diff.ts "$S/census-wasm-$f.json" "$S/census-native-$f.json"
  cmp "$S/hashes-wasm-$f.txt" "$S/hashes-native-$f.txt" && echo "$f hashes identical"
done
for k in do dc sentinel bcf sysapp bsrc btest; do bun scripts/census-operator-sites.ts "${C[$k]}" "$S/census-native-$k.json"; bun scripts/probe-census-diff.ts "$S/census-wasm-$k.json" "$S/census-native-$k.json"; done
bun scripts/measure-peak.ts bun scripts/census-operator-sites.ts "$BASEAPP" "$S/census-native-baseapp.json"; sha256sum "$S/census-native-baseapp.json"   # RUST-02 W2 was 153bac07... (context, not the gate)
```

Expected: every census diff is 0/0 and every hash listing is identical, native against WASM at the same commit and corpus revision. That is the parser gate, and bsrc and btest carry it at BaseApp scale. W2 completes in one pass with a peak at or below 16,384 MB. WASM cannot run W2 in one pass (R292), so W2 has no same-revision WASM twin. If its hash differs from RUST-02's 153bac07..., run `probe-census-diff.ts` against RUST-02's W2 output and explain every moved row by a commit between RUST-02's base and the S3 base (RUST-02 already recorded 33 row additions this way). A moved row with no such commit is a BLOCK. A hash difference alone is not.

- [ ] **Step 4: Q2, identity keys.** Run the S0.2 capture harness, rebuilt on this switched tree, on each fixture, on do, dc, sentinel, bcf and sysapp, and on whole BaseApp. Compare against WASM listings taken with the WASM materialized-capture harness in the scratch worktree at the S3 base commit, on the same corpus revisions. That includes whole BaseApp. RUST-02 ran it on WASM at 17,798 MB, which is above 16,384 MB, so run it on the host with no other large job and record its peak. It is a reference run, and no ceiling applies to it. RUST-01's `ids-capspec2-*.txt` and `a66a270e...` are the expected values if nothing in between changed; a difference from them is explained, not judged alone.

```bash
cmp "$S/ids-wasm-baseapp.txt" "$S/ids-native-baseapp.txt" && echo "BaseApp identity listing identical"
head -1 "$S/ids-native-baseapp.txt"   # header: raw <n> deployed <n> skippedFiles <n>, raw and deployed > 0
wc -l < "$S/ids-native-baseapp.txt"   # > 1,000,000 (RUST-02: 1,687,697)
sha256sum "$S/ids-native-baseapp.txt" # expected a66a270e1530907e2b6c2b468b29f409fcd822b2ee92e02e6827bd083c59621b
```

Every listing, on both sides, must pass the same non-empty checks: a header line with `raw`, `deployed` and `skippedFiles` all present and `raw` and `deployed` above 0, and a line count equal to `deployed` plus the header. Two empty listings "matching" is this project's signature bug. Any same-revision difference is a BLOCK. Save the working tree with `git stash push -m "RUST-03 switch, blocked by <Q>"` (keep the stash as evidence), write an AMENDMENT, and stop for the owner.

### Task S3.5: Commit the switch, then run the live gates (Q6)

- [ ] **Step 1: Commit the switch.**

```bash
bunx biome check packages/engine/src/ast packages/engine/tests/ast packages/runner/src/testpage-scan.ts packages/runner/tests/testpage-scan.test.ts packages/engine/src/index.ts
git add packages/engine/src/ast packages/engine/tests/ast packages/engine/src/index.ts packages/runner/src/testpage-scan.ts packages/runner/tests/testpage-scan.test.ts <S3.2 Step 4 files>
git commit -m "feat(RUST-03): the engine parses AL natively; structure, sites, hashes, identity keys and fixture emission byte-identical; R-236c leak test in native form"
```

- [ ] **Step 2: al-runner, locally.** Run `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner`. Record the al-runner build line first. Expected: PASS, 3 / 12 / 4 on all four legs, with per-mutant verdicts equal to the one-shot leg.
- [ ] **Step 3: Take a Cronus28 coord lease** (the owner authorized this, 2026-09-25). Record the control app version on every gate container: it must be 1.0.0.19 (GH-24), as CLAUDE.md requires. If a container has an older one, publish 1.0.0.19 with the `control-app` skill first. Do not run or read any switch gate against an older control app.
- [ ] **Step 4: Run the gates in the foreground, one at a time.**

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
LETHAL_ITEST_CHUNKED=1 bun run itest:chunked
```

Expected:
  - bcdev: PASS, 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, screen `vacuous`.
  - chunked: PASS, both legs 17 / 7 / 2, control 9 / 33, chunked 5 / 57.

- [ ] **Step 5: `itest:tables`, only after the owner commits the pending re-record.** On 2026-09-28, master had uncommitted changes to `packages/runner/itest/tables.baseline.json` and `tables.itest.ts` (a re-record in progress). This plan never commits, edits or finishes that re-record: it is the owner's. Check with `git -C /u/Git/LethAL status --porcelain -- packages/runner/itest/tables.baseline.json packages/runner/itest/tables.itest.ts` and `git log -1 --format=%h -- packages/runner/itest/tables.baseline.json` on master. Run `LETHAL_ITEST_TABLES=1 bun run itest:tables` ONLY if both files are clean on master and the re-record commit is in this branch's history. It must PASS with the figures frozen in `tables.itest.ts` at this commit, per-mutant equal. Otherwise the tables leg is DEFERRED: say so in the OUTCOME, with the date and the reason, and name it as the one Q6 leg still owed.
- [ ] **Step 6: Release the lease.** Any failure is a BLOCK. Explain the failure before any re-run. Never edit a baseline. If a gate fails, revert the switch commit with `git revert`, not a reset, and stop for the owner.
- [ ] **Step 7: Re-run the five compiled-binary product smokes on the switched tree.** S2's product `--dry-run` smokes ran while WASM was the product parser, so they proved nothing about the native path. Run the release workflow again with `gh workflow run release.yml --ref lethal/rust-03` (the S2.2 Step 5 dispatch trial). All five `smoke` jobs must pass, now with `--dry-run` parsing through the embedded addon, with the same count lines as Windows source mode. `publish` must show as skipped. Any failure is a BLOCK on the merge.
- [ ] **Step 8:** Merge S3 to master, but only after S2 is on master and green and Step 7 passed.

---

## Stage S4: spec-generation memory (R311, plus the attribution targets from AMENDMENT 1)

### Task S4.1: Stream the manifest (R311), byte-identical

**Files:**
- Modify: `packages/schemata/src/project.ts:653-661`
- Test: `packages/schemata/tests/manifest-stream.test.ts`

**Interfaces:**
- Produces: `writeManifestJson(path: string, manifest: MutantManifest, io?: ManifestIo): Promise<void>` (exported from `project.ts`). Its bytes equal `` `${JSON.stringify(manifest, null, 2)}\n` `` for every input. `ManifestIo = { open: typeof open; rename: typeof rename }` defaults to `node:fs/promises`; it exists only so tests can inject a short-writing file handle and a failing rename. Product code never passes it.

- [ ] **Step 1: Write the failing test.**

```ts
import { afterAll, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifestJson } from "../src/project";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const selectorIds = { selectorId: 79399, controlId: 79398, tableId: 79397 };
const cases: Record<string, unknown[]> = {
  empty: [],
  one: [{ mutantId: 1, file: "a.al", text: 'x "q" \\ \n é', nested: { a: [1, 2], b: null }, skip: undefined }],
  many: Array.from({ length: 2500 }, (_, i) => ({ mutantId: i + 1, file: `f${i % 7}.al`, parts: [i, `t${i}`] })),
};

for (const [name, mutants] of Object.entries(cases)) {
  it(`streams byte-identically to JSON.stringify: ${name}`, async () => {
    const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
    dirs.push(d);
    const m = { selectorIds, artifactId: "0".repeat(32), mutants } as never;
    await writeManifestJson(join(d, "m.json"), m);
    expect(await readFile(join(d, "m.json"), "utf8")).toBe(`${JSON.stringify(m, null, 2)}\n`);
  });
}

// A write that fails halfway must not leave a file that looks like a whole manifest.
it("a failed write leaves no manifest and no partial file, and rethrows", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const mutants = [...cases.many ?? [], { mutantId: 9999, bad: 1n }]; // BigInt: stringify throws late
  const m = { selectorIds, artifactId: "0".repeat(32), mutants } as never;
  await expect(writeManifestJson(join(d, "m.json"), m)).rejects.toThrow();
  expect(await readdir(d)).toEqual([]);
});

// A short write need not throw. A handle that writes at most 7 bytes per call must still give a
// byte-identical file; one that makes no progress must throw and leave nothing.
const shortOpen = (limit: number): typeof open =>
  (async (...args: Parameters<typeof open>) => {
    const fh = await open(...args);
    const write = fh.write.bind(fh) as (b: Uint8Array, o: number, l: number) => Promise<{ bytesWritten: number }>;
    return Object.assign(Object.create(fh), {
      write: (b: Uint8Array | string, o = 0, l?: number) => {
        const buf = typeof b === "string" ? Buffer.from(b) : b;
        const len = Math.min(limit, (l ?? buf.length - o));
        return len === 0 ? Promise.resolve({ bytesWritten: 0, buffer: buf }) : write(buf, o, len);
      },
      close: () => fh.close(),
    });
  }) as typeof open;

it("short writes are completed, byte-identically", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.many ?? [] } as never;
  await writeManifestJson(join(d, "m.json"), m, { open: shortOpen(7), rename });
  expect(await readFile(join(d, "m.json"), "utf8")).toBe(`${JSON.stringify(m, null, 2)}\n`);
});

it("a write that makes no progress throws and leaves nothing", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.one ?? [] } as never;
  await expect(writeManifestJson(join(d, "m.json"), m, { open: shortOpen(0), rename })).rejects.toThrow(/no progress/);
  expect(await readdir(d)).toEqual([]);
});

it("a failed rename removes the partial file and rethrows", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.one ?? [] } as never;
  const failRename = (async () => { throw new Error("rename refused"); }) as typeof rename;
  await expect(writeManifestJson(join(d, "m.json"), m, { open, rename: failRename })).rejects.toThrow("rename refused");
  expect(await readdir(d)).toEqual([]);
});
```

Import `readdir`, `open` and `rename` too. If the `shortOpen` wrapper does not type-check cleanly against Bun's `FileHandle`, keep its behaviour (cap each write at `limit` bytes, return the true `bytesWritten`) and adapt only the typing. Run it: it FAILS, because `writeManifestJson` is not exported.

- [ ] **Step 2: Implement it** in `project.ts`, next to `writeInstrumentedProject`:

```ts
/** R311: the manifest, written one row at a time, byte-identical to
 *  `${JSON.stringify(manifest, null, 2)}\n`. One string for a whole-BaseApp manifest exhausts
 *  memory; each row's own stringify is small. JSON strings contain no raw newline, so indenting
 *  every line after the first reproduces the nesting JSON.stringify would produce. */
export interface ManifestIo {
  readonly open: typeof open;
  readonly rename: typeof rename;
}

export async function writeManifestJson(
  path: string,
  manifest: MutantManifest,
  io: ManifestIo = { open, rename },
): Promise<void> {
  const nest = (v: unknown, pad: string): string => JSON.stringify(v, null, 2).replaceAll("\n", `\n${pad}`);
  // Written to a .partial file and renamed only when whole, so a crash, a throw or a short write
  // never leaves a truncated mutant-manifest.json that a later reader could take for a whole one.
  const partial = `${path}.partial`;
  const fh = await io.open(partial, "w");
  // A write may accept fewer bytes than asked without throwing, so loop until all are written.
  const writeAll = async (text: string): Promise<void> => {
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      if (bytesWritten <= 0) throw new Error(`writeManifestJson: no progress writing ${partial} at byte ${off} of ${buf.length}`);
      off += bytesWritten;
    }
  };
  let ok = false;
  try {
    await writeAll(`{\n  "selectorIds": ${nest(manifest.selectorIds, "  ")},\n  "artifactId": ${JSON.stringify(manifest.artifactId)},\n  "mutants": `);
    if (manifest.mutants.length === 0) {
      await writeAll("[]");
    } else {
      await writeAll("[\n");
      let chunk = "";
      for (let i = 0; i < manifest.mutants.length; i++) {
        chunk += `${i === 0 ? "" : ",\n"}    ${nest(manifest.mutants[i], "    ")}`;
        if (chunk.length > 1 << 20) {
          await writeAll(chunk);
          chunk = "";
        }
      }
      await writeAll(`${chunk}\n  ]`);
    }
    await writeAll("\n}\n");
    ok = true;
  } finally {
    await fh.close();
    if (!ok) await rm(partial, { force: true });
  }
  try {
    await io.rename(partial, path);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
}
```

Import `open`, `rename` and `rm` from `node:fs/promises`. Replace the `writeFile(... JSON.stringify(manifestJson, null, 2) ...)` at lines 657 to 661 with `await writeManifestJson(join(input.targetDir, "mutant-manifest.json"), manifestJson);`. The key order must stay `selectorIds`, `artifactId`, `mutants`, as in the `MutantManifest` literal. If `MutantManifest` gains a field, this function must change too, so add a type-level guard that fails typecheck when the keys differ:

```ts
type _ManifestKeys = Exclude<keyof MutantManifest, "selectorIds" | "artifactId" | "mutants">;
const _manifestKeysCovered: [_ManifestKeys] extends [never] ? true : never = true;
```

- [ ] **Step 3: Run it:** 7 pass. `fixture-emission.test.ts` also passes unchanged: the manifest hash is pinned there. Red-checks, each reverted after it goes red:
  1. Drop the `\n` after `"mutants": [`: both suites fail.
  2. Remove the `if (!ok) await rm(...)` line: the failed-write test fails (a `.partial` file is left).
  3. Write to `path` directly instead of `partial`: the failed-write test fails (a truncated `m.json` is left).
  4. Replace the `writeAll` loop body with a single `await fh.write(buf, off, buf.length - off)` and no loop: "short writes are completed" fails (the file is truncated and renamed as if whole). This is the case a thrown error never shows.
  5. Remove the `bytesWritten <= 0` check (keep the loop): "no progress" hangs; run it with `--timeout 5000` and confirm it fails.
  6. Remove the `rm` in the rename `catch`: "a failed rename removes the partial file" fails.
- [ ] **Step 4: Commit:** `fix(R311): stream mutant-manifest.json row by row, byte-identical to JSON.stringify`.

### Task S4.2: One sub-task per attribution target from AMENDMENT 1

**This task is a TEMPLATE.** No S4.2 sub-task is opened until AMENDMENT 1 has been reviewed and committed (S0.3 Step 2). For every reconciled lead that the reviewed AMENDMENT 1 lists at 15% or more of the W8 or W4 peak, create a task shaped like this (S4.2a, S4.2b, and so on). The exact code is written when the task is opened, not now. A lead is a lead: each sub-task's Step 4 measurement, not the attribution, decides whether the fix worked. Do not grow S4 into a two-pass redesign from these leads; that is its own plan (open question 1).

- [ ] **Step 1: Pre-commit the prediction.** Append to the pre-commitment `## AMENDMENT <n> (S4.2x prediction)`: the item, the predicted W8 and W4 peaks after the fix, and "identity listing a66a270e unchanged". Commit it alone.
- [ ] **Step 2: Write the failing test.** Use a unit-scale memory assertion of the same kind as S3.3: for example, `liveParseResults()` falls after spec generation if the item is "retained ParsedAL after context build", or a heap-count bound from `bun:jsc` `heapStats().objectTypeCounts` on a 2,000-file synthetic project. Red-check it against the unfixed code.
- [ ] **Step 3: Implement the smallest change that releases the item.** The expected shapes, depending on attribution:
  - drop references to `parsed[]` sources and roots once specs are generated and ordinals are assigned;
  - stop keeping `before` nodes in the specs once `originalText` and the offsets are copied;
  - write NDJSON-free id listings.

  Keep every consumer's input identical.
- [ ] **Step 4: Prove it.** `fixture-emission.test.ts` passes unchanged. The S0.2 harness listing on whole BaseApp still has sha256 `a66a270e...`. Re-measure W8 and W4, 3 runs each.
- [ ] **Step 5:** Commit the fix. Then commit the measured result as an AMENDMENT, alone.

### Task S4.3: Measure the ceilings, then file honestly

- [ ] **Step 1: The W9 patch audit, before any W9 number.** Build W9's harness from W8's on the final S4 tree, then list every hunk of `git diff` between the W9 harness and product code into `$S/w9-patch-audit.txt`. For each hunk, say what it turns off. The audit must show all of this, or W9 is not run:
  - **One exempt hunk, shown in full.** The only hunk allowed inside the manifest writer is the scratch marker: one added line, `console.error("W9: product manifest writer ran", path);`, as the first statement of `writeManifestJson`. The audit file shows that hunk verbatim and labels it EXEMPT (instrumentation only).
  - **The rest of the writer equals product code.** With the marker line removed, the harness's `writeManifestJson` function body and its call site in `writeInstrumentedProject` are byte-identical to the final S4 tree's product code. Check it mechanically: extract both functions and the call-site lines to files, drop the one marker line from the harness copy, and `cmp` them. Any other difference means W9 is not run.
  - **No substitute writer.** The NDJSON manifest substitute from W8's patch is NOT present (`grep -in ndjson` over the harness diff of `project.ts` prints nothing).
  - **The run log proves it ran.** The W9 run's stderr contains the marker line exactly once, naming `<target>/mutant-manifest.json`.
- [ ] **Step 2:** Take W2, W4, W8 and W9 on the final S4 tree, with the release clang binary, 3 runs each.
- [ ] **Step 3:** Compare each against the pre-committed ceilings: W2 16,384 MB, W4 16,384 MB (the owner's ruling, written into S0.1 before any W4 number), W8 16,384 MB (win only at 8,192 MB), W9 16,384 MB. Record MET or MISSED with the numbers. A W2 or W3a result is never reported as a W4 or product-wide result. W9's manifest is checked by STREAMING, never by `JSON.parse` of the whole file and never by reading it into one string: a scratch script (`$S/manifest-check.ts`) streams the file through a real streaming JSON parser, not a hand-written depth counter: `@streamparser/json` (the `JSONParser` class, fed chunk by chunk from `fs.createReadStream`), installed only in the scratch directory, never added to the repo. With `paths: ["$.mutants.*"]` and `keepStack: false` it emits each mutant row without holding the rest. The script confirms the parser reaches the end with no error and no trailing data, that the top-level keys are `selectorIds`, `artifactId`, `mutants` in that order, and that the row count equals `deployed` from the run's own output and is above 0. It also confirms no `mutant-manifest.json.partial` is left in the target directory. Before trusting it on BaseApp, run it on the sandbox-app manifest (must pass) and on five broken copies (each must fail): truncated by one byte; a comma removed between two rows; a trailing comma added after the last row; a bad token (`tru` in place of a `true`); and an extra `}` appended. If the package cannot be installed, write the check with Bun's own `JSON.parse` applied to each ROW (the writer puts one row per 4-space-indented block), plus an explicit check of every separator between rows, and add the same five broken copies. Loading the whole file stays forbidden.
- [ ] **Step 4: Update the roadmap.** Re-check the free id first.
  - R292: `done (<switch commit>)` if W2 completes on master (the native parser removes the retained-WASM-heap mechanism), with the Tier-2 cross-half blind spot closed by W2's one-pass census.
  - R311: `done (<S4.1 commit>)` if W9 completes. If W9 still fails, R311 stays open with the new failure point.
  - R314: `closed 2026-09-xx: superseded by RUST-02/RUST-03 (clang build; native switch landed <commit>)`.
  - Every MISSED ceiling gets a new item with its number and the attribution row it traces to.

  Run `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, and commit.

---

## Stage S5: OUTCOME and documentation

### Task S5.1: OUTCOME, the vendor README, and clean-up

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-rust-03-precommitment.md` (`## OUTCOME`), `packages/engine/vendor/README.md`, `docs/roadmap/*` (if S4.3 has not already done it), `ROADMAP.md` (regenerated)

- [ ] **Step 1: OUTCOME.** One line for each of Q1 to Q7 (MATCHED or MISSED, with numbers), the S1.4 decision, and W2, W4, W8 and W9 against their ceilings, with WASM and native side by side. Add the speed figures, recorded but not gating: W1 parse ms, W2 and W3a wall, W4 wall. Commit it alone: `spec(RUST-03): OUTCOME`.
- [ ] **Step 2: Vendor README section `## Native parser (RUST-03, <date>)`.** Cover:
  - the crate path and pins;
  - that no binary is committed, and the build command (Rust 1.96, LLVM 23.1.2);
  - the per-target compiler table;
  - the grammar check, the provenance record and the notice inventory;
  - the reproducibility result;
  - the grammar bump procedure: bump the crate pin, run `check-native-grammar.ts` with the new tag's inputs, rebuild, update `GRAMMAR_PIN`, run `probe-parser-equivalence.ts` on every fixture and corpus, then the TSAL-441 census method;
  - that WASM is the reference only, and stays until one grammar bump has been done natively (ruling), after which the owner decides.
- [ ] **Step 3: Sweep the prose.** `grep -rn "web-tree-sitter\|wasm" README.md docs/*.md CLAUDE.md .claude/skills fixtures/README.md`, and correct every user-facing claim that says LethAL parses with WASM. Edit CLAUDE.md only with the owner's yes. List the CLAUDE.md lines that would change in the final report instead.
- [ ] **Step 4: Remove the scratch worktrees** listed in S0.2 Step 8 and RUST-02 concern 6. Check with `git worktree list`.
- [ ] **Step 5: Commit:** `docs(RUST-03): native parser vendoring, compilers, provenance, bump procedure; roadmap updated`.

---

## Self-review notes

- Coverage against the brief:
  - Task 0 measurement and attribution: S0.2 and S0.3.
  - Loader, pin, staleness, `--compile`, and the missing-binary error: S1.3 and S2.2.
  - FlatNode for every member: S1.4.
  - The switch, with no product fallback: S3.2 and the `no-wasm-in-product` test.
  - Equivalence: S3.1 for structure, S3.4 for identity (including BaseApp), S1.5 and S3.4 for emission.
  - The R-236c test adapted: S1.1 Rust layer and S3.3 JS layer, both red-checked.
  - Spec-generation memory: S4.
  - Release CI: S2.
  - Live gates: S3.5.
  - Pre-commitments: S0.1, S0.3, S1.4 Step 5 and S4.2 Step 1.
- Types used across tasks: `ParsedAL`, `FlatTree`, `wrapFlatRoot`, `liveParseResults`, `NativeInfo.cCompiler`, `writeManifestJson`, all defined in the task that produces them.

## Open questions (for the owner, before or during execution)

1. **S4.2 is a template until S0 has run.** Its sub-tasks depend on where W8's 15.9 GB actually goes. If the attribution shows the peak is spec objects that are inherent to one whole-BaseApp context (1.78 M specs), then W8 at 8,192 MB may not be reachable without a two-pass design (R292's declaration-index route). Should that become its own plan, with W8 at 16,384 MB (no crash) accepted as RUST-03's bar?
2. **W4 ceiling: RESOLVED (orchestrator ruling, review r1).** W4 is 16,384 MB, the owner's 16 GB, written into S0.1 before any W4 number.
3. **The macOS compiler: RESOLVED (orchestrator ruling, review r1).** LLVM 23.1.2 is pinned on all five targets, macOS included (S2.1).
4. **The transfer-buffer variant (S1.4)** uses raw `napi_create_arraybuffer`. If napi-rs 3 has a safe equivalent, that is preferred. If "owned" loses the pre-committed rule, should the synchronous callers (`line-map.ts`, `al-runner-coverage.ts`) instead yield to the event loop every 100 files? That is a smaller change but touches product code paths.
5. **When to retire WASM.** The standing ruling keeps WASM until one grammar bump has been done natively. After that, removing `web-tree-sitter`, `parser-wasm.ts` and the vendored `.wasm` needs the owner's decision.
6. **`itest:tables`: RESOLVED (orchestrator ruling, review r1).** It runs in S3.5 only after the owner commits the pending re-record on master. Otherwise it is deferred, and the OUTCOME says so.
7. **Consumers of a whole-BaseApp manifest.** S4.1 makes the write stream, but readers still `JSON.parse` the whole file. Is reading a BaseApp-sized manifest in scope, or should it be filed separately?

## Review r1 disposition

Review: `H:/lethal-coord/reviews/RUST-03-plan/review-r1.md`. Orchestrator rulings applied as given.

| # | finding | disposition |
| --- | --- | --- |
| C1 | W4 ceiling 8,192 MB contradicts the owner | Fixed. W4 is 16,384 MB in Global Constraints, in the S0.1 pre-commitment text (written before any W4 number), and in S4.3 Step 3. |
| C2 | darwin-arm64 on an "Intel" `macos-14` runner | Reviewer wrong on the fact: `macos-14` is Apple Silicon (arm64), `macos-13` is Intel. Kept `macos-14`. Added the runner-to-arch-to-triple table for all five targets, a `process.arch` assertion before the build, a `nativeInfo().target` assertion after it, and LLVM 23.1.2 pinned on macOS too (S2.1, S2.2). |
| C3 | Control app prerequisite stale | Fixed. S3.5 Step 3 and Q6 require 1.0.0.19 on every gate container. |
| I1 | S2 smoke never touches the addon before S3; pre-release tag fails the tag check | Fixed. Each `native-parser` job parses a fixture through the addon (`scripts/native-parse-smoke.ts`); each compiled-binary `smoke` job runs `lethal native-check`. The trial is a `workflow_dispatch` run with the tag check and `publish` gated to tag pushes, the trigger landed on master first, and the run checked to have executed. S3.5 Step 7 re-runs all five product smokes after the switch. |
| I2 | Stale-build guarantee is test-only; target not checked | Fixed. `checkBinding` runs at init: grammar pins, `nativeInfo().target` against the runtime platform and arch, and in source mode `bindingSourceSha256` against the local crate (`NativeParserStaleError`). No WASM fallback. Tests and red-checks in S1.3. |
| I3 | Whole-BaseApp Q2 needs a same-revision rule | Fixed. Global rule, pre-commitment section and S3.4 Step 0 pin the LethAL and corpus revisions. WASM against native at the S3 base commit, including a WASM BaseApp identity listing. RUST-02's W2 hash and `a66a270e` are context; a difference is explained, not judged alone. Non-empty header and line-count checks kept on every listing. |
| I4 | S0 attribution cannot assign percentages | Fixed. Rows are labelled leads, reconciled with phase peak RSS and external memory, with an unexplained remainder row. AMENDMENT 1 is reviewed before commit; S4.2 stays a template until then. No W2 or W3a win is called a W4 or product-wide win. |
| I5 | W9 may not exercise the real writer; `JSON.parse` of a huge file | Fixed. S4.3 Step 1 patch audit, with a scratch marker proving `writeManifestJson` ran once. Streaming validity and row-count check, itself tested on a good and a truncated manifest. S4.1 writes to `.partial` and renames; a new test and two red-checks cover a failed write. |
| I6 | R-236c first count unstable | Fixed. The monotonic `parsesSinceStart()` counter is in the loader from S1.3 and used by S3.3 from the outset. Post-GC live bound and the retained-result red-check kept. |
| M1 | S1.5 reuses sandbox-app's selector ids | Fixed. Per-fixture ids from each `app.json` `idRanges`, checked unused, and asserted in range at test time. |
| M2 | S4.2 must stay a template; S3 must not merge before its gates | Fixed. S4.2 is marked a template until the reviewed AMENDMENT 1. S3.5 Step 8 merges only after S2 is green and the post-switch smokes pass. |
| (ruling 11) | `itest:tables` baseline uncommitted on master | S3.5 Step 5 runs it only after the owner commits the pending re-record; otherwise deferred and stated in the OUTCOME. Open question 6 marked resolved. |

## Review r2 disposition

Review: `H:/lethal-coord/reviews/RUST-03-plan/review-r2.md`. All findings applied.

| # | finding | disposition |
| --- | --- | --- |
| C1 | Manifest writer can rename a short-written file as whole | Fixed (S4.1). `writeAll` loops on `bytesWritten` and throws on no progress. A failed `rename` removes `.partial` and rethrows. An injectable `ManifestIo` (tests only) drives three new tests: a 7-byte short-writing handle (byte-identical result), a zero-progress handle (throws, leaves nothing) and a failing rename (leaves nothing). Six red-checks, including a single un-looped write. |
| I1 | S0 WASM capture at 71b8df1 breaks the same-revision rule | Fixed (S0.2 Steps 3 and 5). `$S/wasm-cap-wt` is built at the same S0 HEAD, the two harness diffs may differ only in the parse hunk, and native and WASM are validated equal on sandbox-app before BaseApp. 71b8df1 and `a66a270e` are context only. |
| I2 | Phase peaks have no instrument | Fixed (S0.2 Steps 4 and 7). The scratch `phase()` reads the process's own monotonic `maxRSS` before its GC (`peakSoFarMb`), checked within 5% of `measure-peak.ts`'s whole-run peak, or else every figure is called a whole-run peak. Marked and unmarked figures are reported separately. The unexplained remainder is never allocated to a lead or an S4 target. |
| I3 | `--expect` not wired into CI | Fixed (S2.2). `--expect` is required by the script, each matrix entry carries `parse_expect`, the step passes it, and a deliberate mismatch is red-checked on the branch. |
| I4 | Hidden CLI dispatch unspecified | Fixed (S2.2). `VALID_SUBCOMMANDS` plus `HIDDEN_SUBCOMMANDS`, `NativeCheckCliConfig` in the union, an early return in `parseCliConfig` with no flags and no positionals, a `main()` branch next to `version`, not in `helpText` or the unknown-subcommand message. Six CLI tests including a missing embedded addon, and a fallthrough red-check. |
| I5 | W9 audit contradicts its marker; tokenizer is not validation | Fixed (S4.3). The one marker hunk is exempt and shown verbatim; the rest of the writer is compared to product code by `cmp`; the run-log assertion stays. Validation uses `@streamparser/json` (scratch only), tested against five malformed copies (truncation, missing comma, trailing comma, bad token, extra brace), with a per-row fallback that keeps the same tests. |
| M1 | Dispatch trial and the `release` environment | Fixed (S2.2 Step 5). Check the environment's branch policy and protection rules first; if it blocks, the owner approves or allows the branch. Never remove the environment or weaken signing. Pass requires all ten matrix jobs `success`, `build` `success`, `publish` `skipped`. |
| r1 closures | W4 16,384 MB, control app 1.0.0.19, selector ids, monotonic counter, S4.2 template, macOS | Accepted by the reviewer; unchanged. |
