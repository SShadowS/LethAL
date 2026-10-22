# R-499 plan (r3): drain outstanding control requests before a score is published

[r3] r3 follows `/coord/handoff/R-499/review-r2-opus-adversary.md` (N1, N2, N3). Changes are
marked [r3].

Source read: `/work/lethal-wt/r496` (branch `lethal/r496`, R-496 submitted). Build on master
AFTER R-496 merges, in your own worktree (`/work/lethal-wt/r499`, task branch `lethal/r499`).
r2 follows the review `/coord/handoff/R-499/review-r1-opus-adversary.md`. Changes are marked [r2].

## 1. Choice: (A) drain with a bound

Before a public transport call (`run`, `runWithCoverage`, `runMany`) returns a **scored** result,
it waits for every fetch still in flight, up to `CONTROL_DRAIN_MS`. That covers its own fetches and
the orphans of earlier calls. A refusal that arrives during the wait is thrown, as R-496 already
does. [r2] If the bound expires, the call **throws** a plain `Error` naming the outstanding actions
and the bound. The session ends. Nothing is published for that call, so it is never a kill.

[r2] Why throw rather than return `in-flight-unknown` (review I-1). The verdict path reads
`in-flight-unknown` in places that would do the wrong thing here:
- `dispatchUnmutated` quarantines the tier without a reconcile;
- the R202 note says "LethAL sent a stop", which is false for a readback or an orphan;
- the confirmation branch would write a false "retried once" / `result-lost`.
A throw needs no new outcome, and it fails loudly on what is a broken-runtime fault: a fetch that
ignored its own abort for 5 s.

Why A and not B (fail closed at once while anything is outstanding):

1. **Every control request already ends by its own timer.** `postAction` arms an abort at
   `timeoutMs`, and every caller wraps it in `bounded(...)` with the SAME number (`stopHungRun`,
   `stopHungRunAt`, `readKeptAnswerBounded`, `completedBeforeStop`). Bun honours the abort (R191
   measured it for the body too). So in production an outstanding request settles within
   milliseconds of its bound.
2. **B is a timer race.** The abort timer is registered before the `bounded` timer, but Bun
   delivers the fetch's AbortError asynchronously. Under B, a call whose `bounded` race just fired
   would see its own fetch as outstanding for one tick and fail at random. A waits that tick out.
