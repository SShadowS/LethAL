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

/**
 * R702 gap 2: a Next walk over a TEMPORARY record runs forever when a second variable that SHARES
 * its rows (`X.Copy(R, true)`) moves a row ahead of the cursor or inserts one ahead of it (bc2
 * probe, run 3: T1c and T3c capped). Such a walk is refused as R696 refuses a permanent one. A
 * by-value copy, a `Copy` without sharing, and R's own Modify or Insert stay emitted (measured
 * finite). Each test names the clause whose removal turns it red.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";

function project(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  const find = (path: string, text: string, nth: number): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    const hits: ALSyntaxNode[] = [];
    visit(f.root, (n: ALSyntaxNode) => {
      const last = hits[hits.length - 1];
      if (last !== undefined && n.startIndex < last.endIndex) return;
      if (n.text === text) hits.push(n);
    });
    const hit = hits[nth - 1];
    if (hit === undefined) throw new Error(`"${text}" #${nth} not found in ${path}`);
    return hit;
  };
  return {
    refused: (path: string, text: string, nth = 1): boolean =>
      openItemHangRefuses(find(path, text, nth), ctx, VMC),
  };
}

const LINE_TABLE = `table 50210 "R702 Line"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Doc No."; Code[20]) { }
        field(3; Note; Text[30]) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
        key(Doc; "Doc No.") { }
    }
}`;

/** A codeunit procedure over a temporary R and a temporary R2. */
const proc = (name: string, body: string): string => `
    procedure ${name}(FirstNo: Code[20]; NewNo: Code[20])
    var
        R: Record "R702 Line" temporary;
        R2: Record "R702 Line" temporary;
    begin
${body}
    end;
`;

const files = (...procs: string[]): Record<string, string> => ({
  "line.al": LINE_TABLE,
  "cu.al": `codeunit 50211 "R702 Cu"
{${procs.join("")}}`,
});

/** A walk of R in "Doc No." order, after `pre`, with `inner` as the body. */
const WALK = (pre: string, inner: string): string => `        ${pre}
        R.SetCurrentKey("Doc No.");
        if R.FindSet() then
            repeat
                if R.Note = FirstNo then
                    exit;
${inner}
            until R.Next() = 0;`;

const MOVE_R2 = `                R2.Get(R."No.");
                R2."Doc No." := NewNo;
                R2.Modify();`;
const INSERT_R2 = `                R2.Init();
                R2."No." := NewNo;
                R2.Insert();`;

describe("R702: a temporary walk moved through a Copy(R, true) variable", () => {
  it("1. T1c: a shared variable's key-moving Modify, and the exit, are refused", () => {
    const p = project(files(proc("Moved", WALK("R2.Copy(R, true);", MOVE_R2))));
    // revert: the temporary-walk branch (rt.temporary returns)
    expect(p.refused("cu.al", "R2.Modify()")).toBe(true);
    expect(p.refused("cu.al", "exit")).toBe(true);
  });

  it("2. T3c: a shared variable's Insert, bound inside the body, is refused", () => {
    const p = project(files(proc("Filled", WALK("", `                R2.Copy(R, true);\n${INSERT_R2}`))));
    // revert: the mover's temporary skip kept for a shared variable
    expect(p.refused("cu.al", "R2.Insert()")).toBe(true);
    expect(p.refused("cu.al", "exit")).toBe(true);
  });

  it("3. the reverse binding R.Copy(R2, true) shares too", () => {
    const p = project(files(proc("Reverse", WALK("R.Copy(R2, true);", MOVE_R2))));
    // revert: the recv === R direction of the shared-set reader
    expect(p.refused("cu.al", "R2.Modify()")).toBe(true);
  });
});

describe("R702 twins: temporary walks that stay emitted", () => {
  it("4. no Copy, Copy without sharing, and Copy(R, false): R2 holds its own rows", () => {
    const p = project(
      files(
        proc("NoCopy", WALK("", MOVE_R2)),
        proc("PlainCopy", WALK("R2.Copy(R);", MOVE_R2)),
        proc("FalseCopy", WALK("R2.Copy(R, false);", MOVE_R2)),
      ),
    );
    // red when any Copy binds (the walk is then refused with no sharing at all)
    expect(p.refused("cu.al", "R2.Modify()", 1)).toBe(false);
    // red when the absent share argument is read as shared
    expect(p.refused("cu.al", "R2.Modify()", 2)).toBe(false);
    // red when a literal false is read as shared
    expect(p.refused("cu.al", "R2.Modify()", 3)).toBe(false);
    expect(p.refused("cu.al", "exit", 3)).toBe(false);
  });

  it("5. R's own Insert and Modify on a temporary walk (T3o, L2: finite), even with a sharer", () => {
    const own = `                R."Doc No." := NewNo;
                R.Modify();
                R.Insert();`;
    const p = project(files(proc("Own", WALK("R2.Copy(R, true);", own))));
    // red when R's own moves count on a temporary walk
    expect(p.refused("cu.al", "R.Insert()")).toBe(false);
    expect(p.refused("cu.al", "R.Modify()")).toBe(false);
    expect(p.refused("cu.al", "exit")).toBe(false);
  });

  it("7. a Copy(R2, true) AFTER the walk shares nothing during it; inside an enclosing loop it does", () => {
    const walk = `        if R.FindSet() then
            repeat
                if R.Note = FirstNo then
                    exit;
${INSERT_R2}
            until R.Next() = 0;
        R.Copy(R2, true);`;
    const enclosed = `        while R.IsEmpty() do begin
${walk}
        end;`;
    // the AFTER case is DC's AlterSourceNames shape (R-702 cost run: the one hit, a false positive)
    const p = project(files(proc("After", walk), proc("Enclosed", enclosed)));
    // red when a Copy anywhere in the procedure binds
    expect(p.refused("cu.al", "R2.Insert()", 1)).toBe(false);
    // red when the enclosing-loop clause is dropped
    expect(p.refused("cu.al", "R2.Insert()", 2)).toBe(true);
  });

  it("6. a Copy(R, true) into a variable that never moves leaves the walk emitted", () => {
    const p = project(
      files(proc("Reader", WALK("R2.Copy(R, true);", "                R2.Note := NewNo;"))),
    );
    // red when a shared variable alone (no mover) refuses
    expect(p.refused("cu.al", "exit")).toBe(false);
  });
});
