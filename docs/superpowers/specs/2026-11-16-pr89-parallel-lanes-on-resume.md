# PR-98 pre-commitment (the reduced PR-89): the resume bugs behind R766's refusal, and a cgroup lane gate

Coord PR-98 (2026-11-16, lethal-preproc). It takes over PR-89 from lethal-code (draft at 8b127283).
- **Background:**
  - `/coord/handoff/PR-89/analysis.md` (read-only analysis);
  - the scoped 4-lane DO measurement `/coord/handoff/PR-89/m1/`;
  - the spec-adversary review of the reduced draft, `/coord/handoff/PR-89/adversary-reduced.md`. Its findings are answered
    below, each named.
- **Scope ruled by the orchestrator:** the two fixes below, which hold under any prefetch design. They are the prerequisite of
  the parallel prefetch (R1093, PR-97's build).
- **Not in scope:** the lane-cost seeding and the lane proof wait for PR-97.

## Measured, for context
On the scoped DO slice (864 mutants, `--workers 4`, fresh, master ff081a96 with PR-88), the run took 2,603 s:
- serve wall time: prefetch 1,669,550 ms (72%), live 632,199 ms (27%), warm-up 21,988 ms;
- **1 of 4 lanes started**, because "no lane 0 live unit finished with a measured warm-up to give a cost";
- 2 daemons, 0 refusal closes;
- its 53 `serve-request-sized` readings top out at 1.86 GiB.

## Fix 1: the resume path under lanes (three fail-closed bugs). The review found it sound as written.
R766 refuses `--workers > 1` with `--resume`/`--resume-run`. Behind that refusal sit three bugs. Each stops the run; none gives
a wrong verdict.
1. **`splitBackend` (parallel-queue.ts) drops four hooks:** `resumeRunsBaseline`, `recheckReusedBaseline`, `baselineState` and
   `isolatesTests`. So a reused snapshot (R1033, L5) is taken unchecked, the owner's `baselineRows` stay empty, and the first
   daemon start throws `al-runner-v3-entries-no-baseline-rows`.
   **Fix:** forward all four to the owner. The two getters are always present; the two methods only when the owner has them.
2. **The re-check throws once lanes exist.** `recheckReusedBaseline` begins with `soleLane()`, which throws then.
   **Fix:** it runs on lane 0, and throws by name when a lane k > 0 holds a daemon. That is unreachable on a correct path,
   because `deploy` closes every daemon first.
3. **A fresh N > 1 run stores no backend baseline state.** It comes with (1).

Then the resume branch of `parallelRefusal` and its `resumeSession` field are deleted. The other refusals stay: a non-serve
transport, an unretired Sleep-rule pin, and N > 8 (which is in the orchestrator, review L4).

## Fix 2: the lane gate reads the CONTAINER and charges every resident lane at its full peak
**Today.**
- `affordableLanes` and `laneMayStart` read `os.freemem()`, which is the HOST's MemAvailable (~98 GB), not the container's
  cgroup (32 GiB, shared).
- They size a lane at `LANE_RSS_BYTES` (2.3 GiB, D1's daemon).

**The new gate.** One function decides; `laneMayStart(k)` and `affordableLanes(n)` both call it.
- **Per-daemon peak** (review M1): the highest PEAK READING any of this session's serve daemons has given so far (PR-88's
  reading in `requestOne`). A sampled reading is a lower bound, and is named as such.
  - **With no reading yet, no lane above 0 starts.** The notice says "unmeasured"; there is no fall-back to 2.3 GiB.
  - A recycle bound (`daemonMaxRssGb`) is not a peak and is not used for this.
- **Bytes per lane** (review H1):
  - the number of distinct request modes in this batch's calls (`modeKey(modeOfCall(...))` over the union: `test`,
    `codeunit`, `+selected`) x the per-daemon peak;
  - plus `MEMORY_CALL_ESTIMATE_BYTES` (3 GiB) when the batch has one-shot codeunits.
- **Lanes charged** (review H2): every lane that holds a daemon now, plus the lane asking to start:
  max(k, lanes holding a daemon) + 1.
