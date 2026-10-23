# Changelog

All notable changes to LethAL are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, the CLI surface,
the `lethal.config.json` schema and the JSON report shape may all change between releases.

Entries cite the `R<n>` id from the roadmap; `docs/roadmap/R<nnn>.md` carries the full evidence for
each one, and [`ROADMAP.md`](ROADMAP.md) indexes them.

## [Unreleased]

### Added

- **`al-runner-v3` can run mutants on a warm `serve` daemon** (R635). Opt in with
  `"alRunnerV3": { "transport": "serve-entries" }`; the default stays `"one-shot"`, unchanged.
  - **How it works:**
    - The baseline still runs one-shot.
    - Every covered mutant is then sent as entries of one `runTests` request on one compile. Each
      entry carries the mutant id as a resource override, and each mutant's group starts with an echo
      test that must report exactly that id.
    - The kill confirm and the reproduction run as small live requests on the same daemon.
  - **Refused by name, never scored:** a warm-up that disagrees with the one-shot baseline, a
    warm-up row R612's rule does not keep, a whole batch refused for one reason, and an answer the
    decoder cannot attribute.
  - **Measured on the CDO slice:** 164-200 s, against 495 s one-shot on the same edge build and
    53-80 s on bcdev. Every mutant's verdict equals one-shot's and BC's.
  - **`alRunnerV3.secondEcho`** (default on) adds an echo before each Sleep coverage window.

- **A new backend, `al-runner-v3`, for the Rust al-runner** (R586). It sat beside the .NET
  al-runner (`--backend al-runner`), which did not change; that backend was retired later (R654,
  under Removed). Select it with `--backend al-runner-v3`
  and an `alRunnerV3` section in `lethal.config.json` (`packagesDir` and a four-number `bcVersion` are
  required). It is pinned to `alrunner 3.0.0-alpha.2 (91253f2d6)` under `/work/tools/al-runner-v3/`,
  and it runs only a build whose `.gated` file names its sha256. It is NOT authoritative: v3 runs code
  that does not compile (#5602), a statement-form duplicate-key `Insert` does not raise (#5603), and
  `Sleep` returns at once on a virtual AL clock (#5605: the clock moves forward by the requested
  time, but a wait costs nothing and is never stopped). What LethAL does about each:
  - **Code that does not compile:** before v3 sees a batch, LethAL compiles the batch and the test
    app with alc. Before every run it checks that the files v3 reads are still the ones alc
    compiled, and refuses otherwise.
  - **Selection:** one `--codeunit` call per test codeunit, with rows matched by codeunit and method,
    so quoted test names work.
  - **Not-run rows** are never killed and never survived.
  - **Sleep:** a covering pass that reaches a project `Sleep` reads `error` / `runner-refused`. The
    Sleep index and v3's argv use the folders' real paths, and an index that joins no path of v3's
    coverage stops the session by name (`al-runner-v3-coverage-join-refused`).
  - **Platforms:** Linux only (the only platform measured); every other one is refused by name.
  - **`timeout-is-cpu`** is measured by the update gate's leg C alone; a session trusts the gated
    build's record and does not re-burn.
  - **Notes:** a kill made after another covering test of the same codeunit run carries
    `[v3-codeunit-state-possible]` in `failureNote`. A survivor beside a test v3 refused at baseline
    carries `[v3-refused-test-nearby]`.
  - **Not supported in this version:** one-shot only; `--workers > 1`, Windows, `serverMode`,
    `selectorMode` and `campaign freeze` are refused by name.
  - **Never lent across backends:** a v3 run lends history, resume verdicts and baseline snapshots
    only to a v3 session of the same build (`runs.runner_build`).
  - **Contract probe:** each session re-measures v3's wire contract (26 facts since R641 and r9: 9 defect, 16 contract, 1 warn).
    Two facts are judged against BC's own texts, measured on bc1 (`docs/measurements/r639/`): an
    upstream fix that fails a test with another text than BC's (`unlike-bc`, #5700) refuses the
    session by name, and a test v3 declines to run (`refused`, #5623) only warns (R641).
  - **A refusal never scores** (R641): a v3 row whose message starts `NotRun: out-of-scope:` but is
    written as a plain `fail` or `pass` reads `error`, never a kill, survive or pass.
  - **Update gate:** `scripts/al-runner-v3-update.ts` moves the pin only after
    `itest:alrunner-v3` passes. It accepts edge builds' SemVer build metadata, holds one lock over
    every gate path, and `--edge-rejudge <sha>` re-gates a kept edge binary at `.gated`'s current
    commit, without a download (R641).
  - **Report:** `executionContexts[]` gains `runnerBuild` and `binarySha256`.

- **On al-runner, a kill must reproduce** (R577). Measured: a Microsoft test that builds its input
  from a random amount fails about 1 run in 100 on its own, and LethAL scored that chance failure as
  a kill on every al-runner transport, because the only check was a re-run with no mutant, which a
  1% test passes 99 times in 100. Now, after that re-run passes, LethAL runs the killing test once
  more UNDER THE MUTANT, in the kill's own context and at the budget the killing run was sent. A
  second failure (any text) makes it `killed`; for a timeout kill, a second timeout at the same
  budget makes it `timeout-killed`. Anything else is `error` with the new cause
  `kill-not-reproduced`, never `survived`, and the covering loop goes on, so a later test that kills
  and reproduces still gives `killed`. A reproduction that is lost, cut by the deadline, stranded or
  run in a reused session keeps that cause. A reproduced kill carries `killReproduced: true` and,
  when the run had text, `reproducedFailure` (both optional, so the report stays schema v3, R157).
  **Cost, per kill:** one more activation and one more run of the killing test under the mutant.
  On one-shot that is one more spawn, with its compile. On `--server` it is one more WHOLE-SUITE run
  (the daemon runs the suite once per activation), plus a recompile with the static selector (the
  resource selector only rewrites its file). A timeout kill also waits out one more whole budget.
  Nothing for survivors. **`lethal explain` is schema v17** (`explain-v17.schema.json`;
  v16 is kept), because `kill-not-reproduced` is a new value of `notMeasured[].cause` (R233).
  **`--resume` on al-runner re-runs a kill recorded before this rule** (no `killReproduced`) instead
  of carrying it, and its warning counts such kills in their own words, apart from prior `error`
  verdicts. bcdev has the same rule since R582 (see Changed).

- **The report records which al-runner test selector produced its verdicts** (R558). R551 picks the
  selector once per session by a probe: `--test-exact` when the build accepts it, otherwise R488's
  substring with excludes. Until now only a warning line said which. The choice is now recorded on
  `validity.executionContexts[].testSelector` (`"exact"` or `"substring-with-excludes"`), with
  `testSelectorReason` (the probe's reason) on the latter. It is present only on directly-measured
  al-runner contexts, and absent on bcdev, on `--server`, and on verdicts carried by `--resume`. It
  is an optional field, so the report stays schema v3 (R157). The committed sample reports were
  deliberately NOT regenerated. The samples `schemas.test.ts` reads are bcdev reports, where the
  field can never appear. R546's two al-runner reports are records of a past measurement.

- **al-runner coverage can admit multi-object files, per build, by a frame probe** (R407). Upstream
  #5249 fixed the frame defect R383 measured on v2.12.0-main.c39ad5de (later objects reported
  against the SOURCE file). When `"alRunner.coverage": "al-runner"` meets a project with a
  multi-object file, `lethal run` now runs a small probe once, on the session's transport: a
  two-object file (a table with code, then a codeunit) beside a same-id source copy and batch copy.
  If every label is inside the bundle, the table has no hit and the codeunit's lines equal the
  measured set, coverage stays on and the index admits multi-object files; otherwise the run falls
  back to coverage `"none"` exactly as before. One warning line names the answer and the al-runner
  build either way. Measured: 43f76177 admitted on one-shot and `--server`; c39ad5de refused on both
  (label `src/...`, lines 12 early). Three backstops stop a run whose coverage does not look like
  the probe (`AlRunnerCoverageFrameError`): a label for an admitted file outside the deployed
  bundle, a `--server` scope its position contradicts in such a file, and a multi-object index built
  without the admission or before any deploy. The admission is never a config key. Costs about 5 s
  (one-shot, with its provisioning call) or 7 s (`--server`), only for such projects.

- **`lethal explain` lists each gap's covering tests with file and line** (R272). Every gap gains
  `coveringTests` (name, file, line, how many of its survivors each test reached, and the test's
  measured baseline duration) ordered by survivors reached, then by name; duration is shown, not
  used to order (R489). The report gains `testMethods`: each discovered test's location and its
  smallest per-test baseline duration measured in this run (al-runner's own per-test figure; bcdev's
  per-call wall clock; never a resume-reused or shared value). Both fields are optional; no schema
  version moves.

- **`lethal explain --suggest` adds a suggested fix kind per gap** (R273). A separate `suggestions`
  section, off by default and labelled as suggestions, not measurements: each gap gets
  `check-the-result`, `cover-the-branch`, `cover-the-statement`, `undecided`, `reader-marked` or
  `mixed`, derived only from each survivor's measured reach and coverage attribution. Everything
  else in explain's output is unchanged with or without the flag. Explain schema stays 13.

- **`lethal explain --project <dir>` shows each gap's source with its survivors marked** (R274).
  Every gap gains `source`: the block's lines and one mark per survivor (start and end line and
  column), as structured data. The report gains `sourceSha256`, the hash of the source generation
  parsed; explain recomputes it over `<dir>` and refuses by name, with nothing on stdout, on any
  difference or on a report from before this release. No source goes into the report. The output
  with `--project` holds target source. Explain schema stays 13 (an optional additive field).

- **A `reportextension` is mutated; identity scheme 17** (R254). Until now such a file was skipped
  as a non-carrier kind. BC reports a report extension's coverage as object type 22 under the
  extension's own id (measured on BC 28), and al-runner as its own Cobertura class, so both are
  attributed now; its members also get a variable scope, so the typed operators reach it. A
  reportextension beside another object in one file is still refused (`object-mix`). Tier 2 does not
  yet claim record calls inside one (R463). Measured: BaseApp (w1-28.6) gains 543 mutants in 13
  report-extension files, none of its other mutants moved, CDO none (it has no report extension). An admitted extension can share an
  object name with another object, and its mutants then take identity ordinals ahead of that one's,
  so keys can move for unchanged source: marks files need `"identityScheme": 17` after re-checking
  each mark (R325), and the first run on a project with report extensions does not carry the
  previous run's history once (R442).

- **The report names the loop steps R196 refused** (R447). A site an operator would have mutated
  but R196's hang check refused (the mutation writes a variable an enclosing loop's condition
  reads, so it could make the loop never end) is now counted per file as an `excludedSites` row
  with reason `hang-refused`. A row with sites makes `reliability` `narrowed`, adds
  `; N hang-refused site(s) in M file(s) not mutated` to `scoreDescribes`, prints a
  `HANG-REFUSED SITES` console line, becomes an `Ignored` entry in the mutation-testing export, and
  makes `lethal explain` withhold `gaps[].unobservedBlock` in that file. The count honours
  `--operator`, `--lines` and inactive `#if` arms. Only the hang-check refusals are counted; the
  loop-CONDITION literal refusals (R239) stay silent, as other operator refusals do. **Expect
  `reliability: full` to become rare on real projects.** Measured: Microsoft BaseApp has 1,463
  hang-refused sites and CDO Cloud 136, so any whole-project run over either now reads `narrowed`.
  That is the correct reading: those loop steps were never mutated, and until now the report did
  not say so. Operators opt in through the optional `MutationOperator.refusesHangCapable`; a
  plug-in without it is not counted. The report schema gains one enum value and the stream schema
  one optional property, in place: no version bump, and older reports still validate.
- **`lethal verify` says what a killing new test does to the rest of its procedure** (R259, verify
  schema v8). Every row killed by a new test carries `sameProcedure`: for each other survived or
  no-coverage mutant of the source run in the same procedure or trigger (by the manifest's line
  span, never by name), whether that test alone `alsoKills` it, it survived a run that included
  the test (`notKilled`), or the answer is `unknown`. Answers come from the named survivors' own
  runs when they prove the pair, else from one extra run of that test against that mutant in the
  same lease, counted against `--max-new-tests` as two runs (`overCap` counts the pairs left out). Reported only: never in `counts` or the exit code.
  `verify-v7.schema.json` is kept as published.

- **`SessionReport.buildSymbols`: the target's effective build symbols** (R381). The set the build
  used (config, the target `app.json`, and on al-runner its predefined symbols), sorted. Written on
  every new report, `[]` included, so `[]` means "built with no symbols" and absent means a report
  from before this change. `preprocessorSymbols` still holds the config set alone. The console
  report prints `build symbols beyond config: [...]` when the two differ (the al-runner
  `CLEANSCHEMA` run is shortened to `CLEANSCHEMA1..25`). Optional in the schema, so the report stays
  v3 and older reports still validate.
- **The verify JSON records the reach filter's state** (R425, verify schema v5). `reachFilter` is
  `{"state": "on"}` or `{"state": "off", "reason": ...}`, with one reason per R384 stderr text, and
  each planned `results[]` row carries `reachNarrowed`, true when the filter left at least one new
  test out of that survivor's request (the tests left out are `newTests[].test` minus `testsRun`).
  A missing field is unknown, never off: in v5 it means verify had not decided yet (an early
  refusal, or a row the filter never decided for). The version bumps although the fields are
  additive, because only the version tells "not decided" from "predates the record". v4 is kept
  as published. `packages/runner/src/verify-read.ts` reads both fields by that rule.
- **`lethal verify` sends a new test only to the survivors its coverage reaches** (R384). Under
  `fenced` coverage, verify reads each new test's coverage from the unmutated run it already makes
  and joins the test only to the survivors whose procedure (or, for a trigger, object) it ran, by
  the source run's own selection rule. A new test whose coverage cannot be used, and a survivor
  coverage cannot place, fail closed: they take every new test. A survivor's covering tests are
  never dropped. A survivor no new test reaches and with no covering test stays `survived` with
  `testsRun: []`. Off under the hub modes and `none`, and with the new `--no-reach-filter`. One
  stderr line states the filter's state; the JSON is unchanged (schema v4) (R425 records it, v5).
  Stated limit: state left by an earlier test in the same call, or code run in another session, is
  not seen.

- **`alRunner.selectorMode` and `alRunner.coverage` config keys** (R387). `selectorMode`
  (`"static"` or `"resource"`) picks R222's selector channel and `coverage` (`"al-runner"` or
  `"none"`) turns on R220's `--coverage`; neither was reachable from `lethal run` before. Coverage
  stays off by default (R394, under Changed, turns it on). When it is on, a project holding a multi-object file or a `#if`-wrapped
  object runs with coverage `"none"` instead, with one `al-runner-coverage-unsupported` warning
  naming the files and the reason (see R383 below).
- **One advisory line on an al-runner run** (R387): `[lethal] al-runner settings: ...` names each
  slow or unmeasured setting and the key that changes it. Until coverage is on by default it always
  names `coverage` (since R394 it names it only when the config sets `"none"`).
- **A file whose instrumentation throws is refused whole, and the rest of the project still runs**
  (R307). Before, one such file (an object mix, no object header, a statement the injector cannot
  place) aborted the whole run. Now LethAL tries each file on its own, skips the one that fails,
  and measures the others. The report shows it: an `excludedSites` row with reason
  `instrumentation-refused` (file, object kinds, site count and the reason), the caveat
  `files-refused`, the warning `instrumentation-refused-files`, and `reliability` `narrowed`,
  because the score then leaves that file out. A refused file's mutants carry no identity, so
  history, resume and equivalence marks skip them, and a warning says so. If EVERY file with sites
  is refused, nothing is left to measure and the run exits 1 naming each file. The explain document
  is now version 10. A mixed-object file is still refused whole: [[R299]] tracks per-object
  dropping. Instrumenting a file is now two steps, PLAN (decides the edits and every refusal) and
  EMIT (writes the text), and the per-file trial runs PLAN only. A dry run therefore sees every
  refusal a real run would, with one exception: the latch-owner and no-anchor refusals can first
  fire when the writer re-instruments a smaller batch of a file's mutants (see R419); EMIT can fail only with the RangeError "Invalid string length", a
  real-run crash. Measured on Base Application (dry run): peak memory 4520 MB against 4473 MB on
  master (+1.0%) and 4888 MB before the split; wall time +13.7% over master. Output is
  byte-identical to the build before the split.

### Changed

- **`--resume` and `--resume-run` now resume a closed-world run that ended before its
  post-execution check** (R601, R620). Before, such a run (a crash, Ctrl-C, any exception after the
  lease) kept its `|pending` test-app identity and was always refused. Now it resumes when it ran
  on the same server and the closed-world guard gives the same answer now. The resumed run's own
  check after execution confirms it, or revokes it. Any `lethal run` session whose check after
  execution flips, fresh or resumed, also revokes every run of the project still pending under its
  package (either closed tag) on its server, and its `closed-world-changed` warning names them. A
  refused revoked run now says its closed-world answer changed, not that the test app was
  republished. Every other case is refused in words that name the cause (the guard is open now,
  quoting why, or the answer, the test app or the server differs). **Open limits:** a server
  restart, or a dependent published and removed again, inside the gap between the crash and the
  resume is not seen (a probe is filed as R632); a guard open at a session's start and a
  `lethal verify` flip revoke nothing; the server key omits the tenant.
- **A loop fed by another object's stateful procedure is hang-refused; identity scheme 41, the number
  confirmed at merge** (R572). A loop whose exit reads a flag, a `var` argument or a call fed by a stateful
  procedure in another project object refuses that procedure's chain, the writers of its value path, and the
  guards in the loop body that decide whether such a writer runs (`r572-guard-writer`). A guard is refused as a
  single site, so its procedure's same-tuple twins renumber (measured on BaseApp: 34 ordinals moved, 0 tuples
  moved). History, `--resume` and marks recorded under scheme 40 are not carried.
- **On bcdev, a kill must reproduce too** (R582). R577's rule is now on for the BC backend: after a
  kill's unmutated confirm passes, LethAL runs the killing test once more UNDER THE MUTANT, and only
  a second failure (for a timeout kill, a second timeout at the budget the first run was sent) keeps
  the kill. Anything else is `error` / `kill-not-reproduced`, never `survived`. A kill at position 1
  re-runs as one single `RunMutant` call; a warm kill (R206) re-runs its call's prefix in one more
  `RunMutantMany`. **Cost, per kill:** about half a second for a failing test, and one more whole
  budget for a timeout kill, with a second `StopHungRunAt` stop whose outcome may not be confirmed
  (that scores `error` / `stop-outcome-unconfirmed`, not `timeout-killed`). Nothing for survivors.
  **Resuming a run recorded on bcdev before R582 re-executes every kill** (none carries
  `killReproduced`), which republishes and re-baselines nearly every batch: it is close to a full
  rerun, so start a fresh run instead.
