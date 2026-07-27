import { describe, expect, it } from "bun:test";
import type { MutationSpec } from "@lethal/engine";
import { assignMutantIds } from "../src/ids";

function spec(startIndex: number, operatorName = "op.test"): MutationSpec {
  return {
    operatorName,
    operatorVersion: "1.0.0",
    astNodeId: `${startIndex}`,
    before: { startIndex, endIndex: startIndex + 1, text: "x" } as never,
    after: { text: "y" } as never,
    parentContext: "statement-position",
  };
}

describe("assignMutantIds", () => {
  it("assigns zero-padded ids in deterministic order", () => {
    const ided = assignMutantIds(new Map([["file1.al", [spec(100), spec(10), spec(50)]]]));
    const flat = [...ided.values()].flat();
    expect(flat.map((s) => s.mutantId)).toEqual(["M0001", "M0002", "M0003"]);
    expect(flat.map((s) => s.spec.before.startIndex)).toEqual([10, 50, 100]);
  });

  it("orders across files by path", () => {
    const ided = assignMutantIds(
      new Map([
        ["b.al", [spec(10)]],
        ["a.al", [spec(10)]],
      ]),
    );
    const entries = [...ided.entries()];
    expect(entries[0]?.[0]).toBe("a.al");
    expect(entries[0]?.[1][0]?.mutantId).toBe("M0001");
    expect(entries[1]?.[0]).toBe("b.al");
    expect(entries[1]?.[1][0]?.mutantId).toBe("M0002");
  });

  it("orders specs at same startIndex by operator name", () => {
    const ided = assignMutantIds(new Map([["f.al", [spec(10, "op.z"), spec(10, "op.a")]]]));
    const flat = [...ided.values()].flat();
    expect(flat.map((s) => s.spec.operatorName)).toEqual(["op.a", "op.z"]);
  });
});
