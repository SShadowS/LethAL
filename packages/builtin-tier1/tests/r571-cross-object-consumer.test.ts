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
import { r571Seam } from "../src/loop-hazard";

/** R571 (prototype): R531's HOP into a consumer that lives in ANOTHER project object. */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";

function refusedIn(files: Record<string, string>, path: string, text: string): boolean {
  const parsed = Object.entries(files).map(([p, src]) => ({ path: p, root: wrapRoot(parseAL(src)) }));
  const ctx = buildSemanticContext(parsed);
  const f = parsed.find((p) => p.path === path);
  if (f === undefined) throw new Error(`no file ${path}`);
  let hit: ALSyntaxNode | null = null;
  visit(f.root, (n: ALSyntaxNode) => {
    if (hit === null && n.text === text) hit = n;
  });
  if (hit === null) throw new Error(`${text} not found`);
  return openItemHangRefuses(hit, ctx, VMC);
}

const SOCKET = `codeunit 50100 Socket
{
    SingleInstance = true;
    var
        Buf: Record "Buf" temporary;

    procedure Pop() Msg: Code[20]
    begin
        if not Buf.FindLast() then
            exit;
        Msg := Buf.Value;
        Buf.Delete();
        exit(Msg);
    end;

    procedure IsEmpty(): Boolean
    begin
        exit(Buf.IsEmpty());
    end;
}`;
const CARD = `page 50101 Card
{
    var
        Sock: Codeunit Socket;
        Last: Code[20];

    trigger OnAfterGetRecord()
    begin
        while not Sock.IsEmpty() do begin
            Last := Sock.Pop();
            Message(Last);
        end;
    end;
}`;
const BUF = `table 50102 Buf
{
    fields { field(1; Value; Code[20]) { } }
}`;

const PASS = (vr: string) => `codeunit 50103 Caller
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
const EATER = (vr: string, body: string) => `codeunit 50104 Eater
{
    procedure Eat(${vr}X: Record Buf)
    begin
        ${body}
    end;
}`;

describe("R571: a consumer in another object", () => {
  it("refuses the delete in the socket's Pop and the guard before it", () => {
    const files = { "s.al": SOCKET, "c.al": CARD, "b.al": BUF };
    expect(refusedIn(files, "s.al", "Buf.Delete()")).toBe(true);
    expect(refusedIn(files, "s.al", "Buf.FindLast()")).toBe(true);
    r571Seam.on = false;
    try {
      expect(refusedIn(files, "s.al", "Buf.Delete()")).toBe(false);
    } finally {
      r571Seam.on = true;
    }
  });
  it("follows R passed by var into another codeunit", () => {
    const files = { "c.al": PASS(""), "e.al": EATER("var ", "X.Delete();"), "b.al": BUF };
    expect(refusedIn(files, "e.al", "X.Delete()")).toBe(true);
  });
  it("by value: a Delete reaches the table, a SetRange does not", () => {
    const del = { "c.al": PASS(""), "e.al": EATER("", "X.Delete();"), "b.al": BUF };
    expect(refusedIn(del, "e.al", "X.Delete()")).toBe(true);
    const flt = { "c.al": PASS(""), "e.al": EATER("", "X.SetRange(Value, 'A');"), "b.al": BUF };
    expect(refusedIn(flt, "e.al", "X.SetRange(Value, 'A')")).toBe(false);
  });
});
