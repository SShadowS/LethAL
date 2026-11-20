# PR-217 (PERF-10) pre-commitment: one full DO run on al-runner perf-combined 2bb4b686 (candidate mode), vs y2 and y3

Committed before the run, after y3 (PR-204) was scored. Lane lethal-bugs, coord PR-217. Requests: /coord/handoff/from-alrunner/PERF-10-run-request.md and
PERF-10-what-to-record.md (followed exactly), plus the orchestrator's addition (y3 comparison, a candidate-mode control).

## Builds and what runs them
- **AFTER, the run:** perf-combined 2bb4b686 (base upstream 0e6397742; contents /coord/handoff/PERF-10/contents.md). Built in
  /coord/handoff/PR-217/combined (heavy-slot --peak 3), its .NET sidecar built from the same commit (`dotnet publish`, as the
  update gate does) into `bin-combined/dotnet-sidecar/`. A TEST build: LethAL's own work never uses it.
- **Plain base:** upstream 0e6397742, built the same way (`bin-base/`), for the moved-verdict reruns only.
- **The al-runner path is a wrapper** (`wrapper.sh`, installed as `bin-<build>/al-runner`): for `serve` it adds `--timings` and
  keeps each daemon's FULL stderr (`daemons/<utc>-<pid>.stderr`; LethAL itself keeps the last 64 KB); every 10th daemon runs
  under `perf stat -e instructions:u` (only after the PERFMON redeploy); other commands pass through. LethAL hashes the
  wrapper, not the binary: harmless in candidate mode (keyed by version line + that sha).
- **LethAL head:** the same as y3 (df6d0073; a detached worktree /work/lethal-wt/pr217, native parser rebuilt), so the y3
  comparison differs only in al-runner and candidate mode.
