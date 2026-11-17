import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReport } from "../packages/runner/src/report";
import {
  ReportDiffRefusal,
  compareByLine,
  compareReports,
  diffReports,
  formatDiff,
  formatLineDiff,
} from "./report-diff.ts";

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
const k = (h: string) => `${h}|Sandbox Logic|Clamp|lethal.return-value|1`;

describe("diffReports (the gates' diffMutants)", () => {
  test("added, removed and changed mutants are each reported", () => {
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
    const diffs = diffReports(a, b);
    expect(diffs).toHaveLength(4);
    expect(diffs.join("\n")).toContain(`mutant ${k("h1")}: killingTest T1 -> T2`);
    expect(diffs.join("\n")).toContain(`mutant ${k("h2")}: verdict survived -> killed`);
    expect(diffs.join("\n")).toContain(`mutant ${k("h3")}: present in "before" but missing`);
    expect(diffs.join("\n")).toContain(`mutant ${k("h4")}: present in "after" but missing`);
    expect(formatDiff(diffs, 3, 3).endsWith("\nDIFFERENT")).toBe(true);
  });

  test("twins sharing one key on both sides, in either order, are IDENTICAL", () => {
    const a = report(m("h1", "killed", { killingTest: "T1" }), m("h1", "survived"));
    const b = report(m("h1", "survived"), m("h1", "killed", { killingTest: "T1" }));
    const diffs = diffReports(a, b);
    expect(diffs).toEqual([]);
    expect(formatDiff(diffs, 2, 2).endsWith("\nIDENTICAL")).toBe(true);
  });

  test("only one twin's verdict changing is DIFFERENT", () => {
    const a = report(m("h1", "killed", { killingTest: "T1" }), m("h1", "survived"));
    const b = report(
      m("h1", "killed", { killingTest: "T1" }),
      m("h1", "killed", { killingTest: "T1" }),
    );
    const diffs = diffReports(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain(`mutant ${k("h1")} [occurrence`);
    expect(formatDiff(diffs, 2, 2).endsWith("\nDIFFERENT")).toBe(true);
  });

  test("empty vs empty is refused, never IDENTICAL", () => {
    expect(() => diffReports(report(), report())).toThrow(ReportDiffRefusal);
  });
});

describe("R556: report-diff reads both reports' identity schemes", () => {
  // Two byte-identical twins: one tuple, ordinals 0 and 1, the same mutated text.
  const twins = (scheme?: number) =>
    ({
      ...(scheme !== undefined ? { identityScheme: scheme } : {}),
      mutants: [
        m("h1", "killed", { mutatedText: "x := 0;" }),
        m("h1", "killed", { mutatedText: "x := 0;", identityOrdinal: 1 }),
      ],
    }) as unknown as SessionReport;

  test("the same recorded scheme compares twins' text row by row", () => {
    const r = compareReports(twins(37), twins(37));
    expect(r.textVerified).toBe(2);
    expect(r.textUnverified).toBe(0);
  });

  test("different or unrecorded schemes leave a shared twin hash UNVERIFIED, and say so", () => {
    for (const [a, b] of [
      [twins(36), twins(37)],
      [twins(), twins(37)],
      [twins(), twins()],
    ] as const) {
      const r = compareReports(a, b);
      expect(r.textUnverified).toBe(2);
      expect(formatDiff(r.differences, 2, 2, r.textUnverified)).toContain(
        "2 mutant(s) text-UNVERIFIED",
      );
    }
    expect(formatDiff([], 2, 2, 0)).not.toContain("UNVERIFIED");
  });
});

describe("--by-line (PR-113)", () => {
  const at = (line: number, verdict: string, extra: Record<string, unknown> = {}) =>
    m("h1", verdict, { file: "A.al", line, startIndex: line * 10, ...extra });
  const full = report(at(1, "killed", { killingTest: "T1" }), at(2, "survived"));
  const subset = report(at(2, "survived"));

  test("twins on two lines: default mode shows a spurious difference, --by-line --subset shows 0", () => {
    expect(diffReports(full, subset).length).toBeGreaterThan(0);
    const c = compareByLine(full, subset, true);
    expect(c.differences).toEqual([]);
    expect(c.onlyInB).toEqual([]);
    expect(c.onlyInA).toHaveLength(1);
    expect(formatLineDiff(c, 2, 1, true)).toContain("not in the subset");
    expect(formatLineDiff(c, 2, 1, true).endsWith("\nIDENTICAL")).toBe(true);
  });

  test("without --subset, a mutant only in a is a difference", () => {
    const c = compareByLine(full, subset, false);
    expect(formatLineDiff(c, 2, 1, false).endsWith("\nDIFFERENT")).toBe(true);
  });

  test("a real verdict difference on one line is caught", () => {
    const changed = report(at(2, "killed", { killingTest: "T9" }));
    const c = compareByLine(full, changed, true);
    expect(c.differences).toHaveLength(1);
    expect(c.differences[0]).toContain("A.al line 2|lethal.return-value");
    expect(c.differences[0]).toContain("verdict survived -> killed");
  });

  test("same file, line and operator twice falls back to startIndex", () => {
    const a = report(at(1, "killed", { startIndex: 5 }), at(1, "survived", { startIndex: 9 }));
    const b = report(at(1, "survived", { startIndex: 9 }), at(1, "killed", { startIndex: 5 }));
    const c = compareByLine(a, b);
    expect(c.keyedBy).toContain("startIndex");
    expect(c.differences).toEqual([]);
  });

  test("keys still ambiguous exit non-zero naming them", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-diff-line-"));
    const p = join(dir, "amb.json");
    writeFileSync(p, JSON.stringify(report(at(1, "killed"), at(1, "survived"))));
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "report-diff.ts"), "--by-line", p, p], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("ambiguous");
    expect(r.stderr.toString()).toContain("A.al line 1|lethal.return-value");
  });

  test("--subset without --by-line is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-diff-line-"));
    const p = join(dir, "one.json");
    writeFileSync(p, JSON.stringify(full));
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "report-diff.ts"), "--subset", p, p], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--subset only works with --by-line");
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
