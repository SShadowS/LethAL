import { describe, expect, test } from "bun:test";
import { type Proc, legProcs, legWindows } from "./itest-timeline.ts";

describe("legWindows (R-587 M5)", () => {
  test("a sequential run: each leg from its start line to its done line", () => {
    const w = legWindows([
      { elapsed: 1, text: "  al-runner build under test: x" },
      { elapsed: 2, text: "leg sandbox-a: start" },
      { elapsed: 9, text: "  verdicts: killed=3" },
      { elapsed: 10, text: "leg sandbox-a: done in 8.0s" },
      { elapsed: 10, text: "leg sandbox-b: start" },
    ]);
    expect(w).toEqual([
      { leg: "sandbox-a", start: 2, end: 10 },
      { leg: "sandbox-b", start: 10 },
    ]);
  });

  test("a parallel run: interleaved legs keep their own windows and groups", () => {
    const w = legWindows([
      { elapsed: 5, text: "[wrapped] leg wrapped-one-shot: start" },
      { elapsed: 6, text: "[layout] leg layout-one-shot: start" },
      { elapsed: 50, text: "[layout] leg layout-one-shot: done in 44.0s" },
      { elapsed: 90, text: "[wrapped] leg wrapped-one-shot: done in 85.0s" },
    ]);
    expect(w).toEqual([
      { leg: "wrapped-one-shot", group: "wrapped", start: 5, end: 90 },
      { leg: "layout-one-shot", group: "layout", start: 6, end: 50 },
    ]);
  });
});

describe("legProcs", () => {
  const p = (pid: number, ppid: number, cmd: string): Proc => ({
    pid,
    ppid,
    rssKb: 1,
    pssKb: 1,
    cmd,
  });
  const procs = [
    p(1, 0, "bun al-runner.itest.ts --parallel=3"),
    p(2, 1, "bun al-runner.itest.ts --worker --legs layout --reports /r"),
    p(3, 2, "/tools/al-runner --server"),
    p(4, 3, "dotnet exec x"),
    p(5, 1, "bun al-runner.itest.ts --worker --legs names --reports /r"),
    p(6, 5, "/tools/al-runner --output-json"),
  ];

  test("a group's leg owns only its worker's subtree", () => {
    expect(legProcs(procs, "layout").map((x) => x.pid)).toEqual([2, 3, 4]);
    expect(legProcs(procs, "names").map((x) => x.pid)).toEqual([5, 6]);
  });

  test("no group (a sequential run) owns the whole tree; an absent worker owns nothing", () => {
    expect(legProcs(procs, undefined)).toHaveLength(6);
    expect(legProcs(procs, "wrapped")).toEqual([]);
  });
});
