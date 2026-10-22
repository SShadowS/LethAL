import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * fixture the same. Each property below maps to one of the three sort keys.
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
    const out = orderCoveringTests(covering, mutant(), newKillLedger(), new Map());
    expect(out.map((r) => r.method)).toEqual(["A", "B", "C"]);
    expect(covering.map((r) => r.method)).toEqual(["C", "A", "B"]);
  });

  test("a test that already killed in the SAME procedure goes first, most kills first", () => {
    const ledger = newKillLedger();
    recordKill(ledger, mutant(), C);
    recordKill(ledger, mutant({ mutantId: "M0002" }), B);
    recordKill(ledger, mutant({ mutantId: "M0003" }), B);
    const out = orderCoveringTests([A, B, C], mutant({ mutantId: "M0009" }), ledger, new Map());
    expect(out.map((r) => r.method)).toEqual(["B", "C", "A"]);
  });

  test("a kill in ANOTHER procedure or object says nothing about this one", () => {
    const ledger = newKillLedger();
    recordKill(ledger, mutant({ procedureName: "Other" }), C);
    recordKill(ledger, mutant({ codeunitName: "Elsewhere" }), C);
    const out = orderCoveringTests([C, A], mutant(), ledger, new Map());
    expect(out.map((r) => r.method)).toEqual(["A", "C"]);
  });

  test("a trigger mutant's scope is its trigger, so kills there order its twins", () => {
    const trigger = mutant({ procedureName: "", triggerName: "OnInsert" });
    expect(procedureScopeOf(trigger)).toBe("Logic|OnInsert");
    const ledger = newKillLedger();
    recordKill(ledger, trigger, C);
    const out = orderCoveringTests([A, C], { ...trigger, mutantId: "M0002" }, ledger, new Map());
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
    const out = orderCoveringTests([A, B], mutant(), newKillLedger(), counts);
    expect(out.map((r) => r.method)).toEqual(["B", "A"]);
    // A test the index never saw ranks after every test it did.
    const out2 = orderCoveringTests([C, B], mutant(), newKillLedger(), counts);
    expect(out2.map((r) => r.method)).toEqual(["B", "C"]);
  });

  test("equal on the first two, the NAME decides, never a duration", () => {
    // The first version broke this tie on baseline duration and the tables gate's determinism
    // check refused it: a test's duration differs between two runs, so `killingTest` differed
    // between two consecutive passes of one invocation. Only stable inputs may order.
    const out = orderCoveringTests([B, A], mutant(), newKillLedger(), new Map());
    expect(out.map((r) => r.method)).toEqual(["A", "B"]);
  });

  test("the keys are consulted in that order, not summed: one kill beats any narrowness", () => {
    const ledger = newKillLedger();
    recordKill(ledger, mutant(), A); // A: broad, but it killed here
    const counts = new Map([
      [testKeyOf(A), 500],
      [testKeyOf(B), 1],
    ]);
    const out = orderCoveringTests([B, A], mutant({ mutantId: "M0002" }), ledger, counts);
    expect(out.map((r) => r.method)).toEqual(["A", "B"]);
  });

  test("a codeunit sharing a method name is a different test", () => {
    const other = t("A", 79200);
    const ledger = newKillLedger();
    recordKill(ledger, mutant(), other);
    const out = orderCoveringTests([A, other], mutant({ mutantId: "M0002" }), ledger, new Map());
    expect(out[0]?.codeunitId).toBe(79200);
  });
});

