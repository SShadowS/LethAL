import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultsStore } from "../packages/runner/src/store";
import {
  type BaselineRow,
  EXIT,
  type RunFacts,
  classify,
  kindOf,
  pickFiles,
  readStore,
  stderrFallbacks,
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
// A finished run whose mutants reached tests, unless said otherwise.
const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  rc: 0,
  reported: true,
  caveats: [],
  mutantTestRows: 5,
  ...over,
});

test("each stop is named, in order, and only a usable baseline is go", () => {
  expect(classify([], run()).stop).toBe("no-baseline");
  // No report with a baseline in the store: the run failed, not the baseline.
  expect(classify([pass("A.x")], run({ reported: false, rc: 124 }))).toMatchObject({
    stop: "run-failed",
    detail: expect.stringContaining("no report was written"),
  });
  expect(classify([pass("A.x")], run({ reported: false })).stop).toBe("run-failed");
  // A fallback stops even with a green baseline: the window would measure nothing about serve.
  const fb = run({ caveats: ["al-runner-v3-serve-default-fallback-warmup"] });
  expect(classify([pass("A.x")], fb).stop).toBe("fallback");
  // ...also from a killed run's stderr (no report): the final R-994 Avalara run, stopped after its fallback.
  const killed = run({
    reported: false,
    rc: 124,
    caveats: stderrFallbacks(
      "[lethal] al-runner-v3 serve-entries (R635): daemons 6\n[lethal] al-runner-v3-serve-default-fallback-warmup: the serve-entries default met a refusal\nWARNING [al-runner-v3-serve-default-fallback-warmup]: ...",
    ),
  });
  expect(killed.caveats).toEqual(["al-runner-v3-serve-default-fallback-warmup"]);
  expect(classify([pass("A.x")], killed).stop).toBe("fallback");
  expect(stderrFallbacks("[lethal] al-runner-v3 serve-entries (R635): daemons 2")).toEqual([]);
  expect(
    classify([pass("A.x")], run({ caveats: ["baseline-red", "time-budget-reached"] })).stop,
  ).toBe("go");
  // One license refusal is enough, before the uniform and zero-green rules.
  expect(
    classify([pass("A.x"), notRun("A.y", "Permission ... with no license file loaded")], run())
      .stop,
  ).toBe("no-license");
  // Every test refused for one cause (digits masked) is uniform; mixed causes are only zero-green.
  const uni = classify(
    [notRun("A.x", "company init failed at 12"), notRun("B.y", "company init failed at 340")],
    run(),
  );
  expect(uni).toMatchObject({ stop: "uniform-refusal", tests: 2, green: 0, refused: 2 });
  expect(classify([notRun("A.x", "one cause"), notRun("B.y", "another")], run()).stop).toBe(
    "zero-green",
  );
  expect(classify([notRun("A.x", "one cause"), fail("B.y")], run()).stop).toBe("zero-green");
  expect(classify([fail("A.x"), fail("B.y")], run()).stop).toBe("zero-green");
  // The baseline rules name a cause better than the run's exit code (DO's license run ends all-errors, exit 4).
  expect(classify([fail("A.x")], run({ rc: 4 })).stop).toBe("zero-green");
  for (const rc of [1, 3, 4, 124, 137])
    expect(classify([pass("A.x")], run({ rc })).stop).toBe("run-failed");
  expect(classify([pass("A.x")], run({ rc: 124 })).detail).toContain("timeout");
  // Exit 7 is the time budget, not a failure.
  expect(classify([pass("A.x")], run({ rc: 7 })).stop).toBe("go");
  // A green baseline whose --only mutants reached no test never ran serve: the fallback check proved nothing.
  expect(classify([pass("A.x")], run({ mutantTestRows: 0 }))).toMatchObject({
    stop: "fallback-unchecked",
    detail: expect.stringContaining("pass --only files the tests cover"),
  });
  // The budget, which counts the baseline too, ran out first: the advice is the budget, not the files.
  const spent = run({ rc: 7, mutantTestRows: 0, caveats: ["time-budget-reached"] });
  expect(classify([pass("A.x")], spent)).toMatchObject({
    stop: "fallback-unchecked",
    detail: expect.stringContaining("raise --budget-s"),
  });
  expect(classify([pass("A.x"), fail("B.y"), notRun("C.z", "c")], run())).toMatchObject({
    stop: "go",
    tests: 3,
    green: 1,
    refused: 1,
  });
  expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
  expect(EXIT.go).toBe(0);
});

