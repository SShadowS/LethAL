# PR-06: scoring the tests PR-05's fixes freed — results

Pre-commitment `precommit.md` (9c181c61; amendment 1 770d06cc; amendment 2 f6db1fe7). Every result below ran on al-runner
edge-a184cfc79, read from each report's `runnerBuild`. The first 982-9 and 982-32 runs went through R-982's configs, which pin
edge-736fc7677; they were re-run pinned to a184cfc79, and the first results are kept, not used. LethAL master 84a2db83. Stores, reports, logs and
scripts: `/coord/handoff/PR-06/` (not committed: reports carry AL source). Per-mutant details: `<key>/compare.txt`;
BLOCK evidence: `blocks.md`.

## Per project
"Compared" = mutants both the reference and the scoring run scored, in the covered files.

| project | freed (pass) | compared | allowed moves | other moves | gain? | predicted |
|---|---|---|---|---|---|---|
| 1 Service Declaration | 6 (6) | 5 | 3 survived -> killed | – | yes, not by a freed test | gain |
| 982-9 Digital Vouchers | 38 (33) | 45 | 4 survived -> killed | – | yes, freed test | gain |
| 15 Late Payment Prediction | 9 (8) | 377 | 14 survived, 1 no-coverage -> killed | 25 S->NC, 13 NC->S, 1 E->S | yes, freed tests | gain |
| 10 Email Logging | 7 (7) | 45 | 1 survived -> killed | 2 S->NC | yes, freed test | gain |
| 11 PayPal Payments | 12 (11) | 47 | 3 survived -> killed | 3 S->NC | yes, not by a freed test | gain |
| 13 Subscription (R-914 sub) | 113 (108) | 177 | – | – | no | gain |
| 3 Intrastat Core | 106 (97) | 48 | – | 23 S->NC | no | gain |
| 52 E-Doc Connector - Avalara | 33 (31) | 468 | – | – | no | gain |
| 62 Azure AD Licensing | 10 (2) | 118 | – | – | no | gain |
| 20 Sales Line Suggestions | 35 (0) | – | – | – | no: every freed test fails | gain |
| 18 Sustainability | 257 (246); 294 (283) on a finished re-baseline (PR-23, R1031) | 0 | – | – | not measurable (not re-run with the 37 more) | gain |
| 68 E-Doc Connector (4) | 3 (2) | 880 | – | 6 S->NC | no | no gain |
| 982-32 Permission Sets | 2 (0) | – | – | – | no covered file | no gain |
| 51 APIV2 | 1 (0) | – | – | – | no covered file | no gain |
| 57 PowerBI Reports | 1 (0) | – | – | – | no covered file | no gain |
| 42 JSON | 1 (0) | – | – | – | no covered file | no gain |

S = survived, NC = no-coverage, E = error. Five projects stopped at their budget in discovery, scoring or both (13, 18, 3, 15, 52)
and are compared only on what they scored.

**Allowed moves: 26 mutants**, all survived or no-coverage -> killed:
- 20 were killed by a freed test: 15 (15), 982-9 (4), 10 (1);
- 6 by another test, not a freed one: 1 (3), 11 (3). These are changes since the older reference, not this pass's freed tests.

## Prediction, scored
- **"Gain", 11 projects:** 18 was not measurable. Of the other 10, five gained (1, 10, 11, 15, 982-9), and in three of those (10,
  15, 982-9) a freed test made the kill. Five did not gain (13, 3, 20, 52, 62).
- **"No gain", 5 projects:** 5 of 5 right.

The offline rule overstated: a freed test that runs is not a freed test that passes, nor one that reaches a weakly tested mutant.
- 20's freed tests all fail; 62 has 2 passing of 10.
- 13 (108 passing freed tests) and 52 (31) covered mutants that were already killed, or that survive with them too.

## BLOCKs (pre-committed rule: any move but survived/no-coverage -> killed): all explained, none a lost kill
- **Survived -> no-coverage: 59 mutants in 5 projects** (3: 23, 15: 25, 68: 6, 11: 3, 10: 2).
  - All are on triggers (OnValidate, OnAction, OnDrillDown, OnInstallAppPerCompany).
  - Each reference attributed them by the object-level trigger fallback (R29); the current LethAL attributes by member and finds
    no test executing them.
  - Ground truth for every project: the moved lines re-run with `alRunnerV3.coverage = "none"`, every test against every mutant.
    0 of the moved mutants was killed. The one other kill on those lines (PayPal line 52) is killed in both scoring and reference.
  - The old "survived" was attribution over code no test reaches.
- **No-coverage -> survived: 13** (15, `CountLPMLInputData`): covered now by a freed test that kills none of them. The
  pre-commitment did not foresee a freed test that covers without killing.
- **Error -> survived: 1** (15): the reference's error was its covering test's refusal (#7834, DateTime before 1753). That test
  runs now.

## NOT COMPARED
18: the reference was narrowed to one file the freed tests' discovery did not reach.

## Ledger
`refusal-ledger.ts`, one store at a time against master's ledger, read all 11 scoring stores used (the pinned 982-9 included).
Budget-cut runs were read with `--run <their latest run>` (`/coord/handoff/PR-06/ledger-all.txt`). It found **21 NEW causes**, and
none comes from a freed test:
- 20 from error mutants;
- 1 from a baseline test that is not a freed one (Sustainability; a CaptionClass refusal).

They are new to the ledger for two reasons:
- Most were met in files no earlier ledger pass read.
- Six (projects 62 and 68: IEnumerator MoveNext and Reset, IEnumerable, ServicePlanId, SkuId, LastError.Rethrow) were already
  error mutants in those projects' references, on edge-c8fe56e05. No ledger pass had read those stores, or the wording changed.

20 are added to `docs/measurements/refusal-ledger.json` as `unexamined`, each noted with its store and kind. Reducing them is a task
of its own.

**One NEW key is withheld.** It is the "an error in a SaveAs of report <x> ... (whether SaveAs raises it or answers false is not
pinned)" refusal (982-9, 1 mutant), and the normaliser leaves the raised error's own message at its end, which is a source label.
This repo is public, so the key is not committed. The normaliser gap is reported for the ledger's owner.

## Not done
The repro-fixed causes' projects (R-915's Subscription Billing and three more, including the 122 tests behind the WINDOWS XmlPort
import) were not run: their sources and packages are gone.
