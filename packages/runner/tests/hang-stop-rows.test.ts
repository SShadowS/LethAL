import { describe, expect, test } from "bun:test";
import { type StopRow, stopRowFailures } from "../itest/hang-stop-rows";

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
const m = { mutantCode: "M0001", killingTest: "Spin" };
const check = (rows: StopRow[]) => stopRowFailures("ON", m, rows, 20_000, 30_000);

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
    expect(f[0]).toContain("re-run timeout row does not carry BC's stop words");
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
