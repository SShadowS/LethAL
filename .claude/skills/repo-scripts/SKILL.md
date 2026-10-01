---
name: repo-scripts
description: Use BEFORE writing an inline shell or bun one-off for any of these: running the build/test loop (typecheck, clean dist, bun test), finding the next free roadmap id or setting a roadmap row's status, checking coord status (pause, questions, stale, doing, checkpoints, Cronus leases), summarising or diffing two LethAL SessionReport JSON files, or querying a lethal.sqlite results store. A tested script already does it.
---

# Repo scripts

Each is a small tested script under `scripts/`. Use it instead of re-writing the flow by hand.
Run from the repo root. Every one exits non-zero on failure and never prints an empty result as success.

| Script | Signature | When |
|---|---|---|
| `verify.ts` | `bun scripts/verify.ts [pkg...]` | The CLAUDE.md build/test loop: typecheck, delete `packages/*/dist`, `bun test` (all, or `packages/<pkg>`). Prints counts and failing test names; full output goes to a log file it names. |
| `roadmap-next-id.ts` | `bun scripts/roadmap-next-id.ts` | Before filing a roadmap row. Max id over the working tree, every local and remote branch, and every worktree, plus one. Run it right before writing the file. |
| `roadmap-set.ts` | `bun scripts/roadmap-set.ts R<n> --status "<text>"` | Closing or updating a row. Rewrites only the `status:` line (escaped), refuses `pending`, regenerates `ROADMAP.md`. |
| `coord.sh` | `bash scripts/coord.sh <command> [args...]` | Any coord CLI call. Always uses `H:\lethal-coord`, IGNORING an inherited `CG_COORD_ROOT` (the machine-wide one can point at CentralGauge's root); override with `LETHAL_COORD_ROOT`. |
| `coord-status.ts` | `bun scripts/coord-status.ts` | One view: pause state, open questions, stale list, Doing tasks with their latest checkpoint, Cronus28 and Cronus284 lease holders. |
| `report-summary.ts` | `bun scripts/report-summary.ts <report.json>` | Totals by verdict and by operator, plus `groupedCalls` / `warmKills`, for a `lethal run --out` report. |
| `report-diff.ts` | `bun scripts/report-diff.ts <a.json> <b.json>` | Per-mutant diff by the live gates' own compare (`diffMutants`, `packages/runner/itest/mutant-equality.ts`: `keyOf` key, multiset per key, so twins are fine). Exit 0 IDENTICAL, 1 DIFFERENT, 2 refused (zero mutants on both sides). |
| `store-query.ts` | `bun scripts/store-query.ts <lethal.sqlite> [--run latest\|<id>] verdicts\|runs\|tests` | Read-only look at a results store. "latest" is the highest FINISHED run id; a newer unfinished run is named on stderr. |
