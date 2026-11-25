import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";
import { negateConditional } from "../src/negate-conditional";

/**
 * PR-429 (R1212): two dispatch-time hang refusals on a loop's record cursor. Invented AL only.
 * Rule 1: `negate-conditional` on the loop's own `Next` end test. Rule 2: removing a cursor
 * restore (`R.Get`, `R.Find...`) that follows an earlier move of R in the loop body.
 */

beforeAll(async () => {
  await initParser();
});

const NC = "lethal.negate-conditional";
const VOID = "lethal.void-method-call";
const EMPTY = "lethal.empty-block";

function load(body: string) {
  const root = wrapRoot(
    parseAL(`codeunit 50429 "Cursor"
{
    procedure P(Skip: Boolean; Id: Integer)
    var
        R: Record Customer;
        Other: Record Customer;
        Cur: Record Customer;
        Found: Text;
        Counter: Integer;
    begin
${body}
    end;
}`),
  );
  return { root, ctx: buildSemanticContext([{ path: "a.al", root }]) };
}

/** The first node whose text is exactly `text`. */
function site(body: string, text: string) {
  const { root, ctx } = load(body);
  let hit: ALSyntaxNode | null = null;
  visit(root, (n: ALSyntaxNode) => {
    if (hit === null && n.text === text) hit = n;
  });
  if (hit === null) throw new Error(`not found: ${text}`);
  return { node: hit as ALSyntaxNode, ctx };
}

function refused(body: string, text: string, op: string): boolean {
  const { node, ctx } = site(body, text);
  return openItemHangRefuses(node, ctx, op);
}

/** The innermost `begin .. end` block whose text holds `marker`. */
function refusedBlock(body: string, marker: string): boolean {
  const { root, ctx } = load(body);
  const blocks = findAll(root, ALNodeKind.block)
    .filter((b) => b.text.includes(marker))
    .sort((a, b) => a.text.length - b.text.length);
  const block = blocks[0];
  if (block === undefined) throw new Error(`no block holds ${marker}`);
  return openItemHangRefuses(block, ctx, EMPTY);
}

describe("PR-429 rule 1 refused", () => {
  it("(a) a nested or in a repeat (M2850's shape)", () => {
    const body = `        repeat
            Counter += 1;
        until (Found <> '') or (R.Next() = 0);`;
    expect(refused(body, "R.Next() = 0", NC)).toBe(true);
  });
  it("(a) Next(-1) against 0", () => {
    const body = `        repeat
            Counter += 1;
        until (Found <> '') or (R.Next(-1) = 0);`;
    expect(refused(body, "R.Next(-1) = 0", NC)).toBe(true);
  });
  it("(a) Next(-1) against -1", () => {
    const body = `        while (Found = '') and (R.Next(-1) <> -1) do
            Counter += 1;`;
    expect(refused(body, "R.Next(-1) <> -1", NC)).toBe(true);
  });
  it("(a) a while comparison at the whole condition", () => {
    const body = `        while R.Next() <> 0 do
            Counter += 1;`;
    expect(refused(body, "R.Next() <> 0", NC)).toBe(true);
  });
  it("(a) while R.Next() = 1, and the literal first", () => {
    const body = `        while R.Next() = 1 do
            Counter += 1;
        while 0 <> R.Next(1) do
            Counter += 1;`;
    expect(refused(body, "R.Next() = 1", NC)).toBe(true);
    expect(refused(body, "0 <> R.Next(1)", NC)).toBe(true);
  });
  it("(b) the whole-condition or flip in a repeat", () => {
    const body = `        repeat
            Counter += 1;
        until ((Found <> '') or (R.Next() = 0));`;
    expect(refused(body, "(Found <> '') or (R.Next() = 0)", NC)).toBe(true);
  });
  it("(b) the and flip in a while", () => {
    const body = `        while (Found = '') and (R.Next() <> 0) do
            Counter += 1;`;
    expect(refused(body, "(Found = '') and (R.Next() <> 0)", NC)).toBe(true);
  });
});

