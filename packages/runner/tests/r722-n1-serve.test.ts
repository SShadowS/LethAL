// R722: leg N1E runs N1's dotted test name (`Dot.Step`) under serve-entries. Pre-committed reading on
// alpha.5 (upstream #5798): the session fails closed by name, with the entries-answer refusal for a
// test line that has no codeunit or method. Anything else is NOT a silent pass.
import { describe, expect, test } from "bun:test";
import { V3_N1E_LEG, judgeN1Serve, v3DefaultLegs } from "../itest/alrunner-v3-legs";
import { decodeEntriesAnswer, serveRow } from "../src/al-runner-v3-entries";

// Byte for byte from /coord/handoff/R-586c/measure/N1-serve-alpha5.log.
const ALPHA5_LINE =
  '{"durationMs":0,"entry":"NONE|78850","name":"Codeunit78850.Dot.Step","status":"pass","type":"test"}';
const wrap = (line: string): string =>
  `backend transport error: two consecutive run() failures for mutant M0001 (test Space Step) — aborting session per spec §11: al-runner-v3 transport failure: al-runner serve: the entries answer is invalid: a test line without v3's row shape: ${line}; never read as "all passed" (R586 §5)`;

describe("R722: judgeN1Serve", () => {
  test("the pre-committed refusal is a pass", () => {
    expect(judgeN1Serve({ threw: wrap(ALPHA5_LINE) }).outcome).toBe("pass");
  });
  test("the pre-committed line really is refused by the row decoder (the text the judge reads)", () => {
    const why = serveRow(JSON.parse(ALPHA5_LINE));
    expect(typeof why).toBe("string");
    const sent = [
      { id: "NONE|78850", mutantId: "NONE", codeunit: 78850, echo: false, resources: {}, test: "" },
    ];
    const d = decodeEntriesAnswer(sent, {
      entrySummaries: [{ entry: "NONE|78850" }],
      tests: [JSON.parse(ALPHA5_LINE)],
      summary: {},
    } as never);
    expect("why" in d && d.why).toMatch(/^a test line without v3's row shape: /);
  });
  test("a session that completes is held, naming #5798", () => {
    const j = judgeN1Serve({ completed: true });
    expect(j.outcome).toBe("held");
    expect(j.lines.join(" ")).toMatch(/re-pre-commit: upstream may have fixed #5798/);
  });
  test("a row that now carries codeunit and method is held", () => {
    const fixed =
      '{"codeunit":78850,"method":"Dot.Step","durationMs":0,"entry":"NONE|78850","name":"Codeunit78850.Dot.Step","status":"pass","type":"test"}';
    const j = judgeN1Serve({ threw: wrap(fixed) });
    expect(j.outcome).toBe("held");
    expect(j.lines.join(" ")).toMatch(/re-pre-commit/);
  });
  test("any other error is a gate-fail", () => {
    for (const m of [
      'al-runner serve: the request was refused: "unknown field `entries` for runTests"',
      "al-runner-v3-entries-batch-refused: x",
      "",
    ]) {
      expect(judgeN1Serve({ threw: m }).outcome).toBe("gate-fail");
    }
  });
  test("the shape refusal for another test is a gate-fail", () => {
    const other = ALPHA5_LINE.replace("Dot.Step", "Space Step");
    expect(judgeN1Serve({ threw: wrap(other) }).outcome).toBe("gate-fail");
  });
  test("N1E is a default itest leg, after N1", () => {
    const legs = v3DefaultLegs({ cdo: false, tables: false });
    expect(legs.indexOf(V3_N1E_LEG)).toBe(legs.indexOf("N1") + 1);
  });
});
