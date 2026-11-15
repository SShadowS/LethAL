# PR-21: L5, a resumed serve session reuses its stored baseline when nothing it measured can differ

Status: pre-commitment (coord PR-21, lethal-code, 2026-11-15), reviewed by lethal-bugs; relayed to lethal-preproc (R1008's owner).
Evidence: `/coord/handoff/PR-21/` (`gaps.ts`, `exp/do-snaps.ts`, `exp/`).

## Today

Since R1008, a resumed session on the serve default re-runs its whole baseline (`resumeRunsBaseline`, `allowReuse` false), because
the al-runner v3 backend needs its own baseline state: the rows per codeunit in run order (the warm-up compares the daemon's NONE rows
with them, R998's left-out run and L4's cut read their order), and the refused tests. On DO that costs about 1,986 s per window
(PR-18): coverage 574 s, compile 248 s, tests 53 s, and about 655 s of one-shot cross-check processes. The last part is R948's
cross-check of the daemon baseline: the 2nd, the last and every 10th codeunit also run one-shot (12 of DO's 110 codeunits, about 53 s
each, `t3.procs.tsv` of R-984; the serve trace does not show them, and 593 of the 596 s of gaps between its baseline requests fall on
one daemon).

R192's snapshot reuse already exists: a completed baseline is stored (`baseline_snapshots`) under the hash of the instrumented `.al`
tree (`batchHash`, the random artifact id left out) and the test app's hash, and found again with the dependency fingerprint, the
coverage mode and the server generation; `runMayLend` then refuses a snapshot whose run had another backend build (the run's
`runner_build`: al-runner version and binary sha256, `skip-after-timeout`, `baseline-daemon`, environment, license, isolation).
Not stored and not reused under isolation "auto" (R896) or `--isolate-tests` (R857).

## The change

1. A serve session may reuse a snapshot on `--resume` (R1008's condition lifted for serve) when every R192 key and `runMayLend` pass.
2. The snapshot also stores the backend's baseline state: per codeunit, its rows in run order (method, status, notRun, message), as
   the backend holds them (`baselineRows`). A snapshot without that state (stored before this change) is not reused on serve.
3. On reuse, the backend imports that state (as if its baseline calls had returned those rows), so the warm-up, R998, L4 and the
   refused-test lists read exactly what a re-run baseline would have given.
4. Before anything is served from the reused baseline, still inside the baseline phase, a CHECK on the session's daemon (lethal-bugs'
   review: the re-run of the whole suite is the main guard, the coverage sample is the extra):
   - every codeunit of the reused baseline runs once, unmutated (NONE), without coverage, and each row must equal the stored row:
     status, notRun, and the failure text with LethAL's minted app version masked (below). On DO this is the union warm-up's work,
     about 70 s;
   - three codeunits (the 2nd, the middle and the last, in baseline order) also run with coverage, and each test's coverage set must
     equal the stored one (a coverage difference does not show in a row).
   Each codeunit is re-checked in the mode the baseline ran it in (R890/R896's per-codeunit isolation, a test run alone, a one-shot
   codeunit one-shot) and with the same tests left out (R1004's refused ones); otherwise a mode difference would read as a mismatch
   and force a needless full baseline (safe, but it would hide the saving). The re-check's own refusals close daemons as any
   request's do (DO's ZipArchive tests are in it); the 300 s below allows for a few such restarts (lethal-bugs' trace: the
   whole-suite NONE request took 69-104 s with a 27-42 s compile).
   Any difference: the reuse is dropped, the whole baseline runs as today, and the session says which test differed and how.
   R948's one-shot cross-check processes do not run on a reused baseline (there is no daemon fill to cross-check): they are the
   655 s.
5. Every refusal to reuse says why by name (`resume-baseline-not-reused: <what> differs`): the instrumented source, the test app,
   the dependencies, the al-runner build, the transport, the isolation, the config, no backend state, or the check.

## Why no verdict can change

- **Same inputs, same baseline.** Everything a baseline measures is a function of the instrumented source, the test app, the
  dependency apps, the al-runner build and its options, and the config. Each is in the key or in `runMayLend` (the config through the
  run's resume key). al-runner is deterministic on identical inputs in everything a verdict reads:
  - the seed is fixed for the baseline (`seed: 1`, `seedSource: env` in PR-18's trace), and an early test's `Random`, `CreateGuid`
    and `Time` draws are the same across entries and requests with one seed (PR-20's seed probe);
  - install and company-initialize run on the cached install baseline (`serve --help`: keyed by build, apps, sources, target);
  - measured on DO: the three stored baselines (runs 1-3 of `dos3.sqlite`, 2026-11-14 17:21, 2026-11-15 03:31 and 08:13, one key)
    agree on all 1,979 tests: outcome, coverage set, and every other verdict field but one (42 failure texts differ only in the
    minted app version in a call stack: `version 30.0.20771.29933` vs `30.0.20772.5228`). A fourth, lethal-bugs' traced run
    (`/coord/handoff/PR-18/tr.sqlite`, a fresh store, 2026-11-15 11:28), agrees with run 3 on all 1,979: outcome and failure text
    (digits masked).
- **The minted version** (`<major>.<minor>.<days>.<halfSeconds>`, a new one per publish) appears in failure texts. No verdict reads a
  baseline failure text (a red baseline test covers no mutant); the check masks `version \d+(\.\d+){3}` before comparing.
- **What the key cannot see, and the check covers** (lethal-bugs' review):
  - the clock: a test that reads `Today`, `WorkDate` or `CurrentDateTime` could flip across a day, month-end or year boundary between
    the snapshot and the resume (DO's snapshots span 2026-11-14 to 15, no such boundary). The whole-suite re-check runs every test
    again on today's clock, so a flipped outcome falls back to a full baseline;
  - al-runner state outside the inputs: the contents of `ALRUNNER_CACHE` (demo data, downloaded apps), the license's expiry, the .NET
    sidecar and assembly dirs. The license file's hash and the environment are in the run build; the rest is not keyed, and the
    re-check is what sees a change;
  - a flaky or timing-dependent test: four identical DO baselines show none there; the re-check would see one that flips now. A test
    that flips only sometimes can pass the re-check and differ later; that risk exists inside every run and is stated in the reuse
    warning, as R192's is;
  - coverage: the re-check carries no coverage; the three-codeunit sample compares coverage sets, and DO's three snapshots had equal
    sets for all 1,979 tests.
- **Durations** are the stored run's, measured on the same build and inputs; budgets are derived from them as in that run.
- **Coverage** is the stored run's per-test sets, the same sets a re-run gives (measured above); the covering set of every mutant is
  therefore the same.

## Not changed

A session under isolation "auto" or `--isolate-tests` stores no snapshot and still re-runs its baseline on a resume. A fresh session
(no `--resume`) runs its baseline as today, with R948's cross-check.

## Red checks (both ways)

1. Identical inputs reuse: no baseline request beyond the check (a NONE request per codeunit without coverage, three with), no
   one-shot cross-check process, the warning `resume-baseline-reused`, and the backend's rows equal to a re-run's.
2. Each changed input re-runs by name: the instrumented source (one guard line), the test app, a dependency file, the al-runner build,
   the transport (one-shot), the isolation, the config, and a snapshot without backend state.
3. A re-check row that differs (any codeunit, not only the three) falls back to a full baseline by name; so does a coverage set of
   the three that differs.
4. The masked version: a failure text that differs only in the minted version passes the check; one that differs otherwise fails it.

## Pre-commitment

Fixture: Service Declaration as R1008's proof (`/coord/handoff/R-975/sweep-src/sd`, tests `/coord/handoff/R-882/src/sd-test`), with
isolation "test" (the config copied with that one change, since "auto" stores no snapshot), `--only
src/Processing/GetServiceDeclarationLines.Codeunit.al`, al-runner `current`, fresh stores under `/coord/handoff/PR-21/`.
- A: uninterrupted. B1: the same with `--time-budget` so it stops in the mutant phase. B2: `--resume` of B1.
- Predictions: (1) B2 prints `resume-baseline-reused`, runs the check (a request per codeunit without coverage, three with) and no
  other baseline request and no one-shot process; (2) B2's report equals A's per mutant (`bun scripts/report-diff.ts`: IDENTICAL,
  verdict and killing test); (3) B2's baseline phase is at most 50% of B1's (the fixture is small, so the daemon start dominates).
- B3: B2's store with one input changed (the test app's one test file touched by a comment) and `--resume`: re-runs its baseline and
  names the test app.

DO (no new window for this task; the next DO window after t4 measures it): the baseline phase of a resumed window falls from about
1,986 s to at most 300 s (one daemon start with its compile, the whole-suite re-check without coverage, three coverage requests, no
one-shot cross-check processes).
