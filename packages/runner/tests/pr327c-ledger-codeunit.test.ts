import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { TestMethodRef } from "../src/backend";
import { newKillLedger, orderCoveringTests, recordKill } from "../src/test-order";

/** PR-327 (c) / R1174: the kill ledger reorders tests only WITHIN a test codeunit. */

const t = (codeunitId: number, method: string): TestMethodRef => ({
  codeunitId,
  codeunitName: `CU${codeunitId}`,
  method,
});

const m = (id = "M0001"): MutantManifestEntry =>
  ({
    mutantId: id,
    file: "src/A.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.negate-conditional",
    operatorVersion: "1.0.0",
    astHash: "h",
    objectType: "codeunit",
    codeunitId: 79000,
    codeunitName: "Logic",
    procedureName: "Post",
    originalText: "",
    mutatedText: "",
  }) as MutantManifestEntry;

const names = (rs: TestMethodRef[]) => rs.map((r) => `${r.codeunitId}.${r.method}`);

describe("orderCoveringTests keeps test codeunits in covering order (R1174)", () => {
  const A1 = t(100, "A1");
  const A2 = t(100, "A2");
  const B1 = t(200, "B1");
  const B2 = t(200, "B2");

  test("a kill by a later codeunit's test does not move that codeunit first", () => {
    const ledger = newKillLedger();
    recordKill(ledger, m(), B1);
    expect(names(orderCoveringTests([A1, B1], m("M2"), ledger, new Map()))).toEqual([
      "100.A1",
      "200.B1",
    ]);
  });

  test("within one codeunit the killer still goes first", () => {
    const ledger = newKillLedger();
    recordKill(ledger, m(), B2);
    expect(names(orderCoveringTests([A1, A2, B1, B2], m("M2"), ledger, new Map()))).toEqual([
      "100.A1",
      "100.A2",
      "200.B2",
      "200.B1",
    ]);
  });

  test("codeunit order is first appearance in covering, not by id or name", () => {
    expect(names(orderCoveringTests([B1, A1, B2], m(), newKillLedger(), new Map()))).toEqual([
      "200.B1",
      "200.B2",
      "100.A1",
    ]);
  });

  test("the code-unit name tie-break still applies within a codeunit", () => {
    const lo = t(100, "NoT_x");
    const hi = t(100, "Not_x");
    expect(names(orderCoveringTests([hi, lo], m(), newKillLedger(), new Map()))).toEqual([
      "100.NoT_x",
      "100.Not_x",
    ]);
  });
});