- **Driver:** `/coord/handoff/PR-217/run-perf10.sh` (y3's `run-y3.sh` with the above): fresh store `doperf10.sqlite`, triage
  first, `--workers 3`, `heavy-slot --peak 18 baseapp`, watchdog 20 GiB / 4 GiB headroom, budget 54000. It stops the run itself
  (SIGTERM, logged in `perf10.procs.tsv`) on any `al-runner-v3-defect-unlike-bc` line: `current` has none (a normal session
  refuses any), so any such line is a defect `current` lacks.

## Candidate mode (`LETHAL_ALRUNNER_V3_CANDIDATE=1`, `LETHAL_V3_PIN_FROM=edge-d72d3197d`, current's readings) — five differences
1. No pin check: no `warnFacts`, no `batchFacts`.
2. **Baseline batching OFF** (no `batchFacts`): the baseline phase and the wall are NOT comparable with y2's or y3's (both batched).
3. Pin readings (Sleep rule, serve-row fields) adopted from current's pin through PIN_FROM, as y2/y3 had them.
4. An `unlike-bc` contract defect warns instead of refusing. **STOP before the mutant phase** if the run prints an
   `al-runner-v3-defect-unlike-bc` line (current has none); the probe's summary line is quoted in the result either way.
5. The contract probe is never cached (a fresh probe each session).

## Other differences from y2/y3, named
- **Private compile cache** (`cache-combined/`): y2/y3 used the shared, warm /coord/handoff/R-942/cache; a test build must not
  write there. So the first compile of each kind is cold (dependency layers built once, then read).
- `ALRUNNER_LOGIN_REPLAY_CHECK=1` (per the request); `ALRUNNER_DAEMON_CLEAN_CHECK` NOT set.
- The recheck is on (PR-182), as in y3; y2 had it off. Verdict tables against y2 name the recheck's error->killed rows.
- **UTC midnight (#8457):** the run is started so that it ends before 00:00Z; if it cannot, every request's UTC day is recorded
  (events' `atMs`) and each daemon that crosses midnight is named.
- **samply 0.13.1** is installed since the 2026-11-19 PERFMON redeploy (q-20261119T094804-96e84ab3): 2-3 samply profiles of
  single daemons, named in the result. **perf stat on a hybrid CPU** (Core Ultra 9 185H: `cpu_core` = logical CPUs 0-11,
  `cpu_atom` = 12-21, counted separately): every perf'd daemon is pinned with `taskset -c 0-11`, so its count is
  `cpu_core/instructions/u` alone (checked: the atom line reads `<not counted>`). The other daemons run unpinned, as in y2/y3.
  A pinned daemon's own wall is not compared with an unpinned one's.
- **The .NET sidecar is built per commit** (combined and base each from their own `tools/dotnet-sidecar`): the sidecar source
  changed upstream between edge-4ebfe7913 and 0e6397742, so y2's DLL would not be the same code.

## The control (orchestrator): `current` itself in candidate mode, baseline only
`bin-current/al-runner` (the same wrapper over edge-4ebfe7913 and its own sidecar), private `cache-current/`, the same flags,
stopped by one SIGTERM at `baseline-batch-finished` (memory: baseline-only-run). It measures the unbatched baseline on the
current build, so the run's baseline and wall can be judged against a same-mode figure.

## y3's figures (PR-204, scored 2026-11-19: /coord/handoff/PR-204/scoring-draft.md)
y3 (df6d0073, edge-4ebfe7913, recheck on): 43,511 deployed, numbering digest b8e0a379433f (= y2's); baseline phase 584.2 s
(batched), 1,979 outcomes = y2's; mutant phase 23,928.2 s, 1.43 s per covered mutant; wall 28,222 s (the recheck about 3,650 s of
it); 48 restarts (25 after a refusal, warm-up compile 1,014.1 s; 23 after a timeout, 944.5 s); waits 27.1 s; verdicts killed
6,442, error 348, the rest = y2's; tree peak 12.21 GiB; rc 0.

## Predictions
1. **Mutation set:** 43,511 deployed; the numbering digest equals y2's and y3's (b8e0a379433f).
2. **Verdicts, by the full site key:**
   - against y3: 0 differences outside (a) mutants moved by upstream changes between edge-4ebfe7913 and 0e6397742, and (b) the
     recheck's own rows. Every moved mutant is rerun on the plain base (`--lines <file>:<line> --operator <op>`, joined on the full
     site key) and reported as y2 / y3 / plain base / perf-combined. **A verdict moved by perf-combined itself (plain base =
     y3, perf-combined differs) is a correctness question, explained before any speed figure.** Expected: 0 such.
   - against y2: the same table, plus y3's recheck class (error -> killed) named.
3. **Baseline:** unbatched, so longer than y3's batched phase; within ±15% of the control's baseline phase.
4. **Mutant phase:**
   - seconds per covered mutant at most y3's 1.43, central about 1.37 (the workspace cache cuts each daemon restart's warm-up
     compile to under 2 s: y3's 48 warm-ups cost 1,958.6 s of lane time, about 652 s of wall over 3 lanes, about 2.7% of the
     mutant phase), mutant phase at most 23,928 s, central about 23,250;
   - after-refusal and after-timeout warm-ups: median compileMs under 2 s, `workspaceCache` = `read`, except the first daemon
     of each lane (`built` or `miss`, named);
   - restarts: y3's 48 within ±5 (the keep list is LethAL's, unchanged).
5. **Per request** (raw, kept): every `setupParts` field, compileMs, engineMs, engineKept, baselineMs, baselineSource, testsMs,
   coverageMs, otherMs, resetMs, workspaceCache from the summary JSON; kept-sources hit by a low `sourcesMs`; per-codeunit time
   from tests' `durationMs` (row count: not reported by this build, left out); idle time between requests from LethAL's events.