3. **The single path's real gap is a few ms.** `execute` sets `stopDeadline = now + timeoutMs +
   grace` BEFORE `dispatch` arms its budget timer. The stop fires at the budget timer (later), and
   its own bound is the full grace. So when `settleStop` gives up, the stop fetch still has δ ms
   left (dispatch setup + timer lateness + hook start). That δ is ordering (a). A waits δ.
4. **The grouped path already drains, by accident.** `runManyOnce` does `await watchdog` on every
   exit after dispatch, and the watchdog awaits its poll and its `StopHungRunAt`. The only
   leftovers are the `bounded` race losers from point 2.

## 2. Change points

### `packages/runner/src/run-mutant-transport.ts`

1. **`RefusalHolder`** gains `pending: Map<Promise<Response>, string>` (promise → action name,
   parsed from `LethALControl_<action>` in the URL, for the message).
2. [r2] **Shared control state (review I-2).** A new exported type
   `ControlState = { orphans: Map<Promise<Response>, string>; lateRefusal?: UnfilteredExtensionsQueryError }`.
   The transport takes it as a constructor option `controlState` and makes a fresh one when it is
   absent (tests). The private `lateRefusal` field moves into it. `takeLateRefusal` reads and clears
   `controlState.lateRefusal`. Orphans are fetches left in flight by a call that already returned,
   and fetches made with no holder.
   [r3] (review N1) Expose it as a read-only getter `controlState`. Test stubs that are bound as
   transports need the getter too.
   [r3] (review N2) Today `lateRefusal ??= err` drops a second refusal silently. Keep the first,
   and `console.warn` each later one, using `takeLateRefusal`'s message text.
3. [r2] **`recording` (review M-1).** Register the wrapper's OWN promise, not the inner fetch's,
   and delete it in that promise's `finally`. Then a refusal is recorded (in `holder.refusal` or
   `controlState.lateRefusal`) BEFORE the entry leaves `pending`, so a drain can never see "settled"
   ahead of the refusal. Put it in `holder.pending`, or in `controlState.orphans` when
   `getStore()` is undefined.
4. **`refusalBoundary(fn, isScored)`**: after `fn` settles and BEFORE `holder.closed = true` (move
   that line down):
   - If `fn` threw, or `isScored(value)` is false: do not wait. Move what is left in
     `holder.pending` to `orphans`, close the holder, and keep today's exits. Nothing is published
     on a non-score.
   - If scored: `await` the settlement of every promise in `holder.pending` and `orphans`, raced
     against `this.drainMs`.
   - Then close the holder. Throw `holder.refusal` if set. Otherwise, if `controlState.lateRefusal`
     is set, clear it and throw it (new exit check; it closes ordering (b)).
   - [r2] If anything is still pending: move it to `orphans` and throw
     `new Error("R499: <actions> still outstanding after <n> ms; this call is not scored and the session ends")`.
5. **Scored predicates**, passed by each entry point:
   - `run`/`runWithCoverage`: `operation === undefined` and outcome `pass`, `fail` or `timeout`.
   - `runMany`: `kind === "verdicts"`, or `kind === "call"` with outcome `timeout`, no
     `operation`, no `cause`.
6. **Constant** `export const CONTROL_DRAIN_MS = 5_000` and a constructor opt `drainMs` (test seam,
   same shape as `traceWrite`). No config key, no config read.

### [r2] `packages/runner/src/bcdev-backend.ts`

7. The backend owns ONE `ControlState` and hands it to every transport it builds (the
   `runMutantTransportFactory` call sites in `deploy` and `attach`). Thread it through the factory.
   Find every factory construction site (cli, itests, tests) with the `wiring-completeness` agent.
8. `takeLateRefusal` reads the shared state. `retiredTransports` then has no job left: delete it.
   [r3] (review N1) `bindTransport(next)` throws a plain `Error` when `next !== undefined` and
   `next.controlState !== this.controlState`. Reason: the factory is built by the caller (cli.ts,
   the itests). A factory that ignores the new `controlState` argument still type-checks. Its
   transport would make a private state, and with `retiredTransports` gone its refusals would be
   lost without a word, which regresses R-496. The throw makes that loud at deploy/attach.
   [r3] (review N2) R-496's retired-transport test in `bcdev-backend.test.ts` ("a refusal landing
   on a RETIRED transport after the re-deploy is surfaced at teardown") does NOT stay green: its
   stubs share no state. Rewrite it against real `RunMutantTransport`s that share the backend's
   one state, and keep its "late on B" warning assertion (now produced by the second-refusal
   warning in point 2).
9. Add `drainControlRequests(ms): Promise<void>`. It waits up to `ms` for the shared `orphans` to
   settle. It never throws: a refusal lands in `lateRefusal`.

### [r2] `packages/runner/src/orchestrator.ts` (review I-3, option a)

10. In `closeLeaseScope`: `await backend.drainControlRequests?.(CONTROL_DRAIN_MS)` for
    `a.backend` and each worker backend. [r3] (review N3) Place it after `leaseSession.finish()`
    and just BEFORE the `phase-left: teardown` event, so the event's `elapsedMs` includes it. The
    `takeLateRefusal` loop stays after the event. The drain never throws, so it never delays or
    skips the lease release; draining after the release is safe because the server's lease fence
    decides. Bounded: teardown takes at most 5 s longer, and only when an orphan exists.
    `surfaceLateRefusal` is unchanged.

Not changed: `settleStop`, the watchdog, `bounded`. No new `cause`, no new `SessionReport` field.

Why this closes both orderings:
- **(a)** A scored call cannot return while a request is in flight: it waits, and the refusal throws
  from that call. An orphan of a non-scored call is drained by the next scored call, on any
  transport (shared state), and once more at teardown. A refusal after that bounded teardown drain
  can only come from a fetch that ignored its abort for 5 s twice. No score was published while it
  was pending.
- **(b)** The originating call closes its holder with a request pending only if it published no
  score. Its orphan is drained by the confirmation call's exit, and a refusal that lands is thrown
  there.

## 3. Run-time effect

What bounds a control request today:
- `StopHungRun` (single): `stopGraceMs` (30 000 default; the single path never sets it), counted
  from when the stop fires. `settleStop` stops waiting about δ ms earlier.
- `StopHungRunAt` (grouped): `min(stopGraceMs, hardCap − sentAt)`, awaited by the watchdog.
- `completedBeforeStop` and `GetOpAnswer`: `KEPT_ANSWER_READ_MS` (15 s), or `min(15 s, timeoutMs)`
  on the single-path readback. Both awaited.
- Watchdog `GetOperationStatus` poll: no bound, but awaited (see section 8).

In practice a stop stays outstanding at return only on the single path, when BC left the stop
unanswered for the whole grace while the main request answered. Then A adds δ (ms). On the grouped
path it adds at most one tick. A normal hang (the stop answers in ms) adds nothing. Worst case, a
fetch that ignores its abort: +5 s, then the session ends. Teardown adds up to 5 s only when an
orphan exists. `durationMs` is taken before the drain, so no recorded duration changes.

## 4. itest:hang

In the live legs no call reaches its exit with a fetch in flight. The drain finds an empty set and
returns at once. A drain that runs out would END the session: that is a gate failure, not a new
figure.

| Leg | Figure | Can A move it? |
|---|---|---|
| ON (grouped) | 38 mutants: killed 24 / survived 9 / timeout-killed 5 / errors 0 | No |
| ON | per-mutant `EXPECTED_ON` table, `killPosition` per row | No |
| ON | `warmKills` 4, `groupedCalls` 42 (= 24 + 9 + 5 + 4) | No |
| ON | timeout rows: "stopped the session" + "StopSession", `duration_ms` in [20 000, 50 000), `op_kind` many | No |
| ON | `session-reused` 0; liveness `missing` 0, `manyDistinct` 37 (= 42 − 5) | No |
| ON | not quarantined; caveats `session-warm`, `stop-hung-sessions`; one `hang-refused` row, 2 sites | No |
| SINGLE | 38 mutants, ON verdicts, 24 / 9 / 5 / errors 0, every kill at position 1 | No |
| SINGLE | `stopped-after-completion` 0, `stop-outcome-unconfirmed` 0 | No |
| SINGLE | 5 timeout rows with BC's words, window [20 000, 50 000), `op_kind` not many | No |
| SINGLE | `groupedCalls` 0, `warmKills` 0, not quarantined; equal to `hang.single.baseline.json` | No |
| OFF | fewer than 38 mutants, `timeoutKilled` 0, an error noting "could not be confirmed complete", a `deadline-exceeded` row, no `timeout` row, quarantined | No |

Commit this pre-commitment BEFORE the live run, as
`docs/superpowers/specs/2026-10-08-r499-hang-drain-precommitment.md`:

> **R-499: itest:hang pre-commitment (written before any live run).** R-499 adds a bounded drain
> (`CONTROL_DRAIN_MS` 5 000) of in-flight control requests at the exit of `run`,
> `runWithCoverage` and `runMany` before a scored result is returned, and once more at session
> teardown. It throws if the bound expires. Prediction: every frozen figure of all three legs is
> UNCHANGED (`STOP_GRACE_MS` 30 000, budget 20 000).
> ON: 38 mutants, killed 24, survived 9, timeout-killed 5, errors 0, the `EXPECTED_ON` table and
> kill positions unchanged, `warmKills` 4, `groupedCalls` 42, `session-reused` 0, `manyDistinct`
> 37, not quarantined. SINGLE: the same 38 verdicts, every kill at position 1, 5 timeout-killed,
> errors 0, `stopped-after-completion` 0, `stop-outcome-unconfirmed` 0, `groupedCalls` 0,
> `warmKills` 0, equal per mutant to `hang.single.baseline.json` (not re-recorded). OFF:
> `timeoutKilled` 0, quarantined, a `deadline-exceeded` row and no `timeout` row. Every timeout
> row's `duration_ms` stays in [20 000, 50 000). [r2] No mutant's `failureNote`, no
> `killingTestFailure` and no `test_results.failure_message` contains "R499". No leg's session
> ends with an R499 expiry error. No baseline file is deleted or re-recorded. Any difference is a
> regression: a BLOCK, never a re-record.

## 5. Tests

Files: `tests/run-mutant-transport.test.ts`, `tests/run-mutant-many.test.ts`,
`tests/bcdev-backend.test.ts`, `tests/refusal-scope.test.ts`. A "deaf" fetch ignores its abort
signal and settles only when the test says so.

[r2] Rules (review M-2, M-4):
- No wall-clock asserts in new tests. Where a wrong wait must go red, use a deaf fetch with
  `drainMs` ABOVE the test timeout, so the wait times the test out. Otherwise assert call counts
  and outcomes.
- The `pending` map is the authority on what is in flight: assert through it, not through timing.
- Write no test for the holderless (`getStore()` undefined) branch.

| # | Path | Case | Expect | Red-check |
|---|---|---|---|---|
| S1 | run | (a): deaf `StopHungRun` outlives `settleStop`'s deadline, then refuses (UnfilteredExtensionsQueryError) inside `drainMs`; the held request answers a valid failure | `run` rejects with the refusal | [r2] Revert the exit to R-496's (no drain block); record the observed output (expected: resolves `fail`) |
| S2 | run | (b): call 1 ends non-scored (`in-flight-unknown`, deaf readback left as orphan). Call 2 (the retry/confirmation) starts; the orphan refuses while call 2's request is open; call 2 answers a pass | call 2 rejects | Remove the exit check of `lateRefusal` → resolves `pass` |
| S2b | run | (b), later: as S2, but the orphan refuses only during call 2's exit drain | call 2 rejects | Drain only `holder.pending`, not `orphans` → resolves `pass` |
| S2c | run | [r2] kept from R-496 as its own case: an orphan refused after call 1 returned; call 2 throws it BEFORE sending anything (`sent.length` unchanged) | call 2 rejects, nothing sent | Remove the entry check → call 2 sends |
| S3 | run | bound expiry: deaf stop never settles within `drainMs`; the held request answers a valid failure | [r2] `run` rejects with an `Error` whose message names `StopHungRun` and R499; never `fail` | On expiry return the value → resolves `fail` |
| S4 | run | control: the stop answers `{stopped:true}` in time, AL-stop 408 | `timeout`, no `operation`, `stopState: "confirmed"`; [r2] `pending` and `orphans` are empty at return | Over-strict: throw whenever a stop FIRED → red. Never delete settled entries from `pending` → red |
| C1 | runWithCoverage | bound expiry: [r2] the test creates its orphan explicitly (a deaf fetch through the transport); then a scored pass | rejects with the R499 error | Return the value on expiry → resolves `pass` |
| G1 | runMany | (a): deaf `StopHungRunAt` outlives `stopBound`, then refuses inside `drainMs`; main answers a valid verdict set | `runMany` rejects with the refusal | [r2] Revert the exit to R-496's; record the observed output (expected: resolves `verdicts`) |
| G2 | runMany | (b): call 1 ends non-scored with a deaf orphan; call 2 (the warm replay) starts; the orphan refuses during call 2; call 2 answers a valid set | call 2 rejects | Remove the exit check of `lateRefusal` → resolves `verdicts` |
| G3 | runMany | bound expiry: deaf `StopHungRunAt` never settles; main answers a valid set | rejects with the R499 error | Return the value on expiry → `verdicts` |
| G4 | runMany | control: stop confirmed in time, 408, `completedBeforeStop` false | `timeout`, unchanged; maps empty | Over-strict: throw on any stopped call → red |
| N1 | both | non-scored pass-through: existing `5b. a readback whose fetch ignores the abort is still bounded` and the two grouped `bound:` tests | stay green | Over-strict: drain before a NON-scored result → red |
| B1 | backend | [r2] rebind (review I-2): a call on transport A leaves a deaf orphan; a re-deploy binds B; A's orphan refuses during B's scored call's exit drain | B's call rejects | Give each transport its own `ControlState` → resolves |
| T1 | session | [r2] teardown (review I-3): the last call ends non-scored with a deaf orphan; the orphan refuses during the teardown drain | the session ends with UnfilteredExtensionsQueryError, after cleanup; [r3] `phase-left: teardown` is emitted after the drain | Remove the teardown drain → the session finishes clean |
| B2 | backend | [r3] (review N1) deploy with a factory that ignores `controlState` (its transport makes a private state) | `deploy`/`attach` throws the mismatch `Error`; no transport is bound | Remove the `bindTransport` check → it binds, and a later refusal on that transport is not surfaced at teardown |
| B3 | backend | [r3] (review N2) the rewritten R-496 retired-transport test: real transports A and B share one state; A refuses after the re-deploy, then B refuses | teardown throws A's refusal; a warning contains "late on B" | Back to a silent `lateRefusal ??= err` → the "late on B" assertion goes red |

Existing test that MUST change (intended; record it in redchecks): `R-496 review 5: a StopHungRun
refused after run returned is thrown by the NEXT run`. Its call 1 returns `fail` while its stop is
in flight, which is the old behaviour. Split it into S3 (call 1 now throws) and S2c (the
"next call throws before sending" assert, kept as its own case). [r3] R-496's retired-transport
test in `bcdev-backend.test.ts` also goes red as written; it is rewritten as B3. Run the full suite and explain
every other red the same way, or fix the code.

## 6. Rules for the builder

- Edit/Write tools only. No `sed -i`, no `bun -e`, no heredoc edits, also for red-check reverts.
- Red-check every fix in the table, one revert at a time, and report the red output and the green
  output after restoring (`mutation-red-checker` subagent). One red test per direction of a guard.
- Typed errors extend `Error` directly (none is planned; the expiry throw is a plain `Error`). No
  `!` non-null assertions; `exactOptionalPropertyTypes` spreads.
- Never read `lethal.config*.json`; no new config key.
- Loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun scripts/verify.ts` from the repo root
  (build the native parser first on a fresh worktree). `bunx biome check` on touched files only.
