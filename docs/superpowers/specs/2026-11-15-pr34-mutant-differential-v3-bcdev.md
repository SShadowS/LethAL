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

## Addendum 1 (2026-11-15, after the first bcdev run of Secrets, before its re-run)

**Measured (lethal-bugs, bc2, lease 382, `/coord/handoff/PR-34/bc/secrets.*`):** Secrets' bcdev baseline is green (6/6), but all 68
mutants are `no-coverage`. Every Secrets procedure is `[NonDebuggable]`, and BC records no Code Coverage line for such a
procedure: each test's stored coverage holds only the selector codeunit's `Active` (91729), although the target's code ran (its
guards call `Active`). v3 records coverage there. So under bcdev's default `coverageMode: "procedure"` Secrets cannot be compared
per mutant. This is a LethAL attribution gap on bcdev (the R175 class: a lost attribution that reads as untested code), filed by
lethal-bugs as a roadmap item. It is not a verdict difference between the backends.

**Re-run:** Secrets on bcdev with `"coverageMode": "none"` (no attribution: every mutant against every green test; the
coverage-differential skill's ground truth), output `bc/secrets.none.*`, otherwise as before.

**Prediction for the re-run:** every Secrets mutant has the same verdict on bcdev (`none`) as on v3. The killing test is compared
too; a different killing test is a finding only where both sides ran the same tests before it (under `none` bcdev runs all six,
v3 only its covering set, so a kill by an earlier test v3 did not run is listed, not a finding). Filter Tokens is unchanged: no
`[NonDebuggable]` there, bcdev's default mode, predictions 1 to 3 as above.

## Addendum 2 (2026-11-15, after the Filter Tokens bcdev run, before any further bcdev run)

**What went wrong.** The Filter Tokens scope did not keep every hang-capable mutant off bc2. M0332 (`ReadUntilCharacter`,
`lethal.empty-block`, its block lines 450-454) touched line 454, which the scope allowed, and `--lines` keeps a mutant that touches
any allowed line. The command also lacked `--stop-hung-sessions` (the control app's stop is opt-in for mutant runs, R053/R191),
so LethAL's own 180 s timer aborted the call, M0332 reads `error` (stranded), and bc2's control-app lease was orphaned (owner
question q-20261115T185041-55e86d96; lethal-bugs holds the lease). The scope was not checked against a v3 run before the hand-off.
Why M0332 exists at all: R1050 (R830 refuses deleting a loop's progress call but not emptying the callee's body).

**The rule for every further bcdev run in PR-34:**
1. The census of hang-capable sites, `bun scripts/census-hang-capable.ts /coord/handoff/PR-34/src/filtertokens` (output
   `/coord/handoff/PR-34/census-filtertokens.{txt,json}`): 2 files, 97 assignments, 10 tagged sites, all in
   `FilterTokensImpl.Codeunit.al`: lines 88, 89, 90, 95, 96, 99, 100, 101 (`MakeFilterExpression`), 444
   (`GetPositionDifferentCharacter`), 453 (`ReadUntilCharacter`); every one with an empty operator list (no operator reaches a
   tagged site). The census covers assignment-shaped hangs only; M0041 (a negated loop condition) and M0332 (an emptied callee,
   R1050) are other shapes, so it alone is not the filter.
2. The scope excludes whole procedures' hang-prone spans: `--lines src/FilterTokensImpl.Codeunit.al:1-91 --lines
   src/FilterTokensImpl.Codeunit.al:104-446 --lines src/FilterTokensImpl.Codeunit.al:455-486 --lines
   src/FilterTokens.Codeunit.al:1-122` (`/coord/handoff/PR-34/scope-filtertokens.txt`), and it is checked BEFORE use: a v3 run on
   exactly that scope (`/coord/handoff/PR-34/v3-scope2/`) gives 341 mutants, **0 timeout-killed** (212 killed, 106 survived, 13
   error, 10 no-coverage). Secrets: 0 timeout-killed on v3 (68 mutants).
3. Every bcdev command carries `--stop-hung-sessions` as a backstop.

**Filter Tokens is not re-run on bcdev in PR-34**: the run on the first scope (331 scored) is compared as it is, with M0332 left
out (error on bcdev, timeout-killed on v3). Its comparison and the Secrets re-run under `coverageMode: "none"` (addendum 1,
waiting for bc2's recovery, now with `--stop-hung-sessions`) are PR-34's two measurements.
