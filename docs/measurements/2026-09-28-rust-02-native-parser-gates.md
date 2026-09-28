# RUST-02: native Rust parser gates, MSVC and clang (2026-09-28)

Measured 2026-09-28 in worktree `U:/Git/LethAL-wt/rust-02` (branch `lethal/rust-02`, HEAD
`b605cf4`). Nothing from this session is committed except this file and the roadmap/pre-commitment
updates that point to it: the crate under `packages/engine/native/`, the `FlatNode` layer and the
native-parser switch stay uncommitted in the working tree for RUST-03. Full reports:
`.superpowers/sdd/rust-02/gate-ii-report.md`, `gate-i-report.md`, `progress.md` (session scratch,
kept for now, not part of this record).

## What was measured, and why

RUST-01 spiked a native Rust parser (napi-rs, tree-sitter 0.25.10 + tree-sitter-al 4.4.1) as a
replacement for the WASM path, to fix WASM's memory ceiling on a whole-BaseApp census (R292). Its
pre-committed speed bar failed by a wide margin: native parse median 34,515 ms against a
9,547 ms bar, about 1.8x slower than WASM (R314). The crate itself was never proven wrong on
correctness, only slow with the MSVC build that was the only one available that day.

RUST-02 retries the same crate with a second compiler and a new owner bar, set in AMENDMENT 3 of
`docs/superpowers/specs/2026-09-27-rust-01-precommitment.md`, committed alone at `b605cf4` before
any RUST-02 number was read: **1) no crash, 2) lower peak memory, 3) speed, in that priority order.
Speed no longer gates.** AMENDMENT 3 replaces the spike's speed bar with two gates, both builds
against both:

- **Gate (ii), parse only**: one pass over whole `U:/Git/BC.History/BaseApp` (9,620 `.al` files)
  through the native parse call alone, no census. Stop only on a crash or a peak over 16,384 MB.
  Node counts must equal WASM's.
- **Gate (i), the census**: if (ii) passes, GO requires for at least one build that the census over
  the same 9,620 files completes in one pass, no crash, peak at most 16,384 MB, nodes equal, and the
  identity listing equal to the WASM spec-level capture (sha256
  `a66a270e1530907e2b6c2b468b29f409fcd822b2ee92e02e6827bd083c59621b`). The native peak on W3a
  (BaseApp/Source, the half WASM completes) is compared against WASM's 16,151 MB as the memory-win
  figure.

Both gates passed for both builds; details below. The crate under `packages/engine/native/` is
byte-identical to RUST-01's copy (`src/lib.rs` sha256 `221357a5...`), untouched by this session.

## Builds

Grammar sources (cargo registry, tree-sitter-al 4.4.1): `src/parser.c` sha256
`0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22`, `src/scanner.c` sha256
`346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a`, both equal to upstream v4.4.1's
inputs. Crate: tree-sitter 0.25.10, tree-sitter-al 4.4.1 (ABI 15), rustc 1.96.0 (`ac68faa20`,
2026-05-25), target `x86_64-pc-windows-msvc`, unchanged from RUST-01 Task 1 (napi 3.13.0,
napi-derive 3.6.9, napi-build 2.5.0, sha2 0.10.9). Kind table sha256
`65dca121ad7b431ee3427e7c0762eba34b90c4ca9dbd5d11593ea91c126f7d45`, same on both builds. Binding
source sha256 `2d996166...315031aff`.

Every build ran `cargo build --release --lib --examples -vv` from `packages/engine/native`, release
profile `lto = true`, `codegen-units = 1`, `.cargo/config.toml` adding `/Brepro` to link and C
flags.

