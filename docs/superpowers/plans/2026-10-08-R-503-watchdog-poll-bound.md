# R-503 plan (r2): bound the runMany watchdog's GetOperationStatus poll

[r2] r2 follows `/coord/handoff/R-503/review-r1-opus-adversary.md` (I1, I2, M1 to M5). Changes are
marked [r2].

Source read: `/work/lethal-wt/r503` (master b8241e46, includes R-496 and R-499). Build in your own
worktree on task branch `lethal/r503`.

## 1. The problem, in the code

`runManyOnce`'s watchdog does `status = await this.getOperationStatus(lease, attemptId,
lease.opSeq)` with no `timeoutMs`, so `postAction` arms no abort and nothing races it. Every exit
of `runManyOnce` (connection failed, body failed, answer) runs `settle()` and then `await watchdog`.
`settle()` only wakes a SLEEPING watchdog; it cannot end a poll in flight. The hard cap
(`requestCeilingMs + stopGraceMs`) aborts only the main `RunMutantMany` request. So one poll that
BC accepts and never answers holds the call, and the session, forever.

Every other control read already ends by its own timer: `StopHungRun`, `StopHungRunAt`,
`GetOpAnswer` (`readKeptAnswerBounded`) and the status read after a stop (`completedBeforeStop`)
pass `timeoutMs` AND wrap in `bounded(...)` with the same number.

[r2] (M4) The lease client's `getOperationStatus` (orchestrator reconciliation) is only PARTLY
bounded: `postLeaseAction` arms its abort at `DEFAULT_TIMEOUT_MS` (30 s) but clears it once the
headers arrive, so its `res.json()` body read has no bound (the R191 class). That is out of scope
for R-503 and not changed here. The builder files it as a NEW roadmap item (next free id,
re-checked with `ls docs/roadmap/` just before writing), citing `postLeaseAction` by name.

## 2. The bound for one poll

```ts
const pollBound = Math.max(0, Math.min(this.pollBoundMs, hardCapMs - (Date.now() - started)));
status = await bounded(
  this.getOperationStatus(lease, attemptId, lease.opSeq, pollBound),
  pollBound,
  "GetOperationStatus",
);
```

- `this.pollBoundMs` defaults to **`KEPT_ANSWER_READ_MS` (15 000)**. Reason: `completedBeforeStop`
  already makes the SAME read (`GetOperationStatus` for this op) and bounds it with
  `KEPT_ANSWER_READ_MS`. One read, one bound.
- Not `pollMs` (`WATCHDOG_POLL_MS`, 5 000). Live poll latency while BC runs a hung loop on another
  session is unmeasured. A 5 s bound could fail polls the live gate gets answers to today, which
  delays the stop and could move a timeout row's `duration_ms`. 15 s gives a wide margin. Also, the
  unit tests set `watchdogPollMs: 5`; a 5 ms bound would make test polls fail by timing.
- Clamped to what is left of the hard cap: the same rule R-204b gives the stop (`stopBound`). A
  poll sent late in the call cannot hold it past the hard cap. With the clamp, no call ever runs
  longer than `hardCapMs` (plus a tick) because of a poll.
- **Both halves are needed.** `timeoutMs` arms `postAction`'s abort, so a normal fetch settles and
  leaves R-499's `holder.pending`. `bounded` holds the bound for a fetch that ignores its abort. With
  `bounded` alone, every live hung poll would stay in `pending` and turn a scored exit into
  `ControlDrainTimeoutError`. With the abort alone, a deaf fetch still holds the call forever.
- `pollBoundMs` is a constructor opt, a test seam of the same shape as R-499's `drainMs`. No config
  key, no config read.
- [r2] (M5) Make the transport's `getOperationStatus` `timeoutMs` parameter REQUIRED, so no future
  caller can make an unbounded status read. Callers: the watchdog (`pollBound`),
  `completedBeforeStop` (`KEPT_ANSWER_READ_MS`, already passed), and the probe script
  `scripts/r236-baseline-probe/size-arm.ts`, which must now pass `KEPT_ANSWER_READ_MS` too. The
  lease client's own `getOperationStatus` is a different method and is not touched.

## 3. What a poll timeout means

- **It is a failed poll.** The existing `catch` already does the right thing: `pollsFailed++`, a
  `poll-failed` trace line (its `error` now reads "GetOperationStatus gave no answer within <n>
  ms"), `refuseOnUnfiltered(err)` (a no-op: a timeout is a plain `Error`), then `continue`. The
  loop sleeps `pollMs` and polls again. No new state, no consecutive-timeout counter: the hard cap
  already bounds a call whose polls never answer, and `stopDetail()` already reports
  `polls failed <n>` in every non-scored message.
- **The stop decision.** `StopHungRunAt` needs `(methodIndex, token)` from an ANSWERED poll, and the
  server refuses it unless that row is current (R198). So a timed-out poll can never cause a stop,
  and there is no stop without an answered poll. That is unchanged and correct. The deadline that
  holds when polls never answer is the HARD CAP: it aborts the main request, the watchdog's
  current poll ends at the same instant (the clamp), the loop sees `settled` and returns. A stop
  already sent keeps its own `stopBound`, unchanged. The cost of a slow poll is a later stop
  decision, by at most `pollBound` per poll, never a missing bound.
- **R-499's drain.** The poll goes through the recording `fetchFn`, so it sits in `holder.pending`
  while the call is open. With the abort armed it settles at the bound and removes itself (the
  abort timer is set inside `postAction` before `bounded`'s guard, as R-499 section 1 point 2
  notes). A deaf poll stays in `pending`:
  - scored exit: the drain waits `drainMs`, then `ControlDrainTimeoutError` names
    `GetOperationStatus`. The session ends. Nothing is published.
  - non-scored exit: it moves to `controlState.orphans`, and the next scored call or the teardown
    drains it (R-499, already tested by G2/T1).
  - a refusal that lands on it later is recorded by the wrapper, as for any other fetch.
  No change to `refusalBoundary`, `drainPending` or `ControlState`.

## 4. Never a kill

| Path | Outcome |
|---|---|
| A poll times out, a later poll answers | today's watchdog and scoring, unchanged |
| A poll times out, BC answers the main request (2xx) | scored from BC's own answer, as today; the kill (if any) is BC's test failure, not the poll |
| Polls never answer, `stopHungSessions` on or off | no stop and no budget abort; the hard cap aborts: `abortedVerdict` → `deadline-exceeded` + `in-flight-unknown` → R236b readback (`GetOpAnswer`). Recovered pass/fail set, or kept `in-flight-unknown`, which the orchestrator reconciles as today (the OFF leg's path). Never `timeout` |
| Stop confirmed, then a poll hangs, BC's 408 arrives | `timeout` as today: the kill rests on the confirmed stop plus BC's 408, not on the poll. The poll now ends at its bound instead of holding the call |
| A deaf poll at a scored exit | `ControlDrainTimeoutError`; the session ends; nothing published |

A timeout is a plain `Error` from `bounded`, never an `UnfilteredExtensionsQueryError`, so it
cannot reach `refuseOnUnfiltered`'s throw. No new outcome, no new `cause`, no `SessionReport` field.

## 5. Bun's socket idle timeout

The plan does NOT depend on it. Whether Bun ends a silent poll on its own is unmeasured. If it does
before the bound, that is a failed poll: the same path. R433's measurement is a hint that it does
not come quickly: BC held an unanswered extensions query for about 166 s before the SERVER closed
the socket. Do not measure it as part of this item; the bound makes the answer irrelevant.

## 6. Run time and itest:hang

Live polls answer (the stops fire near the budget today), so no bound is reached and nothing
waits longer or shorter. The only new cost is two timers per poll. A poll slower than 15 s would
now fail and be retried 5 s later; nothing suggests one exists.

[r2] (I1) The gate's own figures cannot see that. The duration window [20 000, 50 000) is 30 s
wide and hides one failed poll (at most 20 s). The poll's error reaches only the R289 trace, and a
timeout row carries no `stopDetail()`, so a text check on failure messages is empty by
construction. So the live run sets `LETHAL_R289_TRACE` (the transport reads it from
`process.env` in its constructor; the itest runs the legs in-process) and the trace is the
evidence:
- Run: `LETHAL_ITEST_HANG=1 LETHAL_R289_TRACE=<scratchpad>/r503-hang-trace.ndjson bun run
  itest:hang` (foreground), with that file absent beforehand. Never inside the repo.
- Pre-committed: zero `poll-failed` lines in the whole file. That covers ON and OFF; SINGLE has no
  watchdog and writes none. At least one `poll-ok` line, so an empty file cannot pass.
- Pre-committed, where readable: the OFF leg's `deadline-exceeded` row (`test_results.failure_message`,
  built by `abortedVerdict` with `stopDetail()`) reads `polls failed 0`. The gate does not assert
  this; the builder reads it after the run. If the OFF leg's store is not readable, say so in the
  receipt; that is not a BLOCK.
- Measured, recorded in R503: the largest `at - sentAt` over the `poll-ok` lines, with the count of
  `poll-ok` lines. That is the live poll latency this plan's bound rests on.
- The failure-text check stays in the pre-commitment, but it is NOT cited as evidence.

[r2] (M3) The table now lists every check the gate makes, not only the counts.

| Leg | Figures | Can R-503 move them? |
|---|---|---|
| ON | 38 mutants, killed 24 / survived 9 / timeout-killed 5 / errors 0; `EXPECTED_ON` and kill positions; `warmKills` 4; `groupedCalls` 42; `session-reused` 0; `sessionLiveness` `missing` 0, `manyDistinct` 37, `singleRows` = `singleDistinct`; not quarantined; `baselineGreen` true; caveats `stop-hung-sessions` and `session-warm`; timeout rows "stopped the session" + "StopSession", `duration_ms` in [20 000, 50 000), `op_kind` many | No |
| SINGLE | same 38 verdicts, 24 / 9 / 5 / 0, every kill at position 1; `stopped-after-completion` 0; `stop-outcome-unconfirmed` 0; `groupedCalls` 0; `warmKills` 0; `baselineGreen` true; caveat `stop-hung-sessions`; 5 timeout rows in the same window, `op_kind` not many; equal to `hang.single.baseline.json`. The single path has no watchdog poll | No |
| OFF | fewer than 38, `timeoutKilled` 0, an error noting "could not be confirmed complete", a `deadline-exceeded` row, no `timeout` row, quarantined; `baselineGreen` true; not `all-errors` | No |
| All legs [r2] | R447: exactly one `hang-refused` row (2 sites, 1 file), `scoreDescribes` names it, reliability `narrowed` | No |
| Trace [r2] | zero `poll-failed` lines; at least one `poll-ok` | (new evidence, pre-committed) |

Commit `/coord/handoff/R-503/hang-precommitment.md` as
`docs/superpowers/specs/2026-10-08-r503-hang-poll-bound-precommitment.md` BEFORE the live run.

## 7. Tests (`packages/runner/tests/run-mutant-many.test.ts`)

Use the existing `fakes`/`deafStop` style: a fake fetch keyed by action, call counters, and a
"hung" poll that rejects on its abort signal versus a "deaf" poll that ignores it. Pass a small
`pollBoundMs` (e.g. 20) through the new constructor opt. No wall-clock asserts; a wrong wait goes
red by timing the test out.

| # | Case | Expect | Red-check (revert → red) |
|---|---|---|---|
| P1 | The first poll hangs (honours abort). The main request answers a valid verdict set after it was sent. [r2] (M2) `drainMs` small (e.g. 50) | resolves `verdicts`; `holder`/`orphans` empty (`t.controlState.orphans.size === 0`) | Revert to today's unbounded poll → test times out. Drop only `timeoutMs` (keep `bounded`) → `ControlDrainTimeoutError` naming `GetOperationStatus` (the small `drainMs` makes it go red on that error, not on bun's 5 s test timeout). [r2] (M1) Treat a timed-out poll as an abort of the call → `kind: "call"`, not `verdicts` |
| P2 | Every poll hangs; the main request is held; small `requestCeilingMs`/`stopGraceMs` | resolves `kind: "call"`, `deadline-exceeded`, `in-flight-unknown`, message has `polls failed` ≥ 1; `StopHungRunAt` count 0; readback `GetOpAnswer` found:false keeps the unknown; never `timeout` | Revert the fix → test times out |
| P3 | Polling continues: poll 1 hangs; poll 2 answers our row over budget; `stopHungSessions: true`; the stop answers `stopped:true`; the main request gets the AL-stop 408 | `timeout` for that method, `stopState: "confirmed"`; `GetOperationStatus` count ≥ 2, `StopHungRunAt` count 1 | On a timed-out poll `return` instead of `continue` → no stop, `deadline-exceeded`. [r2] (M1) Treat a timed-out poll as an abort of the call → no `timeout` |
| P4 | Clamp: `pollBoundMs` far above the hard cap (60 000); every poll hangs | resolves `deadline-exceeded` (the call ends at the cap, not 60 s later) | Remove the clamp → test times out |
| P5 | Deaf poll (ignores abort); `drainMs` small. [r2] (M2) The main request is held (`many: "hold"`) and released with a valid verdict set only once `polls() >= 1` | rejects `ControlDrainTimeoutError`, message contains `GetOperationStatus` and `R499`; never `verdicts` | Remove `bounded` (keep `timeoutMs`) → test times out |
| P6 [r2] (I2) | Bound not too tight: `watchdogPollMs` 5, `pollBoundMs` 200, `stopHungSessions: true`. Poll 2 answers after about 40 ms (a fake delay, not an assert) with our row `running` and over budget; the stop answers `stopped:true`; the main request gets the AL-stop 408 | `timeout`, `stopState: "confirmed"`; `StopHungRunAt` count 1 | Set the bound to `pollMs` → every poll times out, no stop, `deadline-exceeded` |
| C1 | Control: polls answer normally (existing tests, e.g. "a method over its budget on SERVER clocks fires StopHungRunAt…", G4, "the call returns when BC answers…") | unchanged, green | [r2] (I2, M1) None of its own: the fakes answer at once, so a too-tight bound cannot turn these red. P6 carries "bound too tight"; P1 and P3 carry "a timed-out poll aborts the call" |

The deaf-poll orphan path on a non-scored exit is R-499's G2/T1 mechanism; no new test.

## 8. Builder rules

- Edit/Write tools only. No `sed -i`, no `bun -e`, no heredoc edits, also for red-check reverts.
- Red-check every row of section 7 one revert at a time (`mutation-red-checker` subagent); report
  the red output and the restored-green output. One red test per direction.
- No new typed error (the timeout is `bounded`'s plain `Error`). If one is ever added it extends
  `Error` directly. No `!`; `exactOptionalPropertyTypes` spreads for the new opt.
- Never read `lethal.config*.json`; no new config key.
- Loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun scripts/verify.ts` from the repo root
  (build the native parser first on a fresh worktree). `bunx biome check` on touched files only.
