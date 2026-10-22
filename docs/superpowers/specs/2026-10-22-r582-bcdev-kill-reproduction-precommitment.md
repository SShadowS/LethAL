# R582 pre-commitment r3: "a kill must reproduce" on bcdev

Committed to master `[skip ci]` BEFORE the build and before any live run.
- Plan: `docs/superpowers/plans/2026-10-22-r582-bcdev-kill-must-reproduce.md` (r3, adopted at 0a66a677).
- Build head: not known when this is committed. Every gate log's first line records the `lethal/r582` commit it ran
  on, and every gate in §4 must run on ONE build head that carries the adopted plan's change and no other product
  change.
- LethAL Control 1.0.0.23 on bc1, bc2 and bc3, read by `lethal doctor` before each queue.

## Changes from r2
- **F2:** the chunked leg's re-run method lists are an asserted figure: each must EQUAL its replay list (§3).
- **F3:** the hang rerun clause is tightened (§2).
- **M-a:** §2 gains a catch-all and names the checks that §3 did not list.
- **M-b:** §5 now says that agreement gates one relative timing.
- **M-c:** envtool gets the marker check with its own row, and it stays UNMEASURED (§4).
- No predicted figure changed.

## 1. The rule this run tests

`BcDevMcpBackend.killsMustReproduce = true`. After a kill's unmutated confirm passes, the killing test is
run once more UNDER the mutant. This "re-run" is:
- a single `RunMutant` at `killPosition` 1;
- one `RunMutantMany` over the call's own prefix at k > 1;
- sent at the budget the first run was sent.

Only a second fail keeps a kill. For a timeout kill, only a second timeout keeps it.

## 2. What must hold on every gate

- **Verdicts and killing tests are UNCHANGED per mutant.** For every mutant, these equal its committed
  baseline or pre-committed table: verdict, `killingTest`, `errorClass`, `coverageFiltered` and
  `mutatedTextSha256`.
- **No baseline file is deleted or re-recorded.** Every gate runs without `LETHAL_ITEST_RECORD_BASELINE`.
- **Every `killed` and `timeout-killed` mutant carries `killReproduced: true`.**
- **No mutant has the cause `kill-not-reproduced`.** Every fixture kill is deterministic.
- **Each kill's killing test has exactly 2 mutated `test_results` rows in that run:** the first run and
  the re-run. `killReproductionFailures` checks this, with the run id.
- **`warmKills` and every `killPosition` are unchanged.**
- **Catch-all (M-a):** every other assertion each itest makes holds unchanged. A failing one is a BLOCK.
  This includes, among others:
  - tables: `declarativeSites`, `notInstrumented`, the assertion-screen twin pairs, and the GH-24 reach
    control;
  - `assertReachEvidence` on every gate that runs it;
  - `assertReachIdenticalAcrossLegs` on chunked;
  - hang's evidence checks on the first timeout row: BC's stop words, the duration band, and `op_kind`;
  - agreement's `publishes` = 1;
  - bcdev's protocol-invariant probes.

**Any verdict move, any killing-test move, any `kill-not-reproduced`, or any figure below that differs is
a BLOCK, reported as it is. Nothing is re-frozen to make a gate pass.**

**The one allowed rerun (F3).** It applies to `itest:hang` only, at most ONCE per queue, and only when ALL
of these hold in the failed attempt:
1. one mutant ended `stop-outcome-unconfirmed`;
2. every other mutant equals its prediction (verdict and `killingTest`);
3. the only failed assertions are the ones that mutant causes:
   - on ON: `counts.errors` 0, the `groupedCalls` and `manyDistinct` formulas, and that mutant's 2-row
     check;
   - on SINGLE: the zero-`stop-outcome-unconfirmed` assertion.

These are BLOCKs, not reruns:
- a second `stop-outcome-unconfirmed`;
- any other non-verdict cause on a re-run, such as a lost ack, `deadline-exceeded` or `stranded`.

Both logs are kept. The failed attempt counts as data for the tally of `stop-outcome-unconfirmed`
against `timeout-killed`.

