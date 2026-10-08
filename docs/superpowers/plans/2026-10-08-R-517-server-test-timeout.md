# R-517 plan r2: give the al-runner daemon a stop LethAL owns, judge a timeout confirm on the test's own duration against the stop al-runner reports it enforced, and never reuse a daemon that overran or timed out

[r2] Revised after `/coord/handoff/R-517/review-r1-opus-adversary.md` and the coordinator's
decisions. Every change from r1 is marked [r2]. Adopted: C1 (close the daemon on any `runTests`
throw; D5's "lost kill" wording corrected), I1 (the stop is the one al-runner REPORTS, parsed from
the timeout row), I2 (close the daemon after any suite with a timeout row), M1 to M5. Two items to
file (D6).

Read `/coord/handoff/R-517/measure.md` first. Every claim below about al-runner is measured there
on `2.12.0-main.43f76177`, or read from its source at 43f7617. [r2] The host pin c39ad5de is NOT
measured; I1 is what keeps that from mattering.

## Scope

al-runner `--server` and resource-with-server (both go through `runViaServer` and one daemon).
The confirm rule change (D2) is backend-agnostic: it changes nothing on bcdev (its
`measuredDurationMs` IS its `durationMs`, `bcdev-backend.ts`, and its timeout verdicts carry no
reported stop) and closes R517's one-shot follow-up (R516's one-shot lost-kill band). That
follow-up is NOT live today: on 43f76177 a one-shot timeout exits 3 and is scored `error` before
any confirm (measure.md finding 6, item (a) of D6).

## What the measurements settle

- The daemon has ONE stop for its life. `TestTimeout()` re-reads the env var per test, but only the
  daemon's own environment; a `runTests` request cannot carry a timeout (refused by name). The
  `--test-timeout N` start flag works under `--server` and beats an inherited env var.
- Each server row carries the test's own duration (body plus per-test setup, no compile). LethAL
  keeps it on a pass as `measuredDurationMs` (R272). That is the same clock the stop is timed on.
- A timeout row says which stop fired: `Test exceeded {N}s timeout.` (`TestExecutor.RunOne`, built
  from the `timeout` it actually used).
- So budgets cannot each get their own stop on one daemon (they differ per test: `budgetOf` is
  `max(2 x d, F)`, with `d` the suite's wall clock on this path, or R515's confirm figure, or
  `fallbackTimeoutMs`). The only fixed numbers LethAL owns for the whole session are the floor F
  (`--mutant-timeout-ms`, `minMutantBudgetMs`, default 180 000) and the baseline timeout
  (`baselineTimeoutMs`, default 120 000).

## Decision: both (A) and (B), plus two daemon-hygiene fixes

