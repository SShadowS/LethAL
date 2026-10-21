# R-595 pre-commitment: re-pin `itest:verify`'s gap ids after R276 (2026-10-21, lethal-preproc)

Written BEFORE the confirming live run.

**Addendum (2026-10-21, still before any live run): a FIFTH pinned id.** `verify.itest.ts` also pins
`OVER_BUDGET_GAP_ID`. That is the gap of `IsOverBudget`'s three mutants, all killed, which the gate asserts
carry one gap id and appear in neither explain list. R595 (filed by code) names it; the table below missed it.
- **Mapped the same way:** `G9890e48cccd0` → `G1b3bb53143f8`. Its members are 3, identical to the three
  `IsOverBudget` rows in `bcdev.baseline.json` (`4004a181…` return-value, `5c9b5c3e…` empty-block, `82a8a378…`
  conditional-boundary).
- **The re-pin:** it replaces this id too. It moves to `verify-gaps.ts` with its members, and the offline test
  pins it the same way.
- **Gaps today:** sandbox-app has six. The four predicted gaps, this one, and `Gb0848d8e882d`, which the gate
  pins nowhere.
- **Prediction:** the live run PASSES with `IsOverBudget`'s rows carrying `G1b3bb53143f8`, in neither list.

**What happened.** R276 (db3fc886, 2026-10-06) changed `gapIdOf` (`packages/schemata/src/project.ts`) to hash
a gap's LINE span and LF-normalised text. It re-pinned the unit tests and the five fixture manifests ("gapId
values only, gap partition unchanged"), but not `PREDICTED_GAPS` in `packages/runner/itest/verify.itest.ts`.
So `itest:verify` has been red on master since then. Code found it in R-583's phase 1.

**The map, computed mechanically.**
- **Tool:** `scripts/r595-gap-map.ts`, which emits sandbox-app's manifest with today's code and groups its
  mutants by `gapId`.
- **Output:** `/coord/handoff/R-595/gaps-now.jsonl`.
- **Matching:** each old gap is matched to the new gap with exactly the same member identity keys. All 24
  pinned member keys were found.

| Gap | Old id | New id | Members |
|---|---|---|---|
| ClampPercent body | `G72826da4c976` | `G82da08c0d8a7` | 5, identical |
| ApplyAudit body | `G140fcb49d7d2` | `G5d4266eab9d8` | 2, identical |
| LogAudit body | `G4e97ec8a420a` | `G557208bb5476` | 3, identical |
| LogAudit then-block | `Gd09a2f841d4e` | `G16ce59f7aad7` | 2, identical |

No gap was ADDED to or LOST from the prediction, and no member moved between gaps. R276 intended the change
(its message: "gapId values only, gap partition unchanged"). So the re-pin replaces the four id strings and
nothing else.

**Predicted for the confirming `itest:verify` run.** It runs on a bc server the orchestrator names as free and
admitted for this gate.
- The gate PASSES.
- The four gaps are reported under their NEW ids, with exactly the members above.
- Every other assertion of the gate holds unchanged: the step-1 verdicts, the no-coverage keys, the three
  driven rows, and the later steps.
- Any gap id or member difference, or any other failure, is a BLOCK, reported as it is.

**The guard against a repeat.** `PREDICTED_GAPS` moves to an importable module with no gate side effects
(R186). A new OFFLINE unit test emits sandbox-app's manifest through the same path as
`fixture-emission.test.ts`, which calls `gapIdOf`, and asserts each pinned gap's id AND member set. A future
change to `gapIdOf`, or to the fixture, then fails the unit suite and CI, not only the live gate.
