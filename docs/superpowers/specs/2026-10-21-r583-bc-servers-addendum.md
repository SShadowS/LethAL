# R-583 pre-commitment addendum: the BC gates run on bc1, bc2 and bc3, not Cronus28

Committed by lethal-code on 2026-10-21, before any live run named here. This amends
`2026-10-20-r583-runtime-17-precommitment.md` ONLY in where its BC gates run. Its predictions, its figures and its
BLOCK rule are unchanged.

## Why
Owner ruling, 2026-10-21: Cronus28 is parked. It has been unreachable from the kraken container since about 14:16Z,
at its new address 172.23.18.89. Every BC gate now runs on the BC-on-Linux servers `bc1`, `bc2` and `bc3` (R589):
BC 28.4, W1, company `CRONUS International Ltd.`, set up by `scripts/bc-linux-setup.ts`.

## Phase 1: each gate first reproduces its frozen baseline on a bc server, under MASTER's code
This runs master's code (1eb4dcf6 or later, which includes R589) and master's fixtures (runtime 13, as published by
the setup script).
- **Prediction.** Each gate gives the same verdict per mutant as its committed baseline or frozen expectation, as
  listed in CLAUDE.md and in the original pre-commitment's table. That includes the killing test and the pinned
  extras where the gate records them.
- **Already proven:** `itest:bcdev`, on all three servers (R589).
- **Not yet proven on W1:** `itest:tables`, `itest:chunked`, `itest:hang`, `itest:harden`, `itest:agreement`,
  `itest:bcdev-wrapped`, `itest:bcdev-names`, `itest:verify`, `itest:verify-scale`, `itest:stale-publish`,
  `itest:testapp` and `itest:lease`.
- **`itest:tables`** is held to `tables.baseline.json` per mutant, and to exactly ONE expected baseline failure,
  BY NAME: `Data Tests.PageActionComputesNonZero`, the TestPage refusal. Its company is now W1 `CRONUS
  International Ltd.`, not DK.
- **A difference is a BLOCK for that gate only.** It is recorded per mutant, with the server, and reported. It is
  never re-recorded. A gate that is blocked in phase 1 is not run in phase 2. A W1 server cannot measure a
  verdict that depends on localization, so such a gate stays unverified.

## Phase 2: R-583 (runtime 17) on the bc servers
- After phase 1, the runtime-17 rebuilds of every fixture pair from `lethal/r583` are published to the bc servers
  over the dev endpoint, each target before its tests.
- LethAL Control 1.0.0.22 is already published there (R589).
- Every gate that passed phase 1 then runs under R-583's code. It is held to the SAME per-mutant figures as in
  phase 1.
- The BLOCK rule is the original pre-commitment's.

## Placement
- One gate per server lease. The gates are spread across `bc1`, `bc2` and `bc3`.
- The container-wide limit of 2 heavy jobs applies, and a running BC gate counts as one. So at most two gates run
  at once, and fewer while another lane's heavy job runs.
- Each gate log's first line (`[itest target]`) names its server.
- The logs are in `/coord/handoff/R-583/gates/`, and the results are recorded per gate and server in
  `/coord/handoff/R-583/gates.md`.

## R589's Cronus28 rows
R589's `itest:bcdev` and `itest:tables` rows, recorded as NOT RUN on Cronus28, are covered by phase 1 of this
addendum, which runs master's code with R589 merged. Each is recorded as run on the bc server named in its log.

## Unchanged
- `itest:alrunner` needs no BC. It PASSED on 672daf45 with f06ee78c.
- `itest:envtool` stays NOT RUN.
