# PR-358 pre-commitment (v2): an opt-in box rule for v3 lanes, with a sixth-lane cap and a guard (R1181)

lethal-code, 2026-11-22. **The ruling:** q-20261122T221352-6e24d803 (kraken from the mantra; the owner may overrule).
- Build it OPT-IN; the default stays 5 lanes; a 7th lane is out.
- `memory.max` 32 GiB stays, and so does the 4 GiB margin.
- The guard re-checks the margin on every sample against the box limit (not the declared peak). While the margin is
  crossed, no new lane starts. When the total passes the limit, the newest lane retires after its current unit, never
  mid-request. The cgroup stop stays the backstop.
- It becomes the default only after a full-DO run under normal sharing shows the gain AND zero margin crossings, and that
  run reports both numbers.

**v2 folds in an Opus spec-adversary review of v1** (`/coord/handoff/PR-358/spec-review.md`):
- one blocking finding: lanes launched together were admitted on one stale reading;
- four serious ones: R948 stops the run before a retire can act; a retire frees no memory; a retire inside a packed batch
  leaves units unrun; restarting a retired lane;
- and five low ones.
- **Its verdict-safety finding stands:** units stay whole procedure scopes, and a lane that stops at `take()` leaves the
  untaken units in the shared index, so nothing runs twice and no verdict or `killingTest` can move.

## What was measured first (PR-352, `/coord/handoff/PR-352/findings.md`)
On PR-330's memory sampler (the container's non-reclaimable use plus each daemon's RSS, both full-DO arms):
- a 6th lane is admitted in 99.7-100% of samples;
- the worst total is 29.5 GiB of `memory.max` 32;
- the 28 GiB margin line was crossed once in 599 samples;
- a 7th lane reaches 32.8 GiB.

## 1. The switch
- **`LETHAL_V3_LANE_RULE=box`** turns it on. Unset or `declared` keeps today's rule; any other value is refused by name at
  startup.
- **Refused by name on the paced path that never resumes** (the non-split `evaluate`, which sets `nextLane = o.lanes`).
  `box` runs only on the split path.
- **Not in the config fingerprint:** a lane count is a cost knob.
- **Off (the default):** byte-identical behaviour, pinned by test 1.

## 2. The two lines
- **R948's bound** `B = memoryBoundBytes(memory.max, memoryHeadroomGb)`: 28 GiB with the default 4 GiB headroom. It is
  read, not assumed.
- **The box line** `L = B - one lane's charge`, about 24.7 GiB on DO. Both admission and the guard use `L`, so the guard
  acts while R948's gate is still open and cannot be pre-empted by R948's wait-then-stop.
- **One lane's charge** is today's per-lane bytes (`modes × the measured peak`, plus the one-shot estimate).

## 3. Admission (`laneMayStart`, under `box`)
- **The lane cap is `min(--workers, 6)`.**
- **The declared-peak rule is not applied.** A lane is admitted only while
  `used + (launched lanes that hold no resident daemon yet, plus this one) × one lane's charge + LethAL's term <= L`.
  - `used` is `readCgroupMemory`'s non-reclaimable figure (R1172). It holds the running lanes' real daemons, including
    lanes closing (`closingLanes`).
  - A launched lane whose daemon has not started is charged in full, so lanes launched in the same tick on one reading are
    charged together (review blocking 1).
  - LethAL's term is today's `max(0, 4 GiB - LethAL's RSS)`.
- **No cgroup limit,** or an unreadable `memory.max`: the rule cannot apply. It falls back to today's rule, with a notice
  naming why.

## 4. The guard
- **The sample:** `used` is read at every `take()` of every lane (after a whole packed batch) and at every lane
  evaluation. An unreadable sample counts as CROSSED.