| build | compiler | parser.c / scanner.c flags | tree-sitter runtime lib.c | `.node` sha256 |
| --- | --- | --- | --- | --- |
| msvc | `cl.exe` 19.44.35228 x64 (VS 2022 Enterprise, MSVC 14.44.35207) | `-nologo -MD -O2 -Brepro -std:c11 -I src -utf-8 /Brepro -c` | cl, `-nologo -MD -O2 -Brepro -W0 -D_POSIX_C_SOURCE=200112L -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE /Brepro` | `61408b1b7a0a1d83...` |
| clang | clang-cl 23.1.2 (llvm-project `85ac5602`), `CC=C:/Program Files/LLVM/bin/clang-cl.exe`, LLVM bin first on PATH | `-nologo -MD -O2 -Brepro --target=x86_64-pc-windows-msvc -std:c11 -I src -utf-8 /Brepro -c --` | clang-cl, same plus `-W0 -Wshadow -Wno-unused-parameter -Wno-incompatible-pointer-types`, archived with `llvm-lib.exe` | `f852037b66d13008...` |
| clang-o3 | as clang, plus `CFLAGS_x86_64_pc_windows_msvc="/Brepro /clang:-O3"` | as clang plus `/clang:-O3` | as clang plus `/clang:-O3` | `f852037b66d13008...` (IDENTICAL to clang) |
| clang-slim (scratch, gate ii shrink variants only) | as clang | as clang | as clang | `f27e492d07123451...` |

**`-O3` is a no-op for clang-cl here.** `/clang:-O3` produces byte-identical objects and a
byte-identical `.node` to clang-cl `/O2`, both through cargo/sccache and in a direct clang-cl
compile of `parser.c`/`scanner.c` outside the build system. So "clang" below means clang-cl `/O2`,
and the clang-o3 timings are a second sample of the same binary. clang objects carry the `clang
version` string; the MSVC ones do not, and `parser.o` sha256 differs between the two compilers
(msvc `ddaf756143abccb6`, clang `97db7a9437fe64d4`). sccache wraps the clang C compiles on this
machine (a machine-level `rustc-wrapper` setting); the direct outside-sccache compile confirmed the
cache did not change the result.

## Gate (ii): parse-only memory and correctness

Input is exactly whole BaseApp, the same enumeration W1 uses: 9,620 files, corpus fingerprint sha256
`2afad2aa60b13958a284de4c0a88277eeeb762ca93a357f86a21a84db3256b7f`, equal to the pre-commitment's
table. The harness calls only the native parse-and-flatten call (or a shrink variant), no census, no
walk; every row exits 0 with no crash.

| build | variant | runs | peak MB | wall s | nodes | = WASM 31,135,464? |
| --- | --- | ---: | --- | --- | --- | --- |
| msvc | base (probe D shape) | 3 | 1,906 / 1,907 / 1,902 | 31.63 / 30.45 / 29.91 | 31,135,464 | yes |
| msvc | yield100 | 1 | **835** | 30.39 | 31,135,464 | yes |
| msvc | lazy | 1 | 479 | 32.92 | 31,135,464 | yes |
| clang | base (probe D shape) | 3 | 1,912 / 1,904 / 1,912 | 15.28 / 14.51 / 13.74 | 31,135,464 | yes |
| clang | gc100 (`Bun.gc(true)` every 100 files) | 1 | 1,845 | 15.23 | 31,135,464 | yes |
| clang | gc1000 | 1 | 1,847 | 15.17 | 31,135,464 | yes |
| clang | drop (free each source string after its parse) | 1 | 1,791 | 13.95 | 31,135,464 | yes |
| clang | yield100 (one `setImmediate` turn every 100 files) | 1 | **827** | 14.18 | 31,135,464 | yes |
| clang | yield1 (a turn after every file) | 1 | 734 | 15.60 | 31,135,464 | yes |
| clang | lazy (read each file just before its parse) | 1 | 478 | 17.62 | 31,135,464 | yes |
| clang | none (preload only, no parse) | 1 | 673 | 1.11 | 0 | n/a |
| clang-o3 | base | 3 | 1,912 / 1,901 / 1,905 | 14.06 / 19.10 / 15.63 | 31,135,464 | yes |
| clang-slim | slim (points, fields, flags dropped) | 1 | 1,316 | 13.64 | 31,135,464 | yes |
| clang-slim | count (nothing but the count crosses) | 1 | 697 | 13.59 | 31,135,464 | yes |
| WASM W1 (same session) | reference | 3 | 1,142 / 1,142 / 1,142 | 25.04 / 24.79 / 25.11 | 31,135,464 | reference |

