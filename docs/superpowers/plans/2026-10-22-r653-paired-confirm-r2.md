# R-653 plan r2: send a fail kill's unmutated confirm and its R577 reproduction in ONE request

Saved by lethal-code from the planner's report (opus, read-only), after adversary-r1 (CHANGES) and the orchestrator's
point on the order inside the request. Edits by lethal-code: the probe apps are runtime 17.0 (no back-compat rule);
"the orchestrator runs the probe" means lethal-code runs it.

Class: **FULL**: it changes how a kill is confirmed.
- Worktree: /work/lethal-wt/r653, branch lethal/r653 from e919379c.
- **R-654 S1 lands first.** R-653 adds no new import at all. The new code uses only symbols the v3 backend already
  has: `request`, `liveFailure`, `serveDaemonReusable`, `suiteMissing`. `r654-v3-imports.test.ts` must stay green.

## 0. What r2 drops and keeps

- **Dropped:** the warm-up stand-in, the stored warm-up rows, C4-C10 and `confirmFromWarmup`. F1 (clock) and F2
  (state that lasts across requests) are real doors to a false kill, and no guard can see them.
- **Built:** r1 §4's fallback. For a fail kill, one entries request carries the reproduction (M) and the unmutated
  confirm (NONE) together. One send, one bound check.
- **Ruling R1 (deadline under load):** moot. The confirm is sent live and keeps its own deadline.
- **F3:** every latch and refused state goes to today's path, each guard tested in both directions (§5).

## 1. Order inside the request: reproduction FIRST, confirm SECOND

The request is `[echo M, codeunit cu under M, echo NONE, codeunit cu under NONE]`.

**Why.** If the M entry leaves state behind (WorkDate, GlobalLanguage, rows if per-entry isolation ever slips), only
the NONE entry after it can see it. A confirm can only FAIL because of it, and a failing confirm reads `unstable`:
a lost kill, never a false kill. With confirm first, NONE's leftover state would reach the reproduction, and a
failure caused by it would read `killed` (F2 in the other direction).

**State from before the request** (F2 across requests) reaches both entries. If it makes the killer fail, NONE fails
too, so the kill reads `unstable`, in either order. **Clock (F1):** both entries run milliseconds apart in one
request (today: about 200 ms apart, in two requests).

**Checked against the code; nothing needs confirm-first:**
- The orchestrator never sees the order inside the request. It still calls `activate(null)`, `run(ref)` (confirm),
  then `reproduceKill`'s `activate(M)` and `run(ref)`. Each `run` reads rows stored when the request was sent (§2).
  The confirm's rows are read and judged first, as today.
- A failing confirm maps exactly as today: `confirm.outcome === "fail"` takes the cold-confirm block's else-branch,
  `error`, cause `unstable`. `reproduce()` is never called; the M rows are never read, never pushed to
  `testResultBuffer`, and dropped at the next `activate`.
- The R577 record does not use the confirm's result. `reproduceKill` takes `m`, `step` and the M run's verdict, and
  is called only after `confirm.outcome === "pass"`. The order of pushes to `testResultBuffer` is set by the reads,
  so it does not change.
- The R612 cut is the only place where order matters in code. `request()` keeps entries up to the first unkept one.
  With M first, a cut in M leaves NONE unsent → the pair is dropped and today's two calls run (§3).

**Probe** (measure before build; not a precondition of this order): §7.

## 2. The mechanism

### backend.ts

```ts
/** R653, OPTIONAL: before a cold fail kill's confirm, send the reproduction and the confirm as one
 *  request and keep each answer for the next activate(null) and activate(mutantId). No-op when it
 *  cannot; the confirm and the reproduction then run as today. */
sendKillPair?(mutantId: string, ref: TestMethodRef): Promise<void>;
```

### orchestrator.ts (cold-confirm branch only)

Just before `await activateOnce(args.backend, args.safety, null);`:

```ts
if (!timedOut && args.backend.killsMustReproduce === true && args.backend.sendKillPair !== undefined) {
  args.safety.assertSafe(`sendKillPair(${m.mutantId})`);
  await args.backend.sendKillPair(m.mutantId, ref);
}
```

