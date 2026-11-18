# PR-140 (R1120): a lane hold closes the idle daemons it charges, so the gate re-admits lanes it can afford

Coord PR-140 (lethal-code, 2026-11-18). R1120: PR-98's lane gate held lane 1 in DO windows x1-x3 (`--workers 3`, declared
`--peak 15 baseapp`), and lanes 1 and 2 then sat idle for the rest of each window (x3: 85% of its 12,448 s mutant phase).
Revision 2, after the spec-adversary (Opus): revision 1 let a resident lane skip the declared-peak check. That defeats
heavy-slot's admission of other jobs, and the model it skipped is measured honest (below).

## What the events show (`/coord/handoff/R-984/x{1,2,3}.run.events.ndjson`, `x3.procs.tsv`)
- **Every hold has the same shape.** Lane 1 asks at a window start and is refused under rule `declared peak`, with "3 lanes
  charged": lanes 0 and 1, plus lane 2.
  - Lane 2's daemon is still resident from the previous window: `lanesCharged` counts every lane that holds a daemon.
  - Lanes 1 and 2 made requests before the hold (`serve-request-sized` events: x1 422 and 421, x2 29 and 28, x3 198 and 116;
    `serve-request-timed` counts more), none after it, and no
    `serve-daemon-closed` came after their last request.
  - `tryLaunch` returns on the refusal, so lane 2 is never asked.
- **The daemons stay alive, idle, for the rest of the window.** In x3 their RSS fell from about 2.5 GiB to about 0.15 GiB after
  23:50 (swapped out, `memory.swap.max` 32 GiB). They do no work and still hold memory or swap.
- **Why it never lifts:** the charge's inputs never fall. The idle resident lane stays charged, and the peak (the session's
  highest reading) only rises. The queue asks again after every measured request (`gateChanged`) and gets the same answer.
- **The model is honest, not an over-charge.** R1120 calls 3 x 4.07 + 4.0 = 16.2 GiB an over-charge against the measured tree
  peak of 12.59 GiB. Per part, in x3:
  - LethAL's own process reached 3.86 GiB (x1: 3.91);
  - single daemons reached 4.06 GiB.

  The parts' worst case is about 16 GiB. The 12.59 GiB tree peak came in under it only because the parts did not peak at the same
  moment. So a 15 GiB declaration is too low for 3 lanes of this DO work, and x4's 18 GiB is the honest figure. The model stays
  (design principle 21: no crash first, then low memory, then speed).

## The change
1. **On a refusal of lane `k`, close the daemons that the charge counts but that do no work.**
   - Which: every lane `j` other than 0 that holds a daemon, is not active (not launched in the running queue, or already ended),
     and is not one of lanes 0..k.
   - How: `closeLane(j, "lane-idle")`. When the closes finish, `gateChanged()` fires, and the queue asks for lane `k` again.
   - Why it is safe: it only takes memory away.
   - In x3's numbers: lane 2's idle daemon closes; lane 1 is then charged {0, 1}: 2 x 4.07 + 4.0 = 12.1 GiB, which fits 15, and
     starts. Lane 2 is charged {0, 1, 2} = 16.2 GiB and is refused. Lanes 0 and 1 work, where today only lane 0 did.
2. **The backend tracks the active lanes.** `launchLane(k)` marks lane `k` active, `releaseLane(k)` (the queue's `onEnd`) ends
   that, and lane 0 is always active. The rule in 1 never closes an active lane's daemon, so a lane in the middle of a unit is
   never touched.
3. **A new close reason, `lane-idle`.**
   - It is not routine: it emits `serve-daemon-closed` with phase `idle`, so the closes can be counted.
   - The next warm-up of such a lane reports cause `after-lane-idle`.
4. **The rules the code depends on** (delta review 5, 6):
   - **Closes happen only while a split queue runs** (a gate watcher is registered), since only that queue keeps the active set.
     The paced and plain paths never close; they are not reachable for v3, which always has `prepareBatch`.
   - **A lane being closed stays charged until its process is gone** (`closingLanes`), and it is not admitted itself until then.
     Without that, another trigger could admit lane k while the old process is still alive, for up to about 5 s.
   - **`gateChanged` fires once per close started, and never on a refusal that closes nothing.** Under the declared-peak rule the
     charge never falls within a batch, so a lane above the hold is closed at most once per batch: no loop, and no repeated
     warm-ups. Under the cgroup rule other jobs' memory can move, so a lane can be closed and warmed again, at most about once
     per window. That costs time, not correctness.
   - **Close failures are swallowed:** `closeDaemon` has already cleared the lane's daemon map, so there is nothing to retry, and
     only memory is at stake.
5. **The hold notice tells the truth.** "this session stays at the lanes already running" is false. It now says that the lane is
   asked again after each measured request, and names the idle lanes closed.
   - It is still printed once per session.

**Unchanged:** the charge (`lanesCharged`, `decideLanes`), both of its rules, `affordableLanes`, the order lanes start in, and R948's
guard.

## Why not the alternatives
- **Skipping the declared peak for resident lanes (revision 1):**
  - it lets a job grow past its heavy-slot ledger figure as the peak rises later in a session;
  - an idle daemon's memory was swapped out, so it is not in `memory.current`;
  - a whole-tree check was replaced by a one-lane check that ignores lanes admitted in the same pass.
- **Starting lanes out of order:** after the closes, the H2 shape (lane 1 without a daemon, lane 2 idle and resident) re-admits
  lane 1, since lane 2's daemon is closed. No new launch order is needed.
- **Lowering the charge:** see "the model is honest". Declaring the measured worst case (18 GiB for this DO work) is the user's
  lever. R1120's text should say so.

## Tests (red both ways)
1. **The idle lane is closed, then the gate admits** (lanes rig, 3 lanes):
   - setup: lane 2 resident and not active, lane 1 not resident, declared 15, peak 4.07 GiB;
   - `laneMayStart(1)` is false, lane 2's daemon is closed with reason `lane-idle`, and the gate watcher fires once;
   - then `laneMayStart(1)` is true.
   - Red if the close step is removed.
2. **An active lane is never closed:** the same, with lane 2 active (`launchLane(2)` and no `releaseLane`). Lane 2's daemon stays.
   - Red if the rule ignores the active set.
3. **Lanes 0..k are never closed:** lane 1 asks while lane 1 itself is resident and idle. Its own daemon stays.
4. **The existing gate tests pass unchanged:** H1, H2, build review #2, M4 and L1. The H2 test (lane 1 refused while lanes 2 and 3
   are resident) still reads false at the first ask.