**No crash, every peak far under the 16,384 MB ceiling, nodes equal WASM on every run. Gate (ii)
PASSES for both builds.**

**The event-loop finding.** The base peak (about 1,906 MB, matching RUST-01's probe D) is almost
entirely the returned typed arrays, not freed during a synchronous loop. Sources held in memory cost
673 MB (`none`); parse and flatten with nothing transferred costs 697 MB (`count`), so tree-sitter
itself adds only a few tens of MB at peak, its tree freed per file. Transferred bytes per node are
37 (kind 2, field 2, flags 1, child_count 4, next_sibling 4, start 4, end 4, points 16), so 31.1
million nodes transfer about 1.15 GB, matching the base-minus-count gap (1,906 minus 697 equals
1,209 MB); dropping to 18 bytes per node (`slim`) cuts the gap to 619 MB, again proportional. A
forced GC does not help (`gc100` 1,845 MB) and freeing sources does not help (`drop` 1,791 MB). **One
event-loop turn does**: `yield100` gives 827 MB clang and 835 MB msvc, `yield1` gives 734 MB.
napi-rs typed arrays are external buffers whose finalizers Bun runs only when the event loop turns.
`lazy` is low (478 MB) for the same reason: each `await readFile` turns the loop.

Best variant is **yield100**, a harness change only, no crate or layout change: 827 MB clang, 835 MB
msvc, both below WASM W1's 1,142 MB, with W1's preload shape kept. `lazy` is lower still but changes
W1's shape by moving disk reads inside the loop.

## Gate (i): the census over whole BaseApp

Gate (i) switches the engine's parse interface to native behind a minimal `FlatNode` implementing
`ALSyntaxNode` (uncommitted; see "What is not committed"). Binaries are gate (ii)'s, unchanged:
`lethal.node` sha256 `61408b1b...` (msvc) and `f852037b...` (clang).

| build | W2: crash? / peak MB (median of 3) / wall s (median) | nodes | identity listing = `a66a270e...`? | W3a peak MB (median of 3) vs WASM 16,151 |
| --- | --- | --- | --- | --- |
| clang | no crash, exit 0 / **8,957** (8,779 / 8,959 / 8,957) / 100.05 | 31,135,464 (equal) | **yes**, 1,687,697 lines, `raw 1775337 deployed 1687696 skippedFiles 73` | **5,855** (5,980 / 5,855 / 5,311) |
| msvc | no crash, exit 0 / **8,792** (9,034 / 8,648 / 8,792) / 129.78 | 31,135,464 (equal) | **yes**, same header and line count | **5,502** (5,678 / 5,502 / 5,334) |

**GO, both builds, with a memory win.** W2 (the whole-BaseApp census, `scripts/census-operator-sites.ts`
against `U:/Git/BC.History/BaseApp`) completes in one pass on each build, well under the 16,384 MB
ceiling, node counts equal, and the identity listing (the same whole-BaseApp spec-level capture
method RUST-01 validated, at commit `71b8df1`) is byte-identical to the WASM reference on both
builds. W3a (BaseApp/Source, 8,020 files, the subset WASM completes) peaks at 5,855 MB clang and
5,502 MB msvc against WASM's 16,151 MB, about a third: the owner's memory win. Native W3a rows are
byte-identical to a same-HEAD WASM run's rows (sha256 `96b4760f...`, 791,795 sites on both builds and
that WASM run).