- **Crossed:** `used > L`.
- **While crossed:**
  - **Hold:** no lane starts, and no retired lane restarts. The hold ends when a later sample is below `L` by at least one
    lane's charge.
  - **Retire:** at its next `take()`, the NEWEST running lane (the highest lane number, never lane 0) takes no unit.
    - Its last batch has finished, so no unit is taken and left unrun (review serious 4).
    - Its daemon is closed (`closeLane(lane, "lane-retired")`) and the lane is put in `closingLanes`, so the memory is
      really freed (review serious 3). Each retire counts toward `DaemonChurnGuard`'s 10 closes, which is harmless.
    - The units it would have taken stay in the shared index for the other lanes.
    - At most ONE lane retires per crossing: another retires only after a sample below `L` and a new crossing.
- **Restart:** after the hold ends and `closingLanes` has cleared, a retired lane restarts under its OLD lane number
  through `launchLane`. That re-applies `lazyLanes`: the new daemon proves each codeunit as it is used, and repeats no
  warm-up of the whole union.
- **R948's guard is unchanged** and stays the backstop.
- **The limit this leaves, stated:** memory can grow between two samples. LethAL spikes to 5.3 GiB, 1.3 GiB over its 4 GiB
  term, and a young daemon grows about 0.6 GiB. The box line sits one lane's charge (about 3.3 GiB) below R948's bound for
  that reason, so a lane admitted just under `L` still leaves about 3 GiB before R948's bound and 7 GiB before
  `memory.max`. A larger jump is R948's and the cgroup's to stop.

## 5. What the run reports (needed before any default flip)
Only when the rule is on: one stderr line at the session's end (no event, so no schema change):
- the box samples, and how many crossed (with the largest excess);
- the largest `used` seen at any sample;
- holds, retirements and restarts;
- lanes started (the max at once, and lane-seconds per lane count);
- R948's gate waits (polls over its bound) and any `memory-bound` stop;
- the seconds spent above the declared peak (heavy-slot's bookkeeping understates the run once the declared-peak rule is
  not applied).

**The default-flip run's claim is all of:** zero box crossings, zero R948 waits, and no `memory-bound` stop.

## 6. Tests (stateful fakes with call counters, never timing; red-checked both ways)
1. **Off:** with `--workers 8`, a declared peak that refuses the 6th lane, and memory high enough to cross `L`: the same
   lanes, the same `memoryReader` calls and the same notices as today, and no box line.
2. **Admission at the line:** a 6th lane starts just under `L` and not just over. A 7th never starts. Red if the cap or the
   line is dropped.
3. **Lanes launched on one reading:** five lanes asked for on one sample, with high `used`, start only as many as the room
   allows. Red if lanes without a daemon are not charged (review blocking 1).
4. **The SUM charge:** with low real use, a 6th lane is admitted where today's rule refuses.
5. **Every-sample re-check:** a crossing after admission is seen at the next `take()` of any lane.
6. **Hold, then resume:** while crossed nothing starts; after the drop below `L` by one charge, a held lane may start.
7. **Retire the newest, at `take()` only, with its daemon closed:**
   - lane 0 never retires;
   - a packed batch is finished first;
   - every unit runs exactly once;
   - `closeLane` is called with `lane-retired`.
8. **Never mid-request:** a crossing seen at a MUTANT boundary inside a unit, while R948's gate is live, retires nothing
   until that unit's `take()`. Red if the retire check moves into the mutant gate.
9. **One retirement per crossing;** and a restart under the old lane number, after `closingLanes` clears.
10. **An unreadable sample counts as crossed.**
11. **No cgroup limit:** today's rule, with the notice.
12. **A bad `LETHAL_V3_LANE_RULE` value** is refused, and so is `box` on the non-split paced path.

## 7. Gates
- **The full v3 gate: 0 moves.** No gate sets the variable; test 1 pins the off path.
- **The BC legs** `selectLegs` names, if any: no BC path changes.
- **No live run of the opt-in in this PR.** The full-DO run that may justify a default is a separate, pre-committed task:
  - the box rule on, under normal sharing;
  - verdicts and `killingTest` equal per mutant against a run with it off;
  - the gain, and section 5's figures, reported.