6. **Nothing idle, no event:** a refusal with no idle lane above it closes nothing and fires no gate watcher. A lane in
   `closingLanes` is refused until its close finishes.
   - Red if `gateChanged` fires on every refusal (the loop guard).
5. **In the queue** (`parallel-queue` with the split): a refusal followed by a watcher event launches lane 1 on the next
   `tryLaunch`. This exists today; a test pins it.

## The pre-committed DO measurement (after review, before submit)
- **Run:** one DO window, resumed on a COPY of R-984's `dos4.sqlite`, never the store itself.
  - The copy is made only after window x4's process has exited, with its `-wal` and `-shm` files (or by sqlite `.backup`).
  - `--workers 3`, `--peak 15 baseapp` (x1-x3's declaration), `--time-budget 7200`, and R-984's watchdog (20 GiB).
  - The same config (`v3.do-serve-xb.json`) and the same al-runner build (edge-4ebfe7913).
  - x3's hold came about 40 minutes into its mutant phase, hence a budget of 2 h.
- **P1:** at least one `serve-daemon-closed` event with reason `lane-idle`. After the first one, lane 1 has `serve-request-timed`
  events.
  - Scored on the close events, since the hold notice prints once per session and a later hold is not in the events.
  - No `lane-idle` close in the run means no idle-lane hold occurred: P1-P2 are then inconclusive, and that is said.
- **P2:** from the first `lane-idle` close to `phase-left` (or `time-budget-reached`), in every 600 s slice in which lane 0 has
  `serve-request-timed` events, lane 1 has some too. Today's gate leaves lane 1 with none after its hold.
- **P3:** the tree's peak (the watchdog's `procs.tsv`) stays at or under the declared 15 GiB, with no watchdog STOP.
- **P4:** a resume carries most verdicts forward, so P4 compares only covered mutants that ran live both here and in x1-x3, per
  (file, line, operator). Under 20 such mutants is inconclusive, not "unchanged". Any verdict difference is investigated per
  mutant.
- **Out of scope for this run:** the run is single-mode DO, so it does not show a peak that rises after lanes are admitted. The
  charge is unchanged, so this needs no test here.

### Amendment 1 (2026-11-18, before any mutant of the PR-140 run): a fresh store, not a resume
- **Why:** window x4 ended at 04:44Z with rc 0. It completed DO's campaign in `dos4.sqlite`, so a resume of a copy has no mutant
  left to run, and P1-P2 could only be inconclusive.
  - The resumed run started at 04:44:36Z. It is left to end on its own, since it scores nothing; it is not evidence.
- **The run instead:** a FRESH store (`/coord/handoff/PR-140/dow2/fresh.sqlite`), no `--resume`, `--time-budget 9000`. Otherwise as
  above (`--workers 3`, `--peak 15 baseapp`, the same config and build, the watchdog).
  - This is window x1's shape. x1 ran fresh at the same declaration and held lane 1 ("3 lanes charged", 15.3 GiB).
  - A fresh baseline takes about 25-40 minutes, hence the larger budget.
- **P1-P3 are unchanged.**
- **P4 becomes:** the verdicts of covered mutants scored both here and in x1 (`/coord/handoff/R-984/x1.run.report.json`) are compared
  per (file, line, operator). Under 20 shared is inconclusive. Any difference is investigated per mutant.