**The same-commit WASM comparison, and the +33 rows.** WASM run fresh at HEAD `b605cf4` (a clean
scratch worktree `$S/head-wt`) gives W3a peak 15,974 MB, close to but below the pre-commitment's
16,151 MB baseline figure (161.03 s / 16,151 MB, 791,762 sites, rows sha256 `63dc038a...`). The
native rows differ from that pre-commitment capture by 33 added rows (void-method-call 22,
remove-assignment 8, remove-setrange 3, 0 removed; `scripts/probe-census-diff.ts`), and the
same-HEAD WASM run shows those 33 rows come from the 51 commits landed between the pre-commitment's
capture and `b605cf4`, not from the parser swap. Native rows equal WASM rows at the same commit,
which is the comparison that isolates the parser.

Ten smaller corpora (five fixtures, do, dc, sentinel, bcf, sysapp; clang) gave identity listings
byte-identical to RUST-01's validated captures on all ten before BaseApp was attempted.

## Speed (recorded, not gating)

| measure (median of 3, ms) | msvc | clang | clang-o3 (same binary as clang) | WASM, same session |
| --- | ---: | ---: | ---: | ---: |
| parseFlat: parse + flatten + transfer (gate ii base) | 29,295 (30,089 / 29,295 / 28,808) | 13,354 (14,073 / 13,354 / 12,632) | 14,389 (12,806 / 17,680 / 14,389) | parse only: 14,910 (14,970 / 14,718 / 14,910) |
| Rust only, tree-sitter parse (`examples/split.rs`) | 20,173 (20,173 / 20,333 / 20,016) | 7,608 (7,714 / 7,608 / 7,471) | 7,538 (7,691 / 7,488 / 7,538) | n/a |
| Rust only, flatten | 5,394 (5,394 / 5,241 / 5,619) | 3,128 (3,178 / 3,128 / 3,083) | 3,069 (3,133 / 3,036 / 3,069) | n/a |

