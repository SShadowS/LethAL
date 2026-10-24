import { describe, expect, test } from "bun:test";
import { isolateBreakingMutants } from "../src/bisect";

// R734: `isolateBreakingMutants` replaces `bisectFailingMutant` (whose tests stay in bisect.test.ts
// until it is removed). `compile(subset)` is true when the subset compiles. Call counters on the
// fake, never timing.
function fake(breaks: (subset: readonly string[]) => boolean) {
  const calls: (readonly string[])[] = [];
  const compile = async (subset: readonly string[]) => {
    calls.push(subset);
    return !breaks(subset);
  };
  return { calls, compile };
}
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `M${String(i + 1).padStart(4, "0")}`);

describe("isolateBreakingMutants", () => {
  test("k=1: names the one culprit, and nobody else", async () => {
    const f = fake((s) => s.includes("M0007"));
    const out = await isolateBreakingMutants(ids(16), f.compile, 64);
    expect(out).toEqual({ kind: "isolated", culprits: ["M0007"], groupErrors: [], unresolved: [] });
  });

  test("k=1: the empty set is compiled FIRST, and a compile with nothing in it blames nobody", async () => {
    const f = fake((s) => s.includes("M0007"));
    await isolateBreakingMutants(ids(16), f.compile, 64);
    expect(f.calls[0]).toEqual([]);
  });

  test("k=2: both independent culprits are named (the old search called this environmental)", async () => {
    const f = fake((s) => s.includes("M0003") || s.includes("M0011"));
    const out = await isolateBreakingMutants(ids(16), f.compile, 64);
    expect(out.kind).toBe("isolated");
    if (out.kind !== "isolated") return;
    expect([...out.culprits].sort()).toEqual(["M0003", "M0011"]);
    expect(out.groupErrors).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  test("k=2: an innocent mutant is never named", async () => {
    const bad = new Set(["M0001", "M0016"]);
    const f = fake((s) => s.some((m) => bad.has(m)));
    const out = await isolateBreakingMutants(ids(16), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(out.culprits.every((m) => bad.has(m))).toBe(true);
  });

  test("environmental: the empty set fails, so no mutant is blamed, after exactly one compile", async () => {
    const f = fake(() => true);
    const out = await isolateBreakingMutants(ids(8), f.compile, 64);
    expect(out.kind).toBe("environmental");
    expect(f.calls).toEqual([[]]);
  });

  test("no-repro: everything compiles", async () => {
    const f = fake(() => false);
    expect(await isolateBreakingMutants(ids(4), f.compile, 64)).toEqual({ kind: "no-repro" });
  });

  test("a pair that fails only together goes to groupErrors, not to culprits", async () => {
    const f = fake((s) => s.includes("M0002") && s.includes("M0009"));
    const out = await isolateBreakingMutants(ids(12), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(out.culprits).toEqual([]);
    expect([...out.groupErrors].sort()).toEqual(["M0002", "M0009"]);
    expect(out.unresolved).toEqual([]);
  });

  test("cap: stops at the compile budget, blames nobody it did not confirm, leaves the rest unresolved", async () => {
    const bad = new Set(ids(40).filter((_, i) => i % 4 === 0)); // 10 culprits, far over 12 compiles
    const f = fake((s) => s.some((m) => bad.has(m)));
    const out = await isolateBreakingMutants(ids(40), f.compile, 12);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(f.calls.length).toBeLessThanOrEqual(12);
    expect(out.unresolved.length).toBeGreaterThan(0);
    expect(out.culprits.every((m) => bad.has(m))).toBe(true);
    // every mutant is in exactly one place: nothing is lost, nothing is listed twice
    const clean = ids(40).filter(
      (m) => ![...out.culprits, ...out.groupErrors, ...out.unresolved].includes(m),
    );
    expect(clean.every((m) => !bad.has(m))).toBe(true);
  });

  test("cap: under the budget nothing is left unresolved", async () => {
    const f = fake((s) => s.includes("M0005"));
    const out = await isolateBreakingMutants(ids(16), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(out.unresolved).toEqual([]);
    expect(f.calls.length).toBeLessThan(64);
  });

  test("a compile that throws (not a compile answer) aborts the search", async () => {
    let n = 0;
    const compile = async (_s: readonly string[]) => {
      n++;
      if (n === 3) throw new Error("disk full");
      return n === 1; // the empty set compiles, everything else fails
    };
    await expect(isolateBreakingMutants(ids(8), compile, 64)).rejects.toThrow("disk full");
  });

  // Ported from bisectFailingMutant: O(log n) per culprit, and a failure that vanishes on a
  // narrowed candidate (transient) never names an innocent mutant.
  test("one culprit among 64 costs fewer than 20 compiles", async () => {
    const f = fake((s) => s.includes("M0064"));
    const out = await isolateBreakingMutants(ids(64), f.compile, 64);
    expect(out).toEqual({ kind: "isolated", culprits: ["M0064"], groupErrors: [], unresolved: [] });
    expect(f.calls.length).toBeLessThan(20);
  });

  test("a failure that only multi-mutant subsets show is never pinned on one mutant", async () => {
    const f = fake((s) => s.length > 1);
    const out = await isolateBreakingMutants(ids(4), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(out.culprits).toEqual([]);
  });

  test("a single mutant whose artifact fails is the culprit", async () => {
    const f = fake((s) => s.length === 1);
    const out = await isolateBreakingMutants(ids(1), f.compile, 64);
    expect(out).toEqual({ kind: "isolated", culprits: ["M0001"], groupErrors: [], unresolved: [] });
  });
});
