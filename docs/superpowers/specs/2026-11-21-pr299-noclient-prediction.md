# PR-299 pre-commitment: which DO baseline tests change between al-runner's client session and `--no-client`

Lane lethal-bugs, 2026-11-21. Committed before the run. DO is private: only counts and test codeunit ids are here. The per-test
list is /coord/handoff/PR-299/prediction.tsv (sha256 recorded in the result).

## Why
LethAL's bcdev backend scores tests with `GuiAllowed() = false` (ODataV4). al-runner v3 defaults to `true`, and
`alRunnerV3.noClient: true` (al-runner `--no-client`) makes it false (R895/R907). PR-287 met one effect: a test passes on al-runner
and fails on BC, because a Message behind `if GuiAllowed` feeds the test's only MessageHandler.

## The prediction (offline, parsed; /coord/handoff/PR-299/predict.ts)
- **Method:** DO's AL and the Continia dependency apps' AL were parsed with LethAL's tree-sitter parser, finding the GuiAllowed and
  CurrentClientType sites:
  - DO: 53 sites, 47 regions;
  - Continia: 58 sites, 71 regions.
  Each region is joined to the baseline tests that reach its procedure (perf10c's per-mutant coverage) and to each test's
  declared handlers, with static call following.
- **Of DO's 1,979 baseline tests: 163 predicted to change, 334 unknown, 1,482 predicted unchanged.**

| prediction | reason | confidence | tests | test codeunits |
|---|---|---|---|---|
| change | refused under --no-client: binds a page handler that takes a TestPage | high | 58 | 68850 68861 68877 68883 68912 68934 68945 68960 68984 68994 |
| change | refused under --no-client: uses a TestPage | high | 56 | 68850 68861 68884 68911 68943 68945 68956 68964 68983 68984 68989 |
| change | client baseline fails "Unhandled UI: Confirm"; --no-client refuses it (fail becomes not run) | medium | 29 | 68857 68859 68874 68929 68934 |
| change | (a) a bound handler fed only by GUI-guarded calls goes unused: pass becomes fail | medium | 20 | 68892 68903 68992 68996 |
| unknown | the GUI branch shows UI the test has no handler for | low | 47 | 15 codeunits |
| unknown | the GUI branch changes only state | low | 19 | 68874 68911 68914 68945 68963 68967 68968 |
| unknown | no source found for a bound handler (Microsoft apps are not parsed) | low | 12 | 68871 68904 68953 68996 |
| unknown | a `not GuiAllowed` branch runs | low | 6 | 68859 69006 |
| unknown | not run in the client baseline | n/a | 250 | 32 codeunits |

- **Not predicted per test:** DO's login subscriber reads `Session.CurrentClientType()`. Under --no-client, al-runner may refuse
  it outside a test method, and that could refuse whole codeunits. If that happens, it is reported as its own finding.

## Pass / fail of the prediction
- **The run:** DO's baseline on `current` twice, `alRunnerV3.noClient` false then true, and the per-test outcomes joined.
- **High-confidence rows (114):** a miss in more than 5% is a failed prediction, and the result says so.
- **Medium rows (49), predicted-unchanged rows (1,482):** the change count and the misses are reported per reason.
- **Every unexpected change gets its own reason in the result.**

## Hindsight check, NOT part of the prediction
PR-287's BC baselines (422 tests, GuiAllowed = false) were joined AFTER the prediction was made:
- all 21 tests that pass on al-runner and fail on BC with "UI handlers were not executed" are predicted changes;
- all 20 reason-(a) tests change on BC;
- 0 predicted-unchanged tests changed.
It is reported as a cross-check, not a validation.
