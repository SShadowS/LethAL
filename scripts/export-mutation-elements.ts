#!/usr/bin/env bun
/**
 * SPIKE: project a LethAL `SessionReport` into the `mutation-testing-report-schema`, the
 * interchange format the Stryker ecosystem reads.
 *
 * WHY this format and not JUnit. Azure DevOps has no native mutation-testing result type. Its Tests
 * tab (`PublishTestResults@2`) takes JUnit/NUnit/VSTest/xUnit, and a mutant CAN be forced into a
 * `<testcase>` with killed=pass and survived=failure, but the semantics fight it: a survivor is a
 * FINDING, not a broken build, and the Tests tab adds flakiness tracking, ownership and duration
 * history that mean nothing for a mutant. The Stryker team's `PublishMutationReport@1` extension
 * adds a report TAB instead, and it is framework-agnostic: it renders whatever HTML you point it at,
 * and `mutation-testing-elements` renders that HTML from this JSON. Same file also feeds the Stryker
 * dashboard and the GitLab/GitHub renderers.
 *
 *   bun scripts/export-mutation-elements.ts <report.json> --project <dir> [--out <file>]
 *
 * WHAT IS LOST, which is the point of running this as a spike rather than shipping it blind. The
 * schema has one `status` per mutant and no room for the qualifications LethAL spent considerable
 * effort earning, so this exporter REPORTS the loss rather than letting it pass silently:
 *
 *   - R175's `unplaceableCount`. The schema has `NoCoverage` and nothing for "attribution could not
 *     place this", so a mutant LethAL declines to call uncovered flattens into the exact reading
 *     R175 exists to prevent.
 *   - R172's `likelyEquivalentSurvivors`, R121's assertion screen, R138's platform-artifact kills,
 *     and `coverageAttribution` (exact / object / all-green). All absent from the schema.
 *
 * SOURCE IS EMBEDDED. `FileResult.source` is required, because the HTML highlights the mutated span.
 * That is fine against a project's own code in its own pipeline, and it is exactly what the
 * 2026-08-09 redaction ruling forbids publishing for a third party. Never point this at a report
 * bound for a public repository without applying `scripts/redact-campaign-report.ts` reasoning first.
 */

/**
 * SUPERSEDED as a converter by `lethal export --format mutation-elements`, which is the shipped
 * surface and shares one implementation in `packages/runner/src/mutation-elements.ts`. This script
 * survives for the one thing the CLI deliberately does NOT do: writing a SELF-CONTAINED HTML file
 * with the `mutation-testing-elements` renderer inlined. The CLI cannot, because it ships as a
 * signed standalone binary and that would mean embedding 238 KB of third-party JavaScript into it.
 * Here node_modules exists, so it is a local convenience rather than a distribution decision.
 */
import { readFile, writeFile } from "node:fs/promises";
import { toMutationElements } from "../packages/runner/src/mutation-elements";
import type { SessionReport } from "../packages/runner/src/report";

const [reportPath, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const projectDir = flag("project");
if (reportPath === undefined || projectDir === undefined) {
  console.error(
    "usage: bun scripts/export-mutation-elements.ts <report.json> --project <dir> [--out <file>] [--html <file>]",
  );
  process.exit(2);
}

const report = JSON.parse(await readFile(reportPath, "utf8")) as SessionReport;
const { report: projected, losses } = await toMutationElements(report, {
  projectDir,
  thresholds: { high: 80, low: 60 },
});
const outPath = flag("out") ?? "mutation-report.json";
await writeFile(outPath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");
console.log(
  `wrote ${outPath}: ${report.mutants.length} mutant(s) across ${Object.keys(projected.files).length} file(s)`,
);

const htmlPath = flag("html");
if (htmlPath !== undefined) {
  const bundlePath = "node_modules/mutation-testing-elements/dist/mutation-test-elements.js";
  let bundle: string;
  try {
    bundle = await readFile(bundlePath, "utf8");
  } catch {
    throw new Error(
      `--html needs the renderer at ${bundlePath}. Install it with 'bun add -D mutation-testing-elements', or drop --html: the JSON alone is what the Stryker dashboard reads.`,
    );
  }
  // '</' inside the embedded JSON would close the script tag early.
  const embedded = JSON.stringify(projected).replace(/<\//g, "</");
  await writeFile(
    htmlPath,
    [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="utf-8"><title>LethAL mutation report</title>',
      `<script>${bundle}</script>`,
      "</head><body>",
      '<mutation-test-report-app title-postfix="LethAL">Loading...</mutation-test-report-app>',
      `<script>document.querySelector("mutation-test-report-app").report = ${embedded};</script>`,
      "</body></html>",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`wrote ${htmlPath}: self-contained, no CDN`);
}

if (losses.length > 0) {
  console.log("\nNOT CARRIED ACROSS:");
  for (const l of losses) console.log(`  - ${l}`);
}
