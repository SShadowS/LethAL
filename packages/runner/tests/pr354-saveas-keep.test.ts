// PR-354 (pre-commitment docs/superpowers/specs/2026-11-22-pr354-saveas-layout-keep.md): the SaveAs-with-layout refusal is
// kept EXACTLY, one row per measured report with only the inner errors measured with it; nothing looser.
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const SAVEAS = (report: string, inner: string) =>
  `an error in a SaveAs of report "${report}", which has a layout of this kind or an extension (whether SaveAs raises it or answers false is not pinned): ${inner}`;
const STMT = "Standard Statement";
const INV = "Standard Sales - Invoice";
const PAYREF = (digits: string) =>
  `The payment reference must be unique. Payment reference ${digits} already exists.`;
const COMMIT =
  "Tests cannot call the Commit function if TransactionModel property is set to AutoRollback.";
const STMT_INNER = [
  "Start Date must have a value.",
  "End Date must have a value.",
  "Start date must be earlier than End date.",
  PAYREF("000000002131019"),
];
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");

describe("PR-354: the SaveAs-with-layout refusal (R1184)", () => {
  // Red: remove either PR56_KEPT row.
  test("every measured text is kept, with the report it was measured with", () => {
    for (const inner of STMT_INNER)
      expect([inner, keeps(P + SAVEAS(STMT, inner))]).toEqual([inner, true]);
    expect(keeps(P + SAVEAS(INV, COMMIT))).toBe(true);
  });

  test("each row matches only its own report", () => {
    const stmt = V3_SERVE_SAFE_REFUSALS["saveas-layout-statement"];
    const inv = V3_SERVE_SAFE_REFUSALS["saveas-layout-sales-invoice"];
    expect(stmt).toBeDefined();
    expect(inv).toBeDefined();
    expect(stmt?.test(P + SAVEAS(STMT, STMT_INNER[0] ?? ""))).toBe(true);
    expect(stmt?.test(P + SAVEAS(INV, COMMIT))).toBe(false);
    expect(inv?.test(P + SAVEAS(INV, COMMIT))).toBe(true);
    expect(inv?.test(P + SAVEAS(STMT, STMT_INNER[0] ?? ""))).toBe(false);
  });

  // Red: widen SAVEASSTMTERR or a report name to an open pattern.
  test("nothing looser: an unmeasured report, inner error or pairing closes", () => {
    const closes = [
      SAVEAS("Standard Purchase - Order", STMT_INNER[0] ?? ""), // another report
      SAVEAS(STMT, "Posting Date must have a value."), // another inner error
      SAVEAS(STMT, COMMIT), // a pairing never measured
      SAVEAS(INV, STMT_INNER[0] ?? ""), // the other pairing never measured
      SAVEAS(STMT, PAYREF("00000000213101")), // 14 digits
      SAVEAS(STMT, PAYREF("0000000021310199")), // 16 digits
      SAVEAS(STMT, PAYREF("00000000213101x")), // not digits
    ];
    for (const v of closes) expect([v, keeps(P + v)]).toEqual([v, false]);
  });

  test("nothing looser: a tail, a dropped end, a changed word or a newline closes", () => {
    const t = SAVEAS(STMT, STMT_INNER[0] ?? "");
    const variants = [
      `${t} x`,
      t.slice(0, -1),
      t.replace("has a layout", "has layouts"),
      t.replace(" (whether SaveAs raises it or answers false is not pinned)", ""),
      `${t}\n`,
      `${P}${t}`.replace(P, "NotRun: out-of-scope:  "),
    ];
    for (const v of variants)
      expect([v, keeps(v.startsWith("NotRun") ? v : P + v)]).toEqual([v, false]);
  });

  test("the text on a plain row (notRun false) is never kept", () => {
    expect(keeps(P + SAVEAS(STMT, STMT_INNER[0] ?? ""), false)).toBe(false);
    expect(keeps(P + SAVEAS(INV, COMMIT), false)).toBe(false);
  });
});
