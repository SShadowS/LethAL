import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReport } from "../packages/runner/src/report";
import { BcV3JoinRefusal, baselineRedFromStore, joinReports, resolveKiller } from "./bc-v3-join";

// PR-490: synthetic reports, invented names. Each mutant is one site; key = file|line|operator|start|end.
type M = {
  line: number;
  verdict: string;
  killingTest?: string;
  coveringTests?: string[];
  failureNote?: string;
  mutantCode?: string;
};
const mutant = (m: M) => ({
  mutantCode: m.mutantCode ?? `M${m.line}`,
  file: "src/A.al",
  line: m.line,
  operatorName: "op",
  startIndex: m.line * 10,
  endIndex: m.line * 10 + 5,
  verdict: m.verdict,
  ...(m.killingTest !== undefined ? { killingTest: m.killingTest } : {}),
  coveringTests: m.coveringTests ?? ["T.One"],
  ...(m.failureNote !== undefined ? { failureNote: m.failureNote } : {}),
});
const report = (ms: M[], red: string[] = [], sha: string | null = "s1") =>
  ({
    ...(sha === null ? {} : { sourceSha256: sha }),
    notRunAtBaseline: red,
    mutants: ms.map(mutant),
  }) as unknown as SessionReport;

test("the killing method resolves to its full name from the covering tests, dotted codeunit names kept whole", () => {
  expect(resolveKiller("Go", ["A. B. Tests.Go", "C.Other"])).toBe("A. B. Tests.Go");
  expect(resolveKiller("Go", ["C.Other"])).toBe("Go");
  expect(resolveKiller("", ["C.Other"])).toBe("");
});

// Red: drop the killing-test comparison: line 2 reads equal.
test("equal, killed-other-test, and the answered agreement", () => {
  const bc = report([
    { line: 1, verdict: "killed", killingTest: "One" },
    { line: 2, verdict: "killed", killingTest: "One", coveringTests: ["T.One", "T.Two"] },
    { line: 3, verdict: "survived" },
  ]);
  const v3 = report([
    { line: 1, verdict: "killed", killingTest: "One" },
    { line: 2, verdict: "killed", killingTest: "Two", coveringTests: ["T.One", "T.Two"] },
    { line: 3, verdict: "survived" },
  ]);
  const r = joinReports([bc], v3);
  expect(r.summary.classes).toEqual({ equal: 2, "killed-other-test": 1 });
  expect(r.summary.answeredAgreement).toEqual({ both: 3, verdict: 3, equal: 2 });
  expect(r.summary.greenBaseline).toEqual({ both: 3, verdict: 3 });
});

// Red: read only "killed" as a kill (PR-494): line 1 reads other, line 2 loses its killer and reads equal.
test("a timeout-killed mutant is a kill, as LethAL's score counts it", () => {
  const bc = report([
    { line: 1, verdict: "timeout-killed", killingTest: "One" },
    { line: 2, verdict: "timeout-killed", killingTest: "One", coveringTests: ["T.One", "T.Two"] },
  ]);
  const v3 = report([
    { line: 1, verdict: "survived" },
    { line: 2, verdict: "killed", killingTest: "Two", coveringTests: ["T.One", "T.Two"] },
  ]);
  const r = joinReports([bc], v3);
  expect(r.summary.classes).toEqual({ "killed-vs-survived": 1, "killed-other-test": 1 });
  expect(r.summary.answeredAgreement).toEqual({ both: 2, verdict: 1, equal: 0 });
});

// Red: decide `baseline` from any red covering test (the first build): line 1 hides a real flip.
test("a flip whose KILLING test is green on both is examined, even when another covering test is red on one side", () => {
  const cover = ["T.Kill", "T.Unrelated"];
  const bc = report([{ line: 1, verdict: "survived", coveringTests: cover }]);
  const v3 = report(
    [{ line: 1, verdict: "killed", killingTest: "Kill", coveringTests: cover }],
    ["T.Unrelated"],
  );
  expect(joinReports([bc], v3).summary.classes).toEqual({ "survived-vs-killed": 1 });
});

