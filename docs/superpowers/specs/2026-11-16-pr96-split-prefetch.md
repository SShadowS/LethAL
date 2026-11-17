# PR-96/PR-97 (R1093): split the serve prefetch across lanes, per procedure scope, r4

Status: r4 (coord PR-97, 2026-11-16, lethal-preproc). Not built.
- **What answers what:** §10 (r4) answers the r3 delta review, §9 (r3) answers r2, §8 (r2) answers r1. Where they differ, §10
  overrides the earlier text.
- **Before the pre-commitment:** a final short delta review of §10, right before it is committed. The pre-commitment's
  counts, mutant identities and bound come from DO run 13 (t12) and from PR-94's and PR-89's landed code, none of which exist
  yet.
- **Before any build:** PR-94 (`runSelectedOnly` on prefix-cut requests) and PR-89's cgroup lane gate must have landed.
- **What r2 answers:** review r1 (opus spec-adversary). Its text is r1's §0 at `9c41f8d7`; each finding's answer is in §8.
- **The measurement:** `/coord/handoff/PR-96/result.md`.

## 1. Why
- **The prefetch holds every lane back.** `runMutantsParallel` (orchestrator.ts) prefetches each window (R912) WHOLE and
  serially on the owner (lane 0), with `owner.prefetchMutants`, before any lane scores it.
- **Its size.** It is 33-45% of DO windows t9-t11 (4,888 / 2,270 / 5,117 s), and 72% (1,670 of 2,603 s) of lethal-code's
  4-lane scoped DO slice (`/coord/handoff/PR-89/m1/`). There only 1 of 4 lanes started.
- **The estimate.** At N = 3 the prefetch's share of the wall falls to ~P/3:
  - plus ~30-40 s per extra lane (its first daemon's recompile, #8143, plus a lazy first proof);
  - plus one lane-0 warm-up of barrier (§2.3);
  - before PR-94's own reduction of P.
- **What the decision is pre-committed on:** the mutant-phase wall (§6), not this estimate.

## 2. The change (`--workers N`, N > 1, serve-entries transport; N = 1 unchanged)
### 2.1 Units
- Windows (R912) stay the unit of the budget check and of OrderedCommit.
- Inside a window the pull queue (`runScopeQueue`) hands a lane a procedure-scope unit, as today.
- The lane first prefetches exactly that unit's covered mutants on its own daemon, then scores them.
- The grouping inside a unit is today's `prefetchWindow`: one group per mutant, `mutantExcludes`, `groupsThatFit` chunks
  from the shared max-only costs (R987/PR-88).

### 2.2 Per-lane prefetch state (review r1 #2)
- **The record.** A new `PrefetchState` on `Lane` holds what is backend-wide today:
  - `prefetched`;
  - `timedOutMutants`;
  - `pairStore`;
  - the lane's pending pair;
  - `prefetchRemainingMs` (R912's clamp);
  - the lane's own stats counters (r3, review r2 #7): every counter a lane increments is the lane's. The session totals are
    summed at the end; PR-56's restore and `batchKillPairs`' `liveRequests - liveBefore` read the lane's own counters.
- **Not per lane (r3, review r2 #2): `prefetchBatch` stays SHARED and one-way.** R912's judgement is about the BATCH's
  layout, not a unit's:
  - once any prefetch entry has run on any lane, no prefetch request speaks for the batch;
  - before the barrier (§2.3) only lane 0 can send, so at N > 1 only lane 0's pre-barrier requests can speak for it, as at
    N = 1;
  - PR-56's re-run restores the shared record under that one-way rule (it never resets `ran`).
- **PR-94's `neverFlag`** (r3, review r2 #8) stays shared: a latch any lane may set. It moves time and visibility only (R1096
  closed).
- **Who touches it.** `prefetchMutants`, `prefetchWindow`, `batchKillPairs`, `takeStoredPair`, `sendKillPairOn`,
  `needsLiveCall`, `runRow`'s `cutElsewhere`, `cutState` and `restoreCutState` all take the lane, and read or write ONLY that
  lane's record. `cutState(id)` becomes `cutState(lane, id)` in the lane view.
- **The resets.** The resets at the top of `prefetchMutants` (`dropPair`, `pairStore.clear()`, the new `prefetched` and
  `timedOutMutants`) reset the CALLING lane's record only, at its unit's start.
- **What stays shared, with its rule:**
  - `coveringOf` and `costOf` are keyed by mutant or call. A mutant belongs to exactly one unit, so exactly one lane writes
    its key. The costs are max-only (PR-88), so a concurrent reading can only raise a cut.
  - `union` holds the whole batch's codeunits (window 0's `batchPlans`) before lane 0's first warm-up (§2.3).
  - The stats counters are summed across lanes at the end, never read for a decision except as stated in §2.3.
  - The R197 ledger stays per scope (units are whole scopes).
- **Each item gets a red test:** lane B's prefetch leaves lane A's record unchanged (§7).

### 2.3 The barrier (review r1 #3; r3: review r2 #3, #4)
- **The rule.** No lane above 0 TAKES A UNIT until lane 0's SESSION-FIRST warm-up (the whole-union warm-up of its first
  daemon) has passed `judgeWarmup`.
  - Only that one warm-up; not one per mode. A wait per mode could wait for a mode lane 0 never uses, which is a deadlock.
  - R960 fires only at the session's first warm-up. At `--workers > 1` a one-shot fallback refuses the session anyway
    (`al-runner-v3-workers-refused`).
