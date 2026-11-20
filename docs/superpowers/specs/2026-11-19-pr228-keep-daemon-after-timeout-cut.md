# PR-228 spec and pre-commitment: keep the serve daemon after a timeout cut (R1147)

Lane lethal-bugs, coord PR-228. The measurement is complete (2026-11-19 18:18Z; the method-mode fresh leg paused 17:50-18:01Z for
preproc's refresh, resumed at request 22). **Ruled YES by the orchestrator (2026-11-19):** keep the daemon after a cut, behind the
existing drift check, with an off switch; default-on only after a full DO run confirms it. It is built after PERF-10 in
priority. Evidence: `/coord/handoff/PR-228/` (`census.md`, `check.ts`, `selfcheck.ts`, `test.*`, `method.*`).

## The measurement (our standard, on `current` edge-4ebfe7913, y2's flags and .NET sidecar)
1. **Census** (`census.md`): y2 and y3 meet the SAME 8 timeout sites, joined on the full site key: 17 timed-out rows each; 2
   void-method-call, 2 negate-conditional, 3 remove-not, 1 return-value; 7 timeout-killed, 1 killed. y3's 23 timeout closes are
   these 8 mutants cut more than once (prefetch, then live).
2. **Direct check, kept daemon vs a fresh daemon per request, every row compared** (`check.ts`):
   - TEST mode (DO's own isolation; PR-222's 16 requests: each timeout mutant, then a no-mutant control): all 8 cut requests
     cut (11 timed-out rows), one kept daemon, **16 of 16 requests equal**.
   - METHOD mode (the recheck's isolation; 34 per-test requests: each of the 17 timed-out tests cut, then the same test with no
     mutant): all 17 cut requests cut (17 timed-out rows), one kept daemon, **34 of 34 requests equal**.
   - Self-test (`selfcheck.ts`): a planted row difference is caught; an unchanged copy reads equal.
3. **`current` vs 49f8a3e05:** PERF-15 (PR-222, alrunner's build) found the same, with al-runner's own clean check: 11/11 lines
   0 differ in answers, engines, session, language, clock, process and compile. Its one store difference is the check's own
   first-login record (an artifact; alrunner asked to drop it). On `current` the cut path answers the same: no row differs.

## What a keep would save on DO
y3: 23 timeout closes, **1,107.6 s of after-timeout warm-up summed over the 3 lanes** (TIMING), so about **370 s of wall**, about
**1.5% of the mutant phase** (23,928 s). The task's "about 4.6%" divides lane-seconds by the wall; the wall figure is the fair one.
y2: 23 closes, about 1,305 lane-seconds.

## The rule proposed
- After a `--test-timeout` cut, keep the serve daemon for the next request instead of closing it, ONLY under the keep standard
  already used for kept refusals (PR-56/PR-195):
  - the next request on that daemon runs the drift check LethAL already runs after a kept refusal (`serve-drift-after-kept-refusal`:
    a NONE row, or a test before the first one covering the mutant, that differs from the baseline closes the daemon and re-runs
    the request on a fresh one; the fresh rows stand);
  - a session option to turn it off (on by default only after a full DO run confirms it);
  - a per-cut-kind allow list is NOT needed: the cut is one path (the daemon's own timeout), unlike refusals' many texts.
- What stays: a hang that the cut does not end (the daemon stops answering) still closes it; `daemonMaxRssGb`/`Requests` recycles
  are unchanged.

## What could make a verdict differ, and what guards it
- State the cut test left half-written (rows, SingleInstance globals, an open transaction, the .NET sidecar) leaking into the next
  request. Guard: test isolation rolls back per test or codeunit; the drift check on the next request; measured 0 of 50 requests
  (16 + 34) differing on DO, including the control right after each cut.
- A cut kind DO does not have (another project's slow test, a cut in a codeunit with SingleInstance state across tests). Guard:
  the drift check, plus a census in the first full run with the keep on.
- The NEXT request being the very same mutant's live re-run (prefetch cut, then live): measured as the control pattern here; the
  full run's census will name how often.

## To confirm before default-on
A full DO run with the keep on, against the then-latest fresh run, per mutant on the full site key: 0 verdict and 0 killing-test
differences, the drift check's closes counted, and the saved warm-up time measured.

## The build (pre-committed; after PERF-10)
- **Option:** `alRunnerV3.keepAfterTimeout` (boolean, default `false`: today's close-after-cut, unchanged), config, CLI
  pass-through (`v3SectionPassThrough`), backend cfg.
- **On:** after a `--test-timeout` cut answer, the daemon is NOT closed. The cut is recorded like a kept refusal (`prior`, with
  the cut test's name and a fixed text `timeout cut`), so the next request on that daemon runs the existing PR-56 drift check
  (`serve-drift-after-kept-refusal`). A drift closes the daemon and re-runs the request on a fresh one, as today for refusals.
  A daemon that does not answer after the cut (a hang the cut did not end) is closed as today.
- **Reported:** a new close-reason count, "timeout cuts kept", in TIMING; drift closes after a kept cut are named by the cut
  test.
- **Tests, red both ways:** off -> close after the cut (as today); on -> no close, the next request carries the drift check, a
  planted drift after a cut closes and re-runs on a fresh daemon, and a non-answering daemon is still closed.
- **Gates:** the v3 gate with the option OFF (default: no change); one short same-scope DO run with it ON vs OFF over a scope
  holding a timeout mutant (PR-222's codeunits), with every verdict equal.
- **Not in this build:** default-on (after the full DO run above, by a ruling).
