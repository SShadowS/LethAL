import { describe, expect, test } from "bun:test";
import { DEFAULT_WAIT, diffCases, matchingProcesses, vacuity } from "./verify-equivalence.ts";
import { parseJunit } from "./verify.ts";

const tc = (file: string, name: string, body = "", classname = "D"): string =>
  `<testcase name="${name}" classname="${classname}" time="0.1" file="${file}" line="1"${body === "" ? " />" : `>${body}</testcase>`}`;

const REF = parseJunit(
  [
    '<testsuites><testsuite name="a.test.ts" file="a.test.ts">',
    tc("a.test.ts", "one"),
    tc("a.test.ts", "two"),
    "</testsuite>",
    '<testsuite name="b.test.ts" file="b.test.ts">',
    tc("b.test.ts", "three"),
    tc("b.test.ts", "four"),
    "</testsuite></testsuites>",
  ].join("\n"),
);

describe("verify-equivalence diff (hand-written junit)", () => {
  test("an identical run has no difference", () => {
    expect(diffCases(REF, [...REF].reverse()).size).toBe(0);
  });
  test("a missing test is named, by file", () => {
    const d = diffCases(
      REF,
      REF.filter((c) => c.name !== "two"),
    );
    expect([...d]).toEqual([["a.test.ts", ["- D > two [pass]"]]]);
  });
  test("an extra test is named, including a duplicate of an existing name", () => {
    const d = diffCases(REF, [...REF, ...parseJunit(tc("b.test.ts", "three"))]);
    expect([...d]).toEqual([["b.test.ts", ["+ D > three [pass]"]]]);
  });
  test("a status change is a - and a + on the same name", () => {
    const run = REF.map((c) =>
      c.name === "four"
        ? (parseJunit(tc("b.test.ts", "four", '<failure message="x" />'))[0] ?? c)
        : c,
    );
    expect([...diffCases(REF, run)]).toEqual([
      ["b.test.ts", ["- D > four [pass]", "+ D > four [fail]"]],
    ]);
  });
  test("a worker crash: lost tests and a (worker crashed) case, both named", () => {
    const crashed = parseJunit(
      [
        tc("a.test.ts", "one"),
        tc("a.test.ts", "two"),
        tc("b.test.ts", "three"),
        tc(
          "b.test.ts",
          "(worker crashed)",
          '<failure type="Error" message="worker process crashed" />',
          "",
        ),
      ].join("\n"),
    );
    expect([...diffCases(REF, crashed)]).toEqual([
      ["b.test.ts", ["- D > four [pass]", "+ (worker crashed) [fail]"]],
    ]);
  });
});

describe("review r1 #4: an empty comparison is refused, never IDENTICAL", () => {
  const run = (name: string, cases: number, pass = cases, todo = 0) => ({
    name,
    cases,
    pass,
    skip: 0,
    fail: 0,
    todo,
  });
  test("real runs with matching counts pass", () => {
    expect(vacuity([run("serial-1", 3), run("parallel-1", 4, 3, 1)])).toEqual([]);
  });
  test("zero cases everywhere, an unread summary, or dropped cases are refused", () => {
    expect(vacuity([run("serial-1", 0), run("parallel-1", 0)])).toContain(
      "the reference run has 0 junit cases",
    );
    expect(vacuity([run("serial-1", 3), run("parallel-1", 3, -1)]).join("\n")).toContain(
      "parallel-1: no pass/fail summary",
    );
    expect(vacuity([run("serial-1", 3), run("parallel-1", 2, 3)]).join("\n")).toContain(
      "parallel-1: 2 junit cases but 3 counted",
    );
  });
});

describe("the heavy-job wait", () => {
  const PS = [
    "    PID COMMAND",
    "     10 bun run itest:alrunner",
    "     11 /work/tools/al-runner/current/al-runner --output-json",
    "     12 bun packages/runner/itest/hang.itest.ts",
    "     13 bun scripts/prod-identity-keys.ts /x out /work/src/DC/app",
    "     14 bun packages/runner/itest/tables.itest.ts",
    "     15 bun scripts/verify-equivalence.ts --serial 3",
    "     16 tail -F /coord/handoff/x/al-runner.log",
    "     17 /bin/bash -c ps -eo pid,args | grep al-runner",
    "     18 bun packages/runner/itest/al-runner.itest.ts",
    "     19 bun scripts/verify.ts",
    "     20 bun test --parallel=8",
  ].join("\n");
  test("matches itest:alrunner, al-runner.itest.ts, the runtime, itest:hang, corpus jobs and other verifies; not a remote BC gate or itself", () => {
    const got = matchingProcesses(PS, new RegExp(DEFAULT_WAIT), new Set([15]));
    expect(got.map((l) => Number(l.split(" ")[0]))).toEqual([10, 11, 12, 13, 18, 19, 20]);
  });
});
