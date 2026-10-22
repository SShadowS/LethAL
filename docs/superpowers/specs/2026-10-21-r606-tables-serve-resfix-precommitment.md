# R-606 tables pre-commitment: the table fixture on serve, patched and unpatched al-runner v3 at 93415c0bb

Drafted 2026-10-21 by the bugs lane's agent, BEFORE any leg ran. Nothing below has been measured on
these builds. The lane commits this file; the legs start only after the lane's go.

## 0. Coverage ON, not OFF (RULED 2026-10-21 by the orchestrator: coverage ON for all three legs)

The brief said "coverage off", as the CDO legs were. **Both references here were recorded with
coverage ON**:
- `packages/runner/itest/tables.baseline.json`: bcdev, fenced coverage; 314 killed / 70 survived /
  22 no-coverage.
- `packages/runner/itest/al-runner-v3.tables.baseline.json`: alpha.2 one-shot, `--coverage
  al-runner`; 290 / 57 / 59.

With coverage off, LethAL runs every test against every mutant and never scores `no-coverage`. So
at least the 59 (or 22) no-coverage rows would differ from a reference by construction. That
includes all 41 Commit rows of the known 52, whose reference verdict IS `no-coverage`. A per-mutant
prediction against either reference would then be a guess. On CDO, coverage was off only because
its oracle `bc3-A` was a coverage-off run.

**This pre-commitment therefore commits coverage ON (`--coverage al-runner`, read through serve's
`perTestCoverage`) for all three legs.** The orchestrator agreed: the references were recorded that
way, and coverage costs the same on every leg, so the comparison between legs holds. This fixture has
no multi-object file: the alpha.2 run records `multi-object admitted=false` with coverage `al-runner`,
so R407's guard does not interfere. §6 (coverage OFF) is kept below as written, but does NOT apply.

## 1. The builds (select BY PATH; sha256 checked before EVERY leg and logged on its first lines)

| Build | Path | sha256 |
|---|---|---|
| UNPATCHED (upstream main 93415c0bb, clean) | `/work/tools/al-runner-v3/local-93415c0bb-unpatched/al-runner` | `379a5fad88617096698ef70d3883d741920cd76d4321244d013ff0cda861eece` |
| PATCHED (93415c0bb + R-606 `resfix.patch`) | `/work/tools/al-runner-v3/local-93415c0bb-resfix/al-runner` | `f02a04ed358ec8c9ba25496767f2e9b30322a51934efedd4a30f49eb10e9acbf` |

Both print `al-runner 3.0.0-alpha.3 (93415c0bb)`. 93415c0bb carries upstream PR #5623 (merged
2026-10-21 17:20Z), which changes several results this fixture can hit (§7).

## 2. The fixture and the driver

- `fixtures/sandbox-data` + `fixtures/sandbox-data-tests`, from LethAL `lethal/r586` at `5eb544ef`
  (the scratch worktree `/work/lethal-wt/r606-cdo-scratch`, detached, nothing committed). 406
  deployed mutants. The one test codeunit is `Data Tests`, with 72 `[Test]` procedures.
- Driver: R-586's `scripts/r586-probe/run-fixture.ts` + `v2-shim.sh` (LethAL's own `AlRunnerBackend`
  and `runSession`, `--isolation test` as LethAL sends it). The selector ids are run-fixture's
  defaults (79199 / 79198 / 79197), as in R-586's tables run. No `--packages`: Library Assert and
  System come from the feed, as on alpha.2. `ALRUNNER_CACHE=/work/tools/al-runtime-rs/cache`.
- The measurement-only serve tap stays as it was on the CDO legs (scratch shim only, no bytes
  changed).
- Guards lifted: none expected. LethAL refuses resource-on-serve only for an app runtime below 14.0.
  Anything lifted will be named in results.
- A fresh store per leg, never `--resume`.

## 3. The legs (one at a time, each its own background job, ≤1 other heavy job container-wide)

| Leg | Build | Transport | Selector | Coverage |
|---|---|---|---|---|
| (c) | UNPATCHED | `serve` | RESOURCE | al-runner (see §0) |
| (a) | PATCHED | `serve` | RESOURCE | al-runner |
| (b) | PATCHED | `serve` | STATIC (control) | al-runner |