describe("PR-429 rule 1 stays admitted", () => {
  it("a Next comparison outside a loop condition", () => {
    const body = `        if R.Next() = 0 then
            Counter := 1;`;
    expect(refused(body, "R.Next() = 0", NC)).toBe(false);
  });
  it("another comparison in the condition", () => {
    const body = `        repeat
            Counter += 1;
        until (Found <> '') or (R.Next() = 0);`;
    expect(refused(body, "Found <> ''", NC)).toBe(false);
  });
  it("Next(2) is not the end test", () => {
    const body = `        while R.Next(2) <> 0 do
            Counter += 1;`;
    expect(refused(body, "R.Next(2) <> 0", NC)).toBe(false);
  });
  // Build review NIT 7: the old "loop over another variable" test was the "not a Next comparison" case again (a Next
  // comparison in C makes the loop "over" that variable by definition). The real boundary: R's end test inside the
  // BODY of a loop over R, not in its condition C. Red: refuse any Next comparison under a loop over R.
  it("R's end test in the loop BODY, not its condition", () => {
    const body = `        repeat
            if R.Next() = 0 then
                Counter := 0;
        until (Found <> '') or (R.Next(-1) = 0);`;
    expect(refused(body, "R.Next() = 0", NC)).toBe(false);
  });
  it("the exact-span repeat condition stays ceded: no site, not refused", () => {
    const body = `        repeat
            Counter += 1;
        until R.Next() = 0;`;
    const { node, ctx } = site(body, "R.Next() = 0");
    expect(negateConditional.targets(node, ctx)).toBe(false);
    expect(openItemHangRefuses(node, ctx, NC)).toBe(false);
  });
  it("(b) the and flip in a repeat exits sooner", () => {
    const body = `        repeat
            Counter += 1;
        until (Found <> '') and (R.Next() = 0);`;
    expect(refused(body, "(Found <> '') and (R.Next() = 0)", NC)).toBe(false);
  });
  it("(b) the or flip in a while exits sooner", () => {
    const body = `        while (Found = '') or (R.Next() <> 0) do
            Counter += 1;`;
    expect(refused(body, "(Found = '') or (R.Next() <> 0)", NC)).toBe(false);
  });
  it("another operator is not refused by rule 1", () => {
    const body = `        while R.Next() <> 0 do
            Counter += 1;`;
    expect(refused(body, "R.Next() <> 0", "lethal.conditional-boundary")).toBe(false);
  });
});

const WALK = (inner: string) => `        if R.FindSet() then
            repeat
${inner}
            until R.Next() = 0;`;

describe("PR-429 rule 2 refused", () => {
  it("M0657's shape: a duplicate, then the restoring Get", () => {
    const inner = `                Cur := R;
                Cur.Get(Id);
                R := Other;
                R.Get(Id);`;
    expect(refused(WALK(inner), "R.Get(Id)", VOID)).toBe(true);
  });
  it("the move is a Copy", () => {
    const inner = `                R.Copy(Other);
                R.Get(Id);`;
    expect(refused(WALK(inner), "R.Get(Id)", VOID)).toBe(true);
  });
  it("the move is another positioning call", () => {
    const inner = `                R.FindLast();
                R.Get(Id);`;
    expect(refused(WALK(inner), "R.Get(Id)", VOID)).toBe(true);
  });
  it("the call sits in an inner loop", () => {
    const inner = `                R := Other;
                while Counter < 3 do begin
                    Counter += 1;
                    R.Get(Id);
                end;`;
    expect(refused(WALK(inner), "R.Get(Id)", VOID)).toBe(true);
  });
  it("empty-block on a block with the call but not the move", () => {
    const inner = `                R := Other;
                if Skip then begin
                    R.Get(Id);
                end;`;
    expect(refusedBlock(WALK(inner), "R.Get(Id)")).toBe(true);
  });
});

describe("PR-429 rule 2 stays admitted", () => {
  it("before the loop", () => {
    const body = `        R := Other;
        R.Get(Id);
${WALK("                Counter += 1;")}`;
    expect(refused(body, "R.Get(Id)", VOID)).toBe(false);
  });
  it("in a loop over another variable only", () => {
    const body = `        repeat
            R := Other;
            R.Get(Id);
        until Other.Next() = 0;`;
    expect(refused(body, "R.Get(Id)", VOID)).toBe(false);
  });
  it("no earlier move", () => {
    const inner = `                R.Get(Id);
                R := Other;`;
    expect(refused(WALK(inner), "R.Get(Id)", VOID)).toBe(false);
  });
  // Build review FIX. Red: drop the `op === "lethal.void-method-call"` check in r429RestoreDeleted.
  it("an operator that KEEPS the call (swap-call-arguments) is not refused by rule 2", () => {
    const inner = `                R := Other;
                R.Get(Id);`;
    expect(refused(WALK(inner), "R.Get(Id)", VOID)).toBe(true);
    expect(refused(WALK(inner), "R.Get(Id)", "lethal.swap-call-arguments")).toBe(false);
  });
  it("a field write is not a move", () => {
    const inner = `                R."No." := 'X';
                R.Get(Id);`;
    expect(refused(WALK(inner), "R.Get(Id)", VOID)).toBe(false);
  });
  it("a call that does not position", () => {
    const inner = `                R := Other;
                R.Modify();`;
    expect(refused(WALK(inner), "R.Modify()", VOID)).toBe(false);
  });
  it("empty-block on a block holding both the move and the call (M0657's if block)", () => {
    const inner = `                if Skip then begin
                    R := Other;
                    R.Get(Id);
                end;`;
    expect(refusedBlock(WALK(inner), "R.Get(Id)")).toBe(false);
  });
});
