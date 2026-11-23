import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * R1196: a leg's report is written to `reportDir` (LETHAL_ITEST_V3_REPORT_DIR) BEFORE any of the leg's assertions run, so a leg
 * that fails its warning set or its verdict table still leaves its report: those are exactly the legs a per-mutant comparison
 * needs. Then `check` runs; whatever it throws is the leg's failure, unchanged.
 */
export async function writeReportThenCheck(o: {
  readonly leg: string;
  readonly report: unknown;
  readonly reportDir: string | undefined;
  readonly check: () => void | Promise<void>;
}): Promise<void> {
  if (o.reportDir !== undefined) {
    await mkdir(o.reportDir, { recursive: true });
    await writeFile(
      join(o.reportDir, `${o.leg}.report.json`),
      `${JSON.stringify(o.report, null, 2)}\n`,
    );
  }
  await o.check();
}