Run order: (c), (a), (b). Each leg logs to `/coord/handoff/R-606/tables/<leg>.log` as it runs:
build path, sha256, LethAL commit. A leg is never signal-stopped.

## 4. References

- **R-BC:** `packages/runner/itest/tables.baseline.json`. It is bcdev, identity scheme 38, and was
  reproduced live on bc1 by lethal-code (`/coord/handoff/R-583/gates/p2-tables-bc1.log`, `tables
  itest: PASS`).
- **R-A2:** `packages/runner/itest/al-runner-v3.tables.baseline.json`. It is R-586's alpha.2
  one-shot record, scheme 40: 290 / 57 / 59 over 406.
- **The 52:** `/coord/handoff/R-586/precommitment-tables-52.txt`, the alpha.2 v3-vs-BC rows by key.
  They are:
  - 41 rows from `Commit` refused under `--isolation test` (#5607). The three Commit tests are
    `CommittedWriteSurvivesFailure`, `CommitBeforeCodeunitRunSucceeds` and
    `CommitBeforeValueFormCodeunitRunSucceeds`; the mutants sit in `Data Commit Ops` and
    `Data Commit Target`. The reference verdict -> v3 verdict is killed/survived -> no-coverage.
  - 7 rows from the duplicate-key statement-form `Insert` not raising (#5603). They are
    `Data Key Probe.OnInsert` x5 and `Data Flag Ops.InsertTwiceWithKeyTrigger` x2 (remove-assignment,
    toggle-blank-string, swap-modify-flag), killed on BC by `DoubleInsertWithoutKeyTriggerRaises`.
    The reference verdict -> v3 verdict is killed -> survived.
  - 4 rows from TestPage running on v3 (BC's fenced session refuses it). They are
    `Data Value Card.OnAction` x2 and `Data Value Source.GetValue` x2, killed on v3 by
    `PageActionComputesNonZero`. The reference verdict -> v3 verdict is no-coverage -> killed.

## 5. Predictions per mutant (coverage ON), every leg

Comparison by run-fixture's `compareMutants` (verdict, killing test, coverage filter, mutated-text
hash), plus `scripts/report-diff.ts`, against each reference. Every kill carries `killReproduced`.

| Leg | vs R-A2 (alpha.2) | vs R-BC (bcdev) |
|---|---|---|
| (c), (a), (b) | **0 differences**, except rows that §7 names as open, each of which is reported by name | **exactly the 52 named rows, each in the alpha.2 direction**, except §7's open rows; no other row differs |

- Counts predicted: 290 / 57 / 59, and `baselineGreen=false` (the 3 Commit tests are not run at
  baseline and dropped as `unsupportedTests`), unless §7's open rows move.
- `killReproduced`: on **every** `killed` row of every leg. It is checked in the code: the v2
  `AlRunnerBackend` sets `killsMustReproduce = true` for every transport and selector, and the
  orchestrator calls `reproduceKill` at every kill site. A kill that did not reproduce is a finding.
- **The patch's claim, pre-committed:**
  1. **(a) EQUALS (c) per mutant**, on verdict AND killing test, all 406 rows.
  2. **(a) answers `cached: true`** on the requests that follow a mutant switch (the resource file
     changed, the source did not). **(c) answers `cached: false`** on those same requests.
  3. **(a) is faster than (c)** in wall time.
  - (b) is predicted equal to (a) per mutant. Its switch changes the source, so it answers
    `cached: false` there, like (c).

## 6. If the lane rules coverage OFF instead (NOT APPLICABLE: coverage ON was ruled, §0)

Only these predictions are made then:
- (a) equals (c) per mutant, on verdict and killing test.
- The `cached` and speed claims of §5.
- `killReproduced` on every kill.
- Every row R-A2 scores `killed` stays `killed`, because coverage off only adds tests. Its killing
  test may change, because the killer-first order differs without coverage.
- No per-mutant equality to R-BC or R-A2 is predicted for the other rows.

## 7. OPEN questions (stated, not predicted): what #5623 and serve could move

From PR #5623's text (`gh pr view 5623`, saved at `/coord/handoff/R-606/pr5623.json`), checked
against the fixture by name:
- **#5603. A test that ends while a duplicate-key `Insert` error is still deferred is now NOT RUN.**
  `DoubleInsertWithoutKeyTriggerRaises` ends right after `Data Flag Ops.InsertTwiceWithKeyTrigger`,
  whose second statement-form `Insert(true)` duplicates the key under those mutants. Unmutated, the
  key trigger assigns the key, so the baseline is not affected.
  - **Question:** do the 7 rows now read `error` (the killer not run) or `survived` (another
    covering test runs and passes)? Or do they read `killed`, if a later access raises the deferred
    error inside the test? A move of these 7 is reported per row and is not a regression.
- **#5610. A refusal no longer turns later failures of the codeunit into not-run, but only for
  `HttpClient` refusals.** The fixture has no `HttpClient`, and its refusals are the 3 Commit tests.
  - **Question:** does their refusal still turn later FAILING tests of `Data Tests` into not-run on
    `serve`? The v2 backend runs the whole suite per activation there. There are 47 `[Test]`
    procedures declared after `CommittedWriteSurvivesFailure`. Any row whose R-A2 killing test is
    one of those and reads `error` here is classed as this cascade. On alpha.2 one-shot, 0
    mutant-time refusals were seen.
- **#5575 (quoted filter in a CalcFormula is refused):** the fixture's one CalcFormula
  (`Data Main`, a `sum ... where (... = field(...))`) has no `filter('...')`. **No row expected.**
- **#5593 (`TestPage.Caption()` with a filter is refused):** no `Caption()` in the tests. **No row
  expected.**
- **#5576 (`extends <id>`):** none in the fixture. **No row expected.**
- **#5602 (compile errors now exit 3 / `compilationErrors`).**
  - **Question:** does v3's own check report an AL error on any instrumented batch? alc accepts these
    batches on the bcdev gate. If it does, the leg may stop or bisect; that is reported as found.
- **#5606 (company-open writer):** no `OnCompanyOpen` subscriber in the fixture. **No row
  expected.**
- **serve vs one-shot.** R-A2 is a ONE-SHOT record; the v3 table fixture was never run on `serve`.
  - **Question:** does any row differ only because of the transport? Classed as such when it is on
    all three legs and §7's other causes do not explain it.

## 8. Speed figures that will be REPORTED (named in advance, not targets), all three legs side by side

1. **Wall time:** run-fixture's `wall=`, from just before `runSession` to after `backend.close()`.
2. **Serve requests:** the `runTests` lines in `<leg>.serve-in.ndjson`, over all daemons. Also
   reported: daemons started (the `serve` rows of `<leg>.shim.tsv`), and summaries vs `{"error"}`
   lines.
3. **Median ms of a cached request:** the median of `wallSeconds * 1000` over the summaries with
   `cached: true`, with n. Beside it, **the median ms and n of the `cached: false` summaries**.
   - `cached` is read per request from that request's own summary line. Requests and summaries pair
     in order per daemon.
   - For claim 2, a "request after a mutant switch" is the first `runTests` after LethAL activates a
     new mutant. It is identified from the tap's request order and LethAL's events. If it cannot be
     identified exactly, the cached/uncached counts per leg are reported instead and the claim is
     read from them: (a) should have about one `cached: false` per daemon, (c) about one per mutant.

**Reference speeds, for context only, not predictions:**
- bcdev `itest:tables` on bc1: about 6 min (the lane's figure; the log does not time it).
- alpha.2 one-shot, coverage on: 114 s (R-586 `measure.md`).

## 9. A per-mutant difference is a FINDING, not a block

Each difference is listed with the leg, the mutant (key: procedure, operator, ordinal), what differs
(verdict, killing test, coverage filter, `killReproduced`), and one cause:
- the patch: on (a) only, not on (c) or (b);
- upstream main: on (c) too;
- the resource selector on serve: (a) and (c), not (b);
- the static path: (b) only;
- one of §7's open questions, named;
- not explained.

**An (a)-only difference is the one that matters most.** It would mean the patch answers a stale
resource on a real suite.