(A) alone (spawn with a stop LethAL owns) fixes R517's first sequence (the 60 s stop LethAL never
set), but the budget can still exceed the stop (budget `2 x W` > S whenever the suite takes over
S/2), and then a confirm judged against the budget is judged against a stop that never fired: the
second shape below. (B) alone (judge on the per-test figure) leaves the stop at al-runner's private
60 s default (or whatever the user's shell exports), so a test whose body is 61 s is red in the
baseline and its budget is meaningless. Both are small. [r2] C1 and I2 (D4b, D4c) are false-kill
doors on the same daemon that D1 widens or that a confirm can walk through; they ship together.

### D1. The daemon's stop is S, sent on its start line

- New optional `ExecutionBackend` hook `useMutantBudgetFloor?(floorMs: number, baselineTimeoutMs:
  number): void`, the same shape as `useDiscoveredTests`. [r2] (M1) `runSession` calls it AFTER
  `minMutantBudgetMs` and the baseline timeout are computed (in declaration order, not merely beside
  the `useDiscoveredTests` call: today `useDiscoveredTests` runs before `minMutantBudgetMs` is
  declared), before the first `run()`, and on every worker backend beside the worker's
  `useDiscoveredTests` call (`workers > 1`). One source of truth: the itest legs build
  `AlRunnerBackend` directly and go through `runSession`, so they get the same values (no leg sets
  `mutantTimeoutMs` or `baselineTimeoutMs`).
- [r2] (M2) `S = max(1, ceil(max(F, baselineTimeoutMs) / 1000))` seconds. With a floor below the
  baseline timeout, a stop of F would stop the BASELINE suite's tests earlier than the baseline
  timeout it was sent, making slow tests red at baseline. At the defaults S = 180.
- `AlRunnerBackend.useMutantBudgetFloor` stores S and hands it to `AlRunnerServer`, which appends
  `--test-timeout S` to the daemon argv (beside `--define`, R319's pattern). The CLI flag, not the
  env var: measured to beat an inherited `AL_RUNNER_TEST_TIMEOUT_SEC` (b2), and it is in the argv
  R387's leg records. Every daemon (re)start (D4b, D4c) uses the same S.
- Fail loudly (CLAUDE.md): `ensureServerSuite` refuses to start the daemon when no floor was set,
  with a typed error extending `Error` directly (e.g. `AlRunnerServerStopUnsetError`), rethrown out
  of `runViaServer` like `ServerCoverageRefusal` so it stops the session rather than reading as one
  `error` per test. A second call with DIFFERENT values throws; the same values are a no-op.
- New optional `ExecutionBackend` field `readonly inRunStopMs?: number`: the stop LethAL configured,
  timed on the test's own body, enforced whatever budget is sent. `AlRunnerBackend` answers
  `S * 1000` under `serverMode` once set, `undefined` otherwise. It is an UPPER bound on the
  threshold only; what the run enforced comes from the row (D2).
- Cost: a genuine hang on `--server` now takes S to stop (180 s at the defaults, was 60 s), plus a
  daemon restart (D4c). Paid only per hang; no gate has one.
- [r2] (M2) Bands on `--server`, stated. Lost kills, never false ones:
  - A test whose own body is between S/2 and S (90 s to 180 s at the defaults) can never have a
    timeout confirmed: 2 x body > S. A genuine hang in such a test is `timeout-unconfirmed`.
  - A body over S is red in the baseline and covers nothing.

### D2. A position-1 timeout confirm is judged on the test's own duration against the stop al-runner reports

[r2] (I1) The stop is the one al-runner ENFORCED, not the one LethAL configured. A build that takes
the flag but does not apply it (the host pin c39ad5de is unmeasured) would otherwise bring R517's
false kill back.

- `verdictFromRunnerTest` (shared by both al-runner transports) parses N from a timeout row's
  message, `Test exceeded {N}s timeout.` (anchored, integer N > 0), and sets a new optional
  `TestVerdict` field `reportedStopMs = N * 1000` on the `timeout` verdict. It is absent when N does
  not parse (the row still classifies as `timeout` through `RUNNER_TIMEOUT_MESSAGE`, as today).
- At the confirm in `runMutantsOnBackend` (the `confirm.outcome === "pass"` branch, today
  `2 * confirm.durationMs > budget`), with `v` the mutated run that timed out:

```ts
// R517: what the run really enforced. bcdev: no reported stop, inRunStopMs unset: the budget.
const reported = v.reportedStopMs;
const mustReport = args.backend.inRunStopMs !== undefined; // al-runner --server
const stopMs = Math.min(budget, reported ?? Infinity, args.backend.inRunStopMs ?? Infinity);
const confirmMs = confirm.measuredDurationMs ?? confirm.durationMs;
if (timedOut && ((mustReport && reported === undefined) || 2 * confirmMs > stopMs)) {
  /* unconfirmed, as today; the note says why (unparsed stop, or the figures) */
}
```

- Unparsed N on a backend that declares `inRunStopMs` stays unconfirmed (`timeout-unconfirmed`, note
  "al-runner did not say which stop it enforced"). On one-shot, a parsed N also tightens the
  threshold (it should equal the budget); an unparsed one falls back to the budget, as today. On
  bcdev nothing is parsed and nothing changes.
- `budget` stays the budget the run was SENT (R516 M2). `noteMeasured` (R515) keeps
  `confirm.durationMs`: a larger re-budget is the safe direction, and it is skipped on `--server`
  anyway (D3).
- Why it is sound: the mutated run's body exceeded the stop al-runner says it enforced, which is at
  least `stopMs`; the kill stands only if the same body unmutated took at most `stopMs / 2`. A false
  kill needs the body to slow more than 2x within one run: R53's accepted margin, the same exposure
  as bcdev. Body against body, on one clock.
- [r2] (I1) `backend.ts`: update `TestVerdict.measuredDurationMs`'s doc. It is no longer "for the
  report only": it is an input to the position-1 timeout confirm (R517). Same for the comment in
  `verdictFromRunnerTest` ("for the report only ... stays wall clock for the timeout budget") and
  the new `reportedStopMs` field's doc.
- The failure note names the stop when it is below the budget: extend `timeoutUnconfirmedNote` (and
  the `reused-budget-stale` text) to say "more than half the S ms in-run stop al-runner reported
  (below its B ms budget)" in that case, and to print the figure it judged (`measuredDurationMs`)
  and, where it differs, the wall clock. Notes only; no schema change, no new cause.
- One-shot: `inRunStopMs` unset (stop = budget); the confirm is judged on the body, not body plus
  compile. That closes R516's one-shot lost-kill band and R514's M3 (R517 "follow-up"), once item
  (a) of D6 lands.
- `confirmWarm` is untouched: al-runner has no `runMany`, and on bcdev the figures are equal.

### D3. `inRunStopIsBudget` stays false under `serverMode`; R-516's carve-out stays

The stop S is fixed when the daemon spawns (measure.md findings 2 and 3); every budget is
`max(2 x d, F)`, and it exceeds S whenever `2 x d > S` (on this path `d` is the suite's wall clock,
compile included). R515's re-budget raises a budget and moves no stop. A daemon restart per budget
would make it budget-true, at a cold start plus a full recompile per changed budget; rejected.
With D2 the carve-out is redundant for the false kill (the threshold is at most S); [r2] it stays
so that a budget's recorded source stays honest (no budget is credited to a confirm that moved no
stop). Update the `inRunStopIsBudget` doc comment in `backend.ts` and on the getter: the daemon's
stop is now S (not 60 s), still not the budget.

### D4. `runViaServer` comment

The comment above `verdictFromRunnerTest(ref, wanted, t, suite.wallMs, coverage)` stays true for
budgets. Add one line: the confirm is judged on `measuredDurationMs` (the row's own figure) against
`reportedStopMs`, see D2.

### [r2] D4b. (C1) Close the daemon on ANY `runTests` throw

The sequence (review C1): `AlRunnerServer.runTests` throws on its deadline without closing;
`LineReader.next` abandons the read; `ensureServerSuite` has no catch. `runOnce` retries; the client
reads request 1's late lines as request 2's answer; from then on every activation is scored on the
PREVIOUS activation's results. A false kill (mutant 2 scored with mutant 1's failing test). It
exists today for a suite slower than 10 min, and D1 widens it (a hang now costs 180 s, not 60 s).

- In `ensureServerSuite`, wrap `server.runTests(...)` so ANY throw does `await server.close()`
  before rethrowing. `server.close()` must leave `AlRunnerServer` restartable (`proc` and `stdout`
  cleared) so the next `start()` spawns a fresh daemon; check and fix that if it does not.
- `serverSuite` stays `undefined` on a throw (it is set only after success), so the retry runs a
  fresh suite on a fresh daemon.
- D5's r1 wording ("a hang reads `deadline-exceeded`, a lost kill") was wrong: before this fix it
  was a false-kill door. After it, a deadline overrun is an `error` verdict for the tests of that
  activation and a fresh daemon for the next one: a lost kill only.

### [r2] D4c. (I2) Close the daemon after any suite containing a timeout row

A timed-out test's thread is abandoned, not stopped (`InvokeWithTimeout`, `IsBackground = true`;
`RunOne`'s TIMEOUT branch skips the rollback because "the abandoned thread may still be writing to
the row store"). On a reused daemon it keeps running and writing into later requests, including the
unmutated CONFIRM, which can then fail or pass for reasons that are not its own. A false-kill door
on `--server` only; it predates R517.

- In `ensureServerSuite`, after a successful `runTests`, if any row classifies as a timeout
  (`RUNNER_TIMEOUT_MESSAGE`), `await server.close()` before returning the results. The results are
  still cached and scored; the NEXT suite (the confirm, or the next mutant) starts a fresh daemon
  (same S) and recompiles. Cost: one cold start plus a compile per timeout. No gate has a timeout.
- (M3) A covering test with no row in a suite that has a timeout row: the `error` note names the
  hung test, e.g. `al-runner --server stopped the run at "Codeunit79620.LongSpin" (timeout); tests
  after it have no row`, instead of only "reported no test named ...". `ServerSuiteResults` keeps the
  hung test's name for this.

### D5. Not done (lost kills, never false ones; listed in R517's close)

- [r2] After D4b, a suite that overruns `ensureServerSuite`'s deadline (`max(budget, 10 min)`; with
  S near 10 min, compile plus earlier tests plus S can pass it) is an `error` and a daemon restart.
  A lost kill only for `--mutant-timeout-ms` near 600 000.
