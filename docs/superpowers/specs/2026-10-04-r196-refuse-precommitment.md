# R-196 pre-commitment: refusing hang-capable sites moves `itest:hang` by two mutants

Written 2026-10-04, BEFORE any live run of the R-196 refusal code (worktree `/work/lethal-wt/r196`,
branch `lethal/r196` off master `d5ee5a04`, uncommitted). No gate has run on this code. Sources: the
adopted plan `docs/superpowers/plans/2026-10-05-R-196-refuse-hang-capable-sites.md`, an offline
`lethal run --dry-run --out` of every fixture and example on both master and this code (per-site
listings diffed), and the gate files under `packages/runner/itest/`.

## What changed

The four value operators (`remove-assignment`, `shift-integer`, `swap-additive`,
`flip-boolean-literal`) now REFUSE a site that writes a variable an enclosing `while`/`repeat`
condition reads (R196, the existing `hangCapableForMutatedNode` detector). Before, they emitted it
with a `hangCapable` tag that changed nothing at run time. `flip-boolean-literal` also refuses a
literal that reaches a loop's exit through parentheses, `not`, `and`/`or` or a `#if` tail, or that
is the condition of an `if` inside a loop (R239). The refusal is silent: no report, event or schema
change. Identity scheme 9 -> 10.

## Offline fixture count (measured, both trees)

Deployed mutants per `lethal run --dry-run`, per-site listing diffed (file, line, operator):

| fixture | gate(s) | before | after | removed |
| --- | --- | ---: | ---: | --- |
| `fixtures/sandbox-app` | itest:bcdev, itest:envtool, itest:alrunner | 19 | 19 | none |
| `fixtures/sandbox-data` | itest:tables, itest:chunked | 387 | 387 | none |
| `fixtures/sandbox-hang` | itest:hang | **40** | **38** | two, below |
| `fixtures/sandbox-symbols` (none / LETHALA / LETHALB) | itest:alrunner symbol legs | 9 / 9 / 9 | 9 / 9 / 9 | none |
| `fixtures/sandbox-layout` | itest:alrunner layout leg | 10 | 10 | none |
| `fixtures/sandbox-harden` | harden baseline | 21 | 21 | none |
| `fixtures/sandbox-multiobject` | alrunner multiobject baseline | 12 | 12 | none |
| `fixtures/sandbox-coverage-probe` | none | 80 | 80 | none |
| `fixtures/sandbox-probes` | none | 269 | 269 | none |
| `examples/gift-card` | demo campaign (frozen 60) | 60 | 60 | none |
| `examples/credit-limit` | demo | 42 | 42 | none |

No site was added anywhere (no dedup displacement). R239's shapes have zero sites in every fixture
and example.

The two removed mutants, both in `DrainQueue` (`fixtures/sandbox-hang/src/HangLogic.Codeunit.al`):

- line 104, `lethal.remove-assignment` (deleting `Pending -= 1`), today `killed`;
- line 104, `lethal.shift-integer` (`1` -> `2` in `Pending -= 1`), today `killed`.

`Pending` is read by `while Pending > 0`, so both are `loop-condition-target` sites. Both were
KILLED by Int32 overflow of `Drained`, not by the budget: they are the refusal's measured
over-approximation, not hangs.

## Predictions for `itest:hang`

ON leg (`--stop-hung-sessions`):

| figure | before (pinned today) | predicted |
| --- | ---: | ---: |
| mutants (`EXPECTED_ON` rows) | 40 | **38** |
| killed | 26 | **24** |
| survived | 9 | 9 |
| timeout-killed | 5 | 5 (lines 37, 43, 44, 73, 145) |
| warmKills | 4 | 4 |
| groupedCalls (asserted as scored + warmKills) | 44 | **42** |

Every other row of `EXPECTED_ON` keeps its line, operator, verdict and `killPosition`. In particular
every `killPosition` in `SpinUntil` (lines 140 to 147) is unchanged: the kill ledger that orders
covering tests is per procedure, and `DrainQueue` is a different procedure. The `M` codes after the
removed pair renumber (one counter over the whole id batch; this fixture has one file), but the gate
keys rows by line and operator, so no row is re-paired.

OFF leg (no `--stop-hung-sessions`): unchanged. It strands at line 37 (`CountUpTo`'s
`void-method-call`), long before `DrainQueue`, so it never reaches the removed pair. Its assertions
(`mutants.length < EXPECTED_ON.length`, zero `timeout-killed`, an `error` that "could not be
confirmed complete", a `deadline-exceeded` row) all still hold with 38 rows.

Identity keys: within `DrainQueue` no same-tuple twin follows a refused site, so no surviving
mutant's key moves on this fixture; the scheme bump is for the general case (an earlier refused twin
hands its key to a later one, pinned by `packages/runner/tests/r196-identity.test.ts`).

## How the gate changes

- `packages/runner/itest/hang.itest.ts`, `EXPECTED_ON`: delete the two rows
  `{ line: 104, operator: "lethal.remove-assignment", verdict: "killed" }` and
  `{ line: 104, operator: "lethal.shift-integer", verdict: "killed" }`, and rewrite the overflow
  comment above them: those were killed by overflow, not hangs, and are now refused. Nothing else in
  the file is a number this change moves: `EXPECTED_WARM_KILLS` stays 4, the `timeout-killed` count
  stays 5 and line 145 stays its fifth, and `groupedCalls` is computed from the counts.
- **No `*.baseline.json` exists for `itest:hang`.** Its frozen table is `EXPECTED_ON` in the test
  file itself, so R332's record-mode procedure does not apply and nothing is re-recorded.
- Offline pins that move with it (already updated in the same change): the sandbox-hang hashes in
  `packages/runner/tests/fixture-emission.test.ts` (`HangLogic.Codeunit.al` and
  `mutant-manifest.json`) and the R-307 O1 golden records
  (`packages/runner/tests/__fixtures__/instrumented-output-golden.json`: sandbox-hang 40 -> 38
  mutants and its sha256; `reach-grain-golden.json`: sandbox-hang `M0039`, `M0040` removed, every
  other entry unchanged). The golden re-record needs the orchestrator's ruling.

## Every other gate: unchanged by construction

Zero per-site difference in their dry runs, so no verdict, count or pin can move:

- `itest:bcdev`: 3 / 12 / 4 over 19, `groupedCalls` 15, `warmKills` 0.
- `itest:envtool`: 3 / 12 / 4 over 19.
- `itest:alrunner`: sandbox-app 3 / 12 / 4 over 19 on every leg; symbol legs 5 / 4 / 0 over 9 per
  set (LETHALA, LETHALB); layout leg 7 / 3 / 0 over 10; multiobject 12 mutants.
- `itest:tables`: 301 / 68 / 18 over 387, `groupedCalls` 382, `warmKills` 13.
- `itest:chunked`: both legs 17 / 7 / 2 (a `--only` subset of sandbox-data, which has no diff).
- harden: 21 mutants, its marks file now states `"identityScheme": 10`.
- gift-card demo: 60.

Running them is not required to land this; `itest:hang` (both legs, on the host) is.

A differing verdict on any row is a block, not "close enough".
