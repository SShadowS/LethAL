import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuildRows,
  type Manifest,
  REPRO_ROOT,
  type Row,
  appsOf,
  compare,
  matchesBc,
  readManifest,
  reportLines,
  rowsOf,
  testArgsOf,
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

  test("PR-05: a repro's own flags go after the fixed ones and before its apps", () => {
    expect(testArgsOf(repro())).toEqual(["--bc-version", "28", "--output-json", "u1"]);
    expect(testArgsOf({ ...repro(["A", "T"]), args: ["--no-client"] })).toEqual([
      "--bc-version",
      "28",
      "--output-json",
      "--no-client",
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
    expect(() => readManifest(missing)).toThrow(/u1[\\/]A has no app\.json/); // `\` on Windows
    const ok = join(TMP, "ok");
    write(ok, { repros: [repro(["P", "A"])] }, ["u1/P", "u1/A"]);
    expect(readManifest(ok).repros).toHaveLength(1);
  });

  test("PR-05 review: args must be a list of strings, never a bare string", () => {
    const str = join(TMP, "args-string");
    write(str, { repros: [{ ...repro(), args: "--no-client" }] }, ["u1"]);
    expect(() => readManifest(str)).toThrow(/args is not a list of strings/);
    const num = join(TMP, "args-number");
    write(num, { repros: [{ ...repro(), args: [7] }] }, ["u1"]);
    expect(() => readManifest(num)).toThrow(/args is not a list of strings/);
    const ok = join(TMP, "args-ok");
    write(ok, { repros: [{ ...repro(), args: ["--no-client"] }] }, ["u1"]);
    expect(readManifest(ok).repros[0]?.args).toEqual(["--no-client"]);
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

  test("PR-01 review: a refusal written as a plain fail never matches an expected fail", () => {
    const failAny = { status: "fail" as const };
    expect(
      matchesBc(failAny, row("x", "fail", "NotRun: out-of-scope: use of an unassigned XmlElement")),
    ).toBe(false);
    expect(matchesBc(failAny, row("x", "fail", "a: NotRun: out-of-scope: y"))).toBe(false);
    expect(matchesBc(failAny, row("x", "fail", "NavXmlElement variable not initialized."))).toBe(
      true,
    );
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

  // PR-34 (preproc's review of PR-31): two repros landed at once with the same id ranges. No NEW pair of apps may share an object
  // id, so a repro can be published or run beside any other. The pairs below predate this test (several copy an issue's own AL
  // unchanged); they are frozen here, and the list may only shrink (its size is pinned below). Each pair's two sides are sorted, so
  // a reordered manifest never turns a frozen pair into a "new" one.
  const LEGACY_OVERLAPS = new Set([
    "u7415-platform-no-provider 51300-51310 / u7994-u7995-evaluate 51300-51310",
    "u7775-refusals 50140-50149 / u7850-autoformat 50100-50199",
    "u7775-refusals 50140-50149 / u7922-part-visibility 50100-50199",
    "u7778-json-null 50940-50949 / u8056-install-order/A2 50940-50949",
    "u7812-json-tab 50280-50289 / u7818-api-version 50280-50289",
    "u7812-json-tab 50280-50289 / u7819-refusals 50280-50289",
    "u7818-api-version 50280-50289 / u7819-refusals 50280-50289",
    "u7850-autoformat 50100-50199 / u7922-part-visibility 50100-50199",
    "u7850-autoformat 50100-50199 / u8006-date-1753 50100-50120",
    "u7922-part-visibility 50100-50199 / u8006-date-1753 50100-50120",
    "u7934-refusals 50430-50479 / u8032-xmlskip 50420-50440",
    "u8032-wildcard 50410-50420 / u8032-xmlskip 50420-50440",
    "u8056-install-order/A 50910-50919 / u8117-refusals 50900-50919",
    "u8056-install-order/P 50900-50909 / u8117-refusals 50900-50919",
  ]);
  test("no new pair of apps in the committed set has overlapping idRanges (and the legacy list holds no stale pair)", () => {
    expect(LEGACY_OVERLAPS.size).toBeLessThanOrEqual(14); // the list may only shrink
    const ranges: { app: string; from: number; to: number }[] = [];
    for (const r of readManifest().repros)
      for (const app of appsOf(r)) {
        const json = JSON.parse(readFileSync(join(REPRO_ROOT, app, "app.json"), "utf8")) as {
          idRanges?: { from: number; to: number }[];
        };
        expect([app, (json.idRanges ?? []).length > 0]).toEqual([app, true]); // never skipped silently
        // appsOf joins with the platform's separator; the frozen pairs use "/" (CI's Windows job)
        const name = app.replaceAll("\\", "/");
        for (const { from, to } of json.idRanges ?? []) ranges.push({ app: name, from, to });
      }
    const clashes: string[] = [];
    for (let i = 0; i < ranges.length; i++)
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i];
        const b = ranges[j];
        if (a === undefined || b === undefined || a.app === b.app) continue;
        if (a.from <= b.to && b.from <= a.to)
          clashes.push(
            [`${a.app} ${a.from}-${a.to}`, `${b.app} ${b.from}-${b.to}`].sort().join(" / "),
          );
      }
    expect(clashes.filter((c) => !LEGACY_OVERLAPS.has(c))).toEqual([]);
    // a pair fixed since must leave the list
    expect([...LEGACY_OVERLAPS].filter((c) => !clashes.includes(c))).toEqual([]);
  });
});
