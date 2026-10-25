// R722: leg N1E runs N1's dotted test name (`Dot.Step`) under serve-entries. Pre-committed reading on
// alpha.5 (upstream #5798): the session fails closed by name, with the entries-answer refusal for a
// test line that has no codeunit or method. Anything else is NOT a silent pass. N1E is a leg of the
// update gate (`V3_GATE_LEGS`); alpha.2 alone has no serve-entries path and reads `pass`, not applicable.
import { describe, expect, test } from "bun:test";
import { V3_GATE_LEGS, gateOutcome } from "../itest/al-runner-v3-gate";
import {
  V3_N1E_LEG,
  V3_N1S_LEG,
  V3_NO_SERVE_ENTRIES,
  judgeN1Serve,
  v3DefaultLegs,
} from "../itest/alrunner-v3-legs";
import { decodeEntriesAnswer, serveRow } from "../src/al-runner-v3-entries";
import { findV3Pin } from "../src/al-runner-v3-pins";

const ALPHA5 = "al-runner 3.0.0-alpha.5 (07342060e)";
const ALPHA2 = "alrunner 3.0.0-alpha.2 (91253f2d6)";
// Byte for byte from /coord/handoff/R-586c/measure/N1-serve-alpha5.log.
const ALPHA5_LINE =
  '{"durationMs":0,"entry":"NONE|78850","name":"Codeunit78850.Dot.Step","status":"pass","type":"test"}';
const wrap = (line: string): string =>
  `backend transport error: two consecutive run() failures for mutant M0001 (test Space Step) — aborting session per spec §11: al-runner-v3 transport failure: al-runner serve: the entries answer is invalid: a test line without v3's row shape: ${line}; never read as "all passed" (R586 §5)`;
// Byte for byte from /coord/handoff/R-586c/measure/N1-serve-alpha2.log.
const UNKNOWN_FIELD =
  'backend transport error: two consecutive run() failures for mutant M0001 (test Space Step) — aborting session per spec §11: al-runner-v3 transport failure: al-runner serve: the request was refused: "unknown field `entries` for runTests" (0 test line(s) seen). stderr tail: <empty>; never read as "all passed" (R586 §5)';

