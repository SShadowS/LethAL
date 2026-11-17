# PR-100 pre-commitment: where a run's time went, in LethAL's own output

Coord PR-100 (lethal-code, 2026-11-17). Every speed finding on DO so far (PR-88, PR-89, PR-90, PR-94) needed hand-parsing:
- the warm-up / prefetch / live split, from the `serve-entries` stderr line;
- which phase a daemon restart happened in (`serve-daemon-closed` carries no phase);
- al-runner's own per-request timings, which LethAL drops. A v3 `summary` carries `timings` (`setupMs`, `compileMs`,
  `engineMs`, `baselineMs`, `testsMs`, `coverageMs`, `otherMs`, `resetMs`, `baselineSource`, `engineKept`; serve.rs
  `timings_json`).

A user of a slow run should see where the time went without our scripts. **No verdict path changes, and the report schema does
not change.**

## 1. A phase on `serve-daemon-closed`
- **What it carries.** The event gains `phase`: the request kind in flight on that lane when it closed (`warmup`, `prefetch`
  or `live`), or `idle` when no request was in flight.
- **How it is known.** `Lane` keeps `inFlight` (set in `send()` around `runEntries`, cleared in `finally`); `closeLane` reads it.
- **What is unchanged.** Routine closes still emit nothing.

## 2. A new event, `serve-request-timed`, one per `send()`
```ts
{ type: "serve-request-timed";
  kind: "warmup" | "prefetch" | "live";
  lane: number;
  wallMs: number;              // LethAL's own clock around runEntries
  entries: number; tests: number;
  selectedOnly?: true;         // PR-94's flag was sent
  cut?: true;                  // a timeout row cut the answer (no summary)
  failed?: true;               // runEntries threw (the close event names why)
  cause?: string;              // warm-ups only, see below
  timings?: { setupMs?: number; compileMs?: number; engineMs?: number; baselineMs?: number; testsMs?: number;
              coverageMs?: number; otherMs?: number; resetMs?: number; baselineSource?: string; engineKept?: true } }
```
- **Where it is emitted.** Through a sink like PR-88's (`setRequestTimedSink`, wired in `handNotify`). It is emitted after
  the answer or the throw, before any decode check, so an unreadable answer is still timed.
- **What `timings` holds.** Only the fields above, copied when their type is right. Anything else is dropped, and a missing
  `timings` is simply absent (older builds, cut answers).
- **The warm-up `cause`:**
  - `first`: the lane's first daemon of this mode in the session;
  - `after-deploy`: the first after a redeploy;
  - `recycle`: after R952's bound;
  - `after-<reason>`: after a non-routine close of that lane and mode, for example `after-refusal` or `after-timeout`.

  The lane remembers the last close reason per mode key.
- **Where it goes.** Events stream only: not the report and not a warning, so gates' warning sets are unchanged.
- **Size.** On DO t11 this is a few thousand lines, far below the `mutant-scored` lines.

## 3. A TIMING section: `lethal run`'s stderr at session end, and `lethal explain <report> --events <events.ndjson>`
- **One fold for both.** A pure `foldTiming(events)` (new `timing-summary.ts`) folds any run's events, on any backend. The
  `run` command subscribes an accumulator to the same stream. `explain --events` reads the NDJSON file, skipping the header
  line and unknown types.
- **The section.** Lines are omitted when they have no data:
```
TIMING (wall clock)
  phases: generate 9.9 s, deploy 26.4 s, baseline 300.6 s, mutants 1,830.0 s, teardown 0.0 s
  serve requests: warm-up 9 (22.1 s), prefetch 61 (1,231.5 s), live 120 (574.0 s); selected-only 51
    warm-ups by cause: first 2 (5.1 s), after-refusal 4 (10.2 s), recycle 3 (6.8 s)
    al-runner inside them: setup 41.2 s, compile 12.0 s, engine 3.1 s, baseline 1.9 s, tests 1,601.0 s, coverage 0.0 s,
      other 7.3 s
  daemon restarts: 7 — refusal/<family> in prefetch 3, timeout in live 2, recycle 2
  timeouts: 4 mutants timeout-killed, 3 answers cut at a timeout row
  per covered mutant: 2.53 s (731 scored with coverage over the mutants phase)
```
  - "per covered mutant" is the mutants phase's `elapsedMs` / the `mutant-scored` events whose verdict is not `no-coverage`.
    With none, the line is omitted, never "0 s".
  - The restart families are cut at 40 characters.