- CHANGELOG `[Unreleased]` entry (Fixed): a scored result now waits (bounded, 5 s) for in-flight
  control requests, and teardown waits once more; a refusal that arrives meanwhile ends the
  session; a request still in flight after the bound ends the session; never a kill.
- Live: commit the pre-commitment in section 4, then `LETHAL_ITEST_HANG=1 bun run itest:hang`
  (foreground). Any figure difference is a BLOCK.
- Close R499: set `status` to `done (<commit>)` in `docs/roadmap/R499.md`, run
  `bun scripts/roadmap-index.ts` and `bun test scripts/line-citations.test.ts` (cite names, not
  file:line). Push only after green, both CI jobs green.

## 7. Open questions [r2: answered by the review]

1. `CONTROL_DRAIN_MS = 5 000`: fine.
2. Reusing `stopState: "unknown"` for a readback: do not. The expiry now throws, so the question
   is gone.
3. An orphan that never settles: end the session on the FIRST expiry (the throw does this).

## 8. File separately (not part of R499)

[r2] The watchdog's `GetOperationStatus` poll has no `timeoutMs`, and every exit of
`runManyOnce` awaits the watchdog. So a poll BC never answers holds the call forever; the hard cap
aborts only the main request. Fix: `bounded(this.getOperationStatus(..., bound), bound)` in the
watchdog. Unmeasured: whether Bun's socket idle timeout already ends such a poll. File it as its
own roadmap item.
