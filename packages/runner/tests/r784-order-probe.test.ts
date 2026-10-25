// R784: leg O1, the serve order probe, is a leg of the update gate; `judgeOrderProbe` reads its answers.
// Pre-commitment: docs/superpowers/specs/2026-10-25-r784-order-probe-leg-precommitment.md (6aa7700c).
import { describe, expect, test } from "bun:test";
import { V3_GATE_LEGS, gateOutcome } from "../itest/al-runner-v3-gate";
import {
  type O1Request,
  judgeOrderProbe,
  o1LoginWorkDate,
  v3DefaultLegs,
} from "../itest/alrunner-v3-legs";
import { V3_BUILD_PINS } from "../src/al-runner-v3-pins";

const TODAY = ["2026-10-25"];
const READS: Record<string, string> = {
  ReadWorkDate: "WORKDATE=2026-10-25",
  ReadLanguage: "LANGUAGE=1033",
  ReadRows: "ROWS=0",
  ReadMark: "MARK=DEFAULT",
  ReadDepMark: "DEPMARK=DEFAULT",
  ReadDepRows: "DEPROWS=0",
  ReadNumSeq: "NUMSEQ=ABSENT",
  ReadIso: "ISO=ABSENT",
};
const WRITES = [
  "SetWorkDate",
  "SetLanguage",
  "InsertRow",
  "SetMark",
  "SetDepMark",
  "InsertDepRow",
  "AdvanceNumSeq",
  "SetIso",
];

/** The pre-committed answers for the five requests, with `tweak` applied to each line. */
function answers(
  tweak?: (l: O1Request["lines"][number]) => O1Request["lines"][number],
): O1Request[] {
  const t = tweak ?? ((l) => l);
  const plan = [["R"], ["W", "R"], ["R", "W"], ["W", "R", "W", "R", "R"], ["R"]] as const;
  return plan.map((shape, i) => {
    const entries = shape.map((kind, j) => ({ id: `${kind}${i}.${j}`, kind }));
    const lines = entries.flatMap((e) =>
      e.kind === "R"
        ? Object.entries(READS).map(([m, msg]) =>
            t({ entry: e.id, name: `Codeunit77051.${m}`, status: "fail", message: msg }),
          )
        : WRITES.map((m) => t({ entry: e.id, name: `Codeunit77052.${m}`, status: "pass" })),
    );
    return { label: `request ${i + 1}`, entries, lines };
  });
}

describe("R784: O1 is an update-gate leg", () => {
  test("O1 is in V3_GATE_LEGS and in the default legs", () => {
    expect(V3_GATE_LEGS as readonly string[]).toContain("O1");
    expect(v3DefaultLegs({ cdo: false, tables: false })).toContain("O1");
  });
  test("a gate run without O1 is not a pass", () => {
    const legs = Object.fromEntries(V3_GATE_LEGS.map((l) => [l, "pass"]));
    expect(gateOutcome(legs as never)).toBe("pass");
    expect(gateOutcome({ ...legs, O1: "skipped" } as never)).not.toBe("pass");
  });
});

describe("R784: judgeOrderProbe", () => {
  test("the pre-committed defaults pass", () => {
    expect(judgeOrderProbe(answers(), TODAY)).toEqual({ outcome: "pass", lines: [] });
  });
  test("a writer value in a Reader entry is a gate-fail, named as carry-over", () => {
    const j = judgeOrderProbe(
      answers((l) => (l.name.endsWith(".ReadLanguage") ? { ...l, message: "LANGUAGE=1030" } : l)),
      TODAY,
    );
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines.join("\n")).toContain("CARRY-OVER");
  });
  test("each writer value is caught", () => {
    for (const [m, v] of [
      ["ReadWorkDate", "WORKDATE=2001-01-01"],
      ["ReadRows", "ROWS=1"],
      ["ReadMark", "MARK=WRITER"],
      ["ReadDepMark", "DEPMARK=DEPWRITER"],
      ["ReadNumSeq", "NUMSEQ=PRESENT current=1002"],
      ["ReadIso", "ISO=WRITERISO"],
    ] as const) {
      const j = judgeOrderProbe(
        answers((l) => (l.name.endsWith(`.${m}`) ? { ...l, message: v } : l)),
        TODAY,
      );
      expect(j.outcome, m).toBe("gate-fail");
    }
  });
  test("a Writer test that does not pass is a gate-fail", () => {
    const j = judgeOrderProbe(
      answers((l) =>
        l.name.endsWith(".SetIso") ? { ...l, status: "fail", message: "ISO not set" } : l,
      ),
      TODAY,
    );
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines.join("\n")).toContain("SetIso is fail");
  });
  test("a missing Reader row is a gate-fail, never an empty match", () => {
    const rs = answers();
    const first = rs[0];
    if (first === undefined) throw new Error("no request");
    const cut = [{ ...first, lines: [] }, ...rs.slice(1)];
    expect(judgeOrderProbe(cut, TODAY).outcome).toBe("gate-fail");
  });
  test("rows in a swapped block order are a gate-fail (answer order differs from sent order)", () => {
    const rs = answers();
    const r2 = rs[1];
    if (r2 === undefined) throw new Error("no request");
    const w = r2.lines.filter((l) => l.entry === "W1.0");
    const r = r2.lines.filter((l) => l.entry === "R1.1");
    const j = judgeOrderProbe(
      [rs[0] as O1Request, { ...r2, lines: [...r, ...w] }, ...rs.slice(2)],
      TODAY,
    );
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines.join("\n")).toContain("answer order differs from sent order");
  });
  test("interleaved rows of two entries are a gate-fail", () => {
    const rs = answers();
    const r4 = rs[3];
    if (r4 === undefined) throw new Error("no request");
    const [a, b] = [
      r4.lines.filter((l) => l.entry === "W3.0"),
      r4.lines.filter((l) => l.entry === "R3.1"),
    ];
    const mixed = [...a.slice(0, 1), ...b.slice(0, 1), ...a.slice(1), ...b.slice(1)];
    const rest = r4.lines.filter((l) => l.entry !== "W3.0" && l.entry !== "R3.1");
    const j = judgeOrderProbe(
      [...rs.slice(0, 3), { ...r4, lines: [...mixed, ...rest] }, ...rs.slice(4)],
      TODAY,
    );
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines.join("\n")).toContain("answer order differs from sent order");
  });
  test("a request count or entry shape that differs from the plan is a gate-fail", () => {
    expect(judgeOrderProbe([], TODAY).outcome).toBe("gate-fail");
    expect(judgeOrderProbe(answers().slice(0, 4), TODAY).outcome).toBe("gate-fail");
    const rs = answers();
    const first = rs[0];
    if (first === undefined) throw new Error("no request");
    const w = { ...first, entries: [{ id: "R0.0", kind: "W" as const }] };
    expect(judgeOrderProbe([w, ...rs.slice(1)], TODAY).outcome).toBe("gate-fail");
  });
  test("WorkDate is judged against the clock's dates, not a fixed one", () => {
    expect(judgeOrderProbe(answers(), ["2030-01-01"]).outcome).toBe("gate-fail");
    expect(judgeOrderProbe(answers(), ["2030-01-01", "2026-10-25"]).outcome).toBe("pass");
  });
});

