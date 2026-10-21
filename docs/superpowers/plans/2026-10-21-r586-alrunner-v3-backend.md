# R-586 plan r4: a new `al-runner-v3` backend for the Rust al-runner (3.0.0-alpha.N)

Plan only. No product code. r4 written 2026-10-21 by the bugs lane. It folds the r3 delta review
(`review-plan-r3-delta.md`, ADOPT with fixes) and the orchestrator's rulings on it, on top of r3 (the r2 delta
review) and r2 (the deep review `review-plan-opus.md`). **Where this plan and `precommitment.md` differ on a measured
figure or an oracle, the pre-commitment wins** (m-1); r4 brings §6, §11 and the open questions up to it.

Words used below:
- **v2** is the frozen .NET al-runner (f06ee78c). **v3** is the Rust al-runner, `3.0.0-alpha.N`.
- A **row** is one test's entry in v3's JSON output.
- A **batch** is one instrumented copy of the target, holding many mutants behind runtime guards.
- A **refusal** is a v3 row with `notRun: true` (v3 says it did not run the test).
- **Local runner** means a backend that publishes nothing (v2 or v3). **bcdev** is the live BC backend.

## Changes from r3

1. **The Sleep rule fails closed and is proven live (I-1, all five parts accepted).** §6 rewritten:
   (1) the index is built per `deploy()` from the instrumented `active/` text plus the test dir, under the absolute
   paths v3 reads, every arm included, and matched on RAW `--coverage-json` lines, never through the line map or the
   multi-object refusal; (2) a missing or partial coverage document, a covering test with no `perTestCoverage` entry,
   or an indexed line absent from the top-level `coverage` sends the affected covering passes to `error` /
   `runner-refused`; (3) a top-level hit on an indexed line that no per-test entry owns sends every covering pass of
   that call to `error` (this answers Q21); (4) a live positive control through the backend in leg X (d), on codeunit
   50660 with no CPU-bound sibling and the sleeping target `Probe Sleeper` (committed, `ab389cc6`); (5) the index
   size is pre-committed per leg (S1, N1, T 0; D 3 target + 0 test).
2. **I-2 rejected (measured by the lane):** Sleep is a no-op with or without a timeout flag; the "cut at N" readings
   were codeunit 50651's unselected `CpuHang` (#5611). `sleep-is-noop` = `defect-present` stays; its probe is
   codeunit 50660 (no CPU-bound sibling), its argv and expected wall are stated (§8), and one line says the probe's
   isolation from #5611 is load-bearing. The cost note stays "0 per covered Sleep".
3. **I-3 accepted:** on leg T, `held` only when every difference is one of the 52 rows of
   `precommitment-tables-52.txt` moving to the BC verdict recorded there; anything else is `gate-fail` (§12, T19 both
   directions).
4. **m-1:** §6, §11 and the open questions now state the measured facts: D oracles are bc3's live R594 reports
   (the hook fired), the D1c shim run is done (51 / 8 / 4, 0 of 63 differ), Q20 is measured (+20.6%, no fallback).
5. **m-2:** `<deps>` is re-hashed (sha256 of every file) once per `deploy()`; the per-`run()` check stays the cheap
   name, size and mtime list.
6. **m-3:** `plan-measure/state-notes.txt` names its inputs and uses the one-shot D1c report.
7. **Re-costed:** 61.5 h (r3 60.5 h; +1 h for I-1). The static fallback is not built (Q20).

## Delta for the reviewer (r4 only)

| Where | What changed | Item |
|---|---|---|
| header | the pre-commitment wins on measured figures | m-1 |
| §3 | `<deps>` re-hashed per `deploy()` | m-2 |
| §6 | index per deploy from `active/` + test dir, raw lines, fail-closed cases, Q21 rule, positive control, index sizes; CDO cost measured; static fallback dropped | I-1, m-1 |
| §8 | `sleep-is-noop` probe = codeunit 50660 with stated argv; `sleep-line-covered` on 50660 | I-2 |
| §11 | D oracles bc3 (R546 the cross-check); M5 done; leg X (d)-(f); R9, R10 | m-1, I-1 |
| §12 | leg T `held` rule | I-3 |
| §13 | T12, T19, T30 changed; T31, T32 new | I-1, I-3 |
| §14 | step 8 +1 h; total 61.5 | - |
| Open questions | Q20, Q21 closed; Q23 new (it gates the D predictions: one light CDO read) | - |

## Changes from r2 (r3, kept for history)

1. **Sleep (#5605, F1): `Sleep` is a NO-OP on alpha.2** (two `Sleep(600000)` ran in 72 ms; the r1/r2 "cut at the
   stop" came from a CPU-bound sibling in the same codeunit). r2's wall-excess check is removed (it could never
   trip). New rule, option (b) by ruling: every mutant call requests `--coverage-json`, and a covering `pass` whose
   per-test coverage hits a `Sleep(` statement in the TARGET or TEST app reads `error`, cause `runner-refused`
   (§6). Measured: the cost on sandbox-app is within noise (20 ms vs 23 ms per call); an executed Sleep line IS
   hit in `--coverage-json` (probe line 27). Dependency Sleeps are a stated residual. The static fallback (only
   if the CDO cost is large) is specified in §6 with the reach that exists. Contract fact `sleep-is-noop`.
2. **The timeout is CPU time (F2)**: r2's "wall" wording is reverted; new fact `timeout-is-cpu` (contended probe
   pinned with `taskset`); the confirm and R-577's reproduction stay mandatory; the outer bound scales by v3's
   10 x N wall backstop.
