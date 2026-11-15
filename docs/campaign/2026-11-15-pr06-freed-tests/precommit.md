# PR-06: scoring the tests PR-05's fixes freed — pre-commitment

Committed before any PR-06 run. LethAL master (84a2db83 or later, named per run), al-runner `current` = edge-a184cfc79 (named per
run). Source: PR-05 (`/coord/handoff/PR-05/`): 634 baseline tests that were refused on older builds run on edge-a184cfc79, in 16
BC.History projects (`classify-runs.tsv`, the fixed causes of `states.tsv`).

## Not scorable here
The repro-based fixes (the 122 Subscription Billing tests behind the WINDOWS XmlPort import, and the other #7775 items) belong to
R-915's four Microsoft apps, whose sources, packages and cache were cleaned. They are not re-run in PR-06; that is a gap, not a
measurement.

## Method, per project
1. **Discovery.** `lethal run` with the baseline narrowed to the freed tests' own test files (`--tests-only`, from the triage
   report's `testFiles`), all source files. The covered files are the files of every mutant whose `coveringTests` names a freed
   test. Its verdicts are not the result.
2. **Scoring.** `lethal run` with every test, mutants only from the covered files (`--only`). Fresh store, no `--resume`.
3. **Comparison**, per mutant, by identity key (scheme 48 on both sides), with the project's earlier full run (the reference):
   only mutants that both runs scored.
   - **Allowed moves:** `survived` -> `killed` and `no-coverage` -> `killed`.
   - **Any other move is a BLOCK, explained before submit:** to or from `error`; `killed` -> anything; `survived` ->
     `no-coverage`; `no-coverage` -> `survived`.
4. **Ledger.** `bun scripts/refusal-ledger.ts` over the new stores: no NEW cause is expected from the freed tests, and any NEW one is
   named.

Every run goes through `scripts/heavy-slot.sh` and is retried only on exit 75. Budgets: discovery 1,800 s, scoring 3,600 s. A run
its budget stops is compared only on what it scored, and the receipt says so.

## Amendment 1 (before every run but project 1's smoke run)
Discovery adds `--operator lethal.empty-block`: one mutant per block, so nearly every procedure has one. It finds the covered files
far cheaper than scoring every operator; project 1's smoke discovery scored 1,044 mutants in about 13 minutes. Discovery only
picks the files, and its verdicts are not the result. Project 1 keeps its smoke discovery, which used all operators. Scoring is
unchanged.

## Amendment 2 (2026-11-15 ~08:05 UTC, before the runs it names)
Two build problems, found on reading each report's `runnerBuild`:
- R-982's configs name `edge-736fc7677` by path, not `current`. Projects 982-9 and 982-32 ran on 736fc7677. So did PR-05's
  triage of R-982's four projects (9, 21, 31, 32), which R1013 states as edge-a184cfc79.
- `current` moved to edge-5a58a0f16 at 07:57:56 UTC. Projects 51 and 42 and the ground-truth runs for 15 and 68 were still queued
  in heavy-slot. No LethAL process of theirs had started, so none of them mixed builds, but they would have run on 5a58a0f16. They
  were stopped while queued.

Every run named here is re-run with a config whose `alRunnerV3.path` is pinned to edge-a184cfc79, outputs under `pinned-runs/`:
- PR-06 projects 982-9, 982-32, 51 and 42 (`run3.sh`, `plan-pinned.tsv`);
- the ground-truth runs for 15 and 68 (`none2.sh`);
- PR-05's triage of R-982's projects 9, 21, 31 and 32 (`triage-baseline.ts`), to correct R1013.

The first 982-9 and 982-32 results (on 736fc7677) are kept and reported, but they are not the result. Predictions are unchanged.

## References (the earlier full run per project)

| project | freed tests | reference | reference scope |
|---|---|---|---|
| 18 Sustainability | 257 | R-950/runs/sus | narrowed (40 mutants) |
| 13 Subscription (R-914 sub) | 113 | R-952/sub-cap6 | budget-cut (1,924 mutants, 1,794 no-coverage) |
| 3 Intrastat Core | 106 | R-912/proof/ab2 (store only) | 72 mutants |
| 982/9 Digital Vouchers | 38 | R-917/edv | full (46) |
| 20 Sales Line Suggestions | 35 | R-927/sls.sample | narrowed sample (150, all no-coverage) |
| 52 E-Doc Connector - Avalara | 33 | R-962/avalara.run | budget-cut (1,004) |
| 11 PayPal Payments | 12 | R-917/pyp | full (47) |
| 62 Azure AD Licensing | 10 | R-969/azureadlicensi.run | full (118) |
| 15 Late Payment Prediction | 9 | R-930/m/lpp.onprem | full (1,060) |
| 10 Email Logging | 7 | R-917/emr | full (45) |
| 1 Service Declaration | 6 | R-896/proof/sd-final | full (5) |
| 68 E-Doc Connector (4) | 3 | R-969/edocumentconne4.run | full (1,676) |
| 982/32 Permission Sets | 2 | R-932/permsets.run | every mutant `error` |
| 51 APIV2 | 1 | R-962/apiv2.run | full (7,654, all no-coverage) |
| 57 PowerBI Reports | 1 | R-962/pbi.run | full (2,515) |
| 42 JSON | 1 | R-953/json.run | full (317) |

## Prediction: which projects gain (at least one allowed move)

Rule: a project gains when it has 5 or more freed tests and its reference has a `survived` or `no-coverage` mutant. The rule is
offline and coarse; PR-06 scores it.

- **Gain (11):** 18, 13, 3, 982/9, 20, 52, 11, 62, 15, 10, 1.
- **No gain (5):** 68, 982/32, 51, 57, 42. These have 1 to 3 freed tests; 982/32's reference scored nothing but errors.

No BLOCK is predicted. A BLOCK is a finding (a build difference or a LethAL defect) to explain, never "close enough".
