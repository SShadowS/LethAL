import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findAll, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { buildComponents } from "../src/components";

const SRC = `codeunit 79000 "T"
{
    procedure IsOver(A: Integer; B: Integer): Boolean
    begin
        exit(A > B);
    end;

    procedure Other(V: Integer): Integer
    begin
        exit(V);
    end;
}
`;

function synth(before: ALSyntaxNode, afterText: string, op: string): MutationSpec {
  return {
    operatorName: op,
    operatorVersion: "1.0.0",
    astNodeId: `${before.startIndex}-${before.endIndex}`,
    before,
    after: { ...before, text: afterText } as never,
    parentContext: "statement-position",
  } as MutationSpec;
}

describe("buildComponents", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("groups nested sites into ONE component rooted at the outermost statement", () => {
    const root = wrapRoot(parseAL(SRC));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    const exits = findAll(root, ALNodeKind.exit_statement);
    const firstExit = exits[0];
    if (cmp === undefined || firstExit === undefined) throw new Error("fixture drift");

    const comps = buildComponents([
      { mutantId: "M0001", spec: synth(cmp as never, "A >= B", "boundary") },
      { mutantId: "M0002", spec: synth(firstExit as never, "exit(false);", "return-value") },
    ]);

    expect(comps).toHaveLength(1);
    const c = comps[0];
    if (c === undefined) throw new Error("no component");
    expect(c.root.startIndex).toBe(firstExit.startIndex);
    expect(c.members.map((m) => m.mutantId)).toEqual(["M0002", "M0001"]); // outermost first
  });

  it("keeps disjoint sites in separate components", () => {
    const root = wrapRoot(parseAL(SRC));
    const exits = findAll(root, ALNodeKind.exit_statement);
    const a = exits[0];
    const b = exits[1];
    if (a === undefined || b === undefined) throw new Error("fixture drift");

    const comps = buildComponents([
      { mutantId: "M0001", spec: synth(a as never, "exit(false);", "return-value") },
      { mutantId: "M0002", spec: synth(b as never, "exit(0);", "return-value") },
    ]);
    expect(comps).toHaveLength(2);
  });

  it("is deterministic — same components and member order regardless of input order", () => {
    const root = wrapRoot(parseAL(SRC));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    const firstExit = findAll(root, ALNodeKind.exit_statement)[0];
    if (cmp === undefined || firstExit === undefined) throw new Error("fixture drift");

    const cmpEntry = { mutantId: "M0001", spec: synth(cmp as never, "A >= B", "boundary") };
    const exitEntry = {
      mutantId: "M0002",
      spec: synth(firstExit as never, "exit(false);", "return-value"),
    };

    const shape = (
      comps: readonly { root: { startIndex: number }; members: readonly { mutantId: string }[] }[],
    ) => comps.map((c) => ({ root: c.root.startIndex, members: c.members.map((m) => m.mutantId) }));

    // Same two specs, fed in both orders — the sort must impose a total order,
    // not just preserve whatever order they were handed in.
    const forward = shape(buildComponents([cmpEntry, exitEntry]));
    const reversed = shape(buildComponents([exitEntry, cmpEntry]));

    expect(reversed).toEqual(forward);
    expect(forward).toEqual([{ root: firstExit.startIndex, members: ["M0002", "M0001"] }]);
  });

  it("groups a 3-level containment chain (block ⊃ exit_statement ⊃ comparison) into ONE component, outermost first", () => {
    const root = wrapRoot(parseAL(SRC));
    const block = findAll(root, ALNodeKind.block)[0];
    const firstExit = findAll(root, ALNodeKind.exit_statement)[0];
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    if (block === undefined || firstExit === undefined || cmp === undefined) {
      throw new Error("fixture drift");
    }

    const comps = buildComponents([
      { mutantId: "M0001", spec: synth(cmp as never, "A >= B", "boundary") },
      {
        mutantId: "M0002",
        spec: synth(block as never, "begin\n        exit(true);\n    end;", "block-replace"),
      },
      { mutantId: "M0003", spec: synth(firstExit as never, "exit(false);", "return-value") },
    ]);

    expect(comps).toHaveLength(1);
    const c = comps[0];
    if (c === undefined) throw new Error("no component");
    expect(c.root.startIndex).toBe(block.startIndex);
    // outermost first: block, then exit_statement, then the innermost comparison
    expect(c.members.map((m) => m.mutantId)).toEqual(["M0002", "M0003", "M0001"]);
  });
});