3. **F3**: the selector check requires `activeId === lastActivated`; leg X gains c4.
4. **F4**: the byte binding also covers both `app.json` files and the package folder's file list with sizes and
   sha256; `hashAlTree` stays (about 150 ms per call on 1,112 files, the reviewer's measurement).
5. **F5**: ONE call per test codeunit; N = the largest budget of the refs in that call, recorded per row; rows
   are cached only after a full, valid decode of the document.
6. **F6** (update gate): (a) the receipt is deleted before the run and matched by candidate sha256 plus a nonce;
   (b) the gate runs from the LethAL commit recorded in `.gated`, never a moving master; (c) a third receipt
   `held` for a move toward BC, never blacklisted; (d) `pass` lists the exact leg set, and a checksum mismatch
   never extracts.
7. **F7**: the `v3-codeunit-state-possible` counts are COMPUTED from the measured row orders
   (`plan-measure/state-notes.txt`, tool `state-notes.ts`): S1 0, N1 0, D1 51 of 51 kills, D1c 51 of 51.
8. **F8** (oracles): S1 against `bcdev.baseline.json` as reproduced on a named bc server (lethal-code's bc1/bc2
   proof); N1 against lethal-code's `itest:bcdev-names` result on bcN (log cited); D legs against R546's frozen
   Cronus28 `bc-A`/`bc-B` with the ruling's wording, and a hook for bc3 (R594). Leg T's BC cross-check is
   SUSPENDED (DK data); its own-baseline comparison stays. The oracle server's BC build is recorded beside v3's
   `--bc-version`.
9. **The I1/I3 notes use the existing per-mutant `failureNote` field** (tagged lines), not new report fields; the
   counts are read from those tags.
10. **Minor (M1-M5)**: T15 also flags string literals in argument position, defaults and `case` arms; v3 inherits
    `al-runner-coverage.ts`'s wrapped and multi-object refusal; `runMayLend` keeps each site's own inputs (the
    snapshot site reads its own error rows); the R592 filing gains `findBaselineSnapshot`; leg T's comparison is
    on the full transition as committed JSON; one shim run of D1c (not run yet: no heavy-job slot; the lane runs it, §11).
11. **Q14, Q16, Q19 as the review says**: whoever merges second makes `kind` required and classifies R-553's
    read; the predefined probe covers `#if` over CLEAN, CLEANSCHEMA and BC1..40; dependency-copy precedence is
    covered by F4's package list and F6d, not by `bc-build-pinned`.
12. **Re-costed**: 60.5 h, 63.5 h if the static Sleep fallback is needed (r2 57.5 h). §14.

## Delta for the reviewer (r3, kept for history)

| Where | What changed | Item |
|---|---|---|
| §0 | rows Sleep, timeout, notes | F1, F2, ruling 3 |
| §2 | row 4 (Sleep); capability `per-test timeout` back to CPU time | F1, F2 |
| §3 | step 3: `lastActivated`, `app.json` and package list in the binding | F3, F4 |
| §4 | one call per codeunit; N per call recorded per row; cache after full decode; notes in `failureNote` | F5, ruling 3 |
| §5 | timeout wording (CPU), outer bound 10 x N | F2 |
| §6 | REWRITTEN: Sleep no-op; coverage-based fail-closed rule; measured cost and premise; static fallback | F1, ruling 1 |
| §8 | facts: `sleep-is-noop` (replaces `sleep-hang-stopped`), `timeout-is-cpu` (replaces `timeout-is-wall`), `predefined-symbols` widened | F1, F2, Q16 |
| §9 | T15 scope (M1); notes field | M1, ruling 3 |
| §10 | `runMayLend` inputs per site; R592 extension | M2, M3 |
| §11 | oracles named per leg; X c4; D1c shim run; notes predictions | F3, F7, F8, M5 |
| §12 | receipts, nonce, pinned LethAL commit, `held`, exact leg set, leg T own-baseline only | F6, F8 |
| §13 | T12 rewritten; T22 gains c4 and the F4 checks; T19 gains F6; T28-T30 new | all |
| §14 | re-cost | - |
| Open questions | Q14-Q16, Q18, Q19 closed; Q17 open; Q20-Q22 new | - |

## 0. Summary of the design

| Decision | Choice | Why (measured unless marked) |
|---|---|---|
| Backend id | `al-runner-v3` | Upstream's product is now "AL Runner" v3; `al-runtime-rs` is archived. |
| `kind` | required `BackendCapabilities.kind`; every backend branch keys on it, never on `authoritative` | today `!caps.authoritative` MEANS v2 (C1) |
| Pin | `alrunner 3.0.0-alpha.2 (91253f2d6)` | ruling: alpha.3 refuses all 21 CDO-slice tests (#5606) |
| Transport | one-shot only (`al-runner test`) | ruling |
| Selection | ONE `--codeunit <id>` per call, rows read by structured `codeunit` + `method` | v3 runs the whole codeunit anyway (#5611); #5572 and #5612 disappear |
| Compile proof | alc on every batch and the test app on every `deploy()`; bound at `run()` to the bytes, `app.json` files, package list and the last activated id | #5602 |
| Selector | static only; `resource` refused by name | #5604 was a serve defect |
| Sleep (#5605) | a covering pass whose coverage hits a project `Sleep(` reads `error` / `runner-refused` | `Sleep` is a no-op on v3 (F1); a hang that sleeps would read `survived` |
| Timeout | CPU-time stop per test, confirm and R-577 reproduction mandatory | F2, `--help`, measured |
| Isolation | `--isolation test`, fixed | 0 differences on the three gate fixtures |
| Coverage | per-test from `--coverage-json`; CoverageMode stays `"al-runner"` | measured |
| `authoritative` | `false` | until #5602, #5603, #5605 are measured gone (§7) |
| Trust | `runMayLend` (§10) | history and snapshot reads have no backend filter |
| R-577 | `killsMustReproduce: true` | C2 makes it real |
| Refused in v1 | `campaign freeze`, Windows, `workers > 1`, `serverMode`, `selectorMode: "resource"` | by name |

## 1. Requirement map (owner decision 2026-10-21)

| # | Requirement | Where |
|---|---|---|
| 1 | Separate backend id; nothing in v2 moves | §0, §9 |
| 2 | Capabilities per measured fact; R586 rows mapped | §2 |
| 3 | Mandatory compile proof | §3 |
| 4 | Not-run rows never killed, never survived | §5, §6 |
| 5 | Own gate, per mutant | §11, `precommitment.md` |
| 6 | Pinned version with its own update gate | §12 |
| 7 | `authoritative: false` until the verdict-changing defects are gone | §7 |

## 2. R586's 15 rows: capability, named refusal or known difference

| R586 # | Issue | Class | LethAL treatment in v1 | Probe fact |
|---|---|---|---|---|
| 1 | #5602 non-compiling code runs | verdict-changing | **Closed on LethAL's side** by the alc proof (§3). Blocks `authoritative`. | `compile-failure-not-scorable` (`matches` via alc); `upstream-compile-errors` |
| 2 | #5603 statement `Insert()` duplicate key does not raise | verdict-changing | **Known-difference row** `v3-duplicate-key-insert` (7 tables rows). Blocks `authoritative`. | `duplicate-key-insert-raises` |
| 3 | #5604 `serve` stale resource | verdict-changing (serve only) | **Out of v1's scope**; resource selector refused by name on one-shot. | none in v1 |
| 4 | #5605 `Sleep` (corrected upstream: a NO-OP, not a cut) | verdict-changing | **Fail-closed refusal** for project Sleeps (§6); dependency Sleeps a stated residual (`v3-sleep-noop-dependency`). Blocks `authoritative`. | `sleep-is-noop` |
| 5 | #5606 alpha.3 company-open writer | refusal (regression) | **Pin** alpha.2; the update gate refuses a regressing build. | none (the CDO legs) |
| 6 | #5607 `Commit()` refused under `--isolation test` | refusal | **Named refusal**, §5; I3 note. 41 tables rows. | `commit-under-test-isolation` |
| 7 | #5608 outbound `HttpClient` refused | refusal | **Named refusal**, §5. | `refusal-row-shape` |
| 8 | #5609 `--isolation disabled` refuses every test | refusal | Never sent. | none |
| 9 | #5610 refusal cascade | refusal | **Named refusal**, §5. Row `v3-refusal-cascade`. | `refusal-cascade` |
| 10 | #5611 whole codeunit runs | difference | **The selection model** (§4); row `v3-codeunit-state`, I1 note. | `codeunit-runs-whole` |
| 11 | #5572 quoted names unselectable | difference | **Bypassed**. | `quoted-name-in-rows`; `quoted-name-unselectable` |
| 12 | #5612 option union | difference | **Bypassed** (T5). | none |
| 13 | #5613 exit 6 without a document | difference | `AlRunnerV3SelectionError`, the session stops. | `none-selected-exit` |
| 14 | #5614 `serve` recompiles | cost | **Out of v1's scope**. | none |
| 15 | #5615 no `CLEANSCHEMA<n>` predefines | difference | **Capability**: the predefined set measured over CLEAN, CLEANSCHEMA and BC1..40 (Q16); row `v3-no-cleanschema`. | `predefined-symbols` |

Capability flags (each measured, each re-checked by §8):

| Capability | Value | Measured where |
|---|---|---|
| `kind` (new, required) | `"al-runner-v3"` | design |
| `coverage` | `"al-runner"` or `"none"` (the Sleep check requests `--coverage-json` on mutant calls whatever this is) | measure.md 7; §6 |
| `deploy` | `"none"` | design |
| `isolation` | `"session"` (read by nothing today; declared for truth) | measure.md 13 |
| `authoritative` | `false` | §7 |
| `killsMustReproduce` | `true` | R-577 |
| `inRunStopIsBudget` | `true` | one-shot |
| multi-object and wrapped files | the R407 frame probe still runs and must admit; v3 inherits `al-runner-coverage.ts`'s wrapped and multi-object refusal (the safe direction, M1) | measure.md 7 |
| `--define`, `app.json` symbols | both read | measure.md 10 |
| per-test timeout | **CPU-time** stop, integer seconds; a test that waits without computing is stopped at 10 x N wall (v3 `--help`); row `Test exceeded Ns timeout.` with `notRun: true` | measure.md 6; F2 (a contended 1.7 s CPU loop at N=3 took 5.2 s wall and passed) |

## 3. The compile proof (requirement 3)

**Where.** In `AlRunnerV3Backend.deploy(instrumentedDir)`, after the batch is copied to `active/` and the two
control-registration files are dropped, and BEFORE any v3 process sees the folder:

1. **Target:** `alc /project:<active> /packagecachepath:<deps> [/define:<symbols>] /out:<scratch>.app` through
   `ArtifactCompiler.compileProject` (`AlcCompileError` / `ArtifactPrepareError`). `<deps>` is the folder v3 gets
   as `--package-cache`.
2. **Test app, on every `deploy()`**: compiled against the batch's `.app` plus `<deps>` (`compileTestApp`). A
   failure stops the session (`TestAppCompileError`).
3. **The proof, bound to what v3 reads** (I7, F3, F4): `{ deployId, activeHashExceptSelector, activeAppJsonSha256,
   testDirHash, testAppJsonSha256, packageList (name, size, sha256 of every file in <deps>), selectorObjectId,
   artifactId, manifestIds, targetAppSha256, testAppSha256, alcVersion }`. At EVERY `run()`:
   - re-hash `active/` without the selector (`hashAlTree`, about 150 ms on 1,112 files) and both `app.json` files;
   - re-list `<deps>` (name, size, mtime; sha256 re-read only when size or mtime moved). Because a same-size copy
     that keeps its mtime (`cp -p`, `touch -r`) passes that list, `deploy()` re-hashes every `<deps>` file's sha256
     once per batch and compares with the proof (m-2);
   - read the selector and require it to equal `emitStaticSelector({objectId, artifactId, activeId})` byte for
     byte, with `activeId === lastActivated` (the id the last `activate()` wrote; the baseline value when it was
     `null`), F3;
   - re-hash the test dir.
   Any mismatch throws `AlRunnerV3UnprovenBatchError` (extends `Error` directly); the session stops.
4. `compileCheck(dir)` = step 1 alone (never starts v3). 5. `compilePlainCheck(dir)` = step 1 on the plain copy
   (R461); sequential only, `workers > 1` refused.

**Why one compile per batch covers every mutant:** only the selector changes between mutants, and
`emitStaticSelector` differs between ids only in the literal (T3); step 3 checks the file really is that text.
**Positional target wins** (measured by the reviewer; fact `positional-target-wins`). **Failure mapping**
(orchestrator unchanged): `AlcCompileError` -> R461 plain check -> `bisectAndNote` (alc only) -> culprit note ->
the batch's `execute` mutants `error`; `ArtifactPrepareError` -> the session stops.

**Cost (measured 2026-10-21, alc 18.0.43.1464):**
| Build | alc wall |
|---|---|
| sandbox-app batch | 0.68-0.69 s |
| sandbox-tests against the batch `.app` | 0.74-0.80 s |
| broken sandbox-app batch | 0.56 s, exit 1, AL0118 (v3 on it: exit 7, 1 pass) |
| CDO slice batch (1,112 files) | 6.91 s, 6.96 s |
| CDO test app against the batch `.app` | 4.36 s, 3.82 s |

## 4. Selection and kill attribution

**Argv, ONE call per test codeunit** (F5):
`al-runner test --output-json --isolation test --test-timeout-secs <N> --codeunit <id> --package-cache <deps>
--bc-version <build> --no-download [--define S ...] --coverage-json <file> <active> <testDir>`

- `N` = the largest per-test budget LethAL gives any ref of this codeunit for this mutant, `max(1, ceil(ms/1000))`;
  every row from the call records the `N` it ran under (so a later timeout confirm reads the stop actually used).
- `--coverage-json` on every call: the baseline's per-test coverage, and on mutant calls the Sleep check (§6).
- Never `--test`, `--test-exact`, `--filter`, `--exclude-test`, `--allow-not-run` (T5).
- **Measured:** 9 of 12 sandbox-names tests (quoted) cannot be selected by name (exit 6); one `--codeunit 78850`
  call reports all 12 by AL name with per-test coverage; a mutated quoted-name procedure is killed in that call; a
  `--codeunit` row equals the `--test-exact` row.
- **Row match** on `codeunit` + `method` (locale-free `toLowerCase()`), cross-checked with `name`.
- **Cache only after a full decode** (F5): a call's rows enter the cache only when the whole document parsed, every
  row passed the decoder, and every needed test of the codeunit has exactly one row. Otherwise nothing from that call
  is cached and the covering step is `error` (`AlRunnerV3RowMissingError` or a transport failure).
- **Cache cleared unconditionally** at the top of `activate()` and `deploy()` (C2, T21).

**Kill attribution:** the killer is the first covering test in LethAL's order whose row is a kill; non-covering
siblings' rows are never verdicts.

**The notes, in the existing per-mutant `failureNote` field** (ruling 3): a tagged line per note,
`[v3-codeunit-state-possible] <why>` on a kill, `[v3-refused-test-nearby] <test>` on a survivor; the report's
existing free-text field carries them (it is excluded from gate equality, `mutant-equality.ts`), and the gate and
any count read them by tag. `failureNote` is today only set on `error` rows; the plan extends its doc and writes it
on `killed` and `survived` rows for v3 only.
- **`v3-codeunit-state-possible`** is set when a covering test of the killer's codeunit comes before the killer in
  v3's row order (then either it failed, so the killer is not the first failing row, or it passed and its state could
  reach the killer: both of I1's cases). Measured predictions (F7, `state-notes.txt`): S1 0 of 3 kills; N1 0 of 36
  (each mutant has one covering test, by the per-test coverage); D1 **51 of 51**; D1c **51 of 51** (the slice's 21
  tests are one codeunit and every killer has an earlier covering sibling). So on a real suite this note is the
  normal case, not an alarm; it says the kill was made in a shared-state codeunit run.

## 5. Rows, exit codes, refusals and the timeout sentence

**Exit codes:** 0, 1, 7, 8 read rows (8 also warns `al-runner-v3-dotnet-helper-missing`); 6 ->
`AlRunnerV3SelectionError`; 2, others, signals, or a missing document -> transport failure, never "all passed".

**Row -> TestVerdict** (decoder, then the imported `verdictFromRunnerTest`):
1. `notRun: true` with `pass`/`fail`: contract error, `runner-test-error`.
2. `notRun: true` + `Test exceeded Ns timeout.`: `timeout`, `reportedStopMs = N*1000` -> R517 confirm -> R-577
   reproduction (both mandatory: a CPU stop is not moved by load, but a reproduction is still LethAL's rule for a
   local runner, and the confirm guards a stop that is wrong for other reasons).
3. `notRun: true`, other message: refusal, `error` / `runner-refused` (the field wins over the prefix).
4. Otherwise `pass` / `fail`; then §6's check on each covering `pass`.

**Refusals, verdict and baseline effect:** at baseline a refused test goes to `unsupportedTests` and is never a
covering test (its only-covered mutants are `no-coverage`); the I3 note marks nearby survivors. Under a mutant a
refused covering row makes the step `error` / `runner-refused`; an earlier covering kill stands. Never `killed`,
never `survived` from a refusal.

**The timeout sentence (F2):** `--test-timeout-secs N` is a **CPU-time** stop per test; machine load does not count
(the reviewer: a contended 1.7 s CPU loop at N=3 ran 5.2 s wall and passed). A test that waits without computing is
stopped at 10 x N wall (v3 `--help`). **Outer wall kill per call:** `10 x N x (tests in the codeunit) + 90 s`; an
outer kill is a transport failure, never a kill.

## 6. Sleep (#5605): fail-closed

**The fact (F1, verified by the lane):** on alpha.2 `Sleep` does nothing: two `Sleep(600000)` in a Sleep-only
codeunit ran in 72 ms. The earlier "cut at N" readings came from `CpuHang`, a CPU-bound sibling in the same
codeunit (#5611); upstream #5605 was corrected publicly. So a mutant that makes a Sleep-retry loop run long is
`timeout-killed` on BC but passes on v3. A false SURVIVE.

(r4: the lane re-measured this against the r3 review's I-2, `plan-measure/sleep-noop-recheck.md`: with `CpuHang`'s
body deleted, `--test-exact SleepHang` takes 39 ms at N=2 and 32 ms with no flag; codeunit 50660 runs every Sleep in
0 ms, and the code after `Sleep(600000)` runs at once.)

**The index (I-1 (1)), built per `deploy()`.** After the alc proof, the parser reads the instrumented `active/` text
(the copy v3 reads, so every mutant ARM is in it, including an arm that changes the Sleep statement itself) and the
test dir. Every `Sleep(` CALL statement (a call whose callee is the bare identifier `Sleep`, case-insensitive; its
argument may be any expression, `Sleep(Delay)` included; a project procedure of that name matches too, which only errs
toward refusing; `X.Sleep(` on a variable and text in comments or strings do not) becomes an entry `(absolute path as
v3 reports it, line)`. It is matched against RAW `--coverage-json` lines: never through the line map, the coverage
index, or `al-runner-coverage.ts`'s multi-object and wrapped refusal (that refusal is the safe direction for SELECTION
and the unsafe one here: a Sleep in a refused file would be in no index). The index is dropped and rebuilt with every
`deploy()` (R349's rule for layout-derived state).

**The rule (option (b), ruling 1).** `--coverage-json` is requested on every call. After each MUTANT call, before any
row is scored:
1. **Missing or partial document (I-1 (2)):** no coverage file, a file that does not parse, or a covering test with no
   `perTestCoverage` entry -> every covering `pass` of the call (or that test's `pass`) reads `error` / `runner-refused`,
   `failureNote` `[v3-sleep-noop] coverage unavailable: <why>`.
2. **Absent indexed line (I-1 (2)):** v3's top-level `coverage` lists every statement of every file it compiled,
   zero-hit ones included (the reviewer: 24 statements, 12 at 0, in the probe's `cov.json`). If an indexed
   `(file, line)` is absent from it, v3 is not seeing that line, so a `pass` proves nothing: every covering `pass` of the
   batch's calls reads `error` / `runner-refused`, `[v3-sleep-noop] indexed Sleep <file>:<line> not in v3's coverage`.
3. **A covered Sleep:** a covering test whose row is `pass` and whose per-test coverage has a hit on an indexed line ->
   `error` / `runner-refused`, `[v3-sleep-noop] covered Sleep at <file>:<line>: Sleep does nothing on al-runner v3
   (#5605), so a pass here proves nothing about a wait; not scored`.
4. **An unowned hit (I-1 (3), answers Q21):** a hit on an indexed line in the top-level `coverage` that no test's per-test
   entry holds (a Sleep run in the test codeunit's OnRun, or in a subscriber v3 does not attribute to a test) -> every
   covering `pass` of that call reads `error` / `runner-refused`, `[v3-sleep-noop] unattributed Sleep hit at ...`.
A kill by an earlier covering test stands in every case (its failure is real). Baseline calls are not touched (a
green baseline stays green), so a baseline cannot be emptied by the rule. With an empty index, steps 2 to 4 cannot fire
and step 1 still does.

**Index size, pre-committed per leg (I-1 (5)):** S1 0, N1 0, T 0, D1/D1c 3 target lines + 0 test lines (counted in the
measured D1c `active/` and the CDO test dir), X (d) at least 2 + 4. An index of any other size is a miss, so an index
that found nothing can never pass as a match.

**Live positive control (I-1 (4)):** leg X (d) runs the probe target `Probe Sleeper` (`WaitThenDouble`: `Sleep(600000);
exit(X * 2);`) and codeunit 50660 (`SleeperDoubles` plus Sleep-only tests, NO CPU-bound sibling) through `runSession`
and the backend. Every mutant whose arm executes a Sleep and whose `SleeperDoubles` row passes must read `error` with
the `[v3-sleep-noop]` note; a mutant that changes `X * 2` reads `killed`; one that removes the Sleep reads `survived`.
Legs X (e) and (f) drive cases 1, 2 and 4 through test hooks. These are what make the rule fail loudly if a path key
stops matching.

**Measured premise and cost** (`plan-measure/covjson-cost-sandbox.txt`, tool `covjson-cost.sh`):
- An executed `Sleep(600000)` line (probe `ProbeHang.Codeunit.al` line 27) IS hit in `--coverage-json`.
- sandbox-app, 10 one-shot `--codeunit 79100` calls each: 23 ms mean without `--coverage-json`, 20 ms with it
  (noise); the file is 28 KB.
- CDO slice (measured by the lane, `plan-measure/covjson-cost-cdo.txt`): 5 calls of codeunit 68933 each, mean
  1,696 ms plain and 2,045 ms with `--coverage-json` (+20.6%, a 5.5 MB file). Under the +25% limit, so the coverage
  rule stands and the static fallback is NOT built.
- A covered Sleep costs 0 under a mutant (Sleep is a no-op), so the 10 x N outer bound needs no allowance for it.

**Residual, stated:** Sleeps inside dependency code (on the CDO closure, counted: Base Application 28 lines, System
Application 3, Business Foundation 1, Tests-TestLibraries 5; the Continia apps 0) are not in v3's coverage and are
NOT caught. Known-difference row `v3-sleep-noop-dependency`. The CDO target's own 3 Sleep lines are in
`CDO Continia Online PDF Mgt` and `CDO Send Mail Management`, not in the slice's codeunit; the gate fixtures hold no
Sleep (sandbox-probes, which does, is in no gate). Predicted §6 refusals on every leg: 0.

**Static fallback: not built** (Q20 measured +20.6%). For the record, the reach that exists is `loop-hazard.ts`'s
one hop into same-object callees (R500) and R570's exit-callee chains, so a static rule would be unsound beyond one hop,
across objects and through events.

**`sleep-is-noop` stays a contract fact** (`defect-present` on alpha.2, probe codeunit 50660, §8): when it reads
`gone` (`LongSleepThenAssert` passes, or a Sleep test comes back as a timeout), the rule can be relaxed by a
pre-commitment, never on its own.

Red tests, both directions: T12 (case 3: a hit -> `error`; `hits: 0` -> scored; an earlier kill stands), T31 (the
index is built from `active/` and the test dir, not the original source), T32 (cases 1, 2 and 4 each fire, and none
fires on a complete document with every indexed line present at 0 hits).

## 7. `authoritative: false`, and what each defect blocks

| Defect | Blocks while present | Gone when |
|---|---|---|
| #5602 | nothing at verdict level (alc proof); `compileCheck` stays alc-based | `upstream-compile-errors` = `gone` |
| #5603 | false survivors through a statement-form duplicate-key `Insert` | `duplicate-key-insert-raises` = `gone`, AND the 7 tables rows match BC |
| #5604 | resource selector; serve | out of v1 |
| #5605 | project Sleep passes read `error`; dependency Sleep passes read `survived` (residual) | `sleep-is-noop` = `gone` |

## 8. The v3 contract probe (R123-style)

As r2, with these facts changed or added:

| Fact | Expected on alpha.2 | Kind |
|---|---|---|
| `sleep-is-noop` (replaces `sleep-hang-stopped`) | probe codeunit 50660 (`extras/ProbeSleep.Codeunit.al` + `extras/ProbeSleeper.Codeunit.al`, runner `sleep-noop-probe.sh`), argv `--codeunit 50660 --test-timeout-secs 3 --coverage-json <f>` and again with no timeout flag: the whole call under 1 s of wall each time; the Sleep tests `pass` with `durationMs` 0; `LongSleepThenAssert` FAILS `after sleep <n>`, n under 1000. **The probe's isolation from #5611 is load-bearing:** 50660 holds no CPU-bound test (in 50651 the unselected `CpuHang` burns the stop, which read as "cut at N") | defect |
| `timeout-is-cpu` (replaces `timeout-is-wall`) | under `taskset -c 0` with a competing busy loop on core 0, a 1.7 s CPU loop at N=3 passes with wall over 3 s; and alone, a CPU loop at N=3 gives a timeout row at about 3 s | contract |
| `predefined-symbols` (was `predefined-symbols-empty`) | no arm active over `#if` CLEAN, CLEANSCHEMA1..25 and BC1..40 (Q16) | contract |
| `sleep-line-covered` (new) | in the 50660 run, `LongSleepA`'s per-test coverage hits its Sleep line and `SleeperDoubles`'s hits `Probe Sleeper`'s; both lines also appear in the top-level `coverage` (the §6 premise, and case 2's "every compiled statement is listed") | contract |

All other facts as r2 §8 (`version`, `unknown-flag-rejected`, `rows-shape`, `quoted-name-in-rows`,
`codeunit-row-equals-exact-row`, `none-selected-exit`, `timeout-classified`, `refusal-row-shape`,
`bc-build-pinned`, `positional-target-wins`, `define-honoured`, `per-test-coverage`, `compile-failure-not-scorable`,
and the defect facts `upstream-compile-errors`, `duplicate-key-insert-raises`, `refusal-cascade`,
`codeunit-runs-whole`, `quoted-name-unselectable`, `commit-under-test-isolation`).

## 9. Wiring, and every shared site classified (C1)

As r2 §9 (the review checked the classification and found it holds), with:
- **T15's scope (M1):** besides `authoritative` reads and `===`/`!==` compares, it flags backend-name string
  literals in argument position (`f("al-runner")`), in parameter defaults, and in `case "al-runner":` arms.
- **Notes:** no `SessionReport.alRunnerV3Notes` and no `MutantOutcome.v3Notes`; the notes are tagged lines in
  `failureNote` (§4). The report ripple shrinks to `backend` from `kind`, `executionContexts[].runnerBuild`,
  `binarySha256` and `oracleBcBuild` (the oracle's build, F8; optional, gate reports only).
- **R-553 (Q14):** whoever merges second makes `kind` required and classifies R-553's read of it in the T15 list.

## 10. Trust, store and resume

As r2 §10 (`runMayLend` in the fixed order backend-and-build, R-557 mark, R-557 C1; four sites; R-577 separate),
with (M2): each site passes its OWN inputs: `priorSurvivorKeys` and `findResumableRun` read
`ctx.baselineErrorMethods(runId)`; the snapshot site passes the snapshot's own `baseline` error rows (as today's
tainted check does), not the run's. And (M3): the pre-existing gap filed as R592 is extended: `findBaselineSnapshot`
also lends across bcdev and v2 under coverage `none`.

## 11. The gate: `itest:alrunner-v3`

All legs one-shot. Every leg compares PER MUTANT through `normalizeForComparison` + `compareMutants`, and also
compares the set of mutants carrying each note tag and each §6 refusal with the pre-commitment.

| Leg | Fixture | Coverage | Oracle (F8) | Frozen figure |
|---|---|---|---|---|
| C | contract probe | - | the fact table | every fact as expected |
| S1 | sandbox-app + sandbox-tests | al-runner | `bcdev.baseline.json`, reproduced live on bc1 (BC 28.4.53241.56590 W1; logs cited in the pre-commitment) | 3 / 12 / 4, 0 of 19 differ |
| S3 | same, `selectorMode: "resource"` | - | - | refused by name |
| N1 | sandbox-names + -tests | al-runner | lethal-code's `itest:bcdev-names` result on bc1 (log cited), equal to `bcdev.names.baseline.json` | 36 / 0 / 0, 0 of 36 differ |
| X | the sandbox-app batch, through the backend directly; and (d)-(f) on the Sleep probes | - / al-runner | - | (a) AlcCompileError, 0 spawns; (b) v3 alone exits 7 with 1 pass; (c1-c3) as r2; (c4) the selector rewritten to ANOTHER manifest id than the last activated -> `AlRunnerV3UnprovenBatchError`; (c5) one byte changed in `active/app.json` or one file added to `<deps>` -> the same; (d) the Sleep positive control (§6); (e) a removed coverage document; (f) a missing per-test entry, an absent indexed line, an unowned hit: each fails closed as the pre-commitment says |
| D1 | R546 CDO slice (opt-in corpus) | none | bc3's live `docs/measurements/r594/bc3-A.report.json` (the hook fired); R546's Cronus28 `bc-A` the cross-check | 51 / 12 / 0, 0 of 63 differ |
| D1c | same | al-runner | bc3's live `bc3-B`; R546's `bc-B` the cross-check | 51 / 8 / 4, 0 of 63 differ |

**bc3 hook (R594): fired.** R594 measured the slice live on bc3 (BC 28.4 W1, Continia stack in Dev scope) at 63 of 63
equal to bc-A and bc-B per mutant, so `D_LEG_ORACLE` names bc3's reports.

**M5, D1c through the shim: done** by the lane: 51 / 8 / 4, baseline green, 0 of 63 differ from bc-B, 560 s
(`/coord/handoff/R-586/cdo-alpha2-d1c/oneshot-cov.compare.txt`).

Red checks R1-R8 as r2, with R7 covering c3 and c4, and R8: drop the §6 rule -> T12 red and leg X (d) red. New R9:
build the index from the original source instead of `active/` -> T31 and leg X (d) red. New R10: read a missing
coverage document as "no hit" -> T32 and leg X (e) red.

**Every existing itest figure unchanged** (as r2).

## 12. The pin and its update gate

As r2 §12, with (F6, F8):
- **(b) Pinned LethAL commit:** `.gated` records `lethalCommit` (the LethAL commit that gated the build). The update
  script runs the candidate's gate in a detached worktree `/work/lethal-wt/al-runner-v3-gate` at the CURRENT gated
  build's `lethalCommit`, never at a moving master. Moving the LethAL side is a separate, manual `--regate` of the
  current build at a new commit, which must pass before candidates are gated there.
- **(a) Receipts:** the script deletes `<gate-dir>/receipt.json` before the run, passes a fresh nonce
  (`LETHAL_V3_GATE_NONCE`), and accepts a receipt only if it carries that nonce and the candidate's binary sha256.
- **(c) Four outcomes:** `pass`; `gate-fail` (a per-mutant difference away from the oracle, a contract `diverged`, a
  new refusal, a note or refusal set that differs) -> `failed/`, never retried; `held` (every difference is a move
  TOWARD the BC oracle, for example a #5603 fix turning a tables survivor into BC's kill) -> kept under `held/`,
  never blacklisted, a line for the orchestrator to re-pre-commit; `infra-fail` -> retried, after 3 in a row a line
  for the orchestrator.
- **(d)** `pass` lists the exact leg set `{C, S1, S3, N1, X, D1, D1c, T}`; a receipt missing any leg is not a pass.
  A checksum mismatch is `infra-fail` and the tarball is NEVER extracted.
- **Leg T:** own-baseline only (`al-runner-v3.tables.baseline.json`, recorded once on alpha.2). The BC cross-check
  is SUSPENDED: `tables.baseline.json` is DK data measured on Cronus28 (F8). The 52 named rows stay in
  `precommitment-tables-52.txt` as the recorded explanation of how the own baseline differs from BC, compared on the
  full transition as committed JSON (M4) once a bc server re-proves `tables.baseline.json`.
- **`held` on leg T (I-3):** with no live BC oracle on T, "toward BC" is read from `precommitment-tables-52.txt` alone:
  a leg-T difference is `held` only when the row is one of the 52 AND it moves to the BC verdict (and killing test)
  that file records for it. The outcome is `held` only when every difference of every leg is `held`-eligible; one
  other difference makes the whole run `gate-fail`.
- Every gate report records the oracle server's BC build (`oracleBcBuild`) beside v3's `--bc-version`.

## 13. Unit tests (a red test per direction)

As r2 §13 (T1-T27), with these changed:
| # | Test | Red when (1) | Red when (2) |
|---|---|---|---|
| T5 | argv: ONE `--codeunit` per call; `--coverage-json` always; forbidden options never | two codeunits in one call, or a forbidden option | `--coverage-json` missing on a mutant call |
| T12 | §6 case 3: covering pass hitting an indexed Sleep line -> `error`/`runner-refused`; `hits: 0` -> scored; an earlier kill stands | rule off (reads survived) | rule fires on a Sleep line with 0 hits, or on a baseline call |
| T22 | binding: c1-c5 (target byte, test dir, selector id not in the manifest, id not the last activated, `app.json` byte, `<deps>` file added) | any check removed | an unchanged folder refused |
| T19 | update script: receipt deleted first, nonce and sha256 matched; runs at `.gated`'s `lethalCommit`; `held` never blacklisted; `pass` needs every leg; checksum mismatch never extracts; leg T `held` only for a listed row moving to its recorded BC verdict (I-3) | a stale receipt accepted; a held build blacklisted; or a #5603-fix diff on one of the 7 listed rows read as `gate-fail` | a valid pass refused; or a diff on an UNLISTED row, or a listed row moving to a non-BC verdict, read as `held` |
| T24 | the I1 note in `failureNote`: set iff a covering test of the killer's codeunit precedes the killer in v3's row order | never set | set on a first-row kill |
New:
| T28 | N per call = the largest budget of the call's refs, recorded on each row | the first ref's budget used | a ref's own smaller budget used for the stop |
| T29 | rows cached only after a full valid decode (a malformed second row caches nothing) | partial rows cached | a valid document not cached |
| T30 | the Sleep index: bare `Sleep(` calls found by the parser (`Sleep(Delay)` included, a test-app helper included); `Sleep` in a comment or string not indexed; `X.Sleep(` (a method on a variable) not indexed | a comment indexed | a real call missed |
| T31 | the index is built per `deploy()` from `active/` (every arm, guard lines included) and the test dir, under v3's absolute paths; a Sleep in a multi-object or wrapped file is indexed | built from the original source (lines shift), or a refused file skipped | a second `deploy()` keeps the first layout's index |
| T32 | fail closed: (1) no coverage file / unparsable / a covering test with no per-test entry; (2) an indexed line absent from top-level `coverage`; (4) a top-level hit no test owns: each sends the right passes to `error` | any case read as "no hit" | a complete document with every indexed line present at 0 hits makes anything `error` |

## 14. Live plan and cost

| Step | What | Hours |
|---|---|---|
| 1 | Delta review of r4 (if any), fold in | 1.5 |
| 2 | The lane commits pre-commitment r4 (FILLs done) | 0.5 |
| 3 | Required `kind`, predicates, §9 sites, T15 (with M1), T20, T27 | 5 |
| 4 | Report: `backend` from `kind`, `runnerBuild`, `binarySha256`, `oracleBcBuild`; `failureNote` on killed/survived for v3; schema, snapshots, sample reports | 1.5 |
| 5 | Store column, `runMayLend` at four sites with their own inputs, resume filter, freeze refusal, T14 | 4 |
| 6 | Backend: deploy, alc proof, binding (F3, F4), guards (T1-T4, T22, T23) | 6.5 |
| 7 | Backend: one call per codeunit, N per call (F5), decoder, cache after full decode, attribution, notes (T5-T11, T13, T21, T24-T26, T28, T29) | 7.5 |
| 8 | §6 Sleep rule: per-deploy index from `active/` + test dir, raw-line match, the four cases, leg X (d)-(f) hooks (T12, T30, T31, T32); no static fallback | 4 |
| 9 | CLI wiring, config, refusals, doctor (T16, T17) | 3 |
| 10 | Contract probe + probe projects, incl. `sleep-is-noop`, `timeout-is-cpu` (taskset), `predefined-symbols` over CLEAN/CLEANSCHEMA/BC1..40, `sleep-line-covered` | 5.5 |
| 11 | `.gated` reader (T18), update script with nonce receipts, pinned LethAL commit, `held`, exact leg set (T19) | 6.5 |
| 12 | `itest:alrunner-v3`: C, S1, S3, N1, X (c1-c5), note and refusal set comparisons | 4 |
| 13 | D1, D1c, leg T (own baseline), corpus guards, `D_LEG_ORACLE` hook, record the tables baseline once | 3 |
| 14 | Red checks R1-R10, both directions | 3 |
| 15 | Live: gate on alpha.2 without D, then with D and T (one corpus job), `itest:alrunner` on v2 | 2 |
| 16 | Docs | 2 |
| 17 | Opus review of the built diff, CI both jobs green, submit | 2 |
| | **Total** | **61.5** |

## Open questions for the reviewer

Closed by the delta review: Q14 (merge order: second merger makes `kind` required), Q15 (about 150 ms, kept), Q16
(probe widened), Q18 (moot), Q19 (F4 package list and F6d). Open:
- **Q17. Coverage of a refused row** (does `--coverage-json` report lines for a test v3 refused?). Branch (b) of the I3
  note works without it.
- **Q20: closed, measured** (+20.6% on CDO, under the +25% limit; no static fallback).
- **Q21: closed by rule** (I-1 (3)): a top-level hit on an indexed Sleep line that no per-test entry owns sends every
  covering pass of the call to `error`. Whether v3 attributes OnRun or subscriber lines to a test is still unmeasured,
  but either answer is now safe.
- **Q23 (new, decides the D predictions). Does v3's top-level `coverage` list every statement of a compiled file that
  no test reached?** Case 2 of §6 assumes it (the reviewer saw zero-hit statements in the probe's `cov.json`). On the
  CDO slice the 3 indexed Sleep lines are in two files the slice's tests do not reach. If v3 omits such a file from the
  top-level list, case 2 sends every covering pass of the D legs to `error`, so D1's 12 and D1c's 8 survivors would
  read `error` and the D predictions break. One light read of a D1c `--coverage-json` (does it list `Codeunit 6175274
  CDO Continia Online PDF Mgt.al` and `Codeunit 6175335 CDO Send Mail Management.al` with their Sleep lines at 0 hits?)
  settles it; the Q20 runs deleted their 5.5 MB files, so this needs one CDO call. If they are absent, v3's list holds only files
  something ran, so an absent file was not executed in that call; case 2 then fails closed only for an indexed line
  missing from a file v3 DID list (a file present but the Sleep statement not, which means v3 cannot see that line).
  The pre-commitment's D figures stand only if this is measured before the lane commits it.
- **Q22. The notes at 51 of 51 on a real suite.** The I1 note fires on every CDO kill. It is honest but carries
  little signal there; should it be counted only, or narrowed (for example to kills where an earlier covering test
  FAILED under the mutant)?
