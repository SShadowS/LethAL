// R612's daemon keep rule (`serveDaemonReusable`), the rule alone. Moved unchanged from
// `al-runner-backend.test.ts` by R654 S1 (plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md),
// with the rule, which v3 uses, now in `al-runner-server.ts`.
import { describe, expect, test } from "bun:test";
import { AlRunnerServeDuplicateRowError, serveDaemonReusable } from "../src/al-runner-server";

// The measured texts (`/coord/handoff/R-612/measure.md`, probe `main.stdout`), verbatim.
const HTTP =
  "NotRun: out-of-scope: an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)";
const COMMIT =
  "NotRun: out-of-scope: Commit inside a test under TestIsolation = Function: what the runner keeps is not pinned";
const CASCADE =
  "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HttpGet: did not run (an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a ): it can change session state the analysis does not follow, so the state it would have left is not BC's; this failure is not trusted: after a refusal";
const ONRUN =
  "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): Arithmetic operation resulted in an overflow.";
const NO_CALLEE =
  "NotRun: out-of-scope: R612 Broken.DoesNotCompile: call `NoSuchProcedure(1)` has no callee the checker resolved";
const PANIC_TEST =
  "NotRun: out-of-scope: runtime panic (bug): requested by ALRUNNER_DEBUG_PANIC_IN";
const PANIC_CASCADE =
  "NotRun: out-of-scope: an earlier test of this codeunit panicked (a runtime bug), so the rest of it was not run";
const DUP_KEY =
  "NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Data Key Probe is deferred: whether the test runner raises it at the end of the test is not pinned";

