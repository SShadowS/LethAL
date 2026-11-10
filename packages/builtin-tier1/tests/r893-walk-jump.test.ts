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
import { r893Seam } from "../src/loop-hazard";

/**
 * R893: swap-find-direction on a cursor jump of the WALKED record inside its own `Next()` walk is
 * hang-refused. Invented AL only.
 */

beforeAll(async () => {
  await initParser();
});

const SFD = "lethal.swap-find-direction";

function refused(src: string, text: string, op = SFD): boolean {
  const parsed = [{ path: "a.al", root: wrapRoot(parseAL(src)) }];
  const ctx = buildSemanticContext(parsed);
  let hit: ALSyntaxNode | null = null;
  visit(parsed[0]?.root as ALSyntaxNode, (n: ALSyntaxNode) => {
    if (hit === null && n.text === text) hit = n;
  });
  if (hit === null) throw new Error(`not found: ${text}`);
  return openItemHangRefuses(hit, ctx, op);
}

const TABLE = `table 50300 "R893 Entry"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; "Customer No."; Code[20]) { }
    }
    keys { key(PK; "Entry No.") { Clustered = true; } }
}
`;

const proc = (vars: string, body: string): string => `${TABLE}
codeunit 50301 "R893 Walk"
{
    procedure Run(Skip: Boolean)
    var
        R: Record "R893 Entry";
        Other: Record "R893 Entry";
${vars}
    begin
${body}
    end;
}`;

const SKIP = (call: string) => `        if Skip then begin
            R.SetRange("Customer No.", R."Customer No.");
            ${call};
            R.SetRange("Customer No.");
        end;`;

const REPEAT = (inner: string) => `        if R.FindSet() then
            repeat
${inner}
            until R.Next() = 0;`;

describe("R893 refused", () => {
  it("FindLast in a repeat walk", () => {
    expect(refused(proc("", REPEAT(SKIP("R.FindLast()"))), "R.FindLast()")).toBe(true);
  });
  it("FindFirst in the same position", () => {
    expect(refused(proc("", REPEAT(SKIP("R.FindFirst()"))), "R.FindFirst()")).toBe(true);
  });
  it("Find('+') and until Next() <= 0", () => {
    const body = `        if R.FindSet() then
            repeat
${SKIP("R.Find('+')")}
            until R.Next() <= 0;`;
    expect(refused(proc("", body), "R.Find('+')")).toBe(true);
  });
  it("nested two ifs deep", () => {
    const inner = `                if Skip then
                    if R."Entry No." > 3 then
                        R.FindLast();`;
    expect(refused(proc("", REPEAT(inner)), "R.FindLast()")).toBe(true);
  });
  it("while R.Next() <> 0 do", () => {
    const body = `        while R.Next() <> 0 do begin
            R.FindLast();
        end;`;
    expect(refused(proc("", body), "R.FindLast()")).toBe(true);
  });
  it("jump on R inside an inner loop over another record", () => {
    const inner = `                if Other.FindSet() then
                    repeat
                        R.FindLast();
                    until Other.Next() = 0;`;
    expect(refused(proc("", REPEAT(inner)), "R.FindLast()")).toBe(true);
  });
});

describe("R893 stays admitted", () => {
  it("another record variable", () => {
    expect(refused(proc("", REPEAT(SKIP("Other.FindLast()"))), "Other.FindLast()")).toBe(false);
  });
  it("before the loop", () => {
    const body = `        R.FindLast();\n${REPEAT("                Skip := true;")}`;
    expect(refused(proc("", body), "R.FindLast()")).toBe(false);
  });
  it("after the loop", () => {
    const body = `${REPEAT("                Skip := true;")}\n        R.FindLast();`;
    expect(refused(proc("", body), "R.FindLast()")).toBe(false);
  });
  it("inside an inner loop over a different record, on a third record", () => {
    const inner = `                if Other.FindSet() then
                    repeat
                        Third.FindLast();
                    until Other.Next() = 0;`;
    const vars = `        Third: Record "R893 Entry";`;
    expect(refused(proc(vars, REPEAT(inner)), "Third.FindLast()")).toBe(false);
  });
  it("a for loop (no Next walk)", () => {
    const body = `        for I := 1 to 3 do
            R.FindLast();`;
    expect(refused(proc("        I: Integer;", body), "R.FindLast()")).toBe(false);
  });
  it("another operator is not refused by this rule", () => {
    expect(
      refused(proc("", REPEAT(SKIP("R.FindLast()"))), "R.FindLast()", "lethal.void-method-call"),
    ).toBe(false);
  });
});

describe("R893 seam", () => {
  it("off: the plain shape is admitted", () => {
    r893Seam.on = false;
    try {
      expect(refused(proc("", REPEAT(SKIP("R.FindLast()"))), "R.FindLast()")).toBe(false);
    } finally {
      r893Seam.on = true;
    }
  });
});
