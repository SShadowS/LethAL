/**
 * Archive a rung's report and freeze its per-mutant verdicts to a committed file.
 *
 *   bun scripts/campaign/freeze.ts <reportPath> <rung> <expectedMutantCount>
 *
 * The real logic lives in packages/runner/src/campaign-freeze.ts, not here: scripts/ is outside
 * every package's tsconfig project graph (packages/runner/tsconfig.json includes only src/,
 * tests/, itest/), so a test under packages/runner/tests can't import a scripts/ module without
 * failing `tsc --build` with TS6059/TS6307 — see compile-only.ts for the same split. This file is
 * just the CLI entry point.
 */
import { freezeRung } from "../../packages/runner/src/campaign-freeze";

export { freezeRung } from "../../packages/runner/src/campaign-freeze";

if (import.meta.main) {
  const [reportPath, rung, expected] = process.argv.slice(2);
  if (reportPath === undefined || rung === undefined || expected === undefined) {
    throw new Error("usage: freeze.ts <reportPath> <rung> <expectedMutantCount>");
  }
  await freezeRung(reportPath, rung, Number(expected));
}