// R481: the last tie is broken by CODE UNIT, never by the host's default collation, so two hosts
// order one mutant's covering tests the same way (the order decides killingTest, killPosition and,
// through a warm prefix, possibly the verdict).
describe("orderCoveringTests: the name tie-break ignores the host collation (R481)", () => {
  // The one pair on any gate fixture that collations order differently (sandbox-data-tests).
  const weak = { ...t("NoTriggerValidateRunsWeak"), codeunitName: "Data Tests" };
  const notBlank = { ...t("NotBlankFilterCountsOnlyTaggedRows"), codeunitName: "Data Tests" };
  // A Danish-style pair: `Aa…` sorts after `Z…` under da-DK, before it by code unit.
  const aa = t("Aa_First");
  const z = t("Z_Last");

  // The tie-break reads the QUALIFIED name, `codeunit.method`, so "Data Tests.…" sorts before
  // "Sandbox Tests.…".
  const CODE_UNIT_ORDER = [
    "NoTriggerValidateRunsWeak",
    "NotBlankFilterCountsOnlyTaggedRows",
    "Aa_First",
    "Z_Last",
  ];

  test("code-unit order: `NoT…` before `Not…`, `Aa…` before `Z…`", () => {
    const out = orderCoveringTests([notBlank, weak, z, aa], mutant(), newKillLedger(), new Map());
    expect(out.map((r) => r.method)).toEqual(CODE_UNIT_ORDER);
  });

  test("an injected host collation that reverses every comparison does not change the order", () => {
    const original = String.prototype.localeCompare;
    const reversed = function (this: string, that: string): number {
      return -original.call(this, that);
    };
    String.prototype.localeCompare = reversed as typeof String.prototype.localeCompare;
    try {
      const out = orderCoveringTests([z, weak, aa, notBlank], mutant(), newKillLedger(), new Map());
      expect(out.map((r) => r.method)).toEqual(CODE_UNIT_ORDER);
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});

/**
 * R-658 plan test F1 (pre-commitment 00d508c4 §2): with the new codeunit 79451 in the hang tests
 * app, the existing `DrainQueue` killer still runs first under every `DrainQueue` mutant, so no
 * new test (and never `SleepsPast…`'s 25 s Sleep) runs under a mutant. Names are read from the
 * fixture `.al` files, never typed here, so a rename moves this test.
 */
describe("R-658 F1: the hang fixture's covering-test order", () => {
  const SRC = join(import.meta.dir, "..", "..", "..", "fixtures", "sandbox-hang-tests", "src");
  function testsOf(file: string): TestMethodRef[] {
    const text = readFileSync(join(SRC, file), "utf8");
    const head = text.match(/^codeunit (\d+) "([^"]+)"/);
    if (head?.[1] === undefined || head[2] === undefined)
      throw new Error(`${file}: no codeunit header`);
    const codeunitId = Number(head[1]);
    const codeunitName = head[2];
    return [...text.matchAll(/\[Test\]\s*procedure (\w+)\(/g)].flatMap((m) =>
      m[1] !== undefined ? [{ codeunitId, codeunitName, method: m[1] }] : [],
    );
  }
  const old = testsOf("HangTests.Codeunit.al");
  const added = testsOf("HangBaselineTests.Codeunit.al");
  const pick = (refs: TestMethodRef[], method: string): TestMethodRef => {
    const r = refs.find((x) => x.method === method);
    if (r === undefined) throw new Error(`no test ${method}`);
    return r;
  };
  const killer = pick(old, "DrainQueueEmptiesTheQueue");
  const sleeps = pick(added, "SleepsPastTheBaselineBudget");
  const zz = pick(added, "ZZDrainsAfterTheStop");
  const drain = (line: number, id: string) =>
    mutant({
      mutantId: id,
      startLine: line,
      codeunitName: "Hang Logic",
      procedureName: "DrainQueue",
    });
  // Each of the three covers one member (DrainQueue) at the 120 s default, so the members key ties.
  const members = new Map([killer, sleeps, zz].map((r) => [testKeyOf(r), 1]));

  test("the fixture reads as pre-committed: 79450 Hang Tests and 79451 Hang Z Baseline Tests", () => {
    expect(added.map((r) => `${r.codeunitId}:${r.codeunitName}.${r.method}`)).toEqual([
      "79451:Hang Z Baseline Tests.SleepsPastTheBaselineBudget",
      "79451:Hang Z Baseline Tests.ZPassesAfterTheStoppedTest",
      "79451:Hang Z Baseline Tests.ZZDrainsAfterTheStop",
    ]);
    expect(killer.codeunitName).toBe("Hang Tests");
  });

  test("old legs: the existing killer is first for line 101, then for every later DrainQueue mutant", () => {
    const ledger = newKillLedger();
    const covering = [zz, sleeps, killer];
    const first = orderCoveringTests(covering, drain(101, "M0001"), ledger, members);
    expect(first[0]).toEqual(killer);
    recordKill(ledger, drain(101, "M0001"), killer);
    for (const [line, id] of [
      [102, "M0002"],
      [103, "M0003"],
      [103, "M0004"],
      [105, "M0005"],
      [105, "M0006"],
      [107, "M0007"],
    ] as const) {
      expect(orderCoveringTests(covering, drain(line, id), ledger, members)[0]).toEqual(killer);
    }
  });

  test("BASELINE leg: were SleepsPast… counted as covering, it would sort before ZZ…", () => {
    expect(
      orderCoveringTests([zz, sleeps], drain(103, "M0003"), newKillLedger(), members)[0],
    ).toEqual(sleeps);
  });
});
