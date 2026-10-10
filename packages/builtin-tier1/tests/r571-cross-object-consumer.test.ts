import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";
import { r531Analyze, r571Seam, r571TempSkip } from "../src/loop-hazard";

/**
 * R571: R531's HOP into a record consumer in ANOTHER project object, and its caller-side temp-flag
 * skip. Each case reads one site twice: with `r571Seam` off (master's behaviour) and on.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";
const REMOVE_NOT = "lethal.remove-not";
const NEG = "lethal.negate-conditional";

type Files = Record<string, string>;

function contextOf(files: Files) {
  const parsed = Object.entries(files).map(([p, src]) => ({
    path: p,
    root: wrapRoot(parseAL(src)),
  }));
  return { parsed, ctx: buildSemanticContext(parsed) };
}

function refusedIn(files: Files, path: string, text: string, op = VMC): boolean {
  const { parsed, ctx } = contextOf(files);
  const f = parsed.find((p) => p.path === path);
  if (f === undefined) throw new Error(`no file ${path}`);
  let hit: ALSyntaxNode | null = null;
  visit(f.root, (n: ALSyntaxNode) => {
    if (hit === null && n.text === text) hit = n;
  });
  if (hit === null) throw new Error(`${text} not found`);
  return openItemHangRefuses(hit, ctx, op);
}

/** [seam off, seam on] */
function bothWays(files: Files, path: string, text: string, op = VMC): [boolean, boolean] {
  r571Seam.on = false;
  try {
    const off = refusedIn(files, path, text, op);
    r571Seam.on = true;
    return [off, refusedIn(files, path, text, op)];
  } finally {
    r571Seam.on = true;
  }
}

/** A site with the temp-flag skip switched off (the seam on). */
function refusedNoSkip(files: Files, path: string, text: string): boolean {
  r571TempSkip.on = false;
  try {
    return refusedIn(files, path, text);
  } finally {
    r571TempSkip.on = true;
  }
}

const BUF = `table 50102 Buf
{
    fields { field(1; Value; Code[20]) { } }
}`;
const TBUF = `table 50105 TBuf
{
    TableType = Temporary;
    fields { field(1; Value; Code[20]) { } }
}`;

const SOCKET = (pop: string, extra = "") => `codeunit 50100 Socket
{
    SingleInstance = true;
    var
        Buf: Record "Buf" temporary;

    procedure Pop() Msg: Code[20]
${pop}

    procedure IsEmpty(): Boolean
    begin
        exit(Buf.IsEmpty());
    end;
${extra}
}`;
const POP = `    begin
        if not Buf.FindLast() then
            exit;
        Msg := Buf.Value;
        Buf.Delete();
        exit(Msg);
    end;`;
const CARD = (cu = "Socket") => `page 50101 Card
{
    var
        Sock: Codeunit ${cu};
        Last: Code[20];

    trigger OnAfterGetRecord()
    begin
        while not Sock.IsEmpty() do begin
            Last := Sock.Pop();
            Message(Last);
        end;
    end;
}`;

const PASS = `codeunit 50103 Caller
{
    procedure Drain()
    var
        R: Record Buf;
        Eater: Codeunit Eater;
    begin
        while R.FindFirst() do
            Eater.Eat(R);
    end;
}`;
const EATER = (param: string, body: string) => `codeunit 50104 Eater
{
    procedure Eat(${param})
    begin
        ${body}
    end;
}`;

/** A loop over R whose body passes alias A (made as `aliasing` says) into another codeunit. */
const ALIAS = (
  rDecl: string,
  aDecl: string,
  aliasing = "A := R;",
  params = "",
) => `codeunit 50103 Caller
{
    procedure Drain(${params})
    var
        R: ${rDecl};
${aDecl === "" ? "" : `        A: ${aDecl};\n`}        Eater: Codeunit Eater;
    begin
        while R.FindFirst() do begin
            ${aliasing}
            Eater.Eat(A);
        end;
    end;
}`;
const EAT_DELETE = EATER("var X: Record Buf", "X.Delete();");

