// PR-365 (pre-commitment docs/superpowers/specs/2026-11-23-pr365-relationfieldno-keep.md, R1187): the Field.RelationFieldNo
// refusal is kept EXACTLY, one row per measured (field, table) pair; nothing looser. The kept lines are al-runner's real rows
// (captured under /coord/handoff/PR-255/dotnet/new.json); the not-kept ones are al-runner's real rows for an invented table
// (/coord/handoff/PR-317/ar.json).
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const RFN = (field: string, table: string) =>
  `NotRun: out-of-scope: the value of field 'RelationFieldNo' of platform table 'Field' is not known for field '${field}' of table '${table}', a TableRelation without a field of a shape not measured: no corpus test pins it (docs/probes-needed.md)`;
const MEASURED: readonly [string, string, string][] = [
  ["relation-field-no-dimension-set-entry-dimension-code", "Dimension Code", "Dimension Set Entry"],
  [
    "relation-field-no-sales-invoice-header-ship-to-post-code",
    "Ship-to Post Code",
    "Sales Invoice Header",
  ],
  [
    "relation-field-no-sales-invoice-header-dimension-set-id",
    "Dimension Set ID",
    "Sales Invoice Header",
  ],
];
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");

describe("PR-365: the Field.RelationFieldNo refusal (R1187)", () => {
  // Red: remove any of the three PR56_KEPT rows.
  test("each measured (field, table) pair is kept, by its own row only", () => {
    for (const [entry, field, table] of MEASURED) {
      expect([entry, keeps(RFN(field, table))]).toEqual([entry, true]);
      const own = V3_SERVE_SAFE_REFUSALS[entry];
      expect(own?.test(RFN(field, table))).toBe(true);
      for (const [other, f2, t2] of MEASURED)
        if (other !== entry)
          expect([entry, other, own?.test(RFN(f2, t2))]).toEqual([entry, other, false]);
    }
  });

  // Red: widen a row to a slot for the field or the table.
  test("another field or table closes the daemon (real al-runner rows of an invented table)", () => {
    for (const f of ["F3", "F4", "F5"]) expect([f, keeps(RFN(f, "RFM Ref"))]).toEqual([f, false]);
    expect(keeps(RFN("Dimension Code", "Sales Invoice Header"))).toBe(false); // a measured field on another table
    expect(keeps(RFN("Ship-to Post Code", "Dimension Set Entry"))).toBe(false);
  });

  test("a reworded or cut text closes, and the row is anchored at both ends", () => {
    const real = RFN("Dimension Code", "Dimension Set Entry");
    expect(keeps(real.replace(" (docs/probes-needed.md)", ""))).toBe(false);
    expect(keeps(`${real} (not pinned)`)).toBe(false);
    expect(keeps(real.replace("NotRun: out-of-scope: ", "NotRun: out-of-scope: x "))).toBe(false);
  });

  test("a plain fail with the same text is not a refusal to keep", () => {
    expect(keeps(RFN("Dimension Code", "Dimension Set Entry"), false)).toBe(false);
  });
});
