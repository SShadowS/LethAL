# Pre-commitment: the COMBINED full DO run (8 lanes, main-ccd0f823d, every landed speed change)

lethal-preproc, 2026-11-21, committed before the run. The owner's critical path. Draft history:
`/coord/handoff/combined-do/precommit-draft.md`. Prediction scripts: `/coord/handoff/combined-do/`.

## 1. What runs
- **al-runner `current`:** `/work/tools/al-runner-v3/main-ccd0f823d`, version
  `al-runner 3.0.0-alpha.14+main.20261120 (ccd0f823d)`, sha256
  `bc3595c4e2ff9c2ae63c7c02e1133155005414464f59ecd22dca9d4ab281ad7c`.
  - Gated by lethal-bugs (PR-255; ledger master efea24776). It is upstream main ccd0f823d (train-261120s, #8579):
    #8365 (kept sources), f7b156fb4 (#8484) and f9116dc96. It has no #8446 (workspace compile cache) or #8445.
  - The run script refuses to start if `current` is not this build.
- **LethAL:** master 09d4cadcc. The script refuses if any of these is not an ancestor:
  - PR-246 (R987's cost model, 7bb8cab55);
  - PR-259 (the bound print, f068a6f5);
  - PR-252 (the monotonic clock, ce8de0baf);
  - PR-264 (the boot-clock suspend watch, 7ca4e7179).
  - PR-250's cut and PR-225's recheck set are older and in master.
  - NOT included: PR-267 (R1151, not landed), PR-235 (R1148, not landed), stop groups (PR-256, not upstream; #8484's
    request stop is not sent).
- **Script:** `/coord/handoff/combined-do/run.sh`, PR-246's `run-z.sh` (y3's script with its triage and watchdog). The
  differences:
  - **`--workers 8`** (the OWNER's decision, 2026-11-20: the count PR-274 recommends). y3 and perf10c ran 3.
  - **Heavy slot `--peak 22` (class baseapp).** PR-274's W8a tree max was 17.3 GiB and no daemon passed 2.06 GiB; its
    amendment 2 set 22. The watchdog's tree limit goes from 20 to 24 GiB (the peak plus 2); the 4 GiB headroom stop is
    unchanged.
  - **Fallback, only if another heavy slot is held when this one is asked:** 6 lanes, `--peak 17`, watchdog 19 (code's
    proposal). The run log records which ran.
  - **`taskset -c 0-11`** (code's PR-235 gate is on 12-21; 8 lanes used 5.4 cores in PR-274).
  - Kept: `--profile slim`, `LETHAL_V3_PACK_ENTRIES=256`, no `--time-budget`, y3's config and scope.
- **Timing:** it starts about 05:30Z on 2026-11-21 and should end well before 00:00Z (#8457).
- **A suspend:** PR-252/264's `run-suspended` warning (BOOTTIME-based) and the TIMING total; durations are monotonic.
- **Comparability:** y3 and perf10c both ran 3 lanes, so WALL figures are compared as "this configuration against
  those", not as each lever's share at equal lanes (stated, the owner's trade). VERDICTS are compared per mutant: a lane
  count must never move a verdict (PR-274: 0 differences across 3/4/6/8).

## 2. Compared with
| | y3 | perf10c (PERF-10) |
|---|---|---|
| al-runner | edge-4ebfe7913 | perf-combined 2bb4b686 (fork with #8365, #8446, #8445, ...) |
| lanes | 3 | 3 |
| mutant phase (monotonic) | 23,928.2 s | 16,457.5 s |
| s per covered mutant (16,682) | 1.43 | 0.99 |
| verdicts | no-cov 26,829 / surv 9,885 / killed 6,442 / error 348 / t-killed 7 | 26,829 / 9,590 / 6,445 / 640 / 7 |

## 3. Verdicts (first; per mutant, joined on the full site key)
- **The baseline on ccd0f823d** (bugs' one-shot, `/coord/handoff/PR-255/dotnet/new.json`): 1,907 passed.
  - 8 tests are newly NotRun on one upstream refusal ("value of field 'RelationFieldNo' of platform table 'Field' is not
    known"): 3 in 68975 "CDO Doc Templ Line Tests" and 5 in 68984 "CDO Variant Setup UI Tests".
  - The by-value refusal of 68874.CustomerWithNegativeBalance_... remains, so perf10c's 302 `error` carry over.
    68904.SetPostedDocumentsHandled_AlreadyHandledKeepsOriginalTimestamp passes, so perf10c's 10 error -> killed carry
    over.
- **Against perf10c:** every mutant keeps its verdict EXCEPT the 1,332 covered by those 8 tests, each named with its
  predicted verdict in `/coord/handoff/combined-do/relationfield-mutants.tsv` (PR-250's cut per codeunit in baseline
  order).
  - Moves: killed -> error 72, survived -> error 495. Unchanged: killed 444, error 321.
  - **Expected totals:** about no-cov 26,829 / surv 9,095 / killed 6,373 / error 1,207 / t-killed 7.
- **Against y3:** perf10c's 312 explained moves, plus the moves above.
- **No lever of this run, and not the lane count, moves a verdict.** Any other move is a BLOCK until explained by name;
  one caused by main against perf-combined is an alrunner finding.

## 4. Speed (mutant phase, monotonic)
- **Work, in busy lane-s, from perf10c's 46,700 (PR-251, overlap-corrected):**
  - LethAL's levers −2,670 (the bound print, R987's model and packing: about 890 s at 3 lanes);
  - main's fixed cost +210 (bugs: 129 ms against 90 ms × about 5,200 requests);
  - warm-ups without #8446 +945 (0 to +1,890);
  - 5 more lanes' first daemon starts +360 (about 72 s each);
  - **about 45,550 lane-s.**
- **Wall at 8 lanes:** 45,550 / 8 = 5,690 s if every lane were busy all phase.
  - PR-274's slice had its lanes 56-80% busy at 8, with a floor of about 2,500 s from one scope chain. A full DO run is
    about 6× the slice, so the tail is a smaller share. Taking 85% busy (75-95%):
  - **central about 6,700 s (6,000 to 7,600; 8,100 if the warm-up share is at its top and efficiency at 75%).**
  - That is 0.40 s per covered mutant: −72% against y3 and −59% against perf10c (in this configuration).
- **Not credited:** the 567 mutants moving to `error` (their walks stop at the cut), and PR-275's R1160 (301 by-value
  mutants, 11,609 lane-s).

**Hard claims, each a BLOCK if missed:**
1. 0 verdict moves outside §3's named list.
2. Mutant phase under 10,000 s (perf10c − 6,450 s; y3 − 13,900 s). The box is shared and its load moved PR-274's 3-lane
   pair by 35%, so this bound is wide.
3. Prefetch requests under 4,000 (perf10c 6,482). R987's model with packing replayed to about 1,270 at 3 lanes, but 8
   lanes split the units into more, smaller packed calls.
4. The bound check's TOTAL `boundMs` under perf10c's 2,381 s. Per check it may exceed R1156's 3-lane 130 ms target,
   because 8 lanes' synchronous hashes queue on one JS thread: about 5,200 checks at up to about 250 ms is 1,300 s.

**Reported against prediction, not BLOCK:** per-check bound ms, the recheck baseline's test count (497 in perf10c; the
RelationFieldNo change can move it), warm-ups by cause, lane busy shares and the tail, the per-mutant s.

## 5. Recorded
- TIMING;
- the serve-entries line;
- `serve-request-timed` and `serve-request-sized` events;
- `--progress-out` NDJSON;
- the per-mutant moves list by name;
- `run-suspended`;
- the procs watchdog log;
- heavy-peaks;
- `journalctl` suspend lines (if readable).

Numbers and names only leave /coord.

## Amendment 1 (2026-11-21, before c2 starts): c1 ran the wrong build; the real run is c2 on main-ccd0f823d
- **What happened to c1.** It ran on edge-4ebfe7913 through the reused config's `alRunnerV3.path` pin, not on `current`.
  The script checked `current`. Write-up: `docs/measurements/2026-11-21-combined-do-c1-edge.md`.
  - Verdicts against y3: 10 moves, all perf10c's explained ones.
  - Speed: −16.8% against y3 at 5 lanes, with per-test time +47-59%.
- **c2's script** (`/coord/handoff/combined-do/run2.sh`, config `v3.main-ccd0f823d.json`):
  - the config's `path` is main-ccd0f823d. The script refuses unless that binary's sha256 is `bc3595c4...` and its
    `--version` is `al-runner 3.0.0-alpha.14+main.20261120 (ccd0f823d)`;
  - after start, the run's own `[lethal] al-runner: <path> (<version>)` line must name it, or the run is SIGTERMed;
  - it has its own cache directory (cold first request);
  - host load, CPU and memory pressure and cgroup memory are sampled every 30 s (`c2.box.tsv`).
- **Lanes, measured rather than assumed:** `--workers 8 --peak 22`, watchdog tree 24 GiB.
  - LethAL's lane gate charges each lane its MEASURED high-water mark and starts as many lanes as fit 22 GiB (with
    LethAL's 4): 8 lanes at up to 2.25 GiB per lane, 7 at up to 2.57, 6 at up to 3.0.
  - c1 measured 3.1 GiB per lane on edge without kept baselines. Main keeps and peaked at 2.06 GiB per daemon on
    PR-274's slice. **Predicted: 6 or 7 lanes, 6 central** (the orchestrator's safe default).
- **LethAL head:** master 19b863275 plus this amendment. It contains PR-246, PR-259, PR-252, PR-264 and PR-282
  (157b85e09, `alRunnerV3.companies`), all checked by the script.
  - PR-281 has NOT merged, so it gets no share. PR-292's bound-print worker is not merged either.
  - `companies` is set to `"CRONUS International Ltd."` from PR-283's measurement (see Verdicts).
- **Beside c2 (the orchestrator's order):** c2 starts after lethal-code's PR-281 A/B (ended 15:27Z) and lethal-bugs'
  PR-287 v3 hang check (ended 15:47Z).
  - Running BESIDE it: lethal-bugs' PR-287 BC arms on bc4 (one LethAL client process, no al-runner daemon), lethal-bugs'
    PR-296 builds (2 × 3 GiB cargo, CPUs 12-21, minutes), and lethal-code's PR-294 v3 gate (2 GiB, about 15 min, CPUs
    12-21). c2 is pinned to 0-11.
  - lethal-bugs' timed rounds (PR-296, PR-284) wait for c2's end.

### Verdicts (§3, ccd0f823d's baseline, plus PR-283's Company mutants)
- perf10c's verdicts, except two named sets that do not overlap:
  - **The 1,332 RelationFieldNo mutants** named in `/coord/handoff/combined-do/relationfield-mutants.tsv`, predicted by
    PR-250's cut.
  - **PR-283's 174 Company-refusal mutants, predicted per mutant from PR-283's measured verdicts on ccd0f823d with
    `companies` = `CRONUS International Ltd.`: 156 killed, 18 error** (`c2-companies-mutants.tsv`, `companies174.py`).
    - PR-283 measured CRONUS, CRONUS + My Company and `all` as identical (156 killed, 18 error, 0 Company refusals); the
      run uses the narrowest. Unset, 80 of the 174 hit the refusal.
    - In perf10c's REPORT they read killed 116 (PR-144 recovered kills) and error 58.
    - PR-283 scores more simply than LethAL (killed = any row fails; error = any notRun). So a c2 difference that
      LethAL's own rules explain (the R197 kill ledger, PR-250's cut, the withheld-kill recheck) is named per mutant,
      not a BLOCK. A difference those rules cannot explain is a BLOCK. The BC check follows later (lethal-bugs).
- **Expected totals:** surv 9,095 / killed 6,413 / error 1,167 / t-killed 7, plus no-coverage 26,829.
- Any other move is a BLOCK until named.

### Speed (replacing §4's 3-lane table; built from main's own readings, not perf10c's fork)
- **Tests sent:** about 2.37M, as in y3, perf10c and c1 (prefetch about 1.94M, live about 0.41M).
- **Per-test time on main through LethAL:** PR-274's arms read 20.8-38.3 ms depending on box load, 27.6 at 8 lanes.
  Central 28 ms (21-38).
- **Busy lane-s:**
  - tests about 66,400 (49,800-90,000);
  - per-request fixed cost about 490 (about 3,770 requests × 0.13 s, kept baselines; c1 on edge paid 7,900);
  - warm-ups about 5,900 (c1's; main has no #8446 either);
  - the bound check about 1,400 (c1);
  - **about 74,200 lane-s (57,000-98,000).**
- **Wall at N lanes, 97% busy as in c1:**
  - **6 lanes: about 12,750 s (9,800-16,800);**
  - 7 lanes: about 10,900 s;
  - 8 lanes: about 9,550 s.
  - Central (6 lanes): 0.76 s per covered mutant, −47% against y3 and −36% against c1.
- **Hard claims (BLOCK):**
  1. 0 unexplained verdict moves;
  2. kept baselines: at least 90% of serve requests report `baselineSource` `kept` or `cache` (c1: 0%);
  3. prefetch requests under 4,000;
  4. total `boundMs` under 2,381 s;
  5. mutant phase under 17,000 s (wide: the shared box's load moved PR-274's 3-lane pair by 35%).
- **Reported:** per-test ms against the box samples, the lanes the gate started and why, and lane busy shares.
