# R-601 live pre-commitment, addendum 1: the head under test

This addendum amends `2026-10-22-r601-lend-precommitment.md` (13b45f39) in ONE respect: the head under test. Lane bugs
commits it to master BEFORE any live run. No live run had started at the time of writing: no lease was taken, no
gate ran, and no call reached bc1.

## Why the head changed

The orchestrator asked for master to be merged into `lethal/r601` before R-601's submit. Master had gained R-629
(90fb6501), which brought PRODUCT code into the merge:
- `packages/runner/src/nested-project.ts`;
- six lines in `packages/runner/src/orchestrator.ts`;
- a test.

So the merge comes before the live run, and the live run measures the head that will be submitted.

## The head under test

- **Head:** `lethal/r601` at **d06d7553**, a merge of origin/master into 524fd8d3.
  - The only conflict was the generated `ROADMAP.md`. It was resolved by regenerating the file.
  - verify on d06d7553: 9521 pass / 8 skip / 0 fail.
- **Code under test:** R-601's f9002861 plus master's code up to that merge, R-629 included.
- **Later commits** may change only docs or the roadmap: nothing under `packages/` or `scripts/`. Any change there
  requires another addendum, committed before the run.

## What stays the same

Every prediction, command, red check and stop rule of the base file is unchanged.

**R-629's change** touches nested-project keys only. That is a refusal in the hang-capable census for nested
copies. `sandbox-app` has no nested project, so no lend or bcdev figure can move because of it. If one moves anyway,
it is a BLOCK under the base file's stop rule.

## Corrections to the base file's preconditions

These match how the tools actually work. No prediction depends on them.
- **`--write-config-only`** takes only `--server`, with no `--lane`.
- **Where the launch file lives:** the bc1 launch file is `fixtures/sandbox-app/.vscode/launch.bc1.json`.
- **Bun install and native parser:** the red checks' scratch worktree is created from d06d7553, with its own
  `bun install` and native parser.
