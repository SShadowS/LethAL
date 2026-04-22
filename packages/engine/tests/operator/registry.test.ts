import { describe, it, expect } from "bun:test";
import { createRegistry } from "../../src/operator/registry";
import type { MutationOperator } from "../../src/operator/interface";

function op(overrides: Partial<MutationOperator> = {}): MutationOperator {
  return {
    name: "test.op",
    version: "1.0.0",
    tier: "custom",
    targetNodeKinds: ["comparison_expression"],
    producesNodeKinds: ["comparison_expression"],
    requiresSemantic: [],
    targets: () => false,
    generate: () => [],
    conformanceTests: [],
    ...overrides,
  };
}

describe("registry", () => {
  it("registers a well-formed operator", () => {
    const reg = createRegistry();
    reg.register(op());
    expect(reg.list().map((o) => o.name)).toEqual(["test.op"]);
  });

  it("rejects a duplicate name+version", () => {
    const reg = createRegistry();
    reg.register(op());
    expect(() => reg.register(op())).toThrow(/already registered/);
  });

  it("accepts two versions of the same operator name", () => {
    const reg = createRegistry();
    reg.register(op({ version: "1.0.0" }));
    reg.register(op({ version: "2.0.0" }));
    expect(reg.list().length).toBe(2);
  });

  it("rejects a manifest with unknown ALNodeKind", () => {
    const reg = createRegistry();
    expect(() =>
      reg.register(
        op({ targetNodeKinds: ["not_a_real_kind" as never] }),
      ),
    ).toThrow(/unknown ALNodeKind/);
  });

  it("rejects non-semver version", () => {
    const reg = createRegistry();
    expect(() => reg.register(op({ version: "latest" }))).toThrow(/semver/);
  });
});
