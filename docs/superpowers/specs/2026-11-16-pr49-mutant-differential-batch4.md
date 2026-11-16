# PR-49 pre-commitment: the mutant-level differential (PR-34/40/46 method), batch 4: Regex, Recurrence Schedule, Record Link Management, Headlines

Status: pre-commitment (coord PR-49, lethal-code, 2026-11-16), before the copies are built, and before any v3 or bcdev run. Method,
classes and safety steps: PR-46 (`2026-11-16-pr46-mutant-differential-batch3.md`, addendum 1). The bcdev side is lethal-bugs'.
Evidence: `/coord/handoff/PR-49/`. Invented AL only in anything committed.

## The modules (BC.History System Application, green on v3), chosen for features no batch has covered

| module | v3 mutants (R-953/964/969) | tests | feature not yet covered | test app needs |
|---|---|---|---|---|
| Regex | 344 (200 killed) | 18 | .NET regular expressions, match groups | Library Assert |
| Recurrence Schedule | 280 (92 killed, 77 error) | 29 | date arithmetic, recurrence patterns | its test library, Library Assert, Any, Permissions Mock |
| Record Link Management | 87 (42 killed) | 9 | record links and notes | its test library, Library Assert, Any, Permissions Mock |
| Headlines | 73 (53 killed) | 5 | text by time of day (v3's noon clock, #8161) | its test library, User Login Times' test library, Library Assert, Permissions Mock |

None has a `[NonDebuggable]` file. Skipped: SFTP (254, mostly no-coverage: network).

## The copies (`/coord/handoff/PR-49/src/`, `prepare.md`; not committed)
As PR-46:
- each module, its test app and its test libraries get their own namespace (`LethAL.PR49.*`) and object ids 92100-92299, and
  depend on the server's System Application for its public modules;
- PR-40's publish lessons apply: permission-set names, header spacing, no DotNet type BC on Linux lacks;
- **PR-46's lesson (#8171):** an object whose name the System Application also has is renamed `PR49 ...`, because v3 binds by name
  across namespaces.
All apps compile clean against the server's symbols.

## Scope, modes, predictions
- v3 first: the hang census, then every mutant; **0 timeout-killed** per module before its bcdev run. bcdev: same scope,
  `--stop-hung-sessions` always, coverage `procedure`.
- Prediction 1: baselines green on both backends. A red BC baseline is a finding; that module is compared on its green tests.
- Prediction 2: per mutant, the same verdict and killing test, except PR-46's known classes:
  - (a) a v3 refusal BC scores;
  - (b) a killing test that differs, R197;
  - (c) no-coverage against survived, or install code;
  - (d) the GUI branch;
  - (e) the noon clock, #8161. Headlines is expected to show it if a test pins the greeting by time of day;
  - (f) the Field closure, #8170;
  - (g) a name bound across namespaces, #8171, should any remain.
  Any other killed/survived disagreement, or a bcdev `error` that v3 scored, is a finding: classified, then an invented repro,
  an upstream issue, a regression entry and an R586 row if it is al-runner's.
- Prediction 3: the per-module agreement rate is reported, as in PR-46.
- Prediction 4: no daemon is stranded; no server restart.
