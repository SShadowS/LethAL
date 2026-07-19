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

  it("is deterministic — same input, same components and order", () => {
    const root = wrapRoot(parseAL(SRC));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    const firstExit = findAll(root, ALNodeKind.exit_statement)[0];
    if (cmp === undefined || firstExit === undefined) throw new Error("fixture drift");
    const input = [
      { mutantId: "M0001", spec: synth(cmp as never, "A >= B", "boundary") },
      { mutantId: "M0002", spec: synth(firstExit as never, "exit(false);", "return-value") },
    ];
    const a = buildComponents(input).map((c) => c.members.map((m) => m.mutantId));
    const b = buildComponents(input).map((c) => c.members.map((m) => m.mutantId));
    expect(a).toEqual(b);
  });
});
