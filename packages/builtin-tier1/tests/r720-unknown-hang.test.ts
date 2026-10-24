import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R720 (R-327b): `resolveVarRef` answers null both for a name that is provably undeclared and for
 * one the engine refuses to resolve ("unknown": a swallowed `#if` member, a global declared in a
 * var-section `#if`, an every-arm-ambiguous name). R196's hang check declined on both. It now
 * matches by NAME when the three-state lookup says "unknown". It only adds refusals.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  declarationStateAt,
  evaluateArms,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { classifyHangCapable } from "../src/loop-hazard";
import { removeAssignment } from "../src/remove-assignment";
import { shiftInteger } from "../src/shift-integer";

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  const arms = new Map([[root, evaluateArms(root, src, [])]]);
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }], arms) };
}

function nodeAt(root: ALSyntaxNode, kind: string, text: string, within?: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode, inside: boolean): void => {
    const now = inside || within === undefined || n.text === within;
    if (now && n.rawKind === kind && n.text === text) out.push(n);
    for (const c of n.children) walk(c, now);
  };
  walk(root, false);
  const first = out[0];
  if (first === undefined) throw new Error(`no ${kind} "${text}"`);
  return first;
}
const assignment = (root: ALSyntaxNode, text: string) =>
  nodeAt(root, ALNodeKind.assignment_statement, text);

/** x1's shape: a swallowed `Spin` and its direct twin with the same body. */
const SWALLOWED = `codeunit 79600 "R402 Shape"
{
    var
        G: Integer;
        K: Integer;
        R: Record Customer;

#if not LETHALX
    procedure Spin(): Integer
    var
        J: Integer;
    begin
        J := 0;
        while J < 5 do
            J += 1;
        while G < 5 do
            G += 1;
        while J < 5 do
            K += 1;
        while R.Amount < 5 do
            R.Amount := R.Amount + 1;
        exit(J);
    end;
#endif

    procedure SpinDirect(): Integer
    var
        J: Integer;
    begin
        J := 0;
        while J < 5 do
            J += 1;
        while G < 5 do
            G += 1;
        exit(J);
    end;
}
`;

/** The swallowed member's text, so a lookup can be scoped to it. */
function inProc(root: ALSyntaxNode, header: string, text: string): ALSyntaxNode {
  const walk = (n: ALSyntaxNode): ALSyntaxNode | null => {
    if (n.rawKind === "procedure" && n.text.startsWith(header)) return n;
    for (const c of n.children) {
      const f = walk(c);
      if (f !== null) return f;
    }
    return null;
  };
  const proc = walk(root);
  if (proc === null) throw new Error(`no ${header}`);
  return nodeAt(proc, ALNodeKind.assignment_statement, text);
}
const inSpin = (root: ALSyntaxNode, text: string) => inProc(root, "procedure Spin()", text);
function findIn(scope: ALSyntaxNode, kind: string, text: string, within?: string): ALSyntaxNode {
  return nodeAt(scope, kind, text, within);
}

describe("R720: a swallowed member (x1)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("premise: the write sits under preproc_conditional_var and its names are 'unknown'", () => {
    const { root, ctx } = load(SWALLOWED);
    const w = inSpin(root, "J += 1");
    let swallowed = false;
    for (let p: ALSyntaxNode | null = w; p !== null; p = p.parent)
      if (p.rawKind === "preproc_conditional_var") swallowed = true;
    expect(swallowed).toBe(true);
    const j = w.childForFieldName("left") ?? w.children[0];
    if (j === undefined) throw new Error("no target");
    expect(declarationStateAt(j, ctx)).toBe("unknown");
  });

  it("refuses the local and the global write inside the swallowed member", () => {
    const { root, ctx } = load(SWALLOWED);
    expect(classifyHangCapable(inSpin(root, "J += 1"), ctx)).toBe("loop-condition-target");
    expect(classifyHangCapable(inSpin(root, "G += 1"), ctx)).toBe("loop-condition-target");
  });

  it("emits no remove-assignment or shift-integer spec on those writes", () => {
    const { root, ctx } = load(SWALLOWED);
    for (const text of ["J += 1", "G += 1"]) {
      const a = inSpin(root, text);
      expect(removeAssignment.targets(a, ctx)).toBe(false);
      expect(removeAssignment.generate(a, ctx)).toEqual([]);
      const one = findIn(a, "integer", "1");
      expect(shiftInteger.targets(one, ctx)).toBe(false);
      expect(shiftInteger.generate(one, ctx)).toEqual([]);
    }
  });

  it("member target: `while R.Amount < 5 do R.Amount := ...` is refused", () => {
    const { root, ctx } = load(SWALLOWED);
    expect(classifyHangCapable(inSpin(root, "R.Amount := R.Amount + 1"), ctx)).toBe(
      "loop-condition-target",
    );
  });

  it("control: a write to a name the loop does not read is not refused", () => {
    const { root, ctx } = load(SWALLOWED);
    expect(classifyHangCapable(inSpin(root, "K += 1"), ctx)).toBeNull();
  });

  it("control: the direct twin SpinDirect keeps its refusal", () => {
    const { root, ctx } = load(SWALLOWED);
    for (const t of ["J += 1", "G += 1"])
      expect(classifyHangCapable(inProc(root, "procedure SpinDirect()", t), ctx)).toBe(
        "loop-condition-target",
      );
  });
});

describe("R720: a global declared inside a var-section #if (x6)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const SRC = `codeunit 79600 "R402 Shape"
{
    var
        Total: Integer;
#if not LETHALX
        Extra: Integer;
#else
        Extra: Decimal;
#endif

    procedure Q(): Integer
    begin
        Extra := 0;
        while Extra < 5 do
            Extra := Extra + 1;
        exit(Total);
    end;
}
`;

  it("refuses the write in a DIRECT procedure", () => {
    const { root, ctx } = load(SRC);
    expect(classifyHangCapable(assignment(root, "Extra := Extra + 1"), ctx)).toBe(
      "loop-condition-target",
    );
  });
});

describe("R720: an every-arm-ambiguous local", () => {
  beforeAll(async () => {
    await initParser();
  });

  const SRC = `codeunit 50100 "Repro S"
{
    procedure P()
    var
        Kept: Integer;
#if not CLEAN27
        Amt: Integer;
#endif
    begin
        while Amt < 5 do
            Amt += 1;
        while Kept < 5 do
            Kept += 1;
    end;
}
`;

  it("refuses the ambiguous name's write; a plain local keeps its (declared) refusal", () => {
    const { root, ctx } = load(SRC);
    expect(classifyHangCapable(assignment(root, "Amt += 1"), ctx)).toBe("loop-condition-target");
    expect(classifyHangCapable(assignment(root, "Kept += 1"), ctx)).toBe("loop-condition-target");
  });
});

describe("R720: a provably undeclared name keeps today's answer", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Ghost in an indexed member is 'null' and still not refused", () => {
    const { root, ctx } = load(
      `codeunit 50371 "R" { procedure P() begin while Ghost < 3 do Ghost := 0; end; }`,
    );
    const a = assignment(root, "Ghost := 0");
    const target = a.childForFieldName("left") ?? a.children[0];
    if (target === undefined) throw new Error("no target");
    expect(declarationStateAt(target, ctx)).toBeNull();
    expect(classifyHangCapable(a, ctx)).toBeNull();
  });
});
