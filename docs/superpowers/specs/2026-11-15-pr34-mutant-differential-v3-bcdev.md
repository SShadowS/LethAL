# PR-34 pre-commitment: a mutant-level differential, al-runner v3 against BC (bcdev), on two small all-green modules

Status: pre-commitment (coord PR-34, lethal-code, 2026-11-15), before the measured runs. Evidence folder: `/coord/handoff/PR-34/`.
The bcdev side is lethal-bugs' (standing approval: small BC.History app+test pairs on bc2/bc3, leased, scratch ids, unpublished
after); hand-off agreed with lethal-bugs on 2026-11-15. Related: R1020 (PR-03), PR-14 (test-level differentials), R586 (v3 is
not authoritative), R926 and R975 (v3's line rules).

## Why

PR-03 and PR-14 compared the two backends test by test, on the unmutated modules. A mutation tool's answer is per mutant. This
runs every mutant of two modules on both backends and compares verdict and killing test per mutant.

## The modules, and what was changed to run them on BC

Filter Tokens (5 tests; 2 codeunits) and Secrets (6 tests; 4 codeunits, an interface, DotNet declarations). Both are all green on
both backends (PR-03), have no source dependencies, and their tests open no TestPage. The source is the BC.History copy R-969
used; its test apps are Microsoft's.

A copy of a System Application module cannot be published next to the server's own System Application as is. Each module and its
test app are copied to `/coord/handoff/PR-34/src/` (not committed; corpus source) and changed in only these ways:
- app ids, names and publisher new ("PR34 ...", "LethAL Scratch"), version 1.0.0.0, runtime 17.0 added;
- namespace `System.Text` -> `LethAL.PR34.FilterTokens` and `System.Security` -> `LethAL.PR34.Secrets` (tests: `...Test`), and the
  tests' `using` lines to match; `Filter Tokens Impl.` gains `using System.Text;` (the platform's `Filter Helper Triggers`);
- object ids into 91700-91739 (Filter Tokens 91700-91701, its test 91710; Secrets 91720-91723, its tests 91730-91731); LethAL's
  selector objects at 91707-91709 and 91727-91729;
- `internalsVisibleTo` names the copy's test app (the Filter Tokens tests subscribe to the module's internal events).
All four apps compile clean with alc against bc2's own symbols (`/coord/handoff/PR-14/server-symbols/.alpackages`;
`/coord/handoff/PR-34/alc.*.txt`). Both sides run the SAME copies. Event subscribers in the copies: `Filter Tokens Impl.`
subscribes to five `Filter Helper Triggers` events (the platform's filter-entry hooks), as the original does; the tests call the
module's procedures directly and never raise those events, so on BC the server's original subscribers and the copy's are not
expected to run in a test. If a run shows otherwise it is reported.

## Scope (identical on both sides)

- Secrets: every mutant.
- Filter Tokens: every mutant except those touching only copy lines 92-103 of `src/FilterTokensImpl.Codeunit.al` (the
  `if Length <> 0` block of `MakeFilterExpression`) and 449-453 (the body of `ReadUntilCharacter`): `--lines
  src/FilterTokensImpl.Codeunit.al:1-91 --lines src/FilterTokensImpl.Codeunit.al:104-448 --lines
  src/FilterTokensImpl.Codeunit.al:454-486 --lines src/FilterTokens.Codeunit.al:1-122`. These spans hold the eight
  hang-capable mutants (PR-03's ids on the original: M0041, M0043 at line 90; M0338-M0343 at lines 448-450; all timeout-killed on
  v3), which stay off bc2 (R164: hang-capable sites only in itest:hang; the approval does not cover driving the control app's
  stop). Their other mutants (e.g. M0042) are dropped with them. v3 also runs Filter Tokens without the scope, for the record.

## Runs

- v3: `current` (edge-5a58a0f16), `/coord/handoff/PR-34/v3.sh` (configs `v3.<module>.json`), on the PR-34 head.
- bcdev: lethal-bugs on bc2, the same `--project`/`--tests`/scope and a bcdev config with the same `selectorIds`; per module one
  lease cycle: lease, check absence by app id, LethAL's run publishes the instrumented target, the test app (`build/<m>.test.app`)
  published as the run needs, the run, unpublish test app then target, doctor, release.
- Compare: `bun scripts/report-diff.ts <v3 report> <bcdev report>` per module (keyed per mutant; verdict, killingTest,
  coverageFiltered, errorClass).

## Predictions

1. Baseline: both modules all green on bcdev (Filter Tokens 5/5, Secrets 6/6), as on v3.
2. Per mutant, every mutant both report has the same verdict and the same killing test, with ONE expected exception class: a
   mutant v3 records `no-coverage` from line evidence (R926 reach, R975 trigger placement: a line no test reached) that bcdev,
   whose coverage is per procedure, runs and records `survived`. Those are counted and listed, not findings. Any other difference
   (a verdict other than that, a different killing test, a refused or error row on one side only) is a finding: classified as
   al-runner wrong, BC flaky (re-run once on BC), or LethAL's path, with an invented repro and an upstream issue or roadmap item.
3. No `error` verdict on bcdev that v3 scored.

## Disclosed before the measured runs

- The setup smoke (`/coord/handoff/PR-34/smoke/`, 60 s budget, meant only to check the baselines: Filter Tokens 5/5, Secrets 6/6
  green on v3) completed Secrets' whole mutant phase (68 mutants, 8 s). Its verdicts were not read. The measured v3 run is a fresh
  one after this commit.
- PR-03's v3 run of the original modules is known (Filter Tokens 353 mutants: 214 killed, 108 survived, 8 timeout-killed, 10
  no-coverage, 13 error; Secrets 68: 47 killed, 20 survived, 1 error); that was a different build of the source (ids, namespace).
