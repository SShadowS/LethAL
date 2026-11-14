import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuildRows,
  type Manifest,
  type Row,
  appsOf,
  compare,
  matchesBc,
  readManifest,
  reportLines,
  rowsOf,
} from "./upstream-repros";

// R-997: several apps run together, in the manifest's order.
describe("R-997: a repro of several apps", () => {
  const TMP = mkdtempSync(join(tmpdir(), "upstream-repros-test-"));
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));
  const repro = (apps?: string[]) => ({
    id: "u1",
    issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/1",
    bcEvidence: "invented",
    rerun: [],
    tests: { "Codeunit1.T": { status: "pass" as const } },
    ...(apps !== undefined ? { apps } : {}),
  });
  const write = (dir: string, m: object, folders: string[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    for (const f of folders) {
      mkdirSync(join(dir, f), { recursive: true });
      writeFileSync(join(dir, f, "app.json"), "{}");
    }
  };

  test("no apps: the repro's own folder; apps: each subfolder, in the manifest's order", () => {
    expect(appsOf(repro())).toEqual(["u1"]);
    expect(appsOf(repro(["P", "A", "T"]))).toEqual([
      join("u1", "P"),
      join("u1", "A"),
      join("u1", "T"),
    ]);
  });

  test("the manifest is refused for an empty apps list or an app folder without app.json", () => {
    const empty = join(TMP, "empty");
    write(empty, { repros: [repro([])] }, ["u1"]);
    expect(() => readManifest(empty)).toThrow(/empty apps/);
    const missing = join(TMP, "missing");
    write(missing, { repros: [repro(["P", "A"])] }, ["u1/P"]);
    expect(() => readManifest(missing)).toThrow(/u1\/A has no app\.json/);
    const ok = join(TMP, "ok");
    write(ok, { repros: [repro(["P", "A"])] }, ["u1/P", "u1/A"]);
    expect(readManifest(ok).repros).toHaveLength(1);
  });
});

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

  test("review: a run that compiled nothing, gave no rows, gave no JSON or timed out is an error, never empty rows", () => {
    const err = (r: ReturnType<typeof rowsOf>) => "error" in r;
    expect(err(rowsOf('{"tests": [], "compilationErrors": ["AL0118"]}', "", 3))).toBe(true);
    expect(
      err(
        rowsOf('{"tests": [{"name": "C.T", "status": "pass"}], "compilationErrors": ["x"]}', "", 3),
      ),
    ).toBe(true);
    expect(err(rowsOf('{"tests": []}', "", 0))).toBe(true);
    expect(err(rowsOf("not json", "", 1))).toBe(true);
    expect(rowsOf('{"tests": [{"name": "C.T", "status": "pass"}]}', "", 0, true)).toEqual({
      error: "stopped after 300 s (timed out)",
    });
    expect(
      err(rowsOf('{"tests": [{"name": "C.T", "status": "pass"}], "compilationErrors": []}', "", 0)),
    ).toBe(false);
  });

  test("review: a manifest test neither build reported is an error, not still-differs", () => {
    const only = build([row("Codeunit1.Stored", "fail", "stored 1754-01-01")]);
    const c = compare(M, only, only);
    expect(of(c, "Codeunit1.Refused")).toBe("error");
    expect(of(c, "Codeunit1.Stored")).toBe("still-matches");
    // Reported by one build only: a real change, not an error.
    expect(of(compare(M, BC_LIKE, only), "Codeunit1.Refused")).toBe("flipped");
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