// Red: the same; the one-mutant refusal hides under baseline.
test("a one-mutant v3 refusal is v3-refused, even when another covering test is red on v3", () => {
  const cover = ["T.Kill", "T.Unrelated"];
  const bc = report([{ line: 1, verdict: "killed", killingTest: "Kill", coveringTests: cover }]);
  const v3 = report(
    [{ line: 1, verdict: "error", coveringTests: cover, failureNote: "NotRun: out-of-scope: x" }],
    ["T.Unrelated"],
  );
  expect(joinReports([bc], v3).summary.classes).toEqual({ "v3-refused": 1 });
});

// Red: ignore the killing test's red status: the flip reads killed-vs-survived.
test("a killing test red at the other side's baseline is a baseline difference, outside the green count", () => {
  const bc = report([{ line: 1, verdict: "killed", killingTest: "One" }]);
  const v3 = report([{ line: 1, verdict: "survived" }], ["T.One"]);
  const r = joinReports([bc], v3);
  expect(r.summary.classes).toEqual({ baseline: 1 });
  expect(r.summary.greenBaseline).toEqual({ both: 0, verdict: 0 });
});

// Red: ignore the extra red sets (from a store): line 1 becomes killed-vs-survived.
test("a test that FAILED at baseline (from a store, not in notRunAtBaseline) counts as red", () => {
  const bc = report([{ line: 1, verdict: "killed", killingTest: "One" }]);
  const v3 = report([{ line: 1, verdict: "survived" }]);
  expect(joinReports([bc], v3).summary.classes).toEqual({ "killed-vs-survived": 1 });
  expect(joinReports([bc], v3, undefined, { v3: new Set(["T.One"]) }).summary.classes).toEqual({
    baseline: 1,
  });
});

// Red: drop the note check: the error/no-coverage pair is not baseline, and it counts as a no-test key.
test("an error whose note names baseline-red tests is baseline, and neither green nor no-test", () => {
  const bc = report([
    {
      line: 1,
      verdict: "error",
      coveringTests: [],
      failureNote: "covered only by test(s) that did not pass at baseline (T.X)",
    },
  ]);
  const v3 = report([{ line: 1, verdict: "no-coverage", coveringTests: [] }]);
  const r = joinReports([bc], v3);
  expect(r.summary.classes).toEqual({ baseline: 1 });
  expect(r.summary.greenBaseline).toEqual({ both: 0, verdict: 0 });
  expect(r.summary.noTestEitherSide).toBe(0);
});

// Red: count no-test keys as green: greenBaseline reads 2.
test("keys no test reaches on either side are counted apart, not as green agreement", () => {
  const none = { line: 1, verdict: "no-coverage", coveringTests: [] };
  const bc = report([none, { line: 2, verdict: "survived" }]);
  const v3 = report([none, { line: 2, verdict: "survived" }]);
  const r = joinReports([bc], v3);
  expect(r.summary.noTestEitherSide).toBe(1);
  expect(r.summary.greenBaseline).toEqual({ both: 1, verdict: 1 });
});

// PR-504 (DOTests file 2: 95 rows). Red: drop `refusedOnly` and both refused rows read `coverage`; T.Green is green
// on v3 and sits in BC's (object-level) covering list, exactly the shape that misled the old class.
test("a no-coverage whose note says its covering tests were refused at baseline is baseline, killed or survived", () => {
  const refused =
    "al-runner v3 refusal: mutant covered by test(s) al-runner v3 refused at baseline (T.Refused)";
  const bc = report([
    { line: 1, verdict: "survived", coveringTests: ["T.Green", "T.Refused"] },
    { line: 2, verdict: "killed", killingTest: "Green", coveringTests: ["T.Green"] },
  ]);
  const v3 = report([
    { line: 1, verdict: "no-coverage", coveringTests: [], failureNote: refused },
    { line: 2, verdict: "no-coverage", coveringTests: [], failureNote: refused },
  ]);
  expect(joinReports([bc], v3).summary.classes).toEqual({ baseline: 2 });
});

