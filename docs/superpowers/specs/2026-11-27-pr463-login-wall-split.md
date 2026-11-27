# PR-463 (R1219): where the ~0.25 s of login wall per entry goes — pre-commitment r3 (measure only)

lethal-code, 2026-11-27. Written before any run. Nothing is built.
- **r1** was 970a40036.
- **r2** (3e11e166c) answered its spec-adversary: B1-B3, S1-S5 and the NITs.
- **r3** answers the delta review. Where r3 and the text below disagree, **r3's section "r3 changes" wins**.

## r3 changes (they override r2 below)

1. **One test thread (delta B1).** Every daemon runs with `AL_TEST_THREADS=1`. Then one thread runs every codeunit,
   so per-thread OFF means what it says, and `perf -t` sees every login.
   - **The denominator** for every reading is W = Σ codeunit wall = `entryStartMs + resetMs + bodiesMs` of the
     request (≈ `testsMs` at one thread), never `loginMs` alone.
   - OFF = W − on-CPU − run-queue wait, all three for the codeunit thread.
2. **Arm L at equal nice (delta B2).**
   - The daemon and the spinners all run at nice 10; no CFS weight gap.
   - N = 30 spinners on cores 12-16 → expected stretch ≈ (30 + 1) / 5 ≈ 6×, PR-439's level (load1 89 on 12 cores ≈
     7×).
   - **L is VALID** only if the codeunit thread's run-queue share of W lies between 60% and 95% (a stretch of about
     2.5× to 20×). Outside that band in either direction, L is VOID.
3. **VOID guards (delta S3, S4).** A request is VOID when any of these holds:
   - exit 6 (nothing selected);
   - any row is not PASS (each entry's test is the cheapest one that PASSES in the baseline);
   - the change in `timings.loginStarts` differs from the number of entries;
   - `loginReplays` grows (replay was not off);
   - the rows are not exactly the chosen tests, one each.
4. **Readings on W (delta S5, S6).**
   - **Contention:** all three hold:
     - L's run-queue wait ≥ 50% of (W_L − W_Q);
     - Q's OFF < 10% of W_Q;
     - `loginMs / W` is within ±25% between L and Q (an even stretch).
   - **Waiting:** Q's OFF ≥ 30% of W_Q.
   - **Mixed:** Q's OFF is 10-30% of W_Q. The login partly blocks; perf and the thread states name where.
   - **L VOID with low Q OFF:** contention is NOT tested. Q gives the login's CPU floor only.
5. **Proof of nice.** The nice LethAL's real daemons run at is read from `/proc/<pid>/stat` (field 19) of a live
   daemon, if one exists, and reported. r2's "as LethAL runs it" was unchecked.

## The question, restated (B2)

- PR-439 attributed ≈ 43% of DO's mutants phase to `testsParts.loginMs`, ≈ 240-265 ms of WALL per entry.
  - That was measured with 3 workers on cores 0-11 at a mean load1 of ≈ 89 (PR-439 findings): about 5-7× CPU
    oversubscription.
- PR-458's "≈ 6 ms per replayed login" was a NET figure, and it has been corrected. The GROSS saving per replay is
  ≈ 47-61 ms of CPU.
  - Replay also skips only `open_company`'s real login, while `before_login` (installs, facts, entering the codeunit)
    is inside `loginMs` either way.
- **So the leading hypothesis is CPU contention:** ≈ 50 ms of login CPU stretched to ≈ 250 ms of wall by the run queue.
  The rival hypothesis is waiting (locks, I/O, a sleep or poll, the .NET sidecar). This run decides between them.

## Setup

- **Build:** alrunner's `measure-tests-split` fork 75946a31f (gated in PR-439); serve `--timings` gives
  `testsParts.loginMs` (C2) per request.
- **App:** today's staging of DO, with today's selector.
- **Config:** pinned as PR-439's (`isolation: "test"`, the same packages, licence and company); replay OFF (`=0`).
- **(B1) NORMAL entries, not login-only.** A login-only entry (every test excluded) makes al-runner run nothing: no
  chosen codeunit, exit 6, no session.
  - Each timed request carries the 110 test codeunits as entries. Each entry selects ONE test, the cheapest (lowest
    baseline duration), with `runSelectedOnly: true`, so each entry is a login plus one short test.
  - **(S4)** Plus 3 SINGLE-entry requests, so a cost paid only by the first codeunit of a request shows apart.
- **VOID guards, per request (B1):**
  - an exit code other than 6;
  - `testsParts.codeunits` equal to the request's entries;
  - `loginMs` > 0;
  - rows ≥ the entries.
  - A VOID request is excluded and counted, never read as zero.

## What is measured per timed request (S1, S3)

- `loginMs`, `testsMs` and the other `testsParts` (al-runner's own).
- **Per thread** of the daemon (`/proc/<pid>/task/<tid>/schedstat`): on-CPU ns, run-queue wait ns and timeslices,
  sampled before and after the request.
  - **The codeunit thread** is the thread whose on-CPU time grows most over the request; it is named per request.
  - For it: OFF = testsMs − on-CPU − run-queue wait, which is the time it was blocked or asleep.
- **(S3) Child processes** (the .NET sidecar, if any): their utime, stime and schedstat, added and named. If there is no
  child, that is stated, and it rules the sidecar out.
- **(S5) Attribution, arm Q only:** `perf record -e cycles:u --call-graph dwarf -t <codeunit tid>` over 2 requests.
  - The share of samples under `open_company`, `before_login` and `installs_for`, against `loginMs`' share of
    `testsMs`.
  - **(N2)** `perf stat` instruction counts are only a cross-check.

## Arms

- **Q (quiet):** one daemon on cores 12-16, with nothing else of mine there. A warm-up request, then 5 timed requests
  and the 3 single-entry ones.
- **L (oversubscribed, S2):** the same daemon and requests on cores 12-16, while N CPU spinners (busy loops, own pids,
  stopped by pid) run pinned to the same cores.
  - N = 25: 5× the cores, PR-439's level. The spinners run at nice 0; the daemon is nice 10, as LethAL runs it.
  - L is VALID only if the codeunit thread's run-queue wait share is ≥ 30% of testsMs. Below that, L is VOID: it did
    not reach contention, and it is never read as "no scaling".
- **(B3) strace is dropped.** `strace -c` counts CPU, not blocked time, and `-f` mixes idle pool threads in.
  schedstat's OFF bounds the blocking directly.

## Readings (pre-committed)

- **Contention:** in L, run-queue wait accounts for ≥ 50% of the rise in `loginMs` over Q, AND Q's OFF is < 10% of
  Q's loginMs. Then the login's wall is CPU stretched by the run queue.
  - The lever is fewer runnable threads per core, or less login CPU. Not a replay.
- **Waiting:** Q's OFF ≥ 30% of Q's loginMs, in either arm. The login blocks or sleeps; perf and the thread states name
  where, and the sidecar is checked.
- **Q's loginMs** per entry is reported against PR-439's 240-265 ms. A Q value far BELOW it is read first as PR-439's
  load (load1 89), not as "the build differs" (B2's trap).
- **Anything else** is reported as measured.

## Deliverable

- Per arm: `loginMs` per entry, the codeunit thread's on-CPU, run-queue wait and OFF, the children's CPU, and the perf
  attribution (Q).
- The named destination of the wall.
- Any lever found is filed as an item; nothing is changed here.