## 3. Moved figures, with the arithmetic

How the counts move:
- `groupedCalls` counts `RunMutantMany` calls.
- A re-run at position 1 is a single `RunMutant`, so it adds nothing.
- A warm re-run is one `RunMutantMany`, so it adds 1 per warm kill.
- The count of distinct grouped session ids gains one per warm FAIL re-run.
- A warm TIMEOUT re-run is a stopped call and records no answering row, so it adds no session id.

| Gate, leg | Figure | Was | Now | Arithmetic |
|---|---|---|---|---|
| tables (both runs) | `groupedCalls` | 399 | **414** | 314 killed + 70 survived scored + 15 warm replays + 15 warm re-runs |
| tables (both runs) | distinct grouped session ids | 399 | **414** | groupedCalls - 0 stopped calls |
| chunked, control leg | `groupedCalls` | 33 | **42** | 17 + 7 scored + 9 replays + 9 re-runs |
| chunked, chunked leg | `groupedCalls` | 57 | **62** | 52 covering chunk calls + 5 replays + 5 re-runs |
| chunked, chunked leg | re-run method list of each of the 5 warm kills (`CHUNKED.warm`) | (new) | **= its replay list**, same methods in the same order (its chunk's 2 methods) | the re-run replays `step.chunkPrefix` |
| hang, ON | `groupedCalls` | 42 | **46** | 24 + 9 + 5 scored + 4 replays + 4 re-runs |
| hang, ON | distinct grouped session ids | 37 | **40** | 46 - 6 stopped calls (5 first timeouts + line 145's re-run); equally, 37 + 3 warm-fail re-runs |
| hang, ON | `HANG_FIGURES.stoppedCallsOn` | (new) | **6** | as above |
| hang, ON and SINGLE | mutated `timeout` rows per `timeout-killed` mutant (`method = killingTest`) | 1 | **2** | both carry "stopped the session" and "StopSession", in [20 000, 50 000) ms |

Asserted and NOT moved:
- **bcdev:** `groupedCalls` **15** (3 kills, all at position 1); `warmKills` 0; distinct grouped ids 15;
  the assertion screen `vacuous`.
- **tables:**
  - `warmKills` 15;
  - positions M0179 5, M0183 4, M0175 2, M0005 3, M0009 3;
  - `platformArtifactKills` 4; the screen `partial`; `untargetedTriggerCount` 0;
  - the one refused baseline test.
- **chunked:**
  - `warmKills` 9 and 5;
  - the control histogram {1: 8, 2: 3, 3: 3, 4: 2, 5: 1};
  - the replay lists, and M0015's 4-method control replay;
  - every chunked covering call has at most 2 methods (re-run rows are kept apart, not counted as
    covering calls);
  - the four kills that turn cold write no replay and no `many` re-run.
- **hang:** `warmKills` 4; `coldConfirmsOn` 4; `coldConfirmsSingle` 5; SINGLE `groupedCalls` 0.

## 4. Per gate

| Gate | Server, queue position | Baseline / table (unchanged per mutant) | Kills that must carry `killReproduced` | Moved figures | Moves nothing else |
|---|---|---|---|---|---|
| `itest:verify-scale` | bc1, 1st | A per verdict = `tables.baseline.json` (314 / 70 / 22) | A 314, B1 314, B2 314 | none asserted (printed ratios fall) | measurement mode |
| `itest:bcdev` | bc1, 2nd | `bcdev.baseline.json` 3 / 12 / 4, both runs | 3 per run | none | groupedCalls 15 |
| `itest:bcdev-names` | bc1, 3rd | `bcdev.names.baseline.json` 36 killed, R557 table | 36 | none | yes |
| `itest:verify` | bc1, 4th | step 1 = `bcdev.baseline.json`; step 3 ClampPercent killed, LogAudit survived, exit 5; steps 4-5 as pre-committed (C02-06, C02-09) | full run 3 (verify's own kill is not evidenced: `VerifyResult` has no marker) | none | yes |
| `itest:testapp` | bc1, 5th | step 1 = `bcdev.baseline.json`; named kill `OverBudgetDetected`, survivor survived | full run 3, the named kill | none | yes |
| `itest:hang` | bc2, 1st | ON = `EXPECTED_ON`; SINGLE = `hang.single.baseline.json` 24 / 9 / 5 timeout-killed; OFF as pinned | ON 29, SINGLE 29, OFF 1 | ON groupedCalls 46, distinct ids 40, stoppedCallsOn 6; 2 stop rows per timeout kill (ON, SINGLE) | coldConfirms 4 / 5, warmKills 4 |
| `itest:harden` | bc2, 2nd | `harden.baseline.json` 16 / 5; leg B S1-S4 killed by name, S5 survives | A 16, B 20 | none | yes |
| `itest:agreement` | bc2, 3rd | A = `harden.baseline.json`; B 20 / 1 / 0 as pre-committed (C02-08); verify 4 killed, S5 skipped | A 16, B 20 (verify's 4 are not evidenced) | none | publishes 1; "verify faster than B" holds, margin widens |
| `itest:bcdev-wrapped` | bc2, 4th | `bcdev.wrapped.baseline.json` 60 / 38 (fenced), `EXPECTED_WRAPPED_BC`, hub = fenced | 60 per leg | none | yes |
| `itest:stale-publish` | bc2, 5th | its probes (no orchestrator) | none | none | yes |
| `itest:lease` | bc2, 6th | its probes (no orchestrator) | none | none | yes |
| `itest:tables` | bc3, 1st | `tables.baseline.json` 314 / 70 / 22, both runs | 314 per run | groupedCalls 414, distinct ids 414 | yes |
| `itest:chunked` | bc3, 2nd | control = chunked per verdict and killer, 17 / 7 / 2 each | 17 per leg | control 42, chunked 62; 5 re-run lists = replay lists | yes |
| `itest:envtool` | host-only | `envtool.baseline.json` | 3, checked by `killReproductionFailures("envtool", ...)` with its own `REPRODUCTION_EXPECTED` row (`killerRowsPerKill` 2) | none | UNMEASURED until the owner runs it; a hosted re-run may score `session-reused` |

Kill split, for the arithmetic:
- tables: 299 at position 1 + 15 warm;
- chunked: control leg 8 + 9; chunked leg 12 + 5;
- hang ON: 21 fails at position 1 + 3 warm fails; 4 timeouts at position 1 + 1 warm timeout;
- hang SINGLE: 24 fails + 5 timeouts, all at position 1;
- bcdev, wrapped, names and harden: kills are re-run whatever their position, and no counter is pinned
  there except bcdev's.

## 5. Timing

- **One gated timing:** `itest:agreement` step 6 gates "verify faster than B", a RELATIVE timing.
  - verify gains 4 re-runs and B gains 20, so the margin is predicted to WIDEN.
  - R-604 bc2 measured verify 6 680 ms against B 9 843 ms.
- **Every other wall time is printed only.** Expected values, against R-604 bc2's 464, 865 and 630 s:
  - tables: about 650-700 s;
  - verify-scale: about 1350 s;
  - hang: about 900 s. The rise is ten more timeout re-runs of about 20-25 s each.

## 6. How the queues run

- R-604's `gate-queue.sh`, copied under `/coord/handoff/R-582/`. One queue per server.
- One detached worktree per server at the build sha. Each is prepared with:
  1. `bun install --frozen-lockfile`;
  2. `bun scripts/build-native-parser.ts`;
  3. `bun scripts/bc-linux-setup.ts --server bcN`;
  4. the `.alpackages` fill.
- Each gate runs under its own coord lease, and only after the lease holder is null and at least 10 GB is
  free. Other lanes (preproc's R-618) also lease the bc servers: a queue waits its turn. A gate is never
  signal-stopped.
- A BC gate against a bc server does not count toward the two-heavy-job limit (CLAUDE.md).
