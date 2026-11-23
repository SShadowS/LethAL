# PR-323 pre-commitment: memory "used" = memory.current − (file − shmem), in one shared function (R1172)

Coord PR-323 (lethal-code, 2026-11-22). **The ruling:** q-20261122T015708-0db73446 (kraken from the mantra; the owner may
overrule).

## Why (R1172, measured)
- **Today's rule** is `readCgroupMemory` (packages/runner/src/al-runner-v3-baseline-check.ts): `used = memory.current −
  inactive_file`. It counts the ACTIVE page cache as used.
- **Measured at 01:52Z on 2026-11-22,** with no slot held: current 8.55 GiB, anon 2.0, active_file 5.07, inactive_file 0.88,
  shmem 0.
- **The effect:** PR-303's queued A/B warm-up was refused 715 times.
  - 608 of them came while another job held 19.2-24 GiB of declared peaks. No `used` formula admits those.
  - **107 were refused on `used` alone** (used 7.3-8.8 GiB). **All 107 would have been admitted** at `used − 5.07 GiB`.
  - That is an ESTIMATE: the refusal lines do not log `file` or `shmem`, so it assumes the measured `active_file` held
    over the window.

## The rule
- **The formula:** `used = memory.current − max(0, file − shmem)`, where `file` and `shmem` come from `memory.stat`.
  - In cgroup v2, `file` includes `shmem` (tmpfs), which cannot be dropped without swap, so shmem stays counted as used.
  - All other file cache, active and inactive, is reclaimable and is not counted.
- **Fallbacks:**
  - if `memory.stat` cannot be read, or holds no `file` line, `used = memory.current`. That is conservative and never
    under-counts.
  - the result is never below 0.
- **The ONE function:** `readCgroupMemory`, as today, serves every reader:
  - heavy-slot admission (`scripts/heavy-slot-class.ts` `readContainerMemory`);
  - the guard (`scripts/heavy-slot-guard.ts`);
  - the v3 backend's lane memory guard (`al-runner-v3-backend.ts`, R948).
- **For run-script watchdogs:** a tiny CLI over it, `scripts/cgroup-used.ts`, prints `used` in bytes (and MiB with
  `--mib`). Run-script watchdogs, such as preproc's combined-do `run2.sh` and its copies (preproc's files), can call it in
  place of their own arithmetic. That is announced to preproc; I do not edit their scripts.

## Tests (red then green, by construction)
- **The deciding case:** a `memory.stat` with a large `active_file` AND a large `shmem` (for example current 20 GiB, file
  12 GiB of which shmem 4 GiB).
  - The new rule reads used 12 GiB: it subtracts the 8 GiB of reclaimable cache and keeps the shmem.
  - The old rule reads current − inactive_file.
  - The admission verdict for a job that fits only under the new rule flips from refuse to admit.
- **shmem is never treated as free:** a stat where everything in `file` is shmem means used = current.
- **No `file` line, or an unreadable stat,** means used = current.
- **The CLI** prints the function's value.
- **The existing r948 test** that pins `current − inactive_file` is updated to the new rule, and says why.

## Gates and merge
- VERIFY pinned to CPUs 12-21 at nice 19, while PR-303's A/B is timed.
- CI green.
- **The full v3 gate AFTER PR-303's series ends.** The v3 backend's lane memory guard reads this function, so v3 lane and
  memory decisions can change.
- **MERGE only after PR-303's series ends:** an admission change mid-series could let jobs in beside its arms.
- R1172 set to done on the branch.
