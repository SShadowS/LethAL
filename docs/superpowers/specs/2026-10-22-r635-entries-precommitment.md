# R-635 pre-commitment: the serve-entries transport, live legs (nothing run yet)

Source: plan r3 §10 (`docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md`), the orchestrator's additions
(2026-10-22: secondEcho ON/OFF, edge one-shot CONTROL legs) and the build review r1
(`/coord/reviews/R-635-build/review-r1.md`). No BC server and no lease are needed.
Committed to master by lethal-code on 2026-10-22, before any leg below ran.

## 0. What is under test

- **Code:** `lethal/r635` at **7a8f63b37dd03bf47c94e7d18408cc092c328b98**. This includes the harness change (§1)
  and the build-review fixes.
- **Worktree:** `/work/lethal-wt/r635`. Before each leg, `git status --porcelain --untracked-files=all` must be
  empty, and `git rev-parse HEAD` must equal the sha above. The itest also refuses a dirty tree (G5).
- **Binary:** the EDGE build, by path and sha256:
  - path `/work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner`
  - sha256 `0642f9b27f0e55912d434fe231543b1bedcf98a14fc38a8b7f08788b11ac8720`
  - `--version`: `al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)`
  - Run under `LETHAL_ALRUNNER_V3_CANDIDATE=1`.
  - Before each leg, `sha256sum` of the path must equal the sha above, and the itest's first line must print it.
  - `ALRUNNER_CACHE` = `/work/tools/al-runtime-rs/cache` (the itest default).
