import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { TestMethodRef } from "../src/backend";
import { testKeyOf } from "../src/selection";
import {
  memberCountsByTest,
  newKillLedger,
  orderCoveringTests,
  procedureScopeOf,
  recordKill,
} from "../src/test-order";

/**
 * R197. The order is a cost heuristic and must be (a) the documented one, (b) total and
 * repeatable, (c) a no-op on verdicts, which the orchestrator tests cover by still scoring every
 * fixture the same. Each property below maps to one of the four sort keys.
 */

const t = (method: string, codeunitId = 79100): TestMethodRef => ({
  codeunitId,
  codeunitName: "Sandbox Tests",
  method,
});

function mutant(over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId: "M0001",
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
    ...over,
  } as MutantManifestEntry;
}

describe("orderCoveringTests (R197)", () => {
  const A = t("A");
  const B = t("B");
  const C = t("C");

  test("with nothing known, the order is by name, and the input is not modified", () => {
    const covering = [C, A, B];
    const out = orderCoveringTests(covering, mutant(), newKillLedger(), new Map(), new Map());
    expect(out.map((r) => r.method)).toEqual(["A", "B", "C"]);
    expect(covering.map((r) => r.method)).toEqual(["C", "A", "B"]);
  });

  test("a test that already killed in the SAME procedure goes first, most kills first", () => {
    const ledger = newKillLedger();
    recordKill(ledger, mutant(), C);
    recordKill(ledger, mutant({ mutantId: "M0002" }), B);
    recordKill(ledger, mutant({ mutantId: "M0003" }), B);
    const out = orderCoveringTests(
      [A, B, C],
      mutant({ mutantId: "M0009" }),
      ledger,
      new Map(),
      new Map(),
    );
    expect(out.map((r) => r.method)).toEqual(["B", "C", "A"]);
  });

  test("a kill in ANOTHER procedure or object says nothing about this one", () => {
    const ledger = newKillLedger();
    recordKill(ledger, mutant({ procedureName: "Other" }), C);
    recordKill(ledger, mutant({ codeunitName: "Elsewhere" }), C);
    const out = orderCoveringTests([C, A], mutant(), ledger, new Map(), new Map());
    expect(out.map((r) => r.method)).toEqual(["A", "C"]);
  });

  test("a trigger mutant's scope is its trigger, so kills there order its twins", () => {
    const trigger = mutant({ procedureName: "", triggerName: "OnInsert" });
    expect(procedureScopeOf(trigger)).toBe("Logic|OnInsert");
    const ledger = newKillLedger();
    recordKill(ledger, trigger, C);
    const out = orderCoveringTests(
      [A, C],
      { ...trigger, mutantId: "M0002" },
      ledger,
      new Map(),
      new Map(),
    );
    expect(out[0]?.method).toBe("C");
  });

  test("with no kills yet, the narrowest test (fewest members covered) goes first", () => {
    const counts = memberCountsByTest(
      new Map([
        ["Logic::Post", new Set([testKeyOf(A), testKeyOf(B)])],
        ["Logic::Other", new Set([testKeyOf(A)])],
        ["Logic::Third", new Set([testKeyOf(A)])],
      ]),
    );
    expect(counts.get(testKeyOf(A))).toBe(3);
    expect(counts.get(testKeyOf(B))).toBe(1);
    const out = orderCoveringTests([A, B], mutant(), newKillLedger(), counts, new Map());
    expect(out.map((r) => r.method)).toEqual(["B", "A"]);
    // A test the index never saw ranks after every test it did.
    const out2 = orderCoveringTests([C, B], mutant(), newKillLedger(), counts, new Map());
    expect(out2.map((r) => r.method)).toEqual(["B", "C"]);
  });

  test("equal on the first two, the faster test at baseline goes first", () => {
    const ms = new Map([
      [testKeyOf(A), 900],
      [testKeyOf(B), 120],
    ]);
    const out = orderCoveringTests([A, B], mutant(), newKillLedger(), new Map(), ms);
    expect(out.map((r) => r.method)).toEqual(["B", "A"]);
  });

  test("the keys are consulted in that order, not summed: one kill beats any narrowness or speed", () => {
    const ledger = newKillLedger();
    recordKill(ledger, mutant(), A); // A: slow and broad, but it killed here
    const counts = new Map([
      [testKeyOf(A), 500],
      [testKeyOf(B), 1],
    ]);
    const ms = new Map([
      [testKeyOf(A), 9000],
      [testKeyOf(B), 1],
    ]);
    const out = orderCoveringTests([B, A], mutant({ mutantId: "M0002" }), ledger, counts, ms);
    expect(out.map((r) => r.method)).toEqual(["A", "B"]);
  });

  test("a codeunit sharing a method name is a different test", () => {
    const other = t("A", 79200);
    const ledger = newKillLedger();
    recordKill(ledger, mutant(), other);
    const out = orderCoveringTests(
      [A, other],
      mutant({ mutantId: "M0002" }),
      ledger,
      new Map(),
      new Map(),
    );
    expect(out[0]?.codeunitId).toBe(79200);
  });
});