- **al-runner coverage is ON by default** (R394). With no `alRunner.coverage` key, `lethal run
  --backend al-runner` now reads al-runner's own `--coverage` (R220): a mutant no green test
  reaches reads `no-coverage` instead of `survived`, and each mutant runs only its covering tests.
  This moves verdicts. On `fixtures/sandbox-app` the CLI default goes from 3 / 16 / 0 to 3 / 12 / 4
  (`SandboxPricing`'s four mutants, which no test calls), equal per mutant to the gate's coverage
  leg. `"alRunner.coverage": "none"` restores the old behaviour, and the advisory line then names
  it and what it costs. The coverage guard now runs on the effective setting, so a run that sets no
  key still gets the R407 frame probe and the R298 `#if`-wrapped refusal: a project they refuse
  runs with coverage `"none"` and one `al-runner-coverage-unsupported` warning, which now says
  coverage was "on by default" or "set by" the key and is turned OFF for the run (it no longer
  says a key the user never set is IGNORED). With the default, the advisory prints no coverage
  note. Measured prevalence of the guard: it keeps coverage on in every project of the three
  Continia corpora measured (27 projects), and turns it off in 15 of 519 BC.History projects
  (R579, R580). **`campaign compare` refuses an al-runner stage frozen under the old default** when
  that stage records its coverage mode (frozen since R355): the frozen side records `"none"`, a
  new run records `"al-runner"`, and R355 refuses the mismatch by name. A stage frozen before R355
  records no mode; it is not refused, but the result says "coverage mode UNVERIFIED" and lists the
  moved mutants as differences. Set `"alRunner.coverage": "none"` to compare against such a stage,
  or re-freeze it. The same setting keeps `--resume` of a run started before the upgrade working
  (otherwise R354 refuses it), and keeps `--skip-known-survivors` carrying survivors from an older
  store (otherwise the first run after the upgrade carries none).
- **Baseline and campaign comparisons see a mutant that changed under an unchanged key** (R556).
  A newly recorded itest baseline or frozen campaign stage records the identity scheme and a
  sha256 of each mutant's mutated text (never the text). Comparing then reports "mutated text
  differs under an unchanged key" as a difference, and a scheme change as "identity scheme
  changed", never a refusal. `campaign compare --json` gains an `identity` block beside
  `coverage`; `campaign freeze` refuses a redacted report. Existing baselines and stages are
  unchanged and still pass, with a line saying text is UNVERIFIED until they are re-recorded
  (R560 lists them).

- **al-runner one-shot runs use `--test-exact` where the build accepts it** (R551). Each one-shot
  al-runner session makes one extra call before the baseline (about 1.3 s on c5bbaf89, 0.15 s on
  43f76177) to ask whether the build parses `--test-exact`. If it does, each test runs as
  `--test X --test-exact X`, with no `--exclude-test`, and a result naming any other test is refused.
  If not, the run keeps R488's exclude-and-learn path exactly as before. One `al-runner-test-selector`
  warning names the choice. `--server` is unchanged and makes no extra call. R488's path is retired
  only when every supported build has the flag (R559).
- **Typed operators reach a trigger's header names; identity scheme 37** (R340). A trigger's
  parameters, plain `var` locals and named return are now typed by their own declarations (they
  were unknown since R330/R323), so `swap-additive` and `swap-call-arguments` gain sites in
  triggers (BaseApp +780 in trigger files, DC +59, DO +5, CDO +5, fixtures 0). The hang check now
  also refuses a loop write to a trigger parameter or named return, and `swap-call-arguments`
  refuses a swap whose argument an enclosing loop reads (a `var` write redirected away from the
  loop's variable never ends), in procedures too: BaseApp 560, DC 84, DO 20, CDO 9 such sites are
  no longer emitted. History, `--resume` and equivalence marks recorded under scheme 36 are not
  carried: a swap can now pick a different argument pair under an unchanged identity key. Known
  residual, as in procedures: a loop whose progress goes through a call argument or an indirect flag
  is not hang-checked (R196's exclusions, R531).

- **Tier 2 claims record calls inside a `reportextension`** (R463). A record the extension declares
  and a data item it adds (`addfirst`/`addlast`/`addafter`/`addbefore`) now resolve, so
  `remove-setrange`, `remove-testfield`, `remove-calcfields`, `swap-modify-flag` and the other
  Tier-2 operators reach those calls; Tier-1's RunTrigger tag drops where the receiver resolves.
  Still refused by name: a `modify(X)` block's record (resolving it through the base report gains 0
  sites on every corpus, measured), the extension's request page, and every bare `Commit()` in an
  extension (it may bind a base-report procedure). It also closes a hang hole: a table procedure
  called from an OPEN extension block through an untyped receiver (a bare `Proc()`, or `D.Proc()`
  for an added data item) is now followed, so its hang-capable mutants are refused. Measured
  offline on BaseApp: 62 such mutants were deployed (`ProdOrderComponent.Table.al` 30,
  `ServiceLine.Table.al` 32); hang-refused 44,126 -> 44,207, deployed -60 net (+7 Tier-2, -67),
  identity keys moved 0, so no scheme change.

- **bcdev scores `#if`-wrapped objects of the shapes measured on BC; identity scheme 36** (R497,
  R300; 35 is unused). Both BC coverage paths (fenced Code Coverage and the procedure hub) now
  score an object wrapped in `#if` when its file has exactly one object wrapper with no `#elif` and
  no nested wrapper, one object per arm (one or two arms, the same object in both), the compiled arm
  decided by the build's symbols, and at most one bare object before and one after it: the shapes
  measured on Cronus28 by R-300b. Fenced lines are read by the measured rule (an object is numbered
  from one past the previous COMPILED object, so an object after a wrapper owns the wrapper's
  directive and inactive-arm lines; the old rule put such an object 11 lines off in the probe).
  Every other wrapped shape stays refused by name, now naming the shape. A declaration in a
  compiled-out arm no longer refuses the same object compiled in another file; two compiled
  declarations of one object are refused by name; whatever the deployed index refuses is refused in
  selection too. `lethal verify` is unchanged (it still refuses wrapped objects). Measured offline:
  BaseApp 241 files with 5,987 mutation sites and DC 21 files with 320 move from refused to scored
  on bcdev (an upper bound: a file whose instrumented text is refused after deploy stays refused);
  CDO and DO have none. No key moves, but a key whose verdict was a refusal's `no-coverage` can now
  be scored, so history, `--resume` and marks recorded under 34 are not carried. A new gate,
  `itest:bcdev-wrapped` (`fixtures/sandbox-wrapped` on Cronus28, fenced and hub), pins it per
  mutant: 26 killed / 10 survived / 0 no-coverage.

- **TypeScript 7.0, the native compiler** (R437). `bun run typecheck` takes about 1 s (was 12 s),
  with the same strictness, measured flag by flag. 7.0 no longer ships the JavaScript compiler API,
  so the schema generator and four tests that parse TypeScript import it from Microsoft's
  `@typescript/typescript6` package instead. No product code changed.

- **A genuine hang on al-runner `--server` now takes the stop (180 s by default, was 60 s) plus a
  daemon restart** (R517).
- **`lethal explain` schema v15: the cause value `timeout-unconfirmed`** (R516). v14 is kept so a
  stored v14 document stays checkable.
- **`lethal explain` schema v14: the cause value `reused-budget-stale`** (R514). v13 is kept so a
  stored v13 document stays checkable.
- **More report-loop hang shapes are refused for every operator; identity scheme 35** (R500). The
  dispatch check of R501 now also refuses: a `Date` data item's code unless `MaxIteration` bounds it;
  procedures in OTHER project objects that open report-item code calls, one hop, with their
  same-object closure (codeunits, records and their tableextensions, interface implementers, and
  subscribers of events that code or a refused callee raises); a filter call on an open item's record
  made from outside the item; an unparsed or `#if`-split reportextension, which now counts as
  extending every report; and `CurrReport.P()` and bare procedure names in expressions as calls. Two
  stated limits: the writes, before the item, of a global the item's exit reads (with their guards and
  any earlier exit), and the OnPreDataItem filter of an item that inserts into its own table. An
  XMLport `Integer` element is a loop too, but dormant while xmlport files are skipped. Record callees
  are refused like codeunit callees although no measured hang is of that kind: a table procedure
  called from open-item code can hold its own `FindNext` loop, and they cost 0.16% of BC.History's
  mutants (measured against master 15c3a620). BaseApp's `Finance Charge Memo - Test` and `Reminder - Test` already loop forever, unmutated,
  on a document whose lines are all blank (DimensionLoop's `Continue` is never reset); LethAL refuses
  the mutants that could reach that state, but the hazard is BaseApp's own. Measured against master
  15c3a620 with production code, on BC.History: 23,944 deployed mutants removed (1.06%), 0 added, 165
  keys move, `skipped` unchanged on every project; CDO and DO lose 2 each; DC, the fixtures and the
  examples are unchanged. By shape, measured against master 15c3a620:

  | shape | removed | shape | removed |
  |---|---:|---|---:|
  | codeunit callees | 17,575 | code before the item (limit) | 803 |
  | record callees | 3,622 | `Date` items | 241 |
  | event subscribers | 1,057 | self-inserting item (limit) | 41 |
  | interface implementers | 605 | | |

  By operator, measured against master 15c3a620:

  | operator | removed | operator | removed |
  |---|---:|---|---:|
  | void-method-call | 5,225 | remove-not | 538 |
  | remove-assignment | 4,896 | conditional-boundary | 293 |
  | empty-block | 2,975 | loop-truncate | 280 |
  | negate-conditional | 2,150 | remove-testfield | 119 |
  | negate-guard | 1,273 | swap-modify-flag | 117 |
  | flip-boolean-literal | 1,075 | flip-filter-literal | 112 |
  | swap-call-arguments | 965 | swap-find-direction | 107 |
  | remove-setrange | 849 | swap-enum-member | 89 |
  | toggle-blank-string | 762 | validate-to-assign | 89 |
  | shift-integer | 744 | remove-calcfields | 63 |
  | return-value | 619 | toggle-blank-temporal | 44 |
  | swap-additive | 540 | loop-skip | 16 |
  | remove-commit | 4 | | |

  History, `--resume` and marks recorded under 34 are not carried: marks files need
  `"identityScheme": 35` after you re-check each mark (R325). Scheme 34 is R-343's. The shapes still
  not refused are filed as R520 to R532.
- **Every operator is refused in open report data-item code, and at a bounded item's only bound;
  identity scheme 33** (R501). One check at dispatch now covers EVERY operator, with no exemption:
  a site in an open `Integer` data item's code (R487's scope) is not mutated, and neither is a site
  that deletes or alters the `SetRange` call that is a bounded item's only bound. That includes the
  condition of a `CurrReport.Break` guard, the `Break` itself, `empty-block`, Tier 2's
  `remove-setrange`, `loop-skip` and `loop-truncate`. Such sites are counted as `hang-refused` (R447),
  and the hang-refused wording now names both causes (R196, R487/R501). A report column's source
  is not counted. Measured with production code on BC.History: 13,435 generated mutants (12,612
  deployed, after dedup) move to hang-refused, 0 appear, 0 change, and 378 keys move. CDO, DC, DO,
  the fixtures and the examples are unchanged. By operator:

  | operator | refused | operator | refused |
  |---|---:|---|---:|
  | void-method-call | 4,635 | return-value | 144 |
  | empty-block | 2,552 | flip-filter-literal | 72 |
  | negate-conditional | 2,233 | swap-call-arguments | 64 |
  | remove-not | 823 | loop-skip | 50 |
  | remove-setrange | 764 | swap-find-direction | 46 |
  | toggle-blank-string | 726 | validate-to-assign | 34 |
  | negate-guard | 593 | remove-calcfields | 33 |
  | conditional-boundary | 374 | toggle-blank-temporal | 29 |
  | loop-truncate | 192 | swap-modify-flag | 29 |
  | remove-testfield | 24 | swap-enum-member | 16 |
  | remove-commit | 2 | | |

  History, `--resume` and marks recorded under 32 are not carried: marks files need
  `"identityScheme": 33` after you re-check each mark (R325). Scheme 31 is unused. Known exclusions
  are unchanged and filed as R500.

- **`lethal verify` refuses a run whose test-app dependencies include a staged partner app**
  (R496). On bcdev, every app the dependency fingerprint hashes, partner and transitive ones too,
  must now have exactly one installed row at the version the server serves; before, only
  Microsoft's apps were checked. A partner dependency that is published but not installed (a
  staged upgrade) makes the run's digests unavailable, so verify refuses it by name
  (`dependency-unreadable`), and the refusal names the app and its served and installed versions.
  This is intended: a digest over a staged dependency would describe a package no test runs
  against. Each check is the per-app `$filter=id eq <GUID>` read, about 0.05 s per partner app; no
  committed fixture has one, so no gate moves. A BC API list read (companies, extensions) that is
  answered with a redirect now fails instead of following it, so a redirect cannot send an
  unfiltered extensions query. The same now holds for every request LethAL sends to BC (the
  shared BC fetch never follows a redirect, so the dev-endpoint package download and the control
  web service fail on one too); and `lethal doctor` now stops on a refused extensions query instead
  of listing it as one failed check. An activation call answered with a redirect counts as sent
  (its effect unknown, never retried), and a refused extensions query now stops the deployment
  check, the permission canary and the grouped run's progress watchdog instead of being reported
  as unavailable, inconclusive or "nothing yet". `run` and `runMany` also throw it at exit
  whenever any request inside the call was refused, even one a stop timer or a status read had
  swallowed, so a refusal can no longer end as a recovered or timed-out verdict; `runWithCoverage`
  does the same, and a refusal that arrives after its call has returned (a stop still pending past
  its bound) is thrown by the next call before it sends anything.
- **An open `Integer` report data item refuses every hang-capable site in its code; identity
  scheme 30** (R487, R493). In an open item (R484's bounds decide, see below), `remove-assignment`,
  `shift-integer`, `flip-boolean-literal` and `swap-additive` now refuse EVERY site, whatever it
  writes or reads. The rule covers the item's triggers, its child items' triggers and columns, a
  reportextension dataset block (`modify`, `add`, `addfirst`, `addlast`) whose base item is open or
  not in the project, and every same-object procedure that code reaches by name. A child of an open
  item counts as open. Two bound changes: an unqualified `Number := X` voids the certificates, and
  for an `Integer` item of a report that any project reportextension extends, only `MaxIteration`
  counts as a bound. A namespace-qualified `System.Utilities.Integer` item counts as an `Integer`
  item. Measured offline: BC.History 5,149 sites move from emitted to refused (0 released, 0
  changed), 203 keys move; CDO, DC, DO, the fixtures and the examples are unchanged.
  History, `--resume` and marks recorded under 29 are not carried: marks files need
  `"identityScheme": 30` after you re-check each mark (R325). Known exclusions, filed: code that
  runs before the item, other-object callees, items over ordinary tables or `Date`, XMLport
  `Integer` elements, reportextensions outside the project, and condition-side mutants.

- **al-runner scores a `#if`-wrapped object that is alone in its file; identity scheme 29**
  (R-300b, R300). al-runner (one-shot, `--server` and resource modes) now scores such an object,
  joining its coverage by the original file's line numbers (measured on both al-runner legs, two
  rounds). Admitted: exactly one one-arm `#if ... #endif` wrapper holding one object, with
  namespace, using and comment lines before it or inside it, and statement-level `#if`s inside the
  object. Declarations in a compiled-out arm are no longer indexed, and an object declared in two
  active files is refused by name. On `--server`, a statement in such a file whose own procedure
  name disagrees with its position is dropped, with a warning. If such a file's instrumented text
  re-parses with `#if` arms that cannot be evaluated, its mutants read `no-coverage` with that
  refusal named; they are never scored by the all-tests fallback, nor carried by
  `--skip-known-survivors` or a full-batch `--resume` before that refusal is known. Two-arm, nested and multi-object
  wrapped files, and every BC coverage path (fenced, hub, `lethal verify`), still refuse by name.
  No key moves and the emitted AL is unchanged, but a key whose verdict was a refusal's
  `no-coverage` can now be scored, so history, `--resume` and marks recorded under 28 (bcdev
  included) are not carried: marks files need `"identityScheme": 29` after you re-check each mark
  (R325). Measured offline on BC.History under an al-runner build: 137 admitted files with 6,984
  mutation sites move from refused to scored; CDO and the gate fixtures have none. A new
  `itest:alrunner` leg (`fixtures/sandbox-wrapped`) pins it: 22 killed / 9 survived / 3 no-coverage
  per mutant, with al-runner's `--define` measured to add to `app.json`'s symbols.

- **Trigger tags read `#if`-wrapped objects for the table they concern** (R485). A clean
  `#if`-wrapped tableextension or codeunit now keeps a `run-trigger-*` tag only when it extends or
  subscribes to THAT table; broken parses and other kinds keep the old any-table text check. On
  BaseApp one wrapped codeunit (Booking Manager) had kept the tag on every table: 331 tags drop (12
  `run-trigger-forced`, 319 `run-trigger-skipped-modify`), none on a table with an observer. No tag
  moves in CDO, DC, DO or the fixtures; no mutant identity moves.

- **A report data item over `Integer` counts as a loop for the hang refusal; identity scheme 28**
  (R484). BC calls a data item's `OnAfterGetRecord` once per record. Over the virtual `Integer` table
  the item ends only when a trigger calls `CurrReport.Break` or `Quit`, raises an `Error`, or a bound
  stops it.

  Such an item now counts as a loop unless one of three bounds holds:
  - a positive `MaxIteration` of at most 1,000,000;
  - a `const` or closed view filter of at most 1,000,000 records, with no other mention of the
    item's record in the report;
  - exactly one mention of the record, and that mention is a literal `SetRange(Number, lo, hi)` in
    its `OnPreDataItem`.

  In an open item, a write that its exit guards or its own range bounds read is hang-refused and
  counted.

  Measured against master: 609 BC.History mutants move from emitted to hang-refused (remove-assignment
  362, flip-boolean-literal 172, shift-integer 75). Nothing else changes, and no gate fixture moves.
  216 identity keys move, all in BaseApp, so marks files need `"identityScheme": 28` after you
  re-check each mark (R325).

  Most of these refusals are not proven hangs. In a hand sample about one in three was a real hang;
  the rest are the conservative direction. The shapes still not refused are listed in R487.
- **More loop shapes refuse a hang-capable mutant; identity scheme 27** (R480). R446 refused a
  write a body-exit guard reads only in a `while true` loop. Now: any `while`/`repeat` gets its
  body-exit guards unless its condition names a cursor method (`Next`, `Read`, `EOS`, `MoveNext`),
  which advances on its own; in a `while true` loop a write that FEEDS a guard's variable is refused
  too; and a write to an enclosing `for` loop's control variable is refused. Measured against master:
  257 mutants move from emitted to hang-refused (BC.History 154, DC 66, DO 25, CDO 12), nothing else
  changes, no gate fixture moves; 52 identity keys move (DC 12, BC.History 40), so marks files need
  `"identityScheme": 27` after re-checking each mark (R325). Still not refused, each a known
  exclusion: a cursor-named condition, a `for` end bound, `foreach`, `asserterror` as the only exit,
  `CurrReport.Skip`.
- **EXISTING EQUIVALENCE MARKS STOP APPLYING UNTIL YOU RE-MARK THEM** (R443). A mark in
  `lethal.equivalent.json` that holds only a `key` (every mark written before this release) is now
  refused (`no-proof`), because a key alone cannot show which mutant it was written for. Each such
  mutant is reported as a plain survivor again, so **a project's survivor list grows, and verify
  runs those survivors, once, until the marks are rewritten.** The score does not change (marks
  never moved it). To re-mark: run the project once with this release, run
  `lethal explain report.json`, and paste each survivor's `mark` object (key, `file`,
  `numberingDigest`, `fileSingleton`) over the old entry, keeping your reason. Every refused mark is
  named, with its reason, in the run's `EQUIVALENCE MARKS REFUSED` console lines and in
  `readerMarkedEquivalent.refused`. A report from an older
  release records no numbering facts, so explain prints no `mark` for it; re-run first.
