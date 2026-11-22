# PR-357 pre-commitment: c3, a new reference full-DO run on current main-bf3a3e863 and current master, with R1180's control

Coord PR-357 (lethal-bugs, 2026-11-22), on the orchestrator's word. Written and committed before any arm runs. Driver and
comparison: `/coord/handoff/PR-357/` (`predict.py`, `predicted.tsv`, sha256 `fae2c8e0…`; the arm and compare scripts follow
PR-330's). c3 becomes the reference for PR-256's stop-groups A/B and PR-347's flip.

## What changed since c2 (main-ccd0f823d, head 5ce080dce)
- **`current` moved twice:**
  - main-ef9f6a222: #8239, and #8652 (Format with a length and a format string);
  - main-bf3a3e863: six alrunner PRs, #8564 among them.
- **master gained:**
  - PR-340, the carry walk (merge 3a943e7c0);
  - PR-341, recheck eligibility (2883ed2d3);
  - PR-327, the SingleInstance label (acd8b0ae4);
  - PR-322 and PR-323, among others.
- c2 has no `[singleinstance-carry-*]` label at all (it predates PR-327).

## The runs
- **c3:** c2's settings (`/coord/handoff/combined-do/run2.sh`), as in PR-330:
  - project `R-942/src/do-cloud`, tests `R-942/src/do-test`, `--backend al-runner-v3`, `--profile slim`, `--allow-large-run`,
    `--workers 8`, `--peak 22`, `LETHAL_V3_PACK_ENTRIES=256`;
  - the triage baseline first, a fresh store;
  - every other `LETHAL_*` unset (except `LETHAL_ALC_DIR` and `LETHAL_COORD_ROOT`), so the carry walk is at its default (on).
- **The config:** c2's, copied with its own `cacheDir`, `alRunnerV3.path` = `/work/tools/al-runner-v3/main-bf3a3e863/al-runner`,
  `"ciSessionKind": "client"`, and companies CRONUS International Ltd. `--ci-session-kind client` is passed as well.
- **The binary:** `al-runner 3.0.0-alpha.15+main.20261122 (bf3a3e863)`, sha256 `b3e1d255…`. It is checked before and after
  each run and by the run's own version line; a mismatch stops the run.
- **The head:** origin/master at the start, recorded in `HEAD.txt` and the same for both runs. It must contain 3a943e7c0
  (PR-340) and 2883ed2d3 (PR-341).
- **c3off (R1180's control):** the same head, build, config and settings with `LETHAL_V3_CARRY_WALK=off`, run right after c3.
- **The box:** CPUs 0-11 (`taskset`), a tree-RSS watchdog at 24 GiB and the headroom stop, as in PR-330. Recorded every 30 s:
  - host load and pressure;
  - the busy share of CPUs 12-21 (PR-330's sampler line FIXED: its `printf ... t > 0 ? ...` was an awk output redirection,
    which is why the column was empty; the expression is now parenthesised and smoke-tested);
  - the memory sampler as in PR-330 (`mem-sampler.tsv`, an observer only).
  - The BOOTTIME − MONOTONIC gap at both ends of each run.
- **When:** after preproc's three v3 gates and code's BC queue, on the orchestrator's word.

## Predictions (written before the run)
1. **The 96 Format cut-errors of c2** (PR-334's `set.tsv`): each gets PR-334's measured verdict and `killingTest` by name
   (`predicted.tsv`): 13 killed, 19 survived, and 64 `error` cut by #8592's RelationFieldNo refusal (codeunit 68984).
2. **PR-340's carry walk:** a c2 `survived` may become `killed` only with the `[singleinstance-carry-killed]` note. A
   survivor may gain `[singleinstance-carry-unobservable]`, `[singleinstance-carry-walked]` or
   `[singleinstance-carry-walk-failed: …]` with no verdict change. The counts are reported.
3. **0 partner-login refusals** (#8239's fix; DO never hit it, PR-334).
4. **Every other verdict or `killingTest` move against c2 is a BLOCK to analyse, not to excuse.** That covers any move outside
   predictions 1 and 2, joined on the full site key (file, line, operator, start, end). Each is listed with c2's and c3's
   verdict, killingTest and note.
5. **Speed against c2** (13,457.8 s, 5 of 8 lanes): reported, not gated. Expected faster, from bf3a3e863's speed PRs; PR-340's
   walks add requests. The TIMING total, the phases, the entries sent and the lanes started are reported.

## R1180: the after-walk check (c3 against c3off)
- **Every mutant WITHOUT a `[singleinstance-carry-*]` tag in c3** must have the same verdict and `killingTest` in c3 and c3off.
  Any difference is a BLOCK (R1180's own rule), listed by name.
- **Reported:** the number of walks c3 ran, by outcome (killed, walked, walk-failed), and how many unlabelled mutants were
  scored on a lane after that lane's first walk (the requests the control is about).
- **If c3off cannot run** (the box), R1180 stays open and only c3 is reported.

## What it becomes
If predictions 1-4 hold and R1180 has 0 differences, c3 is the reference for PR-256 and PR-347, and R1180 closes. Otherwise the
BLOCKs are the finding, and the orchestrator decides.
