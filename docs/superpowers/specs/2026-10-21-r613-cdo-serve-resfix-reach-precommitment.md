# R-613 CDO pre-commitment: the R546 slice on serve, on R-613's combined build

Drafted 2026-10-21 by the bugs lane's agent, BEFORE any leg ran. The lane commits it; the legs start
only after that. It decides the owner's PR ruling: **63 of 63 on leg (a) means GO.**

## 1. Builds (select BY PATH; sha256 checked before EVERY leg, logged on its first lines)

| Build | Path | sha256 |
|---|---|---|
| RESFIX+REACH (93415c0bb + R-606 `resfix.patch` + R-613 `reach.patch`) | `/work/tools/al-runner-v3/local-93415c0bb-resfix-reach/al-runner` | `79be72f4195f72c6c3656f3ee0be91b4f8bf9865dfe2bd58a7e7579b50a39102` |
| REACH-only (93415c0bb + `reach.patch`) | `/work/tools/al-runner-v3/local-93415c0bb-reach/al-runner` | `6400c58c8563b3fa870c5375d184bb18d9b2f75ebd4783940a2b3aefbb33a122` |

Both print `al-runner 3.0.0-alpha.3 (93415c0bb)`. Both hashes were checked at draft time against
their `SHA256SUM` files. R-613's `baseline-res.patch` is in NEITHER build. LethAL's selector reads
the resource at test time, not in the install baseline, so it is not needed here.

## 2. Slice, driver, legs (the slice exactly as in `932247bf`)

- CDO `5f2a71d`, from the read-only `/work/lethal-wt/cdo-r396`. It must be clean, with corpus
  fingerprint `aa47c61c1fcbb7e3`. This is checked at the start of every leg, and any mismatch
  refuses the leg.
- `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`,
  `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al`, ids 6175460 / 6175459 / 6175458,
  packages `Test/.alpackages`. A fresh store per leg, never `--resume`. **Coverage OFF** (`none`),
  because the oracle is a coverage-off run.
- Driver: R-586's `run-fixture.ts` + `v2-shim.sh` (LethAL's own `AlRunnerBackend`), from the
  scratch worktree `/work/lethal-wt/r606-cdo-scratch` at LethAL `5eb544ef`.
  - **No LethAL change**: only the measurement-only serve tap in the scratch shim.
  - **No guard lifted.**
  - The run-fixture out dir is in the scratchpad, so the instrumented CDO copies never reach
    `/coord`. It is deleted after redaction.
- Order (c), (a), (b). Each leg runs in **its own background job**, with ≤1 other heavy job
  container-wide; R-586's chain counts as one. Each logs as it runs to
  `/coord/handoff/R-613/cdo/<leg>.log`, and none is signal-stopped.

| Leg | Build | Transport | Selector |
|---|---|---|---|
| (c) | REACH-only | `serve` | RESOURCE |
| (a) | RESFIX+REACH | `serve` | RESOURCE |
| (b) | RESFIX+REACH | `serve` | STATIC (control) |

## 3. Oracle

`docs/measurements/r594/bc3-A.report.json`: live BC 28.4 on bc3, coverage `none`, 63 mutants,
**51 killed / 12 survived**, equal to R546 `bc-A` 63 of 63.
- It is redacted, so text compares are marker to marker. The results say how many rows were
  text-verified.
- The compare uses run-fixture's `compareMutants`, `scripts/report-diff.ts` and
  `scripts/r546-bucket.ts` on the REDACTED leg reports.
- Only redacted reports are kept: `redact-campaign-report.ts`, then `--check`.

## 4. Predictions, every leg

1. **Baseline GREEN: 21 of 21 tests pass, 0 not run.** There is no company-open refusal.
   - On 93415c0bb, the reach of the `OnCompanyOpenCompleted` subscriber was "not known" only
     because of a statement using a `[RunOnClient]` variable (an `Expr::Refused`) in a Microsoft
     Base Application routine.
   - `reach.patch` excludes such statements from the company-open checks.
