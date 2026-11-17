# PR-115 pre-commitment (R1106 part b): batch the v3 daemon baseline's codeunits, gated on PR-114's accessor

Coord PR-115 (lethal-code, 2026-11-17).
- **The base:** draft 3 (`2026-11-17-pr114b-baseline-batching-draft3.md`), plus every fix of its final spec-adversary review.
- **What PR-114 landed:** the 8 capability facts in leg C, `baselineBatchingFor`, and leg DBM.
- **Evidence:** `/coord/handoff/PR-114/` (carry, carry2, lane, mem).

## Erratum (2026-11-17, found in PR-120, committed before any window measured the prediction)
The window prediction below has the wrong base.
- **What happened:** t13 and t14 were `--resume` windows whose baseline was REUSED (`resume-baseline-reused` in both stderr
  files). So their 214.5 s and 200.1 s are the L5 re-check of a stored baseline, which sends one request per codeunit and is
  never batched (`recheckReusedBaseline`).
- **Replaced by:**
  - **A resumed window:** the baseline phase does NOT change because of PR-115 (it re-checks; nothing is batched).
  - **A fresh window** (a fresh store, a head with PR-115, and `current`'s `.gated` carrying PR-117's `batchFacts`): the baseline
    phase falls from x1's 1,697.7 s by at least 300 s, with 0 verdict moves.
    - x1 used a fresh dos4 store and head c996629b, before PR-115's code. Its phase held 110 serve requests (1,075.0 s) and 12
      cross-check one-shots (574.5 s).
    - The 300 s is about half the serve share, which is the PR run's measured ratio (112.5 s fell to 28.9 s).

## Delta review r1 (2026-11-17), folded in below
The review found no false-kill path, and its fixes converge:
- **H-A, the pin flag.** `edge-4ebfe7913` has no hand pin; it reads `edge-d72d3197d` (the root of 17 of 18 gated rows). The
  flag is therefore a NEW hand pin for 4ebfe7913.
- **M-A:** DBM's pin is conditional.
- **M-B:** an excluded whole codeunit does not run. Measured (`/coord/handoff/PR-115/hidden-probe.ts`, `hidden.txt`, 3 rounds):
  an excluded CPU-burning codeunit adds 0.7-1.3 ms of `testsMs` to the batch, against 106-122 ms when it runs, and gets no
  `perTestCoverage` entry.
  - **The same probe corrects draft 4.** A test that hits no statement has NO `perTestCoverage` entry, so "exactly one entry per
    row" would discard every batch with an empty test. It is "at most one".
- **M-C:** draft 3's dropped items are restored.
- **The lows.**

Draft 3's text binds only where this draft restates it.

## Build review amendment (2026-11-17), overrides the pin text below
The Opus build review (H1) found that a hand pin carrying the flag spreads:
- a re-gate of `current` writes the applied pin into `.gated` `readingsFrom`;
- later candidates adopt that pin's readings, flag included.

So there is NO hand pin and no pin field. The flag is a separate list `V3_BASELINE_BATCHING_BUILDS` (`{version, binarySha256}`),
outside all readings, holding edge-4ebfe7913 only. `baselineBatchingFor` requires exact membership.
- **Leg DBM:** a listed build REQUIRES batching on and 2 requests; any other build requires 4.
- **Expected test moves:** no `serveRowFields` move. The gap is R1109.

