# R822 pre-commitment: retry a contended `timeout-is-cpu` before it costs a gate

Written 2026-11-05 by lethal-code, before any build. Basis: R789's rule and its addendum 1, which stand.
Evidence: `/coord/handoff/R-819/v3/gate.log` (A used 2106 ms of CPU in 3669 ms of wall time, on a contended core 13, at a
load average over 100).

## The rule

A retry happens in exactly one case: run A was stopped by the timeout, was late (over `BURN_WALL_FACTOR` x the limit), its
process CPU time was read, and that CPU time is under `BURN_CPU_SHARE` of its wall time. That is the existing "A late: core N
contended" reading.

In that case the fact picks the least busy core again and runs A again, at most `BURN_TRIES` = 3 runs of A in all.

Everything else is exactly today's path, with no retry:
- A killed by the process timeout: `diverged`.
- A with no row: `unmeasurable`.
- A's row is not a timeout row: `diverged`.
- A late with no CPU time read: `unmeasurable`.
- A on time, or late with a full share of the CPU: B runs, judged by today's rule.
- B is never retried.

If all three runs of A are contended, the fact reads `unmeasurable`, as today, and leg C reads `infra-fail`.

## Predicted outcomes

| Build and machine | Today | With R822 |
|---|---|---|
| CPU-time build, quiet | `matches` | `matches`, one run of A |
| CPU-time build, core contended once | `unmeasurable` | `matches`, B runs on the core A's last try used |
| CPU-time build, contended three times | `unmeasurable` | `unmeasurable` |
| Wall-time build, loaded or quiet | `diverged` | `diverged`: A stops at about 2 s, so it is never late and never retries |
| A build with no limit | `diverged` | `diverged`, one run of A |

A retry can only turn `unmeasurable` into a reading. It cannot turn `diverged` into anything: no `diverged` path retries. It
cannot produce a false `matches`: `matches` still needs a B that is late and over twice A, from the same rule on the same
final A.

`measured` keeps its `core N; A ...` start for the last try, and adds the earlier tries after it, so the reading shows
what happened. No gate figure moves, no pin changes, and every R789 test keeps its meaning. A test that drives a contended A
every time sees three runs of A.

## Gates

Red tests each way, the full v3 gate on the head, CI, one opus build review. Any difference from this table is a BLOCK until
explained in a dated addendum.

## Addendum 1, 2026-11-05: what the build review found

Written before any live gate of the R822 build. The rule does not change; two table lines were too simple.

- **"Wall-time build ... is never late" holds only for a limit with no slack.** A wall-time build with some slack on a busy
  core can be late with a low CPU share. That is the contended reading, so it retries. Once a try is free it stops on time
  and reads `diverged`. If all three tries are contended it reads `unmeasurable`. It never reads `matches`.
- **A correct build can reach a killed A on a later try.** A contended first A, then a later A that runs into the 60 s process
  timeout, reads `diverged`, as a killed first A always did. It needs a CPU share of about 3%. Retries give it more chances,
  and this rule accepts that: a killed A is the reading of a build with no limit, and it stays unretried.

The gate page's "about 20 s" is the quiet case. With retries the fact takes about a minute.
