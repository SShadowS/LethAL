# R-586 pre-commitment r15 (R-586b): al-runner v3.0.0-alpha.5 (07342060e), measured once, judged in advance

DRAFT for review. Not committed. Master path when committed:
`docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r15-alpha5.md`.

Naming: the task called this "r11", but r11 (`xd-sleep5000`), r12 (`message-prefix`), r13 (`dependency-skip`) and r14
(`timeout-is-cpu`) are already on master. The next free number is **r15**. The file name in `/coord/handoff/R-586b/`
stays `precommit-r11.md` only because the task named it.

Written by lane bugs on 2026-10-24, from READING ONLY: the failed receipt and gate log, the daily log, master's gate
code and the upstream issues. No gate, no probe and no al-runner call was run for this draft. It is committed
(specs only, `[skip ci]`) before any `--regate` and before any code that reads alpha.5.

It is a delta on r14 (`2026-10-23-r586-alrunner-v3-precommitment-r14-timeout-is-cpu.md`) and the deltas before it.
Everything there stands except what is below. A differing verdict in any leg is still a BLOCK.

Evidence:
- the failed receipt and log: `/work/tools/al-runner-v3/failed/v3.0.0-alpha.5@6eddda0bc744b5397dc11c5edc34fc841d065e47/`
  (`receipt.json`, `gate.log`, the kept binary, sha256 `fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2`);
- the daily log `/coord/handoff/al-runner-v3-update/2026-10-24.log`;
- upstream: release v3.0.0-alpha.5 (`07342060e`, published 2026-10-23 20:46Z) and issues #5700, #5607, #5605, #5623.

## Why

The daily update gated alpha.5 on 2026-10-24 at LethAL **6eddda0b**, which is `.gated`'s commit, not master's. It read
`gate-fail`: C `gate-fail`, X `held`, T `held`, and S1, S3, N1, D1, D1c `pass`. `current` stays alpha.2.