- A timeout ends the daemon's run: tests after the hung one have no row (measure.md finding 5) and
  are `error` (now with M3's note). Today's behaviour; item (b) of D6 would confine it.
- D1's 90 to 180 s band above.

### D6. Items the builder files (re-check the next free id with `ls docs/roadmap/` immediately before EACH; names, not file:line)

- [r2] **(a) one-shot exit 3.** measure.md finding 6. On 43f76177 a one-shot test timeout exits 3
  (`TEST-TIMEOUT-ABORT` in `suiteErrors`), and `OneShotTransport.send` reads every code but 0 and 1
  as `kind: "error"`, so the verdict is `error` / `pre-dispatch-rejected`, which `runOnce` retries
  (a second full hang). Every one-shot hang is a LOST kill (verified never a false one) and a WRONG
  diagnosis ("could not compile" shape for a hang), and it masks R516's one-shot confirm live. Its
  fix must accept exit 3 as test results ONLY when every suite error is `TEST-TIMEOUT-ABORT`, and it
  needs a live one-shot hang leg (`itest:alrunner` has none). Not fixed in this build.
- [r2] **(b) performance: per-request selection.** al-runner's server now accepts per-request
  `test` and `excludeTests` (43f7617 `docs/server-mode.md` §"Request fields"); the comment in
  `al-runner-server.ts` saying the server has no per-test selection ("measured on 2.11.0") is stale.
  A per-test request would make `durationMs` per test, cost a mutant only its covering tests, and
  confine a hang to one test (no abandoned later rows, D5). Needs its own measurement.

## Tests (offline; no wall-clock asserts; each direction red-checked with the Edit tool)

Extend `ClockBackend` in `packages/runner/tests/resume.test.ts` with a `server` option modelling the
daemon: `inRunStopIsBudget = false`; `useMutantBudgetFloor(f, b)` records its arguments and a call
counter; [r2] (M5) the stop is `ceil(max(f, b)/1000)*1000` once set, and DEFAULTS TO 60 000 ms
(al-runner's own default) when no floor was set, which is what makes the RED repro reproduce
today's daemon; `inRunStopMs` answers the stop once set; a run times out when BSlow's body exceeds
the stop, whatever `timeoutMs` says, and [r2] its verdict carries `reportedStopMs` = that stop (an
option can withhold it, or report a different N, for the I1 tests); `durationMs` is the suite's wall
clock (body plus a configurable rest); a pass carries the body as `measuredDurationMs`.

1. **R517 S1 (the review's sequence, RED before D1).** F 180 000. BSlow body 58 s, rest 30 s:
   baseline 88 s, budget 180 s. Under a mutant that does not touch it BSlow's body is 61 s. Today
   (no hook call, the fake's default 60 s stop): `timeout-killed` after a confirm of 88 s
   (2 x 88 <= 180). After D1: no timeout, `survived`. Red-check: delete the `runSession` hook call;
   red.
2. **R517 S2 (the stop below the budget, RED before D2).** F 180 000, stop 180 s. BSlow body 100 s,
   rest 30 s: baseline 130 s, budget 260 s. Unrelated mutant: body 181 s, stopped at 180 s. Confirm
   wall 130 s, body 100 s. Old rule: 2 x 130 <= 260, `timeout-killed` (false). New:
   2 x 100 > min(260, 180), `timeout-unconfirmed`, note names the 180 000 ms stop. Red-check:
   replace `stopMs` by `budget`; red.
3. **R517 S3 (a genuine hang on `--server` is still killed, and no longer lost).** F 180 000, stop
   180 s. BSlow body 1 s, rest 94 s: baseline 95 s, budget 190 s. Mutant: body infinite, stopped at
   180 s. Confirm wall 95 s, body 1 s. New: `timeout-killed`, exactly one unmutated confirm.
   Red-check: replace `confirmMs` by `confirm.durationMs` (keeping `stopMs`): 2 x 95 > 180, red.
4. **[r2] (I1) R517 S5, the ENFORCED stop, both directions.**
   (a) The fake was configured with S = 180 s but reports `Test exceeded 60s timeout.` (a build that
   ignores the flag): BSlow body 58 s, rest 30 s, budget 180 s, 61 s under an unrelated mutant,
   timed out at 60 s. Confirm body 58 s: 2 x 58 > min(180, 60, 180): `timeout-unconfirmed`.
   Red-check: drop `reported` from the `min`; red (killed).
   (b) The timeout row's message does not parse (no `reportedStopMs`) on a backend with
   `inRunStopMs`: a genuine hang stays `timeout-unconfirmed`, note "did not say which stop".
   Red-check: delete the `mustReport && reported === undefined` clause; red (killed).
   (c) Parser unit test in `al-runner-backend.test.ts`: `Test exceeded 180s timeout.` gives
   180 000; `Test exceeded 0s timeout.`, `TIMEOUT after 5s`, and a non-timeout `error` give none.
   Red-check: loosen the anchor; red.
5. **R517 S4 (R515's sequence still not a kill).** The existing R516 review-fix test (29378d30) for
   the re-budget on `--server` stays green with the new fake (adding the stop if it needs one). The
   re-budget must still be skipped (`inRunStopIsBudget` false).
6. **One-shot follow-up.** Existing `alRunnerCompileMs` fake: compile 65 s, F 120 000, BSlow body
   1 s, mutant hangs. Confirm wall 66 s, body 1 s. Old: 132 > 120, `timeout-unconfirmed` (lost).
   New: `timeout-killed`. Red-check as in 3 (a separate test so each direction has its own red).
   The false-kill direction on one-shot needs the confirm's BODY above half the budget, which on a
   same-day budget takes drift (budget is at least 2 x body + compile). Reuse R516's drift shapes
   (T1 / T3a / T3b): each must stay `timeout-unconfirmed` when judged on the body figure; if one
   flips to a kill, its body grew less than 2x and that is a false kill: STOP and report. Red-check:
   drop the `* 2`; red.
7. **bcdev unchanged.** A bcdev-shaped fake (no `inRunStopMs`, no `reportedStopMs`,
   `measuredDurationMs = durationMs`): R516's T1 to T12 stay green untouched. Any R516 test that
   changes verdict must change only in the lost-kill-to-kill direction on one-shot; the builder
   lists each in the submit note.
8. **Backend, `al-runner-backend.test.ts`** (fake `ServerSpawnFn` recording argv):
   (a) after `useMutantBudgetFloor(180000, 120000)` the daemon argv contains `--test-timeout`, `180`
   exactly once; (180 500, 120 000) gives `181`; [r2] (M2) (30 000, 120 000) gives `120`;
   (b) serverMode with no floor: `run()` throws `AlRunnerServerStopUnsetError`, never an `error`
   verdict, and spawns nothing; (c) a second call with other values after start throws, the same
   values do not; (d) `inRunStopMs` is 180 000 under serverMode after the call and `undefined`
   one-shot; (e) one-shot argv/env unchanged (the floor never reaches `sendOneShot`, which keeps
   `oneShotLimits`). Red-check (a) and (b) each by deleting its line.
9. **[r2] (C1) Daemon closed on a `runTests` throw.** A fake `ServerSpawnFn` whose first daemon
   answers the first request's summary only after the deadline (the fake withholds it until the
   test's own trigger, no real time), and whose lines carry a request marker. Assert: the first
   `run()` returns `error`; the next `run()` (same activation, as `runOnce`'s retry does, and after
   a fresh `activate`) causes a SECOND spawn (spawn count 2), and no line from daemon 1 is ever
   read as daemon 2's answer (the second suite's results are daemon 2's rows). Red-check: delete the
   `close()` in the catch; spawn count stays 1 and the stale rows are read: red.
10. **[r2] (I2) Daemon closed after a suite with a timeout row.** Fake daemon: suite 1 has a timeout
    row for BSlow; then `activate(null)` and a confirm `run()`. Assert a second spawn before the
    confirm's suite, with the same `--test-timeout S`; a suite with no timeout row causes no
    restart (spawn count stays 1 across two activations). Red-check: delete the close; spawn count
    1: red. And (M3): in suite 1, a covering test ordered after BSlow has no row; its `error` note
    names `BSlow` as the hung test. Red-check: drop the hung-test name from the note; red.
11. **Orchestrator wiring.** A call-counter fake: `useMutantBudgetFloor` is called with
    `minMutantBudgetMs` and the baseline timeout (default and overridden) BEFORE the first `run()`,
    once per backend, and on every worker backend under `workers > 1`. Red-check: delete the worker
    call; red.

## itest:alrunner and itest:hang

See `alrunner-precommitment.md` (r2): no verdict, count, killing test or baseline moves on any leg;
one NEW live check (the daemon argv carries `--test-timeout 180`) in the R387 CLI-default leg,
written before the run. [r2] No leg has a timeout row or a deadline overrun, so neither D4b's nor
D4c's restart fires, and the R387 leg's existing "one `--server` spawn per backend" count holds.
`itest:hang` is bcdev-only: D1, D4b and D4c do not touch bcdev, and D2 is the identical rule there
(`measuredDurationMs === durationMs`, no `inRunStopMs`, no `reportedStopMs`); not re-run.

## Builder rules (as R-516)

- Edit/Write tools only for every file, red-check reverts and restores included (no `sed -i`,
  heredocs, `cat >>`, `cp`, shell redirects into files).
- Never read `lethal.config*.json`. No credentials. Typed errors extend `Error` directly.
- Verify loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun scripts/verify.ts`;
  `bunx biome check` on touched files only.
- Snapshots only whole-file, on purpose, with the diff in the submit note.
- [r2] (M4) Commit the probe as `scripts/r517-probe/` (from `/coord/handoff/R-517/probe/`, written
  with Write, imports made relative), and make its `backend` mode call
  `backend.useMutantBudgetFloor(180000, 120000)` before `deploy` (the server variants would throw
  without it after D1). Add a `PROBE_FLOOR_MS` override so a reader can see the stop move.
- Roadmap: R517 status `fixed in <commit>, live gate pending` until `itest:alrunner` passes against
  `alrunner-precommitment.md` (committed as
  `docs/superpowers/specs/2026-10-08-r517-alrunner-precommitment.md` BEFORE the run); then
  `done (<commit>)`. R517's close text: the probe's answers (measure.md, `scripts/r517-probe/`),
  D4b and D4c, D5's notes and band, and that the one-shot follow-up is not live until item (a)
  lands. File items (a) and (b) of D6. Update R516's "NOT closed here: R517" sentence to point at
  R517's fix. Regenerate `ROADMAP.md` (`bun scripts/roadmap-index.ts`) before the final verify; run
  `bun test scripts/line-citations.test.ts`.
- CHANGELOG `### Fixed`:
  - "al-runner `--server` (and resource with `--server`) now stops a test at the larger of the
    `--mutant-timeout-ms` floor and the baseline timeout (180 s by default), sent as
    `--test-timeout` on the daemon's start line. It used al-runner's own 60 s default, which LethAL
    never set, so a test slower than 60 s under an unrelated mutant could be scored
    `timeout-killed` (R517)."
  - "A timeout at position 1 is now confirmed on the test's own duration (al-runner's per-test
    figure, never the suite's or the process's wall clock), against the stop al-runner reports it
    enforced, when that is below the budget. On bcdev nothing changes. On al-runner one-shot a
    genuine hang is no longer lost to the compile time, once one-shot reports timeouts again
    (R<a>)."
  - [r2] "al-runner `--server`: a suite that overruns its deadline, or that contains a timed-out
    test, now ends that daemon; the next run starts a fresh one. Before, a late answer could be read
    as the next mutant's results, and a timed-out test's abandoned thread kept running into later
    runs, including the unmutated confirm (R517)."
  - `### Changed`: "A genuine hang on al-runner `--server` now takes the stop (180 s by default, was
    60 s) plus a daemon restart."

## Open questions

1. [r2] Abandoned threads still spin until the daemon exits; D4c bounds that to one suite per
   timeout. Each restart is a cold compile; on a big app with many hangs that is the dominant cost.
   Item (b) of D6 would shrink it.
2. Tests after a hung one have no row: a mutant whose hang is in a test that runs before another
   covering test gets an `error` row for the later one (now with M3's note). The kill still reads at
   position 1 if the hung test is first in the covering order; is the order guaranteed? Not
   analysed here.
3. Item (a)'s fix needs a one-shot hang leg live; which fixture?
