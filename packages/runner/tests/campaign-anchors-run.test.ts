import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// The EXIT CODE, which only `main()` owns, is covered by spawning `lethal campaign anchors` in
// `campaign-subcommands.test.ts`. It used to be covered here by spawning
// `scripts/campaign/anchors.ts`; that script was deleted when the subcommand landed, so that the
// gate has exactly one entry point and therefore no entry point that skips the git check.
import { parseAnchorArgs, parseAnchorConfig, runAnchorCheck } from "../src/campaign-anchors-run";
import type { SessionReport } from "../src/report";

const CONFIG = {
  expectedMutantCount: 2,
  expectedBaselineTests: 56,
  coveredProcedureRanges: [{ name: "SendPeriodStatements", startLine: 90, endLine: 200 }],
  reconcileNotInstrumented: false,
};

function report(
  mutants: readonly { verdict: string; line: number }[],
  extra: Record<string, unknown> = {},
): SessionReport {
  return {
    baselineGreen: true,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    mutants: mutants.map((m, i) => ({
      mutantCode: `M${String(i).padStart(4, "0")}`,
      file: "Codeunit 6175297 CDO Send Cust. Statement Mgt.al",
      line: m.line,
      operatorName: "lethal.negate-conditional",
      verdict: m.verdict,
      batchIndex: 0,
      durationMs: 0,
    })),
    ...extra,
  } as unknown as SessionReport;
}

const PASSING = report([
  { verdict: "killed", line: 100 },
  { verdict: "survived", line: 150 },
]);
/** Same cardinality, but a covered mutant sits outside the covered procedure — anchor 2 fails. */
const ONE_FAILING_ANCHOR = report([
  { verdict: "killed", line: 100 },
  { verdict: "survived", line: 900 },
]);

let dir: string;
let reportPath: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-anchors-run-"));
  reportPath = join(dir, "report.json");
  configPath = join(dir, "anchors.json");
  await writeFile(configPath, JSON.stringify(CONFIG), "utf8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseAnchorArgs", () => {
  test("parses a full invocation", () => {
    const a = parseAnchorArgs(["--report", "r.json", "--config", "c.json", "--project", "P"]);
    expect(a).toEqual({ reportPath: "r.json", configPath: "c.json", projectDir: "P" });
  });

  test("throws naming the missing flag rather than defaulting", () => {
    expect(() => parseAnchorArgs(["--report", "r.json"])).toThrow(/--config/);
  });
});

describe("parseAnchorConfig", () => {
  test("refuses a config with no expectedMutantCount rather than deriving one from the report", () => {
    const { expectedMutantCount, ...rest } = CONFIG;
    expect(expectedMutantCount).toBe(2); // the field being removed, named so this cannot rot
    expect(() => parseAnchorConfig(rest, "c.json")).toThrow(/expectedMutantCount/);
  });

  test("refuses an empty coveredProcedureRanges", () => {
    expect(() => parseAnchorConfig({ ...CONFIG, coveredProcedureRanges: [] }, "c.json")).toThrow(
      /coveredProcedureRanges is empty/,
    );
  });

  test("refuses an unstated reconcileNotInstrumented", () => {
    const { reconcileNotInstrumented, ...rest } = CONFIG;
    expect(reconcileNotInstrumented).toBe(false);
    expect(() => parseAnchorConfig(rest, "c.json")).toThrow(/reconcileNotInstrumented/);
  });
});

describe("runAnchorCheck", () => {
  test("ok on a report where every anchor holds, and prints the PASSING anchors too", async () => {
    await writeFile(reportPath, JSON.stringify(PASSING), "utf8");
    const out = await runAnchorCheck({ reportPath, configPath });
    expect(out.ok).toBe(true);
    expect(out.lines.filter((l) => l.includes("PASS")).length).toBe(3);
    expect(out.lines.join("\n")).toContain("anchor 3");
  });

  test("NOT ok when one anchor fails, naming it", async () => {
    await writeFile(reportPath, JSON.stringify(ONE_FAILING_ANCHOR), "utf8");
    const out = await runAnchorCheck({ reportPath, configPath });
    expect(out.ok).toBe(false);
    expect(out.lines.join("\n")).toContain("FAIL coverage-location");
  });

  test("throws on a cardinality mismatch before any anchor is evaluated", async () => {
    await writeFile(reportPath, JSON.stringify(report([{ verdict: "killed", line: 100 }])), "utf8");
    await expect(runAnchorCheck({ reportPath, configPath })).rejects.toThrow(/expected 2, got 1/);
  });

  test("refuses to skip a requested reconciliation when --project was not given", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ ...CONFIG, reconcileNotInstrumented: true }),
      "utf8",
    );
    await writeFile(reportPath, JSON.stringify(PASSING), "utf8");
    await expect(runAnchorCheck({ reportPath, configPath })).rejects.toThrow(/--project/);
  });

  test("runs the reconciliation over the report's OWN listed files when asked", async () => {
    const projectDir = join(dir, "project");
    const listed = report(
      [
        { verdict: "killed", line: 100 },
        { verdict: "survived", line: 150 },
      ],
      {
        notInstrumented: {
          totalFiles: 2,
          fileCount: 1,
          siteCount: 3,
          files: [{ file: "Al/Page/P.al", kinds: "page_declaration", sites: 3 }],
        },
      },
    );
    await writeFile(reportPath, JSON.stringify(listed), "utf8");
    await writeFile(
      configPath,
      JSON.stringify({ ...CONFIG, reconcileNotInstrumented: true }),
      "utf8",
    );
    const alPath = join(projectDir, "Al/Page/P.al");
    await mkdir(dirname(alPath), { recursive: true });

    await writeFile(alPath, 'page 6175272 "P" { }', "utf8");
    const pass = await runAnchorCheck({ reportPath, configPath, projectDir });
    expect(pass.ok).toBe(true);
    expect(pass.lines.join("\n")).toContain("PASS notinstrumented-reconciliation");

    // Same report, same claim — but the file is really a codeunit, which CAN carry the selector
    // var. The report's own claim is what fails, which is the identity this check asserts.
    await writeFile(alPath, 'codeunit 6175271 "P" { }', "utf8");
    const fail = await runAnchorCheck({ reportPath, configPath, projectDir });
    expect(fail.ok).toBe(false);
    expect(fail.lines.join("\n")).toContain("FAIL notinstrumented-reconciliation");
  });
});

/**
 * The exit code IS the gate — a driver that printed "FAIL" and exited 0 would be read as a pass by
 * every script, CI step and operator that ran it. It now belongs to `main()` rather than to a
 * script, and it is spawned in `campaign-subcommands.test.ts`'s "lethal campaign anchors (exit
 * code, spawned)" block: `scripts/campaign/anchors.ts` was deleted when the subcommand landed, so
 * the gate has one entry point and no second one that could reach it without the git check.
 */
