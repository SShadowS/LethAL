import { heapStats } from "bun:jsc";
import { beforeAll, describe, expect, test } from "bun:test";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { generateMutationSet } from "../src/orchestrator";

/**
 * RUST-03 S4.2c (AMENDMENT 1's lead A): a spec's `after` node must not pin copied `children` /
 * `namedChildren` arrays (each read builds fresh wrappers on the native tree), position objects or a
 * bound `childForFieldName` closure. It keeps one wrapper per spec site: `before`.
 *
 * Counted on a synthetic project through the product's own spec generation, so both tiers'
 * `synthesizeAfter` are covered.
 *
 * PR-445 (R1222): this file timed out at VERIFY's 5 s under ordinary load. Measured: the FIRST generation in a process is
 * cold (parser, operators, caches: 4.3 s for 60 files and 11.5 s for 300 under load, against ~2 s warm), it ran twice
 * at 300 files, and its one-time allocations (~345 functions, whatever the size) also land in the measured delta.
 * Now a one-file warm-up generation runs first, in its own hook (setup, not the guarded claim), then ONE measured
 * generation of 20 files serves both tests. The signal is per spec: red-checked with the unfixed `synthesizeAfter`
 * (copied arrays and a bound closure) at this size, in both tiers and in tier 2 alone.
 * Each file varies two literals (`exit(k+1)`, `X - (k+2)`), so a cache keyed by mutated text cannot be pre-filled by the
 * warm-up (review finding 3).
 */
const FILES = 20;
const WARM_UP_TIMEOUT_MS = 60_000;
/** The measured generation and its two full GCs: setup, not the claim, so a load spike cannot time it out (PR-445). */
const MEASURE_TIMEOUT_MS = ownTimeout(30_000);
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
            exit(${k + 1});
        if (A <> B) and (C = '') then
            X := X - ${k + 2};
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

// The one-time cost and allocations of a process's first generation, outside the measured window. File level, so it
// runs before the describe's hook; its own timeout, as it is setup and the cold first run is the slow part (PR-445).
beforeAll(async () => {
  const warm = new Map<string, Buffer>([["src/W.Codeunit.al", Buffer.from(unit(FILES))]]);
  await generateMutationSet("synthetic", { source: warm, emit: () => {} });
}, WARM_UP_TIMEOUT_MS);

describe("RUST-03 S4.2c: the spec's after node pins no copies", () => {
  let base: Record<string, number> = {};
  let after: Record<string, number> = {};
  let set: Awaited<ReturnType<typeof generateMutationSet>> | undefined;

  beforeAll(async () => {
    // Counted after the warm-up (whose specs are unreferenced, so collected) and before the measured generation.
    base = counts();
    set = await generateMutationSet("synthetic", { source: snapshot(), emit: () => {} });
    after = counts();
  }, MEASURE_TIMEOUT_MS);

  const specsOf = () => {
    if (set === undefined) throw new Error("the mutation set was not generated");
    return set.files.flatMap((f) => f.specs);
  };

  test("retained arrays and functions per spec, measured on the heap", () => {
    const specs = specsOf().length;
    const per = (k: string) => ((after[k] ?? 0) - (base[k] ?? 0)) / specs;
    // Measured at this size (PR-445; 540 specs, 60 of them tier 2): fixed ~0.00 functions per spec; arrays ~0.1 in a
    // plain process but ~0.5 under `bun test`, whose own arrays land between the hooks. Unfixed in both tiers: ~0.93
    // functions per spec. Unfixed in tier 2 alone: ~0.11 functions per spec, so the FUNCTION bound (0.05) is the one that
    // catches a one-tier regression; the array bound keeps its original 1 (the runner's noise).
    expect(per("Function")).toBeLessThan(0.05);
    expect(per("Array")).toBeLessThan(1);
    expect(set?.files.length).toBe(FILES);
  });

  test("no after node owns an array, a function or a position object", () => {
    const specs = specsOf();
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