**The gate that judged it is older than master.** Master has moved by many commits since 6eddda0b. Three things in that
run therefore do not describe master's gate:
- Leg C ran **26 facts** (r9's count). Master has **28**: r12's `message-has-no-type-prefix`, r13's
  `dependency-skip-line`, and r14's changed `timeout-is-cpu` (two burns, A and B). alpha.5 has never run those.
- The receipt's legs were `C, S1, S3, N1, X, D1, D1c, T`. Master's gate also judges **L1, Y-A, Y-B, MO and WR**
  (`V3_GATE_LEGS`, 13 legs), and the itest runs K. alpha.5 has never run any of them. The receipt shows them as
  "missing legs L1,Y-A,Y-B": the daily script's own checkout had 11 gate legs (after R654 S2, before R602), so it
  did not list MO and WR.
- The 7 leg-T rows and every leg-C reading below were measured by that older code. They are still the right
  evidence: leg C's other facts and leg T's rows do not depend on the later commits. **Inferred unchanged at the new
  head:** the later commits that touch the v3 backend or gate (R675, R-435, R608/R645, R602, R-653, R-678) were each
  pre-committed to move no alpha.2 figure; whether they move an alpha.5 figure is measured by the next daily run,
  under the BLOCK rule below.

This delta records what alpha.5 did, says which reading is a fix, which is a refusal and which is still a difference
from BC, and predicts the legs it has not run.

## What alpha.5 changed (measured in the receipt)

### Leg C: six defect facts moved, one warn fact moved, one defect fact is now unlike BC

Fact counts in the log: 26 facts = 16 `matches` + 5 `gone` + 2 `defect-present` + 1 `refused` + 1 `unlike-bc` + 1 warn
`diverged`. Every contract fact that ran reads `matches`.

| Fact | alpha.2 (pinned) | alpha.5 | Basis (receipt line) |
|---|---|---|---|
| `none-selected-exit` | `defect-present` | **`gone`** | "exit 6, stdout 0 rows" (#5613, fixed by #5622, in alpha.4 too) |
| `quoted-name-unselectable` | `defect-present` | **`gone`** | "exit 0" (#5572) |
| `refusal-cascade` | `defect-present` | **`gone`** | `LaterFails` is a plain `fail`, message `later`, exit 1 (#5610) |
| `sleep-is-noop` | `defect-present` | **`gone`** | N=3: `ShortSleep` pass; `LongSleepA` `error` "Test exceed…" in 26-102 ms (#5605: a Sleep now counts toward the time limit) |
| `upstream-compile-errors` | `defect-present` | **`gone`** | "exit 3 null" (#5602) |
| `duplicate-key-insert-raises` | `defect-present` | **`refused`** | `DuplicateNamedKey` is `error`, `notRun`, "NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Probe Row is deferred: whether the test runner raises it at the end of the test is not pinned", exit 7 (PR #5623) |
| `codeunit-runs-whole` | `defect-present` | `defect-present` | unchanged ("rows=0 counter=1") |
| `commit-under-test-isolation` | `defect-present` | `defect-present` | unchanged: `notRun`, exit 7 (#5607 is still open) |
| `refusal-row-shape` | `defect-present` (refused) | **`unlike-bc`** | `HttpGet` to `http://localhost:1/x` is a plain `fail` with "There was an error while executing the HTTP request, the connecting endpoint violates security requirements…", exit 1 |
| `refusal-row-shape-public` | `matches` | `matches` | refusal row for `example.com`; its TEXT changed (see below), the reading did not |

`duplicate-key-insert-raises` is `refused`, never `gone`: v3 declines the test; it does not fail it as BC does. bc1 shows
BC FAILS that test at its end with `BC_END_OF_TEST_TEXT` (r9).

The refusal text for an unhandled public HTTP call also moved. alpha.2 said "an outbound HTTP request with no
[HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)". alpha.5 says "an outbound HTTP
request that a test handler does not answer: the runtime never opens a connection (ADR-027). To run the test, bind an
[HttpClientHandler] that answers the request, or set TestHttpRequestPolicy = BlockOutboundRequests on the test codeunit
to get BC's error for it". `refusal-row-shape-public` only asks for a refusal row, so it still reads `matches`.

### `serve-keep-reasons` (warn fact): every keep reason MOVED

**Old (alpha.2, `matches`, the five entries of `V3_SERVE_SAFE_REFUSALS`):**

| Entry | Row | The text the daemon keeps on |
|---|---|---|
| http | `Codeunit50670.HttpGet` | `NotRun: out-of-scope: an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)` |
| commit | `Codeunit50671.CommitCall` | `…Commit inside a test under TestIsolation = Function…` (two accepted wordings) |
| cascade | `Codeunit50672.LaterFails` | `…an earlier test of this codeunit was refused while it ran (…)` |
| onrun-failed | `Codeunit50673.Never` | `…OnRun failed (runner behaviour not pinned): …` |
| no-callee | `Codeunit50674.DoesNotCompile` | `…<file>: call \`<call>\` has no callee the checker resolved` |

**New (alpha.5):** all five read `MOVED no row <name>`: the serve answer holds **no row at all** for any of the five
tests. That is the whole measured reading: no text came back to compare.

What is known from other facts, so the moved list is not read as five changed texts:
- **http:** the one-shot text for a public host changed (above) and the `localhost` call is now a plain fail, so the
  anchored regex for http would no longer match even if a row came back.
- **commit:** the one-shot text is unchanged (it still matches the second wording of the commit regex).
- **cascade:** `refusal-cascade` is `gone` one-shot: the later test is a trusted `fail`, so there is no cascade
  refusal left to keep the daemon on.
- **onrun-failed, no-callee:** not measured one-shot. #5748 (open) says an OnRun that raises is still refused. #5602's
  fix makes upstream refuse uncompilable code with exit 3, so a "no callee" row may no longer exist.
- **Why there is no row at all (diagnosed):** the probe's own codeunit 50674 (`NoSuchProcedure(1)` in `DoesNotCompile`,
  in `SERVE_TESTS_AL`, `packages/runner/src/al-runner-v3-contract.ts`) does not compile. Since #5602's fix (alpha.4,
  edge, alpha.5), v3 runs no test in a request whose apps do not compile, so no row comes back for ANY of the five.
  alpha.3 (#5602 still present) reads `matches`; alpha.4, edge and alpha.5 read "no row". R635 records the same
  cause. **The probe is blind on every #5602-fixed build.** The fix is LethAL's: move no-callee into its own request,
  or drop it (roadmap item `R705`). This is not an upstream difference.

This is a WARN fact and it changes no gate outcome. But "costs speed only, never a verdict" is NOT proven for
alpha.5: K, the only leg that exercises the serve path, is skipped on candidate builds, so nothing measures alpha.5's
serve path. **A K / serve measurement on alpha.5 is a prerequisite of R-586c.** Until the probe is fixed, alpha.5's
keep reasons are unpredicted beyond "no row". If alpha.5 is ever admitted, `.gated.warnFacts["serve-keep-reasons"]`
will read `diverged`, and a session will show that, never a `matches` it did not see.

### Leg C: `refusal-row-shape = unlike-bc` (#5700)

**Evidence.**
- The reading is measured: alpha.5 fails the `localhost:1` call with the "security requirements" text
  (`HttpRequest:Security`). bc1 (BC 28.4, Linux, web-service session, runner 130450, no `TestHttpRequestPolicy`)
  fails the same test with `BC_HTTP_INTERNAL_TEXT`, "The request was blocked by the runtime to prevent accidental use
  of production services." (`docs/measurements/r639/`). Both are plain fails; only the text differs.
- Upstream's reply on #5700 (maintainer, comments of 2026-10-22 and later): on Windows BC 28.5 and 29.0, cloud and
  OnPrem apps, the call gives "…connecting endpoint violates security requirements…" (`HttpRequest:Security`), "which
  is what AL Runner gives today and what our corpus pins". Their corpus CI also runs on the BC-on-Linux image, through
  the test runner hub, and gets the same `HttpRequest:Security`. They suspect the difference is our **web-service
  session under runner 130450**, not the image. They have NOT confirmed it. They keep #5700 open until their Windows
  nightly has run our repro under runner 130450, and "treat it as not an AL Runner issue".
- No leg's verdict moves on this text: S1, N1, D1 and D1c read 0 per-mutant differences from their BC oracles with the
  `unlike-bc` warning printed, because none of those fixtures asserts on an HTTP error text. So the data neither
  supports nor contradicts v3's text in the legs; it says only that the probe's `HttpGet` is different.

**The default ruling (this delta adopts it): `refusal-row-shape` stays `unlike-bc`, which is `gate-fail` in leg C
and a by-name refusal in a normal session, until one of (a) or (c) below.** Reasons:
1. LethAL's oracle for "BC's reading" is bc1 through the web-service path. Until a measurement says that path differs
   from what a user's own CI sees, the pinned text is the oracle, and r9's rule ("both fail, only the text differs is
   not safe for a user's suite: a test that asserts on `GetLastErrorText` would get a different verdict") stands.
2. The only thing that has changed since r9 is that the release carrying the text exists. The maintainer's reply gives
   a hypothesis (our harness path), not a result.
3. A gate that admits a build on an unconfirmed hypothesis cannot be un-admitted without moving `current` back.

**What would change the ruling.** Either of these, with its evidence in `/coord/handoff/`:
- (a) A client-session or test-runner-hub run of the same test, on a leased bc server, reads the "security
  requirements" text, while the web-service run reads the "blocked by the runtime" text. The run uses the same BC
  build, the same probe app and `TestHttpRequestPolicy` absent, as `docs/measurements/r639/`. Then v3's text is what a
  user's CI sees, and `BC_HTTP_INTERNAL_TEXT` is an artefact of our harness. The pin would add the "security" text as a
  second `gone` text (a delta, with its own tests). **Lifting under (a) also needs the bcdev harness question
  decided** (the authoritative backend runs tests in a session whose error texts differ from a user's CI); that is a
  separate roadmap item.
- (c) The owner rules, by name, that the text does not matter for this gate.

**Evidence that confirms the ruling (it does not lift it):** (b) upstream's Windows nightly under runner 130450 reads
the "blocked by the runtime" text. Then v3 is wrong and the upstream fix is theirs; `unlike-bc` stays until they change
it.

**(d) Upstream closes #5700 as a BC-on-Linux image difference.** This does NOT lift the ruling by itself, because our
oracles bc1-bc3 are BC on Linux. It becomes an owner ruling (c), plus a roadmap item.

**The other exit:** if a later build writes `BC_HTTP_INTERNAL_TEXT`, the fact reads `gone` (held), and that is a normal
re-pre-commitment.

Until one of these, the update gate reads `gate-fail` on alpha.5 from leg C, and `current` stays alpha.2.

### Leg X: `held`, by X (b), NOT by #5700

The task text says X is held by the #5700 refusal. The receipt says otherwise:
- X's `held` comes from **X (b)**: "exit 3 passed 0 notRun 0: v3 now refuses the broken target (#5602 fixed)". That is
  the `xbHeldFirst` path, a move toward BC.
- The `unlike-bc` line on X is only the warning that every candidate leg prints (`al-runner-v3-defect-unlike-bc`).
  It does not decide X.
- X (a) `AlcCompileError; v3 spawns 0`, X (c1)-(c5), and X (d)-(f) all read as pre-committed (below).

| Part | alpha.2 | alpha.5 | Status |
|---|---|---|---|
| X (a) | `AlcCompileError`, spawns 0 | same | as pre-committed |
| X (b) | runs the broken target, its test passes | **exit 3, passed 0, notRun 0**: refused | `held` (#5602) |
| X (c1)-(c5) | `AlRunnerV3UnprovenBatchError`, spawns 0 | same | as pre-committed |
| X (d) | r5 table (r11: Sleep 5000) | M0001 killed, M0002 survived, M0003 and M0004 `error` by §6 at :25 and :37, M0005 killed; `SleeperDoubles` baseline `pass`; Sleep index 4 + 5 | **equals the r5 table** |
| X (e), (f1)-(f3) | pre-committed | same lines | as pre-committed |

Notes:
- X (d) printed `baselineGreen false`. That is the three 600 s sibling tests (r11 keeps them): on alpha.5 a Sleep counts
  toward the time limit, so they are baseline `timeout` rows. `SleeperDoubles` itself is `pass` and the table is the
  r5 table: this is the first live evidence that r11's 5 s Sleep makes X (d) pass on a build that counts Sleep.
- The mutants M0003 and M0004 still read `error` ("[v3-sleep-noop] covered Sleep … Sleep returns…") because LethAL's
  §6 still refuses a mutant whose covering test reaches a Sleep. It does not yet use alpha.5's new behaviour. That is
  R649 step 2, not this delta.

**So X is `held` only because X (b) reads "a refusal" where alpha.2 reads "the test passes".** On admission X (b)'s
refusal reading becomes the build's pass (a code change, R-586c, only if #5700 is lifted).

### Leg T: seven rows `survived -> error / runner-refused`

Measured: **290 killed / 50 survived / 59 no-coverage, errors 7, over 406** (own baseline: 290 / 57 / 59, errors 0).
Sleep index 0 + 0. `held`: every difference is one of the 7 pinned #5603 rows, moving to a named refusal (r9 §7).

All 7 are rows of `TABLES_KNOWN_DIFFERENCES` whose BC verdict is `killed` by `DoubleInsertWithoutKeyTriggerRaises`.
Old = the own baseline (alpha.2). New = alpha.5. For every row the new value is
`verdict error`, `errorClass runner-refused`, `killingTest -` (null), and `mutatedTextSha256` unchanged.

| Code | Key (hash, object, procedure, operator, ordinal) | Old (alpha.2) | **New (alpha.5)** | BC |
|---|---|---|---|---|
| M0157 | `a811b46c…` Data Flag Ops, InsertTwiceWithKeyTrigger, `lethal.remove-assignment`, 1 | survived / - / - | **error / runner-refused / -** | killed |
| M0158 | `c88702df…` Data Flag Ops, InsertTwiceWithKeyTrigger, `lethal.toggle-blank-string`, 1 | survived / - / - | **error / runner-refused / -** | killed |
| M0159 | `e75f9a09…` Data Flag Ops, InsertTwiceWithKeyTrigger, `lethal.swap-modify-flag`, 1 | survived / - / - | **error / runner-refused / -** | killed |
| M0161 | `dd3aa023…` Data Key Probe, OnInsert, `lethal.empty-block`, 1 | survived / - / - | **error / runner-refused / -** | killed |
| M0162 | `2d119c2e…` Data Key Probe, OnInsert, `lethal.negate-conditional`, 1 | survived / - / - | **error / runner-refused / -** | killed |
| M0163 | `c88702df…` Data Key Probe, OnInsert, `lethal.toggle-blank-string`, 1 | survived / - / - | **error / runner-refused / -** | killed |
| M0164 | `0121538c…` Data Key Probe, OnInsert, `lethal.remove-assignment`, 1 | survived / - / - | **error / runner-refused / -** | killed |

The full keys (each verified against `receipt.json`'s `T: held:` lines; the first field of a key is the 64-hex hash):

| Code | Full key |
|---|---|
| M0157 | `a811b46c95a74b761966dc4d0fd260793ba4c503b9cc6c7efd6e554acb7563d8\|Data Flag Ops\|InsertTwiceWithKeyTrigger\|lethal.remove-assignment\|1` |
| M0158 | `c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364\|Data Flag Ops\|InsertTwiceWithKeyTrigger\|lethal.toggle-blank-string\|1` |
| M0159 | `e75f9a0967677be80d3659fdc47e601d3764ac75077fb4d25c54b5f1322b2a8a\|Data Flag Ops\|InsertTwiceWithKeyTrigger\|lethal.swap-modify-flag\|1` |
| M0161 | `dd3aa023aa7fb2b7893efe181ccbf517d3ca97cbfacec07f3818c25c45c127dc\|Data Key Probe\|OnInsert\|lethal.empty-block\|1` |
| M0162 | `2d119c2ec73ab1ae52dbba9a46ff0f4bc4d1489684b7064c985ef4a94112ee7e\|Data Key Probe\|OnInsert\|lethal.negate-conditional\|1` |
| M0163 | `c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364\|Data Key Probe\|OnInsert\|lethal.toggle-blank-string\|1` |
| M0164 | `0121538c88a9342b484d6597b43bf7bc9d138149790fb204378e0afae2086339\|Data Key Probe\|OnInsert\|lethal.remove-assignment\|1` |

(M0158 and M0163 share one hash: the same text in two objects.)

Nothing else moves: the other 45 known rows (41 Commit, 4 TestPage; 52 = 41 + 7 + 4) are equal to the own baseline.
`unsupportedTests` is 3: `judgeLegT` step 2 gate-fails on any other count, and T read `held`. No leg-T report was
kept.

Compared with edge-57f1e4f98: its gate at 6eddda0b
(`/work/tools/al-runner-v3/failed/edge-57f1e4f98@6eddda0bc744b5397dc11c5edc34fc841d065e47/gate.log`) read the same
290 / 50 / 59, errors 7, `leg T: HELD`. alpha.5 equals it.

### D1 and D1c: `pass`

D1: 51 / 12 / 0 over 63, 0 differences from bc3-A (text verified 16, unverified 47), Sleep index 3 + 0 (513 s).
D1c: 51 / 8 / 4 over 63, 0 differences from bc3-B, Sleep index 3 + 0 (484 s). Both equal alpha.2's figures. This is
the first admitted-looking D figure on a build after alpha.2: alpha.3 and alpha.4 failed these legs (#5606, #5641).

### S1, S3, N1: `pass`

S1: 3 / 12 / 4 over 19, 0 differences from `bcdev.baseline.json`. S3: the resource selector is refused by name.
N1: 36 / 0 / 0 over 36, 0 differences from `bcdev.names.baseline.json`. Sleep index 0 + 0 in S1 and N1.

## What changes (rules)

Nothing in the gate's code or verdict rules changes in this delta. The default ruling on #5700 means alpha.5 is not
admitted, so no per-build reading table is needed yet.

**When the #5700 ruling is lifted** (see "What would change the ruling"), the code delta (R-586c) is:
- A table of expected readings **per build**, keyed by the build's `--version` string
  (`al-runner 3.0.0-alpha.5 (07342060e)`) AND its `binarySha256`
  (`fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2`), beside the alpha.2 table. The alpha.2 table
  stays until alpha.5 is `current`. A `gone` reading is the pass for alpha.5's key and `held` for any other. A build
  whose key is in neither table keeps r14's readings, so any `gone`, `refused` or moved reading is
  `held` again and needs its own delta. This keeps "a differing verdict is a BLOCK" literal, per build. The
  alternative, accepting either reading for each moved fact, would let a later regression back to the defect pass.
- The expected values for alpha.5 are the "alpha.5" columns of the tables above: five facts `gone`,
  `duplicate-key-insert-raises` `refused` (held-kind becomes the expected kind for this build), X (b) the refusal,
  leg T the seven rows, `refusal-row-shape` whatever the ruling says.
- Every `held` rule (r9 §6 `refused`, r9 §7, `xbHeldFirst`) stays in force for every build not in the table.
- **Prerequisite:** a K / serve measurement on alpha.5 (K is skipped on candidates, so nothing measures its serve path),
  and the serve probe fixed (`R705`).

## Figures that move

None on alpha.2 (`current`). On alpha.5, nothing is admitted, so no pre-committed count, fact count, index size or
baseline file changes now, and no baseline is re-recorded. Leg T's baseline file
`al-runner-v3.tables.baseline.json` is alpha.2's and stays as it is.

## Predictions

"Measured" means a run showed it. "Inferred" means it comes from code, another build, the release notes or the
commit list. Basis for every inference: alpha.5 is edge `57f1e4f98` plus 35 upstream commits
(`compare/57f1e4f98...v3.0.0-alpha.5`); their titles are corpus bumps, DemoTool and Contoso company builds, TestPage
and Blob refusals, XmlPort, `serve runTests` (#5715), `--isolation required` (#5699), Windows signing and the .NET
helper cache. **No title names coverage, the per-object frame, or `#if` handling.** That is a reading of titles, not
a review of the diff.

### A. `--regate the master commit that adds this file` on alpha.2 (`alrunner 3.0.0-alpha.2 (91253f2d6)`): `pass` on all 13 legs

`the master commit that adds this file` is the master commit that holds this file; it is filled in at commit time. **Addendum rule:** if a
commit touching `packages/runner/itest/al-runner-v3*`, `alrunner-v3-legs.ts`, `packages/runner/src/al-runner-v3*`,
`al-runner-server.ts` or `al-runner-rows.ts` lands on master first, an addendum names the new head before the regate.

`--regate` re-gates the **current** build (alpha.2) at the new LethAL commit. It cannot move `current` to alpha.5.
On `pass`, `.gated.lethalCommit` takes the new head and `current` stays alpha.2.

| Leg | Prediction | Basis |
|---|---|---|
| C | `pass`: 28 facts, 9 defect (all `defect-present`), 18 contract (`matches`), 1 warn (`serve-keep-reasons` `matches`) | r12, r13 and r14 measured alpha.2 `matches` each; the 9 defect readings measured at 711c94d9 and 6eddda0b's regate |
| S1, S3, N1 | 3 / 12 / 4; refused; 36 / 0 / 0 | Measured |
| X | `pass` (X (b) runs the broken target; (d) is the r5 table; the new r10 lines print `SleeperDoubles` baseline `pass`) | Measured at the regate on 6eddda0b; r10 and r11 inferred |
| L1, Y-A, Y-B | 7 / 3 / 0 over 10; 5 / 4 / 0; 5 / 4 / 0, each equal to its own baseline | Measured on alpha.2 (R-654 S2, R-666) |
| MO, WR | 6 / 1 / 5 over 12; 58 / 37 / 3 over 98, killers 6 and 58, WR's 6 state notes | Measured on alpha.2 (R-602, baselines recorded 2026-10-24) |
| D1, D1c | 51 / 12 / 0 and 51 / 8 / 4, 0 differences from bc3-A and bc3-B | Measured |
| T | `pass`: 290 / 57 / 59 over 406, 0 differences from its baseline | Measured |
| K (outside `V3_GATE_LEGS`) | on a gated build must pass: 3 / 12 / 4, 0 serve spawns | Measured on alpha.2 (R-654 S2) |

If the heavy-job limit stops the CDO legs, the regate is skipped and exits 2; it is not a pass.

If the regate reads anything other than pass (held, gate-fail or infra-fail), or is skipped (exit 2): `.gated` stays at
6eddda0b; the daily run then finds `failed/v3.0.0-alpha.{3,4,5}@6eddda0b…` and does not gate them again, so section B
does not happen. A non-pass is a BLOCK, reported with its receipt in `regate/<commit>.receipt.json`.

Also predicted on a pass: `.gated.warnFacts` = `{serve-keep-reasons: matches}`, `tarballSha256` inherited, exit code 0,
the `current` symlink unchanged.

### B. The next daily run at the new `.gated` commit

`failed/…@6eddda0b` is keyed by commit, so a new `.gated` commit lets alpha.3, alpha.4 and alpha.5 be gated again.
Each gate runs about 25 minutes with the CDO legs, and counts as a heavy job.

**alpha.5 (07342060e). Predicted overall: `gate-fail`, from leg C alone (`refusal-row-shape = unlike-bc`).**
`current` does not move. The result goes to `failed/v3.0.0-alpha.5@<new head>/`.

| Leg | Prediction | Basis |
|---|---|---|
| C | **`gate-fail`.** 28 facts. `refusal-row-shape` `unlike-bc` (gate-fail line). Held lines for `none-selected-exit`, `quoted-name-unselectable`, `refusal-cascade`, `sleep-is-noop`, `upstream-compile-errors` (all `gone`) and `duplicate-key-insert-raises` (`refused`). `codeunit-runs-whole` and `commit-under-test-isolation` `defect-present`. `serve-keep-reasons` `diverged` (warn, no outcome) | The 26 facts of 6eddda0b are **measured**. The other contract facts are `matches` there |
| C, the 3 facts alpha.5 has never run | `message-has-no-type-prefix` `matches`; `dependency-skip-line` `matches`; `timeout-is-cpu` (r14, A and B) `matches` | **Inferred.** r12, r13 and r14 measured alpha.2 and edge-57f1e4f98. alpha.5's limit is still CPU time (the old `timeout-is-cpu` read `matches`: alone 2004 ms stopped, shared 3120 ms passed). #5749 (a skipped dependency) closed 2026-10-23 22:07Z, after the release was published, so alpha.5 is inferred to still write the `dependency skipped:` line. A `diverged` on any of the three is a leg C `gate-fail` that the `unlike-bc` already makes, so it cannot change the overall outcome, but it must be named in the report |
| S1 | `pass`, 3 / 12 / 4 over 19, 0 differences, with the `unlike-bc` warning line | **Measured at 6eddda0b; inferred at the new head** |
| S3 | `pass` | **Measured at 6eddda0b; inferred at the new head** |
| N1 | `pass`, 36 / 0 / 0 over 36, 0 differences, with the warning line | **Measured at 6eddda0b; inferred at the new head** |
| X | `held`, through X (b) only. (d) the r5 table, (e), (f1)-(f3) as in the receipt | **Measured at 6eddda0b; inferred at the new head** |
| L1 | `pass`, 7 / 3 / 0 over 10, 0 differences from `al-runner-v3.layout.baseline.json` | **Inferred.** Never run on alpha.5. Measured on alpha.2. L1 depends on how v3 labels coverage by deployed path and on its line numbers; nothing in the 35 commits' titles touches it |
| Y-A, Y-B | `pass`, 5 / 4 / 0 each, 0 differences from their baselines | **Inferred.** `--define` handling; never run on alpha.5 |
| MO | `pass`, 6 / 1 / 5 over 12, killers 6, 0 differences | **Inferred.** Never run on alpha.5. alpha.2 and edge-57f1e4f98 gave identical tables in R-602's measurement, so the per-object frame did not move across that span either |
| WR | `pass`, 58 / 37 / 3 over 98, killers 58, the 3 `WrappedArms` refusals with `ARMS_REFUSAL`, 6 state notes | **Inferred**, as for MO |
| D1, D1c | `pass`: 51 / 12 / 0 and 51 / 8 / 4, 0 differences | **Measured at 6eddda0b; inferred at the new head** |
| T | `held`: 290 / 50 / 59, errors 7, exactly the 7 rows above (full keys), Sleep index 0 + 0 | **Measured at 6eddda0b; inferred at the new head** |
| K | `skipped (candidate build)` | By rule (`V3_K_CANDIDATE_SKIP`) |

MO, WR, L1, Y-A and Y-B are inferred, not measured on alpha.5. If MO or WR throws `AlRunnerCoverageFrameError`, that
leg is `gate-fail` by rule (`legOutcomeOfError`), not `infra-fail`.

**How the next daily run is read.** Its receipt and gate.log are compared leg by leg with table B: each leg's outcome;
each figure line (k / s / n over N, the differences, killers, state notes, the refusal sentence, the Sleep index); each
fact reading; and leg T's 7 held lines by full key. Any difference in any leg, Measured or Inferred, is a BLOCK on
R-586c: alpha.5 is not admitted, even if the #5700 ruling is lifted, until a new delta explains that difference. It is
never re-recorded. If v3 caused it, an upstream issue is filed. If LethAL caused it (a Measured leg moving at the new
head), it is a LethAL regression to find. That the overall outcome is already gate-fail from leg C changes none of
this.

The daily run must use an update script at least as new as the regate commit. With an older one, a receipt whose
outcome rests on MO or WR reads `infra-fail` (missing legs).

**alpha.3 (c893e3633) and alpha.4 (7739d8132).** Not re-judged by this delta. Inferred: alpha.3 `gate-fail` on D1 and
D1c (all 63 `error`, #5606), as at 6eddda0b; alpha.4 `gate-fail` on C and on D1 and D1c (#5641), as at 6eddda0b. Both
stay failures. **Cost:** each runs the full 13-leg gate at the new head, so the daily run is three full gates in a row,
one heavy slot for over an hour.

### C. If the #5700 ruling is lifted later (not predicted to happen)

Then the alpha.5 gate is the same run with the code delta above. Predicted: C `pass`, X `pass`, T `pass`, every other
leg as in B, overall `pass`, and `.gated` and `current` move to alpha.5. This is a prediction of a run that is not
authorised.

## Candidate upstream differences (nothing is filed here)

The owner's rule: every Rust-runtime refusal or difference is filed at aldevtools/BusinessCentral.AL.Runner. Checked
with `gh issue list -R aldevtools/BusinessCentral.AL.Runner --search <words> --state all`:

1. **A test that ends with a deferred duplicate-key `Insert` is refused (PR #5623); BC fails it at its end.** No issue
   exists (searches "duplicate key", "deferred", "end of the test", "RecordExists" show #5603, closed by #5623, and
   nothing on the end-of-test reading). PR #5623's own "Not done / probes wanted" asks exactly this: "does BC fail the
   test with the 'already exists' error?" LethAL measured it on bc1 (`docs/measurements/r639/bc1-probe.json`):
   `BC_END_OF_TEST_TEXT`. Harness: BC on Linux 28.4.53241.56590, a web-service session through LethAL Control
   RunMutant, runner 130450, `TestPermissions = Disabled`, the error raised from `Test Runner - Mgt(130454).RunTests`.
   **Candidate: file it, with the bc1 text.**
   It moves 7 leg-T rows to `error`; real projects with a double Insert in a test hit it.
2. **#5700 is already filed and open** (HttpClient failure text). The ruling above does not change it. LethAL's next
   comment, if the owner agrees, is the client-session measurement of "What would change the ruling" (a).
3. **#5607 is already filed and open** (`Commit()` under `--isolation test`). alpha.5 keeps the refusal. `--isolation
   required` (#5699) is not a difference; it is a possible LethAL option (a roadmap candidate, not an issue).
4. **`serve` returns no row for the five probe tests** (`serve-keep-reasons`). Not an upstream difference: LethAL's
   probe (codeunit 50674 does not compile, so v3 correctly runs nothing). Nothing to file.
5. **Sleep.** #5605 is closed and its behaviour is `gone`. No difference to file. X (d)'s `baselineGreen false` is the
   three 600 s sibling tests timing out at baseline, which is the intended behaviour.
6. **The unhandled-public-host refusal text** changed. It is a refusal, not a difference from BC. #5777 (an
   `[HttpClientHandler]` bound with `HandlerFunctions` is never called) is an existing open issue and is not one of
   ours.

## Tests (pre-committed, coded only if the ruling is lifted)

Under the default ruling no code changes, so no new tests. If R-586c is opened, each of these goes red on its own
single revert, in both directions:
- **R-a1.** The per-build table: alpha.5's version string with the alpha.5 readings reads `pass`; the same readings on
  alpha.2's version string read `held`/`gate-fail`; an unknown version string keeps r14's rules (a `gone` is `held`).
- **R-a2.** Leg T with the 7 rows equal to the table above on alpha.5's version string is `pass`. The same 7 rows on
  an unknown version, or 6 of 7, or the 7 plus one other moved row, is `held` or `gate-fail`.
- **R-a3.** X (b) refused is the pass for alpha.5's version string and `held` for any other; the broken target running
  is the pass for alpha.2's.
- **R-a4.** `refusal-row-shape` `unlike-bc` is `gate-fail` unless the ruling names a second accepted text; with the
  text, it reads `gone`; with any third text, `unlike-bc`.
