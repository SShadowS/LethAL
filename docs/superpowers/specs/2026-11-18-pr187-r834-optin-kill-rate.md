# PR-187 (R834): the real kill rate of the opt-in operators `condition-true` and `blank-argument` — pre-commitment

Coord task PR-187, lethal-preproc, 2026-11-18. Measure only. Written before any run. Related: [[R834]].

## Why
R834 built `lethal.condition-true` (#36) and `lethal.blank-argument` (#34) as opt-in (coord R-868, f3b1c420). Their yield is
judgement only: "no kill rate, no live run". Equivalence was read from 12 sites each, about plus or minus 25 points.

## What is run (al-runner v3, offline; current = edge-4ebfe7913)
1. **DO**
   - Project `/coord/handoff/PR-67/do-app`, tests `/coord/handoff/PR-67/do-test-new`, config
     `/coord/handoff/PR-67/v3.json`.
   - The run is scoped to the two operators only (`--operator lethal.condition-true --operator lethal.blank-argument`),
     so every mutant is one of theirs.
   - `--workers 1`, `heavy-slot.sh --peak 8` (PR-179's lane guidance).
   - The comparison is DO y1 (`/coord/handoff/R-984/y1/y1.run.report.json`, same build, the default operators), with
     per-operator kill rates from that report.
2. **Two corpus apps from BC.History** (R890's trees, configs and packages): PaymentPractices
   (`/coord/handoff/R-882/src/pp` + `pp-test`, config R-887 `v3.pp.json`, packagesDir `/coord/handoff/R-886/bd/pkgs`) and
   ServiceDeclaration (`sd` + `sd-test`, `v3.sd.json`).
   - Each runs whole, with the default operators PLUS the two opt-in ones, so both sets' kill rates come from one run.
3. Every run carries `--progress-out`. A run's v3 hang check is its own `timeout-killed` count.

## What is measured, per operator and per project
- **Sites:** mutants generated (and refused or dropped, if any, by name).
- **Verdicts:** killed, survived, no-coverage, timeout-killed, error.
- **Covered kill rate** = (killed + timeout-killed) / (killed + timeout-killed + survived).
- **Cost per site** = the mutant phase's wall time (phase events) / the operator's mutants (DO: the whole run is these
  two operators; corpus: the cost is apportioned by `mutant-scored` durations).
- **Hand-read equivalent sample:** 12 survivors per operator, DO first, then the corpus. Each is read for "is this mutant
  equivalent (no test could kill it)?": yes / no / unsure. Recorded by names only (file, procedure, line, operator), never
  source text, under /coord/handoff/PR-187/.

## The decision rule (pre-committed, per operator, over DO and the corpus together)
- **Default-on** if all of these hold:
  - its covered kill rate is at least the MEDIAN per-operator covered kill rate of the default operators on the same
    projects;
  - at most 3 of its 12 sampled survivors read as equivalent;
  - 0 timeout-killed beyond what a default run of the same scope shows (hang-safe);
  - its cost per site is at most 1.5x the default operators' mean cost per site.
- **Drop** if its covered kill rate is under 20%, or at least 6 of 12 sampled survivors read as equivalent.
- **Otherwise stay opt-in.**
- Default-on needs the owner's word (principle 17: a default keeps everything, so a bigger default is a cost), and its
  frozen-gate effects need their own pre-commitment. This task only proposes.

## Predictions (R834's judgement, for comparison, not a gate)
- `condition-true`: R834 read 6 of 12 sites as real, so the equivalent share in a hand-read sample is about half.
- `blank-argument`: 6 of 12 real; noisy.
- On that reading both land at "stay opt-in" or "drop" on equivalence. The measurement decides.