- **What it guards:** a refusal there still stops before any verdict is committed.
- **Launch (r3).**
  - Lanes 1..N-1 are launched by a callback when that warm-up passes, not at a unit boundary of `runScopeQueue` (which would
    make them wait for lane 0's whole first unit, up to ~100 mutants).
  - If lane 0's first unit has no serve groups (R937, one-shot codeunits only), lane 0 starts its daemon and union warm-up
    first anyway, so the barrier does not slip.
- **Lazy start on lanes ≥ 1 (r3, a code change).**
  - Today `unionWarmed` is a WeakMap per lane, and each lane's first daemon per mode goes through `startDaemon`, a
    whole-union warm-up.
  - r3 marks lanes 1..N-1 as union-warmed for every mode when they launch. Their first daemon then starts through
    `spawnRestarted`, and `proveOnDaemon` proves each codeunit before first use (PR-24), with its own test.
  - That is what makes the ~30-40 s per extra lane in §1 true. Without it, each lane pays a whole-union warm-up.

### 2.4 Failure inside a unit (review r1 #4)
- A throw from a lane's unit prefetch, before the unit's first `begin` (a batch refusal, an unproven batch, a dependency
  skip), is blamed on `unit[0]` with `selfKept` false. The previous unit's `current()` is not used.
- A request cut (R612) or a dropped prefetch request leaves its groups to live requests on that lane, as on lane 0 today.

### 2.5 Lane start and memory (review r1 #6, #7)
- **The gate is PR-89's cgroup lane gate:**
  - free = guard bound - (cgroup used + held reservations);
  - bytes per lane = max(LANE_RSS_BYTES, daemonMaxRssGb, lane 0's PR-88 peak).
- **Reservation:** each launched lane reserves its bytes from launch until its first request is measured (PR-88's
  serve-request-sized). So N lanes started at once cannot all be admitted against an empty `memory.current`.
  - **Release (r3, review r2 #9):** a reservation is released when its lane's first request is measured, or when the lane ends
    without one (a thrown or dropped first request, a unit that is one-shot only, the lane's queue empty), in a `finally`.
  - A lane may hold one daemon per mode (`Lane.daemons`). Bytes per lane count each mode's daemon the lane has started; the
    other-mode daemon's size on DO is not measured (stated as such).
- **The rule:** lane k (k ≥ 1) starts when all of these hold:
  - the barrier (§2.3) has passed;
  - the window holds at least k + 1 units not yet taken;
  - the gate admits k's reservation.

  R785's live-warm-up pacing does not apply to prefetch work (it read the owner's `prefetched`, now per lane).
- **R948's guard stays as the backstop.**
- **Proof runs declare `heavy-slot --peak` of N x serve.**

### 2.6 PR-94 (review r1 #5)
- PR-94 sets `runSelectedOnly` per REQUEST, only when every entry qualifies. Which neighbours share a request changes with
  the split, so whether a given entry's tail runs hidden changes too.
- R1096 is closed: PR-95 measured that a hidden tail leaves the daemon clean, and that a hidden tail refusal or hang is
  invisible. So this moves time and visibility, not state.
- The run reports `selectedOnlyRequests` and `selectedOnlyRefusedGapped` per N.
- A verdict move found in the proof is diagnosed with PR-94's one-shot arbiter, and still blocks.

## 3. Why no verdict moves (r2, to be challenged)
- **A mutant's group is unchanged:** the same echo, the same codeunit entries, the same `mutantExcludes`. Only its request
  and daemon neighbours change.
- **The neighbours:**
  - other entries (independent: PR-24's carry probe; PR-92 E1 is NARROW: 14 mutants, one daemon, no timeouts);
  - lazy-proof warm-ups;
  - kept refusals.
- **The kept-refusal carry is the one real cross-entry state.**
  - PR-56's guard checks the next request per daemon, and still applies per lane.
  - It is NOT armed by a kept refusal inside a warm-up (`proveOnDaemon` and `startDaemon` use `send()`; only `requestOne`
    sets `daemon.keptRefusal`; R1072 open). The split puts more lazy warm-ups before prefetch requests.
  - **r3: no warm-up arming here (r2's rule is withdrawn, review r2 #1).** It would make `requestOne`'s drift re-run loop
    without end: the re-run's fresh daemon re-arms from its own lazy proof, and t11's baseline holds kept refusals in 31
    test codeunits. It would also change N = 1.
  - The gap stays R1072's, as a known limit. The proof counts warm-ups that held a kept refusal per lane, and they are
    reported, never netted.
  - A separate item may close it at N = 1, with its own pre-commitment, the rule that a drift re-run is never
    drift-checked again (one re-run, counted), and a v3 gate run.
- **`v3-cpu-stop` kills are not reproduced** (R577 skips them; PR-43), and the drift guard covers none of them:
  - `requestOne` skips answers cut at a timeout;
  - `keptRefusalDrift` skips timeout rows and alone entries;
  - R1067's alone re-measure is unchecked.

  Their protection is entry independence (PR-24's carry probe; PR-95's 60 kept + 50 fresh readers) plus this proof's
  per-mutant identity. Hence the floor on such kills (§6). (r3: r2's "plus the guard" was wrong, review r2 #5.)
- **Timeouts:** PR-51 (R1057) made the timeout class packing-independent.
- **Wall-time checks** ("confirm passed quickly", R514's margin, `v3CallDeadlineMs`) move only in the safe direction under the
  CPU contention the split adds (a deadline drops to live, a live call to `deadline-exceeded`). Any such move blocks.
- **The killing test (R197)** is read from the mutant's own rows.
- **R577 reproductions** run on the lane that scored the kill.
- **Stops:** budget, signal, memory gate and the §2.4 refusal stop change which mutants are scored before a stop, never a
  verdict (OrderedCommit).

## 4. Unchanged
- N = 1 (the owner prefetches the window).
- No gate leg uses `--workers`. The v3 gate therefore cannot cover the new path; the proof (§6) is its coverage, and a gate
  leg at N = 3 is a follow-up item.

## 5. Order of work
1. PR-94 lands.
2. PR-89's cgroup lane gate lands.
3. r2's re-review passes.
4. Then this pre-commitment (§6) is committed, and the build follows.

## 6. Pre-commitment (committed before the proof runs)
**The proof slice** (r3, from per-mutant facts in R-984's dos3.sqlite, runs 10-13; review r2 #6). Every part is narrowed by
`--lines` to one procedure, with the spans taken from a dry-run listing at build time:
- **The timeout kills.** Two stable `v3-cpu-stop` kills, timeout-killed in every window t10-t13 (re-scored each window; the
  "7" of r2 counted the same mutants again):
  - M13125, `CDODocumentTemplateLine.Table.al` `CopyAttachmentsTo` (line 1636);
  - M14760, `CDOEMailTemplateHeader.Table.al` `GetRecipients` (line 875).
  - r2's third file, `CDOEMailLog.Table.al` (M25653, seen in t11 only), is dropped.
- **The refusals that still close a daemon after PR-93.** Four procedures of `CDOEMailTemplateManagement.Codeunit.al` produced
  the four texts PR-93 did not keep, per mutant (verdict `error` with that text, runs 11-12):
  - `CreateDocumentsForRecord`: the placeholder Pdf read (2 mutants);
  - `CreateReportUsingReportSelection` (4) and `CreateReports` (2): SaveAs of a report with a layout;
  - `GetReportParameters`: Report.RunRequestPage with a parameters string (2).
  - r2's `ShouldShowRequestPage` is dropped: its 10 were cascade texts, which are kept.
- **Drift.** The drift-fire tests (Codeunit68859.CreatePDF_WithValidData_ShouldCreatePDF, Codeunit68996.AutomaticStatementJob_
  ...) are red in the baseline, so no mutant lists them as covering. They enter only as rows of whole-codeunit entries: 62 slice
  mutants ran their codeunits (review r2's count). The drift floor below is therefore a floor on the guard ARMING, not on a fire.

**The runs:**
- one fresh N = 1 run and one fresh N = 3 run, same head (after PR-94 and PR-89's gate), same build, same store state;
- compared per mutant with `scripts/report-diff.ts`: verdict and `killingTest` IDENTICAL;
- also identical on the gift card and D1 at N = 1 against N = 3.

**Before any proof run (r3, review r2 #6): make the floors measurable.** The build adds:
- a `lane` field to `serve-daemon-closed`, `serve-drift-after-kept-refusal` and `serve-request-sized`;
- per-lane counters in the stats line: units prefetched, lazy proofs, requests armed by a kept refusal in `requestOne`,
  warm-ups that held a kept refusal, refusal closes.

**Non-zero floors.** If one is missed, the run is NOT evidence and is re-planned, never counted as a pass:
- lanes started = 3;
- every lane prefetched at least one unit (per-lane counter);
- at least one lazy proof on a lane ≥ 1 (with r3's lazy start, every lane ≥ 1 has them);
- at least 1 `v3-cpu-stop` timeout kill (M13125 or M14760);
- at least 1 refusal close (a restart) on a lane ≥ 1;
- at least 1 `requestOne`-armed next request on a lane ≥ 1 (warm-up-held kept refusals are counted apart and do not meet it).

**PR-94's gapped flag (r3, review r2 #6):** `selectedOnlyRefusedGapped` is reported, not a floor.
- A gapped entry needs a #8059 prefix-name clash, which the slice may simply not hold.
- So §2.6's interaction is covered by a unit test (a request with one gapped entry, at N = 1 and at N = 3, the same flag
  decision per request). A 0 is reported as "§2.6 not exercised by the slice".

**Committed figures:**
- 0 verdict or `killingTest` moves.
- **The mutant-phase wall at N = 3** at most 1.2 x the scheduling bound, plus the barrier.
  - The bound is the longest-first (LPT) schedule of the N = 1 run's per-unit times on 3 lanes (r3, review r2 #10: the
    longest unit, not a third of the total, sets the wall).
  - It is computed from the N = 1 run and written into the receipt BEFORE the N = 3 run starts.
- The tree peak under the gate's bound, with no R948 stop.

A move blocks; it is never re-recorded.

## 7. Tests (each red-checked both ways)
1. N = 1: the owner prefetches the window, unchanged (a fake counts prefetch calls per lane).
2. N = 3: each lane prefetches exactly its units' covered mutants, on its own daemon, before scoring them.
3. **Per-lane state:** lane B's unit prefetch leaves lane A's `prefetched`, `timedOutMutants`, `pairStore`, pending pair,
   `cutState`, R912 clamp and counters unchanged. One test per item.
3a. **`prefetchBatch` is shared and one-way:**
    - a request on lane 1 after any prefetch entry ran never speaks for the batch;
    - the same request at N = 1 and at N = 3 gets the same judgement;
    - PR-56's restore never resets `ran`.
4. A unit's kill pairs are served on the lane that scored the kill.
5. **The barrier:**
   - no lane ≥ 1 takes a unit before lane 0's session-first warm-up passes;
   - lanes are launched by the callback, not at a unit end;
   - R960's fallback still fires at lane 0's first warm-up when lanes are waiting;
   - a lane ≥ 1 never takes R960's path;
   - lane 0's first unit with no serve groups still starts lane 0's daemon first.
6. A unit-prefetch throw before `begin` is blamed on `unit[0]`, with `selfKept` false.
7. **Lane start and lazy start:**
   - a lane starts when the barrier, the units and the gate allow;
   - it does not start when the gate says no;
   - N launched lanes hold N reservations until measured, and a lane that ends without a measured request releases its own;
   - a lane ≥ 1's first daemon starts through `spawnRestarted` and proves per codeunit, with no whole-union warm-up.
8. **No warm-up arming (r3):** a kept refusal inside a warm-up does NOT arm the drift guard, at N = 1 or N = 3 (it is counted,
   per lane). Red if r2's arming is added back.
9. Verdict identity on a stateful fake that models state per daemon and per lane: N = 1 against N = 3 equal. Red-checked by
   reverting §2.2 to shared maps, which must make it differ.
10. PR-94: a request holding one gapped entry gets the same per-request flag decision at N = 1 and at N = 3.

## 8. Review r1 (opus), finding by finding
1. **The proof could pass empty against empty.** §6's slice, chosen from data to hold timeouts, refusal closes and the drift
   tests, and the non-zero floors. §3 drops "`resetMs` 0" and labels E1 narrow.
2. **Shared state.** §2.2 lists every item, makes it per lane or gives its rule, and §7.3 tests each.
3. **No barrier.** §2.3.
4. **The blame for a unit throw.** §2.4.
5. **PR-94's per-request flag.** §2.6, with R1096's close by PR-95.
6. **The memory gate.** §2.5: PR-89's gate as a prerequisite, reservations, the heavy-slot declaration.
7. **The lane-start rule.** §2.5, exact.
8. **The metrics.** §6: the mutant-phase wall, the per-lane cost made lazy, contention named in §3, test 9's fake red-checked.

## 9. Review r2 (opus delta), finding by finding (answered in r3)
1. **HIGH, the warm-up arming loops and changes N = 1.** Withdrawn (§3). Warm-up-held kept refusals are counted per lane, the
   floor is on `requestOne`-armed requests (§6), and test 8 pins "no arming". Closing R1072's gap is a separate N = 1 item.
2. **A per-lane `prefetchBatch` breaks R912's batch-wide rule.** Kept shared and one-way (§2.2, test 3a).
3. **The barrier deadlocks per mode, and has no launch trigger.** Session-first warm-up only, launched by a callback, with lane
   0 starting its daemon even when its first unit is one-shot (§2.3, test 5).
4. **"Lanes prove lazily" did not match the code.** A stated code change: lanes ≥ 1 are marked union-warmed at launch
   (§2.3, test 7).
5. **"Plus the guard" was wrong for `v3-cpu-stop` kills.** Fixed (§3).
6. **The slice facts and the floors.** The slice is restated per mutant (2 stable timeout kills; 4 procedures that produced
   the 4 unkept texts; the drift tests enter only as whole-codeunit rows). The floors are made measurable by `lane` fields and
   per-lane counters. The PR-94 gapped floor is reported, with a unit test, and its 0 is stated (§6).
7. **Stats.** Per lane, summed at the end (§2.2).
8. **`neverFlag`.** Listed as shared, with its rule (§2.2).
9. **Reservations.** A release rule, and daemons per mode counted (§2.5).
10. **The 60% target.** Replaced by 1.2 x the LPT bound from the N = 1 run's per-unit times, written before the N = 3 run
    (§6).

## 10. Review r3 (opus delta), finding by finding: r4's rules (these override §2-§7 where they differ)
1. **`prefetchBatch` was not "shared and one-way" in the code.**
   - Today `send()` resets `size`/`ran` at every 256-entry chunk, and PR-56's restore writes `batchBefore.*` back.
   - **r4 rule:** at N > 1, `ran` is a LATCH. The chunk rule never resets it, the PR-56 restore never writes it, and `size` is
     not used at N > 1. N = 1 keeps today's code unchanged (§4 holds).
   - Test 3a's middle clause becomes: "at N > 1, once any prefetch entry ran, no request speaks for the batch; before the
     barrier only lane 0 sends".
   - **Residual, stated:** lane 0's pre-barrier request is a single unit, much narrower than N = 1's first chunk, so at N > 1
     the batch-refusal judgement rests on fewer entries.
2. **The bound left out the prefetch** (an N = 1 prefetched mutant's `duration_ms` is ~0). **r4 rule:**
   - **Per-unit time** = the unit's scoring time + its share of its window's prefetch wall (its entries x the window's
     measured prefetch wall per entry). N = 1 records entries per unit (new instrumentation, named in the build).
   - **The bound** simulates `runScopeQueue`'s real greedy in MANIFEST order (not longest-first). Lane 0 starts at 0; lane
     k ≥ 1 starts at the barrier time plus its measured per-lane start cost.
   - The pass bar stays 1.2 x that simulated wall, written into the receipt before the N = 3 run.
3. **Mutant codes are sequence numbers.**
   - `--lines` renumbers from M0001 (`assignMutantIds` numbers only the surviving specs), and codes shift between heads.
   - **r4 rule:** each slice mutant is pinned by (file, procedure, operator, `ast_hash`). The build-time dry-run listing must
     show each pinned mutant before the proof run; one missing means the slice is re-planned.
4. **Doubled counts and off-by-one window labels.**
   - Per run, the four unkept-text procedures held 5 mutants, not 10: `CreateDocumentsForRecord` 1 (placeholder Pdf),
     `CreateReportUsingReportSelection` 2, `CreateReports` 1, `GetReportParameters` 1.
   - Runs 10-13 are windows t9-t12, not t10-t13.
   - **r4 rule:** the pre-commitment re-derives every count from run 13 (t12, head 4763e43d, PR-93's keep-list) once it
     finishes, including the drift-codeunit count for the new slice.
5. **Batch 2 and later raced lanes ≥ 1 against lane 0's per-batch setup.** **r4 rule:**
   - the batch setup (`union`, `coveringOf`, `prefetchBatch`, from `batchPlans`) is done ONCE per batch, in one owner call in
     `runMutantsParallel`, before window 0's `runScopeQueue`;
   - the union-warmed mark for lanes ≥ 1 is re-applied at every launch, after every deploy (`resetLayoutState` clears it);
   - after the barrier has passed once, lanes launch at queue start;
   - `Lane.resetLayout()` resets the lane's `PrefetchState`.
6. **R960's trigger is a stat read for a decision.** **r4 rule:** a session-scoped `firstWarmupDone` flag replaces
   `stats.warmups === 1`, with a test that a lane ≥ 1 reaching `startDaemon` after a deploy never takes R960's path.
7. **Two launchers, one lane index.** **r4 rule:** under the split, R785's `pace` is off and the barrier callback is the only
   launcher of lanes ≥ 1 (one `nextLane` counter), with a test that no lane index is launched twice.
8. **A carry shown in a lazy warm-up is a session stop, not a drift re-run** (speculative). **r4 rule:** count, per lane, the
   warm-ups that FOLLOWED a request that left `keptRefusal` set, beside those that held one. A rise in
   `entries-warmup-disagrees` stops is then traceable.
- **Checked and holding (r3 review):**
  - the lanes ≥ 1 union-warmed mark: R786/R960 on lane 0, the echo, `no-baseline-rows`, R952;
  - the barrier callback: it cannot deadlock, and a failed lane 0 launches nothing;
  - concurrent `coveringOf` merges;
  - no carried verdicts in fresh proof runs;
  - the reservation `finally` rule (to be re-checked against PR-89's code);
  - three lanes get work if the slice is one window (6 units). If `cutWindows` makes two, the pre-commitment checks that
    the first window still feeds 3 lanes.
