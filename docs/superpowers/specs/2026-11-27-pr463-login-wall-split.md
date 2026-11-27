# PR-463 (R1219): where the ~0.25 s of login wall per entry goes — pre-commitment (measure only)

lethal-code, 2026-11-27. Written before any run. Nothing is built.

## The question

- PR-439 attributed ≈ 43% of DO's mutants phase to `loginMs`, ≈ 240-265 ms of WALL per entry.
- PR-458 measured that a replayed login saves only ≈ 20 M user instructions, about 6 ms of CPU.
- So most of the login's wall is not user CPU. Is it sys CPU, other threads, waits on locks or I/O, or a sleep or
  poll?

## Setup

- **Build:** alrunner's `measure-tests-split` fork 75946a31f (gated privately in PR-439), the only build that reports
  `timings.testsParts.loginMs` per request (serve `--timings`).
- **Apps:** today's staging of DO (re-staged for this task), with today's selector. Replay OFF (`=0`), so every login is
  real.
- **LOGIN-ONLY entries:** one entry per test codeunit (110), each with `excludeTests` = ALL of that codeunit's methods
  and `runSelectedOnly: true`.
  - The session opens the company (the login) and runs no test, so the request's time is, up to request overhead, the
    login.
  - `testsParts.loginMs` and the run's row count (expected 0 rows per entry) confirm it.
- **A control:** the same 110 codeunits as NORMAL whole-codeunit entries, once, so `loginMs` per entry can be compared
  with PR-439's.

## Arms (each: 1 daemon, warm-up request first, then 5 timed requests of the 110 login-only entries)

- **Q (quiet):** one daemon on cores 12-16, nothing else of mine on them.
- **L (loaded, concurrent):** the same as Q, on cores 12-16, WHILE a second daemon on the SAME cores replays real
  traffic (PR-453's captured life 1747706, `=0`), so the five cores are shared.
- **S (syscalls):** the same as Q, with the daemon started under `strace -f -c` (a summary per syscall: count and
  time), then once more under `strace -f -T -e trace=futex,poll,ppoll,epoll_wait,nanosleep,clock_nanosleep,select,read,write`
  on ONE request, for per-call durations.
  - strace slows syscalls, so S's own wall is not used for the split, only its syscall shares.

## Measured per timed request (Q and L)

- **wall** (the request's round trip) and `testsParts.loginMs` (al-runner's own);
- **process CPU:** user and sys, summed over all the daemon's threads (`/proc/<pid>/stat` utime and stime deltas);
- **per thread:** the CPU of each thread (`/proc/<pid>/task/*/stat`), to see whether one thread or many work during the
  logins;
- **user instructions and cycles** (`perf stat -e instructions:u,cycles:u -p`, paranoid 2);
- **the per-entry figures:** each divided by the 110 entries.

## The split, and what each outcome means (pre-committed)

- **The parts:** U = user CPU and Y = sys CPU (both over all threads); OFF = loginMs − (U + Y) when the work is on one
  thread.
  - If several threads work at once, (U + Y) can exceed the login's wall share. Then the per-thread table decides
    which thread's time is on the login's path.
- **Readings:**
  - **CPU-bound:** U + Y ≥ 80% of loginMs. Then PR-458's 6 ms is wrong, or another thread does the work: it is
    named.
  - **Waiting:** OFF ≥ 50% of loginMs. S's syscall table names the wait: futex (locks or a thread pool), poll or epoll
    (a socket, for example the .NET sidecar), nanosleep (a sleep), read or write (I/O).
  - **Load:** if L's loginMs / Q's loginMs ≥ 1.5, the login waits for CPU (contention: it scales with load). If it is
    ≤ 1.15, it does not (a fixed wait or sleep).
  - Anything else is reported as measured, not rounded.
- **Sanity:**
  - login-only requests return 0 test rows (else the entry shape is wrong, and the run is VOID);
  - Q's control `loginMs` per entry lies within 2× of PR-439's 240-265 ms (else the build or scope differs, and that
    is stated).

## Deliverable

- The table per arm: loginMs / entry, U, Y, OFF, the threads, the syscall shares, and L / Q.
- The named destination of the wall, or "not found" with what was ruled out.
- No change to LethAL or al-runner. Any lever found is filed as an item for a later task.
