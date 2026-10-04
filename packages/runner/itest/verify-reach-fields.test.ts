import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifyOutput } from "../src/verify";
import { type ReachFieldsExpectation, assertReachFields } from "./verify-reach-fields";

// R-425: the offline red-check of the gates' one R-425 assertion helper. The base output is the
// R-384 gate's REAL step-3 JSON (v4), lifted to what a v5 build prints for it: reachFilter on,
// ClampPercent not narrowed, LogAudit narrowed. Each hand-edit below is one way the fields can be
// wrong, and each must throw.

const NEW_TEST = "Sandbox Tests.ZzC0206ClampRejectsAboveHundred";

function v5Step3(): VerifyOutput {
  const v4 = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "tests", "fixtures", "verify-v4-r384-step3.json"),
      "utf8",
    ),
  ) as VerifyOutput;
  return {
    ...v4,
    verifySchemaVersion: 5,
    reachFilter: { state: "on" },
    results: v4.results.map((r) => ({ ...r, reachNarrowed: r.procedureName === "LogAudit" })),
  };
}

const idOf = (out: VerifyOutput, procedureName: string): string => {
  const r = out.results.find((x) => x.procedureName === procedureName);
  if (r === undefined) throw new Error(`no ${procedureName} row`);
  return r.id;
};

function step3Expectation(out: VerifyOutput): ReachFieldsExpectation {
  return {
    filter: { state: "on" },
    rows: {
      [idOf(out, "ClampPercent")]: { narrowed: false },
      [idOf(out, "LogAudit")]: { narrowed: true, dropped: [NEW_TEST] },
    },
  };
}

/** `out` with the named row replaced by `edit(row)`. */
function editRow(
  out: VerifyOutput,
  procedureName: string,
  edit: (r: VerifyOutput["results"][number]) => VerifyOutput["results"][number],
): VerifyOutput {
  return {
    ...out,
    results: out.results.map((r) => (r.procedureName === procedureName ? edit(r) : r)),
  };
}

describe("R-425: assertReachFields", () => {
  test("the step-3 output as pre-committed passes", () => {
    const out = v5Step3();
    expect(() => assertReachFields("step 3", out, step3Expectation(out))).not.toThrow();
  });

  test("RED: LogAudit reachNarrowed false (the live red-check's edit) throws", () => {
    const out = v5Step3();
    const bad = editRow(out, "LogAudit", (r) => ({ ...r, reachNarrowed: false }));
    expect(() => assertReachFields("step 3", bad, step3Expectation(out))).toThrow(
      /step 3: .*reachNarrowed/,
    );
  });

  test("RED: reachFilter missing throws, and is never read as off", () => {
    const { reachFilter: _f, ...noFilter } = v5Step3();
    expect(() => assertReachFields("step 3", noFilter, step3Expectation(v5Step3()))).toThrow(
      /reachFilter/,
    );
  });

  test("RED: reachFilter off where on is expected throws", () => {
    const out: VerifyOutput = {
      ...v5Step3(),
      reachFilter: { state: "off", reason: "no-reach-filter" },
    };
    expect(() => assertReachFields("step 3", out, step3Expectation(v5Step3()))).toThrow(
      /reachFilter/,
    );
  });

  test("RED: a v4 document (predates the record) throws even with the fields set", () => {
    const out: VerifyOutput = { ...v5Step3(), verifySchemaVersion: 4 };
    expect(() => assertReachFields("step 3", out, step3Expectation(v5Step3()))).toThrow(
      /reachFilter/,
    );
  });

  test("RED: a dropped list that differs throws", () => {
    const out = v5Step3();
    const exp: ReachFieldsExpectation = {
      ...step3Expectation(out),
      rows: {
        [idOf(out, "ClampPercent")]: { narrowed: false },
        [idOf(out, "LogAudit")]: { narrowed: true, dropped: ["Sandbox Tests.Other"] },
      },
    };
    expect(() => assertReachFields("step 3", out, exp)).toThrow(/dropped/);
  });

  test("RED: reachNarrowed missing on a row expected false throws", () => {
    const out = v5Step3();
    const bad = editRow(out, "ClampPercent", (r) => {
      const { reachNarrowed: _n, ...rest } = r;
      return rest;
    });
    expect(() => assertReachFields("step 3", bad, step3Expectation(out))).toThrow(/reachNarrowed/);
  });

  test("RED: a row expected absent that carries reachNarrowed throws", () => {
    const out = v5Step3();
    const exp: ReachFieldsExpectation = {
      ...step3Expectation(out),
      rows: { ...step3Expectation(out).rows, [idOf(out, "ClampPercent")]: "absent" },
    };
    expect(() => assertReachFields("step 3", out, exp)).toThrow(/reachNarrowed/);
  });

  test("RED: the row set must match the expectation exactly", () => {
    const out = v5Step3();
    const exp: ReachFieldsExpectation = {
      filter: { state: "on" },
      rows: { [idOf(out, "LogAudit")]: { narrowed: true, dropped: [NEW_TEST] } },
    };
    expect(() => assertReachFields("step 3", out, exp)).toThrow(/rows/);
  });

  test("a refusal: absent filter, no rows, passes; a present filter there throws", () => {
    const refused: VerifyOutput = {
      verifySchemaVersion: 5,
      ok: false,
      exitCode: 6,
      newTests: [],
      results: [],
      counts: { killed: 0, survived: 0, error: 0, skipped: 0 },
      refused: { reason: "not-a-survivor", detail: "d" },
      timings: { totalMs: 1 },
    };
    expect(() =>
      assertReachFields("step 5a", refused, { filter: "absent", rows: {} }),
    ).not.toThrow();
    expect(() =>
      assertReachFields(
        "step 5a",
        { ...refused, reachFilter: { state: "on" } },
        { filter: "absent", rows: {} },
      ),
    ).toThrow(/reachFilter/);
  });
});