describe("R771 addendum 2: a pinned login WorkDate (O1's CDO set on edge-a157b2d34)", () => {
  const LOGIN = "2026-08-01";
  const atLogin = (l: O1Request["lines"][number]) =>
    l.name.endsWith(".ReadWorkDate") ? { ...l, message: `WORKDATE=${LOGIN}` } : l;
  test("every Reader entry at the pinned date passes; without the pin it is a gate-fail", () => {
    expect(judgeOrderProbe(answers(atLogin), TODAY, LOGIN)).toEqual({ outcome: "pass", lines: [] });
    expect(judgeOrderProbe(answers(atLogin), TODAY).outcome).toBe("gate-fail");
  });
  test("under the pin, the clock's date is no longer accepted (the fresh R0.0 included)", () => {
    const j = judgeOrderProbe(answers(), TODAY, LOGIN);
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines.join("\n")).toContain("request 1 entry R0.0");
  });
  test("under the pin, one Reader entry with another date is a gate-fail", () => {
    const j = judgeOrderProbe(
      answers((l) =>
        l.entry === "R3.3" && l.name.endsWith(".ReadWorkDate")
          ? { ...l, message: "WORKDATE=2026-10-25" }
          : atLogin(l),
      ),
      TODAY,
      LOGIN,
    );
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines).toHaveLength(1);
    expect(j.lines[0]).toContain("R3.3");
  });
  test("under the pin, a carried-over writer WorkDate after a W entry is still a gate-fail", () => {
    const j = judgeOrderProbe(
      answers((l) =>
        l.entry === "R1.1" && l.name.endsWith(".ReadWorkDate")
          ? { ...l, message: "WORKDATE=2001-01-01" }
          : atLogin(l),
      ),
      TODAY,
      LOGIN,
    );
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines.join("\n")).toContain("CARRY-OVER");
  });
  test("a pin that names the writer's WorkDate is refused", () => {
    const writer = (l: O1Request["lines"][number]) =>
      l.name.endsWith(".ReadWorkDate") ? { ...l, message: "WORKDATE=2001-01-01" } : l;
    const j = judgeOrderProbe(answers(writer), TODAY, "2001-01-01");
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines.join("\n")).toContain("is a writer value");
  });
  test("a pin value that is not YYYY-MM-DD is refused", () => {
    for (const bad of ["2026-8-1", "01-08-2026", "2026-08-01 ", ""]) {
      const j = judgeOrderProbe(answers(atLogin), TODAY, bad);
      expect(j.outcome, JSON.stringify(bad)).toBe("gate-fail");
      expect(j.lines.join("\n")).toContain("is not YYYY-MM-DD");
    }
  });
  test("the itest's set choice: the CDO set takes the pin's date, the own set always the clock", () => {
    const aPin = V3_BUILD_PINS.find((p) => p.id === "edge-a157b2d34");
    expect(o1LoginWorkDate("cdo", aPin)).toBe(LOGIN);
    expect(o1LoginWorkDate("own", aPin)).toBeUndefined();
    for (const p of V3_BUILD_PINS.filter((x) => x.id !== "edge-a157b2d34"))
      expect(o1LoginWorkDate("cdo", p)).toBeUndefined();
    expect(o1LoginWorkDate("cdo", undefined)).toBeUndefined();
    // The own set on the a157b2d34 pin is judged against the clock: the login date fails there.
    expect(judgeOrderProbe(answers(), TODAY, o1LoginWorkDate("own", aPin)).outcome).toBe("pass");
    expect(judgeOrderProbe(answers(atLogin), TODAY, o1LoginWorkDate("own", aPin)).outcome).toBe(
      "gate-fail",
    );
  });
  test("only the edge-a157b2d34 pin carries o1, at 2026-08-01 (#5743)", () => {
    const withO1 = V3_BUILD_PINS.filter((p) => p.o1 !== undefined);
    expect(withO1.map((p) => p.id)).toEqual(["edge-a157b2d34"]);
    expect(withO1[0]?.o1?.cdoWorkDate).toBe(LOGIN);
    expect(withO1[0]?.o1?.issue).toMatch(/\/5743$/);
  });
});
