import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaselineRow,
  EXIT,
  type ReportFacts,
  baselineRows,
  classify,
  pickFiles,
} from "./triage-baseline";

const pass = (t: string): BaselineRow => ({ test: t, outcome: "pass", message: "" });
const fail = (t: string, m = "Assert.AreEqual failed"): BaselineRow => ({
  test: t,
  outcome: "fail",
  message: m,
});
const notRun = (t: string, m: string): BaselineRow => ({
  test: t,
  outcome: "error",
  message: `NotRun: ${m}`,
});
// A report where 2 of 3 mutants reached a test, unless said otherwise.
const rep = (caveats: string[] = [], mutants = 3, noCoverage = 1): ReportFacts => ({
  caveats,
  mutants,
  noCoverage,
});

test("each stop is named, in order, and only a usable baseline is go", () => {
  expect(classify([pass("A.x")], undefined).stop).toBe("no-baseline");
  expect(classify([], rep()).stop).toBe("no-baseline");
  // A fallback stops even with a green baseline: the window would measure nothing about serve.
  expect(classify([pass("A.x")], rep(["al-runner-v3-serve-default-fallback-warmup"])).stop).toBe(
    "fallback",
  );
  expect(classify([pass("A.x")], rep(["al-runner-v3-coverage-off", "baseline-red"])).stop).toBe(
    "go",
  );
  // One license refusal is enough, before the uniform and zero-green rules.
  expect(
    classify([pass("A.x"), notRun("A.y", "Permission ... with no license file loaded")], rep())
      .stop,
  ).toBe("no-license");
  // Every test refused for one cause (digits masked) is uniform; mixed causes are only zero-green.
  const uni = classify(
    [notRun("A.x", "company init failed at 12"), notRun("B.y", "company init failed at 340")],
    rep(),
  );
  expect(uni).toMatchObject({ stop: "uniform-refusal", tests: 2, green: 0, refused: 2 });
  expect(classify([notRun("A.x", "one cause"), notRun("B.y", "another")], rep()).stop).toBe(
    "zero-green",
  );
  expect(classify([notRun("A.x", "one cause"), fail("B.y")], rep()).stop).toBe("zero-green");
  expect(classify([fail("A.x"), fail("B.y")], rep()).stop).toBe("zero-green");
  // A green baseline whose --only mutants all went uncovered never ran serve: the fallback check proved nothing.
  expect(classify([pass("A.x")], rep([], 2, 2)).stop).toBe("fallback-unchecked");
  expect(classify([pass("A.x")], rep([], 0, 0)).stop).toBe("fallback-unchecked");
  expect(classify([pass("A.x")], rep([], 2, 1)).stop).toBe("go");
  expect(classify([pass("A.x"), fail("B.y"), notRun("C.z", "c")], rep())).toMatchObject({
    stop: "go",
    tests: 3,
    green: 1,
    refused: 1,
  });
  expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
  expect(EXIT.go).toBe(0);
});

test("pickFiles takes the smallest codeunits up to 100 mutants, else the smallest file, never an empty one", () => {
  const files = [
    { file: "src/A.PageExt.al", deployed: 2 },
    { file: "src/Setup/DeclUpgrade.Codeunit.al", deployed: 3 },
    { file: "src/Install/AppInstall.Codeunit.al", deployed: 4 },
    { file: "src/Empty.Codeunit.al", deployed: 0 },
    { file: "src/Z.Codeunit.al", deployed: 16 },
    { file: "src/B.Codeunit.al", deployed: 16 },
    { file: "src/Big.Codeunit.al", deployed: 70 },
    { file: "src/Huge.Codeunit.al", deployed: 500 },
  ];
  // 16 + 16 + 70 = 102 reaches 100: Huge stays out.
  expect(pickFiles(files)).toEqual([
    "src/B.Codeunit.al",
    "src/Z.Codeunit.al",
    "src/Big.Codeunit.al",
  ]);
  const many = Array.from({ length: 12 }, (_, i) => ({
    file: `src/C${i + 10}.Codeunit.al`,
    deployed: 1,
  }));
  expect(pickFiles(many)).toHaveLength(8);
  expect(pickFiles(files.filter((f) => !f.file.includes("Codeunit")))).toEqual([
    "src/A.PageExt.al",
  ]);
  expect(pickFiles([{ file: "src/Empty.Codeunit.al", deployed: 0 }])).toEqual([]);
});

test("baselineRows reads the latest run's baseline only, last row per test", () => {
  const path = join(mkdtempSync(join(tmpdir(), "triage-")), "s.sqlite");
  const db = new Database(path);
  db.run("create table runs (id integer primary key)");
  db.run(
    // `id` is not the rowid here, so a scan returns insertion order and only `order by id` puts the rows right.
    "create table test_results (id integer, run_id integer, mutant_row_id integer, codeunit_name text, method text, outcome text, failure_message text)",
  );
  db.run("insert into runs (id) values (1), (2)");
  const ins = db.prepare("insert into test_results values (?, ?, ?, ?, ?, ?, ?)");
  ins.run(1, 1, null, "Old", "t", "pass", null); // an abandoned run
  ins.run(20, 2, null, "A", "x", "pass", null); // the re-baseline: the last row by id counts
  ins.run(10, 2, null, "A", "x", "fail", "first");
  ins.run(30, 2, 7, "A", "y", "fail", "a mutant's row");
  db.close();
  expect(baselineRows(path)).toEqual([{ test: "A.x", outcome: "pass", message: "" }]);
});