- **Our own processes' resident memory** (review M4): the sum of `RssAnon` of every lane's daemons, read per pid, with an
  unreadable pid counted as 0. `VmRSS` would count shared file pages that the cgroup charges once.
  - The .NET sidecar child is in neither the subtraction nor the charge.
  - It is short-lived per pass (#8204), so its current size is in `used` and nowhere else. Stated as a limit.
- **The cgroup rule:** (`used` - our daemons' `RssAnon`) + lanes charged x bytes per lane + max(0, 4 GiB - LethAL's own RSS)
  <= `memory.max` - 4 GiB reserve.
  - `used` = `memory.current` - `inactive_file`, as `readCgroupMemory` reads it.
  - The LethAL term is review L1: LethAL's own process at R988's measured 3.9 GiB, charged up to 4 GiB.
- **The declared-peak rule** (review M2, M3):
  - `scripts/heavy-slot.sh` exports `LETHAL_HEAVY_CLASS_FILE`, the path of its slot's class file (`<class> <pid> <peak>`), to
    the job. LethAL re-reads it at each gate decision, so a peak PR-73 lowers mid-run is followed.
  - The rule: lanes charged x bytes per lane + 4 GiB (LethAL) <= the declared peak.
  - **No class file in a cgroup with a limit:** heavy-slot's default for the `other` class (8 GiB) is used as the declared
    peak, and the notice names that. In practice that is lane 0 only (review L5: a DO lane is ~6 GiB, so `--workers N` on DO
    needs an explicit `--peak`).
  - **Not covered** (stated): two `lethal run`s inside one heavy-slot job each see the whole declared peak.
- **No readable cgroup, or `memory.max` = `max`** (review L2): today's `freemem` path, with the NEW bytes per lane (and the
  unmeasured rule), named once.
- **One notice:** `al-runner-v3-lanes-started` is reused, so no new warning code (review M5). It names the lanes started, the
  bytes per lane and its parts (modes x peak, plus one-shot), the reading's source, and which rule limited the count:
  `unmeasured`, `cgroup`, `declared peak` or `--workers`.
- **R948's guard** stays as the backstop between groups. It does not act mid-request (stated).

## Itest knob (review M5)
`LETHAL_ITEST_V3_WORKERS > 1` today checks only warning codes. It now also asserts that the lanes-started notice reports as many
lanes as asked, or the leg fails by name. Unset (the gate), nothing changes.

## Predictions (pre-committed)
- **N = 1 is unchanged in every path.** `splitBackend` and the lane gate are used only when lanes are built; the v3 gate pins
  `workers: 1`. So **`itest:alrunner-v3` is unchanged, every leg and pin.**
- **Unit tests,** each red when its change is reverted:
  - `splitBackend` forwards the four hooks (and leaves the optional two absent when the owner lacks them);
  - `recheckReusedBaseline` after `lanes(2)` runs on lane 0, and throws by name when lane 1 holds a daemon;
  - a `--workers 2` resume with a matching snapshot emits the re-checked `resume-baseline-reused`;
  - a fresh `--workers 2` run stores backend baseline state;
  - `parallelRefusal`: a resume is allowed, and the transport and Sleep refusals are unchanged;
  - **lane gate:**
    - host freemem 90 GB but the cgroup at 26 of 32 GiB used starts no lane 1 (red when it reads freemem);
    - **no peak reading yet** starts no lane 1 and says "unmeasured" (M1);
    - **lane 1 holding two daemons** (`test` and `codeunit`) is charged two peaks (H1);
    - **window 2 with lanes 2-3 still resident:** lane 1 asked is charged 4 lanes (H2);
    - `RssAnon`, not `VmRSS`, is subtracted, and an unreadable pid counts 0 (M4);
    - the declared peak is re-read live: a lowered class file stops the next lane (M2);
    - no class file in a limited cgroup uses 8 GiB (M3);
    - no cgroup, or an unlimited one, uses the freemem fallback with the new bytes per lane (L2);
    - the cgroup rule charges LethAL's own 4 GiB less its RSS (L1);
  - `heavy-slot.sh` exports `LETHAL_HEAVY_CLASS_FILE` (the job sees it);
  - the itest knob fails by name when fewer lanes started than asked.
- **Not in this PR:** the lane-cost seeding (m1's "unmeasured" stall in R785's pacing) and an N > 1 proof on real projects.
  Both belong with PR-97.
  - Until then a resumed `--workers N` run is allowed, and may still start only lane 0.
  - With this gate's "no reading yet, no lane" rule, a fresh session starts no lane above 0 until its first serve request
    has been read.
