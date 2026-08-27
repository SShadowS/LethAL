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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface ReportMutant {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly operatorName: string;
  readonly verdict: string;
  readonly mutatedText?: string;
  readonly coveringTests?: readonly string[];
  readonly killingTest?: string;
  readonly coverageAttribution?: string;
}
interface Report {
  readonly mutants: readonly ReportMutant[];
  readonly unplaceableCount?: number;
  readonly likelyEquivalentSurvivors?: { readonly count: number };
  readonly platformArtifactKills?: { readonly killedCount: number };
  readonly assertionScreen?: { readonly discrimination: string };
}

/**
 * Every LethAL verdict maps, and the two lossy ones are named here rather than in a comment far
 * away. `known-survivor` is a survivor CARRIED from a prior run rather than one measured now; the
 * schema has no provenance, so it becomes `Survived` and the distinction is gone.
 */
const STATUS: Readonly<Record<string, string>> = {
  killed: "Killed",
  survived: "Survived",
  "no-coverage": "NoCoverage",
  "timeout-killed": "Timeout",
  "known-survivor": "Survived",
  error: "RuntimeError",
};

/** 1-based line/column for a 0-based character offset. */
function positionOf(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

const [reportPath, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const projectDir = flag("project");
if (reportPath === undefined || projectDir === undefined) {
  console.error(
    "usage: bun scripts/export-mutation-elements.ts <report.json> --project <dir> [--out <file>]",
  );
  process.exit(2);
}

const report = JSON.parse(await readFile(reportPath, "utf8")) as Report;
const byFile = new Map<string, ReportMutant[]>();
for (const m of report.mutants) {
  const list = byFile.get(m.file);
  if (list === undefined) byFile.set(m.file, [m]);
  else list.push(m);
}

const files: Record<string, unknown> = {};
const unmapped = new Set<string>();
for (const [relRaw, mutants] of byFile) {
  const rel = relRaw.replace(/\\/g, "/");
  let source: string;
  try {
    source = await readFile(join(projectDir, rel), "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${join(projectDir, rel)} for its source, which the schema REQUIRES so the HTML ` +
        `can highlight each mutant: ${err instanceof Error ? err.message : String(err)}. Pass the ` +
        "--project the report was produced against.",
    );
  }
  files[rel] = {
    language: "al",
    source,
    mutants: mutants.map((m) => {
      const status = STATUS[m.verdict];
      if (status === undefined) unmapped.add(m.verdict);
      return {
        id: m.mutantCode,
        // Short name: the renderers group and filter by this, and `lethal.` on every row is noise.
        mutatorName: m.operatorName.replace(/^lethal\./, ""),
        location: {
          start: positionOf(source, m.startIndex),
          end: positionOf(source, m.endIndex),
        },
        status: status ?? "Pending",
        ...(m.mutatedText !== undefined ? { replacement: m.mutatedText } : {}),
        ...(m.coveringTests !== undefined && m.coveringTests.length > 0
          ? { coveredBy: [...m.coveringTests] }
          : {}),
        ...(m.killingTest !== undefined ? { killedBy: [m.killingTest] } : {}),
      };
    }),
  };
}

if (unmapped.size > 0) {
  throw new Error(
    `no schema status for LethAL verdict(s): ${[...unmapped].join(", ")}. Add them to STATUS ` +
      "rather than letting them land on `Pending`, which reads as 'not yet run'.",
  );
}

const out = {
  schemaVersion: "1",
  // REQUIRED by the schema and NOT a LethAL concept: nothing in `lethal.config.json` sets a
  // mutation-score threshold. These are the ecosystem's conventional defaults and a pipeline that
  // gates on them should choose its own deliberately rather than inherit these.
  thresholds: { high: 80, low: 60 },
  files,
};
const outPath = flag("out") ?? "mutation-report.json";
await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");

const total = report.mutants.length;
console.log(`wrote ${outPath}: ${total} mutant(s) across ${byFile.size} file(s)`);

// `--html <file>` writes the SELF-CONTAINED report Azure DevOps' `PublishMutationReport@1` renders
// in its own tab. The `mutation-testing-elements` bundle is INLINED rather than pulled from a CDN:
// a build agent may have no egress, and a report that silently renders blank on a locked-down agent
// is worse than one that was never produced.
const htmlPath = flag("html");
if (htmlPath !== undefined) {
  const bundlePath = "node_modules/mutation-testing-elements/dist/mutation-test-elements.js";
  let bundle: string;
  try {
    bundle = await readFile(bundlePath, "utf8");
  } catch {
    throw new Error(
      `--html needs the renderer at ${bundlePath}. Install it with \`bun add -D mutation-testing-elements\`, ` +
        "or drop --html and publish the JSON to the Stryker dashboard instead.",
    );
  }
  // `</script>` inside the embedded JSON would close the tag early; escaping the slash is the
  // standard fix and changes nothing about how JSON.parse reads it.
  const embedded = JSON.stringify(out).replace(/<\//g, "<\\/");
  await writeFile(
    htmlPath,
    [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="utf-8"><title>LethAL mutation report</title>',
      `<script>${bundle}</script>`,
      "</head><body>",
      '<mutation-test-report-app title-postfix="LethAL">',
      "Loading...",
      "</mutation-test-report-app>",
      `<script>document.querySelector("mutation-test-report-app").report = ${embedded};</script>`,
      "</body></html>",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`wrote ${htmlPath}: self-contained, no CDN`);
}

// The lossy half, reported every run. A silent projection is how a qualified verdict becomes an
// unqualified one, which is the failure R175 was.
const lost: string[] = [];
if ((report.unplaceableCount ?? 0) > 0) {
  lost.push(
    `${report.unplaceableCount} mutant(s) LethAL reports as attribution-unplaceable (R175) flatten ` +
      "into NoCoverage, which reads as 'your tests do not reach this code' — the exact conflation " +
      "that field exists to prevent",
  );
}
if (report.likelyEquivalentSurvivors !== undefined) {
  lost.push(
    `${report.likelyEquivalentSurvivors.count} survivor(s) flagged as likely-equivalent (R172) lose ` +
      "that flag; the schema has no field for it",
  );
}
if (report.platformArtifactKills !== undefined) {
  lost.push(
    `${report.platformArtifactKills.killedCount} kill(s) screened as platform artifacts (R138) ` +
      "become ordinary kills",
  );
}
if (report.assertionScreen !== undefined) {
  lost.push(
    `the assertion screen's discrimination ("${report.assertionScreen.discrimination}", R121) has ` +
      "no schema equivalent",
  );
}
const attributed = report.mutants.filter((m) => m.coverageAttribution !== undefined).length;
if (attributed > 0) {
  lost.push(
    `${attributed} mutant(s) carry a coverageAttribution (exact / object / all-green) that the ` +
      "schema cannot express, so an approximate covering set renders as an exact one",
  );
}
if (lost.length > 0) {
  console.log("\nLOST IN PROJECTION — the schema has one status per mutant and no room for these:");
  for (const l of lost) console.log(`  - ${l}`);
}
