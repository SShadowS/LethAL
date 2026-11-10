import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { TestMethodRef } from "../src/backend";
import {
  type CostModel,
  TimeBudget,
  WINDOW_TIME_CAP_MS,
  cutWindows,
  estimateCovered,
  formatEstimate,
} from "../src/mutant-windows";

/**
 * R912: the window cut, the estimate and the budget clock, without a session.
 * Costs are in ms of baseline time; a mutant's id is its only field the cut reads.
 */
const ref = (cu: number, method: string): TestMethodRef => ({
  codeunitId: cu,
  codeunitName: `CU${cu}`,
  method,
});
const m = (id: string) => ({ mutantId: id }) as unknown as MutantManifestEntry;
const ids = (ws: readonly (readonly MutantManifestEntry[])[]) =>
  ws.map((w) => w.map((x) => x.mutantId));
const model = (durations: Record<string, number>, whole?: (cu: number) => boolean): CostModel => ({
  baselineDuration: new Map(Object.entries(durations)),
  fallbackMs: 999_999,
  wholeCodeunit: whole,
});

describe("R912: cutWindows", () => {
  test("the cut falls at the time cap: 250 s mutants go two to a window", () => {
    const mutants = ["M1", "M2", "M3", "M4", "M5"].map(m);
    const tests = new Map(mutants.map((x) => [x.mutantId, [ref(1, "A")]]));
    const ws = cutWindows(mutants, tests, model({ "1::A": 250_000 }));
    expect(ids(ws)).toEqual([["M1", "M2"], ["M3", "M4"], ["M5"]]);
  });

  test("the cap is exactly 600 s: three 200 s mutants fit, a fourth does not", () => {
    expect(WINDOW_TIME_CAP_MS).toBe(600_000);
    const mutants = ["M1", "M2", "M3", "M4"].map(m);
    const tests = new Map(mutants.map((x) => [x.mutantId, [ref(1, "A")]]));
    expect(ids(cutWindows(mutants, tests, model({ "1::A": 200_000 })))).toEqual([
      ["M1", "M2", "M3"],
      ["M4"],
    ]);
  });

  test("a single mutant over the cap goes alone, between its neighbours", () => {
    const mutants = ["M1", "M2", "M3"].map(m);
    const tests = new Map<string, TestMethodRef[]>([
      ["M1", [ref(1, "A")]],
      ["M2", [ref(1, "BIG")]],
      ["M3", [ref(1, "A")]],
    ]);
    const ws = cutWindows(mutants, tests, model({ "1::A": 100_000, "1::BIG": 700_000 }));
    expect(ids(ws)).toEqual([["M1"], ["M2"], ["M3"]]);
  });

  test("the cut falls at the entry cap: the default cap of 256 holds 128 one-test mutants", () => {
    const mutants = Array.from({ length: 300 }, (_, i) => m(`M${i}`));
    const tests = new Map(mutants.map((x) => [x.mutantId, [ref(1, "A")]]));
    const ws = cutWindows(mutants, tests, model({ "1::A": 1 }));
    expect(ws.map((w) => w.length)).toEqual([128, 128, 44]);
  });

  test("an explicit entry cap cuts before the time cap would", () => {
    const mutants = ["M1", "M2", "M3"].map(m);
    const tests = new Map(mutants.map((x) => [x.mutantId, [ref(1, "A"), ref(1, "B")]]));
    // 3 entries each (two tests and the echo): a cap of 6 holds two.
    const ws = cutWindows(mutants, tests, model({ "1::A": 1, "1::B": 1 }), {
      timeMs: WINDOW_TIME_CAP_MS,
      entries: 6,
    });
    expect(ids(ws)).toEqual([["M1", "M2"], ["M3"]]);
  });

  test("an uncovered mutant costs nothing and stays in the window it falls in", () => {
    const mutants = ["M1", "U1", "M2", "M3"].map(m);
    const tests = new Map<string, TestMethodRef[]>([
      ["M1", [ref(1, "A")]],
      ["M2", [ref(1, "A")]],
      ["M3", [ref(1, "A")]],
    ]);
    const ws = cutWindows(mutants, tests, model({ "1::A": 400_000 }));
    expect(ids(ws)).toEqual([["M1", "U1"], ["M2"], ["M3"]]);
  });

  test("a whole-codeunit call counts the whole codeunit's suite, so it cuts sooner", () => {
    const mutants = ["M1", "M2"].map(m);
    const tests = new Map(mutants.map((x) => [x.mutantId, [ref(1, "A")]]));
    const durations = { "1::A": 100_000, "1::B": 350_000 };
    // Per test: 100 s each, one window. Whole codeunit: 450 s each, two windows.
    expect(ids(cutWindows(mutants, tests, model(durations)))).toEqual([["M1", "M2"]]);
    expect(
      ids(
        cutWindows(
          mutants,
          tests,
          model(durations, () => true),
        ),
      ),
    ).toEqual([["M1"], ["M2"]]);
  });
});

describe("R912: estimateCovered", () => {
  test("equals the hand sum, with a whole-codeunit mutant counted whole and a codeunit once", () => {
    const durations = {
      "10::A": 100,
      "10::B": 200,
      "10::C": 300,
      "11::X": 50,
      "11::Y": 70,
    };
    const mutants = ["M1", "M2", "M3", "M4", "U1"].map(m);
    const tests = new Map<string, TestMethodRef[]>([
      ["M1", [ref(10, "A")]], // codeunit 10 is whole: 100 + 200 + 300 = 600
      ["M2", [ref(10, "A"), ref(10, "B")]], // the same codeunit, counted once: 600
      ["M3", [ref(11, "X")]], // per test: 50
      ["M4", [ref(11, "X"), ref(11, "Y")]], // per test: 50 + 70 = 120
    ]);
    const est = estimateCovered(
      mutants,
      tests,
      model(durations, (cu) => cu === 10),
    );
    expect(est).toEqual({ covered: 4, ms: 600 + 600 + 50 + 120 });
  });

  test("formatEstimate names hours, minutes and seconds", () => {
    expect(formatEstimate(41_000)).toBe("41 s");
    expect(formatEstimate(432_000)).toBe("7.2 min");
    expect(formatEstimate(9_000_000)).toBe("2.5 h");
  });
});

describe("R912: TimeBudget", () => {
  test("is exhausted when the clock passes the budget, and `reach` keeps the first count only", () => {
    let now = 5_000;
    const b = new TimeBudget(100, 5_000, () => now);
    expect(b.exhausted).toBe(false);
    expect(b.remainingMs()).toBe(100_000);
    now = 105_000;
    expect(b.exhausted).toBe(true);
    b.reach(7);
    b.reach(9);
    expect(b.reached).toEqual({ unscheduledCount: 7 });
  });
});
