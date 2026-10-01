import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReport } from "../packages/runner/src/report";
import { ReportDiffRefusal, diffReports, formatDiff } from "./report-diff.ts";

function m(hash: string, verdict: string, extra: Record<string, unknown> = {}) {
  return {
    astHash: hash,
    codeunitName: "Sandbox Logic",
    procedureName: "Clamp",
    operatorName: "lethal.return-value",
    operatorMajor: 1,
    verdict,
    ...extra,
  };
}
const report = (...mutants: object[]) => ({ mutants }) as unknown as SessionReport;

describe("diffReports", () => {
  test("added, removed and changed (verdict or killingTest) on the baseline key", () => {
    const a = report(
      m("h1", "killed", { killingTest: "T1" }),
      m("h2", "survived"),
      m("h3", "killed"),
    );
    const b = report(
      m("h1", "killed", { killingTest: "T2" }),
      m("h2", "killed", { killingTest: "T1" }),
      m("h4", "survived"),
    );
    const d = diffReports(a, b);
    const k = (h: string) => `${h}|Sandbox Logic|Clamp|lethal.return-value|1`;
    expect(d).toEqual({
      added: [k("h4")],
      removed: [k("h3")],
      changed: [
        `${k("h1")}: killingTest T1 -> T2`,
        `${k("h2")}: verdict survived -> killed, killingTest null -> T1`,
      ],
    });
    expect(formatDiff(d, 3, 3).endsWith("DIFFERENT")).toBe(true);
  });
  test("identical reports print IDENTICAL; an identity ordinal keeps twins apart", () => {
    const r = report(m("h1", "killed"), m("h1", "survived", { identityOrdinal: 1 }));
    expect(formatDiff(diffReports(r, r), 2, 2).endsWith("\nIDENTICAL")).toBe(true);
  });
  test("a duplicate key on either side is refused, naming the key", () => {
    const dup = report(m("h1", "killed"), m("h1", "survived"));
    const ok = report(m("h1", "killed"));
    expect(() => diffReports(dup, ok)).toThrow(/a has duplicate key h1\|Sandbox Logic\|Clamp/);
    expect(() => diffReports(ok, dup)).toThrow(/b has duplicate key/);
  });
  test("empty vs empty is refused, never IDENTICAL", () => {
    expect(() => diffReports(report(), report())).toThrow(ReportDiffRefusal);
  });
});

describe("report-diff CLI exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-diff-"));
  const write = (name: string, r: object) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(r));
    return p;
  };
  const run = (a: string, b: string) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "report-diff.ts"), a, b], {
      stdout: "pipe",
      stderr: "pipe",
    });

  test("0 identical, 1 different, 2 refused (empty vs empty)", () => {
    const one = write("one.json", { mutants: [m("h1", "killed")] });
    const two = write("two.json", { mutants: [m("h1", "survived")] });
    const empty = write("empty.json", { mutants: [] });
    expect(run(one, one).exitCode).toBe(0);
    expect(run(one, two).exitCode).toBe(1);
    const refused = run(empty, empty);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout.toString()).not.toContain("IDENTICAL");
  });
});
