# PR-119 (R1107): pre-commitment of the proof runs

Status: committed to master before any proof run (coord PR-119, lethal-preproc, 2026-11-17). The design is
`2026-11-17-pr119-concurrent-baseline-samples.md` (r5 or later; the version committed beside this file is the one measured).
Evidence goes to `/coord/handoff/PR-119/`. Every run below uses the PR head that is submitted, and al-runner `current`
(edge-4ebfe7913 today). If `current` moves before a run, the run says so on its first line, and the pair is re-run on one build.

## P1. The v3 gate (`LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3`)
- Every leg passes, with every pre-committed figure unchanged.
- DBM (spec §7.1):
  - it sets `concurrentSamples` to `true` itself;
  - it has a fixed memory reader and a fixed sample size (`sampleRss`, 1 GiB);
  - it asserts `samplesOverlapped >= 1`.
- `DBM_FIGURES` (122 / 15 / 3 / 104) and `GATE_WARNINGS["al-runner-v3/dbm-daemon"]` are unchanged.
- Since a DBM pass gates the al-runner update script (R1109), this check becomes a condition of every later build's update.
  No build can move it: a build changes neither the order of DBM's 4 codeunits nor the request that codeunit 2 needs.

## P2. DO's 735fb42 arm, sequential vs concurrent (spec §7.2)
- **Setup:** PR-118's (`/coord/handoff/PR-118/run.sh`), with the same changes, `--workers 1`, `--changed-since 735fb42^` and
  config `PR-67/v3.json`.
  - DO is cloned again from `/work/src/do-lethal` at 735fb42 into `/coord/handoff/PR-119/do-git`.
  - The CLI is the PR-119 worktree's.
  - PR-118's 200 ms RSS sampler records children of the run's own CLI pid only.
- **Runs:** one after the other in one heavy slot (`--peak 10 baseapp`):
  - (a) `LETHAL_V3_SEQUENTIAL_SAMPLES=1`;
  - (b) unset (concurrent).
- **Equal (a difference is a BLOCK):**
  - every per-mutant verdict and `killingTest`, joined by file, startIndex, endIndex, operator and astHash;
  - `daemonBaselineReport()`'s `requests` and `sampledCodeunits`;
  - `compared` and `dropped`, when no sample was skipped in either run. Otherwise they are reported, not judged.
- **Allowed to differ:**
  - `replacements`;
  - the order of `skippedError` / `sampledSkipped`;
  - `skippedTooSlow` (more only);
  - `served`, either way.
- **The wall:** if (b) has `samplesOverlapped >= 6`, (b)'s baseline phase is at least 15 s shorter than (a)'s. With fewer,
  the wall is reported, not judged, with `sampleMemoryAtStart` and the count of admission refusals.
- **Memory:**
  - (b)'s fill peak is at most the daemon's peak plus the largest one-shot peak plus 0.5 GiB, by the sampler;
  - no memory stop in either run.
- **Stats:**
  - (a) prints `0 overlapped`;
  - when no sample was skipped in either run, (b)'s `overlapped + sequential` equals (a)'s `sequential`.

## P3. A larger corpus: BaseApp under test × Fixed Asset tests, the RSS series (spec §7.3)
- **Corpus:**
  - PR-75's corpus, with BC.History Base Application 28.6 under test (`/coord/handoff/PR-57/src/baseapp`, full source,
    `--only 'FixedAssets/**'`);
  - against 12 of the 16 Tests-Fixed Asset codeunits, copied unchanged into `/coord/handoff/PR-119/fa-test12`. Its
    `app.json`, its `Directory.App.Props.json` and its `Translations` are copied too.
  - **Dropped**, to bound the time: 134450, 134451, 134453 and 134456. They hold 234 of PR-75's 316 refusal daemon restarts.
  - **Kept:** 134049, 134063, 134452, 134454, 134478, 134913, 134978, 134980, 134981, 134990, 135401, 139505.
  - With 12 codeunits, the samples are index 1, index 10 and the last. Two of them can overlap.
  - Config `/coord/handoff/PR-119/v3.fa-test.json`: PR-75's `v3.fa.json`, with `"isolation": "test"`, so auto's re-baseline
    does not double the time.
  - Baseline only: one SIGTERM once `baseline-batch-finished` appears (PR-75's watchdog). No mutant is scored.
- **Runs:** (a) sequential and (b) concurrent, one after the other in one heavy slot.
  - The slot is `--peak 16 baseapp`: PR-75's tree peaked at 9.4 GiB, and a concurrent one-shot can add about the daemon's
    size.
  - The watchdog stops at a tree of 20 GiB, or at less than 4 GiB of container headroom.
  - Neither run starts beside a DO window.
- **The series:** 200 ms RSS of each al-runner child of the run's CLI. It records:
  - the baseline daemon's RSS, idle and during an overlapped request;
  - each one-shot's ramp, peak and run time;
  - S and the guard's reading at each admission, and every admission decision, from the stats and the
    `[lethal] ... baseline samples (PR-119)` line.
- **Predictions:**
  - no memory stop and no watchdog stop in either run;
  - each admitted sample's real one-shot peak is at most S + 0.5 GiB;
  - either a sample was admitted and (b)'s tree peak stayed under the guard's bound (28 GiB), or every admission refused
    and (b) reports `0 overlapped`;
  - the baseline's per-test results are equal between (a) and (b): status, and refusal text by family.
- **If the fill drops or stops before any sample,** the result says "not exercised". It still records S, the daemon's size
  and the admission decisions. The default stays `true` only if what WAS measured stays under the bound.
- **The default:** `concurrentSamples` ships `true` only if P3 holds in both runs. Otherwise the PR sets it `false` until
  a ruling.

## Not claimed
- No wall-time claim on the large corpus: its baseline time is dominated by refusal daemon restarts (PR-75).
- No score claim: P3 scores no mutant.
