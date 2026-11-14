import { describe, expect, test } from "bun:test";
import {
  type BuildRows,
  type Manifest,
  type Row,
  compare,
  matchesBc,
  readManifest,
  reportLines,
} from "./upstream-repros";

// R-996: the flip detection. Every case is an injected reading; no al-runner runs here.
const M: Manifest = {
  repros: [
    {
      id: "r1",
      issue: "https://example.invalid/1",
      bcEvidence: "invented",
      rerun: ["DO", "R985"],
      tests: {
        "Codeunit1.Refused": { status: "fail", messageIncludes: "Cannot write" },
        "Codeunit1.Stored": { status: "fail", message: "stored 1754-01-01" },
      },
    },
  ],
};
const row = (name: string, status: string, message?: string, notRun?: boolean): Row => ({
  name,
  status,
  ...(message !== undefined ? { message } : {}),
  ...(notRun === true ? { notRun } : {}),
});
const build = (rows: Row[]): BuildRows => new Map([["r1", new Map(rows.map((r) => [r.name, r]))]]);
const BC_LIKE = build([
  row("Codeunit1.Refused", "fail", "Cannot write the value 01/02/1753 ..."),
  row("Codeunit1.Stored", "fail", "stored 1754-01-01"),
]);
const STORES_1753 = build([
  row("Codeunit1.Refused", "fail", "stored 1753-01-02"),
  row("Codeunit1.Stored", "fail", "stored 1754-01-01"),
]);
const of = (changes: ReturnType<typeof compare>, test: string) =>
  changes.find((c) => c.test === test)?.change;

describe("R-996: a repro's change between current and the candidate", () => {
  test("differs on current, matches BC on the candidate: flipped, naming what to re-run", () => {
    const c = compare(M, BC_LIKE, STORES_1753);
    expect(of(c, "Codeunit1.Refused")).toBe("flipped");
    expect(of(c, "Codeunit1.Stored")).toBe("still-matches");
    expect(reportLines(c)[0]).toBe("FLIPPED to BC: r1 Codeunit1.Refused: re-run DO, R985");
  });

  test("matched BC on current, differs on the candidate: regressed (a finding)", () => {
    const c = compare(M, STORES_1753, BC_LIKE);
    expect(of(c, "Codeunit1.Refused")).toBe("regressed");
    expect(reportLines(c)[0]).toContain("REGRESSED (a finding): r1 Codeunit1.Refused");
  });

  test("the same on both: still-differs or still-matches, and no FLIPPED or REGRESSED line", () => {
    const c = compare(M, STORES_1753, STORES_1753);
    expect(of(c, "Codeunit1.Refused")).toBe("still-differs");
    expect(reportLines(c).some((l) => /FLIPPED|REGRESSED/.test(l))).toBe(false);
  });

  test("a repro that did not run on either build is an error, never a match or a flip", () => {
    const broken: BuildRows = new Map([["r1", { error: "exit 3: compile failed" }]]);
    expect(compare(M, broken, BC_LIKE).every((c) => c.change === "error")).toBe(true);
    expect(compare(M, BC_LIKE, broken).every((c) => c.change === "error")).toBe(true);
    expect(compare(M, new Map(), BC_LIKE).every((c) => c.change === "error")).toBe(true);
  });

  test("a missing row, a not-run row, another status or another message never matches BC", () => {
    const bc = { status: "fail" as const, message: "stored 1754-01-01" };
    expect(matchesBc(bc, undefined)).toBe(false);
    expect(matchesBc(bc, row("x", "fail", "stored 1754-01-01", true))).toBe(false);
    expect(matchesBc(bc, row("x", "pass", "stored 1754-01-01"))).toBe(false);
    expect(matchesBc(bc, row("x", "fail", "stored 1754-01-02"))).toBe(false);
    expect(matchesBc(bc, row("x", "fail", "stored 1754-01-01 "))).toBe(true);
    expect(
      matchesBc({ status: "fail", messageIncludes: "Cannot" }, row("x", "fail", "stored")),
    ).toBe(false);
  });

  test("the committed manifest reads, and every repro has an app and named tests", () => {
    const m = readManifest();
    expect(m.repros.length).toBeGreaterThan(0);
    for (const r of m.repros)
      expect(r.issue).toMatch(
        /^https:\/\/github\.com\/aldevtools\/BusinessCentral\.AL\.Runner\/issues\/\d+$/,
      );
  });
});
