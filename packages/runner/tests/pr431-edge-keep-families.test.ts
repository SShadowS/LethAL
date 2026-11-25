// PR-431 (R1214, spec 2026-11-25-pr431-r1214-edge-keep-families.md v2): edge e5176a9fd's two daemon-closing families are
// kept by four slotted rows, which replace PR-408's and PR-419's exact rows. Each slot is bounded: a value past its class,
// another field or source type, another assumption, or a tail still closes. The kept-vs-fresh DO checks:
// /coord/handoff/PR-431/keepcheck/. The values below are invented ones of DO's shapes (DO's own stay under /coord).
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
const READ = (table: string, field = "SystemRowVersion") =>
  `${field} of a row of ${table} that the open transaction inserted before a row version sent ahead of it: BC gives the row its row version when it sends it, this runtime the Insert's`;
const FIND = (table: string) =>
  `a find filtered or sorted on SystemRowVersion of a table (${table}) with rows the open transaction inserted before a row version sent ahead of them: BC gives them their row version when it sends them, this runtime the Insert's`;
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const by = (entry: string, line: string) => V3_SERVE_SAFE_REFUSALS[entry]?.test(P + line) === true;

describe("PR-431: edge's setrange-other-type-convert and restamped-row texts", () => {
  // Red: remove any of the four PR56_KEPT rows.
  test.each([
    ["setrange-code-to-biginteger", SR("Code", "ABCDE1", "BigInteger")],
    ["setrange-code-to-biginteger", SR("Code", "QWERTYUIOPASDFG", "BigInteger")], // 15, the bound
    ["setrange-code-to-biginteger", SR("Code", "GL00000000", "BigInteger")], // PR-408's line
    ["setrange-text-to-integer", SR("Text", "QWERTYUIOPASDFGHJKLZ", "Integer")], // 20, the bound
    ["setrange-text-to-integer", SR("Text", "", "Integer")],
    ["setrange-text-to-integer", SR("Text", "=18", "Integer")], // PR-408's line
    ["setrange-text-to-integer", SR("Text", "1=18", "Integer")], // PR-419's line
    ["rowversion-restamped-read", READ("ER Row A")],
    ["rowversion-restamped-read", READ("Sales Invoice Header")],
    ["rowversion-restamped-read", READ("Purch. Cr. Memo Hdr.")],
    ["rowversion-restamped-find", FIND("ER Row A")],
    ["rowversion-restamped-find", FIND("Sales Invoice Header")],
  ])("kept by %s: %s", (entry, line) => {
    expect(keeps(P + line)).toBe(true);
    expect(by(entry, line)).toBe(true);
    // one home per text
    expect(Object.values(V3_SERVE_SAFE_REFUSALS).filter((re) => re.test(P + line))).toHaveLength(1);
  });

  // Red: widen a slot past its class (or drop a fixed word): each line below would be kept unmeasured.
  test.each([
    ["a Code of 16", SR("Code", "QWERTYUIOPASDFGH", "BigInteger")],
    ["a lower-case Code", SR("Code", "abcde1", "BigInteger")],
    ["an empty Code", SR("Code", "", "BigInteger")],
    ["a Text of 21", SR("Text", "QWERTYUIOPASDFGHJKLZX", "Integer")],
    ["a Text with a digit", SR("Text", "ABC1", "Integer")],
    ["a lower-case Text", SR("Text", "abc", "Integer")],
    ["another filter text", SR("Text", "2=18", "Integer")],
    ["Code into Integer", SR("Code", "ABCDE1", "Integer")],
    ["Text into BigInteger", SR("Text", "ABC", "BigInteger")],
    ["a Boolean source", SR("Boolean", "ABC", "Integer")],
    ["another assumption", SR("Code", "ABCDE1", "BigInteger", "assumption setrange-other")],
    ["a tail appended", `${SR("Code", "ABCDE1", "BigInteger")}; more`],
    ["another field", READ("ER Row A", "SystemModifiedAt")],
    ["a table starting lower-case", READ("er Row A")],
    ["a table of 42", READ(`A${"b".repeat(41)}`)],
    ["a table with a quote", READ("ER 'Row' A")],
    ["a find with a tail", `${FIND("ER Row A")}; more`],
    [
      "a query form",
      FIND("ER Row A").replace("a find filtered or sorted", "a query filtered or sorted"),
    ],
  ])("an unmeasured near miss still closes: %s", (_name, line) => {
    expect(keeps(P + line)).toBe(false);
  });

  test("a non-refusal row with a kept text never counts as kept", () => {
    expect(keeps(P + READ("ER Row A"), false)).toBe(false);
  });

  test("PR-408's and PR-419's exact entries are gone (one home per text), the old conversion texts stay kept", () => {
    for (const e of [
      "setrange-code-gl-to-biginteger",
      "setrange-text-eq18-to-integer",
      "setrange-text-1eq18-to-integer",
    ])
      expect(V3_SERVE_SAFE_REFUSALS[e]).toBeUndefined();
    expect(keeps(`${P}conversion of Code 'GL00000000' to BigInteger`)).toBe(true);
    expect(keeps(`${P}conversion of Text '=18' to Integer`)).toBe(true);
    expect(keeps(`${P}conversion of Text '1=18' to Integer`)).toBe(true);
  });
});
