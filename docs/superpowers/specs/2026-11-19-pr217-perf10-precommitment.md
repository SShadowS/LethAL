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