## The switch
- **Batching happens only when `baselineBatchingFor(contract, version, sha)` is true:**
  - the build's pin carries `baselineBatching: true`;
  - this session's probe reads all 8 capability facts as `matches`;
  - the §6 Sleep rule is retired (`this.sleepRuleRetired`, the verdict path's field).
- **The pin flag (H-A):** PR-115 adds ONE new hand pin `edge-4ebfe7913`, whose leg C read all 8 facts `matches` (PR-114). It
  holds:
  - version and sha copied from its gated row;
  - every reading copied from `edge-d72d3197d`;
  - `baselineBatching: true`.

  A hand pin wins over a gated row (`findV3Pin`). The gated rows, their digests and `edge-d72d3197d` are unchanged, so the flag
  reaches no other build.
- **When edge moves `current`,** batching is OFF on the new build until someone adds a hand pin for it. Making the flag follow the
  update gate automatically (`.gated` recording the capability facts) is filed as a roadmap item.
- **Otherwise:** every daemon-baseline request stays as today.

## The batch
- **The body (H1):** `{...lane.requestBase(mode), excludeTests, coverage: true, perTestCoverage: true}`. That keeps every
  `requestBase` field (`sourcePaths`, `testIsolation`, `noClient`), so the baseline and the mutant phase run under the same
  session settings. The seed travels in the child's environment, not the body.
- **Only with coverage:** batches are sent only when the fill's `coverage` is true. Otherwise the codeunits go singly.
  - **Forbidden fields** (a unit test pins their absence): `test`, `runSelectedOnly`, `strictOrder`, `testSuites`, `testRunner`,
    `testDriver`.
- **`excludeTests` (M2, L4):** every Subtype=Test codeunit, in any `#if` arm of BOTH `sourcePaths` trees, outside the batch,
  whether or not it has test methods, as `Codeunit<id>.`. It is built by the same scan that finds OnRun.
  - **Never empty:** if the complement would be empty, the codeunits go singly. A batch of 1 is exactly today's request
    (`test: "Codeunit<id>."`).
- **Never batched:**
  - a test codeunit with `trigger OnRun` in any `#if` arm (the scan above);
  - the per-test fill (R866), R937's one-shot codeunits, the R1033 re-check and the mutant phase.
- **Batch size:** `B = 8`, the measured value on DO (+103 to +129 MiB). There is a seam for tests and for leg DBM.

## The decode, in this order (M3, M4, delta H1)
1. **`plainInFlight`'s pre-row steps, unchanged:**
   - `refuseDaemonDependencySkip` (R590, which also runs `watchTestDataOff`, R885) THROWS as today;
   - the seed and `cachedFalse` reads.

   Only a protocol error (an unreadable `serveRow`) or unavailable coverage discards.

From step 2 on, any failed check discards the WHOLE batch answer, closes the daemon (R612) and re-sends each codeunit of the batch
singly as today's request:
2. Every row's codeunit is in the batch.
3. **No test name appears twice,** scanned BEFORE `serveDaemonReusable`. This is the OnRun carry and lane re-run signature, and
   `AlRunnerServeDuplicateRowError` is never reached.
4. Every row is one R612 keeps.
5. **Every `perTestCoverage` entry names a row of the batch,** and no row has two entries (M-B). An entry for a test outside the
   batch is a hidden run. A row with NO entry is a test that hit no statement, as today.
6. **Per codeunit,** with rows sliced by `r.codeunit`, and coverage entries sliced by the exact row name `Codeunit<id>.<method>` (M4;
   `coverageOf` matches on `e.test === row.name`): `hasEveryRow` (extra rows allowed, as today).

R949's `flaggedUnknown` marks rows as today; it is not a check. A batched row's `flagged` is ignored, as for a single row. A batch's
summary `orderHints` is ignored, and its count goes into the stats line.

## The fill around a batch
- **Before and after each request:** `spent()` before each batch request, and `signalled()` after it (a signal drops the whole
  batch). One `memoryGate` hold per request.
- **After a clean decode,** each codeunit goes through TODAY's per-codeunit loop body, in id order: R1001's uniform watch
  observes, then the sample check or R951 replace, then R790, then keep. So:
  - R1001 never sees a discarded batch's rows;
  - R951's forward replacement works when its pick falls in the same batch.
- **R951's sample plan is unchanged** (`baselineSampleIds` by position). At B = 8 on DO, 2 of 14 batches hold no sample. Index 1
  now shares its request with index 0, so index 0's exclusion ("its daemon is fresh") applies per request, not per codeunit.
  This is accepted on the measured 1,979-row equality.

## Per codeunit, after the decode
- **Coverage:** a codeunit's top-level coverage is the union of its own tests' per-test coverage.
- **R948:** the cross-check compares a batched sample's rows and per-test sets, and the whole call only for a batch of 1.
- **R790 (M5):** `durationCouldMoveBudget(codeunitRows, batchWallMs, floor)` per codeunit; a too-slow codeunit re-runs one-shot,
  as today. A row with no `durationMs` takes the batch's whole wall time, which is the safe direction.
- **Deadline (L1):** the deadline is `v3CallDeadlineMs(s, totalTestsInBatch)`.
- **One `callId`** covers the batch. `BaselineAnswer` carries it, so `measuredDurationOf` charges the batch's wall time once, not
  once per codeunit. The baseline `serve-request-timed` event carries the batch's real `entries` and `tests`.
- **The exclusion pattern** is `Codeunit<id>.` with the trailing dot. v3 matches `excludeTests` as a substring of
  `Codeunit<id>.<method>`, so `Codeunit1.` never hides `Codeunit11`; a unit test pins this.

## Failure (L2)
- **A batch request that fails** (daemon error, transport, a timeout cut) keeps nothing: every codeunit of the batch re-sends
  singly.
- **Batching turns off for the session** after the first discard or failure, so daemon closes never repeat.
- **"Two requests in a row without a usable answer"** counts single requests only.

## Predictions (pre-committed)
- **0 verdict moves.**
  - `itest:alrunner-v3` passes, every verdict and pin unchanged, except the DBM pins below.
  - DB stays 1 = 1: `sandbox-tests` has one codeunit, so its complement is empty and it goes singly.
- **Leg DBM at B = 2** (the seam):
  - `requests === (b.isBaselineBatching() ? 2 : 4)` (M-A), with the reason printed when batching is off, so the update gate's
    candidates (no flag) still pass. On 4ebfe7913 it is 2: two batches of 2, each excluding the other two, and each holding one
    sample (indices 1 and 3);
  - the per-mutant table equals the one-shot session's, 15/3/104 over 122;
  - the daemon baseline is not dropped;
  - the warning sets are unchanged.
- **The DO PR run** (PR-113's `live/arm.sh`, the 735fb42 changed arm) on the PR head:
  - the baseline phase falls by at least 40 s of its 152.4 s;
  - `scripts/report-diff.ts --by-line --subset` against PR-113's live run shows 0 differences.
- **The next DO window on a head with PR-115, while `current` is still edge-4ebfe7913:** its baseline phase falls by at least 60 s
  from t13's and t14's 200-215 s. It is reported by lethal-bugs. On another `current`, batching is off, and the stats line says so.
- **Expected test moves:** the R948 unit-test fakes that answer by `body.test` gain batch answers, and `r586c-pins.test.ts`'s
  `serveRowFields` id list gains the new pin.
- **Unit tests, each red when its rule is reverted:**
  - the body (from `requestBase`, the forbidden fields absent, `noClient` kept);
  - the empty complement goes singly;
  - OnRun codeunits go singly;
  - each decode step (an out-of-batch row, a duplicate that discards without throwing, an R612-unkept row, a missing row, per
    codeunit slicing with the same method name in two codeunits, a missing per-test coverage entry);
  - a failed batch re-sends singly;
  - the first discard turns batching off;
  - the per-codeunit coverage union;
  - the R948 sample compare;
  - R790 per codeunit;
  - the deadline;
  - one `callId`;
  - the accessor false means no batching;
  - exactly one pin carries the flag, the gated rows' digests are unchanged, and `baselineBatchingFor` is false for alpha.13,
    alpha.14 and edge-d72d3197d;
  - every `perTestCoverage` entry names a batch row (a hidden-run entry discards), and a row with no entry is kept;
  - batching only with coverage;
  - a signal mid-batch drops the batch;
  - R1001 sees only decoded rows;
  - R951's replacement inside one batch;
  - the exclusion pattern.
