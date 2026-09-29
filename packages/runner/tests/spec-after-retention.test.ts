import { heapStats } from "bun:jsc";
import { describe, expect, test } from "bun:test";
import { generateMutationSet } from "../src/orchestrator";

/**
 * RUST-03 S4.2c (AMENDMENT 1's lead A): a spec's `after` node must not pin copied `children` /
 * `namedChildren` arrays (each read builds fresh wrappers on the native tree), position objects or a
 * bound `childForFieldName` closure. It keeps one wrapper per spec site: `before`.
 *
 * Counted on a synthetic project through the product's own spec generation, so both tiers'
 * `synthesizeAfter` are covered.
 */
const FILES = 300;
const unit = (k: number) => `codeunit ${50000 + k} "U${k}"
{
    procedure P${k}(A: Integer; B: Integer; C: Code[20]): Integer
    var
        X: Integer;
        R: Record Customer;
    begin
        R.SetRange("No.", C);
        if R.FindFirst() then
            R.Modify(true);
        X := A + B;
        if A > B then
            exit(1);
        if (A <> B) and (C = '') then
            X := X - 1;
        Message('%1', X);
        exit(X * 2);
    end;
}
`;

function snapshot(): ReadonlyMap<string, Buffer> {
  const m = new Map<string, Buffer>();
  for (let k = 0; k < FILES; k++) m.set(`src/U${k}.Codeunit.al`, Buffer.from(unit(k)));
  return m;
}

const counts = (): Record<string, number> => {
  Bun.gc(true);
  return { ...heapStats().objectTypeCounts };
};

describe("RUST-03 S4.2c: the spec's after node pins no copies", () => {
  test("retained arrays and functions per spec, measured on the heap", async () => {
    // First in the file, so no earlier test's specs can sit in `base`.
    const base = counts();
    const set = await generateMutationSet("synthetic", { source: snapshot(), emit: () => {} });
    const after = counts();
    const specs = set.files.reduce((n, f) => n + f.specs.length, 0);
    const per = (k: string) => ((after[k] ?? 0) - (base[k] ?? 0)) / specs;
    // Unfixed (measured): 1.01 functions and 2.32 arrays per spec, the bound closure and the two
    // copied child arrays. Fixed: 0.01 and 0.32, the project's own structures.
    expect(per("Function")).toBeLessThan(0.2);
    expect(per("Array")).toBeLessThan(1);
    expect(set.files.length).toBe(FILES);
  });

  test("no after node owns an array, a function or a position object", async () => {
    const set = await generateMutationSet("synthetic", { source: snapshot(), emit: () => {} });
    const specs = set.files.flatMap((f) => f.specs);
    expect(specs.length).toBeGreaterThan(FILES * 10);
    // Both tiers' `synthesizeAfter` are exercised.
    expect(specs.some((s) => s.operatorName === "lethal.remove-setrange")).toBe(true);
    expect(specs.some((s) => s.operatorName === "lethal.void-method-call")).toBe(true);
    let owned = 0;
    for (const s of specs) {
      for (const v of Object.values(Object.getOwnPropertyDescriptors(s.after))) {
        const x = v.value;
        if (
          Array.isArray(x) ||
          typeof x === "function" ||
          (x !== null && typeof x === "object" && x !== s.before && "row" in x)
        )
          owned++;
      }
    }
    expect(owned).toBe(0);
  });
});
