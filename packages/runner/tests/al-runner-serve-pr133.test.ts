// PR-133: the keep entries for two of the texts DO's x2 window still closed its daemon on, measured CLEAN by PR-54's
// strict census with every distinct text a refuser (`/coord/handoff/PR-133/census2/`, invented cells of family
// `x2-refusals`): `C*` in the BigInteger SetFilter text, and `RecordRef.GetTable of Integer 123`.
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);

const KEPT: [string, string][] = [
  ["setfilter-not-a-biginteger", "SetFilter: `C*` is not a BigInteger"],
  ["recordref-gettable-integer-123", "RecordRef.GetTable of Integer 123"],
];

describe("PR-133 keep entries", () => {
  test("each measured text is kept by its own entry and by no other", () => {
    for (const [entry, t] of KEPT) {
      const by = names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
      expect([t, keeps(P + t)]).toEqual([t, true]);
      expect([t, by]).toEqual([t, [entry]]);
    }
  });

  test("a reworded text closes: a tail, a prefix, a line break, a dropped end, and a row that is not notRun", () => {
    for (const [, t] of KEPT) {
      for (const m of [`${t} x`, `x ${t}`, `${t}\n`, t.slice(0, -1)])
        expect([m, keeps(P + m)]).toEqual([m, false]);
      expect([t, keeps(P + t, false)]).toEqual([t, false]);
    }
  });

  test("only the measured variants: near misses close", () => {
    const k = (m: string) => keeps(P + m);
    for (const c of ["", "C", "CC", "C**", "XC*", "c*", "C*C"])
      expect([c, k(`SetFilter: \`${c}\` is not a BigInteger`)]).toEqual([c, false]);
    for (const v of ["124", "1234", "12", "0", "-123", " 123", ""])
      expect([v, k(`RecordRef.GetTable of Integer ${v}`.trimEnd())]).toEqual([v, false]);
    expect(k("RecordRef.GetTable of Integer")).toBe(false);
    expect(k("RecordRef.GetTable of Decimal 123")).toBe(false);
  });

  test("P2: x2's two kept texts are kept; the other three families it closed on still close (invented tails only)", () => {
    expect(keeps("NotRun: out-of-scope: SetFilter: `C*` is not a BigInteger")).toBe(true);
    expect(keeps("NotRun: out-of-scope: RecordRef.GetTable of Integer 123")).toBe(true);
    // RunRequestPage: DO reaches it inside an AutoRollback write transaction (spec r2 H1/H2)
    expect(
      keeps(
        `${P}a parameters string without the XML declaration in this form, given to Report.RunRequestPage (which character BC's filter error names is not pinned)`,
      ),
    ).toBe(false);
    // SaveAs with a layout: it needs BaseApp's own reports
    expect(
      keeps(
        `${P}an error in a SaveAs of report "Standard Sales - Invoice", which has a layout of this kind or an extension (whether SaveAs raises it or answers false is not pinned): Tests cannot call the Commit function if TransactionModel property is set to AutoRollback.`,
      ),
    ).toBe(false);
    // the placeholder Pdf read: the same
    expect(
      keeps(
        `${P}a read of the content of a placeholder Pdf of report Standard Sales - Invoice (the runtime writes a placeholder, not BC's rendering: only that the output exists and is not empty, and that a PDF starts with the bytes '%PDF-' matches BC; a test that reads the content tests the layout renderer)`,
      ),
    ).toBe(false);
  });
});