2. **Per mutant: 63 of 63** equal to the oracle on verdict AND killing test (51 / 12 / 0), on every
   leg. The legs are equal to each other, 63 of 63.
3. **`killReproduced`** on all 51 kills of every leg. The v2 `AlRunnerBackend` has
   `killsMustReproduce = true` on every transport and selector, and the orchestrator calls
   `reproduceKill` at every kill site.
4. **Daemons: 1 per leg**, read from the `serve` rows of `<leg>.shim.tsv`, with 0 summaries
   showing `notRun` > 0.
   - If any suite run has a not-run row, LethAL's R517 close-on-notRun (R612) cold-starts the
     daemon. Then the daemon count is above 1. The results say that R612 fired, and read the cached
     figures per daemon.
5. **`cached`, per request.** Each request is paired, in order, with its tap summary and with its
   activation from the leg's store (`test_results` by id), as on sandbox-app. Repeat activations
   are counted separately.
   - **(a):** the first request of each daemon answers `cached: false`; **every request after a
     mutant switch answers `cached: true`**.
   - **(c) and (b):** every request after a switch answers `cached: false`. On (c) the resource is
     in the warm key; on (b) the source changes.

## 5. NAMED risks (findings if they happen, not predictions)

- **Refused code reached at RUN time (from R-613's own result).** Under `reach.patch`, a
  subscriber that actually ENTERS refused code at run time still gets `Signal::Unsupported`, and
  every test is NotRun.
  - A routine with a real lowering reason in the subscriber's reach, or in its direct calls through
    `blocked_reason`, still refuses every test before the first test runs.
  - If the baseline is refused, the results record the routine named in the reason, **by name
    only**, with no source text, and classify it as a FINDING.
- **#5623's own per-test rule.** The subscriber does write the database. So a CDO test that can
  READ a table it writes is still NotRun ("this test can read table <name>"), as in the invented
  repro's control.
  - If any of the 21 tests is NotRun for that reason, the baseline is not 21 of 21. The tests and
    the table are named, and it is a FINDING. It would also make R612 fire.
- **The 22nd install root.** alpha.2 and 93415c0bb printed "21 of 22 install roots ran to their
  end". That is not a refusal, and it is not expected to change.

## 6. Speed figures (named in advance, not targets), the three legs side by side

1. **Wall time:** run-fixture's `wall=`, the whole LethAL session from just before `runSession` to
   after `backend.close()`. It includes the baseline, every mutant's suite request, the confirms
   and the reproductions.
2. **Serve requests:** the `runTests` lines in `<leg>.serve-in.ndjson`, with daemons started and
   summaries vs `{"error"}` lines.
3. **Median ms:**
   - The median of the daemon's own `wallSeconds × 1000` over `cached: true` summaries, with n. On
     (a), this is **what a mutant switch costs on a real app with the patch**: a warm program, with
     only the resource refreshed.
   - The same over `cached: false` summaries, with n. On (c), this is **what a switch costs without
     the patch**: a recompile of the changed workspace. R-586 measured about 6.5 s per request on
     alpha.2 serve for this slice.
   - Both are the daemon's figures for running the 21-test suite, not a client round trip.

Context, not a prediction: R-586's alpha.2 serve leg with the static selector took 409 s; R546's
bcdev legs took 80 s and 53 s.

## 7. A per-mutant difference is a FINDING, not a block

Each one is listed with:
- the leg;
- the mutant (key: procedure, operator, ordinal);
- what differs: verdict, killing test, `killReproduced`, a `cached` value against its prediction,
  or a daemon count;
- a cause:
  - the resfix patch: on (a) only;
  - upstream main / the reach patch: on (c) too;
  - the resource selector: (a) and (c), not (b);
  - the static path: (b) only;
  - a named risk from §5;
  - not explained.

**An (a)-only difference matters most:** it would mean the patched warm path answers a stale
resource on a real app.

No CDO source text goes into any log, results file, message or commit: names and line numbers
only.
