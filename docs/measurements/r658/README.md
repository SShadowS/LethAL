# R658: does LethAL Control's stop end a BASELINE test on BC?

The probe ran on bc3 on 2026-10-22. Pre-commitment: `2026-10-22-r658-bc-baseline-stop-probe-precommitment.md`
(master 7a0d4f96). Probe: `scripts/r658-bc-probe/` at 586c7835.

- **Driver and logs:** the driver is `scripts/r658-bc-probe/drive.ts`. Its readings are `bc3-probe.json`, and its log
  is `/coord/handoff/R-658/probe/drive.log`.
- **Server:** measured on BC 28.4.53241.56646 on bc3, with LethAL Control 1.0.0.23, under lane bugs' coord lease
  from 18:41:23Z.
- **The apps:** 92940-92959, built 2026-10-22 against bc3's System symbols. The sha256 of both builds equals the
  pre-commitment's.

## Results

| Case | Test | Stop | BC's answer on the held request | Progress at the settle read (+70 s) | Release, then next acquire | Row |
|---|---|---|---|---|---|---|
| C | `Sleep100` | none | 200, pass, 207 ms | — | released, granted | control |
| L | 60 s busy loop | `stopped: true` at +20 000 ms | AL-stop 408 at +20 075 ms | `running` / 0 | released, granted | **1** |
| S | `Sleep(60000)` | `stopped: true` at +19 999 ms | AL-stop 408 at +20 086 ms | `running` / 0 | released, granted | **1** |
| D | `Sleep(30000)`, 10 s budget, no stop | — | client abort at 10 s (`deadline-exceeded`, `in-flight-unknown`) | `run`, not completed, `running` / 0 at +45 s and +60 s | — | **D2**, so the STOP rule fired |

What the rows say:
- **L and S (row 1).** `StopSession` ends a baseline test session about 75 ms after the stop, whether it is busy in a
  loop or inside `Sleep`. The session never writes again, and the lease releases cleanly. The prediction for S
  (2/3a, "a stop lands at the next database call") was wrong: a Sleep is interrupted.
- **D (row D2).** This is the path every baseline takes today. Once LethAL gave up at 10 s, the op was still marked
  `run` at +60 s. The test's Sleep had ended at 30 s, yet the method never completed and phase 3 never ran.
  - So the session most likely died at the client's abort. A hang is not ruled out.
  - Either way, the marker is stranded.
  - Our cleanup `StopHungRun` at +60 s answered `stopped: true` (session 42780) and tombstoned it. That fired the
    pre-committed STOP rule.
  - A read-only status read at 18:46:21Z (`/coord/handoff/R-658/probe/status-after-stop.json`) shows the op
    tombstoned, with progress still `running` / 0.
- **R-649 read again.** R-649's "still running 20 minutes later" on bc2 is this D2 shape: a stranded marker, most
  likely not a session that ran on.

## After the STOP

- **Kept by rule:** the bc3 coord lease (no release, no reset, no unpublish). bc3 was taken out of use, pending the
  owner's restart and a clean `bc-linux-setup.ts --server bc3`.
- **Still published:** the probe apps. They are removed afterwards with `--remove-only`.

## What stays on the server

- One row in LethAL Control's artifact registry, keyed by target `d1d2d26c-…`, which no API removes.
- LethAL Control's own bookkeeping (see the pre-commitment §10).
