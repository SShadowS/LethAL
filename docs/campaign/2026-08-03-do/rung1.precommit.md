# Rung 1 — pre-commitment

Written and committed **before** the first run. Machine-readable half in `rung1.anchors.json`.

## Target

```
--project U:/Git/do-lethal/Cloud
--config U:/Git/do-lethal/lethal.config.envtool.json
--only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al"
--tests-only "Src/AutomaticDocuments/**"
--stop-hung-sessions
```

Scoping recovered verbatim from the 2026-07-27/28 run record (`docs/benchmarks/runs.jsonl`), which
also records that `--tests-only Src/AutomaticDocuments/**` narrows the baseline from 1,246 tests to
**56**.

## The gate

**Primary: two runs, verdict-identical per mutant**, run 1's per-mutant verdicts frozen to
`rung1.baseline.json` via `scripts/campaign/freeze.ts`. Determinism, not a historical regression
check — the 2026-07-28 per-mutant record does not survive anywhere, so there is nothing to compare
against per identity. `assertCardinality` runs first and independently in both freezes, so a
truncated or empty report fails loudly rather than self-recording something meaningless.

**Cardinality: 176**, per `rung0.precommit.md`.

**The four anchors** (`scripts/campaign/anchors.ts`, exits non-zero if any fails):

1. **Fenced baseline is 56/56 green.**
2. **Coverage split by LOCATION** — every covered (non-`no-coverage`) mutant lies inside
   `SendPeriodStatements` (lines **17–43** in the pinned source) or carries object-level
   attribution; everything outside is `no-coverage`. The 2026-07-28 record pins this exactly: *"its
   13 covered mutants are exactly `SendPeriodStatements` (12) plus one object-level entry"*.
   Deliberately location-based, not count-based, so a mutant from an operator that shipped after
   2026-07-28 landing inside that range is allowed to be covered.
3. **M0013's branch** — see below. Not derivable from the report, so the driver prints by name that
   anchor 3 is NOT checked; a clean exit never means four anchors passed.
4. **killed >= 1.**

## M0013 — the pre-committed branch

M0013 is `negate-conditional` on `until DOCustSetup.Next() = 0`, covered by the
`SendPeriodStatements` tests, and it stranded at both the 30 s and 120 s budgets on 2026-07-28.
`--stop-hung-sessions` is **unmeasured on the hosted topology** (R53's own caveat — it was measured
against a container).

- **Stop works** → M0013 scores `timeout-killed`, and the determinism comparison covers all 176.
- **Stop does not work** → the run strands at M0013's identity, an `R<n>` row is filed, recovery is
  `recover-tier` then `--resume` (which SKIPS the stranded identity and records it unscored —
  `orchestrator.ts:2566-2578`), and the comparison covers **175 plus exactly one named excluded
  identity, with that cardinality asserted**.

**Never pass `--retry-stranded`** during the gate: it converts the safe skip back into the re-strand
loop.

**Deviation from the plan, stated:** gate 0's separate hosted hang-stop probe
(`fixtures/sandbox-hang` + `itest:hang` through an envtool config) was **not run**. The branch above
already covers both outcomes, and rung 1 measures the same property on the actual target rather than
on a fixture — so the probe would have cost a publish and a run to answer a question this run
answers directly. The cost of skipping it is that a rung-1 strand is discovered during the run
rather than before it; the recovery path is unchanged either way.

## Identity

Comparison is semantic-identity keyed — `astHash` / `codeunitName` / `operatorName` /
`operatorMajor` (`mutant-equality.ts`) — never `mutantCode` or `file:line`, which re-batching can
shift.

## Admissibility

A quarantine-resumed completion **is** admissible as an input to the determinism comparison,
decided here rather than after seeing a result. `docs/measurements` bars resumed runs from
*differential* inputs (two runs differing only in coverage mode); this is a verdict-only run-vs-run
comparison, where a carried verdict is the same verdict. If a resume is used, the resumed run's
excluded identity is named and its cardinality asserted per the M0013 branch above.
