import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReportThenCheck } from "../itest/leg-report";

describe("R1196: the v3 itest's session() uses it", () => {
  const src = readFileSync(join(import.meta.dir, "../itest/al-runner-v3.itest.ts"), "utf8");
  const session = /async function session\([\s\S]*?\n}\n/.exec(src)?.[0] ?? "";

  test("the warning checks run inside writeReportThenCheck's check, and no other write of a leg report is left", () => {
    expect(session).toContain("await writeReportThenCheck({");
    const at = session.indexOf("await writeReportThenCheck({");
    for (const call of ["checkGateWarnings(", "assertGateWarnings(", "assertLanesStarted("])
      expect(session.indexOf(call)).toBeGreaterThan(at);
    expect(src).not.toMatch(/writeFile\(join\(REPORT_DIR/);
    // the control compare reads the report it was just written beside, after the warning set
    expect(session.indexOf("CONTROL_DIR !== undefined")).toBeGreaterThan(at);
  });
});

describe("R1196: the v3 itest writes a leg's report before its assertions", () => {
  const report = { mutants: [{ mutantCode: "M0001", verdict: "killed" }] };

  test("a leg that fails its warning check still leaves its report, and the failure is the check's own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leg-report-"));
    try {
      await expect(
        writeReportThenCheck({
          leg: "D1",
          report,
          reportDir: join(dir, "reports"),
          check: () => {
            throw new Error("al-runner-v3/D1: the warning set differs");
          },
        }),
      ).rejects.toThrow("al-runner-v3/D1: the warning set differs");
      const file = join(dir, "reports", "D1.report.json");
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(report);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a passing leg writes it too, and without a report dir nothing is written but the check still runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leg-report-"));
    try {
      let checked = 0;
      const check = () => {
        checked += 1;
      };
      await writeReportThenCheck({ leg: "S1", report, reportDir: dir, check });
      expect(existsSync(join(dir, "S1.report.json"))).toBe(true);
      await writeReportThenCheck({ leg: "S2", report, reportDir: undefined, check });
      expect(existsSync(join(dir, "S2.report.json"))).toBe(false);
      expect(checked).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
