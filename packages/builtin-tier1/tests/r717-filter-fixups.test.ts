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
 * R717: a Next walk that INSERTS into its own table (in its body, or through a one-hop callee: DC's
 * `CDC Template.Clone`) relies on a fix-up that moves the inserted row out of the walk's FILTER: a
 * write of a filtered field on a second variable, then its Modify. A mutant deleting either keeps the
 * row in the walk, which can then meet its own copies forever. Both are refused; every field counts
 * when the filters are unknown. Each test names the clause whose removal turns it red.
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

/** The walked table, with a Clone-like procedure that inserts a copy of a row (same filter values). */
const TABLE = `table 50220 "R717 Tmpl"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Ident; Code[20]) { }
        field(3; Note; Text[30]) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    procedure CloneNo(var From: Record "R717 Tmpl"; NewNo: Code[20]): Code[20]
    var
        X: Record "R717 Tmpl";
    begin
        X := From;
        X."No." := NewNo;
        X.Insert(true);
        exit(X."No.");
    end;
}`;

const OTHER = `table 50221 "R717 Other"
{
    fields
    {
        field(1; Id; Code[20]) { }
        field(2; Ident; Code[20]) { }
    }
    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}`;

const proc = (name: string, body: string, params = "Id: Code[20]; NewNo: Code[20]"): string => `
    procedure ${name}(${params})
    var
        R: Record "R717 Tmpl";
        T2: Record "R717 Tmpl";
        T3: Record "R717 Tmpl";
        O: Record "R717 Other";
    begin
${body}
    end;
`;

const files = (...procs: string[]): Record<string, string> => ({
  "tmpl.al": TABLE,
  "other.al": OTHER,
  "cu.al": `codeunit 50222 "R717 Cu"
{${procs.join("")}}`,
});

/** A walk of R filtered on Ident, with `inner` as the body. */
const WALK = (inner: string, pre = "R.SetRange(Ident, Id);"): string => `        ${pre}
        if R.FindSet() then
            repeat
${inner}
            until R.Next() = 0;`;

const CLONE = `                T2.Get(T2.CloneNo(R, NewNo));`;
/** T3 inserts; T2 (no key write of its own, so no R696 mover) does the fix-up. */
const OWN_INSERT = `                T3 := R;
                T3."No." := NewNo;
                T3.Insert();
                T2.Get(NewNo);`;

