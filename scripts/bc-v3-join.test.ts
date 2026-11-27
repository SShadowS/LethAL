import { expect, test } from "bun:test";
import type { SessionReport } from "../packages/runner/src/report";
import { BcV3JoinRefusal, joinReports } from "./bc-v3-join";

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
const report = (ms: M[], red: string[] = [], sha = "s1") =>
  ({
    sourceSha256: sha,
    notRunAtBaseline: red,
    mutants: ms.map(mutant),
  }) as unknown as SessionReport;

// Red: compare killing tests on any verdict, or drop the killing-test check: the first two lines swap classes.
test("equal, killed-other-test, and the answered and green-baseline agreement", () => {
  const bc = report([
    { line: 1, verdict: "killed", killingTest: "a" },
    { line: 2, verdict: "killed", killingTest: "a" },
    { line: 3, verdict: "survived" },
  ]);
  const v3 = report([
    { line: 1, verdict: "killed", killingTest: "a" },
    { line: 2, verdict: "killed", killingTest: "b" },
    { line: 3, verdict: "survived" },
  ]);
  const r = joinReports([bc], v3);
  expect(r.summary.classes).toEqual({ equal: 2, "killed-other-test": 1 });
  expect(r.summary.answeredAgreement).toEqual({ both: 3, verdict: 3, equal: 2 });
  expect(r.summary.greenBaseline).toEqual({ both: 3, verdict: 3 });
});

// Red: classify a verdict flip before the baseline check: line 1 reads killed-vs-survived and green counts it.
test("a covering test red on one side only is a baseline difference, outside the green-baseline count", () => {
  const bc = report([{ line: 1, verdict: "killed", killingTest: "a" }]);
  const v3 = report([{ line: 1, verdict: "survived" }], ["T.One"]);
  const r = joinReports([bc], v3);
  expect(r.summary.classes).toEqual({ baseline: 1 });
  expect(r.summary.greenBaseline).toEqual({ both: 0, verdict: 0 });
});

// Red: ignore the extra red sets (from a store): line 1 becomes killed-vs-survived.
test("a test that FAILED at baseline (from a store, not in notRunAtBaseline) counts as red", () => {
  const bc = report([{ line: 1, verdict: "killed", killingTest: "a" }]);
  const v3 = report([{ line: 1, verdict: "survived" }]);
  expect(joinReports([bc], v3).summary.classes).toEqual({ "killed-vs-survived": 1 });
  expect(joinReports([bc], v3, undefined, { v3: new Set(["T.One"]) }).summary.classes).toEqual({
    baseline: 1,
  });
});

// Red: drop the note check from the green count: the error/no-coverage pair counts as green with a differing verdict.
test("a note naming baseline-red tests keeps the mutant out of the green-baseline count", () => {
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
});

test("no-coverage on one side with different covering sets is a coverage difference", () => {
  const bc = report([{ line: 1, verdict: "killed", killingTest: "a", coveringTests: ["T.One"] }]);
  const v3 = report([{ line: 1, verdict: "no-coverage", coveringTests: [] }]);
  expect(joinReports([bc], v3).summary.classes).toEqual({ coverage: 1 });
});

test("an error on one side only is named for that side", () => {
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
test("BC halves join on the site key, never the per-half mutant code; keys only on one side are counted", () => {
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
});

test("refuses different source, a repeated key, and an empty side", () => {
  const ok = report([{ line: 1, verdict: "survived" }]);
  expect(() => joinReports([ok], report([{ line: 1, verdict: "survived" }], [], "s2"))).toThrow(
    BcV3JoinRefusal,
  );
  expect(() => joinReports([ok, ok], ok)).toThrow(/appears twice/);
  expect(() => joinReports([ok], ok, "src/Other.al")).toThrow(/no mutant in scope/);
});