describe("serveDaemonReusable, the rule alone", () => {
  // Each row its own name: under v3 a repeated name throws (M-3).
  let rowSeq = 0;
  const r = (status: string, o: { message?: string; notRun?: boolean } = {}) => ({
    name: `C.X${++rowSeq}`,
    status,
    ...o,
  });
  test("v2 is today's condition: every row pass or fail, notRun ignored", () => {
    expect(serveDaemonReusable([r("pass"), r("fail")], "v2")).toBe(true);
    expect(serveDaemonReusable([r("pass", { notRun: true })], "v2")).toBe(true);
    expect(serveDaemonReusable([r("error", { notRun: true, message: COMMIT })], "v2")).toBe(false);
    expect(serveDaemonReusable([], "v2")).toBe(true);
  });
  test("R705: a no-callee row closes the v3 daemon", () => {
    expect(
      serveDaemonReusable(
        [
          { name: "C.NC1", status: "pass" },
          { name: "C.NC2", status: "error", notRun: true, message: NO_CALLEE },
        ],
        "v3",
      ),
    ).toBe(false);
  });
  test("v3 keeps on each of the four entries, and on pass/fail without notRun", () => {
    for (const m of [HTTP, COMMIT, CASCADE, ONRUN]) {
      expect([
        m,
        serveDaemonReusable([r("pass"), r("error", { notRun: true, message: m })], "v3"),
      ]).toEqual([m, true]);
    }
    expect(serveDaemonReusable([r("pass"), r("fail", { notRun: false })], "v3")).toBe(true);
  });
  // R635: the edge build's Commit wording, measured clean (`/coord/handoff/R-635/edge-reasons.md`).
  const EDGE_COMMIT =
    "NotRun: out-of-scope: Commit inside a test under TestIsolation = Function is not supported yet: no corpus test pins whether BC keeps the committed rows for the next test (corpus issue 645). Run this codeunit with TestIsolation = Codeunit (al-runner: --isolation codeunit, the default)";
  test("R635: v3 keeps on the edge build's Commit wording", () => {
    expect(serveDaemonReusable([r("error", { notRun: true, message: EDGE_COMMIT })], "v3")).toBe(
      true,
    );
  });
  test("R635: the edge Commit wording is anchored at both ends (a tail or a prefix closes)", () => {
    for (const m of [`${EDGE_COMMIT} after a timeout`, `x${EDGE_COMMIT}`]) {
      expect([m, serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")]).toEqual([
        m,
        false,
      ]);
    }
  });
  test("v3 closes on a timeout row and both panic wordings", () => {
    for (const m of ["Test exceeded 3s timeout.", PANIC_TEST, PANIC_CASCADE]) {
      expect([m, serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")]).toEqual([
        m,
        false,
      ]);
    }
  });
  for (const [c, m] of [
    [
      "c",
      "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): runtime panic (bug): boom",
    ],
    [
      "d",
      "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): the OnRun panicked (a runtime bug) at x",
    ],
    [
      "e",
      "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (Y: runtime panic (bug): z)",
    ],
  ] as const) {
    test(`T3 (${c}): no entry with a tail keeps a panic`, () => {
      expect(serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")).toBe(false);
    });
  }
  // Build review r1 I-1: a tail must not keep a timeout, a wall-time stop or ANY panic (an
  // #5698 fix would put the OnRun timeout inside the onrun-failed tail). One test per word,
  // and a case variant each, so each word's red check names its own test.
  const ONRUN_TAIL = "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): ";
  const CASCADE_TAIL =
    "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (";
  for (const [c, m] of [
    ["f timeout", `${ONRUN_TAIL}Test exceeded 3s timeout.`],
    ["f timeout case", `${ONRUN_TAIL}TIMEOUT after 3s`],
    ["f timed out", `${ONRUN_TAIL}the trigger timed out`],
    ["f timed out case", `${CASCADE_TAIL}X: Timed Out)`],
    ["f exceeded", `${ONRUN_TAIL}CPU limit Exceeded`],
    ["f wall", `${ONRUN_TAIL}stopped at 10 times N of WALL time`],
    ["f wall cascade", `${CASCADE_TAIL}X: stopped on wall time)`],
    ["f deadline", `${ONRUN_TAIL}Deadline reached`],
    // Bugs' finding: a TIMEOUT-caused cascade row, alone in the answer (no timeout row beside it).
    [
      "g time limit cascade",
      `${CASCADE_TAIL}X: did not run (the test used more than the Time Limit): this failure is not trusted`,
    ],
    ["f panicked at", `${ONRUN_TAIL}thread 'worker' panicked at src/run.rs:10:5`],
    ["f panic case", `${CASCADE_TAIL}X: PANIC in the runtime)`],
  ] as const) {
    test(`T3 (${c}): a tail never keeps a timeout, a wall-time stop or a panic`, () => {
      expect(serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")).toBe(false);
    });
  }
  test("M-3: the rule itself throws on a duplicate name under v3, never under v2", () => {
    const dup = [
      { ...r("pass"), name: "C.D" },
      { ...r("fail"), name: "C.D" },
    ];
    expect(() => serveDaemonReusable(dup, "v3")).toThrow(AlRunnerServeDuplicateRowError);
    expect(serveDaemonReusable(dup, "v2")).toBe(true);
    expect(serveDaemonReusable([r("pass"), r("pass")], "v3")).toBe(true);
  });
  test("v3 closes on every unknown kind", () => {
    const unknown = [
      r("error", { notRun: true, message: DUP_KEY }),
      r("error", { notRun: true, message: `${HTTP} and more` }),
      r("error", { notRun: true, message: `${COMMIT}.` }),
      r("error", { notRun: true }),
      r("error", { message: COMMIT }),
      r("error", { notRun: false, message: COMMIT }),
      r("fail", { notRun: true, message: COMMIT }),
      r("pass", { notRun: true }),
      r("skipped", { notRun: true, message: COMMIT }),
    ];
    for (const row of unknown) {
      expect([row, serveDaemonReusable([r("pass"), row], "v3")]).toEqual([row, false]);
    }
  });
  // R672 (plan 2026-10-23-r672-v3-refusal-prefix.md §1c): a refusal written as a plain pass/fail
  // (no notRun) says the runtime's state is not trusted, so v3 closes the daemon on it.
  const REFUSAL = "NotRun: out-of-scope: x";
  // R675: and on a plain pass/fail that holds the marker after ANY text (an Assert quoting it too).
  test("R672/R675: v3 closes on a plain fail or pass that holds the refusal marker anywhere", () => {
    for (const row of [
      r("fail", { notRun: false, message: REFUSAL }),
      r("fail", { notRun: false, message: `Error: ${REFUSAL}` }),
      r("pass", { message: `X.Y: ${REFUSAL}` }),
      r("fail", { message: `Runtime error: ${REFUSAL}` }),
      r("pass", { message: `Runtime error: ${REFUSAL}` }),
      r("fail", { message: `a::b: ${REFUSAL}` }),
      r("fail", { message: `A: B: ${REFUSAL}` }),
      r("fail", { message: `Assert.AreEqual failed. Expected: ${REFUSAL}` }),
    ]) {
      expect([row, serveDaemonReusable([row], "v3")]).toEqual([row, false]);
    }
  });
  test("R672/R675: v3 still keeps on a plain fail, a pass and every R612 keep-list refusal; v2 is unchanged", () => {
    for (const row of [
      r("fail", { message: "boom" }),
      r("fail", { message: "out-of-scope: x" }),
      r("pass"),
      ...[HTTP, COMMIT, CASCADE, ONRUN].map((message) => r("error", { notRun: true, message })),
    ]) {
      expect([row, serveDaemonReusable([row], "v3")]).toEqual([row, true]);
    }
    expect(serveDaemonReusable([r("fail", { notRun: false, message: REFUSAL })], "v2")).toBe(true);
  });
});