- **`validate-to-assign` mutates a bare `Validate(F, V)` whose receiver it cannot spell; identity
  scheme 26** (R477; operator 1.2.0). R464 refused such a site where no receiver spelling (`Rec`,
  a dataitem's name, a `with` subject) could be proven to bind the call's record. The mutant is
  now the bare `F := V`, but only where nothing at the call declares `F` (no local, parameter,
  named return value, trigger local or object global, including inside `#if`); otherwise it is
  still refused. `alc` was used to measure which symbol each shape binds, and every emitted shape
  compiles. Measured against master `963ee476`: 47 new mutants (Intrastat 39, SAF-T 3, BaseApp 1,
  CDO 2, DO 2); 2 sites stay refused; DC, the fixtures and the examples are unchanged. No existing
  key moved in any corpus, but a new mutant can take ordinal 0 ahead of a same-tuple twin in the
  same procedure, so re-check equivalence marks.
- **A write a body-exit guard reads, in a `while true` loop, is hang-refused; identity scheme 25**
  (R446; 24 was R475, 23 is unused, 22 was R464). When a loop's condition reads no name and calls nothing
  (`while true`, `until false`), the four value operators now also refuse a write that the guard
  of any of its body exits reads: `exit`, `Error(...)` outside `asserterror`,
  `CurrReport.Quit`/`Break`, or a `break` of that loop. Such a write could leave the loop with no
  way out. The refusals are counted as `hang-refused` sites (R447). This is a scoped rule, not a
  proof that no mutant hangs; the shapes it still misses are R480. Measured against master `fc9ff10a`:
  BC.History 74 sites move from mutated to hang-refused (remove-assignment 55,
  flip-boolean-literal 11, shift-integer 6, swap-additive 2) and 16 keys move ordinal in
  `ItemJnlPostLine`; CDO, the fixtures and the examples unchanged.
  Re-check equivalence marks.
- **One implicit-record resolver; identity scheme 22** (R464; 20 was held for R-464 and is unused,
  21 is R459). Which record a bare name or a `Rec.`-qualified call binds to is decided in one place
  in the engine (`recordScopesAt`): a page's `SourceTable`, a TableNo codeunit's `OnRun` (`Rec`
  only), every enclosing report dataitem, and every enclosing `with` subject; a pageextension stays
  refused. So a qualified `Rec.Modify(true)` in a page or a TableNo `OnRun` is now claimed exactly
  as the bare `Modify(true)` was, and bare calls in report dataitems and `with` bodies are claimed
  on the record they bind to. `lookupVar` gains a precise guard: a record field wins over a
  variable only where AL binds it (a `with` subject's field over any variable, an implicit record's
  field over an object global, never in a table or tableextension) and only for a field the
  project declares. Measured on BaseApp, CDO, the other BC.History apps and every fixture: +3,928
  Tier-2 mutants; 250 `true` RunTrigger flips cede to `swap-modify-flag` at the same call, none
  orphaned; no hang refusal moves. Run-trigger tags: 12 dropped where the receiver now resolves
  and the real predicate proves the trigger absent (CDO Page 6175303 x2, EDocOrderLineMatching,
  ShpfyVariantImageExport x2, SubBillingActivities, CreateSubContractRenewal,
  ItemServCommitmentPackages, sandbox-probes LangRefusalRunner, SustExciseJnlPost,
  AITLogEntries, CommandLineTestTool), 1 added (DeleteExpiredSalesQuotes). Of R473's new skip
  tags, 231 move onto the replacing `swap-modify-flag` mutant: 198 keep a tag and 33 are untagged
  by its proof (four of those are a known under-tag, R476). No gate fixture moves. Re-check
  equivalence marks.
- **One source snapshot per run, and `--changed-since` diffs against it** (R205). `lethal run`
  reads the target's `.al` files and `app.json` once, before anything else, and every reader of
  them uses that copy: the `--changed-since` lines, the al-runner coverage guard, the selector-id
  check, `--dry-run`, the build and the app version an al-runner run records. Still read from the
  disk: the test project, the target's resources (`.xlf`, layouts) and `lethal verify`.
  An edit made during the run is not built; the run warns `source-changed-during-run`, naming each
  added, removed and changed file, and records no source hash. A source file that cannot be read
  stops the run, naming the file. Under `--changed-since`, a git-ignored `.al` file now gets
  mutants, consistent with alc compiling every `.al` under the folder, and a renamed or new path is
  selected whole. The refusal of an `.al` marked assume-unchanged or skip-worktree is removed: the
  index is no longer read for content, so such a file's edits are seen.
- **A two-argument `Insert(RunTrigger, InsertWithSystemId)` is mutated; identity scheme 21**
  (R459; 20 is held by R-464). `flip-boolean-literal` (now 1.1.0) used to cede every `true` of a
  claimed `Insert` to `swap-modify-flag`, which claims a sole `true` only, so the `true` literals of
  `Insert(true, X)` and `Insert(X, true)` were mutated by nobody (a `false` there already had a flip). Both operators now ask one engine
  answer for the sole-argument skip site, so the seam cannot orphan or duplicate a literal. The
  first literal is tagged `run-trigger-skipped-insert` / `run-trigger-forced` by the same rules as
  `Insert(true)` / `Insert(false)`; the second gets no RunTrigger tag (a SystemId mechanism for it
  is R472). Measured: BC.History +30 mutants, 7 gain `run-trigger-forced`, 9 keys move ordinal;
  CDO and the fixtures unchanged apart from the operator version in manifests. Re-check
  equivalence marks.
- **Identity scheme 19** (R468; 18 was R-458). Every object-level `var` section is now read
  (below), so call deletions move between operators, flips cede, hang-capable writes are removed,
  and 26 BaseApp swaps choose a different pair under an unchanged key: re-check equivalence marks.
- **Identity scheme 18** (R-458; 17 was R254). The hang refusal through implicit
  records and `with` subjects (below) removes mutants, and a later same-tuple twin of a removed
  mutant can take its key: re-check equivalence marks.
- **Identity scheme 16** (R-364; 15 is reserved for R-254). The hang refusal below removes
  mutants inside wrapped objects, and a later same-tuple twin of a removed mutant can take its key:
  re-check equivalence marks.

- **A skipped `OnModify` is now screened, and so are `ModifyAll`/`DeleteAll` RunTrigger flips**
  (R452). `swap-modify-flag`'s `Modify(true)` -> `Modify(false)` mutants carry the new
  `platformKillMechanism` value `run-trigger-skipped-modify` unless LethAL can prove that skipping
  the table's `OnModify` is harmless (no project modify subscriber or tableextension trigger), the
  same refusal detector R281 built for `Delete`. `flip-boolean-literal`'s `true` -> `false` flip
  of a Record `ModifyAll`'s third argument carries the same tag, and of a `DeleteAll`'s argument
  carries `run-trigger-skipped-delete`. The detector itself got stricter for both kinds: no
  `Modify` or `Delete` inside the trigger counts as harmless any more, a parenthesis-less
  split-header procedure call keeps the tag, and a bare `X.Y` counts as a field read only for the
  trigger's own `Rec`/`xRec` and its own table's fields. Verdicts and scores do not move; only the
  screen grows. Measured (probe, no `#if` arms): BC.History gains 22,523 tagged `Modify` mutants,
  188 `ModifyAll` and 846 `DeleteAll`; CDO 35 and 9; the fixtures one (unpinned `grammar-probe`).
  It reads only this project: a subscriber in another app, such as the test app, is not seen.

- **The results store no longer fsyncs on every commit** (R449). `lethal.sqlite` now runs with
  `PRAGMA synchronous = NORMAL` under WAL, SQLite's recommended pairing, and opening a new store went
  from a 238 ms median to 54 ms on Linux. A crashed or killed LethAL process loses nothing. An OS
  crash or power cut can lose the last few commits, but never corrupts the file, and a lost verdict
  row is a mutant that `--resume` runs again.

- **`lethal verify` refuses a test project nested in the target, by name** (R260, verify schema
  v7). The target build compiles every `.al` under its folder, so a test project inside it is part
  of the installed target app, and a test edit there used to read as `source-changed`. Verify now
  refuses `test-project-nested` before it builds anything when `--tests` lies inside the target,
  contains it, or cannot be resolved to a real path (symlinks and junctions are resolved). The fix
  is to move the test project beside the target, point `--tests` at it, run `lethal run` again,
  then verify. v6 is kept as published.
- **`lethal verify` sees a Microsoft dependency rebuilt or upgraded on the server** (R385). On
  bcdev, the dependency fingerprint in every test digest now hashes Microsoft packages by the bytes
  the server holds, as it already did for the others, over the whole closure (so a Microsoft app
  reached only through another counts too). It also always hashes `System`, hashes `Application`
  (by its id) when any app in the closure declares one, and hashes the dependencies of the
  `LethAL Control` app the server runs, today Test Runner, which runs every test. The control
  package is read from the server and must be the version the running control app reports. Each
  Microsoft app (except `System`, which is not an extension) must have exactly one installed
  version, equal to the package served, read by app id. Any failure refuses by name: the run
  records no digests (`test-digests-unavailable`) and verify refuses `dependency-unreadable`; it
  never falls back to declared versions and never treats every test as new. Cost: about 4.3 s per
  run and per verify, measured on Cronus284 (BC 28.4): 3.2 s to download 14 packages (68.9 MB),
  0.6 s for the per-id installed checks, 0.4 s to read the running control version. No cache.
  Stated limits, each of which verify reports as OLD tests with no warning: an installed app
  outside the closure, and a non-Microsoft dependency that is published but not installed (R434);
  a body-only rebuild of a symbols-only package, which is `Application` (0 `.al`, expected for a
  wrapper app whose dependencies carry the source) and the `LethAL Control` package (0 `.al`; its
  bytes are not hashed anyway); a service-tier update with no new `System` package (unmeasured);
  and the control app's own changes (its bytes are not hashed, or every control-app upgrade would
  make every test new). al-runner keeps Microsoft apps by declared version, under a tag that never
  matches a bytes digest (R435); verify is bcdev only. The test digest scheme is now `v3`, so every
  digest moves once: verify refuses, once per source run, every run recorded before R385 as
  `source-predates-verify` (the detail names both schemes); run `lethal run` again. The verify
  JSON schema stays v6.
- **`lethal verify` does not rerun a new test the reach filter sent to no survivor** (R427,
  verify schema v6). Every new test still runs once, unmutated, before the mutants. Only a test
  sent to at least one survivor runs again after them. A test sent to none reads the new
  `newTests[].state` value `not-rerun`, with its one fresh `pass` as `runs` (one entry, not two).
  Its stability is unknown and it is never `stable`, but it does not block exit `0`, because it
  is in no row's `testsRun` and gated no verdict. What is lost: a flaky test that reaches no
  survivor is no longer caught (`flaky`, exit `5`) in that verify; it is caught when a later
  verify sends it to a survivor. A test whose coverage cannot be used (a red or non-fresh
  baseline, no coverage) still joins every survivor, so it is still rerun. The schema bumps
  because a value domain grew; v5 is kept as published, so a v5 reader never sees `not-rerun`.
  The budget follows: check 2 (after the baseline) counts N + R + P extra runs, R being the new
  tests sent to a survivor, and its text is unchanged when R = N. Check 1 (before the lease, filter
  on) now refuses only when N, the one unmutated run per new test, exceeds the budget B, where it
  refused at 2N > B. So a run with N <= B < 2N now passes check 1. With at least one survivor to
  run it takes the lease, runs the N baselines, and may still refuse at check 2. With no survivor
  to run (S = 0, every named survivor skipped) it finishes with nothing run and `newTests: []`, as
  any S = 0 verify does. No verdict is wrong in either case; the refusal only moves later.
- **`--max-new-tests` budgets extra test runs, not new tests** (R384). The budget is
  `--max-new-tests` x (survivors + 2) extra test runs. With the reach filter off, the boundary is
  unchanged (more new tests than `--max-new-tests` refuses). With it on, verify refuses before the
  lease only when two unmutated runs per new test exceed the budget, and otherwise after those
  runs, before any mutant, when the runs left after the filter still do. No verify that passed
  before refuses now. The `too-many-new-tests` texts change; the refusal value does not.
- **`coverageFilter` takes an optional `warn` sink** (R384). `lethal run` prints the same lines.

- **The hang tag reads loop-condition operands in `#if` arms the build compiles, and only those** (R402). A `while (A < 10)` `#if X and (B < 5) #endif` tail is now read, so `B := B + 1` is tagged `loop-condition-target` under `X`. Tails inside a condition (call arguments, subscripts, list elements) are no longer read when their arm is compiled out. Directive symbols are never read as variables.
- **A file where a statement-level `#if` continues an unterminated statement is not mutated** (R402, R408). For example, `repeat ... until (A > 10)` `#if X or (B > 5) #endif ;`. The parser places the tail as a separate statement, and the instrumented artifact then failed alc (`AL0111`), taking down every mutant in its batch. Such a file is reported as `preproc-undecided` with the reason `directive-continues-statement at line N`, and it is still compiled and published. Measured on DC, System Application, Business Foundation and BaseApp: no file is refused by this, and no mutant, key or tag changes.
- **A file declaring more than one object still turns al-runner coverage off, for a new reason**
  (R383). Upstream #3713 (every object after a file's first was lost) is fixed. But on the pinned
  al-runner v2.12.0-main.c39ad5de those objects' lines come back in a mixed frame: when a source
  project with the same app id is reachable, a later object's line is reported as (previous object's
  end in the SOURCE) + (distance in the INSTRUMENTED text), so it can land in an earlier object.
  bcdev matched the admission's pre-committed table; al-runner did not. So the whole-run refusal
  stays, and the `al-runner-coverage-unsupported` warning now names that reason (and R300's for a
  `#if`-wrapped file). Position-based resolution of every row (both transports) is built and tested
  offline, kept off until upstream fixes the frame (R407). The rule is now: a file is refused
  unless every object after its first is code-free (a permission set, permission set extension,
  enum, interface or entitlement holding no procedure or trigger). So an enum then a codeunit is
  refused, which it was not before, since only kinds with a coverage identity were counted; a
  codeunit then permission sets is not. An object whose header is split by `#if` (one shared body)
  counts as an object that carries code, so a plain codeunit followed by one is refused too; such
  an object as a file's first is simply the first object. Two separate objects are never merged
  into one, so a second multiline `interface` with a procedure body is seen. Measured: no refused file is added or removed on DC,
  System Application, Business Foundation, BaseApp, Continia Document Output or the fixtures. A
  coverage row for a file the index skipped (multi-object, `#if`-wrapped, or with no
  indexed object) now stops at that file instead of matching a shorter path another file owns.
- **Three platform-kill tags ignore code the build compiles out** (R378):
  - **The tags:** `write-txn-codeunit-run` on `remove-commit`, plus `run-trigger-skipped-insert` and `run-trigger-forced` on `swap-modify-flag`. These tags are set from a whole procedure or from the receiver table's triggers.
  - **The bug:** a `Codeunit.Run`, a key assignment or an `Error` inside an `#if` arm the build does not compile could tag a mutant whose build never runs it.
  - **The fix:** each file's arms are now evaluated once and shared with every analysis (`SemanticContext.armOf`).
  - **Uncertainty keeps the tag:** a receiver table whose directives cannot be evaluated keeps both trigger tags. So does a primary key with no readable field list. The primary key is the first key the build compiles.
  - **Measured on the four R214 corpora** (DC, System Application, Business Foundation and BaseApp, both symbol sets): no mutant gained, lost or renumbered, no tag changed, and peak memory within 110% of master. Every frozen gate fixture is unaffected.
  - **Verdicts:** no verdict and no identity key moves.
- **al-runner runs now measure the preprocessor symbols al-runner predefines, every session**
  (R392): one one-shot al-runner run of a generated probe project, after provisioning and before
  anything is generated, instead of assuming the `CLEANSCHEMA1`..`CLEANSCHEMA25` list measured on
  v2.12.0 (R377). The measured set decides which `#if` arms are mutated and is the run's recorded
  build identity. A set that differs from the v2.12.0 list is used, with the named warning
  `al-runner-predefined-symbols-changed` listing what was added and removed. A probe that cannot
  give a complete answer REFUSES the run (`AlRunnerPredefinedProbeError`). `lethal run --dry-run
  --backend al-runner` now SPAWNS al-runner for the same probe (before, it was offline), and
  refuses by name when the config names no `alRunner.alRunnerPath`. The probe costs under 3 s
  per session (measured on v2.12.0: a dry run including it took 2.8 to 2.9 s in total), so it is
  not cached.