describe("R722: judgeN1Serve", () => {
  test("the pre-committed refusal is a pass", () => {
    expect(judgeN1Serve({ threw: wrap(ALPHA5_LINE) }, ALPHA5).outcome).toBe("pass");
  });
  test("the pre-committed line really is refused by the row decoder (the text the judge reads)", () => {
    const why = serveRow(JSON.parse(ALPHA5_LINE));
    expect(typeof why).toBe("string");
    const sent = [
      {
        id: "NONE|78850",
        mutantId: "NONE",
        key: "NONE",
        codeunit: 78850,
        echo: false,
        resources: {},
        test: "",
      },
    ];
    const d = decodeEntriesAnswer(sent, {
      entrySummaries: [{ entry: "NONE|78850" }],
      tests: [JSON.parse(ALPHA5_LINE)],
      summary: {},
    } as never);
    expect("why" in d && d.why).toMatch(/^a test line without v3's row shape: /);
  });
  test("a session that completes is held, naming #5798", () => {
    const j = judgeN1Serve({ completed: true }, ALPHA5);
    expect(j.outcome).toBe("held");
    expect(j.lines.join(" ")).toMatch(/re-pre-commit: upstream may have fixed #5798/);
  });
  test("a row that now carries only a codeunit is held", () => {
    const fixed = ALPHA5_LINE.replace("{", '{"codeunit":78850,');
    const j = judgeN1Serve({ threw: wrap(fixed) }, ALPHA5);
    expect(j.outcome).toBe("held");
    expect(j.lines.join(" ")).toMatch(/re-pre-commit/);
  });
  test("a row that now carries only a method is held", () => {
    const fixed = ALPHA5_LINE.replace("{", '{"method":"Dot.Step",');
    const j = judgeN1Serve({ threw: wrap(fixed) }, ALPHA5);
    expect(j.outcome).toBe("held");
    expect(j.lines.join(" ")).toMatch(/re-pre-commit/);
  });
  test("any other error is a gate-fail", () => {
    for (const m of ["al-runner-v3-entries-batch-refused: x", ""]) {
      expect(judgeN1Serve({ threw: m }, ALPHA5).outcome).toBe("gate-fail");
    }
  });
  test("the shape refusal for another test is a gate-fail", () => {
    const other = ALPHA5_LINE.replace("Dot.Step", "Space Step");
    expect(judgeN1Serve({ threw: wrap(other) }, ALPHA5).outcome).toBe("gate-fail");
  });
  test("alpha.2 refusing `entries` is a pass, not applicable", () => {
    expect(V3_NO_SERVE_ENTRIES).toEqual([ALPHA2]);
    const j = judgeN1Serve({ threw: UNKNOWN_FIELD }, ALPHA2);
    expect(j.outcome).toBe("pass");
    expect(j.lines.join(" ")).toMatch(/not applicable: this build has no serve-entries path/);
  });
  test("any other build refusing `entries` is a gate-fail", () => {
    for (const v of [ALPHA5, "al-runner 3.0.0-alpha.3 (x)", `${ALPHA2} `]) {
      expect(judgeN1Serve({ threw: UNKNOWN_FIELD }, v).outcome).toBe("gate-fail");
    }
  });
  test("alpha.2 with any other error is a gate-fail, and a completed session is held", () => {
    expect(judgeN1Serve({ threw: "boom" }, ALPHA2).outcome).toBe("gate-fail");
    expect(judgeN1Serve({ completed: true }, ALPHA2).outcome).toBe("held");
  });
  test("N1E is a default itest leg, after N1", () => {
    const legs = v3DefaultLegs({ cdo: false, tables: false });
    expect(legs.indexOf(V3_N1E_LEG)).toBe(legs.indexOf("N1") + 1);
  });
});

// R771: byte for byte from the receipt of the held edge build a157b2d34 (/work/tools/al-runner-v3/held).
const A157_LINE =
  '{"codeunit":78850,"codeunitName":"Names Tests","durationMs":0,"entry":"NONE|78850","method":"Dot.Step","name":"Codeunit78850.Dot.Step","status":"pass","type":"test"}';
const A157 = "al-runner 3.0.0-alpha.5+edge.20261025 (a157b2d34)";
const A157_SHA = "d9429e53a6938dbafb58108f61ce5408f65389bd9604ff94b4788ef26c8d17fb";

describe("R782: judgeN1Serve on a flagged build (its pin records #5798 fixed)", () => {
  const flagged = findV3Pin(A157, A157_SHA)?.serveRowFields !== undefined;
  test("the a157b2d34 pin is flagged", () => {
    expect(flagged).toBe(true);
  });
  test("g: a completed session is a pass when flagged, held when not", () => {
    expect(judgeN1Serve({ completed: true }, A157, flagged).outcome).toBe("pass");
    expect(judgeN1Serve({ completed: true }, A157).outcome).toBe("held");
    expect(judgeN1Serve({ completed: true }, A157, false).outcome).toBe("held");
  });
  test("g: on a flagged build any error is a gate-fail, even the old pinned refusal", () => {
    for (const m of [wrap(A157_LINE), wrap(ALPHA5_LINE), "boom"]) {
      expect(judgeN1Serve({ threw: m }, A157, true).outcome).toBe("gate-fail");
    }
  });
  test("an unflagged build keeps its reading: the receipt line is held, the alpha.5 refusal a pass", () => {
    expect(judgeN1Serve({ threw: wrap(A157_LINE) }, A157).outcome).toBe("held");
    expect(judgeN1Serve({ threw: wrap(ALPHA5_LINE) }, A157).outcome).toBe("pass");
  });
});

describe("R782: serveRow reads codeunit and method from the row's fields on a flagged build", () => {
  const dotted = JSON.parse(A157_LINE) as Record<string, unknown>;
  const row = (patch: Record<string, unknown>, drop: string[] = []): Record<string, unknown> => {
    const o = { ...dotted, ...patch };
    for (const k of drop) delete o[k];
    return o;
  };
  test("a: a flagged build scores the dotted row with the right codeunit and method", () => {
    const r = serveRow(dotted, true);
    expect(r).toMatchObject({
      codeunit: 78850,
      method: "Dot.Step",
      name: "Codeunit78850.Dot.Step",
      status: "pass",
      notRun: false,
    });
  });
  test("b: an unflagged build still refuses the dotted row by name", () => {
    for (const f of [undefined, false]) {
      const r = f === undefined ? serveRow(dotted) : serveRow(dotted, f);
      expect(typeof r).toBe("string");
      expect(r).toMatch(/^a test line without v3's row shape: /);
    }
  });
  test("b: an unflagged build ignores the fields, flagged or not a plain row reads the same", () => {
    const plain = row({ codeunit: 50100, method: "A", name: "Codeunit50100.A" });
    expect(serveRow(plain)).toEqual(serveRow(plain, true));
  });
  test("c: a row whose fields disagree with its name is refused on a flagged build", () => {
    for (const patch of [
      { codeunit: 78851 },
      { method: "Other.Step" },
      { name: "Codeunit78850.Dot" },
      { name: "Codeunit78850.Dot.Step " },
    ]) {
      const r = serveRow(row(patch), true);
      expect(typeof r).toBe("string");
      expect(r).toMatch(/disagree with its name \(R782\)/);
    }
  });
  test("d: a row missing method or codeunit, or with a wrong type, is refused on a flagged build", () => {
    for (const r of [
      serveRow(row({}, ["method"]), true),
      serveRow(row({}, ["codeunit"]), true),
      serveRow(row({ codeunit: "78850" }), true),
      serveRow(row({ codeunit: 1.5 }), true),
      serveRow(row({ method: 7 }), true),
    ]) {
      expect(typeof r).toBe("string");
      expect(r).toMatch(/^a test line without v3's row shape: /);
    }
  });
  test("a flagged row with a bad status is still refused", () => {
    expect(typeof serveRow(row({ status: "weird" }), true)).toBe("string");
  });
  test("decodeEntriesAnswer passes the flag through: the dotted row decodes only when flagged", () => {
    const sent = [
      {
        id: "NONE|78850",
        mutantId: "NONE",
        key: "NONE",
        codeunit: 78850,
        echo: false,
        resources: {},
        test: "",
      },
    ];
    const answer = {
      entrySummaries: [
        { entry: "NONE|78850", passed: 1, failed: 0, errors: 0, notRun: 0, total: 1 },
      ],
      tests: [dotted],
      summary: { passed: 1, failed: 0, errors: 0, notRun: 0, total: 1 },
    } as never;
    expect("why" in decodeEntriesAnswer(sent, answer)).toBe(true);
    const ok = decodeEntriesAnswer(sent, answer, true);
    expect("rows" in ok && ok.rows.get("NONE|78850")?.[0]?.method).toBe("Dot.Step");
  });
});

describe("R722: N1E is read by the update gate", () => {
  const legs = (o: string) =>
    Object.fromEntries(V3_GATE_LEGS.map((l) => [l, l === V3_N1E_LEG ? o : "pass"])) as Record<
      string,
      "pass" | "held" | "gate-fail" | "infra-fail"
    >;
  test("N1E is in V3_GATE_LEGS", () => {
    expect((V3_GATE_LEGS as readonly string[]).includes(V3_N1E_LEG)).toBe(true);
  });
  test("N1S is in V3_GATE_LEGS (R763: the widened method shape rests on it)", () => {
    expect((V3_GATE_LEGS as readonly string[]).includes(V3_N1S_LEG)).toBe(true);
  });
  test("N1E held with every other leg passing is held", () => {
    expect(gateOutcome(legs("held"))).toBe("held");
  });
  test("N1E pass is a pass, gate-fail and infra-fail are not", () => {
    expect(gateOutcome(legs("pass"))).toBe("pass");
    expect(gateOutcome(legs("gate-fail"))).toBe("gate-fail");
    expect(gateOutcome(legs("infra-fail"))).toBe("infra-fail");
  });
});