- **Two claims, kept apart:**
  - **Transport (R-635's claim):** each entries leg equals its edge ONE-SHOT control per mutant, with 0
    differences and no exceptions.
  - **Binary (not R-635's):** each control is compared with its authoritative baseline. A difference there is an
    EDGE-BINARY difference. It is recorded with a cause and is not a stop for R-635.

## 1. Harness (built and red-checked in 7a8f63b3; `/coord/handoff/R-635/build.md`, R81-R87)

`itest:alrunner-v3` takes these, all unset by default, which leaves the gate byte-for-byte unchanged (pinned by test):
- `LETHAL_ITEST_V3_TRANSPORT=one-shot|serve-entries` and `LETHAL_ITEST_V3_SECOND_ECHO=0|1`. Any other value refuses by name
  (`al-runner-v3-itest-transport-refused`).
- `LETHAL_ITEST_V3_REPORT_DIR=<dir>`: writes `<dir>/<leg>.report.json` BEFORE any assertion, so a control whose
  baseline comparison fails still leaves its report.
- `LETHAL_ITEST_V3_CONTROL_DIR=<dir>`: FIRST compares the session per mutant with `<dir>/<leg>.report.json`.
  A missing control file refuses (`al-runner-v3-itest-control-missing`).
- The serve-entries legs print `<leg>: entries {daemons, cachedFalse, warmups, prefetchRequests, liveRequests,
  coverageRequests, echoRequests, echoMismatches, secondEchoMismatches, entriesSent}`. Every leg with a flag prints
  `<leg>: timings {...}` (generate, deploy, baseline, mutants, total).
- **Per-mutant equality** is `assertPerMutant`, i.e. `compareMutants(normalizeForComparison(...))`
  (`packages/runner/itest/mutant-equality.ts`). It compares verdict and killing test per mutant, plus the source text
  where the oracle has it. It prints the count of differences, then each one.

## 2. Legs, in run order (each control runs just before its entries legs)

Common environment:

```
cd /work/lethal-wt/r635
test "$(git rev-parse HEAD)" = 7a8f63b37dd03bf47c94e7d18408cc092c328b98
test -z "$(git status --porcelain --untracked-files=all)"
test "$(sha256sum /work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner | cut -c1-64)" = 0642f9b27f0e55912d434fe231543b1bedcf98a14fc38a8b7f08788b11ac8720
export LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ALRUNNER_V3_CANDIDATE=1 \
  LETHAL_ALRUNNER_V3_PATH=/work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner
C=/coord/handoff/R-635/live/control; E=/coord/handoff/R-635/live/entries
```

- **Stores:** the itest makes a fresh `mkdtemp` scratch per run (`lethal-itest-v3-*/<leg>/lethal.sqlite`). Never
  `--resume`, never a reused snapshot, one worker.
- **Logs:** `/coord/handoff/R-635/live/<id>.log`.
- **Reports:** controls write to `$C/<leg>.report.json`; entries legs write to `$E` (E3b to `$E/b`).

| # | Id | Command (after the common env) | Compared with |
|---|---|---|---|
| 1 | E0-S | `LETHAL_ITEST_V3_LEGS=S1 LETHAL_ITEST_V3_REPORT_DIR=$C bun run itest:alrunner-v3 2>&1 \| tee /coord/handoff/R-635/live/E0-S.log` | `packages/runner/itest/bcdev.baseline.json` (binary claim) |
| 2 | E1 | `LETHAL_ITEST_V3_LEGS=S1 LETHAL_ITEST_V3_TRANSPORT=serve-entries LETHAL_ITEST_V3_REPORT_DIR=$E LETHAL_ITEST_V3_CONTROL_DIR=$C bun run itest:alrunner-v3 2>&1 \| tee .../E1.log` | `$C/S1.report.json` (transport), then bcdev.baseline.json |
| 3 | E0-T | `LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_LEGS=T LETHAL_ITEST_V3_REPORT_DIR=$C bun run itest:alrunner-v3 2>&1 \| tee .../E0-T.log` | `packages/runner/itest/al-runner-v3.tables.baseline.json` (the alpha.2 v3 tables record; binary claim) |
| 4 | E2 | `LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_LEGS=T LETHAL_ITEST_V3_TRANSPORT=serve-entries LETHAL_ITEST_V3_REPORT_DIR=$E LETHAL_ITEST_V3_CONTROL_DIR=$C bun run itest:alrunner-v3 2>&1 \| tee .../E2.log` | `$C/T.report.json`, then the tables record |
| 5 | E0-D | `LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396 LETHAL_ITEST_V3_LEGS=D1 LETHAL_ITEST_V3_REPORT_DIR=$C bun run itest:alrunner-v3 2>&1 \| tee .../E0-D.log` | `docs/measurements/r594/bc3-A.report.json` (binary claim) |
| 6 | E3a | as E0-D plus `LETHAL_ITEST_V3_TRANSPORT=serve-entries LETHAL_ITEST_V3_REPORT_DIR=$E LETHAL_ITEST_V3_CONTROL_DIR=$C`, tee `E3a.log` | `$C/D1.report.json`, then bc3-A |
| 7 | E3b | as E3a plus `LETHAL_ITEST_V3_SECOND_ECHO=0`, `LETHAL_ITEST_V3_REPORT_DIR=$E/b`, tee `E3b.log` | `$C/D1.report.json`, then bc3-A |

- **E0-T / E2 and the 52:** the v3 tables record already differs from BC's `tables.baseline.json` in the 52 rows of
  `TABLES_KNOWN_DIFFERENCES` (`al-runner-v3-tables-known.ts`), asserted by key AND transition through leg T's existing
  code. That handling is unchanged. A row that edge one-shot (E0-T) moves against the alpha.2 record is an
  edge-binary difference. E2 is held to E0-T with 0 differences.
- **E0-D / E3:** the existing guard pins the CDO checkout: `/work/lethal-wt/cdo-r396` at 5f2a71d, clean,
  fingerprint `aa47c61c1fcbb7e3`, plus `CDO_SLICE_SHA256` and `CDO_ALPACKAGES`. Coverage is `none`, as in bc3-A.
  The Sleep index is 3 + 0, so §5 windows run in E3a (with the second echo) and E3b (without it).
- **Reading a leg's later assertions:** after the control comparison, a leg runs the existing oracle assertions
  (counts, state notes, index, kills reproduced). An entries leg that fails one of them on a row where its control
  failed the same way is an edge-binary difference, not R-635's. Every such row is listed with its cause.

## 3. Pre-committed figures

Transport, entries legs (any miss is a STOP for R-635):

| Figure | E1 | E2 | E3a | E3b |
|---|---|---|---|---|
| per-mutant differences against its edge one-shot control | 0 | 0 | 0 | 0 |
| daemons started | 1 | 1 + R612 cuts (recorded) | 1 | 1 |
| cachedFalse | = daemons | = daemons | = daemons | = daemons |
| warmup-dirty / warmup-disagrees / batch-refused / no-baseline-rows | 0 | 0 | 0 | 0 |
| echoMismatches | 0 | 0 | 0 | 0 |
| secondEchoMismatches | 0 (no window) | 0 (index 0) | 0 | 0 (off) |
| kills reproduced (R577) | all | all | all | all |

Binary, controls, against the authoritative baselines. These are EXPECTED; a miss is recorded with a cause and is
not an R-635 stop:
- E0-S: 3 / 12 / 4 over 19, 0 differences from bcdev.baseline.json.
- E0-T: 290 / 57 / 59 over 406, 3 refused tests, 0 differences from the alpha.2 tables record.
- E0-D: 51 / 12 / 0 over 63, 0 differences from bc3-A.

## 4. Recorded, not predicted

- **Each leg's wall time** (the itest's per-leg time and the `timings` line).
  - **The HEADLINE is E3a's and E3b's wall time**, set against bcdev's 53-80 s, one-shot's 378 s (D1 on
    alpha.2), and E0-D's edge one-shot time, measured beside them.
- **The MEASURED cold baseline compile:** E3a's and E0-D's `timings.baselineMs`. That is one cold one-shot call of
  codeunit 68933 (the compile plus 21 tests).
- Requests by kind, entries per request, and cached true/false, from the `entries` line.
- **Whether the second echo ever caught anything:** E3a's `secondEchoMismatches`. Pre-committed 0; any other value
  is a STOP, recorded.

## 5. STOP rules (each is recorded, never retried into a pass)

- Any per-mutant difference between an entries leg and its edge one-shot control.
- Any named refusal in an entries leg: `-warmup-dirty`, `-warmup-disagrees`, `-batch-refused`,
  `-no-baseline-rows`, `AlRunnerV3ServeStopUnsetError`, `-itest-control-missing`, or an encoder throw.
- cachedFalse greater than the daemons started.
- A binary sha256 mismatch, or a HEAD other than 7a8f63b3.
- A dirty worktree.
- An entries-leg difference from its authoritative baseline that its control does NOT share.
- A leg that ends by a signal or a timeout is recorded as such. It is never TaskStopped mid-leg.
- **NOT a stop:** a control's difference from its authoritative baseline (an edge-binary difference, recorded with a
  cause), and the same difference repeated in its entries leg.

## 6. Heavy jobs and order

- Each leg is ONE local heavy job (the container limit is 3; at most 2 BaseApp; CDO is not BaseApp). Before each
  leg, check `ps` and `free -g` (at least 10 GB available).
- Run strictly ONE AT A TIME, in the order of §2. The headline is a wall time, and E0-D, E3a and E3b share one
  ALRUNNER_CACHE and one CDO checkout.
- E0-D took about 378 s on alpha.2. E0-S and E0-T take minutes. No BC server is needed.
