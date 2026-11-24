// PR-408: edge e5176a9fd's reworded SetRange/SetFilter conversion refusal (assumption setrange-other-type-convert) is kept
// EXACTLY, one row per measured line (the edge gate's captured text); nothing looser. The kept-vs-fresh check:
// /coord/handoff/PR-408/kc/.
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const SR = (
  type: string,
  value: string,
  field: string,
  tail = "assumption setrange-other-type-convert",
) =>
  `SetRange or SetFilter of ${type} '${value}' into a ${field} field in a shape no cell measures (${tail})`;
// The two lines leg C's PR-363 cases t10/t12 read on edge e5176a9fd, byte for byte.
const CODE_LINE = SR("Code", "GL00000000", "BigInteger");
const TEXT_LINE = SR("Text", "=18", "Integer");
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");

describe("PR-408: the reworded SetRange/SetFilter conversion refusal", () => {
  // Red: remove either PR56_KEPT row.
  test("both measured edge lines are kept, each by its own exact entry", () => {
    expect(keeps(P + CODE_LINE)).toBe(true);
    expect(keeps(P + TEXT_LINE)).toBe(true);
    expect(V3_SERVE_SAFE_REFUSALS["setrange-code-gl-to-biginteger"]?.test(P + CODE_LINE)).toBe(
      true,
    );
    expect(V3_SERVE_SAFE_REFUSALS["setrange-text-eq18-to-integer"]?.test(P + TEXT_LINE)).toBe(true);
  });

  // Red: widen either row with a slot (another value or field type would then be kept unmeasured).
  test.each([
    ["another Code value", SR("Code", "GL00000001", "BigInteger")],
    ["another Text value", SR("Text", "=19", "Integer")],
    ["another field type", SR("Code", "GL00000000", "Integer")],
    ["another source type", SR("Text", "GL00000000", "BigInteger")],
    ["another assumption", SR("Text", "=18", "Integer", "assumption setrange-other")],
    ["a tail appended", `${TEXT_LINE}; more`],
  ])("an unmeasured near miss still closes: %s", (_name, line) => {
    expect(keeps(P + line)).toBe(false);
  });

  test("a non-refusal row with the same text never counts as kept", () => {
    expect(keeps(P + CODE_LINE, false)).toBe(false);
  });

  test("the old conversion texts these shapes gave on main-bf3a3e863 stay kept", () => {
    expect(keeps(`${P}conversion of Code 'GL00000000' to BigInteger`)).toBe(true);
    expect(keeps(`${P}conversion of Text '=18' to Integer`)).toBe(true);
  });
});