- Update the `getOperationStatus` doc comment and the watchdog comment (one line: bounded like
  `completedBeforeStop`, clamped to the hard cap like `stopBound`).
- CHANGELOG `[Unreleased]`, Fixed: "A grouped call's progress poll that BC never answers no longer
  holds the call forever. Each poll now ends after 15 s, or at the call's hard cap if that is
  sooner, and counts as a failed poll; polling goes on. Never a kill (R503)."
- Live: commit the pre-commitment (section 6), then [r2] (I1) `LETHAL_ITEST_HANG=1
  LETHAL_R289_TRACE=<scratchpad>/r503-hang-trace.ndjson bun run itest:hang` (foreground, trace
  file absent beforehand). Any figure difference, or any `poll-failed` line, is a BLOCK, never a
  re-record.
- [r2] (M4) File the lease client's unbounded `res.json()` in `postLeaseAction` as a new roadmap
  item (next free id, `ls docs/roadmap/` just before writing; cite names, not lines), then
  regenerate the index.
- Close R503 only after the live gate passes: `status` → `done (<commit>)` in
  `docs/roadmap/R503.md`, note there that Bun's idle timeout stays unmeasured and is not relied on,
  [r2] (I1) record the largest live poll latency (`at - sentAt` over `poll-ok`) and the `poll-ok`
  count, run `bun scripts/roadmap-index.ts` and `bun test scripts/line-citations.test.ts` (names, not
  file:line). Push only after green, both CI jobs green.

## 9. Not changed

`refusalBoundary`, `drainPending`, `ControlState`, `stopHungRunAt`, `completedBeforeStop` (its
call already passes `timeoutMs`), `readKeptAnswerBounded`, the single path, the lease client (its
gap is filed separately, M4), the orchestrator.