test("both stored refusal forms count as refused", () => {
  const suffix = "[al-runner v3 did not run this test (notRun), so whether ...]";
  const rows: BaselineRow[] = [
    { test: "A.x", outcome: "error", message: `<no message> ${suffix}` },
    { test: "A.y", outcome: "fail", message: "Runtime error: NotRun: out-of-scope: x" },
    { test: "A.z", outcome: "error", message: "NotRun: y" },
  ];
  expect(classify(rows, run()).refused).toBe(3);
  expect(classify([fail("A.x", "Expected NotRunning to be false")], run()).refused).toBe(0);
});

test("kindOf reads the object from the text, not the file name", () => {
  expect(kindOf('// c\ncodeunit 50100 "Foo"\n{\n}')).toBe("codeunit");
  expect(kindOf("codeunit 50101 Up\n{\n    Subtype = Upgrade;\n}")).toBe("setup");
  expect(kindOf("codeunit 50102 In\n{\n    Subtype = Install;\n}")).toBe("setup");
  expect(kindOf("codeunit 50103 T\n{\n    Subtype = Test;\n}")).toBe("codeunit");
  expect(kindOf('pageextension 50100 "X" extends "Y"\n{\n}')).toBe("other");
});

test("pickFiles takes the smallest codeunits to 100 mutants (never past 300), else the smallest file, never an empty one", () => {
  const files = [
    { file: "src/A.PageExt.al", deployed: 2 },
    { file: "src/Setup.al", deployed: 3 },
    { file: "src/Empty.al", deployed: 0 },
    { file: "src/Z.al", deployed: 16 },
    { file: "src/B.al", deployed: 16 },
    { file: "src/Weird[1].al", deployed: 17 },
    { file: "src/Big.al", deployed: 60 },
    { file: "src/Huge.al", deployed: 500 },
  ];
  const kind = (f: string) =>
    f.includes("PageExt") ? "other" : f === "src/Setup.al" ? "setup" : "codeunit";
  // 16 + 16 + 60 = 92; Huge would pass 300. Setup is skipped, and so is a glob character.
  expect(pickFiles(files, kind)).toEqual(["src/B.al", "src/Z.al", "src/Big.al"]);
  // Service Declaration's shape: the file crossing 100 is taken (23 + 30 + 134 = 187), then the pick ends.
  const sd = [23, 30, 134, 140].map((deployed, i) => ({ file: `f${i}.al`, deployed }));
  expect(pickFiles(sd, () => "codeunit")).toEqual(["f0.al", "f1.al", "f2.al"]);
  // 100 reached: nothing more, however small.
  const full = [50, 60, 70].map((deployed, i) => ({ file: `g${i}.al`, deployed }));
  expect(pickFiles(full, () => "codeunit")).toEqual(["g0.al", "g1.al"]);
  // The first codeunit is taken even when it alone passes 100.
  expect(pickFiles([{ file: "h.al", deployed: 500 }], () => "codeunit")).toEqual(["h.al"]);
  const many = Array.from({ length: 12 }, (_, i) => ({ file: `c${i + 10}.al`, deployed: 1 }));
  expect(pickFiles(many, () => "codeunit")).toHaveLength(8);
  expect(pickFiles(files, () => "other")).toEqual(["src/A.PageExt.al"]);
  expect(pickFiles([{ file: "src/Empty.al", deployed: 0 }], () => "codeunit")).toEqual([]);
});

test("readStore reads the latest run's baseline (last row per test) and its mutants' test rows, from a real store", () => {
  const path = join(mkdtempSync(join(tmpdir(), "triage-")), "s.sqlite");
  const store = new ResultsStore(path);
  const ref = (codeunitName: string, method: string) => ({ codeunitId: 1, codeunitName, method });
  const newRun = () =>
    store.createRun({
      projectPath: "p",
      backend: "al-runner-v3",
      appVersion: "1.0.0.0",
      identityScheme: 1,
      buildSymbols: [],
      coverageMode: "al-runner",
      testScope: null,
    });
  const old = newRun(); // an abandoned serve run
  store.recordTestResult(old, null, null, ref("Old", "t"), "pass", 1);
  const r = newRun();
  store.recordTestResult(r, null, null, ref("A", "x"), "fail", 1, "first");
  store.recordTestResult(r, null, null, ref("A", "x"), "pass", 1); // the method re-baseline: the last row counts
  const mid = store.recordMutant(r, {
    mutantCode: "M0001",
    astHash: "h",
    codeunitName: "A",
    procedureName: "P",
    operatorName: "lethal.return-value",
    operatorMajor: 1,
    file: "src/A.al",
    line: 1,
    verdict: "killed",
    durationMs: 1,
    batchIndex: 0,
  });
  store.recordTestResult(r, mid, "M0001", ref("A", "x"), "fail", 1, "a mutant's row");
  store.close();
  expect(readStore(path)).toEqual({
    rows: [{ test: "A.x", outcome: "pass", message: "" }],
    mutantTestRows: 1,
  });
});