6. **Login replay check:** its lines are template-checked; values withheld; counts reported.
7. **Lanes and memory:** 3 of 3 lanes; tree at most 18 GiB; no watchdog stop; no budget stop.
8. **Output:** s per covered mutant, wall, restart count and cost, the setupMs/compileMs/baselineMs totals, verdict counts, against
   y2 AND y3, each comparison labelled with what is fair for it (mutant phase: y3; baseline and wall: the control; verdicts: y3
   per mutant, y2 as asked); the moved-verdict table; the ranked "where the remaining time goes".

## Amendment 1 (2026-11-19, before any run; the replaced run request and the day's rulings)

The first start (14:42Z) stopped in triage, before any baseline: **the CLI has no candidate mode**
(`LETHAL_ALRUNNER_V3_CANDIDATE` is read only by the v3 itest). The owner ruled out a hand-written `.gated`
(q-20261119T144427-5d4d1763) and chose a reviewed private gate (q-20261119T144716-dff42cde): PR-226. The run request was replaced
(`/coord/handoff/from-alrunner/PERF-10-run-request.md`, the set-aside rule, owner option (a)). This amendment replaces
"Candidate mode", the wrapper, and the parts of "Builds" and "Other differences" they touch. Everything not named here
stands.

**Order of steps; each must hold before the next:**
1. PR-209, then PR-233, are on master.
2. **Private gate** of perf-combined 2bb4b686 with PR-226's `--root /coord/handoff/PR-217/root --local-candidate <binary>`, from a
   shell with no `LETHAL_*` variables. Its receipt is quoted in the result.
   - It must PASS. A held or failed gate stops PERF-10 and goes to the orchestrator.
   - Known beforehand: perf-combined's leg O1 reads HELD under `current`'s readings (PR-233: "held for PR-233's O1 pin"). A
     PASS therefore needs a hand pin for perf-combined's exact binary carrying `o1.partnerLoginRefusal`. That pin is its own
     pre-commitment, naming the binary, made only with the orchestrator's word. Nothing here writes one.
3. The run, then the control, then the moved-verdict reruns on plain base.

**What runs, replacing candidate mode and the wrapper:**
- LethAL points `alRunnerV3.path` at the gated copy `/coord/handoff/PR-217/root/builds/<tag>/al-runner`, never a wrapper.
  Session rules are a normal pinned session's: the pin check, the gate's own `.gated` facts, `unlike-bc` refusing, the probe
  cached.
- **Baseline batching** follows the gate's `.gated`: on when it carries `batchFacts` (a DBM leg that batched and passed), as in y3;
  off otherwise. The result says which. When on, prediction 3 becomes "within ±15% of y3's 584.2 s", and the control is still
  run as the same-mode reference for the wall.
