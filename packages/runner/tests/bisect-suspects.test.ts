import { beforeAll, describe, expect, test } from "bun:test";
import { ALNodeKind, findAll, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { compileSchemataForFile } from "@lethal/schemata";
import { guardGoverning, isolateBreakingMutants, parseAlcErrors } from "../src/bisect";

// R735: alc's own diagnostics name the suspects. `compile` may answer `true` (compiles), `false`
// (fails, no pointer) or an array (fails, alc pointed at these). Call counters, never timing.
type Ans = boolean | readonly string[];
function fake(
  breaks: (s: readonly string[]) => boolean,
  point: (s: readonly string[]) => string[],
) {
  const calls: (readonly string[])[] = [];
  const compile = async (s: readonly string[]): Promise<Ans> => {
    calls.push(s);
    return breaks(s) ? point(s) : true;
  };
  return { calls, compile };
}
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `M${String(i + 1).padStart(4, "0")}`);
const m = (n: number) => `M${String(n).padStart(4, "0")}`;
const single = (calls: readonly (readonly string[])[], id: string) =>
  calls.filter((c) => c.length === 1 && c[0] === id).length;

describe("isolateBreakingMutants: suspects from alc's diagnostics (R735)", () => {
  test("B1: the suspects are compiled alone first, in alc's order", async () => {
    const bad = new Set([m(3), m(7)]);
    const f = fake(
      (s) => s.some((x) => bad.has(x)),
      (s) => s.filter((x) => bad.has(x)),
    );
    const out = await isolateBreakingMutants(ids(16), f.compile, 64);
    expect(out).toEqual({
      kind: "isolated",
      culprits: [m(3), m(7)],
      groupErrors: [],
      unresolved: [],
    });
    expect(f.calls[2]).toEqual([m(3)]);
    expect(f.calls[3]).toEqual([m(7)]);
    expect(f.calls.length).toBe(5); // empty, full, two singletons, the recompile
  });

  test("B2: an innocent mutant alc points at is compiled alone once and never blamed", async () => {
    const f = fake(
      (s) => s.includes(m(5)),
      (s) => (s.length === 16 ? [m(2)] : []),
    );
    const out = await isolateBreakingMutants(ids(16), f.compile, 64);
    expect(out).toEqual({ kind: "isolated", culprits: [m(5)], groupErrors: [], unresolved: [] });
    expect(single(f.calls, m(2))).toBe(1);
  });

  test("B3: with no suspects the sequence is exactly R734's halving", async () => {
    const breaks = (s: readonly string[]) => s.includes(m(3)) || s.includes(m(11));
    const withPointer = fake(breaks, () => []);
    const out = await isolateBreakingMutants(ids(16), withPointer.compile, 64);
    // R734's order: the empty set, the full set, then halving's first probe is the first half.
    expect(withPointer.calls.slice(0, 3)).toEqual([[], ids(16), ids(16).slice(0, 8)]);
    expect(withPointer.calls.filter((c) => c.length === 1).map((c) => c[0])).toEqual([m(3), m(11)]);
    expect(out).toEqual({
      kind: "isolated",
      culprits: [m(3), m(11)],
      groupErrors: [],
      unresolved: [],
    });
  });

  test("B4: 30 bad of 2000, all named by alc: isolated in 33 compiles", async () => {
    const bad = new Set(ids(2000).filter((_, i) => i % 67 === 3));
    expect(bad.size).toBe(30);
    const f = fake(
      (s) => s.some((x) => bad.has(x)),
      (s) => s.filter((x) => bad.has(x)),
    );
    const out = await isolateBreakingMutants(ids(2000), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(new Set(out.culprits)).toEqual(bad);
    expect(out.unresolved).toEqual([]);
    expect(f.calls.length).toBe(33);
  });

  test("B5: the recompile's own diagnostics name the next round's suspects", async () => {
    const bad = new Set([m(3), m(9)]);
    const f = fake(
      (s) => s.some((x) => bad.has(x)),
      (s) => [s.find((x) => bad.has(x)) ?? ""], // alc stops at the first error it meets
    );
    const out = await isolateBreakingMutants(ids(16), f.compile, 64);
    expect(out).toEqual({
      kind: "isolated",
      culprits: [m(3), m(9)],
      groupErrors: [],
      unresolved: [],
    });
    expect(f.calls.length).toBe(6);
    expect(f.calls[4]).toEqual([m(9)]);
  });

  test("B6: one diagnostic per compile, 30 bad of 2000: at most 64 compiles (62)", async () => {
    const bad = new Set(ids(2000).filter((_, i) => i % 67 === 3));
    const f = fake(
      (s) => s.some((x) => bad.has(x)),
      (s) => [s.find((x) => bad.has(x)) ?? ""],
    );
    const out = await isolateBreakingMutants(ids(2000), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(new Set(out.culprits)).toEqual(bad);
    expect(out.unresolved).toEqual([]);
    expect(f.calls.length).toBe(62);
  });

  test("B7: the suspects are tried BEFORE the early stop (cap 4, n 1024, k 1: found in 4)", async () => {
    // A halving round on 1024 costs 12; the budget left after the two opening compiles is 2.
    const f = fake(
      (s) => s.includes(m(700)),
      () => [m(700)],
    );
    const out = await isolateBreakingMutants(ids(1024), f.compile, 4);
    expect(out).toEqual({ kind: "isolated", culprits: [m(700)], groupErrors: [], unresolved: [] });
    expect(f.calls.length).toBe(4);
  });

  test("B8: a pair alc points at is still reported as a pair (the suspect compiles alone)", async () => {
    const f = fake(
      (s) => s.includes(m(2)) && s.includes(m(9)),
      () => [m(2)],
    );
    const out = await isolateBreakingMutants(ids(12), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(out.culprits).toEqual([]);
    expect([...out.groupErrors].sort()).toEqual([m(2), m(9)]);
    expect(out.unresolved).toEqual([]);
  });

  test("B9: a cleared suspect is not recompiled alone; a suspect outside the set is never compiled", async () => {
    // M5 breaks alone and M2+M9 only together; alc keeps pointing at M2 after M5 is gone.
    const pair = fake(
      (s) => s.includes(m(5)) || (s.includes(m(2)) && s.includes(m(9))),
      () => [m(2)],
    );
    const res = await isolateBreakingMutants(ids(12), pair.compile, 64);
    expect(res).toMatchObject({ culprits: [m(5)], unresolved: [] });
    expect(single(pair.calls, m(2))).toBe(1);
    const stray = fake(
      (s) => s.includes(m(4)),
      () => ["M9999", m(4)],
    );
    const out = await isolateBreakingMutants(ids(12), stray.compile, 64);
    expect(out).toEqual({ kind: "isolated", culprits: [m(4)], groupErrors: [], unresolved: [] });
    expect(stray.calls.some((c) => c.includes("M9999"))).toBe(false);
    expect(stray.calls.length).toBe(4);
  });

  test("B10: the budget ends mid-suspects: confirmed culprits stay, the rest is unresolved", async () => {
    const bad = new Set([m(1), m(2), m(3), m(4), m(5)]);
    const f = fake(
      (s) => s.some((x) => bad.has(x)),
      (s) => s.filter((x) => bad.has(x)),
    );
    const out = await isolateBreakingMutants(ids(10), f.compile, 5);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(out.culprits).toEqual([m(1), m(2), m(3)]);
    expect(out.unresolved).toEqual(ids(10).slice(3));
    expect(f.calls.length).toBe(5);
  });
});

// R743: a cascade (one culprit whose error alc reports on many INNOCENT branches) must not spend the
// budget on singleton compiles of innocents. At most MAX_CLEARED_SUSPECTS_PER_ROUND suspects may
// compile fine alone in one round; then that round falls back to halving. A suspect that FAILS
// alone (a culprit) does not count, so a round that names many real culprits is unchanged (R735's
// DC run: 15 culprits named at once, none cleared).
describe("isolateBreakingMutants: a cascade of innocent suspects (R743)", () => {
  test("B11: one culprit, alc points at 60 innocents: isolated by halving after 8 of them", async () => {
    const culprit = m(1500);
    const innocents = ids(60);
    const f = fake(
      (s) => s.includes(culprit),
      (s) => innocents.filter((x) => s.includes(x)),
    );
    const out = await isolateBreakingMutants(ids(2000), f.compile, 64);
    // red when every pointed innocent gets its singleton: 62 compiles, then the early stop
    expect(out).toEqual({ kind: "isolated", culprits: [culprit], groupErrors: [], unresolved: [] });
    expect(innocents.filter((x) => single(f.calls, x) === 1).length).toBe(8);
    expect(f.calls.length).toBeLessThanOrEqual(2 + 8 + Math.ceil(Math.log2(2000)) + 2);
  });

  test("B12: 20 culprits named at once: all tried alone in one round (culprits do not count)", async () => {
    const bad = new Set(ids(200).filter((_, i) => i % 10 === 0));
    expect(bad.size).toBe(20);
    const f = fake(
      (s) => s.some((x) => bad.has(x)),
      (s) => s.filter((x) => bad.has(x)),
    );
    const out = await isolateBreakingMutants(ids(200), f.compile, 64);
    if (out.kind !== "isolated") throw new Error("expected isolated");
    expect(new Set(out.culprits)).toEqual(bad);
    // red when the cap counts culprits too: rounds of 8 add a recompile each (25 compiles)
    expect(f.calls.length).toBe(23); // empty, full, 20 singletons, the recompile
  });

  test("B13: 7 innocents then the culprit: the culprit is still a suspect (no halving)", async () => {
    const culprit = m(100);
    const pointed = [...ids(7), culprit];
    const f = fake(
      (s) => s.includes(culprit),
      (s) => pointed.filter((x) => s.includes(x)),
    );
    const out = await isolateBreakingMutants(ids(128), f.compile, 64);
    expect(out).toEqual({ kind: "isolated", culprits: [culprit], groupErrors: [], unresolved: [] });
    // red when the cap stops at fewer than 8 cleared: the culprit is then found by halving
    expect(f.calls.length).toBe(11); // empty, full, 7 innocents, the culprit, the recompile
  });

  test("B14: 8 innocents then the culprit: the round stops at the cap and halves", async () => {
    const culprit = m(100);
    const pointed = [...ids(8), culprit];
    const f = fake(
      (s) => s.includes(culprit),
      (s) => pointed.filter((x) => s.includes(x)),
    );
    const out = await isolateBreakingMutants(ids(128), f.compile, 64);
    expect(out).toEqual({ kind: "isolated", culprits: [culprit], groupErrors: [], unresolved: [] });
    // red when the cap allows more than 8 cleared: the 9th suspect, the culprit, is tried alone
    expect(single(f.calls, culprit)).toBe(1);
    // the culprit is not the round's 9th suspect compile; the exact count below is halving's
    expect(f.calls[10]).not.toEqual([culprit]);
    expect(f.calls.length).toBe(2 + 8 + Math.ceil(Math.log2(128)) + 2);
  });
});

describe("parseAlcErrors (moved from the R315 script)", () => {
  test("keeps code, file name and line only", () => {
    expect(parseAlcErrors("/a/b/Foo.al(12,5): error AL0185: secret text\nnoise")).toEqual([
      { code: "AL0185", file: "Foo.al", line: 12 },
    ]);
  });
});

describe("guardGoverning against real emitted chains (R735)", () => {
  beforeAll(async () => {
    await initParser();
  });
  function emitted(src: string, afters: string[], kind: ALNodeKind) {
    const root = wrapRoot(parseAL(src));
    const nodes = findAll(root, kind);
    const before = nodes[0] as ALSyntaxNode;
    const specs: MutationSpec[] = afters.map((a, i) => ({
      operatorName: `op.m${i}`,
      operatorVersion: "1.0.0",
      astNodeId: `${before.startIndex}-${i}`,
      before,
      after: { ...before, text: a } as never,
      parentContext: "statement-position",
    }));
    return compileSchemataForFile(src, root, specs);
  }
  const chain = () =>
    emitted(
      'codeunit 51030 "C"\n{\n  procedure P(A: Integer; B: Integer)\n  begin\n    if A > B then\n      exit;\n  end;\n}\n',
      ["A >= B", "A < B", "A = B"],
      ALNodeKind.comparison_expression,
    );
  const lineOf = (text: string, needle: string) =>
    text.split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1;

  test("a mutated line belongs to its own member", () => {
    const t = chain();
    expect(guardGoverning(t, lineOf(t, "A >= B"))).toBe("M0001");
    expect(guardGoverning(t, lineOf(t, "A < B"))).toBe("M0002");
    expect(guardGoverning(t, lineOf(t, "A = B"))).toBe("M0003");
  });

  test("an error on a guard line is the PREVIOUS member's (alc reports the next line)", () => {
    const t = chain();
    expect(guardGoverning(t, lineOf(t, ".Active('M0002')"))).toBe("M0001");
    expect(guardGoverning(t, lineOf(t, ".Active('M0003')"))).toBe("M0002");
  });

  test("line 1, a line out of range, and a line above every guard give no pointer", () => {
    const t = chain();
    expect(guardGoverning(t, 1)).toBeUndefined();
    expect(guardGoverning(t, 0)).toBeUndefined();
    expect(guardGoverning(t, 9999)).toBeUndefined();
    expect(guardGoverning(t, lineOf(t, ".Active('M0001')"))).toBeUndefined();
  });

  test("the ELSE branch (the original text) is the last member's: a known wrong pointer, pinned", () => {
    const t = chain();
    const lines = t.split(/\r?\n/);
    const elseAt = lines.findIndex((l) => l.includes("end else begin")) + 1;
    expect(guardGoverning(t, elseAt + 1)).toBe("M0003");
  });

  test("works on CRLF text", () => {
    const t = chain().replaceAll("\n", "\r\n");
    expect(guardGoverning(t, lineOf(t, "A < B"))).toBe("M0002");
  });

  test("a wrapped statement and a case arm resolve to their own member", () => {
    const wrapped = emitted(
      'codeunit 51031 "C"\n{\n  procedure P(A: Integer)\n  begin\n    DoThing(A);\n  end;\n}\n',
      [""],
      ALNodeKind.procedure_call,
    );
    // The mutated branch is empty: the line after the guard holds the branch body's start.
    expect(guardGoverning(wrapped, lineOf(wrapped, ".Active('M0001')") + 1)).toBe("M0001");
    const arm = emitted(
      'codeunit 51032 "C"\n{\n  procedure P(A: Integer)\n  begin\n    case A of\n      1:\n        Foo(A + 1);\n    end;\n  end;\n}\n',
      ["Foo(A - 1)"],
      ALNodeKind.procedure_call,
    );
    expect(guardGoverning(arm, lineOf(arm, "Foo(A - 1)"))).toBe("M0001");
    expect(findFirst(wrapRoot(parseAL(arm)), ALNodeKind.procedure_call)).not.toBeNull();
  });
});