describe("R571: a consumer in another object", () => {
  it("T1: refuses the delete in the socket's Pop", () => {
    const files = { "s.al": SOCKET(POP), "c.al": CARD(), "b.al": BUF };
    expect(bothWays(files, "s.al", "Buf.Delete()")).toEqual([false, true]);
  });

  it("T2: refuses an early exit before the last consumer, and its guard", () => {
    const files = { "s.al": SOCKET(POP), "c.al": CARD(), "b.al": BUF };
    expect(bothWays(files, "s.al", "not Buf.FindLast()", REMOVE_NOT)).toEqual([false, true]);
    expect(bothWays(files, "s.al", "exit", VMC)).toEqual([false, true]);
  });

  it("T3: follows R passed by var into another codeunit that Modifies it", () => {
    const files = {
      "c.al": PASS,
      "e.al": EATER("var X: Record Buf", "X.Value := 'A';\n        X.Modify();"),
      "b.al": BUF,
    };
    expect(bothWays(files, "e.al", "X.Modify()")).toEqual([false, true]);
  });

  it("T4: by value, a Modify reaches the table; CalcFields and SetRange do not", () => {
    const mod = {
      "c.al": PASS,
      "e.al": EATER("X: Record Buf", "X.Value := 'A';\n        X.Modify();"),
      "b.al": BUF,
    };
    expect(bothWays(mod, "e.al", "X.Modify()")).toEqual([false, true]);
    const calc = {
      "c.al": PASS,
      "e.al": EATER("X: Record Buf", "X.CalcFields(Value);"),
      "b.al": BUF,
    };
    expect(bothWays(calc, "e.al", "X.CalcFields(Value)")).toEqual([false, false]);
    const flt = {
      "c.al": PASS,
      "e.al": EATER("X: Record Buf", "X.SetRange(Value, 'A');"),
      "b.al": BUF,
    };
    expect(bothWays(flt, "e.al", "X.SetRange(Value, 'A')")).toEqual([false, false]);
  });

  it("T5: a var parameter named Rec is keyed like Rec.M()", () => {
    const files = {
      "c.al": PASS,
      "e.al": EATER("var Rec: Record Buf", "Rec.Delete();"),
      "b.al": BUF,
    };
    expect(bothWays(files, "e.al", "Rec.Delete()")).toEqual([false, true]);
  });

  it("T6: temp-flag skip, both directions (known flags that differ)", () => {
    const tempR = {
      "c.al": ALIAS("Record Buf temporary", "Record Buf"),
      "e.al": EAT_DELETE,
      "b.al": BUF,
    };
    expect(bothWays(tempR, "e.al", "X.Delete()")).toEqual([false, false]);
    expect(refusedNoSkip(tempR, "e.al", "X.Delete()")).toBe(true);
    const realR = {
      "c.al": ALIAS("Record Buf", "Record Buf temporary"),
      "e.al": EAT_DELETE,
      "b.al": BUF,
    };
    expect(bothWays(realR, "e.al", "X.Delete()")).toEqual([false, false]);
    expect(refusedNoSkip(realR, "e.al", "X.Delete()")).toBe(true);
  });

  it("T7: an unknown flag stays refused (table outside the project; TableType = Temporary)", () => {
    const outside = {
      "c.al": ALIAS("Record Buf temporary", 'Record "Outside Table"'),
      "e.al": EAT_DELETE,
      "b.al": BUF,
    };
    expect(bothWays(outside, "e.al", "X.Delete()")).toEqual([false, true]);
    const tempType = {
      "c.al": ALIAS("Record TBuf temporary", "Record TBuf"),
      "e.al": EATER("var X: Record TBuf", "X.Delete();"),
      "b.al": TBUF,
    };
    expect(bothWays(tempType, "e.al", "X.Delete()")).toEqual([false, true]);
  });

  it("T8: a callee local that shadows the global is not R", () => {
    const pop = `    var
        Buf: Record Buf;
    begin
        Buf.Delete();
    end;`;
    const files = { "s.al": SOCKET(pop), "c.al": CARD(), "b.al": BUF };
    expect(bothWays(files, "s.al", "Buf.Delete()")).toEqual([false, false]);
  });

  it("T9: a codeunit outside the project gives no hop (control)", () => {
    const files = { "c.al": CARD("Outside"), "b.al": BUF };
    const { parsed, ctx } = contextOf(files);
    let hops = 0;
    let loops = 0;
    for (const f of parsed)
      visit(f.root, (n: ALSyntaxNode) => {
        const a = r531Analyze(n, ctx);
        if (a !== null) {
          loops++;
          hops += a.hops.length;
        }
      });
    expect(loops).toBe(1);
    expect(hops).toBe(0);
  });

  it("T10: a temporary global under a codeunit R stays refused", () => {
    const files = { "s.al": SOCKET(POP), "c.al": CARD(), "b.al": BUF };
    expect(refusedIn(files, "s.al", "Buf.Delete()")).toBe(true);
  });

  it("T11: a Copy(R, true) alias passed to the callee stays refused", () => {
    const files = {
      "c.al": ALIAS("Record Buf temporary", "Record Buf", "A.Copy(R, true);"),
      "e.al": EAT_DELETE,
      "b.al": BUF,
    };
    expect(bothWays(files, "e.al", "X.Delete()")).toEqual([false, true]);
  });

  it("T12: a no-keyword var parameter alias stays refused", () => {
    const files = {
      "c.al": ALIAS("Record Buf temporary", "", "A := R;", "var A: Record Buf"),
      "e.al": EAT_DELETE,
      "b.al": BUF,
    };
    expect(bothWays(files, "e.al", "X.Delete()")).toEqual([false, true]);
  });

  it("T13: assignment aliases with known, different flags are skipped (two aliases)", () => {
    const caller = `codeunit 50103 Caller
{
    procedure Update()
    var
        TempE: Record Buf temporary;
        E: Record Buf;
        S: Record Buf;
        Mgr: Codeunit Mgr;
    begin
        while TempE.FindFirst() do begin
            E := TempE;
            TempE := S;
            Mgr.Match(E, S);
        end;
    end;
}`;
    const mgr = `codeunit 50106 Mgr
{
    procedure Match(var P: Record Buf; var Q: Record Buf)
    begin
        P.Delete();
        Q.Delete();
    end;
}`;
    const files = { "c.al": caller, "m.al": mgr, "b.al": BUF };
    expect(bothWays(files, "m.al", "P.Delete()")).toEqual([false, false]);
    expect(bothWays(files, "m.al", "Q.Delete()")).toEqual([false, false]);
    expect(refusedNoSkip(files, "m.al", "P.Delete()")).toBe(true);
  });

  it("T14: a callee's call to a same-object helper that sees the global is refused, with its guard", () => {
    const pop = `    begin
        if Buf.FindLast() then
            RemoveTop();
    end;`;
    const helper = `
    local procedure RemoveTop()
    begin
        Buf.Delete();
    end;`;
    const files = { "s.al": SOCKET(pop, helper), "c.al": CARD(), "b.al": BUF };
    expect(bothWays(files, "s.al", "RemoveTop()")).toEqual([false, true]);
    expect(bothWays(files, "s.al", "Buf.FindLast()", NEG)).toEqual([false, true]);
  });

  it("T15: an exit inside a callee loop after a guarded consumer is refused", () => {
    const pop = `    var
        I: Integer;
    begin
        for I := 1 to 3 do begin
            if Buf.FindLast() then
                Buf.Delete();
            if Buf.IsEmpty() then
                exit;
        end;
    end;`;
    const files = { "s.al": SOCKET(pop), "c.al": CARD(), "b.al": BUF };
    expect(bothWays(files, "s.al", "Buf.IsEmpty()", NEG)).toEqual([false, true]);
    expect(bothWays(files, "s.al", "exit")).toEqual([false, true]);
  });

  it("T16: the assignment feeding an early-exit guard is refused", () => {
    const pop = `    var
        Found: Boolean;
    begin
        Found := Buf.FindLast();
        if not Found then
            exit;
        Buf.Delete();
    end;`;
    const files = { "s.al": SOCKET(pop), "c.al": CARD(), "b.al": BUF };
    expect(bothWays(files, "s.al", "Found := Buf.FindLast()", "lethal.remove-assignment")).toEqual([
      false,
      true,
    ]);
  });

  it("T17: a break that leaves the callee's consumer loop is refused, with its guard", () => {
    const pop = `    begin
        if Buf.FindSet() then
            repeat
                if Buf.Blocked then
                    break;
                Buf.Delete();
            until Buf.Next() = 0;
    end;`;
    const files = { "s.al": SOCKET(pop), "c.al": CARD(), "b.al": BUF };
    expect(bothWays(files, "s.al", "Buf.Blocked", NEG)).toEqual([false, true]);
  });
});
