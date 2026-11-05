# R807 pre-commitment (R-807): one run seed, and al-runner 3.0.0-alpha.12

Written 2026-11-05 by lethal-bugs, before the build. Orchestrator's ruling: no build from alpha.11 on becomes
`current` until LethAL pins one run seed and the gate proves it.
Evidence: `/coord/handoff/R-807/probe.md`; the receipt
`/work/tools/al-runner-v3/failed/v3.0.0-alpha.12@10f9f63a7bc8610202cb6ec410dd917f3bf902e3/`; alpha.11's receipt in
`/coord/handoff/R-807/alpha11/`.

## What moved, alpha.7 to alpha.12
A masked diff of the two gate logs (durations, paths, hashes, core and CPU figures, timing lines, version line) leaves only:
1. **The run seed (ADR-061, since alpha.11).** Every one-shot run and every `serve` request now gets a fresh seed for
   `Random`, `CreateGuid` and SystemIds. The output gains `seed` and `seedSource`, and stderr a `Seed:` line.
2. **O1's CDO set stops at 18 package apps, pre-committed 17.** alpha.12 lists `Application` (0 files, from the folder),
   most likely PR #6944. There is no shadowing: every other app loads as on alpha.7 and alpha.11.
   `Library Variable Storage` and `Business Foundation Test Libraries` are declared dependencies, loaded from the
   artifact cache on all three builds. An empty cache drops them, which LethAL already refuses (R590).
3. **The dependency hint's text** (`--dep DIR`). `dependency-skip-line` still reads `matches`.
Plus `timeout-is-cpu`'s measured figures (still `matches`), and WorkDate following the clock on the own set.
No verdict moves. T is 318/70/18 with the same 48 rows; D1 and D1c have 0 differences.

## Why LethAL must pin
Measured on alpha.12 with no pin: a test failing when `Random(2) = 1` failed in 6 of 12 separate requests. LethAL compares
a baseline, a prefetch, live requests and one-shot calls, and these are separate requests or processes. Without a pin, a
value-dependent test can fail in a mutant's run for a reason other than the mutant, and two runs of one project can
disagree. Upstream's ADR-061 gives its impact runs one seed for the same reason.

## The change
- **One run seed: the constant `V3_RUN_SEED = 1`**, for every run of every project: baseline, prefetch, live, coverage
  windows, warm-up, one-shot, and the contract probe.
  - Why a constant and not one fresh seed per run: resume, lend, carried verdicts and `verify` compare results across
    runs, and those need equal values too. It is also upstream's own choice for its corpus CI.
- **Mechanism: `ALRUNNER_SEED=1` in the environment of every al-runner process LethAL spawns**, set explicitly, so an
  ambient value cannot win. Measured: alpha.11 and alpha.12 honour it on `serve` and one-shot; alpha.7 ignores it
  harmlessly. The `seed` field and `--seed` are refused by alpha.7, so they are not used. No per-build branch.
- **A read-back guard.** When an answer reports `seed`, it must read seed 1 with `seedSource` `env`. Anything else refuses
  the session by name. A build reporting no `seed` is accepted (alpha.7's values are fixed).
- **Recorded in the report**, as an optional run-seed value in the v3 execution context, so a run can be replayed with
  `--seed 1`. Absent on a build that reports no seed. It goes through the normal field ripple; older reports stay valid.
- **Pin `alpha.12-d4bc8d3a5`:** version `al-runner 3.0.0-alpha.12 (d4bc8d3a5)`, sha256
  `c406b57f178066ebbca3a66d7f6436730b2a1956292a7ccb6120479a93ec12cf`, on the shared `READINGS_8078BCF49`, plus a new
  optional pin field for O1's CDO package-app count: 18 here, default 17.

## What the seed means for kill confirmation
Under one seed, the prefetch run, the pair's NONE run and its M run all draw the same values for a test method,
because values derive from (seed, codeunit, method). So the only difference left between NONE and M is the mutant, and a
kill still means "the mutant did it". A test that depends on its values is stable under seed 1, whichever way it goes,
so the baseline decides it; finding such flakiness is upstream's stability mode, not LethAL's job.

## The gate proves it: a new sub-check in leg O1 (no new leg, `V3_GATE_LEGS` unchanged)
A small test in `fixtures/sandbox-order-tests` reads `Random`, `CreateGuid` and a new row's SystemId and reports them.
- **Pinned (LethAL's spawn environment, one daemon):** two separate requests read identical values. Must hold on every build.
- **Sensitivity (a daemon with the variable absent), on a build that reports `seed`:** two requests read different
  values, proving the check can see a difference. On a build that reports no `seed`, values are identical (alpha.7).
- **Read-back:** on a build that reports `seed`, the pinned answers read seed 1, `seedSource` `env`.
- Any failure is `gate-fail`. So a later build that ignores the variable, or reseeds, cannot pass unseen.

## Predicted figures
**On alpha.7 (`current`), at the merge, by `--regate`:** every leg passes, every figure unchanged, per mutant. O1's sub-check:
identical values with and without the variable; no `seed` reported.

**On alpha.12, the release path at the merge:**
- C: 8 `pinned:` lines; `codeunit-runs-whole` defect-present; `serve-keep-reasons` diverged as a warn line; `timeout-is-cpu` and
  `dependency-skip-line` `matches`.
- N1E: completed 36/0/0, 0 differences. S1, S1E, N1, N1S, X, L1, Y-A, Y-B, MO, WR as on alpha.7. K skipped as a candidate.
- O1: pass on both sets, 18 apps on the CDO set, CDO WorkDate 2026-08-01, commit kind "runs", the seed sub-check passing.
- T: "T: pinned 48 rows (pin alpha.12-d4bc8d3a5, #5603, #5607)", 318/70/18 over 406, 0 refused tests.
- D1 and D1c: 0 differences. Update gate `pass`, so `current` moves to alpha.12.
- The later K run: every leg passes with the pin applied.

The pinned seed changes the drawn values from alpha.7's, so a test depending on them could read differently. The gate's
fixtures read the same under fresh seeds, so none is predicted. Corpus runs outside the gate are not re-measured here.

## Judgement
Any verdict moving away from BC is a BLOCK. Any other reading off this file is a BLOCK until explained, in a dated
addendum, never an edit of this file.