describe("R717: the fix-up that moves an inserted row out of the walk's filter is refused", () => {
  it("1. DC's Clone shape: a callee inserts, the caller writes a filtered field and Modifies", () => {
    const p = project(
      files(
        proc(
          "Clone",
          WALK(`${CLONE}
                T2.Ident := NewNo;
                T2.Modify();`),
        ),
      ),
    );
    // red when the one-hop callee insert is not read (r696CalleeInserts)
    expect(p.refused("cu.al", "T2.Modify()")).toBe(true);
    // red when the fix-up's writes are not pushed
    expect(p.refused("cu.al", "T2.Ident := NewNo")).toBe(true);
    // red when the walk's own filter (whose deletion keeps the copies in the walk) is not refused (review B1)
    expect(p.refused("cu.al", "R.SetRange(Ident, Id)")).toBe(true);
  });

  it("1b. the cloning helper is a bare procedure of the SAME object (review S1)", () => {
    const local = `
    local procedure LocalClone(var From: Record "R717 Tmpl"; NewNo: Code[20]): Code[20]
    var
        X: Record "R717 Tmpl";
    begin
        X := From;
        X."No." := NewNo;
        X.Insert(true);
        exit(X."No.");
    end;
`;
    const p = project(
      files(
        proc(
          "Bare",
          WALK(`                T2.Get(LocalClone(R, NewNo));
                T2.Ident := NewNo;
                T2.Modify();`),
        ),
        local,
      ),
    );
    // red when a bare same-object callee is not read for an insert
    expect(p.refused("cu.al", "T2.Modify()")).toBe(true);
  });

  it("1c. a ModifyAll fix-up: the value it writes is fed (review M1)", () => {
    const p = project(
      files(
        proc(
          "All",
          `        Mid := NewNo;
${WALK(`${CLONE}
                T2.ModifyAll(Ident, Mid);`)}`,
        ).replace("    begin", "        Mid: Code[20];\n    begin"),
      ),
    );
    expect(p.refused("cu.al", "T2.ModifyAll(Ident, Mid)")).toBe(true);
    // red when the fix-up movers' arguments are not traced to their feeds
    expect(p.refused("cu.al", "Mid := NewNo")).toBe(true);
  });

  it("1d. a local R filtered by a helper call before the walk: every field counts (review S2)", () => {
    const helper = `
    local procedure ApplyFilters(var X: Record "R717 Tmpl"; Id: Code[20])
    begin
        X.SetRange(Ident, Id);
    end;
`;
    const p = project(
      files(
        proc(
          "Helper",
          WALK(
            `${CLONE}
                T2.Note := NewNo;
                T2.Modify();`,
            'ApplyFilters(R, Id);\n        R.SetCurrentKey("No.");',
          ),
        ),
        helper,
      ),
    );
    // red when R passed to a call before the walk does not make its filters unknown
    expect(p.refused("cu.al", "T2.Modify()")).toBe(true);
  });

  it("2. an insert in the walk's own body, with the same fix-up", () => {
    const p = project(
      files(
        proc(
          "Own",
          WALK(`${OWN_INSERT}
                T2.Ident := NewNo;
                T2.Modify();`),
        ),
      ),
    );
    // red when an own-body insert does not arm the fix-up rule
    expect(p.refused("cu.al", "T2.Modify()")).toBe(true);
  });

  it("3. unknown filters (R a parameter: the caller filtered it), key known: every field counts", () => {
    // SetCurrentKey makes R696's key known (the PK), so a Note write is no key write there; only
    // the unknown filters refuse it. (Without a SetCurrentKey, or after a SetView or Copy, R696
    // already counts every field as a key, and its mover rule takes the fix-up.)
    const p = project(
      files(
        proc(
          "Param",
          WALK(
            `${CLONE}
                T2.Note := NewNo;
                T2.Modify();`,
            'R.SetCurrentKey("No.");',
          ),
          'var R: Record "R717 Tmpl"; NewNo: Code[20]',
        ).replace('        R: Record "R717 Tmpl";\n', ""),
      ),
    );
    // red when a non-local R's filters are read as known (none set here)
    expect(p.refused("cu.al", "T2.Modify()")).toBe(true);
  });
});

describe("R717 twins: fix-ups that stay emitted", () => {
  it("4. a write of a field the walk does NOT filter on, then Modify", () => {
    const p = project(
      files(
        proc(
          "NonFilter",
          WALK(`${CLONE}
                T2.Note := NewNo;
                T2.Modify();`),
        ),
      ),
    );
    // red when every field counts with known filters
    expect(p.refused("cu.al", "T2.Modify()")).toBe(false);
    expect(p.refused("cu.al", "T2.Note := NewNo")).toBe(false);
  });

  it("5. a walk that inserts nothing: a filter-field fix-up is not refused", () => {
    const p = project(
      files(
        proc(
          "NoInsert",
          WALK(`                T2.Get(R."No.");
                T2.Ident := NewNo;
                T2.Modify();`),
        ),
      ),
    );
    // red when the rule does not require an insert into the walked table
    expect(p.refused("cu.al", "T2.Modify()")).toBe(false);
  });

  it("6. a fix-up on ANOTHER table is not refused", () => {
    const p = project(
      files(
        proc(
          "OtherTable",
          WALK(`${CLONE}
                O.Get(Id);
                O.Ident := NewNo;
                O.Modify();`),
        ),
      ),
    );
    // red when the fix-up's table is not checked against the walked table
    expect(p.refused("cu.al", "O.Modify()")).toBe(false);
  });

  it("8. a fix-up alone refuses no exit of the walk (the hazard is the deleted fix-up)", () => {
    const p = project(
      files(
        proc(
          "Exit",
          WALK(`                if R.Note = Id then
                    exit;
${CLONE}
                T2.Ident := NewNo;
                T2.Modify();`),
        ),
      ),
    );
    expect(p.refused("cu.al", "T2.Modify()")).toBe(true);
    // red when R696's exit refusal runs for fix-ups with no R696 mover
    expect(p.refused("cu.al", "exit")).toBe(false);
  });

  it("7. R's own filter write and Modify after a callee insert (moves R's own cursor) is not refused", () => {
    const p = project(
      files(
        proc(
          "OwnFix",
          WALK(`${CLONE}
                R.Ident := NewNo;
                R.Modify();`),
        ),
      ),
    );
    // red when R itself counts as the second variable
    expect(p.refused("cu.al", "R.Modify()")).toBe(false);
  });
});
