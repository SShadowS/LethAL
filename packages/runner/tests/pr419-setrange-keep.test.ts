// PR-419 (R1209): the '1=18' variant of edge e5176a9fd's reworded Text-to-Integer refusal is kept EXACTLY, one row for the
// measured line (t12-refusals cell 51009, captured in /coord/handoff/PR-419/kc/kept.json); nothing looser.
// Spec: docs/superpowers/specs/2026-11-24-pr419-setrange-1eq18-keep.md.
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
// The line t12-refusals 51009 reads on edge e5176a9fd, byte for byte.
const LINE = SR("Text", "1=18", "Integer");
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");

describe("PR-419: the '1=18' Text-to-Integer refusal in edge's wording", () => {
  // Red: remove the PR56_KEPT row.
  test("the measured line is kept, by its own exact entry", () => {
    expect(keeps(P + LINE)).toBe(true);
    expect(V3_SERVE_SAFE_REFUSALS["setrange-text-1eq18-to-integer"]?.test(P + LINE)).toBe(true);
    expect(V3_SERVE_SAFE_REFUSALS["setrange-text-eq18-to-integer"]?.test(P + LINE)).toBe(false);
  });

  test.each([
    ["another value", SR("Text", "2=18", "Integer")],
    ["another number", SR("Text", "1=19", "Integer")],
    ["a Code source", SR("Code", "1=18", "Integer")],
    ["another field type", SR("Text", "1=18", "BigInteger")],
    ["another assumption", SR("Text", "1=18", "Integer", "assumption setrange-other")],
    ["a tail appended", `${LINE}; more`],
  ])("an unmeasured near miss still closes: %s", (_name, line) => {
    expect(keeps(P + line)).toBe(false);
  });

  test("a non-refusal row with the same text never counts as kept", () => {
    expect(keeps(P + LINE, false)).toBe(false);
  });

  test("PR-408's two rows and the old %INTTEXT% texts stay kept", () => {
    expect(keeps(P + SR("Text", "=18", "Integer"))).toBe(true);
    expect(keeps(P + SR("Code", "GL00000000", "BigInteger"))).toBe(true);
    expect(keeps(`${P}conversion of Text '=18' to Integer`)).toBe(true);
    expect(keeps(`${P}conversion of Text '1=18' to Integer`)).toBe(true);
  });
});
