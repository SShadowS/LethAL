# Rung 0 — pre-commitment

Written and committed **before** the Continia environment was created, per the plan's gate rule.

## The dry-run pre-commitment

Command, run against the pinned worktree:

```bash
bun packages/runner/src/cli.ts run \
  --project U:/Git/do-lethal/Cloud --dry-run \
  --only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al"
```

**Pre-committed result: 1 file, 176 mutant sites, 1 batch.**

Per-operator composition, recorded so a future drift is attributable rather than merely visible:

| operator | count |
|---|---|
| `lethal.void-method-call` | 55 |
| `lethal.empty-block` | 30 |
| `lethal.negate-conditional` | 25 |
| `lethal.return-value` | 20 |
| `lethal.remove-setrange` | 19 |
| `lethal.swap-call-arguments` | 10 |
| `lethal.conditional-boundary` | 8 |
| `lethal.remove-testfield` | 3 |
| `lethal.remove-commit` | 3 |
| `lethal.remove-calcfields` | 3 |
| **total** | **176** |

### Why this is not the historical 138 or 105

`105` was never a generation count — it is what the severed 2026-07-28 fenced run *reached* before
M0013 latched the session (`docs/measurements/README.md:313-316`, "105 of 138"). The deployed count
that day was 138.

Of the 38-mutant delta from 138 to 176, **13 are attributable by operator name**:
`swap-call-arguments` 10 (`f9e055c`, 2026-08-03) and `remove-commit` 3 (`9b541cf`, 2026-07-31), both
after the differential. **The remaining 25 are unreconciled** — the obvious explanation ("the Tier-2
record-method set is new") is false, since the Tier-2 scaffold registered at `fbda298` and
`RemoveSetRange` landed at `50a7118`, both 2026-07-26, *before* the differential. Reconciling it
exactly is impossible without the lost per-mutant record, which is itself one more reason
per-identity comparison to 2026-07-28 is dead rather than merely inconvenient.

## Selector ids

DO's `Cloud/app.json` declares `idRanges: [{ from: 6175271, to: 6175468 }]`. `DEFAULT_SELECTOR_IDS`
(79197–79199) sits outside it, so `validateSelectorIdsForProject` refuses. Chosen, verified free
against the 116 codeunit ids the project declares:

| role | id |
|---|---|
| `selectorId` | 6175468 |
| `controlId` | 6175467 |
| `tableId` | 6175466 |

All three injected objects are codeunits, so the declared-codeunit set is the right collision set
(`id-ranges.ts:65-90`).

## Gate 0 — six items, each with its observable

Pass/fail recorded in `rung0.result.md` after the run. All six must hold before rung 1 starts.

1. **LethAL Control publishes and harness-verifies.** Build it first (`/control-app`) — R25: a stale
   local `lethal-control.app` publishes fine and then fails with a confusing `clientProtocol`
   rejection.
2. **DO's test app compiles and publishes**, with the known `CDOTelemetryTests` exclusion applied
   deliberately (pre-existing source/dependency mismatch, recorded in the 2026-07-27 run notes and
   again in R53's DO-route rejection).
3. **The resolved compiler is alc 17.** Observable: read the resolved `alcPath` back and invoke it
   to print its version. DO declares `runtime 17.0`; R43 measured that alc 18 writes a package BC 28
   cannot load.
4. **`--dry-run` reports 176 mutant sites**, per the pre-commitment above.
5. **`compile-only` passes** — `scripts/campaign/compile-only.ts` with the ids above and
   `--control-symbol`. This is the only gate item that exercises `validateSelectorIdsForProject` at
   all: `--dry-run` returns at `cli.ts:2058-2060`, before the check at `cli.ts:1704`.
6. **The hosted hang-stop probe.** Publish `fixtures/sandbox-hang` to the new environment and run
   `itest:hang`'s ON leg through an envtool config. This decides M0013's rung-1 branch and touches
   no DO code. `--stop-hung-sessions` is unmeasured on the hosted topology (R53's own caveat).

## Pinned inputs

See `manifest.md`. The DO worktree commit is pinned there because every later "did a verdict
change?" question is unanswerable if the source underneath moved.