- **The whole `lethal run` runs under `taskset -c 0-11`** (PR-226's ruling), so every daemon is on the performance cores
  (`cpu_core`). y2 and y3 ran unpinned on all 22 logical CPUs. **The control is pinned the same way**, so the fair speed reference
  for this run is the control (baseline, wall) and the same-mode y3 figures only with that named.
- **perf stat:** a small watcher attaches `perf stat -e instructions:u -p <pid>` to every 10th new `al-runner serve` pid and
  writes `<pid>.perf`.
- **Daemon stderr:** LethAL's own `alRunnerV3.daemonStderrDir` (PR-227) writes every daemon's FULL stderr to a file (`compile
  cache:` and `login replay check:` lines included). **Raw timings:** PR-227's `timings.extra` on `serve-request-timed` carries
  `setupParts` and `workspaceCache` from the summary JSON. So `--timings` must reach the daemon; how it is passed is named in
  the result.
- **LethAL head:** master with PR-227 and PR-233 (needed for the two items above), NOT df6d0073. The result lists every commit
  between df6d0073 and that head that touches `packages/runner/src`, and names which could move a verdict or a timing.
  y3's verdict comparison keeps the recheck class and those named commits apart.

**Set-aside rule (owner, the replaced request), verbatim in effect:**
- A mutant is SET ASIDE when any of its covering tests is NotRun with a reason naming "OnAfterLogin raised to the login
  subscribers of the partner dependency apps" (or "a read of a global of SingleInstance codeunit ... changed it before the
  first test").
- Set-aside mutants are left out of BOTH the verdict comparison and the speed comparison (seconds per covered mutant and every
  total), and reported apart: how many, which reason, and their y2 verdicts (killed / survived).
- **Prediction: 0 set aside.** Upstream main c5861dcd9, which carries f9116dc96, refused nothing over PR-223's 90 DO mutants
  (519 test rows). Any set-aside count above 0 is reported with its reason, and is not a failure of this prediction's purpose.
- Every other moved verdict is a correctness question explained before any speed claim, as in prediction 2.

**Comparisons:** speed against y2 (the request) AND y3 (the orchestrator), each labelled; verdict attribution per the request
(rerun ONLY the moved mutants on plain 0e6397742, reported y2 / plain base / perf-combined).

## Amendment 2 (2026-11-19, before any run; the orchestrator's two adjustments)
1. **One regate of `current`**, at master after PR-209, PR-236 (the private gate accepts the candidate's own pin) and the
   perf-combined pin (its own pre-commitment, `2026-11-19-pr217-perfcombined-pin-precommitment.md`) are all on master. It is run
   by lethal-bugs and also serves PR-209's moved readings (preproc's proposal). The private gate then runs at that commit.
2. **`--profile slim` for the run AND the control.** PR-209 turns two new operators on by default, which adds mutants. slim keeps
   y2's and y3's mutation set. **Checked in triage before the main run:** 43,511 deployed and numbering digest b8e0a379433f (y3's,
   = y2's). Any other count or digest stops PERF-10 before the main run; it is reported, not adjusted.
3. **LethAL head:** master after those merges (amendment 1 named "master with PR-227 and PR-233"; it is now that head, which
   also holds PR-209 and PR-236). The commit list against df6d0073 grows accordingly and is reported the same way.

**What happened since amendment 2 (recorded, not a prediction):** the first start (19:37Z) was stopped at 20:18Z by a restart storm
(a keep-list text reworded upstream, the Company-table refusal); the pair was widened with a kept-vs-fresh check (28/28,
master c3355859), and the run restarted at 22:36:11Z (tag perf10b) from master c3355859. The pre-run checks of amendment 2 held
on both starts. The private compile cache is warm from the stopped start.

## Amendment 3 (2026-11-19 ~23:55Z): ADDED MID-RUN, NOT A PRE-COMMITMENT
**Written at 77 minutes into the restarted run, from what the run showed.** The orchestrator's ruling, with its honesty
conditions. It is a reporting rule, decided after seeing data; nothing here predicts.

- **What the run showed:** 24 of its first 33 daemon closes were refusals with a text y3 never met (0 in y3's events and store):
  `Record.SetFilter(): a record handed by value whose view the probe did not measure (...)`, from al-runner's
  `al-vm/src/records/by_value_view.rs` (BY_VALUE_VIEW). It is present in plain upstream 0e6397742, in perf-combined and in
  upstream main c5861dcd9, and ABSENT at edge-4ebfe7913. So it is upstream's new refusal, not the fork's. y3 ran these tests.
- **The rule:** a mutant whose covering tests include a NotRun row with that refusal is SET ASIDE, the same way as the owner's
  O1 set-aside rule (amendment 1), and reported apart: how many, and their y2/y3 verdicts.
- **Honesty conditions (the orchestrator's):**
  1. this amendment says plainly that it was added mid-run;
  2. the result gives BOTH speed figures (over ALL covered mutants, and over those not set aside) and BOTH verdict tables (all,
     and with the set-aside), so the set-aside hides nothing;
  3. the restarts on this refusal and their warm-up cost are counted separately.
- **After PERF-10:** this refusal loses tests y3 ran, and the next `current` update brings it to every DO run. So: an upstream
  report (duplicate search first, invented repro, BC's answer on a leased server), and a keep-list candidate with the usual
  kept-vs-fresh proof.
