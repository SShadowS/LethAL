# R-908 pre-commitment: do helper-reach TestPage refusals really open a page?

Committed before any live run, 2026-11-10. Coord task R-908 (owner's ruling on R908). Plan and review: `/coord/handoff/R-908/plan.md`.
Evidence goes to `/coord/handoff/R-908/`. No source text from BC.History is committed: app, test and procedure names and counts only.

## Setup

- **Server:** `bc5`, a throwaway BC 28.4 W1 from kraken, without Microsoft's Bank Deposits, VAT Group Management and Intrastat Core. Not a gate
  server. A test here may wedge it.
- **LethAL:** a scratch worktree, never pushed: master, bc5's setup plumbing from R-882, and one edit that empties the refusal scan
  (`scanTestPageModel`) so the refused tests run. No product change.
- **Apps:** BankDeposits (41 reach-refused tests), VAT Group Management (51), Intrastat Core (78): 170 reach tests. Plain target and test app published
  first, as in R-882.
- **Runs:** `lethal run --backend bcdev`, a tiny `--lines` range with at least one deployed mutant, `--baseline-timeout-ms 60000`, `--tests-only` plus
  `--exclude-test` so a run sends exactly its intended tests, a scratch store per run.

## Order

1. **Pilot:** ONE direct-refused test per app, alone. Its raw failure text fixes the `opened` rule for this server, because LethAL's `TestPage` refusal
   text has only ever been seen on Windows containers.
2. **Groups:** the reach tests in random groups of 10 (seed 908), each with up to 5 plain control tests.
3. At most TWO server restarts in all. Then stop and report what was measured.

## Classes (each test gets exactly one, from the run's store and the verdict's classification)

| class | meaning |
|---|---|
| `opened` | the failure is the page-unsupported text, or a CLR `NotSupportedException` whose top AL frame is a page-opening call (`RunModal`, `Page.Run`, `OpenEdit`, `OpenView`, `Trap`) |
| `no-page-pass` | passed, with no page opened |
| `stopped` / `wedged` | stopped by the budget, or in flight when the tier was quarantined. "May have opened". Before a restart, a wedge is read as `hung` or `reply-lost` from the op status |
| `failed-earlier` | any other failure: says nothing either way |

**"Did not open" means `no-page-pass` only.** A pass that swallowed an error around a page call (`asserterror`, `[TryFunction]`, `if Codeunit.Run`) is flagged when the helpers are read, and
reported apart.

## Anchors

- Every sent test has exactly one class. Each group sends exactly its intended tests.
- The plain controls show no page text and no page-call frame.
- The pilots: BankDeposits and VAT read `opened`, `stopped` or `wedged`. Intrastat's pilot does a long setup first, so any other result there is named, not an anchor failure.

A control that fails its anchor stops the reading until the cause is named.

## Not predicted

No share of `no-page-pass` is predicted: finding it is the point.

## What is reported (in R908, for the owner)

Per app: reach tests, and the classes. `no-page-pass` as a share of all reach tests, and of decided tests only (`opened` + `no-page-pass`), since `failed-earlier` is undecided. The recovery:
tests recovered, and mutants with no non-refused covering test and at least one `no-page-pass` test (v3 covering sets, lower bounds). A recommendation on whether a narrower rule is worth
building. Whether R-882's `NotSupportedException` rows were page opens the reader missed.
