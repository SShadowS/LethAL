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

    // R828 O1: the block's own member copies it plain; the exit statement holds its comparison and
    // is its own component, in the block's original branch.
    expect(comps).toHaveLength(2);
    const [outer, inner] = comps;
    if (outer === undefined || inner === undefined) throw new Error("no component");
    expect(outer.root.startIndex).toBe(block.startIndex);
    expect(outer.members.map((m) => m.mutantId)).toEqual(["M0002"]);
    expect(outer.split).toBe(true);
    expect(inner.root.startIndex).toBe(firstExit.startIndex);
    expect(inner.members.map((m) => m.mutantId)).toEqual(["M0003", "M0001"]);
    expect(inner.split).toBeUndefined();
  });
});

// R828 O1: which statement becomes its own component, and what stays one flat chain.
const NEST = `codeunit 79001 "N"
{
    procedure P(C: Integer; N: Integer) var I: Integer; T: Integer;
    begin
        if C > 0 then
            for I := 1 to N do
                T += 1;
        while N > 0 do begin
            N -= 1;
            if T > 3 then
                T := 0;
        end;
        if C > 1 then begin
            T := 1;
#pragma warning disable AL0432
            T := 2;
            if T > 1 then
                T := 3;
        end;
        case C of
            1: T := 2;
            2: begin T := 3; end;
        end;
    end;
}
`;

describe("buildComponents, R828 O1", () => {
  beforeAll(async () => {
    await initParser();
  });

  const at = (root: ALSyntaxNode, kind: ALNodeKind, n: number): ALSyntaxNode => {
    const found = findAll(root, kind)[n];
    if (found === undefined) throw new Error(`fixture drift: ${kind} ${n}`);
    return found;
  };
  const entry = (id: string, before: ALSyntaxNode): { mutantId: string; spec: MutationSpec } => ({
    mutantId: id,
    spec: synth(before, "X", "op"),
  });

  it("a mutant in a loop inside a plain root joins the OUTERMOST loop within it, never the statement", () => {
    const root = wrapRoot(parseAL(NEST));
    const outerIf = at(root, ALNodeKind.if_statement, 0);
    const forLoop = at(root, ALNodeKind.for_statement, 0);
    const assign = findAll(forLoop, ALNodeKind.assignment_statement)[0];
    if (assign === undefined) throw new Error("fixture drift");
    const comps = buildComponents([entry("M0001", outerIf), entry("M0002", assign)]);
    expect(
      comps.map((c) => [c.root.rawKind, c.members.map((m) => m.mutantId), c.split === true]),
    ).toEqual([
      ["if_statement", ["M0001"], true],
      ["for_statement", ["M0002"], false],
    ]);
  });

  it("everything inside a loop with its own member stays in the loop's one chain", () => {
    const root = wrapRoot(parseAL(NEST));
    const loop = at(root, ALNodeKind.while_statement, 0);
    const innerIf = at(root, ALNodeKind.if_statement, 1);
    const comps = buildComponents([entry("M0001", loop), entry("M0002", innerIf)]);
    expect(comps).toHaveLength(1);
    expect(comps[0]?.members.map((m) => m.mutantId)).toEqual(["M0001", "M0002"]);
    expect(comps[0]?.split).toBeUndefined();
  });

  it("a root holding a directive keeps everything below it as members", () => {
    const root = wrapRoot(parseAL(NEST));
    const host = at(root, ALNodeKind.if_statement, 2);
    const nested = at(root, ALNodeKind.if_statement, 3);
    const comps = buildComponents([entry("M0001", host), entry("M0002", nested)]);
    expect(comps).toHaveLength(1);
    expect(comps[0]?.members.map((m) => m.mutantId)).toEqual(["M0001", "M0002"]);
    expect(comps[0]?.split).toBeUndefined();
  });

  it("a case arm is not a node: the case is, and an arm's block is one of ITS members", () => {
    const root = wrapRoot(parseAL(NEST));
    const caseStatement = at(root, ALNodeKind.case_statement, 0);
    const armBlock = at(root, ALNodeKind.block, 3);
    const inArm = findAll(armBlock, ALNodeKind.assignment_statement)[0];
    if (inArm === undefined) throw new Error("fixture drift");
    const comps = buildComponents([
      entry("M0001", caseStatement),
      entry("M0002", armBlock),
      entry("M0003", inArm),
    ]);
    // The arm's block resolves to the `case`: an own member, copying the case plain. A statement
    // inside the arm is the case's nested component.
    expect(
      comps.map((c) => [c.root.rawKind, c.members.map((m) => m.mutantId), c.split === true]),
    ).toEqual([
      ["case_statement", ["M0001", "M0002"], true],
      ["assignment_statement", ["M0003"], false],
    ]);
  });
});
