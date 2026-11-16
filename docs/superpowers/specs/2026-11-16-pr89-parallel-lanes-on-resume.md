# PR-89 pre-commitment (reduced scope): the resume bugs behind R766's refusal, and a cgroup lane gate

Coord PR-89 (2026-11-16). Background: `/coord/handoff/PR-89/analysis.md` (read-only analysis), the scoped 4-lane DO measurement
`/coord/handoff/PR-89/m1/`, and a spec-adversary review of a wider draft. **Scope ruled by the orchestrator after the
measurement:** only the two bug fixes, which hold under any prefetch design. They are the prerequisite of preproc's parallel
prefetch (R1093, PR-96 GO, built next as PR-97). Lane-cost seeding and the parallel proof wait for PR-97.

## Measured, for context
On the scoped DO slice (864 mutants, `--workers 4`, fresh, master ff081a96 with PR-88), the run took 2,603 s:
- serve wall time: prefetch 1,669,550 ms (72%), live 632,199 ms (27%), warm-up 21,988 ms;
- **1 of 4 lanes started**, because "no lane 0 live unit finished with a measured warm-up to give a cost";
- 2 daemons, 0 refusal closes.

## Fix 1: the resume path under lanes (three fail-closed bugs)
R766 refuses `--workers > 1` with `--resume`/`--resume-run`, on the grounds that "a resumed session's lanes were never measured
on a re-run baseline". Behind that refusal sit three bugs. Each stops the run; none gives a wrong verdict.
1. **`splitBackend` drops resume calls.** `splitBackend` (parallel-queue.ts) does not forward `resumeRunsBaseline`,
   `recheckReusedBaseline`, `baselineState` or `isolatesTests` (review L2). So a reused snapshot (R1033, L5) is taken unchecked,
   the shared `baselineRows` stay empty, and the first daemon start throws `al-runner-v3-entries-no-baseline-rows`.
   **Fix:** forward all four to the owner backend. `resumeRunsBaseline` is a getter.
2. **The re-check throws once lanes exist.** `recheckReusedBaseline` begins with `soleLane()`, which throws then. **Fix:** it
   uses lane 0. It is an owner, baseline-phase method, and throws by name when any lane k > 0 holds a daemon. `deploy` closes
   every daemon first, so a correct call never trips that.
3. **A fresh N > 1 run stores no state.** It reads `baselineState` through the split backend, so it stores no backend state,
   and its later resume cannot reuse the snapshot. **Fix:** this comes with (1).

Then the resume branch of `parallelRefusal` and the `resumeSession` field are deleted. The other refusals stay: a non-serve
transport, an unretired Sleep-rule pin, and N > 8. No verdict path changes. Carried, known-survivor and stranded mutants are
removed before the queue, and the R197 ledger and the prefetch are the same at any N.

## Fix 2: the lane gate reads the CONTAINER, charges each launched lane its peak, and agrees with heavy-slot
**Today.** `affordableLanes` and `laneMayStart` read `os.freemem()`, which is the HOST's MemAvailable (about 98 GB here), not the
container's cgroup (32 GiB, shared). They size a lane at `LANE_RSS_BYTES`, 2.3 GiB, which is D1's daemon. A DO daemon peaks at
about 5.7 GiB. And each new lane is judged on the lanes' CURRENT size, while their daemons start lazily and grow later (review
HIGH 2).

**The new gate:**
- **Free memory** = `memory.max` - reserve (4 GiB, the lane gate's own, whatever R948's guard setting is) - (`memory.current`
  - `inactive_file`), read as `readCgroupMemory` does. With no readable cgroup (a host, not a container), today's `freemem`
  path is used, and that is said once.
- **Bytes per lane** = max(`LANE_RSS_BYTES`, `daemonMaxRssGb` while the recycle bound is on, the highest true peak any lane's
  daemon has shown so far, from PR-88's readings).
- **Charge per launched lane, at peak, not at current size.** Lane k may start only if (used - the resident RSS of this run's
  lane daemons) + (lanes launched + 1) x bytes per lane <= the bound. That subtracts our own daemons' current RSS from `used`,
  so they are not counted twice, and charges each of them, plus the new one, its peak. `affordableLanes` uses the same formula,
  and counts lane 0 as launched.
- **Agreement with heavy-slot** (review HIGH 2 item 4). `scripts/heavy-slot.sh` exports the job's declared peak as
  `LETHAL_HEAVY_DECLARED_PEAK_GB` to its child. When it is set, the lane gate also requires (lanes launched + 1) x bytes per
  lane + 4 GiB (LethAL's own process, R988's measured 3.9 GiB) <= the declared peak. So a run admitted at `--peak 8` cannot
  grow four DO-sized lanes past what it declared. When it is not set, the cgroup rule alone applies.
- **One notice** names the lanes started, the bytes per lane and where that figure came from, and which rule limited the count
  (cgroup, declared peak, or `--workers`).
- **R948's guard** stays as the backstop between groups. The spec states that it does not act mid-request.

## Predictions (pre-committed)
- **N = 1 is unchanged in every path:** `splitBackend` and the lane gate are used only when lanes are built. The v3 gate pins
  `workers: 1`, so **`itest:alrunner-v3` is unchanged**, every leg and pin.
- **Unit tests** (each red when its change is reverted):
  - `splitBackend` forwards the four hooks;
  - `recheckReusedBaseline` after `lanes(2)` runs on lane 0, and throws by name when lane 1 holds a daemon;
  - a `--workers 2` resume with a matching snapshot emits the re-checked `resume-baseline-reused`, and its per-mutant table
    equals a `--workers 1` resume on the same fake backend;
  - a fresh `--workers 2` run stores backend baseline state;
  - `parallelRefusal`: a resume is allowed, and the other three refusals are unchanged;
  - lane gate:
    - host freemem 90 GB but the cgroup at 26 of 32 GiB used starts no lane 1 (red when it reads freemem);
    - bytes per lane follows `daemonMaxRssGb` and the highest observed peak;
    - two launched lanes at 1 GiB resident are charged at their peak, not 1 GiB;
    - the declared-peak cap limits the count;
    - with no cgroup, the freemem fallback and its notice;
  - `heavy-slot.sh` exports `LETHAL_HEAVY_DECLARED_PEAK_GB` (its existing test harness).
- **Not in this PR:** seeding the lane cost from lane 0's first warm-up (the m1 run's "unmeasured" stall), and an N > 1 proof on
  real projects. Both belong with PR-97, so lanes are not built twice. Until then, a resumed `--workers N` run on DO is allowed,
  but may still start only lane 0, as the m1 run did.