- **`lethal run --backend al-runner` defaults to its fast path** (R387): `serverMode` now defaults to
  `true` (al-runner's warm `--server` daemon, one per worker) and `selectorMode` to `"resource"`
  when the server is on (one compile per batch instead of one per mutant). `"serverMode": false`
  restores one process per test, with the `"static"` selector. An explicit one-shot plus resource
  is accepted but no gate has measured it. Verdicts are unchanged per mutant on the fixtures the
  gate measures; under `--server` a hung test becomes an error after one long suite deadline, not a
  per-test timeout.
- **BREAKING: an unknown key in the `alRunner` section is refused by name** (R387), listing the
  allowed keys (`alRunnerPath`, `packagesDir`, `serverMode`, `selectorMode`, `coverage`). A
  misspelled key used to be ignored in silence. `stubsDir` keeps its own message.

- **`lethal run` removes its temp scratch folder after a clean run** (R360): the installed
  batch's files now live in the results database, checked against a digest of the instrumented
  payload, so `lethal verify` refuses a run recorded before this build ("recorded before R360"):
  run `lethal run` again, then verify. A run that throws or is quarantined keeps its folder and
  names it. A finishing run keeps only the most recently published stored files for the same app
  on the same server, an environment deleted at env-tool teardown takes its stored files with it,
  and verify names what replaced them. `--resume` does not need the stored files and is unchanged.
- **The run's own outputs are no longer copied into each batch build** (R363): the results
  database with its sidecars, `--out` and `--progress-out`.
- **Runs now record a source digest per test, and `lethal verify` treats an edited test as new**
  (R-278, R258): an edited covering test gets the new-test double unmutated run and the flakiness
  gate, and an edited test that did not cover the survivor is now run against it. One-time cost:
  `lethal verify` refuses a source run from before this build as `source-predates-verify`; run
  `lethal run` again, then verify. On bcdev the digest is taken from the PUBLISHED test app, the body
  the server runs, not from disk (R372); where that source cannot be read the run records none,
  warns `test-digests-unavailable`, and verify refuses it. al-runner digests the source on disk.
- **`lethal verify` now sees an edit to anything a test reaches, not only the test method**
  (R-371, R371): the per-test digest covers the helpers, handlers and objects a test reaches in the
  test app, every event-subscriber codeunit and extension object and what they reach, the build inputs, and every
  non-Microsoft dependency by the SHA-256 of its package. A call the walk cannot follow makes the
  digest cover the whole test-app source, so it can only make a test new; so does a test-app object passed to code in another app (R386: on
  BaseApp Test every test is on the whole-source digest today). Microsoft dependencies are
  covered by their declared version only (R385, since changed: see its entry above). A Variant holding a test-app codeunit or interface that
  code in another app runs is not seen (R389), nor is a test-app codeunit whose id the test
  reads from the platform, such as an `AllObj` loop, or computes, such as `50000 + 101` passed to
  code in another app that runs it (R390). An unreadable test-app `app.json` is
  treated like an unreadable dependency. One-time cost: verify refuses a source run from
  before this build as `source-predates-verify`; run `lethal run` again, then verify. Verify refuses
  as `too-many-new-tests` when more tests are new than `--max-new-tests` (default 50) and names the
  number to pass (R384 is the filter large suites need), and as `dependency-unreadable` when a
  dependency package cannot be read. The verify JSON is now schema v4.
- **Runs now record the test app they measured against** (R247): `--resume` and `--resume-run`
  refuse by name when the test app changed since the run, a republish that only moved the version
  stamp included. One-time cost: an unfinished run from before this build is refused once, and the
  next `--skip-known-survivors` run skips nothing once.
- **Runs now record their coverage mode** (R354): an unfinished run from before this build is
  refused once by `--resume` and `--resume-run`, the next `--skip-known-survivors` run skips
  nothing once, and `lethal verify` (schema v3) refuses a source run measured under another or an
  unrecorded coverage mode.
- **Identity scheme 10** (R196, R239): mutants that can stop a loop from ending are no longer
  made. `remove-assignment`, `shift-integer`, `swap-additive` and `flip-boolean-literal` now refuse
  a site that writes a variable an enclosing `while`/`repeat` condition reads (these were tagged
  `hangCapable` and deployed before), and `flip-boolean-literal` also refuses a literal nested in a
  loop condition (through parentheses, `not`, `and`/`or`, or a `#if` tail) or in the condition of
  an `if` inside a loop. The refusal is silent, like every other operator refusal: no report field,
  warning or event changes, and `hangCapableCount` now reads 0 for built-in operators (the field
  stays for plug-in operators). Keys can move where such a site is refused: a later twin (same
  object, member, operator and code) takes the refused mutant's ordinal and its old key, and `M`
  codes after it renumber. Every older store stops resuming (`--resume` and `--resume-run` refuse
  it by name), the next `--skip-known-survivors` run skips nothing once, and marks files need
  `"identityScheme": 10` after re-checking each mark against a fresh report (R325).
- **Identity scheme 9** (R307, R374): identity ordinals are now numbered once over the whole run,
  not per batch. Before, two twin mutants (same object, member, operator and code) that
  `--max-guards-per-batch` put in two different batches both got ordinal 0 and shared one key, so
  `--skip-known-survivors` could skip one on the other's verdict. Keys move only where batching
  split twins; a one-batch run keeps every key. Every older store stops resuming (`--resume` and
  `--resume-run` refuse it by name), the next `--skip-known-survivors` run skips nothing once, and
  marks files need `"identityScheme": 9` after re-checking each mark against a fresh report (R325).
- **Identity scheme 8** (R405, part a): a procedure or trigger inside a member-level `#if` is now
  seen by arm in the symbol table, the table-trigger readers and the receiver filter. A call that
  was refused is admitted, and when the new mutant has the same tuple as an existing one earlier in
  the member it takes ordinal 0 and moves that one's key. Measured: no committed gate project
  changes; the synthetic twin in `r405a-identity.test.ts` does. Marks files need
  `"identityScheme": 8` after re-checking each mark against a fresh report.
- **Identity scheme 7** (R421): discovered file paths are now normalised to `/` on every platform.
  On Windows a project with subfolders gets the file order, mutant ids and batches Linux gets, and
  with per-batch ordinals an identity twin in another file can change ordinal. Existing marks files
  (`lethal.equivalent.json`) need `"identityScheme": 7` after re-checking each mark against a fresh
  report. History and resume from older-scheme runs are refused by name (R325).
- **Paths in reports** (R421): reports made on Windows before this version show `src\X.al`; from
  this version every platform writes `src/X.al`.
- **Identity scheme 6** (R418): a key's `codeunitName` can move in a file that holds a non-BMP
  character (an emoji) anywhere before a later comment or blanked string: in code, a quoted name, a
  comment or a string, and in a file of one object as well as several. The mask no longer shifts,
  so an erased header is found, a phantom commented-out header is gone, and a header offset
  matches the source. Existing marks files need `"identityScheme": 6` after re-checking each mark
  against a fresh report. History and resume from older-scheme runs are refused by name (R325).
  The same fix reaches two other places. Test discovery no longer refuses a test file ("lost 1 of
  1 [Test]"), or files its tests under the wrong codeunit, when an emoji anywhere earlier in the
  file shifted the blanking of a later comment. And the object-id collision scan no longer misses a
  real object id or reports one from a commented-out header.
- **Identity scheme 5** (R214): keys can move in any object that holds a `#if`. A mutant in an arm
  the build's preprocessor symbols compile out is no longer generated, a file whose directives
  LethAL cannot evaluate as alc does is not mutated at all, and a statement directly inside a
  statement-level `#if` is now a mutation site, so twin mutants renumber. Runs now record their
  effective preprocessor symbols (config plus `app.json`), and history, resume and equivalence
  marks apply only within the same set. Existing marks files need `"identityScheme": 5` after
  re-checking each mark against a fresh report, and a mark for a project whose `app.json` or config
  defines symbols needs `"preprocessorSymbols"` naming them. History and resume from older-scheme
  runs are refused by name (R325). Removing a site can still renumber a twin in another file, and a
  changed `#if` is one more way to do that, see R391. An al-runner run's set also includes the
  `CLEANSCHEMA1` to `CLEANSCHEMA25` that al-runner predefines (measured on 2.12.0, R377), so an
  al-runner run and a bcdev run of one project share no history; `run --dry-run` takes `--backend`.
  A mark for an al-runner run must list that whole set (the 25 symbols plus any the project
  defines); a mark without them covers only a build with no symbols, so one mark cannot cover both
  backends, and LethAL warns by name (`equivalence-marks-build-symbols`) when a mark's set differs.
- **Identity scheme 4** (R318): no key moves, but a renamed split member's coverage is now
  attributed, and a line two members share names nobody, so a verdict recorded under scheme 3 may
  say something this build would not. Marks files need `"identityScheme": 4` after re-checking each
  mark against a fresh report. History and resume from scheme-3 runs are refused by name (R325).
- **Identity scheme 3** (R323): keys can move in procedures with a named return value, where the
  fix adds or removes a typed mutant that shares an identity tuple with another one. Existing marks
  files need `"identityScheme": 3` after re-checking each mark against a fresh report. History and
  resume from scheme-2 runs are refused by name (R325).
- **Existing `lethal.equivalent.json` files need an `"identityScheme"` field** (R325), set to the
  report's own `identityScheme` (the current scheme, see above). Identity keys now
  carry a scheme version, because an engine change can renumber twin mutants and hand an old key to
  a different mutant with the source unchanged. A marks file without the field is read as scheme 1,
  so every mark in it is reported stale (warning `equivalence-marks-identity-scheme`) and none is
  applied, until you check each mark against a fresh report and add the current `"identityScheme"` at
  the top level. For the same reason, `--skip-known-survivors` skips nothing from a run recorded before this
  version, and `--resume` / `--resume-run` refuse such a run by name.
- **Report schema v3** (R231): mutant codes restart at `M0001` in every batch, so a bare code named
  a mutant only inside its batch, and on a multi-batch run a run-level list could point at another
  batch's row. These lists now hold `<batchIndex>/<mutantCode>` ids (for example `0/M0004`, the id
  `lethal verify --survivors` takes): `platformArtifactKills.byMechanism[].mutants`,
  `likelyEquivalentSurvivors.byRisk[].mutants`, `assertionScreen.flaggedMutants`,
  `assertionScreen.runnerRefusalMutants` and `unplaceableMutants`. `unplaceableMutants` also no
  longer drops one of two batches' same-numbered mutants. `readerMarkedEquivalent.matched[]` and
  `.contradicted[]` entries carry `batchIndex` beside `mutantCode`. `survivorsByProcedure` keeps bare
  codes, since one procedure's mutants are always in one batch. `lethal export` uses the same id, so
  a multi-batch export no longer repeats mutant ids. `lethal explain` still reads v2 reports, and
  `schemas/report-v2.schema.json` is frozen beside the new `report-v3.schema.json`.
- **A test that opens a TestPage only through a helper whose header is split by `#if` is now
  refused on bcdev** (R424). Before, the TestPage scan could not see such a helper, so the test was
  sent into the fenced session like any other. Now the scan walks the helper's body, and the test
  is refused like every other TestPage test, with a reason naming the helper. Its verdicts move
  where this applies: the test leaves the suite that runs, and the session's
  `baselineGreenOverall` becomes false, as for every TestPage refusal. The old silence was the bug.
  On al-runner nothing changes: the scan runs on bcdev only.

### Removed

- **The .NET al-runner backend (v2) is retired** (R654). The Rust al-runner, `--backend al-runner-v3`,
  replaces it. Upstream moved to the Rust runtime, and the .NET build gets no more updates.
  - **Refused by name, never ignored:** `--backend al-runner` (on `run` and `--dry-run`), a stored run
    of that backend (it lends nothing to history, `--resume`, `--resume-run` or snapshot reuse), and a
    report of it (`explain`, `campaign freeze`, `campaign compare`, `anchors`, `lethal export`). Each
    names `al-runner-v2-retired`.
  - **Gone:** `itest:alrunner`, its legs and its baselines; agentflow's `alrunner` leg; the startup
    canary (`alRunnerCanary` in the report) and the v2 stream events; v2's `--server` transport and
    its resource-selector mode; the v2 probe scripts.
  - **Moved to the v3 gate first:** the layout, symbol-set and CLI-default checks are legs L1, Y-A, Y-B
    and K of `itest:alrunner-v3`.
  - **Schemas narrowed in place** (no version bump): the report loses `alRunnerCanary` and the v2-only
    fields, the event stream its three v2 events, and `doctor` the `al-runner-only` caveat. Committed
    v2 reports are kept as history and no longer validate.
  - **`--workers` > 1 is now refused on every backend.** The .NET al-runner was the only one that ran
    workers in parallel ([R671](docs/roadmap/R671.md)).
  - **Known gaps left open:** a config `alRunner` section is still ignored without a word until the
    owner rules on its refusal, and an `envTool` section is ignored without a word on `al-runner-v3`
    ([R674](docs/roadmap/R674.md)). Leg L1 still sees a stale layout on v3, through both coverage-index
    guards together ([R666](docs/roadmap/R666.md)).
  - **The v2 tooling and its container wiring are gone** (R654 S5): `scripts/al-runner-update.sh`,
    `scripts/al-runner-bootstrap.sh` and the update script's test; the container's bootstrap step,
    `LETHAL_ALRUNNER_PATH` and the pinned c39ad5de build. The v3 update gate,
    `bun scripts/al-runner-v3-update.ts`, is the only al-runner update path.

- **The unused `MutationControlClient` and `postOData`**, left over from before the LethAL Control
  extension (R506).

### Fixed

- **`--skip-known-survivors` no longer lends a narrower run's survivors** (R585). A run now records
  its test scope (the tests its baseline is given, as `runs.test_scope`). History lends only when
  every test this session sends is in the source run's scope: an equal or wider run lends, a
  `--tests-only` run does not lend to a session over more tests (a survivor there may be killed by a
  test it never ran). A refusal warns `history-test-scope-changed`. Runs recorded before R585 have no
  scope and lend no history: the first `--skip-known-survivors` run after the upgrade executes every
  mutant. `--resume` already refused a scope change (the session fingerprint) and is unchanged.
- **`--resume` never carries a stored `no-coverage`** (R621). It is re-derived from this session's
  coverage: a mutant uncovered now reads `no-coverage` again, one covered now (say, after a target
  edit added a call to it) is run. So a fully scored batch that holds a `no-coverage` row is no
  longer carried whole: it is deployed, and its baseline comes from the saved snapshot when one
  matches (R192). This costs one deploy per such batch per resume; R643 files a cheaper variant.
- **LethAL no longer follows links (symlinks, junctions) when it walks a folder** (R631). Bun's
  recursive `readdir` follows them, so a link cycle hung or crashed with `ELOOP`, and a link out
  pulled a foreign tree into the run. Every walk now goes through one walker that never descends a
  link. alc and both al-runners DO follow a linked folder and a linked `.al` file (measured), so:
  - **A link in the target or test project now refuses by name** (`ProjectSymlinkRefusedError`),
    before anything compiles, in `lethal run` and `lethal verify`. This covers file links too (a
    linked README refuses). Links inside `node_modules`, `.git` and `.vscode` are excused (never
    followed); real files there are read as before. A link that appears during a run is reported
    as drift (`added link <path>`).
  - **An excused link that reaches a `.al` file still refuses.** alc compiles `.al` under
    `node_modules`, `.git` and `.vscode` (measured), so skipping such a link would hide source alc
    reads. The same holds for a link in a package cache (and for any link named `.alpackages`). A
    link whose folder tree is too deep to check (over 32 levels) refuses too. During a run, such a
    link is reported as drift.
  - **Package caches:** the package cache folder (by default `<project>/.alpackages`, or the
    configured `packageCachePath`) is not part of the project refusal, so a linked `.app` or a
    junctioned `.alpackages` runs. A linked `.app` is copied from its real path (a relative one
    used to dangle in LethAL's copy). A linked subfolder there refuses by name. A link whose
    target is gone is left out of the copy with a warning that names it.
  - **`lethal doctor`:** the al-runner cache size no longer counts files behind links, and says how
    many links it did not follow.
  - A new caveat, `project-symlink-skipped`, is a tripwire: it is raised if a folder LethAL builds
    ever holds a link it skipped. Explain schema v18 adds it to `$.caveats[].caveat`.

- **The assertion screen reads past al-runner's exception-type prefix** (R553). al-runner writes
  every failure as `<Type>Exception: <message>`, so the screen found no `Assert.` text on any
  al-runner kill and reported `vacuous` where bcdev, on the same kills, reported `partial`. On the
  al-runner backend the screen now reads the message with ONE leading `...Exception: ` removed; bcdev
  is unchanged, and the stored `killingTestFailure` is never rewritten. The backend is told by a new
  optional `kind` that each backend declares (stream schema gains it), not by `authoritative`. A
  `vacuous` al-runner screen whose killed kills include text without that prefix gets a note that
  names the backend as a possible cause, instead of blaming the suite. `caps` in the stream schema
  has `additionalProperties: false`, so a validator still holding the previous `stream-v1` rejects
  a new stream for the `kind` field alone.
- **bcdev no longer writes `lethal-control.app` into `packageCachePath`** (R552). alc now gets ONE
  package-cache path: a LethAL-owned directory (`lethal-pkgcache-<random>` under the temp
  directory), made once per backend, holding a hard link (a copy where linking fails with EXDEV or
  EPERM, which inside kraken and for a cache off C: on Windows is the usual case) to every `.app` in
  the user's cache, subfolders included, plus LethAL's own `lethal-control.app`. It is removed when
  the backend closes. The user's cache is only read. The leftover `lethal-control.app` an older
  LethAL left there (any case, any depth) is left out of the copy; it gets one warning (safe to
  delete) and is never touched. Any other link or copy failure is an `ArtifactPrepareError` naming
  the file. A `;` or `,` in that path is refused before alc runs, because alc splits its
  package-cache list on both. `scripts/campaign/compile-only.ts` and the `stale-publish` itest do
  the same.
- **`lethal verify` sees an edit to a test-app codeunit handed out in a Variant or interface**
  (R389). Code in another app can run a test-app codeunit it receives in a Variant (measured live),
  and a test's digest did not cover it, so an edit there left the test read as unchanged. The digest
  now traces what a handed-out Variant is assigned from, a Variant parameter through every test-app
  caller, and folds that codeunit, or every test-app implementation of an interface; a subscriber
  or folded codeunit handing a value back through a `var` parameter or its return value is read the
  same way, and so is a Variant handed to a built-in such as `Format` (whose text can carry the
  codeunit's id). Where the walk cannot see the value (a global, a collection element, a procedure
  the platform calls) the test takes the whole-source digest. A namespace-qualified name the test
  app does not declare now reads as a dependency's object instead of falling back. No scheme
  change: a test whose digest covers more, or that leaves the whole-source digest, gets a new
  digest and reads as new once (the safe direction), and every other test keeps its digest. Measured: 5 of 1,854 DC
  tests and 2 of 1,986 DO tests newly take the whole-source digest, CDO none; every DO test's
  digest moves once, because test-app codeunits implementing dependency interfaces now fold into
  every digest. A Variant parameter is traced through its callers only where no other app can call
  the procedure: always for a `local` one, and for a `public` or `internal` one only when the
  server reports that no published app depends on the test app (the new `DependentCount` action
  of LethAL Control 1.0.0.23, on bcdev; `internal` also needs no `internalsVisibleTo` in the test
  app.json). Otherwise (al-runner, an env-tool session, an older control app, an error, a
  dependent app) the test takes the whole-source digest: on DC that is every test. The answer is
  part of every digest, so a run and a verify that got different answers share no digest.
  `MIN_CONTROL_VERSION` stays 1.0.0.22.
  After the upgrade, the first run whose guard answers closed-world gives every test a new digest
  (the answer is a line in each one), so the next verify re-runs every test once. The guard asks
  about the package actually digested (the published test app), asks again after execution and
  keeps open-world digests unless the answer held, and is part of the run's test-app identity, so
  `--resume`, `--skip-known-survivors` and baseline reuse carry nothing across a changed answer.
  Until that recheck confirms it, a closed-world run and its baseline snapshots are recorded as
  pending and are never reused, so a run killed before it supplies nothing. Verify fails with
  `ClosedWorldChangedError` when the answer changed while it ran. Stated limit: LethAL assumes that
  no app depending on the test app is published, installed, uninstalled or unpublished between the
  first guard query and the post-execution recheck; the run does not detect a violation, and a
  concurrent publish already breaks the fenced run's assumptions in other ways.
- **al-runner: the resource selector is refused below runtime 14.0, and a run al-runner did not
  fully compile is never scored** (R583).
  - **The cause.** From upstream f23b9b5f, al-runner compiles at the app's own `runtime`. The
    resource selector calls `NavApp.GetResourceAsText`, which needs 14.0 (AL0666). On a
    runtime-13 app, al-runner drops the selector, but the tests still run against a dependency
    copy and can PASS (upstream #5573).
  - **The refusal.** `lethal run` (campaign stages included) and `run --dry-run` now refuse such
    an app by name before anything is instrumented, and `deploy()` refuses again. The refusal
    reads: `runtime <X> is below 14.0, which the resource selector needs (NavApp.GetResourceAsText,
    AL0666); set app.json runtime ≥ 17.0 or alRunner.selectorMode static`.
  - **The net.** A target-bundle diagnostic turns every row into `error`. That is a target
    `compilationErrors` entry, or a one-shot target-bundle `EMIT-ZERO`/`EMIT-EXCLUDED`/`PARTIAL-EMIT-DROP`
    marker. A diagnostic that cannot be attributed does the same, and the refusal names it as one.
    On the baseline it stops the session (`AlRunnerTargetCompileError`).
  - **What the net leaves alone.** A test-app entry keeps today's behaviour. A dependency's drop,
    such as Tests-TestLibraries, is scored anyway and reported as the warning
    `al-runner-dependency-emit-excluded`. It is a dependency only when a foreign module is named.
    `--server` cannot see such drops, because they print only on the daemon's stderr. So no
    warning there is not evidence of no drop.
  - **What the net closes.** `--server` used to ignore `compilationErrors`. That let the default
    transport score false survives from a bundle al-runner had refused.
  - **Runtime 17.0 everywhere.** Every fixture, example and probe app, and LethAL Control
    1.0.0.22, now declare runtime 17.0. `MIN_CONTROL_VERSION` is 1.0.0.22.

- **al-runner runs a test whose AL name it renames** (R557, upstream al-runner #5572). al-runner names
  a test row by the C# identifier BC's compiler gives the AL method, so `"Stone Quoted"` is
  `Stone_Quoted`, `"Dot.Name"` is `Dota46Name`, `"2Lead"` is `_2Lead`, and even an unquoted
  `Default` is `_Default`. LethAL sent the AL name, al-runner selected nothing, and the test read as
  a baseline `error`: every mutant only it would kill read `survived` (coverage `none`) or
  `no-coverage` (coverage `al-runner`), a false survive. DC has 248 such tests of 1,902. LethAL now
  sends and looks up BC's name (`alRunnerMethodName`: a space or `"` to `_`, a leading non-start
  character prefixed `_`, any other non-identifier character as `a<code>`, a reserved C# keyword
  prefixed `_`, format characters deleted), measured on 58 names on two builds. A session-suite test
  al-runner still has no row for now STOPS the session by name (`AlRunnerTestNameError`): on one-shot
  when al-runner selects nothing, on `--server` when its answer is otherwise clean (exit 0 or 1,
  every row a pass or fail run row) or when the test's own codeunit ran another test. A test in an
  `#if` arm LethAL could not decide (R403) keeps its `error`, with one
  `al-runner-undecided-test-missing` warning per batch. A new store column, `runs.al_runner_names`,
  marks every run an R557+ al-runner session creates; NULL (every older row) is untrusted. No al-runner
  run without the mark is trusted, nor a marked one whose baseline holds a renamed test as an
  `error`: `--skip-known-survivors` skips none of its survivors (`history-al-runner-test-names`),
  `--resume` carries none of its verdicts (stranded R53 keys included, so those mutants run again;
  the RESUMED banner names the reason, `resumedFrom.carryRefused`), and none of its baseline
  snapshots is reused (`resume-al-runner-test-names`). bcdev runs are unaffected. The R123 contract probe gains a seventh fact,
  `test-name-mangling`, which checks the rule against real rows once per session. Every test name in
  `fixtures/` and `examples/` maps to itself, so no existing gate's argv moves; the new
  `fixtures/sandbox-names` pair runs in `itest:alrunner` and in the new `itest:bcdev-names`.

- **A same-object callee's early exits are hang-refused** (R574). When R531 follows a loop's call into a
  procedure of the same object, or a table procedure on the record, it now builds that hop with R571's rule:
  an `exit` or `Error` before the callee's last consumer, or inside a callee loop that holds one, a `break`
  that leaves such a loop, their guards, and the assignments feeding the hop's guards are refused too. Before,
  `remove-not` on `if not Buf.FindLast() then exit;` was deployed and could hang the loop. Measured: Data
  Search -5 and BaseApp -19 mutants. No identity tuple or ordinal moved, and there is no scheme change.

- **A loop that consumes its record through a procedure in ANOTHER project object is hang-refused**
  (R571). R531 refused the consumers of a cursor loop's record (`while R.FindFirst()`, `while not
  Socket.IsEmpty()`), but followed a call only into the same object or a table procedure on the
  record. It now also follows the call into another project object: a parameter that receives the
  record counts as it (a by-value one for Delete, Rename and Modify only), and a call on a codeunit
  variable the loop tests by name makes that codeunit's globals the set, together with its calls to
  its own helpers that can see them. Refused in the callee: its consumers and their guards, every
  `exit` or `Error` that comes before the last consumer or sits inside a callee loop that holds one,
  every `break` that leaves such a loop, the guards of those exits, and the assignments that feed
  those guards. An alias made by `:=` whose `temporary` flag is known to differ from the loop
  record's is not followed: assignment never shares the table (measured on BC,
  `scripts/r571-assign-probe`). Filed limits: a second cross-object hop, the body of the callee's
  own helper, and a codeunit set matched by global name only (R576); `this.P(R)` in the same object
  and two variables of one SingleInstance codeunit (R575). Measured: DC Cloud -4, E-Document
  Core -24 and BaseApp -37 mutants, no identity tuple or ordinal moved, and no scheme change.

- **A loop that ends through a cursor procedure in another object is hang-refused** (R570). A
  `while`/`repeat` loop (any object kind) whose condition, or a body exit guard, calls a procedure
  in another project object that steps a cursor (`Find*`, `Next`, `IsEmpty`, `Count`, or a loop)
  now refuses every site in that procedure, and in every procedure its `exit(<call>)` chain reaches
  (up to 4 hops). Create Pick's FEFO loop, Sales Tax Calculate, TempStack.Pop and the Power BI
  report iterator are examples a sample showed can hang. A guard call is followed when the
  condition steps no cursor; when it does, only a guard call that shares the condition's record
  (its receiver, or a `var` argument) AND whose callee touches that record is refused. Touching
  means it moves it, filters, marks or changes rows, writes a key field or a field the loop
  filters on, calls `Modify(true)`, or hands it on to code that does, followed up to 8 calls
  deep; unknown counts as touching. Measured against master 259a5eae: DC 31 mutants removed
  (0.016%), BC.History 407 (0.018%; BaseApp 259, 0.036%), DO, CDO and fixtures 0; no identity
  tuple or ordinal moved. The same change fixes R531's hop into a `var` parameter named `Rec`
  (it never matched that parameter's consumers); measured on all 565 corpus projects it removes
  nothing. A loop flag fed by such a callee (R572) and a record consumer in another object (R571)
  are filed, not built.

- **A call to a preset writer of a report OUTSIDE the project is hang-refused; identity scheme 40**
  (R565, closes R561). R555 refused a call through `Report X` to a procedure that writes a name the
  report's open-item exit guard reads, but only when X was a project report: LethAL had only the
  dependency's symbols, which carry no procedure bodies. It now reads X's source from the dependency
  packages: on al-runner the provisioned platform-apps folder, then `alRunner.packagesDir`; on bcdev
  and envtool `bcdev.packageCachePath`. Per app id the first folder holding it wins, then its highest
  version there. A ReadyToRun wrapper is read only in the measured shape. X's dependency
  reportextensions are read beside it, and every outside report counts as extended (R487), since the
  project or an installed app may extend it. Nothing is written to those folders. When the source
  cannot be read (`not-found`, `no-source`, `ambiguous`, `unwrap-failed`, `no-symbols`, `unreadable`,
  `parse-damaged`, `base-not-found`), the call is checked as before, with a `dependency-report-source-unavailable`
  warning. The report gains `dependencyReportSources` and `dependencySourceSha256` (optional fields,
  so it stays schema v3). The digest is also recorded on the run, and history and `--resume` carry a
  verdict by key (rule 1) only when it is equal too. The refused set now depends on dependency bytes
  and a refused site renumbers its same-tuple twins, so history, `--resume` and marks recorded under
  scheme 39 are not carried. Measured with al-runner's 28.5 platform apps: Quality Management 7
  removed (R561's 5 sites plus 2 of the same shape), Application Test Library 15 removed and 2
  ordinals moved, 0 tuples moved; ten other projects unchanged. Limits: `--dry-run` on al-runner has
  no provisioned platform folder, so its refused set can differ from a real run's (it warns); a
  bcdev package cache can hold an older BaseApp than the server; a third-party package without
  source is not read.

- **A test temp folder that cannot be removed now names the file still locked** (R375). On Windows
  CI the full suite sometimes failed with `R358: could not remove ...: EBUSY`, and the R358 leak
  guard then failed too. The main fix was R449, which moved CI's temp folder off the runner's OS
  disk: 11 such failures in about 390 runs before it, 1 in 290 after, and none in the last 214.
  The test cleanup helper (`removeScratchDir`) passes `rmSync` the same retry options and fails
  the same way, but its message now ends with the files still locked and their error code, e.g.
  `still locked: lethal.sqlite-wal (EBUSY)`. The 56 `afterAll`/`afterEach` temp-folder cleanups
  in the test files now use it, or `removeScratchDirs`, which tries every folder in a list before
  failing.

- **A third-object procedure whose value decides when a report item stops is hang-refused** (R569).
  R500 refused a procedure of another object that open report-item code calls (hop 1), but not
  that callee's own calls into a third object (hop 2). `Export Item Budget to Excel` loops until
  `Item Budget Management`.NextRecord returns 0, and NextRecord's value comes from
  `PeriodPageManagement`.NextDate, whose 28 mutants were deployed; one keeps the step at 1 for ever.
  Now a hop-2 procedure is refused when its value reaches an open item's exit (a loop condition or
  a `CurrReport.Break`/`Quit` guard) through the hop-1 callee's RETURN value: its result, or a `var`
  argument the callee writes and returns. A `var` argument passed into another object from the
  exit's own trigger or procedure is not followed (a stated residual, measured at 906 in one report,
  0 hangs in the sample); one passed from a report procedure reached through its return value is,
  nor are events, globals set in another trigger, or a third hop. An `OnPreDataItem` Break guard
  counts too, a named over-refusal of 12. Measured: BaseApp -86 and PEPPOL -18
  mutants, the other seed projects 0, no identity tuple or ordinal moved, and no scheme change.
- **The loop-hazard check reads every name of a multi-name declaration** (R521). A declaration that
  names two variables at once declares both, but four readers took only the first: the type lookup for a receiver the
  symbol table does not index (an XMLport's variable), the local-shadow check, a report's open-item
  globals, and a base report's `protected var` names. PEPPOL's two XMLports declare their line
  iterator second, so the iterator implementations that end the line loop were deployed: 2 real
  hangs. Measured on all 138 corpus projects with a multi-name declaration: 26 mutants removed, all
  in PEPPOL's iterator implementations, none added, no identity moved. R521's other receiver
  classes and R520's general second hop are closed by ruling; R569 and R570 file the two hang
  shapes the measurement found.
- **A value fed into a report's preset exit name through another variable is hang-refused** (R532).
  R500 refused a write of a report global that an open item's exit or bound reads (`Continue :=
  ...`), its guards, and an early exit before it. A mutant one step back was still emitted:
  `Tmp := ...; Continue := Tmp`. Now, in the same procedure or trigger, every FEED of such a write is
  refused like the write itself: an assignment whose value flows into it by name (to any depth, an
  array element `Arr[1]` included), and a `var` argument, `Evaluate`, `Clear` or unknown call that
  writes such a name (`Compute(Tmp)`). It also covers an argument of a bare call that writes the
  preset name itself (`Evaluate(Continue, S)`), and an argument of a same-object setter whose parameter
  feeds it (`SetContinue(Tmp)`). Matching is by name, so it can over-refuse. A value that passes
  through another object's function (`Obj.Proc(...)`), or comes from another procedure, is NOT
  followed: R532 closes that part by ruling. A BaseApp census and a 15-site sample found no hang, and
  following it would cost 321 mutants. Measured: BaseApp -60 mutants, Withholding Tax,
  TestLibraries and the fixtures 0, no identity tuple or ordinal moved, and no scheme change. Not
  yet followed: a name read only as an argument of a platform method (`Continue := Cust.Get(Key)`),
  filed as R568.
- **An argument of a platform method in a preset write's right side is now a feed** (R568). R532
  stopped at the arguments of every `X.Proc(...)` call, so `Key := ...; Continue := Cust.Get(Key)`
  left `Key := ...` deployed. Now the arguments feed unless the receiver is typed as any object
  other than a record (a codeunit, report, page, query and so on) or is a record whose table or a
  project tableextension declares the member. Measured: BaseApp -1 mutant, Withholding Tax,
  TestLibraries and the fixtures 0, no identity tuple or ordinal moved, and no scheme change. Not
  followed: a platform method on an object-typed variable (`Rpt.SaveAsPdf(F)`, `Cu.Run(Rec)`).
- **A comment inside an argument list is no longer read as an argument by the loop-hazard check** (R567).
  `F(xRec /*c*/)` counted two arguments, so the hang check followed no overload of `F` (or a wrong
  one), and the callee's `SetRange` or `Delete` sites could be deployed. Every loop-hazard and engine
  semantic reader of a call's or attribute's arguments now uses one shared reader that drops comments
  (swap-call-arguments and testpage-scan keep their own filtering). When a `#pragma` or a parse error
  sits among the arguments, positions cannot be trusted, and each reader refuses more instead of
  guessing. A
  comment between an `[EventSubscriber]` attribute and its procedure no longer hides the subscriber.
  Measured on every corpus project with either shape: no mutant identity changed.
- **A loop-hazard HOP no longer refuses an overload the call cannot reach** (R564). R531's HOP and
  R562's FILTER HOP followed every overload of the called name whose parameter count fit, so an
  overload taking a different table's record was refused too. Now, when every argument is a record
  of a known project table, every parameter of every candidate is a `Record` of a known project
  table, no candidate is split by `#if`, and exactly one candidate matches the arguments' tables
  (compared as objects, not by spelling), only that one is followed. Anything less certain keeps
  every candidate, as before. alc confirms a `Record A` argument cannot bind to a `Record B`
  parameter, by value, `var` or `temporary` (AL0133). Measured: DO Cloud gains the 8 keys predicted,
  no key moves anywhere in DO, and the identity scheme stays 39.
- **A hook session whose test app has no `.al` source can now prove its identity** (R498). Before,
  the read-back after the env-tool hook was refused as `unavailable`, so such a run never resumed,
  skipped known survivors or reused a baseline. It is now proven when the served package's SHA-256
  equals the `publishApps` test-app file's (or, with no such file, by the installed checks alone),
  on top of the existing identity, version and installed checks. It still records no test digests,
  with the same one warning. Measured on Cronus28: the dev endpoint serves back exactly the bytes
  published, with or without `.al`. The env tool's own publish route is not measured; if it
  repackages, the run stays unproven.
- **A consuming loop whose filter is set through a call is hang-refused** (R562). Before an R531 loop
  whose ending depends on a filter, a call that sets that filter one hop away is now followed: a table
  procedure on the record (`Attachment.SetTemplateFilter(xRec)`, `Rec.SetFilters()`, or a bare call
  on the implicit Rec of a tableextension or a page with a `SourceTable`), a same-object procedure
  that sees it, the record passed to a `var` parameter of a same-object procedure or a project
  codeunit or table procedure, or `Codeunit.Run` of a project codeunit with a `TableNo` (its `OnRun`
  is assumed to receive the record itself; not measured). The callee's qualifying
  `SetRange`/`SetFilter` (or `MarkedOnly`), their guards, the callee's exits and `Error`s before
  them, and the call itself (its arguments, guards and feeds) are refused. A by-value record is not
  followed: its filters are the copy's. A call that cannot be followed, and `RecordRef.SetTable` of
  the record, is refused itself. R531's consumer HOP now resolves the implicit Rec's table the same
  way (`Rec.P()`, and a bare base-table procedure called from a tableextension or SourceTable page),
  which it missed before; `SetAscending` is now a built-in. Measured on the built branch: CDO Cloud
  15 deployed mutants removed (0.055%), DO Cloud 23 (0.079%; 8 of them an overload chosen by arity
  that the call never reaches, filed as R564), every other corpus project and every fixture 0, the
  shared resolver's effect on R531 0; 0 identity tuples and 0 ordinals moved, so IDENTITY_SCHEME
  stays 39.
- **A loop that ends only by consuming its record set is hang-refused; identity scheme 39** (R531). A
  `while`/`repeat` whose condition is a cursor test on a record (`Find`, `FindFirst`, `FindLast`,
  `FindSet`, `IsEmpty`, `Count`; never `Next`) and whose body consumes that set (`Delete`, `DeleteAll`,
  `Rename`, a refilter, a mark change, a `Modify` of a filtered field, a delete and re-insert, or an
  unknown call that may consume it) no longer gets the mutants that can stop it ending. Refused for every
  operator: the consumers, the blocks holding them and their guards; every operator but
  `swap-find-direction` in the loop's own condition; the pre-loop filters the ending depends on (so
  `swap-rec-xrec` in an OnRename filter on `xRec`); the same-scope assignments feeding those; and a
  consumer one hop away in a same-object callee or a table procedure on the record. A
  `repeat ... until Rec.Next() = 0` loop is unaffected. A callee's `Delete`, `DeleteAll`, `Rename` or
  `Modify` is followed through a by-value record parameter too, since it changes the real rows.
  Measured on the built branch: BC.History 984 deployed mutants removed (0.044%), CDO 9, DC 39, DO
  9, fixtures 0; 0 identity tuples moved; 47 ordinals renumbered (43 BaseApp, 4 System
  Application), so IDENTITY_SCHEME is 39. History,
  `--resume` and marks recorded under scheme 38 are not carried. Four sampled loops with a counter beside the cursor test are refused
  anyway (a known cost). A filter set through a table procedure and a refilter through a FieldRef are
  filed as R562 and R563.
- **Deleting a call to a procedure that sets a report's exit flag is hang-refused; identity scheme
  38** (R555). A report procedure that writes a name an open data item's exit guard reads (a
  "preset writer", directly or through other calls) is now treated like the write itself: its call,
  the guard around the call, the blocks holding it and an early exit before it are refused for every
  operator. This holds inside the report, from a reportextension calling a base procedure, and from
  any object calling the writer through a `Report X` variable (an extension's procedure too: alc
  binds it through `Report X`). An unparsed base or a parse-damaged report counts a callee as a
  writer only where its text declares `procedure <name>`. Measured on the built branch against
  master 9ff74df7: BaseApp hang-refuses 487 more deployed mutants (0.065%), 244 of them in
  `CostingErrorsDetection`, whose `AddError` sets the flag; every other corpus project and the
  fixtures are unchanged; 0 identity tuples moved, six ordinals renumber (a refused twin's sibling),
  so history, `--resume` and marks recorded under scheme 37 are not carried. Calls through a receiver
  that does not resolve to a project report are filed as R561.
- **A reportextension's reach into its BASE report is hang-refused, and a pageextension's bare
  `Commit()` that binds a base page procedure is no longer claimed** (R547, R548, R549). A bare
  (or `this.`) call from an open reportextension block to a base-report procedure is now followed,
  so that procedure's mutants are refused like any other one-hop callee (R547). Inside a
  reportextension, a write of a preset exit name (a base `protected var`, or the extension's own
  global its open block reads) is refused as it is inside the report, including through a `var`
  argument of a base procedure (R548). Measured on the built branch against master 0e017cb5: BaseApp
  hang-refuses 2 more deployed mutants (`MfgWhseSourceCreateDocument`'s `SetProdOrder`; hang-refused
  44,207 -> 44,209); every other corpus project and the fixtures are unchanged; 0 identity keys,
  ordinals or kill tags moved.
  `remove-commit` no longer claims a bare `Commit()` in a pageextension when a base page in the
  project declares a visible procedure of that name (R549; measured 0 such sites). Every same-named
  base counts, including `#if`-wrapped and split-header ones. A base outside the project keeps the
  old behaviour, a named residual in each item.
- **al-runner: a test row al-runner reports as `error` no longer aborts the session** (R534). A
  hang in a test codeunit's OnRun trigger is scored `timeout` and confirmed unmutated on the
  confirm's wall time (al-runner does not report the OnRun's own time). An unexecuted UI handler, a
  failing OnRun and similar rows are a per-mutant `error`, cause `runner-test-error`, and are not
  re-sent. A test that fails with al-runner's `out-of-scope: ` refusal (any exception type) is
  `error`, cause `runner-refused`, no longer a kill. Spec §11's abort is kept for real transport
  failures (R534). Explain schema 16 adds the two causes.
- **`lethal verify` reads a `#if`-wrapped object as the run did** (R536). Verify now hands the
  backend the build symbols its source run recorded, so the installed artifact's line map scores
  the wrapped shapes the run scored (R497) instead of refusing them with "Its mutants read
  no-coverage", and its reach filter refuses exactly what the run refused. A source run that
  recorded no build symbols is refused by name. Pinned by unit tests and the real backend's attach
  test; no live verify gate runs on a wrapped fixture (it changes which new tests run, never a
  verdict on its own).
- **al-runner one-shot: a test that hits its in-run stop is scored `timeout` again and goes
  through the unmutated confirm, so a genuine hang is `timeout-killed`** (R518). al-runner now
  exits 3 on a test timeout; LethAL read that as a failed run, re-ran the hang, and then ABORTED
  THE WHOLE SESSION (spec §11's two-consecutive-failures rule). Exit 3 is read as results only
  when every suite error is a test-timeout abort naming a test in the output. The contract probe
  now checks this shape in the CLI's pre-session probe and, inside a session, wherever the session
  pins al-runner's platform-app directory (the one-shot runs) (R518).
- **al-runner `--server` (and resource with `--server`) now stops a test at the larger of the
  `--mutant-timeout-ms` floor and the baseline timeout (180 s by default), sent as
  `--test-timeout` on the daemon's start line** (R517). It used al-runner's own 60 s default, which
  LethAL never set, so a test slower than 60 s under an unrelated mutant could be scored
  `timeout-killed`.
- **A timeout at position 1 is now confirmed on the test's own duration (al-runner's per-test
  figure, never the suite's or the process's wall clock), against the stop al-runner reports it
  enforced, when that is below the budget** (R517). On bcdev nothing changes. On al-runner one-shot
  a genuine hang is no longer lost to the compile time, once one-shot reports timeouts again
  (R518; that one-shot timeouts exit 3 was measured on al-runner 43f76177 only). A reported stop
  other than the configured one warns once per session (`alrunner-stop-mismatch`).
- **al-runner `--server`: a suite that overruns its deadline, or that contains a timed-out test
  (any row neither `pass` nor `fail`, whatever its wording), now ends that daemon; the next run
  starts a fresh one** (R517). Before, a late answer could be
  read as the next mutant's results, and a timed-out test's abandoned thread kept running into
  later runs, including the unmutated confirm.
- **Typed operators now mutate an object wrapped whole in `#if`; identity scheme 34** (R343). The
  symbol table left every object inside a file-level `#if` unindexed, so operators that need a type
  (`swap-additive`, `swap-call-arguments`, `remove-setrange`, `swap-modify-flag` and others) emitted
  nothing there, and said nothing. An object in an arm the build compiles, that parses clean, is now
  indexed like any other object (with its arm's own `namespace`, if it has one). An object in an
  inactive arm, in a file whose arms cannot be decided, or with a parse error stays unindexed, and
  R-364's hang refusal still guards it. Measured on BaseApp (BC.History w1-28): 546 wrapped objects
  now indexed, and none left unindexed in a live arm; on DC 21. A few identity keys move (BaseApp: 4;
  the fixtures, CDO, DC and DO: none). `itest:alrunner`'s wrapped leg now holds 36 mutants, and each
  wrapped file must equal its unwrapped twin in both directions.
- **On bcdev and al-runner one-shot, a timeout at group position 1 is now confirmed by one
  unmutated run on every batch, not only a reused one, and on the worker that saw it** (R516). The
  kill stands only if that run takes at most half the budget (R53's margin); otherwise the mutant is
  an `error` with the new cause `timeout-unconfirmed`. A warm replay uses the same half-budget rule.
  With the default `--mutant-timeout-ms`, a test that overruns its budget even unmutated is
  abandoned at the deadline on bcdev (an unmutated run has no stop), recorded `in-flight-unknown`,
  and the tier is quarantined; never a kill. Known lost-kill bands, never a false kill: a genuine
  hang can be reported `timeout-unconfirmed` where a test's budget is twice its measured duration
  (above the floor), and on al-runner one-shot wherever compile plus the test's body takes more than
  half the budget (R516). The cost is one unmutated run per position-1 timeout: on bcdev one
  `RunMutant` call (the test's own duration), on al-runner one-shot one full invocation, compile
  included. al-runner `--server` is not covered (R517).
- **al-runner one-shot now gives a test its whole budget in-run (it had half) and the process twice
  the budget, so a slow test no longer times out under every mutant** (R516). A genuine hang now
  takes the full budget to stop (180 s at the default, was 90 s), and a confirm there is a full
  invocation, compile included. A baseline run's in-run limit moves from 60 s to 120 s at the
  default baseline deadline, so a test whose body takes 60 to 120 s is no longer non-green there.
- **On bcdev and al-runner one-shot, once a confirm measures a test slower than its budget allows,
  later mutants in the same batch and worker are budgeted from that measurement** (R515). A kill is
  still judged against the budget its run was sent. On al-runner `--server` (and resource with
  `--server`) the re-budget is skipped: the daemon stops a test at its own 60 s whatever the budget,
  so a larger budget would only let a later confirm pass the 2x rule (R516, R517).
- **An al-runner run with coverage stops if the project changes under it** (R505). The pinned
  al-runner (`v2.12.0-main.c39ad5de`) labels coverage with the project's files as they are on disk,
  not the files LethAL compiled, so an object moved or renamed during a run had its coverage
  credited to the wrong object or dropped. `lethal run` now checks the project's `.al` files,
  `app.json` and resources before and after every al-runner call that produces coverage, and stops
  with `ProjectChangedDuringRunError` naming what changed. `--resume` continues the run from its
  last recorded verdict. A log or office lock file written into the project does not count. An
  edit undone within one al-runner call is not seen. Upstream fixed the labelling after the pinned
  build (#5249).
- **A resumed batch that reused a stored baseline (R192) no longer scores a timeout as
  `timeout-killed` without an unmutated confirm** (R514). The test is re-run once with no mutant,
  and the kill stands only if it finishes in at most half its budget (R53's margin on bcdev; on
  al-runner one-shot, whose in-run timeout is already half the budget, the margin is about 1x, see
  R516); otherwise the
  mutant is an `error` with the new cause `reused-budget-stale`. The same 2x margin applies to the
  warm replay of a timeout at a later position in a grouped call on such a batch. A batch whose
  baseline was measured in the same run is scored as before. With the default
  `--mutant-timeout-ms` a test that overruns its budget even unmutated is stopped as a re-run
  baseline would stop it: the run is quarantined, never a kill. A `timeout-killed` recorded on a
  reused baseline BEFORE this fix is still carried by `--resume`; re-run without `--resume` to
  re-score it (R514).
- **A tableextension or subscriber codeunit whose header is split by `#if` now keeps a table's
  trigger tags** (R494). Such an object was in no index the trigger-skip rule reads, so a
  `run-trigger-skipped-*` or `run-trigger-forced` tag it should have kept was dropped. It is now
  read by the conservative text rule and by any subscriber to the table's events. A procedure such
  an extension declares now also blocks the claim that a same-named call is the built-in method.
  Measured: no change on fixtures or any corpus.
- **A baseline saved for `--resume` is no longer reused once a run measured against it answered
  without attesting the deployed binary** (a stale or wrong container) (R512). The mark is written
  at that answer, so it also holds when the session throws or is killed before the batch ends, and
  when the baseline was itself reused from an earlier run. Before, such a baseline could make a
  test that hangs on the real binary score a timeout kill. **A batch whose lease was lost is now
  recorded in the results store at the moment of loss** (R513), and `--resume` reads every verdict
  of that batch as an error, so a verdict recorded after the loss and before a crash or kill is no
  longer carried.
- **A field of a temporary record now has a type** (R509). The type table read the type text
  `Record "Sales Line" temporary` with the keyword still on, found no table of that name, and gave
  every field of a temporary record no type, so `swap-additive` emitted nothing there. Measured:
  CDO +1, DC +15, DO +3 and BC.History +554 `swap-additive` mutants; none removed, no tag changed.
  A few identity keys move (a new mutant takes a twin's ordinal), so **IDENTITY_SCHEME is 32**:
  history, `--resume` and marks recorded under an earlier scheme are not carried.
- **A table named with a leading number binds by name** (R510). `resolveObject` read
  `"50000 Foo"` as table id 50000. It now reads an id only from all digits. No corpus has such a
  collision, so no verdict moves.
- **A lease lost mid-batch now discards that batch's verdicts in the results store** (R508), at the
  moment of the loss and again at session end, not only in the report. `--resume` no longer carries
  them, a later `--skip-known-survivors` no longer reads them through a resumed run, and the batch's
  saved baseline is not reused. Because such a run may now hold nothing carryable, `--resume last`
  can pick an OLDER unfinished run with the same configuration. If the store write fails, the
  session ends with an error that names the run and says not to resume it.
- **A namespace-qualified table or codeunit reference is read as the object it names** (R502).
  `Record System.Utilities.Integer`, `dataitem(X; Microsoft.Sales.Customer)` and a qualified
  `SourceTable` were read by their FIRST segment (`System`), or by the whole dotted text, so the
  receiver never found its table. Now the project's object of that name is used, but only when it is
  the only one and its file declares that namespace. Otherwise the reference stays unresolved and
  every trigger-skip tag is kept, as before. Measured: 0 changes on fixtures and the three customer
  corpora; 2 added specs in BC.History's BaseApp; no tag and no identity key moved.

- **A BC answer that starts but never finishes no longer holds LethAL forever on the harness
  check, the deployment check or the permission canary** (R506, R507); a package read-back now also
  ends on a fetch that ignores its abort. Each
  call's timeout now covers the response body as well as the headers, and an unread or unparseable
  body is an error, never an empty answer. A harness answer that times out or cannot be read no
  longer makes an env-tool session republish the control app. On the lease path, a refused
  redirect to BC's unfiltered extensions list now ends the session as itself instead of reading as
  "unreachable", and `force-reset-lease` says the reset may have been applied unless BC answered
  with an error status.
- **A lease call whose answer BC starts but never finishes no longer holds the session forever**
  (R504). The lease client's 30 s timeout now covers the response body as well as the headers, and
  an unanswered call fails the way an unreachable one does: never a kill, and never a lease
  reported as released. A heartbeat renew answered after the session stopped no longer reports the
  lease as lost.

- **A grouped call's progress poll that BC never answers no longer holds the call forever**
  (R503). Each poll now ends after 15 s, or at the call's hard cap if that is sooner, and counts as
  a failed poll; polling goes on. Never a kill.

- **A verdict is no longer published while a control request is still in flight** (R499). A stop or
  answer readback that outlived its own bound could be refused (a redirect to an unfiltered
  extensions query) after the call had already returned a score, or after the session had ended.
  Before `run`, `runWithCoverage` or `runMany` returns a scored result, it now waits, up to 5 s
  (`CONTROL_DRAIN_MS`), for every control request still in flight: its own and those an earlier
  unscored call left behind, on any transport of the session (one shared state per backend). A
  refusal that arrives meanwhile ends the session; a request still in flight after 5 s ends the
  session with `ControlDrainTimeoutError`. Neither is ever a kill, and no verdict is recorded for
  that call. Teardown waits once more (5 s at most, and only when a request is in flight) before
  taking the late refusal. A second late refusal is now logged rather than dropped. Recorded
  durations do not change. A transport factory must pass the new `controlState` argument to the
  transport; one that ignores it is refused at deploy or attach. The watchdog's status poll still
  has no timeout of its own (R503).
- **A project with two `.al` files of the same name in different folders can be instrumented**
  (R219). Batches are written flat, so such a project used to be refused ("two source files share
  the basename"). That is how Continia Document Capture failed, with its two `ScannerUI.al`. Now
  each duplicate is written as `<stem>.<8 hex of its folder>.al`, and nothing replaces anything.
  Every message that quotes a batch file still names the project file: coverage and line-map
  refusals, and alc's compile errors, which gain a note naming each renamed file. A project without
  duplicate names builds byte-identical batches, so no verdict, digest or gate figure moves.
- **On al-runner `--server`, a coverage refusal stops the run** (R-219c). Before, it read as an
  `error` verdict on every test; the one-shot transport already stopped. Its scope warnings also now
  name the file the coverage was credited to.
- **A run lends its verdicts only to a session whose test app runs against the same dependencies**
  (R496). Two proven runs with the same test-app bytes matched even when a dependency of the test
  app had been rebuilt between them (republished out of band, or by an env-tool hook that publishes
  only the dependency), so `--resume`, `--resume-run`, `--skip-known-survivors` and baseline reuse
  carried verdicts measured against the old dependency. Each run now records its test app's
  dependency fingerprint (`runs.test_app_deps`, an additive column, R-371's fingerprint) with its
  identity, and all three compare it; a run without one lends nothing. A session without a hook
  takes the fingerprint under the lease, so a dependency another session published while this one
  waited is seen; if its pre-lease digests then disagree, the run keeps neither its identity nor its
  digests (one `test-digests-unavailable` warning), runs unproven, and a requested resume refuses
  with `TestAppRepublishedError`. A source-less test app now fingerprints from its manifest, so it
  stays resumable without a hook. **One-time cost:** rows recorded before this release, R495's
  included, carry no fingerprint, so the first run after upgrading carries nothing on `--resume`,
  skips nothing on `--skip-known-survivors` and re-runs every baseline. A non-hook bcdev run now
  walks its dependencies a second time, under the lease (about 4.3 s on the measured closure). Not
  covered: apps outside the closure, a dependency changed during the batches, and the control
  app's own bytes. No report schema, store schema version or identity scheme changes. A redirect to
  an unfiltered extensions query that arrives after a call has returned is now thrown when the
  session tears down (after cleanup, never over an earlier error); the wider gap is filed as R499.

- **A run lends its test-app identity only when it proved it, on every backend** (R495). A bcdev
  session without an env-tool hook recorded the served test-app package's hash without proving it
  was the installed one, so a run that measured P1 while P2 was served could pass its verdicts, its
  known survivors and its saved baselines to a later P2 session (a false kill), and hook and non-hook
  sessions consumed each other's rows. Each run now records a proven flag with its identity
  (`runs.test_app_proven`, an additive column): proven by the env-tool read-back (as since R492), by
  the served package's own version having exactly one installed row (no hook), or by construction on
  al-runner. `--resume`, `--resume-run`, `--skip-known-survivors` and baseline reuse require it;
  R492's digests marker is gone. An unproven run records no identity and lends nothing. A session
  whose test app changes after it was proven, or can no longer be read, stops at the next batch with
  `TestAppDriftedError` (code `test-app-drifted`) before that batch records anything, and its run
  keeps no identity. **One-time cost:** rows recorded
  before this release carry no proof, so the first run after upgrading carries nothing on
  `--resume`, skips nothing on `--skip-known-survivors` and re-runs every baseline. No report
  schema, store schema version or identity scheme changes.

- **An env-tool run's test app is recorded only when proven installed** (R492). The server can serve a
  test app that is not the installed one; such a run recorded the served hash, so a later `--resume`,
  `--skip-known-survivors` or reused baseline could carry verdicts measured under another test app.
  The recorded identity, the history and the digests now need one installed proof; an env-tool resume
  is compared after the hook with the resumed run's proven identity (an env-tool session refuses older
  env-tool runs, and a hook that restores the resumed run's test app now resumes); a baseline snapshot
  is reused only from a run that recorded its hash (and, on an env-tool session, digests). Still open:
  sessions without a hook, and rows shared between hook and non-hook sessions (R495).

- **al-runner one-shot: a result with two rows for the requested test is refused by name** (R491).
  Two rows carrying the requested name, exactly or ignoring case, were credited from the first row
  and that call's coverage; now the run is an `error` naming the test. That refusal, and R488's
  "ran other tests despite `--exclude-test`" refusal, are no longer labelled pre-dispatch: the test
  was dispatched, so the orchestrator no longer re-sends it as a retry-safe failure. The R488 unit
  tests now run against a fake that selects as al-runner does (excluding the requested test itself
  drops it), with coverage on, and with an order check on the discovered-list seeding.

- **al-runner one-shot: a result naming any other test is never credited to the requested one**
  (R488). al-runner's `--test` is a case-insensitive substring match, so asking for `GrowPre` also
  ran `GrowPreTwin`, and LethAL credited both tests' coverage, and their shared deadline, to
  `GrowPre`. al-runner has no exact `--test`, but `--exclude-test` matches a whole name. Every
  discovered test whose name contains the requested one is now excluded from the first call on, on
  the session backend and on every worker. As a defence, a result that still names another test is
  discarded, the test re-runs with that name excluded too, and a result that names one even then is
  refused by name. A test whose name is no part of another's runs exactly as before. `--server` was not
  affected.

- **A lost answer after a stop is never retried into a survivor; the single path refuses a stop
  that landed after the test finished** (R202, R204; R-204b landing 1, client only). With
  `--stop-hung-sessions`, a hung run whose answer came back unreadable (BC can answer HTTP 400
  instead of its stop 408) used to be retried once, and a hang need not recur, so the retry could
  pass and score a real timeout `survived`. Each call now records what became of its stop, and a
  lost answer is retried only when no stop was sent or every stop was refused; otherwise the mutant
  is `error` with the new cause `stop-outcome-unconfirmed` (`--resume` re-runs it). Both stop calls
  are now time-bounded. With `--no-group-runs`, a stop 408 whose method had already recorded its
  completion is now `error` / `stopped-after-completion`, as the grouped path already did, instead
  of `timeout-killed`. `lethal explain` is schema v13 (one new cause value). R202 and R204 stay
  open.
- **An env-tool run records test digests, so `lethal verify` accepts it** (R373). An env-tool
  session publishes its test apps (`envTool.publishApps`) after it takes the lease, after the
  published test app is read, so it recorded no digests and verify refused it as
  `source-predates-verify`. It now reads the test app back after that publish, under the lease, and
  takes the digests from that read with R372's own code (no digest-scheme change). It records them
  only with proof the read-back is what runs: exactly one installed version, the one served, for
  the test app and for every app the hook published, and, when a `publishApps` file is the test app,
  the same name, publisher, version and `.al` sources as that file. Otherwise the digests stay NULL
  with one `test-digests-unavailable` warning naming why. `published-test-app-mismatch` and
  `published-test-app-unreadable` are now said only about that read-back, not about the package
  the server held before the publish.

- **An env-tool `--resume` no longer carries kills measured under the outgoing test app** (R486).
  `--resume` compared the test app read BEFORE the lease, and an env-tool session then publishes
  its own. When a resume was found, the session now refuses with `TestAppRepublishedError`
  (`test-app-republished`) before the first baseline unless the test app read back after the
  publish equals it; an unreadable read-back refuses too. `--skip-known-survivors` compares the
  read-back instead, so a newly published test app skips no survivor (with the
  `history-test-app-changed` warning), and so does an unreadable read-back. The run row records the
  read-back's test-app hash, or NULL when it could not be read, never the outgoing one.

- **`lethal run` refuses a test project nested inside the target** (R445). The target build copies
  every `.al` under the target folder, so a `--tests` folder inside it was mutated and published as
  target code, without a word. `lethal run` now refuses that layout by name
  (`test-project-nested`), both ways round (the test folder inside the target, or containing it),
  before it reads or builds anything, with the same fix as `lethal verify` (R-260): move the test
  project beside the target and pass that folder as `--tests`. Campaign stages run through
  `lethal run`, so they are covered; `lethal run --dry-run` takes no `--tests` and still lists a
  nested project's test files as mutants.
- **A carried verdict no longer lands on a statement whose procedure changed around it** (R474).
  When the source changed since the recorded run, `--resume` and `--skip-known-survivors` matched a
  mutant on its file and statement alone, so inserting `exit;` before an unchanged statement carried
  its old `killed` onto a mutant that could no longer be reached, and removing such an `exit;`
  skipped a now-killable mutant as a known survivor. A verdict now carries across an edit only
  when the enclosing procedure or trigger is byte-identical, its attributes included (a retargeted
  `[EventSubscriber]` counts as an edit). Unchanged source carries exactly as before. Rows and
  manifests from before this change carry nothing across an edit, so the first run after it
  re-runs those mutants once. Still carried across: edits outside the procedure (a caller, a
  global or its initialisation, a table definition, another trigger or subscriber, the `#if`
  around it). Measured cost: 0.03-0.74% of such carries refused across one PR, up to 6.6% across
  a month, on BC apps and one partner app (a structural proxy, R474).
- **An `Insert(true)` -> `Insert(false)` mutant keeps its platform tag when `OnInsert` fills the
  key through a procedure** (R476). The tag `run-trigger-skipped-insert` was dropped whenever the
  table's `OnInsert` did not assign the primary key itself, so a trigger that reaches the key
  through a helper (BaseApp `Sales Header` -> `InitInsert`) left a possible duplicate-key kill
  untagged. Now the tag also stays when `OnInsert` makes any call not proven harmless, or when the
  project subscribes to the table's insert events or extends its insert triggers (R452's rule for
  `Modify` and `Delete`). Tags only, no mutant moved: 1,030 more `Insert` mutants are tagged
  (BaseApp 759, other BC.History 175, CDO 8, DC 61, DO 26, the gift-card example 1); no gate
  fixture changes.
- **A mutant's covering tests run in the same order on every host** (R481). The last tie between
  two covering tests was broken by name with the host's default collation, which decides
  `killingTest`, the kill position and, through a warm prefix, possibly the verdict. It now compares
  names by code unit. Measured: no gate fixture's order changes.
- **An equivalence mark no longer lands on a mutant nobody marked** (R443). A mark named its mutant
  by identity key alone, and a key holds no file: twins (the same statement in the same member and
  operator) are told apart by a run-wide number. So an edit that removed a twin, `--only`,
  `--lines`, or a file header that became readable again could hand a mark's key to another twin,
  and the report then listed that twin as "reader-marked equivalent" although nobody had looked at
  it: a survivor hidden from the one list a reader acts on. `lethal verify` skipped such a
  survivor the same way. A mark now carries its proof and applies only when that proof holds: by
  key when this run's numbering digest equals the mark's, or by its file when the mark proved its
  mutant the only one of its kind in that file and this run agrees. Any other mark is refused by
  name in `readerMarkedEquivalent.refused` and its mutant stays a survivor. The report records
  `numberingDigest`, `twinSites` and `carryHidden` for this; `lethal explain` (now
  `explainSchemaVersion` 12) prints each survivor's ready-to-paste `mark`; the store records
  `runs.numbering_digest`. Remaining limits are listed in `docs/roadmap/R443.md`.
- **Identity twins are numbered in code-unit file order; identity scheme 24** (R475; 23 was held
  for R-446, which landed as 25, and is unused). The run-wide twin numbering sorted files with `localeCompare`, the host's default
  collation, while file discovery and the generation hash sort by code unit. A resume on a host
  with another collation (Danish puts `Aa_…` after `Z_…`) could give a cross-file twin the other
  twin's key under an equal source hash, so a recorded `killed` landed on a mutant that was never
  measured: a false kill, reproduced in a unit test. Every identity comparator (twin numbering,
  mutant codes, guard nesting order) now compares by code unit. Measured over 1.76M sites
  (every fixture, CDO, BaseApp and its tests) under en, da, sv and upper-first collations: 0 keys
  and 0 codes move. Marks files need `"identityScheme": 24`; no key changes on those corpora.

- **`validate-to-assign` writes the record the call binds to** (R464). Its bare form synthesized a
  literal `Rec.`: inside `with R do begin Validate(Amount, 1); end;` in a table trigger or a page,
  that was `Rec.Amount := 1`, a mutant of a different record (no real site in the measured
  corpora). It now writes the binding (`R.`, a dataitem name, `Rec.`), and only where that spelling
  is PROVEN to bind that record: every reachable table is declared in the project and has no field
  or procedure of that name (in any `#if` arm), and the name is provably undeclared at the call
  (or, for a `with` subject, the same declaration). Otherwise the site is refused, in `targets()`
  too. Cost: 29 of the bare sites mutated before are refused (Intrastat 23 and SAF-T 3 in
  tableextensions of tables outside the project, BaseApp 3), and 6 new claims are not taken
  (R477). The name scans read the engine's lexer (`maskAlNonCode`), so a `//` inside a string no
  longer hides the rest of a line, as do `projectDeclaresProcedureOnTable`'s unparsed-object scans.
- **A recorded verdict no longer carries onto a different mutant after an edit** (R391).
  `--skip-known-survivors` and `--resume` matched a mutant to its earlier record by identity key
  alone. When two mutants share every identity field, for instance the same statement in two
  same-named objects, or twice in one procedure, an edit that removed one of them renumbered the
  other onto its key, and the old verdict, `killed` included, carried to code that never ran.
  - Now a verdict carries by key only when the project's source is unchanged since the recorded
    run, interrupted runs included.
  - After an edit, a verdict carries only to a mutant that is the only one of its kind in its file in
    both runs, and every such "twin" runs again.
  - Refused carries are counted in one `carry-refused-renumbered` warning.
  - No key or baseline changes.
  - **One-time cost:** history and resume data recorded before this release lack the new run facts,
    so nothing carries from it; the next run measures everything once.
- **A `Modify(true)`, `Delete(true)` or `Insert(true)` flip on a receiver LethAL cannot resolve
  keeps its skip tag** (R473). `swap-modify-flag` does not claim such a call, so
  `flip-boolean-literal` flips its `true`, and that flip carried no `run-trigger-skipped-*` tag. It
  now carries the tag of its kind, as the `false` flip on the same receiver already did (R460).
  Tags only: no mutant added or removed and no identity key moved. Measured: BC.History 1116 flips
  newly tagged (879 modify, 130 delete, 107 insert), CDO 1, fixtures none.
- **A bare `Insert(true)`, `Modify(true)` or `Delete(true)` in a pageextension keeps its tag**
  (R479). A call with no receiver binds the implicit `Rec`, and in a pageextension that is the
  extended page's source table, which LethAL cannot see, so the call is not claimed by
  `swap-modify-flag` and `flip-boolean-literal` flips it. That flip carried no
  `run-trigger-skipped-*` tag, while `Rec.Insert(true)` in the same place did. Now the bare form is
  treated like the qualified one, in both directions (`true` keeps its skip tag, `false` gets
  `run-trigger-forced`), also in a reportextension and under a `with` whose subject LethAL cannot
  resolve. The same rule reaches every RunTrigger argument the operator tags, so a bare
  `ModifyAll(..., true)`, `DeleteAll(true)` or `Insert(true, X)` there is tagged too. Untagged:
  a name the enclosing object declares as its own procedure, a name the project declares on the
  record's known table (or a tableextension of it), and a `with` whose subject is declared as a
  non-record such as a codeunit. A `with` subject LethAL cannot find a declaration for is tagged.
  Tags only: no mutant added or removed and no identity key moved. Measured: no change on
  BC.History, CDO, DC, DO or the fixtures, none of which has this shape.
- **The test-app scan reads a TableNo codeunit's `Rec` in its `OnRun` only** (R466), as AL does,
  instead of in every procedure of the codeunit. Measured: no test digest or TestPage result
  changes on CDO or on 178 BC.History test apps, because none of them uses `Rec` outside `OnRun`.
- **The al-runner warning printed when no al-runner path is configured gives the current reason**
  (R255, R267): conditional coverage and unverified transaction semantics, not the v1 `asserterror`
  defect that al-runner v2 fixed.
- **A report and its reportextension can both be mutated in one project** (R470). A report's
  globals and its reportextensions' share one namespace, so the `MutationSelector` variable LethAL
  declares in each instrumented object was declared twice, and BC's compiler refused the project
  (AL0155). Two reportextensions of one report collided the same way, even when the report itself
  had no mutants. On bcdev the whole batch then ended as `error`. Measured: 10 such groups in
  Microsoft's Base Application (13 reportextensions, about 2,700 mutants in those files), none in
  CDO. A reportextension's selector is now named after its own object id
  (`MutationSelector<id>`, with a suffix if that name is already used in the file); every other
  object kind is unchanged. No mutant or key moves, and the gates' verdicts are unchanged; a batch
  that collided before stops ending as `error`. The instrumented text of
  reportextensions changes, so a project that has them re-measures its baseline once
  (the baseline key hashes the instrumented AL). al-runner had accepted the colliding project
  (R471).
- **A global declared in an object's second `var` section is now known** (R468). An object may
  declare its globals in several sections, usually `protected var` then `var`; LethAL read only
  the first, so every name in a later one resolved to nothing. Record operators lost those
  receivers, and the loop-hang check could not refuse a write to such a variable. Measured on
  BaseApp (BC.History w1-28, 203 projects), on top of R-458: 1 more hang-capable mutant is
  refused (`SuggestVendorPayments`; R-458 already refuses the other 6 this fix would have caught,
  by name); 680 call deletions move from `void-method-call` to `remove-setrange`,
  `remove-testfield` or `remove-calcfields` with the same deleted text; 25 `true` RunTrigger flips
  cede to `swap-modify-flag`; 637 new sites appear, mostly typed record operators and argument
  swaps; one `run-trigger-forced` tag drops where the table is now known to have no `OnModify`.
  CDO: one site changes. No fixture changes. No name in a later section was found to bind where AL binds a
  record field instead; that check, and the 39 places where an existing FIRST-section global
  already does, are recorded on R464.
- **The loop-hang refusal now sees writes through an implicit record or a `with` subject** (R-458).
  A loop that writes a field through `Rec` (table, tableextension, pageextension, page with
  `SourceTable`, TableNo codeunit `OnRun`, request page), a report dataitem, a reportextension
  `modify(X)` or a `with` subject, and reads it back in its condition, was mutated with no refusal
  (for example a table's number-series loop). Such a site is now refused by name and counted in
  `hang-refused`, following R294's measured precedence (a local wins over the field outside a
  `with`; a global wins in a table). Measured: 43 more refused sites (BaseApp 37, CDO 2, other
  BC.History apps 4), nothing else changed; some are over-refusals (e.g. a loop that also ends on
  `Next() = 0`).
- **A target whose unmutated build alc rejects is refused as that, not blamed on a mutant or the
  environment** (R461). At a session's first compile failure (bcdev, sequential path), LethAL now
  compiles its staged copy of the unmutated target once. If alc rejects that too, the run stops
  with `UnmutatedBuildFailedError` and alc's output, records no `error` rows for the batch, and
  stays resumable. If it compiles, bisection runs as before. Compile-failure text now carries
  BOTH alc streams, labelled `stdout:` and `stderr:`, so a stderr warning no longer hides a stdout
  error; bisection notes and `TestAppError.detail` get longer accordingly.
- **A stale-test-app refusal says what the test app's identity shows, not that the app is older**
  (R462). At the refusal the published test app (the same publisher and name as the first read) is
  hashed again and compared with the hash taken at the start of the baseline. A changed package
  throws the new `TestAppChangedError`. An unchanged one throws `StaleTestAppError`
  (`cause: "unchanged-endpoints"`), which notes that a replace-and-restore between the two reads
  cannot be ruled out. A read that cannot be compared throws `StaleTestAppError`
  (`cause: "identity-unverified"`): the app may be older or may have been replaced. Both give the
  republish remedy only "if no other session publishes to this server". A replacement restored
  before the second read is still reported as unchanged.
- **The loop-hang refusal now works inside an object wrapped whole in `#if`** (R-364, R343).
  The symbol table does not index such an object, so no variable there resolved and the four value
  operators deployed hang-capable mutants. Now, when a write's target does not resolve and its own
  object is unindexed, an enclosing loop condition that reads the same NAME refuses the site (a
  plain name against a plain read, `R.Field` against the same receiver and field), and it is
  counted in `hang-refused`. Indexed objects are unchanged: there an unresolved target is still not
  matched by name. Measured: the 7 BaseApp mutants of the census are now refused.
- **A forcing RunTrigger flip carries `run-trigger-forced` when the receiver does not resolve**
  (R460). The `false` -> `true` flip at `ModifyAll`, `DeleteAll`, `Modify`, `Delete` or `Insert`
  can force a table trigger to run, and was tagged only on a receiver the project resolves. An
  unresolved receiver now gets the tag too, the same conservative rule R-364 applied to the skip
  direction (`true`); where the receiver is not really a record this over-tags, the accepted
  direction (R143). Measured, tags only (no mutant added, removed or re-keyed): 45 rows gain the
  tag: 40 BaseApp rows (BC.History w1-28, 203 projects), 4 CDO rows covering 2 sites across two
  symbol sets, and 1 `sandbox-probes` row. `sandbox-data` is unchanged.
- **A `ModifyAll`/`DeleteAll` RunTrigger flip keeps its platform-kill tag when the receiver does
  not resolve** (R-364). `flip-boolean-literal` dropped the tag there, the unsafe direction for the
  screen (R143); it is now kept, in every object. Tier-2 claiming is unchanged. The tag is
  conservative over-tagging: inside a wrapped object a codeunit variable calling a project
  procedure named `DeleteAll` or `ModifyAll` with `true` also gets the tag (its receiver does not
  resolve), which is the accepted direction.
  - Measured on BaseApp (BC.History w1-28, 203 projects, under `[]`): 11 `flip-boolean-literal`
    mutants gain a tag, and none loses one.
  - **1 restored**, in a wrapped object: `CalculateSubcontracts.Report.al`'s
    `RequisitionLine.DeleteAll(true)` (`run-trigger-skipped-delete`).
  - **10 newly added**, in indexed objects. The line numbers are in the R-364 site diff.
    - 8 are a qualified `Rec.` call in a page or a `TableNo` codeunit, where an implicit `Rec` does
      not resolve (R458's territory):
      - Base Application: `Rec.ModifyAll` in `DimensionCorrectionChanges.Page.al`,
        `ReminderAutErrorOverview.Page.al` and `MonitoredFieldsWorksheet.page.al`, and
        `Rec.DeleteAll` in `ArchivedWFStepInstances.Page.al`;
      - Sustainability: `Rec.DeleteAll` in `SustExciseJnlPost.Codeunit.al` and
        `SustainabilityJnlPost.Codeunit.al`;
      - AI Test Toolkit: `Rec.DeleteAll` in `AITLogEntries.Page.al`;
      - Test Runner: `Rec.ModifyAll` in `CommandLineTestTool.Page.al`.
    - 2 are a global the symbol table does not read because a `#if` sits in the global var section
      (R369's class): `PurchReqLine.DeleteAll` in `CalculatePlanReqWksh.Report.al` and
      `SalesLine.DeleteAll` in `SalesHeader.Table.al`'s `RecreateSalesLines`.
  - CDO and every fixture are unchanged.

- **Three more loop-hang shapes are refused; identity scheme 14** (R454). `shift-integer` now
  refuses a literal in a loop condition's `#if` tail; `flip-boolean-literal` refuses a literal
  inside a comparison in a loop's exit test (`until X.Next() = false`) or an in-loop `if` guard;
  and all four value operators refuse a write to `R.Field` that an enclosing loop's condition
  reads (receiver and field compared separately; an unresolved receiver is still not seen). The
  first two are silent refusals; the third counts into `hang-refused`. Measured: BaseApp loses 47
  mutants (15 more hang-refused), CDO 1, no fixture or gate figure moves. A later same-tuple twin
  of a refused mutant can take its key, hence the scheme bump: marks files need
  `"identityScheme": 14` after re-checking each mark (R325).
- **`swap-call-arguments` no longer swaps an argument that names a field** (R455). In
  `R.SetRange(Amount, Value)` the first argument is the record's field even when a local has the
  same name, so the swap did not compile (AL0166). Record builtins are matched by method name, with
  the field positions of each (SetRange, SetFilter, Validate, TestField and others at position 1;
  CalcFields, CalcSums, SetLoadFields, SetCurrentKey and others at every position; CopyFilter at 1
  and 3). Swaps between value arguments stay. BaseApp: 43 swaps removed, among them 28 that alc
  rejects; CDO: 1.
- **An unqualified call in a record scope has no type** (R455). Inside `with R do`, on a page with a
  `SourceTable`, in a `TableNo` codeunit's OnRun and in a report dataitem, a call `F()` binds to the
  table's method first, so typing it by the object's own procedure could emit `F() - F()` on Text
  (AL0175). BaseApp: 13 `swap-additive` mutants removed; CDO: 0.
- **A case-only pair is not swapped** (R455): `SetRange(ID, Id)` names one variable twice.
- **Identity scheme 13** (R455; 12 is reserved for R254): swaps and additive flips are removed, so
  same-tuple ordinals can move. Every older store stops resuming once, the next
  `--skip-known-survivors` run skips nothing once, and marks files need `"identityScheme": 13`
  after re-checking each mark (R325). History only: R454 moved the effective scheme to 14, so
  marks files now need `"identityScheme": 14`.
- **No more wrong swaps and claims from the later names of `A, B: T`** (R295). Only the first name
  of a multi-name declaration was seen, so a use of B was typed by a same-named global of another
  type: `swap-call-arguments` emitted swaps `alc` rejects (AL0133) and `remove-setrange` claimed a
  Codeunit's `SetRange`. Every name is now declared with the full shared type. A bare name inside a
  `with` body now types as nothing, because the record's field of that name wins there (an
  `alc`-failing swap was possible before too). Measured: BaseApp +1,169 sites, and all 129 wrong
  rows of the later-name class gone (30 `swap-call-arguments`, 99 `flip-boolean-literal`); CDO +4,
  and its 1 wrong row gone. No fixture or gate figure moves. These counts cover the class the
  census looked for (a later name typed by a global); they do not prove that no other class of
  wrong mutant exists.
- **Member-expression receivers resolve again** (R294): the `R` of `R.Field` and `Txt` of
  `Txt.Contains(...)` were always refused, so a loop such as
  `while Txt.Contains('a') do Txt := Txt.Replace('a', 'b')` was not seen as hang-capable. Such sites
  are now refused by R196's rule (36 BaseApp, 1 CDO, measured with the R295 fix: both together).
- **No more swaps typed by a global that an implicit record's field hides** (R294 review). Some
  bodies run inside an implicit `with` over a record. There, a field of that record wins over an
  object global of the same name (a procedure's local or parameter still wins over the field). The
  type layer does not read those fields, so in these places a bare name that would fall through to
  the globals now types as nothing. The places, measured with `alc` 18.0: a page with a
  `SourceTable`, every pageextension, a codeunit's `OnRun` when it has `TableNo`, report dataitem
  triggers, a report request page with a `SourceTable`, and reportextension dataset and request
  page triggers. Table, tableextension and xmlport triggers were measured safe and are unchanged.
  Before, on a page over a table with a Text field `Z`, two Integer page globals `Q2` and `Z` were
  swapped, which `alc` rejects (AL0133). Measured: 1,961 BaseApp and 38 CDO rows removed
  (`swap-call-arguments` and `swap-additive`), and 12 BaseApp swaps moved to another argument pair,
  each new pair made of procedure locals, parameters or named returns of one type. A type-level
  check found none of the removed rows wrong in these corpora: in each one the implicit record has
  no field of the refused name, or (2 rows) has one of the same type. So the refusal closes a real
  door (the synthetic case), but these corpora had not used it; the cost is the lost sites.
- **Identity scheme 11** (R295, R294): sites are added and removed, so same-tuple ordinals can
  move. Every older store stops resuming once, the next `--skip-known-survivors` run skips nothing
  once, and marks files need `"identityScheme": 11` after re-checking each mark (R325).
- **`reliability` is now `narrowed` when a file with sites was left out for an undecided `#if` or
  because its object kind cannot carry the selector** (R399). R307 did this for refused files
  only, so a run that left such a file out still said `full`. A zero-site undecided row, a
  compiled-out row and a declarative row still do not narrow. `scoreDescribes` and the console
  `SCOPE:` line now name the left-out files and sites, and the "nothing is left to measure" error
  also names undecided files. The console text that said only a codeunit or a table can carry the
  selector now lists the real carrier kinds. The explain document's `score.reliability` copies the
  same value. Treated as a correction like R307's: no report or explain version change. Measured
  at generation: the `fixtures/sandbox-data` run (its query object, 5 sites) and the r214
  `p12-refused` unit fixture flip from `full` to `narrowed`; every other `fixtures/` and `examples/`
  project under its gate symbol sets, the r214 and r364 unit fixtures, and the six CDO at 5f2a71d
  projects (with and without `DOSMTP`) do not move. No live-gate assertion reads these values.
- **A codeunit after an enum, interface or permission set in the same file got the wrong base line**
  (R383). The line map moved a file's base line only past objects with a coverage identity, so every
  covered line of such a codeunit was looked up in the wrong place (latent on bcdev too; no fixture
  has the shape, re-checked: no file under `fixtures/` holds an unindexed object at all). Every
  top-level object now moves the base. A `#pragma` line does not, as before: it is not an object
  (BaseApp has 166 at top level).
- **Test discovery found no `[Test]` whose declaration its regular expression could not read**
  (R420). Such a test was dropped silently, so it never ran and the mutants only it kills could
  score survived or no-coverage. Discovery now reads these shapes as the compiler does: `#if`/`#else`
  around a test's attributes or around whole test procedures, a `#pragma` or `#region` line between
  `[Test]` and `procedure`, and an `internal procedure`. A `[Test]` before an `#if` with no `#else`
  (or an empty one) goes, as alc gives it, to the procedure after the `#endif` in a build that
  compiles none of the arms. A file the regular expression reads in full
  is not parsed again, so every existing project discovers exactly what it did. A test procedure
  whose HEADER is split by `#if` (one name per arm) is still not discovered: it now raises a
  `test-shape-unsupported` warning naming both names (R424). When the published test app holds a
  test the source did not yield, the bcdev refusal now names that as a third possible cause. The
  resume fingerprint's `testDiscovery` gains `"tree-v1"` (and `"arms-v1+tree-v1"`) when discovery
  found a test the regular expression missed, so such a run does not resume a run from before.
- **A `[HandlerFunctions]` inside `#if` was invisible to the TestPage scan and the test digest**
  (R420). For a TEST procedure, both now read the attributes of every `#if` arm in its attribute
  run (the union), and its span starts at the first node of that run, the `#if` included. So
  editing a handler named only inside `#if` now changes the test's digest. Every other procedure
  keeps its old span, so a helper under `#if not CLEAN24 [Obsolete(...)] #endif` changes nothing.
  Digests change ONCE after upgrading in exactly one case: a codeunit holding a test procedure
  whose attribute run already contained an attribute-only `#if` block (before `[Test]`, a shape
  discovery always found). That `#if` moves from the codeunit's shared parts into the test's span,
  so the digest of every test that reaches that codeunit changes, the test's codeunit siblings
  included. `lethal verify` treats each as a new test on the first run, which is the safe
  direction. No committed fixture has the shape, and their digests are unchanged (pinned by test).
- **A procedure whose HEADER is split by `#if` (one header per arm, one shared body) was invisible
  to the test-app model** (R424). tree-sitter-al reads it as one `preproc_split_procedure` node (or
  a `preproc_split_procedure_preamble`, when each arm has its own `var` section), and the TestPage
  scan and the test digest kept only plain `procedure` nodes. Now:
  - **A split TEST is discovered**, one candidate per arm, each kept or dropped by the `#if` arm
    its NAME starts in, exactly as alc compiles it (measured with alc 18.0.41.45789 for a `[Test]`
    before the `#if`, a `[Test]` inside each arm, an `#elif` arm, an `internal` arm, a shared and a
    per-arm `var` section). The `test-shape-unsupported` warning no longer fires for it. The resume
    fingerprint's `testDiscovery` gains `"split-v1"` (in every combination with `"arms-v1"` and
    `"tree-v1"`) when a discovered test comes from a split member, so such a run does not resume a
    run from before. A split HELPER alone does not set it.
  - **A split HELPER is resolved.** Each arm is its own declaration, never merged: a call resolves
    by name and parameter count, and a helper whose return type differs per arm is followed into
    every codeunit either arm can return. Before, a call to it was silently treated as a built-in.
    A split member's locals are no longer read as globals. A split helper's body can now raise the
    same `TestPageScanError` problems as a plain helper (an unresolved receiver), not only the
    ruled TestPage case.
  - **Digests move once, only for tests that REACH a split member**: the member is now a reach
    edge with its own span (both headers and the body). Its text stays in its codeunit's parts hash,
    as before, so a test that does not reach it keeps its digest byte for byte. A test that
    reaches one is treated as new by `lethal verify` on its first run after upgrading, the safe
    direction. No committed fixture has a split member, so their digests are unchanged.
  - `TreeDiscoveryMismatchError` names a second possible cause: the file uses a construct the
    parser (tree-sitter-al) does not read correctly yet, with a request to report the file.


## [0.1.0-alpha.3] — 2026-08-27

The operator set goes from **15 to 24**, and `no-coverage` stops claiming something it cannot
observe. Twenty-two roadmap rows closed since alpha.2; the ones a user can see are below.

### Added

- **Nine new mutation operators.** Every one was sized against a real 554-file Business Central app
  BEFORE it was written, and the sizing repeatedly collapsed by an order of magnitude once contexts
  were counted rather than node kinds, so several candidates were refused on measurement instead of
  shipped.
  - `negate-guard` (R171): `if Cust.Get(X) then` becomes `if not (Cust.Get(X)) then`. A bare Boolean
    guard had no polarity mutant at all; 1,891 sites.
  - `remove-not` (R163): drops `not` from a bare call or identifier, which no operator could see.
  - `swap-additive`, `flip-boolean-literal`, `remove-assignment`, `toggle-blank-string` and
    `shift-integer` (R159), the five behaviour-carrying node kinds the coverage census left
    unclaimed. `remove-assignment` alone claims 6,850 corpus sites.
  - `loop-truncate` (R164): a `repeat` loop's exit condition becomes `true`, so the body runs once.
    A survivor is unusually specific, meaning no test drives this loop over more than one row.
  - `swap-enum-member` (R162) and `swap-modify-flag`'s forward direction (R165).
- **The report says which `no-coverage` verdicts are ours** (R175): `unplaceableCount`,
  `unplaceableMutants` and an `attribution-unplaceable` caveat. Excluded from the score exactly as
  before, so no verdict moves; what is new is that a reader can tell a statement about their tests
  from a statement about LethAL's attribution.
- **Survivors likelier to be equivalent say so** (R172): `likelyEquivalentSurvivors` groups survivors
  whose operator declares an elevated equivalence risk, with the reason. A hint attached to a verdict
  rather than a change to it, so nothing is subtracted from the score.

### Changed

- **`negate-conditional` no longer claims a `repeat` loop's exit condition** (R164). On the canonical
  BC shape its mutant does not terminate: `until Rec.Next() <> 0` never ends once the recordset is
  exhausted, which is the common one-row fixture. 326 such mutants on one real corpus are replaced by
  `loop-truncate`, which cannot hang. Measured, not argued: the arm's mutant was scored
  `timeout-killed` before the cession landed.
- **On the fenced coverage path, a local procedure's member miss is no longer widened to object
  level** (R175). That widening existed because `SymbolReference.json` lists no locals, which is true
  of the hub resolver and false of the default one: the line map parses source and does not look at
  scope. Measured on a fixture, all five mutants of a local came back exactly attributed.

- **Mutants are now generated at the un-braced body of a branch or loop** (R161). Six operators
  guarded on a predicate that asks "is this one of several statements inside a `begin ... end`",
  and used it to mean "is this a statement". It is not: `if Cond then Rec.Validate(F, V);` puts the
  call in a slot where the grammar requires a statement, and every one of those operators refused
  it. Measured on a real 554-file app, set-diffed per operator: **1,280 sites gained, 0 lost**
  (`void-method-call` 9,218 to 10,336, `remove-setrange` 810 to 932, `validate-to-assign` 112 to
  131, and three smaller).

  What this is worth is not the count. The commonest shape it unlocks is `if <bad condition> then
  Error(...)`, the ordinary Business Central guard clause, at which LethAL previously emitted
  **nothing at all**. A suite that never checks a guard now gets a mutant that says so. On the
  bundled demo app all five new mutants are exactly that, and the demo moves from 36 mutants /
  20 killed to 41 / 25.

  Expect more mutants, and therefore longer runs, on any project with un-braced branches. The six
  operators bump to 1.1.0: MINOR, so existing mutants keep their history.

### Fixed

- **`no-coverage` was asserting a negative it could not observe** (R175). When coverage saw an object
  execute a member it could not NAME, a mutant in a public procedure there was reported `no-coverage`
  without ever being run, which reads as "your tests do not reach this code" and was a statement about
  LethAL instead. Reported downstream at 223 of 2,058 mutants across 17 reports, and proven by a
  contradiction inside one report: a callee killed by a test whose only caller was `no-coverage`.
- **Six CLI flags were accepted and silently ignored** (R176). `lethal run --report r.json` completed
  normally and wrote nothing, because `--report` belongs to `campaign` and a run writes with `--out`.
  All six now refuse and name the flag to use instead.
- **Mutant identity erased the enclosing procedure name** (R166), so three different guard deletions
  in one object shared one identity and a per-mutant baseline could not tell them apart.
- **`alc.exe` discovery broke on the current AL extension** (R167), which moved it out of `bin/win32/`.
- **LethAL's own object ids collided with a real product's** (R169), so two fixtures could not be
  published beside it.
- **Every refusal reached the user as a stack trace** (R158), including the first command the README
  tells them to run.
- **The al-runner backend resolved its target to a stale symbol-only `.app`** (R148), and its second
  cache tree went unaccounted for by `doctor` (R168).
- **Arithmetic types could not be resolved for a call or a record field** (R160), which is where BC
  arithmetic actually lives.
- **A required report field was added without bumping `schemaVersion`** (R157), so one version number
  described two shapes.


## [0.1.0-alpha.2] — 2026-08-17

The first release with a machine-readable surface for agents and CI, a demo application you can
point the tool at, and a licence. Roughly thirty roadmap rows closed since alpha.1; the ones a user
can see are below, each citing its `R<n>` for the evidence.

### Added

- **A licence.** MIT. There was none, so nobody could legally use a binary they downloaded.
- **`lethal explain --top <n>`** (R150), because the projection built for agents did not fit one:
  a 473-mutant report projects to 243 KB. The output now always carries `survivorSelection`
  (`total`, `shown`, `omitted`, `rankedBy`), present even when nothing was capped, so a truncated
  list can never read as a complete one. A cap ranks survivors by how much evidence each carries,
  in a total order, so the same report and cap give the same rows on any machine.
- **`lethal doctor --json`** (R151). The read-only pre-flight was the one surface an agent could not
  parse. Emits `doctorSchemaVersion`, `ok`, per-check `name`/`ok`/`detail`, `notChecked` tokens for
  what a GREEN report does not cover, and a caveat with a machine `kind`. Same exit code; only the
  rendering changes. `--json` is refused elsewhere rather than ignored.
- **An agent contract** (R153): `docs/using-lethal-from-an-agent.md` and a copyable skill at
  `skills/lethal-mutation-testing/SKILL.md`, both checked against the code by a test — every flag
  they name must exist, and the exit codes and schema versions they promise must match the
  constants.
- **Published JSON Schemas** for the `explain` projection and `doctor --json`, under `schemas/`
  (R152). Pinned against the TypeScript declarations in both directions, with every enum asserted
  equal to its runtime constant. The report and the event stream do not have one yet.
- **A demo application**, `examples/gift-card` (R155): a small store-credit extension whose eight
  tests are green and do not notice that deleting one `SetRange` makes a card's balance the whole
  store's liability. Measured live: 36 mutants, 20 killed / 9 survived / 7 no-coverage, 13.8 s, and
  all 36 verdicts were pre-committed before the run and all 36 matched. Its rehearsal report ships
  too, so `lethal explain` can be exercised with no server.
- **`--operator <name>`** (R127) to scope a run by operator, so measuring one operator on a real
  project no longer costs every other operator's mutants in the same files.
- **Four Tier-2 operators and one extension**: `flip-filter-literal` (R134, the first operator that
  mutates a filter string BC re-parses at runtime rather than AL that `alc` compiles),
  `swap-find-direction`, `validate-to-assign`, and `swap-modify-flag` extended from `Modify` to
  `Insert`/`Delete` (R136). Every one landed with its per-mutant verdicts pre-committed and matched
  against a live container.
- **`declarativeSites` in the report** (R144). Sites LethAL declines to mutate because they are
  declarative properties were counted and then thrown away in a warning; the report now carries
  them.
- **The BC build that produced the verdicts** is recorded on the al-runner path (R129).
- **`lethal doctor` works for an al-runner-only project** (R146) instead of refusing it.
- A source-overlay renderer, `scripts/render-overlay.ts`: a run drawn on the code it measured, with
  "ran" at procedure granularity (which is all coverage knows) and "checked" per site.
- CI and release workflows (R154).
- **`validity.executionContext` on every report** (R60). LethAL executes every mutant headlessly,
  so every verdict describes your app's NON-interactive branch, while a developer running the same
  suite from VS Code runs GUI-allowed — the two are not measuring the same code, and nothing said
  so. Required rather than optional, and printed on every run including a clean one, because the
  reader most likely to quote a score without qualification is the one whose run had no other
  caveats. Measured before it was written (`scripts/measure-gui-guarded.ts`, Continia Document
  Output, 551 `.al` files): **62 of 19,850 mutation sites — 0.3% — sit inside a
  `GuiAllowed`/`Confirm`-guarded branch**, which is why this is a stated limit rather than a
  per-site signal. Note the three constructs differ: `Message` is a no-op, `Confirm` forces its
  DEFAULT answer (so the non-default arm is the unreachable one), and `Page.RunModal` errors.
- **`bcdev.altoolPath` config override** (R64) to pin the publish tool, alongside the existing
  `bcdev.alcPath` (R43) for the compiler. The publish tool build is not interchangeable either: the
  AL extension's bundled `altool` 17.0.2273547 silently ignores `BC_SERVER_USERNAME`/
  `BC_SERVER_PASSWORD` for `publishapp` and its `auth login` is AAD-only, while the
  `microsoft.dynamics.businesscentral.development.tools` 18.x dotnet tool reads them and publishes.
  The two overrides are independent, so compile and publish can run on different builds — and,
  set together, they now satisfy the "no AL extension installed" gate on the container path as
  well, which previously demanded the extension no matter what the config named.

### Changed
- **Vendored tree-sitter-al 3.2.1 to 4.0.1** (R133), a breaking grammar release that moves named
  trees LethAL hashes. Thirty-two empty-block identity hashes were re-keyed with per-site proof and
  all six live gates re-measured unchanged.
- **al-runner stops re-downloading 230 MB of platform apps per invocation** (R147, R130): the
  platform-app directory is pinned with `--package-cache`, and the double provisioning inside a
  single invocation is gone. 17.1 s per invocation became 6.8 s.
- The platform-artifact screen no longer tags every `Insert` mutant (R143): the tag is dropped when
  the receiver's `OnInsert` provably does not assign the primary key, so the screen stops
  over-reporting. A receiver that cannot be resolved keeps the tag.

### Fixed
- **A trigger mutant could score `survived` when its only covering test was red** (R140), where
  member-level attribution correctly declines to score at all.
- **A stale published TEST app was indistinguishable from genuinely failing tests** (R139) and cost
  a full gate run to diagnose.
- **Conformance refusals that asserted nothing** (R137, R142): an empty expectation passed on any
  input, and a non-empty one never checked for extra specs.
- **Two more `error` shapes recorded no `cause`**, one of them labelled `deadline-exceeded` when it
  was not one (R122).
- Eight `scripts/` files did not compile under the repo's own strict flags, and two had produced
  numbers a roadmap decision was made on (R120).
- **A permissions refusal at baseline discovery no longer reads as an unsupported test type**
  (R35). R27 taught LethAL to name the `TestPermissions` cause, but only on the `unstable` path.
  A test BC refused at *baseline discovery* never reaches it: the test was dropped from the green
  set and the mutants it alone covered were recorded `error` with the note "unsupported test
  type", pointing the reader at their test's type when the fix is one property
  (`TestPermissions = Disabled`) in their own source. Those mutants now carry a note naming the
  permissions cause and quoting BC verbatim, the report gains `permissionsRefused` and a
  `tests-permission-refused` caveat, and the same refusal recognised on the `unstable` path feeds
  the same field — so a run can no longer disagree with itself about whether it hit one.
  **Known limitation:** the detector matches BC's English refusal text, so a non-English server
  still gets a silent miss (never a wrong answer) — tracked as R66 and pinned by a test.
- **A failed tool spawn could report nothing at all** (R65). A Bun spawn `ENOENT` arrives with an
  EMPTY `message`, so catches that stringified `err.message` reported a blank cause — how R64's
  wrong-platform binary presented, and why it took a long external session to trace. `alc`,
  `altool` and the configured environment tool now report the OS error code, syscall and path.

- **The bcdev backend on Linux and macOS hosts** (R64). `defaultAlToolPaths()` hardcoded `bin/win32/`
  regardless of `process.platform`, so every non-Windows run spawned a Windows PE `alc.exe`/
  `altool.exe` that cannot execute — including anyone using the released Linux and macOS binaries,
  for which the bcdev backend could never have worked. The failure surfaced many layers up as an
  opaque, message-less `Error`. The AL Language extension ships per-RID builds side by side
  (`bin/win32/{alc,altool}.exe`, `bin/linux/{alc,altool}`, `bin/darwin/{alc,altool}`, verified
  2026-07-31 against `ms-dynamics-smb.al-18.0.2498801`); LethAL now picks the one matching the host,
  and refuses loudly on a host the extension ships no build for instead of guessing a RID.
  Reproduced the frozen `itest:bcdev` baseline exactly — **3 killed / 10 survived / 3 no-coverage**,
  `authoritative`, `baselineGreen` — against a live Linux Docker BC 28.1 container, with the run
  costs recorded in `docs/benchmarks/runs.jsonl` (the ledger's first plain-container rows).

### Security
- **Six committed campaign reports carried 1,857 fields of a third party's AL source** in this
  public repository. They predate the redaction ruling and were never swept. Redacted, and the
  guard now discovers the report set by glob instead of naming two paths by hand, which is how it
  missed them.

## [0.1.0-alpha.1] — 2026-07-27

First distributable build. LethAL has run against live Business Central servers throughout
development; this is the first release that someone other than its authors can download and run.

Alpha means the tool is honest about its own limits rather than complete: the al-runner backend is
measurably not authoritative, individual survivors are still not proven non-equivalent, and several
classes of AL construct are never mutated. Known gaps are listed at the bottom of this entry.

What this release *can* now claim, and could not before: **coverage selection does not hide kills.**
Two runs of one Continia Document Output codeunit, identical except for `coverageMode`, compared
per-mutant across all 138 mutants — no mutant reported `survived` or `no-coverage` under selection
turned out killable by the full suite (R37). That is the failure mode (R29) that once produced 10
false survivors out of 20 on a fixture, and on a real product it is empty.

### Added

- **Standalone binaries** for Windows x64, Linux x64/arm64 and macOS x64/arm64, built with
  `bun build --compile`. No Bun, Node or npm install required on the target machine. The tree-sitter
  AL grammar and the web-tree-sitter runtime are embedded in the executable.
- **`lethal --help` and `--version`** (R49), and usage for a bare `lethal`. Both are intercepted
  before `parseArgs`, which runs in strict mode and previously turned `--help` — the first flag a
  new user types — into a raw `TypeError` with a stack trace into the bundled binary. The version
  is bundled by a static JSON import, not read from disk, for the reason R50 measured.
- **Tier-2 mutation operators** (R10) — `RemoveTestField`, `RemoveSetRange`, `RemoveCalcFields`
  and `SwapModifyFlag`, over a shared `claimsRecordMethod` receiver predicate. These mutate table
  triggers, which Tier 1 never reached.
- **Page, report, `pageextension` and `tableextension` instrumentation** (R40). Previously only
  codeunits and tables could carry the injected selector variable, and the stated reason for that
  turned out to be wrong: the constraint is *where* in the object the `var` is anchored, not which
  object kind. On a real app (Continia Document Output) this took mutant sites from **11,777 to
  19,832** and instrumented files from **162 to 438** — app coverage 59% → 90%.
- **`--only <glob>`** (R41), repeatable, to scope which files contribute mutants, so a large project
  has a cheap first run. Narrows spec generation only: every file is still parsed into the
  project-wide semantic context, compiled and published, because narrowing the parse set would
  silently change verdicts through the Tier-2 shadowing guard.
- **`--tests-only <glob>`** (R45), repeatable, to narrow the baseline test suite. On Document Output
  this cut the baseline from **744.8 s to 25.0 s** and the total run from **953.8 s to 231.2 s**,
  with identical verdicts. Unlike `--only` this *can* change a verdict — excluding a killing test
  turns a kill into a survivor — so it carries its own `tests-narrowed` report caveat and degrades
  `validity.reliability`.
- **`--max-guards-per-batch <n>`** (R44) to bound how many injected guards go into one published
  artifact. Publish cost scales with guard count because BC recompiles the extension server-side:
  163 guards published in 28 s, 11,777 hit a hosting proxy's `504 Gateway Time-out` at 362 s.
- **`--selector-id` / `--control-id` / `--table-id` flags and a `selectorIds` config section** (R3).
  The three injected object ids were hardcoded to 79197–79199, so a project whose `app.json`
  `idRanges` excluded them could not be instrumented at all. Resolution is CLI > config file >
  default, decided independently per id, and validated against the target's declared `idRanges`,
  against already-declared codeunit ids, and pairwise — all before any `alc` invocation.
- **Two instrumented projects can now share one BC container** (R4), a direct consequence of R3.
  Verified live with two apps simultaneously installed on one container.
- **`bcdev.alcPath` config override** (R43) to pin the AL compiler. `alc 18` writes OPC part names
  with single-encoded spaces, producing a package BC 28 refuses with `Specified part does not exist
  in the package.`, while `alc 17` builds the same source successfully. Both compilers exit 0 — the
  defect surfaces only at publish. The encoding difference itself is upstream in Microsoft's `alc`.
- **Custom environment tool support** (R15/R16) — run against environments owned by an external CLI,
  described purely in config (tool path plus command templates for create / resolve / symbols /
  publish / delete). LethAL's fenced `RunMutant` path still decides every verdict. Gate frozen at
  3 killed / 10 survived / 3 no-coverage, identical to the direct-container gate on the same
  fixture.
- **`notInstrumented` on the session report** (R5) — how many files and mutation sites were never
  measured because their object kind could not carry the selector variable. Without it a page-heavy
  project got a confident-looking score computed over a fraction of its code.
- **`guardObserved` per mutant** (R46) — whether any instrumented guard actually fired for a
  mutant's runs. Deliberately asymmetric: `false` is decisive (the mutation was never in play, so
  the mutant belongs with `no-coverage`, not with findings), `true` is weak (some selector fired
  somewhere in the artifact), and absent means not measured. First measurement on Document Output:
  86 of 86 survivors `true`.
- **Stale-test-app detection** (R31). The runner discovers tests from source while the server holds
  an older published set; mutants then fall to `no-coverage` and read as a scoring problem rather
  than "your published test app is older than your source". Cost two debugging sessions before it
  was detected. Reported as `staleTestApp.missingTests` with a `stale-test-app` caveat.
- **al-runner startup canary** (R7/R8) — the two known al-runner defects are now re-measured against
  the binary actually configured, every session, instead of repeating a claim frozen at the date
  someone last checked by hand. The verdict is attached to the report, not only printed to stderr.
- **Permission canary** (R26/R27) reporting whether the fenced path can write, plus a targeted
  diagnosis when a test is refused: the failure note names the likely missing
  `TestPermissions = Disabled`, quotes BC's own refusal text, and says what to declare.
- **Env-tool crash-recovery records are now read** (R17). `~/.lethal/env-state/<runId>.json` had a
  writer and no reader, so the recovery story for a leaked environment was a file nobody looked at.
- **Resource files reach the compiler** (R39). The batch project copied only `*.al`, so a real app's
  logo, translations, layouts and permission XML never arrived and `alc` stopped at
  `AL1001: Source file 'Images\Logo.png' could not be found` before compiling a line. Basename
  collisions among `.al` sources are now detected and refused naming both files, instead of silently
  dropping one.

- **`--mutant-timeout-ms`, `--resume` and `--resume-run`** (R47). One slow or hanging
  (mutant, test) pair used to cost the entire run: the per-mutant budget was a hardcoded floor with
  no config surface, and exceeding it is indistinguishable from "the server may still be executing
  this", so the session quarantines. `--resume` recovers an aborted run by skipping only the
  execution of mutants already scored — verdicts are carried by IDENTITY, so an edited site stops
  matching and re-batching is survivable, while coverage attribution and covering-test lists still
  come from the resumed run.
- **`--retry-stranded`** (R53), and skipping stranded mutants by default. A mutant that never
  terminates — measured: `until Rec.Next() = 0;` negated to `<> 0` — reproduces its own quarantine
  on every retry and blocks every mutant behind it. It is now recorded as an unmeasured error and
  stepped over, so the run completes.
- **`--allow-large-run`** and a pre-flight size refusal (R48). An unscoped run on a real project
  costs days and usually cannot publish at all, so it is refused before anything is deployed, naming
  every narrowing lever. `--dry-run` prints the same limit instead of refusing.
- **`envTool.requireStatus`** (R34). A reused environment that has idled is refused by name rather
  than resolving a dead endpoint and failing minutes later inside the transport. The expectation is
  config-declared; no vendor's status vocabulary lives in LethAL.
- **`MutantOutcome.carried`** (R54) — provenance for a verdict a resume reused rather than measured.

### Fixed

- **False survivors from coverage attribution** (R29) — the worst output a mutation tool can
  produce, and it was live. BC does report table-trigger coverage, but `SymbolReference.json`
  records no trigger, so the lookup missed, the fallback scanned *local* procedures (empty for a
  table whose procedures are public), and the observation was dropped entirely. Measured on the
  Phase-1 fixture: **10 of 20 survivors were false**. Each was driven through the fenced path
  against its intended killer and killed — 53/20/2 became the honest 63/10/2. Perversely, a table
  with public procedures scored *worse* than one with none, and every real app is in the losing
  category.
- **Instrumented codeunits that declare object properties did not compile** (R38). The selector
  variable was anchored before the object's properties; AL requires properties before any `var`
  section, so `alc` read `Permissions` as a variable name and never recovered. On Document Output:
  **19 of 162 instrumented files, 246 alc errors, whole-app compile fails, zero mutants runnable**.
  Note tree-sitter recovers from the bad ordering with no ERROR node, so the error-node count was
  structurally blind to it — `alc` is the authority here.
- **Declarative page properties were claimed as mutation sites** (R40). An AL page property parses
  with statement syntax (`SubPageLink` reads `"No." = field("Customer No.")`), so
  `negate-conditional` / `conditional-boundary` matched 204 sites that are not executable AL at
  all; one aborted a whole session. Now filtered once at spec generation, counted and warned rather
  than dropped silently.
- **Coverage keyed on `(objectType, objectId)`** rather than the bare id — a table and a codeunit
  sharing an id sent a trigger mutant at the wrong object's tests.
- **Per-mutant time budget floored at 30 s** — an unfloored `2 x baseline` quarantined a cold start
  as in-flight-unknown.
- **Stale `LethAL Control` builds are named** (R25). A control app older than its AL source
  published fine and then failed harness verification with BC's confusing
  `the parameter 'clientProtocol' ... is not a valid parameter` — confusing precisely because the
  endpoint exists and answers, it just rejects an argument added later.
- **A configured `envTool` section is no longer silently ignored under `--backend al-runner`** (R18),
  and env-tool mode no longer hard-requires `altool.exe` on a path that never uses it (R21).
- **`itest:tables` runs its session twice** and asserts run-to-run equality (R9), matching the other
  gates, so cross-run nondeterminism surfaces as a determinism failure rather than a confusing
  per-mutant baseline mismatch.

- **The compiled binary could not parse a single line of AL** (R50). Both wasm assets resolved
  relative to `import.meta.url`, which under `bun build --compile` is Bun's virtual root. The unit
  suite is structurally blind to this — it runs interpreted, where the relative resolve is correct —
  so it was caught by running the produced binary from a foreign cwd, not by a test.
- **`lethal --help` exited 1 with a `TypeError`** (R49), for the first flag a new user types.
- **`force-reset-lease` could not reach an env-tool environment** (R51). It built its URL with
  port-7048 injection and ignored `bcdev.baseUrl`, so the documented recovery procedure was
  unreachable on the one setup that most needs it — a proxy-severed run. The instance must now match
  a path SEGMENT of the configured URL, because a substring check passes a one-character instance
  against almost any hostname.
- **A stale `LethAL Control` build was undetectable** (R28). `HarnessInfo` reported a hardcoded
  version, so every new client action failed in its own way instead of the harness saying once that
  the control app predates the client.
- **`--resume` preferred an empty aborted run over one holding verdicts** (R52), which is the
  situation recovery is for.
- **A resumed run's phase clocks did not add up** (R54): `mutantsMs` counted durations carried from
  a prior run, and `overhead`'s clamp hid the resulting contradiction as a plausible `0.0s`.
- **Verdicts from an unattested artifact were corrected in memory only** (R47). The fail-closed
  attestation gate relied on a quarantined run never being marked finished; `--resume` selects on
  exactly that condition, so the correction is now durable.

### Known limitations

- **The al-runner backend is not authoritative.** `asserterror` never fails a test there (R7), so
  a mutant killable only by an `asserterror` assertion is reported as survived. Under-reporting
  only, never a false kill. A table global written by a trigger is also dropped (R8). Re-confirm
  survivors under `--backend bcdev` before acting on them.
- **`--workers > 1` is refused with `--backend bcdev`.** Mutant activation is a single server-side
  record shared by every worker, so concurrent workers would overwrite each other's active mutant.
  Real parallelism needs per-container isolation.
- **Single-tenant containers only, unenforced** (R2). AL cannot enumerate tenants from an extension,
  so the lease cannot fence a second tenant. Verify single-tenancy out of band.
- **A file declaring two AL objects** is handled only when every object in it is injectable (R6).
- **Enums and queries are still never mutated**, and `xmlport` remains uninstrumented (R40 covered
  page, report, `pageextension` and `tableextension`).
- **A mutant that never terminates is not scored, only stepped over** (R53). AL cannot preempt a
  running loop, so LethAL sees only its own client-side abort, which it must treat as "the server
  may still be executing this". Such a mutant arguably SHOULD count as killed (a timeout is
  observable misbehaviour), but scoring it needs `RunMutant` to return a terminal timed-out result —
  an AL change plus a protocol bump. Today it is recorded as an unmeasured error, and `--resume`
  steps over it so the rest of the run completes.
- **Coverage collection makes some tests fail, which under-reports what the suite exercises**
  (R55). Measured on Document Output: with the default `coverageMode`, 12 of 56 tests fail and the
  baseline goes red; with coverage off the same tests on the same environment all pass. The knock-on
  is that 14 mutants are reported `no-coverage` when the suite does execute them — which tells a
  reader to write a new test when the real answer is to strengthen an existing one. Safe direction
  (no false kill, no false survivor), but the mechanism is not yet established.
- **Hosted environments can time out on publish** (R44). The proxy cap is real and unraisable from
  the client; `--max-guards-per-batch` is what keeps LethAL from asking it to swallow an unbounded
  artifact.

<!-- No link-reference definitions for the version headings yet: this repository has no configured
     git remote (`git remote -v` is empty as of 2026-07-27), so there is no release page or compare
     view to point at. Add them when a remote exists — see docs/releasing.md. -->