// PR-504, the other direction. Red: classify every v3 no-coverage as baseline (or match any note): these read baseline.
test("a no-coverage WITHOUT the refused-at-baseline note stays a coverage difference, survived or killed", () => {
  const bc = report([
    { line: 1, verdict: "survived", coveringTests: ["T.Green"] },
    { line: 2, verdict: "killed", killingTest: "Green", coveringTests: ["T.Green"] },
  ]);
  const v3 = report([
    { line: 1, verdict: "no-coverage", coveringTests: [], failureNote: "some other note" },
    { line: 2, verdict: "no-coverage", coveringTests: [] },
  ]);
  expect(joinReports([bc], v3).summary.classes).toEqual({ coverage: 2 });
});

test("killed vs no-coverage with a green killing test is a coverage difference", () => {
  const bc = report([{ line: 1, verdict: "killed", killingTest: "One" }]);
  const v3 = report([{ line: 1, verdict: "no-coverage", coveringTests: [] }]);
  expect(joinReports([bc], v3).summary.classes).toEqual({ coverage: 1 });
});

test("an error on one side only, without a baseline note, is named for that side", () => {
  const bc = report([
    { line: 1, verdict: "survived" },
    { line: 2, verdict: "error" },
  ]);
  const v3 = report([
    { line: 1, verdict: "error" },
    { line: 2, verdict: "survived" },
  ]);
  expect(joinReports([bc], v3).summary.classes).toEqual({ "v3-refused": 1, "bc-error": 1 });
});

// Red: join on mutantCode: the halves both number from M1 and collide.
test("BC halves join on the site key, never the per-half mutant code; one-side keys are listed", () => {
  const a = report([{ line: 1, verdict: "survived", mutantCode: "M1" }]);
  const b = report([{ line: 2, verdict: "survived", mutantCode: "M1" }]);
  const v3 = report([
    { line: 1, verdict: "survived" },
    { line: 2, verdict: "survived" },
    { line: 3, verdict: "survived" },
  ]);
  const r = joinReports([a, b], v3);
  expect(r.summary).toMatchObject({ bcMutants: 2, v3Mutants: 3, both: 2, onlyBc: 0, onlyV3: 1 });
  expect(r.summary.classes).toEqual({ equal: 2 });
  expect(r.rows.filter((l) => l.endsWith("\tonly-v3\t"))).toHaveLength(1);
});

test("refuses a missing or different source, a repeated key, halves with different baselines, an empty side", () => {
  const ok = report([{ line: 1, verdict: "survived" }]);
  expect(() => joinReports([ok], report([{ line: 1, verdict: "survived" }], [], "s2"))).toThrow(
    BcV3JoinRefusal,
  );
  expect(() =>
    joinReports([report([{ line: 1, verdict: "survived" }], [], null)], report([], [], null)),
  ).toThrow(/no sourceSha256/);
  expect(() => joinReports([ok, ok], ok)).toThrow(/appears twice/);
  const half = report([{ line: 2, verdict: "survived" }], ["T.X"]);
  expect(() => joinReports([ok, half], ok)).toThrow(/different baselines/);
  expect(() => joinReports([ok], ok, "src/Other.al")).toThrow(/no mutant in scope/);
  expect(() => joinReports([ok], report([]))).toThrow(/no mutant in scope on the v3 side/);
});

// Red: read every run (not the latest), or keep a row without a codeunit name.
test("the store reader takes the latest run's non-pass baseline rows and refuses a nameless row", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-v3-join-"));
  try {
    const path = join(dir, "store.sqlite");
    const db = new Database(path);
    db.run(
      "create table test_results (run_id integer, mutant_row_id integer, codeunit_name text, method text, outcome text)",
    );
    const add = (
      run: number,
      mutant: number | null,
      cu: string | null,
      m: string,
      outcome: string,
    ) => db.run("insert into test_results values (?, ?, ?, ?, ?)", [run, mutant, cu, m, outcome]);
    add(1, null, "Old Tests", "Gone", "fail");
    add(2, null, "A. B. Tests", "Red", "fail");
    add(2, null, "A. B. Tests", "Green", "pass");
    add(2, 7, "A. B. Tests", "UnderMutant", "fail");
    db.close();
    expect([...baselineRedFromStore(path)]).toEqual(["A. B. Tests.Red"]);
    const db2 = new Database(path);
    db2.run("insert into test_results values (2, null, null, 'Nameless', 'fail')");
    db2.close();
    expect(() => baselineRedFromStore(path)).toThrow(/no codeunit name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
