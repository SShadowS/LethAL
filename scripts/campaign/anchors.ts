/**
 * Run rung 1's anchor gate over a report.
 *
 *   bun scripts/campaign/anchors.ts --report <report.json> --config <anchors.json> [--project <dir>]
 *
 * Exit 0 = the pre-committed cardinality held AND every anchor passed. Any other exit is a rung
 * failure: a non-zero exit is the gate, not the printed text. Every anchor is printed, including
 * the passing ones, because plan Task 6 step 4 requires each result recorded in
 * `rung1.precommit.md`'s result section.
 *
 * The real logic lives in `packages/runner/src/campaign-anchors-run.ts`, not here: `scripts/` is
 * outside every package's tsconfig project graph, so a test under `packages/runner/tests` cannot
 * import a `scripts/` module without failing `tsc --build` with TS6059/TS6307 (see
 * `compile-only-args.ts` and `freeze.ts` for the same split). This file is the CLI entry point.
 */
import { parseAnchorArgs, runAnchorCheck } from "../../packages/runner/src/campaign-anchors-run";

export { parseAnchorArgs, runAnchorCheck } from "../../packages/runner/src/campaign-anchors-run";

if (import.meta.main) {
  const outcome = await runAnchorCheck(parseAnchorArgs(process.argv.slice(2)));
  for (const line of outcome.lines) console.log(line);
  process.exit(outcome.ok ? 0 : 1);
}