The machine ran faster than on the RUST-01 baseline day (WASM W1 parseMs median 14,910 here against
the pre-commitment's 19,094), so builds are compared against today's WASM figure. clang parses 2.65x
faster than MSVC in Rust alone (7,608 against 20,173 ms) from the same C sources; clang's `parseFlat`
is about 10% faster than WASM's parse alone the same day, MSVC about 2x slower, matching RUST-01's
earlier finding.

Census-level wall times: W2 median clang 100.05 s, msvc 129.78 s; W3a median clang 41.93 s, msvc
51.62 s, WASM 157.29 s. The whole-BaseApp identity capture: clang 1,466 s, msvc 1,453 s, WASM
1,820 s (dominated by spec generation, not parsing).

## Unit suite under native

`bun run typecheck`: one error, `packages/runner/tests/testpage-scan.test.ts(1252,10)`, `delete`
does not exist on `ParsedAL`. Then `rm -rf packages/*/dist`, then `bun test`:

| run | pass | skip | fail | tests | files |
| --- | ---: | ---: | ---: | ---: | ---: |
| WASM at HEAD `b605cf4` (clean scratch worktree) | 4,082 | 7 | 0 | 4,089 | 214 |
| native clang | 4,081 | 7 | **1** | 4,089 | 214 |
| native msvc | 4,081 | 7 | **1** | 4,089 | 214 |

The one failing test, on both builds: `packages/runner/tests/testpage-scan.test.ts`, the memory test
that every parse tree is released once its facts are read (over 3,000 files, every tree deleted, a
cross-file opening call still refused). It pins the WASM mechanism itself: it calls `parseAL("")`,
takes the prototype's `delete`, and wraps it to count one `Tree.delete()` per file. A native
`ParsedAL` is a plain object with no `delete` (its tree is freed inside the native call), so the test
throws at line 1252 before it can assert anything. The behaviour it guards, no per-file tree kept
alive across the scan, holds by construction under native, but the test cannot see that: it is not
weakened, it needs a native form (or retiring alongside the WASM path) as part of any real
switch-over, and typecheck already fails on the same line.

## Caveats

1. **The identity-capture path barely wins memory, and MSVC crosses the census ceiling there.** Its
   peak is 15,942 MB clang and 17,030 MB msvc against WASM's 17,798 MB: 4 to 10% lower, and MSVC's
   figure is above the 16,384 MB figure that gates W2 (this harness is not W2; the capture runs
   `generateMutationSet` plus the manifest, the same machinery as W4, so its win should not be read
   as a product-wide number).
2. **W4 (`run --dry-run` on the Base Application) is unmeasured** in RUST-02. WASM W4 peaks at
   16,810 MB; it is the next number to look at before any product-wide memory claim.
3. **The loader is a scratch one.** `LETHAL_NATIVE_NODE` names an absolute path to a `.node` file
   with no grammar pin, no staleness check, and no `--compile` embedding path. The real loader (the
   plan's Task 3) is still to build.
4. **The yield effect is shape-specific.** Gate (ii)'s dead-array problem is a synchronous-loop
   artifact. The census already turns the event loop once per file (it awaits `readFile` inside the
   parse loop), so the yield choice barely separates there: single-sample preload-vs-lazy runs span
   8.7 to 11.4 GB on both builds without separating cleanly. A caller that parses synchronously and
   discards results would still carry gate (ii)'s roughly 1.2 GB of dead arrays until it yields; the
   engine's `parseAL` is synchronous and cannot yield for its own caller.
5. Single-run shrink and yield variants in gate (ii) are one sample each; the three base runs agree
   within about 12 MB of peak, so one sample is enough for peak comparisons, not for speed.
6. Two scratch git worktrees registered during this session, `$S/cap-wt` (`71b8df1`) and `$S/head-wt`
   (`b605cf4`), are pending `git worktree remove --force <path>` cleanup; neither holds committed
   work.

## Verdict

**GO for both builds**, against AMENDMENT 3's bar: no crash, peak at or under 16,384 MB, nodes equal,
identity listing equal, on gate (ii) and on gate (i)'s W2, with a memory win on W3a for both (clang
5,855 MB and msvc 5,502 MB against WASM's 16,151 MB). If one build is chosen for RUST-03: the two
builds' peaks are within noise of each other on every measurement above, and clang is faster
throughout (W2 wall 23% lower, Rust-only parse 2.65x faster, `parseFlat` about 10% faster than WASM),
so **clang wins on the owner's third priority** with no memory cost.

## What is not committed

This session commits only this file, the pre-commitment's RESULT section, `R314.md` and the
regenerated `ROADMAP.md`. Left uncommitted in the working tree, for RUST-03 to pick up:

- `packages/engine/native/` (the Rust crate, byte-identical to RUST-01's).
- `packages/engine/src/ast/native-parser.ts` and `parser-wasm.ts` (new files: the native loader
  behind `LETHAL_NATIVE_NODE`, and today's WASM parser renamed so both stay reachable).
- The `FlatNode` layer and `isMissing`/`hasError` additions in
  `packages/engine/src/ast/syntax-node.ts`, and `parser.ts`'s re-export of the native pair as
  `initParser`/`parseAL`.
- The R-236c `errorOffsets` port to `ALSyntaxNode` in `packages/runner/src/testpage-scan.ts`, the
  synthetic-node field plumbing in both tiers' `mutate-helpers.ts` and in
  `packages/schemata/src/compile.ts`/`dedup.test.ts`, and the grammar-instrument import updates in
  `scripts/lib/grammar-crosscheck.ts` (+ test), `scripts/probe-grammar-corpus.ts`,
  `scripts/probe-grammar-crosscheck.ts` and `scripts/r159-remainder-census.ts`.
- The rewritten `packages/engine/tests/ast/parser.test.ts`.

None of this is switch-over work: no loader hardening, no decision on the one differing unit test,
no W4 or W6 measurement. That is RUST-03.
