# PR-96 (R1093): split the serve prefetch across lanes, per procedure scope

Status: r1 draft plus review r1's required changes (2026-11-16, lethal-preproc). Not built. A build task must write r2 from
§0 and re-review it. The go/no-go measurement is `/coord/handoff/PR-96/result.md`.

## 0. Review r1 (opus spec-adversary): not safe as drafted; convergent fixes, the core holds
The r2 spec must carry each of these. §1-§6 below are the r1 draft they amend.

1. **The proof could pass empty against empty.**
   - lethal-code's DO slice has 0 timeouts, 0 drift fires, 0 restarts and 1 lane started.
   - Pre-commit non-zero floors, or the slice is not evidence:
     - lanes started = 3;
     - at least one unit prefetched per lane;
     - at least one lazy proof on a lane of 1 or more;
     - at least k `v3-cpu-stop` timeout kills;
     - at least one kept-refusal-armed next request on lanes of 1 or more;
     - `selectedOnlyRefusedGapped > 0`.
   - Pick the slice from t9-t11 to include R1057's procedures and t10's drift-fire mutants.
   - **Unwatched door (speculative):** a `v3-cpu-stop` kill is not reproduced (R577 skips it), and a kept refusal inside a
     lazy proof's warm-up never arms PR-56. The split puts more such warm-ups before prefetch requests.
   - **The evidence chain:** drop "`resetMs` 0" as evidence (a 0 ms reset looks like no reset). Label PR-92 E1 as narrow.
2. **Shared backend state, not only four maps.** Each item is made lane-scoped, or gets a stated rule and a red test
   (lane B's prefetch must not change lane A's state):
   - `prefetchMutants` resets everything at its top: `dropPair()` for every lane, `pairStore.clear()`, `prefetched`,
     `timedOutMutants`. PR-51's held-timeout walk breaks if another lane clears `timedOutMutants`: a test runs in context
     instead of alone (R1067).
   - `cutState`/`restoreCutState` (no lane argument);
   - `prefetchRemainingMs`, one field: the first lane to finish clears R912's clamp for all of them;
   - `prefetchBatch` (R912's batch-refusal judgement), and PR-56's re-run snapshot of it and of `stats`;
   - `needsLiveCall` (reads the owner's `prefetched`);
   - `union` (window 0's `batchPlans` must be in it before lane 0's first warm-up);
   - `prefetchWindow` and `batchKillPairs` hard-code `this.lane`.
3. **A barrier.**
   - No lane above 0 sends anything until lane 0's first whole-union warm-up has passed, which costs about one warm-up.
     Otherwise R960's fallback (`stats.warmups === 1`, shared) can be lost, and lanes can commit verdicts before a serve
     refusal or a one-shot re-run that discards them.
   - Say per mode (R896) whose warm-up decides.
4. **Blame.** A throw from a per-unit prefetch, before the unit's first `begin`, is blamed on `unit[0]` with `selfKept`
   false, not on `current()` (the previous unit). Refusal stops join §3's stop paragraph.
5. **PR-94.**
   - `runSelectedOnly` is set per REQUEST, and only when every entry qualifies. So whether a mutant's entry is flagged
     depends on its neighbours, which the split changes.
   - An unflagged request runs its tails hidden (R1096): a second cross-entry state. State it in §3.
   - Report `selectedOnlyRequests` and `selectedOnlyRefusedGapped` per N.
   - Use PR-94's one-shot arbiter to diagnose a move; a move still blocks.
6. **Memory.**
   - PR-89's cgroup lane gate is a hard prerequisite: on master `affordableLanes` reads the HOST's free memory.
   - Each launched lane reserves its declared bytes until its first request is measured, or lanes start in steps.
   - Proof runs declare `heavy-slot --peak` as N x serve.
7. **The lane-start rule** is written exactly. Today's R785 weights read the owner's `prefetched`, and with the split
   lane 0's first unit carries its daemon start: as in m1, "unmeasured", so 1 lane.
8. **Metrics.**
   - Pre-commit the mutant-phase wall (N = 3 against N = 1, both after PR-94), not a "prefetch wall per lane".
   - Make the per-lane cost in `result.md` lazy, as §2.4 says.
   - Note the CPU contention the split adds: wall-time checks move only in the safe direction, and any move blocks.
   - Test 6's fake models state per daemon and per lane, red-checked by reverting to shared maps.

**Checked and holding:** the R197 ledger (per scope), OrderedCommit's order, kill pairs with a per-lane `pairStore`, lazy
proof as strong as the union warm-up, the budget check per mutant (R1014), a cut prefetch going live on its lane, N = 1 and
the v3 gate untouched.

## 1. Why
- **Lanes wait for the prefetch.** `runMutantsParallel` (orchestrator.ts) prefetches each window WHOLE and serially on lane 0
  (`owner.prefetchMutants`). Only then do the lanes score it, so lanes 1..N-1 are idle for the whole prefetch.
- **The prefetch is the largest part.** It is 33-45% of a DO window's mutant phase (t9 4,888 s, t10 2,270 s, t11 5,117 s).
  On lethal-code's scoped DO slice, run with `--workers 4` (`/coord/handoff/PR-89/m1/`, 864 mutants, 2,603 s), it is 72%
  (1,670 s). Only 1 of 4 lanes started there, so PR-89's lanes alone buy nothing on that slice.
- **The estimate:** at N = 3 the prefetch wall falls to ~P/3 plus ~100 s for each extra lane's first daemon (a ~26-28 s
  recompile, #8143, plus its first proof):
  - t11: ~3,200 s saved;
  - the slice: ~1,000 s saved (2,603 s to ~1,600 s).
- **Order with PR-94.** PR-94 (`runSelectedOnly` on cut entries, R1094) shrinks every prefetch entry by itself. The two
  compose (the split divides what PR-94 leaves), so this spec's figures are pre-committed after PR-94 lands.

## 2. The change
Under `--workers N` (N > 1) on the serve-entries transport, `runMutantsParallel` no longer prefetches the window on the
owner. Instead:
1. **Windows (R912) stay** as the unit of budget checks and ordered commits.
2. **Each lane prefetches its own units.** The pull queue (`runScopeQueue`) hands a lane a procedure-scope unit, as it does
   today. The lane first prefetches exactly that unit's covered mutants on its OWN daemon (`prefetchMutants` on the lane's
   split backend, with the lane's own `prefetched` map, `pairStore`, `coveringOf` and `timedOutMutants`), then scores them as
   today.
   - The grouping inside a unit is today's (`prefetchWindow`: one group per mutant, `groupsThatFit` chunking from the shared
     max-only costs, R987/PR-88).
3. **Kill pairs (R778)** for a unit's kills are batched on the same lane after its prefetch (`batchKillPairs` per lane). A
   kill's NONE confirm and reproduction therefore stay on the daemon that scored it, as today on lane 0.
4. **The first warm-up per lane:** a lane's first daemon proves lazily, only the codeunits of its first unit (PR-24's
   `proveOnDaemon`), instead of warming the whole union. That avoids ~N-1 whole-union warm-ups.
   - Lane 0 keeps its whole-union first warm-up: R786/R960 decide there whether serve is usable at all.
