# PR-60 pre-commitment: the al-runner update's memory gate uses the heavy-slot guard's inputs (R992's small-job allowance)

Status: pre-commitment (coord PR-60, lethal-code, 2026-11-16), before the build. Evidence: the daily update at 2026-11-16 07:47Z
was SKIPPED with "used 8.2, held slots' peaks 28.0 (3), this job's peak 2.0, reserve 4.0 -> REFUSED".

## The cause

`scripts/al-runner-v3-update.ts` `gateMemory` builds its own inputs for `memoryVerdict`:
- it passes no `smallHeld`, so R992's allowance never applies (used + peak + reserve fits, and fewer than 2 small jobs are held);
- it counts held slots only, not the unslotted heavy processes that `heavy-slot-guard.ts` adds.
`heavy-slot-guard.ts` computes both, and on a small admission it also marks the slot and writes the small-admits ledger line.

Separately, `freeGb` reads `free -g`, which is the HOST, not the container. It decides only on the path where the cgroup names no
limit, and that path never runs inside the container.

## The change

- **One helper**, exported from the guard's module and used by both callers. It reads the held slots, their peaks (unclassed at
  the largest default), the unslotted heavy processes and `smallHeld` (undefined, failing closed, when a held class cannot be
  read), and returns what `memoryVerdict` needs. `gateMemory` calls it, then calls `memoryVerdict` exactly as the guard does.
  On an admission by the allowance, it writes the same small-admits ledger line. The update holds no slot of its own, so it marks
  none; the line names the update instead.
- **`freeGb`:** the decision reads the cgroup (`memory.max - memory.current`) where a limit exists. The `free -g` fallback stays
  only for a host with no cgroup limit, and is named so in the log.

## Predictions
1. Unit tests, red both ways:
   - the gate admits under the allowance when used + peak + reserve fits and fewer than 2 small jobs are held;
   - it refuses when 2 small jobs are held;
   - it refuses when a held slot's class is unreadable (fail closed);
   - it counts an unslotted heavy process as the guard does;
   - `freeGb` is not consulted where the cgroup names a limit.
2. No other caller's verdict changes: `heavy-slot-guard.ts`'s tests are unchanged and green.
3. The next daily update, with 8.2 GiB used and the same held slots, is admitted by the allowance and logs the small-admits line.
