# PR-46 pre-commitment: the mutant-level differential (PR-34/PR-40 method), batch 3: Document Sharing, Telemetry, AppSource Product Gallery

Status: pre-commitment (coord PR-46, lethal-code, 2026-11-16), before the copies are built, before any v3 or bcdev run. Method and
rules: PR-34 (`2026-11-15-pr34-mutant-differential-v3-bcdev.md`, addenda 1-2) and PR-40
(`2026-11-15-pr40-mutant-differential-batch2.md`). The bcdev side is lethal-bugs' (standing approval; bc2 or bc3, leased, scratch
ids, unpublished after). Evidence: `/coord/handoff/PR-46/`. Invented AL only in anything committed.

## The modules (BC.History System Application, all green on v3 in R-961)

| module | v3 mutants (R-961) | tests | `[NonDebuggable]` files | its test app needs |
|---|---|---|---|---|
| Document Sharing Service | 167 (87 killed) | 17 | 0 | Library Assert |
| Telemetry | 387 (104 killed) | 9 | 0 | Telemetry Test Library (one permission set), Library Assert, Permissions Mock |
| AppSource Product Gallery | 346 (37 killed) | 7 | 1 | AppSource Gallery Test Library (2 codeunits), Library Assert, Library Variable Storage |

Chosen over the other green modules of a few hundred mutants: Azure Storage Services Authorization has 2 tests and 5
`[NonDebuggable]` files; E-Document Connector - SignUp needs E-Document Core's test apps, which the servers may not carry.

## The copies (`/coord/handoff/PR-46/src/`, `prepare.md`; not committed)

Each module, its test app and its test library get their own namespace (`LethAL.PR46.*`), app ids and object ids (92000-92199).
Dependencies the server's System Application provides publicly are taken from the server. PR-40's lessons apply before any
publish:
- a permission set whose name the server's System Application or its test library also has is renamed (at most 20 characters);
- no object header loses its space before the name;
- no DotNet declaration that BC on Linux lacks.
All apps compile clean with alc against the server's symbols.

## Scope and modes

- v3: every mutant of each module, on `current`. First the hang census and R1050's refusals. The measured v3 run must show
  **0 timeout-killed** per module before its bcdev run. A module with any is not run on bcdev until its hang-capable procedures are
  excluded by whole procedure and the scoped v3 run shows 0 (an addendum names them).
- bcdev: the same scope, `--stop-hung-sessions` always. `coverageMode: "procedure"`, except a module whose run would put any mutant
  in a `[NonDebuggable]` member, which runs under `"none"` (R1049; an addendum says which).

## Predictions

1. Baselines green on both backends. A red BC baseline is a finding; that module is compared on its green tests only.
2. Per mutant, the same verdict and killing test, except these known classes, each listed and not a finding:
   - (a) a v3 refusal (`error`) that BC scores;
   - (b) a different killing test with the same verdict (R197);
   - (c) v3 `no-coverage` where bcdev runs the mutant, or the reverse for install code (R887/R982);
   - (d) the GUI branch (R060/R895);
   - (e) v3's noon clock (#8161);
   - (f) v3's `Field` table closure (#8170).
   Any other difference (a `killed`/`survived` disagreement, or a bcdev `error` that v3 scored) is a finding. Each is classified
   as al-runner wrong, BC flaky (one re-run) or LethAL. An al-runner difference gets an invented repro, an upstream issue, a
   regression entry and an R586 row.
3. The report gives the per-module agreement rate: the mutants both backends scored with the same verdict, of those both scored.
4. No daemon is left stranded; no server needs a restart.