- **`--events` with `--json`** is refused by name: the events file itself is the machine surface. So the explain schema
  (v29) does not move.
- **A partial stream** (a killed run, or no `session-finished`) prints `TIMING (partial: the run did not finish)`.

## Predictions (pre-committed)
- **No verdict changes.** `itest:alrunner-v3` passes unchanged: every leg, pin and warning set. The event stream gains
  `serve-request-timed` lines and `phase` fields; no gate reads them.
- **Schemas.** `bun scripts/generate-schemas.ts` regenerates only the event stream schema (`RunEvent`). The report and explain
  schemas are byte-identical.
- **Goldens.** No `.snap` moves. If one does (a CLI stderr capture), it is listed in an addendum before the change is accepted.
- **Unit tests, each red when its rule is reverted:**
  - `closeLane` stamps the in-flight kind, and `idle` between requests;
  - `serve-request-timed`: one per send, including a thrown send (`failed`) and a cut answer (`cut`, no `timings`);
  - `timings` copies only the known fields, of the right type;
  - the warm-up cause is right for each of the four kinds;
  - `foldTiming`:
    - each line, over a fixed event list;
    - "per covered mutant" excludes no-coverage, and is omitted at 0;
    - a partial stream;
    - a stream from a non-serve backend (phases and per-mutant only);
  - `explain --events` prints the section, and refuses `--json`;
  - `run` prints the section once at the end.
- **A live check.** The PR-94 DO slice re-run on the final head (`/coord/handoff/PR-94/slice.sh`, `--workers 1`) prints a
  TIMING section whose prefetch/live/warm-up seconds are at most the `serve-entries` stderr line's wall ms (that timer also
  covers decoding and re-sends), and within 5% of it. Its per-mutant
  report equals PR-94's AFTER arm (`scripts/report-diff.ts`: 0 differences).

## Addendum 1 (2026-11-17, after the Opus build review of 278d0ee7)
The review found no verdict risk. It found five places where the TIMING output would not be true. The rules are amended as
follows, before the fixes.
- **Warm-up cause, decided once per daemon start.**
  - The cause is set when a daemon starts and stored on the daemon. Its first warm-up carries it.
  - Every later lazy warm-up on the same daemon (`proveOnDaemon`) carries `lazy-prove`.
  - Closes of a BASELINE daemon (one with a baseline stop) never set a mutant warm-up's cause.
  - A redeploy sets `after-deploy` on every lane, whether or not that lane held a daemon.
  - So the causes are `first`, `after-deploy`, `recycle`, `after-<reason>` and `lazy-prove`.
- **Phase `baseline`.** `serve-daemon-closed.phase` gains `baseline`, for closes during a baseline, coverage or echo request
  (`plain()` and the coverage window). Every close that ends a request is stamped with that request's kind, including:
  - `warmup-refused` after the warm-up judge;
  - `kept-refusal-drift`;
  - the coverage-window dirty close.

  `idle` is only for closes with no request: a recycle or a stop-signal watch.
- **Per covered mutant** excludes `known-survivor` as well as `no-coverage`. A `mutant-scored` superseded by
  `batch-invalidated` is counted once: the last one per mutant id.
- **The header reads `TIMING (serve times are summed over lanes)`** when more than one lane ran, and `TIMING` otherwise. Counts
  take singular or plural forms ("1 mutant", "2 mutants").
- **Printed once.** `lethal run` prints the section exactly once per invocation, after the R786 fallback retry if there is
  one. A throw inside the fold or the render is reported on one stderr line and never replaces the run's own error.
- **`explain --events` streams the file line by line.** Memory stays flat in the file's size, and a corrupt line's error names
  its real line number.
- **Tests added to the predictions, each red when its rule is reverted:**
  - a restarted daemon with two codeunits gives the exact cause list `after-timeout`, `lazy-prove`;
  - the first mutant warm-up after a baseline timeout says `first`;
  - a `request-failed` close in a thrown send is stamped `prefetch`;
  - a `plain()` close is stamped `baseline`;
  - `run` prints once on the fallback path and on the normal return path;
  - streaming, checked with a fold test over a generated 200,000-line file.