Nothing else in the orchestrator changes. `confirmWarm` (k > 1), the timeout path, Decision 11's reruns and the
baseline never reach this line.

### al-runner-v3-backend.ts

**State:** `private pair: { mutantId; codeunit; none?: CallRows; noneVerdict?: TestVerdict; m?: CallRows; next:
"null" | "mutant" } | undefined` and `private pairVerdict: TestVerdict | undefined`.

**`sendKillPair(mutantId, ref)`** sends and stores nothing (today's path) unless ALL hold:

| # | Guard | Why |
|---|---|---|
| G1 | `this.entries` | one-shot transport: today's path |
| G2 | `this.entriesRefused === undefined` | F3: a latched session stays latched; `liveCall` gives `transportFailure`, a pair must not give a pass |
| G3 | `!this.inBaseline` | the baseline runs no mutant |
| G4 | `this.lastActivated === mutantId` | the call comes right after the kill, under M |

Then: `this.union.add(ref.codeunitId)`; `out = await this.request([{mutantId, codeunits:[cu]}, {mutantId: NONE,
codeunits:[cu]}], "liveMs")`: one `send` of kind `"live"`, one bound check, `liveRequests += 1`, new
`pairRequests += 1`. Map:

| Result | Stored | Confirm reads | Equal to today because |
|---|---|---|---|
| NONE call present | `none` = its CallRows, `m` = M's (always present when NONE is: entries stand as a prefix) | `run()` decodes as for `liveCall`: `refusal` (echo mismatch), `missing` (`suiteMissing`), 0 or 2+ rows, other-codeunit rows filtered, then `v3RowVerdict` | same `request()`, same CallRows; empty or partial gives `rowMissing`, never a pass |
| NONE absent (cut at or before it) | nothing; `pairFallbacks += 1` | today's live confirm, then today's live reproduction | today's path; M rows discarded, never scored |
| `AlRunnerV3EntriesRefusedError` | `noneVerdict = this.liveFailure(ref, err, wall)` (latches `entriesRefused`) | `transportFailure` | `liveCall` maps the same throw the same way |
| `AlRunnerServerRequestError` | `noneVerdict = this.liveFailure(...)` | `transportFailure` or `deadline-exceeded` | same function |
| any other throw (e.g. `AlRunnerV3UnprovenBatchError`) | nothing; `pairFallbacks += 1`; `console.warn` names it | today's path; its own send re-checks and throws as today | default when unsure |

**Consuming** (in `activate`, serve-entries branch, after `rowsByCodeunit = new Map()`): take `p = this.pair`, set
`this.pair = undefined`.
- `p.next === "null"` and `mutantId === null`: `rowsByCodeunit.set(cu, p.none)` or `pairVerdict = p.noneVerdict`;
  then `this.pair = {...p, next: "mutant"}`.
- `p.next === "mutant"`, `mutantId === p.mutantId`, `p.m` present: `rowsByCodeunit.set(cu, p.m)` (the reproduction).
- Any other `activate` drops the pair; so does `resetLayoutState()` (deploy). `pairVerdict` is cleared on every
  `activate`.

**`run()`**, first line after the proof check:
`if (this.pairVerdict?.ref.codeunitId === ref.codeunitId) { const v = this.pairVerdict; this.pairVerdict = undefined; return {...v, ref}; }`

**Also:**
- `send`'s batch-refusal test becomes `kind === "warmup" || (kind === "prefetch" && groups.length >= 2)`. A pair
  speaks for one kill, like today's lone live group, so a refusal of both entries stays that kill's own `error`.
- Reword the R652 comment on `checkBound`: the confirm rides in the reproduction's request (R653). L1's exposure is
  unchanged in kind: the pair is now the last send.

**Differences from today, all named:**
1. The order and timing inside one request (§1).
2. `durationMs` of both verdicts is the pair request's wall time; read only for timeout kills, which are excluded.
3. The deadline is `v3CallDeadlineMs(S, tests of both entries + 2 echoes)`, so longer.
4. A pair whose NONE entry did not stand is re-sent as today's two calls (M rows discarded).

## 3. Which kills take the pair

ALL must hold: a position-1 `fail` kill in the cold-confirm branch; `killsMustReproduce === true`; the backend
defines `sendKillPair`; the safety latch is clear; G1-G4.

Today's path stays for: timeout kills (D7); `confirmWarm` (k > 1); Decision 11 reruns; the baseline; one-shot;
bcdev and every other backend; latched `entriesRefused`; latched session safety; a NONE entry that did not stand;
any throw that is not a server error.

Outcome map: confirm `fail` → `error unstable` (M rows unused); confirm `pass` + M `fail` → `killed`,
`killReproduced`; confirm `pass` + M not `fail` → `kill-not-reproduced`; confirm `transportFailure`,
`deadline-exceeded`, refusal or missing row → today's error branches; never a pass from an empty or partial entry.

## 4. CDO saving, re-estimated

E3a (R-652): boundChecks 141 = 1 + 1 + 102 + 37; liveMs 22.65 s / 102 = 222 ms per request; boundMs 25.27 s / 141 =
179 ms per check.
- Bound checks: 51 fewer → 9.1 s, near certain.
- Requests: 51 fewer, each pair 4 entries instead of 2. Prefetch ran 126 entries in 1.46 s (about 12 ms per entry),
  so a pair costs about 247 ms against 444 ms for two requests: about 10 s.
- Total: about 19 s if fixed cost per request dominates; at least 9 s. Loop 83.5 → about 64-74 s (E3a), 76 → about
  57-67 s (E3b).

## 5. Tests first (each written red, each guard red-checked in both directions)

### `packages/runner/tests/al-runner-v3-entries.test.ts`, describe "R653 pair" (stateful fake, send counters, no wall time)

- **P1 pair verdicts equal today's two calls.** Same fake answers through today's path and the pair path; confirm
  and reproduction verdicts deep-equal except `durationMs`. Cases: (NONE pass, M fail); (NONE fail, M fail);
  (NONE pass, M pass); NONE echo mismatch; NONE 0 rows; 2 rows for the method; only another codeunit's rows; a
  suite test missing.
- **P2 pair is one send, M first.** One `runEntries`, `liveRequests +1`, `boundChecks +1`, `pairRequests 1`; body
  order echo M, cu M, echo NONE, cu NONE. Red if flipped; red if the method is a no-op.
- **P3a-d one per guard**, each red when its guard is removed: one-shot (0 entries sends, confirm spawned as
  today); `entriesRefused` latched (F3: pair sends 0, confirm reads `transportFailure`; with G2 removed it reads
  `pass`); in baseline (no send); `lastActivated !== mutantId` (no send).
- **P4 consumed only in order.** Live, not from the pair: `activate(M2)` after the pair; a second `activate(null)`;
  `activate(M)` before `activate(null)`; `deploy()` in between.
- **P5 NONE not standing falls back.** Unkept M row or NONE echo → `pairFallbacks 1`; confirm and reproduction sent
  live; pair M rows never reach a verdict.
- **P6 server errors map like liveCall.** Request error → `transportFailure`; deadline → `deadline-exceeded`;
  refused → `transportFailure` + latch.
- **P7 other throws go to today's path.** An .al changed after deploy: pair sends 0, the confirm's `run()` throws
  today's `AlRunnerV3UnprovenBatchError`.
- **P8 pair skips batch refusal.** Both entries refused with one unknown reason: no latch, verdicts equal today's
  lone-group verdicts. Red if the condition is reverted.

### `packages/runner/tests/orchestrator.test.ts` (fake backend with a call log)

- **O1** cold fail kill: `sendKillPair(M, ref)`, `activate(null)`, `run`, `activate(M)`, `run`; `killed`,
  `killReproduced`. Red if the call is removed.
- **O2** a timeout kill never pairs (red when `!timedOut` removed).
- **O3** no pair without `killsMustReproduce`.
- **O4** warm confirm and Decision 11 never pair.
- **O5** a backend without the method is unchanged (pins bcdev).
- **O6** unsafe latch stops before the pair (red when `assertSafe` removed).
- **O7** confirm fail after a pair is `unstable` and pushes no M row.

Update every pinned count (14 `liveRequests`/`boundChecks` sites and orchestrator-driven tests) deliberately; name
each in build.md.

## 6. Build order

1. Probe (§7); record the fact in measure.md §5.
2. Write P1-P8 and O1-O7; check all red.
3. backend.ts optional method; orchestrator.ts guarded call.
4. v3 backend: `pair`, `pairVerdict`, `sendKillPair`, consumption, the `run` first line, the batch-refusal
   condition, counters `pairRequests` and `pairFallbacks` in `V3EntriesStats`, printed in the close line and the
   itest entries line.
5. Red check each of G1-G4, the O-guards, consumption order, the batch-refusal change and the error mapping, one at a
   time; `sendKillPair` as a no-op must turn P2 and O1 red.
6. `bun scripts/verify.ts`, biome on touched files, `r654-v3-imports.test.ts`, Opus build review.

## 7. Probe: does per-entry isolation cover session settings?

A recorded fact and the expected rate of lost kills; not a precondition. Directory `/coord/handoff/R-653/order-probe/`:
an app (table 50900 "R653 Probe Row"; SingleInstance codeunit 50901 with SetMark/GetMark) and a test app with
codeunit 50951 "R653 Reader" (tests that `Error` out with WORKDATE, LANGUAGE, ROWS, MARK) and 50952 "R653 Writer"
(sets WorkDate 2001-01-01, GlobalLanguage 1030, inserts a row, sets the mark). Runtime 17.0. Requests, through
`/coord/handoff/R-635/drive.ts` on the edge build: `reader-alone`; `writer-then-reader` (two entries);
`reader-then-writer`; `reader-alone-after`.

Read: setters must pass; isolation covers settings if R in `writer-then-reader` reads what `reader-alone` reads; a
leak is any R value equal to the writer's (record which). `reader-then-writer` R must read defaults;
`reader-alone-after` shows cross-request persistence of settings (F2). ROWS is a control (no Commit possible).
The exact files are in the probe directory.

## 8. Pre-commitment (committed before any live run)

Same edge build as R-652 (`0642f9b2…8720`). No BC (bc2 off-limits). No other heavy job.

Legs E1, E2, E3a, E3b (serve-entries): per mutant, `verdict`, `killingTest` and `killReproduced` identical to
R-652's; 0 differences against one-shot controls and baselines.

F = `pairFallbacks`, expected 0; any F allowed only if the formulas hold exactly.

| Leg | pairRequests | liveRequests | boundChecks | entriesSent | other |
|---|---|---|---|---|---|
| E1 | 3 | 3 + 2F (was 6) | 5 + 2F (was 8) | 44 + 4F | |
| E3a | 51 | 51 + 2F (was 102) | 90 + 2F (was 141) | 332 + 4F | coverage 37, daemons 1, cachedFalse 1 |
| E3b | 51 | 51 + 2F (was 102) | 90 + 2F (was 141) | 332 + 4F | echo 74, coverage 37, daemons 1, cachedFalse 1 |
| E2 | 290 | 305 + 2F (was 595) | 317 + 2F (was 607) | 1932 + 4F | daemons 8, cachedFalse 8 |

`boundChecks = warmups + prefetch + live + coverage` on every leg. CDO timing E3a: liveMs 10-16 s (was 22.65),
boundMs 13-19 s (was 25.27), loop 64-76 s (was 83.5); E3b loop 55-70 s (was 76). E2 reported, not bounded.

Controls and gates: E0 one-shot controls (G1 makes the pair a no-op; reuse R-652's or re-run, orchestrator decides);
`itest:alrunner` (`--parallel=3`, required: shared backend.ts and orchestrator.ts); `itest:alrunner-v3` prints
`pairRequests` and `pairFallbacks`; BC gates on the final head at the orchestrator's call, not bc2. CI green on both
jobs.
