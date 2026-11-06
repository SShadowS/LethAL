import { describe, expect, test } from "bun:test";
import {
  type StopForm,
  type StopRow,
  stopFormFor,
  stopRowFailures,
  stopWordsProblem,
} from "../itest/hang-stop-rows";

/** R582 (U6): itest:hang's two-stop check, one red test per direction. */
const STOP = "BC stopped the session: the AL StopSession call ended it";
const stop = (over: Partial<StopRow> = {}): StopRow => ({
  mutant_code: "M0001",
  method: "Spin",
  outcome: "timeout",
  duration_ms: 20_500,
  failure_message: STOP,
  ...over,
});
const m = { mutantCode: "M0001", killingTest: "Spin", stopEvidence: "bc-named-stop" };
const check = (rows: StopRow[]) => stopRowFailures("ON", m, rows, 20_000, 30_000, "408");

/** What the 400 form's failure message quotes (`scoreStop`: "BC's own words: <JSON of the body>"). */
const BODY_400 = `RunMutant exceeded its 20000 ms budget and was stopped server-side so it could be scored rather than strand the tier. BC's own words: ${JSON.stringify('{"error":{"code":"Internal_ServerError","message":"begin transaction world not called  CorrelationId:  0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0."}}')}`;
const stop400 = (over: Partial<StopRow> = {}): StopRow =>
  stop({ failure_message: BODY_400, ...over });
const m400 = { mutantCode: "M0001", killingTest: "Spin", stopEvidence: "begin-transaction-world" };
const check400 = (
  rows: StopRow[],
  form: StopForm = "400",
  mm: { mutantCode: string; killingTest: string; stopEvidence?: string } = m400,
) => stopRowFailures("ON", mm, rows, 20_000, 30_000, form);

describe("GitHub #49: one stop form per server", () => {
  test("stopFormFor: bc1-bc3 are the 408 form, bc4 the 400 form", () => {
    expect(stopFormFor("lethal.config.bc1.json")).toBe("408");
    expect(stopFormFor("lethal.config.bc2.json")).toBe("408");
    expect(stopFormFor("lethal.config.bc3.json")).toBe("408");
    expect(stopFormFor("lethal.config.bc4.json")).toBe("400");
  });

  test("stopFormFor refuses a config it cannot place, the parked default included", () => {
    expect(() => stopFormFor("lethal.config.local.json")).toThrow("cannot tell");
    expect(() => stopFormFor("lethal.config.bc5.json")).toThrow("cannot tell");
  });

  test("a 400 body with the 400 form and evidence holds on BC 29", () => {
    expect(check400([stop400(), stop400({ duration_ms: 49_999 })])).toEqual([]);
  });

  test("a 400 body fails on BC 28 (the 408 form)", () => {
    const f = check400([stop400(), stop400()], "408", { ...m400, stopEvidence: "bc-named-stop" });
    expect(f).toHaveLength(2);
    expect(f[0]).toContain("does not carry BC's 408 stop words");
  });

  test("a 408 body fails on BC 29 (the 400 form)", () => {
    const f = check400([stop(), stop()]);
    expect(f.some((x) => x.includes("does not carry BC 29's 400 body"))).toBe(true);
    expect(f.some((x) => x.includes('expected "begin-transaction-world"'))).toBe(false);
  });

  test("the 400 form without stopEvidence begin-transaction-world fails", () => {
    expect(
      check400([stop400(), stop400()], "400", { ...m400, stopEvidence: "bc-named-stop" })[0],
    ).toContain('expected "begin-transaction-world"');
    expect(
      check400([stop400(), stop400()], "400", { mutantCode: "M0001", killingTest: "Spin" })[0],
    ).toContain("stopEvidence undefined");
  });

  test("the 408 form without stopEvidence bc-named-stop fails", () => {
    expect(
      stopRowFailures(
        "ON",
        { mutantCode: "M0001", killingTest: "Spin" },
        [stop(), stop()],
        20_000,
        30_000,
        "408",
      )[0],
    ).toContain('expected "bc-named-stop"');
  });

  test("the 400 form keeps the duration window", () => {
    expect(check400([stop400(), stop400({ duration_ms: 50_000 })])[0]).toContain(
      "outside [20000, 50000)",
    );
  });

  test("stopWordsProblem: 400 needs both the text and the code", () => {
    expect(stopWordsProblem("400", "begin transaction world not called")).toBeDefined();
    expect(stopWordsProblem("400", "Internal_ServerError")).toBeDefined();
  });
});

describe("R582: hang's two stop rows per timeout kill", () => {
  test("two in-band rows with BC's stop words hold", () => {
    expect(check([stop(), stop({ duration_ms: 49_999 })])).toEqual([]);
  });

  test("one row (no re-run) fails", () => {
    expect(check([stop()])).toEqual([
      "[ON] R582: M0001 must have exactly 2 mutated timeout rows for Spin (the first run and the re-run), got 1",
    ]);
  });

  test("three rows fail", () => {
    expect(check([stop(), stop(), stop()])[0]).toContain("got 3");
  });

  test("a re-run row without BC's stop words fails", () => {
    const f = check([stop(), stop({ failure_message: "the session went away" })]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("re-run timeout row does not carry BC's 408 stop words");
  });

  test("a re-run row with only one of the two phrases fails", () => {
    expect(check([stop(), stop({ failure_message: "stopped the session" })])).toHaveLength(1);
  });

  test("a re-run row out of band fails, both ends", () => {
    expect(check([stop(), stop({ duration_ms: 19_999 })])[0]).toContain("outside [20000, 50000)");
    expect(check([stop(), stop({ duration_ms: 50_000 })])[0]).toContain("outside [20000, 50000)");
    expect(check([stop(), stop({ duration_ms: 5_000 })])[0]).toContain("outside [20000, 50000)");
  });

  test("a timeout row of another method, an unmutated row and another mutant's row are ignored", () => {
    const rows = [
      stop(),
      stop({ method: "Advance" }),
      stop({ mutant_code: null }),
      stop({ mutant_code: "M0002" }),
      stop({ outcome: "pass" }),
      stop(),
    ];
    expect(check(rows)).toEqual([]);
  });
});