5. **Lane start:**
   - a lane may start for prefetch work; today R785 starts a lane only after a measured lane-0 live warm-up;
   - the memory gate is PR-89's cgroup lane gate (`affordableLanes`/`laneMayStart`, bytes per lane = max(LANE_RSS_BYTES,
     daemonMaxRssGb, lane 0's PR-88 peak));
   - R948's guard stays the backstop.
6. **N = 1 is unchanged** (the owner prefetches the window). No gate leg uses `--workers`.

## 3. Why no verdict moves (to be challenged)
- **A mutant's group is unchanged:** the same echo and codeunit entries, the same `mutantExcludes` (PR-20 cut, R998 tail).
  Only which other groups share its request and its daemon changes.
- **Entries in one request are independent:**
  - the PR-24 carry probe;
  - PR-92 E1 (14 mutants, one request each against one batched request: 0 differ);
  - each entry is a pass that resets the database (`resetMs` 0, isolation `test`).
- **Timeouts:** PR-51 (R1057) made the timeout class independent of packing (a held timeout is replayed, a later kill
  wins).
- **The killing test (R197)** is read from the mutant's own rows, so it cannot move unless a row moves.
- **The kept-refusal carry** is the one real cross-entry state. Which group follows a kept refusal on a daemon changes with
  the split. PR-56's drift guard (next request per daemon) still applies, per lane. Its fires in t9-t11 (1/3/5) were all
  R1072's false-fire class.
- **R577's reproduction** runs on the lane that scored the kill, as today.
- **Budget, stop signal and memory gate:** which mutants are scored before a stop changes, never a verdict (OrderedCommit
  keeps the commit order).

## 4. Pre-commitment (after PR-94 lands, before any build is trusted)
- **Proof pairs,** each N = 1 (today's serial prefetch) against N = 3 (split), fresh, per mutant IDENTICAL in verdict and
  `killingTest` (`scripts/report-diff.ts`):
  - lethal-code's scoped DO slice (the 4 e-document files of PR-89 m1);
  - the gift card;
  - D1.
- **Counted on the DO slice:**
  - the drift-guard fires;
  - the timeout kills (all `v3-cpu-stop`);
  - the lanes started;
  - the prefetch wall per lane.
- **The prefetch wall on the slice** at N = 3 at most 45% of N = 1's (the estimate is ~40%).
- **The tree peak** stays under the cgroup lane gate's bound, with no R948 stop.
- **The v3 gate** (workers 1) per mutant unchanged.
- A verdict or `killingTest` move blocks. It is never re-recorded.

## 5. Tests (red both ways)
1. N = 1: the owner prefetches the window, unchanged; a fake counts the prefetch calls per lane.
2. N = 3: each lane prefetches exactly its units' covered mutants, on its own daemon, before scoring them; no owner-wide
   prefetch.
3. A unit's kill pairs are batched and served on the lane that scored the kill.
4. A lane's first daemon proves only its unit's codeunits; lane 0 still warms the union.
5. A lane starts for prefetch work under the cgroup gate; it does not start when the gate says no.
6. Verdict identity on a stateful fake backend: N = 1 against N = 3, equal per mutant.

## 6. Open questions for review
- Does any state outside the lane backend (the shared cost model, the R197 ledger, OrderedCommit, the union set) break when
  several lanes prefetch at once?
- Is lazy proof on lanes 1..N-1 as strong as the whole-union warm-up for verdicts? (R1035: entries are proven per codeunit
  before use.)
- What should happen when a lane's prefetch is cut (R612) or dropped: its groups going live on that lane, as today on lane 0?
