import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R494: an object whose HEADER is split by `#if` (`preproc_split_declaration`) is in no index
 * `projectObserves` reads, so a split-header tableextension or subscriber codeunit that observes a
 * table could not keep that table's trigger tags: the unsafe direction. Measured on master
 * 1f3a4540 (`/coord/handoff/R-494/scratch/measure494.ts`): every split case below dropped both the
 * forced and the skip tag, while its plain twin kept them. Each case here is a TWIN of a plain
 * object, at the top level and inside a `#if` wrapper.
 */
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { bareReceiverText } from "../../src/semantic/receiver";
import { forceCanRaise, modifySkipCanRaise } from "../../src/semantic/trigger-skip";

/** Par has NO OnModify, so only an observer can make the answer "keep". */
const PAR = `table 50300 Par
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Decimal) { }
    }
}
`;
const CALLER = `codeunit 50301 Ops
{
    procedure P()
    var
        Par: Record Par;
    begin
        Par.Modify();
        Par.Modify(true);
    end;
}
`;
const header = (kind: string, rest: string) =>
  `#if CLEAN25\n${kind} ${rest}\n#else\n${kind} ${rest.replace(/(\d+ \w+)/, "$1Old")}\n#endif\n`;
const wrapped = (src: string) => `#if not NEVER\n${src}#endif\n`;

const EXT_BODY = `{
    trigger OnAfterModify()
    begin
        Codeunit.Run(50999);
    end;
}
`;
const SUB_BODY = (event: string) => `{
    [EventSubscriber(ObjectType::Table, Database::Par, '${event}', '', false, false)]
    local procedure Handle(var Rec: Record Par)
    begin
        Codeunit.Run(50999);
    end;
}
`;
const plainExt = `tableextension 50302 ParExt extends Par\n${EXT_BODY}`;
const splitExt = `${header("tableextension", "50302 ParExt extends Par")}${EXT_BODY}`;
const plainSub = (event: string) => `codeunit 50303 Subs\n${SUB_BODY(event)}`;
const splitSub = (event: string) => `${header("codeunit", "50303 Subs")}${SUB_BODY(event)}`;

/** [forced tag on `Par.Modify()`, skip tag on `Par.Modify(true)`] with `observer` in the project. */
function tags(observer: string): [boolean, boolean] {
  const files = [
    { path: "Par.al", root: wrapRoot(parseAL(PAR)) },
    { path: "Ops.al", root: wrapRoot(parseAL(CALLER)) },
    ...(observer === "" ? [] : [{ path: "Obs.al", root: wrapRoot(parseAL(observer)) }]),
  ];
  const ctx = buildSemanticContext(files);
  const ops = files[1]?.root;
  if (ops === undefined) throw new Error("no caller");
  const calls: ALSyntaxNode[] = [];
  visit(ops, (n) => {
    if (n.rawKind === "call_expression" && n.text.startsWith("Par.Modify")) calls.push(n);
  });
  const [plain, withTrue] = calls;
  if (plain === undefined || withTrue === undefined) throw new Error("two calls expected");
  return [forceCanRaise(plain, ctx, "modify"), modifySkipCanRaise(withTrue, ctx)];
}

describe("R494: a split-header observer keeps the tags its plain twin keeps", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("controls: no observer drops both tags; the plain observers keep both", () => {
    expect(tags("")).toEqual([false, false]);
    expect(tags(plainExt)).toEqual([true, true]);
    expect(tags(plainSub("OnAfterModifyEvent"))).toEqual([true, true]);
  });

  // Revert: drop the `splitObjects` loop from `projectObserves`.
  for (const [what, src] of [
    ["a split-header tableextension", splitExt],
    ["a split-header tableextension inside a #if wrapper", wrapped(splitExt)],
    ["a split-header subscriber codeunit", splitSub("OnAfterModifyEvent")],
    [
      "a split-header subscriber codeunit inside a #if wrapper",
      wrapped(splitSub("OnAfterModifyEvent")),
    ],
  ] as const) {
    it(`${what} keeps both tags`, () => {
      expect(tags(src)).toEqual([true, true]);
    });
  }

  // R-485's rule for a codeunit it cannot read structurally: ANY event of this table counts, a
  // custom one too, which the text rule alone does not see. An INDEXED codeunit is read exactly and
  // counts only this kind's events, so its plain twin does not keep the tag; that difference is
  // R-485's, not this item's. Revert: drop the subscriber read from the `splitObjects` loop.
  it("a split-header codeunit subscribing to a custom event of this table keeps both tags", () => {
    expect(tags(plainSub("OnCustomThing"))).toEqual([false, false]);
    expect(tags(splitSub("OnCustomThing"))).toEqual([true, true]);
  });

  // The other direction: a split-header object that observes nothing does not tag every table.
  it("a split-header codeunit that observes nothing keeps no tag", () => {
    const idle = `${header("codeunit", "50304 Idle")}{\n    procedure Nothing()\n    begin\n    end;\n}\n`;
    expect(tags(idle)).toEqual([false, false]);
  });

  // Opus build review: the text rule's OTHER branch, a tableextension that names this table, with
  // no `On(Before|After)Modify` in it. Revert: drop the `textObserves` call of the loop.
  it("a split-header tableextension of this table with only a procedure keeps both tags", () => {
    const body = "{\n    procedure Touch()\n    begin\n    end;\n}\n";
    expect(tags(`${header("tableextension", "50302 ParExt extends Par")}${body}`)).toEqual([
      true,
      true,
    ]);
  });

  // Opus build review: a subscriber to ANOTHER table's custom event is not this table's observer.
  it("a split-header codeunit subscribing to another table's custom event keeps no tag", () => {
    const other = splitSub("OnCustomThing").replace("Database::Par", "Database::Other");
    expect(tags(other)).toEqual([false, false]);
  });
});

/**
 * Opus build review of R-494: the same split header also hid a tableextension's PROCEDURE from the
 * rule-3 shadowing guard (`projectDeclaresProcedureOnTable`), so `B.FindFirst()` in Par's
 * OnModify was claimed as the built-in, called harmless, and the skip tag dropped although the
 * project's FindFirst on Bt writes rows. And from `mayHaveMember`, which decides whether
 * `validate-to-assign` may write `Rec.` before a bare call.
 */
describe("R494: a split-header tableextension's members shadow like its plain twin's", () => {
  beforeAll(async () => {
    await initParser();
  });

  const PAR_TRIGGER = `table 50300 Par
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnModify()
    var
        B: Record Bt;
    begin
        B.FindFirst();
    end;
}
`;
  const BT = "table 50310 Bt\n{\n    fields\n    {\n        field(1; K; Code[10]) { }\n    }\n}\n";
  const BT_BODY = `{
    procedure FindFirst(): Boolean
    begin
        Rec.ModifyAll(K, 'x');
        exit(true);
    end;
}
`;
  function skipKept(ext: string): boolean {
    const files = [
      ["Par.al", PAR_TRIGGER],
      ["Bt.al", BT],
      ["Ops.al", CALLER],
      ...(ext === "" ? [] : [["Ext.al", ext]]),
    ].map(([path, src]) => ({ path: path ?? "", root: wrapRoot(parseAL(src ?? "")) }));
    const ctx = buildSemanticContext(files);
    const ops = files[2]?.root;
    if (ops === undefined) throw new Error("no caller");
    let call: ALSyntaxNode | undefined;
    visit(ops, (n) => {
      if (call === undefined && n.rawKind === "call_expression" && n.text === "Par.Modify(true)")
        call = n;
    });
    if (call === undefined) throw new Error("no call");
    return modifySkipCanRaise(call, ctx);
  }

  // Revert: read only `unparsedObjects` in `projectDeclaresProcedureOnTable`'s fallback.
  it("a shadowing FindFirst on Bt keeps Par's skip tag, plain or split", () => {
    expect(skipKept("")).toBe(false);
    expect(skipKept(`tableextension 50311 BtExt extends Bt\n${BT_BODY}`)).toBe(true);
    expect(skipKept(`${header("tableextension", "50311 BtExt extends Bt")}${BT_BODY}`)).toBe(true);
  });

  // Revert: read only `unparsedObjects` in `mayHaveMember`.
  it("a field named Rec on the page's table stops validate-to-assign writing Rec., plain or split", () => {
    const page = `page 50320 P
{
    SourceTable = Par;

    trigger OnOpenPage()
    begin
        Validate("No.", 'x');
    end;
}
`;
    const fieldBody = "{\n    fields\n    {\n        field(50100; Rec; Integer) { }\n    }\n}\n";
    const receiverOf = (ext: string) => {
      const files = [["Par.al", PAR], ["P.al", page], ...(ext === "" ? [] : [["Ext.al", ext]])].map(
        ([path, src]) => ({ path: path ?? "", root: wrapRoot(parseAL(src ?? "")) }),
      );
      const ctx = buildSemanticContext(files);
      const p = files[1]?.root;
      if (p === undefined) throw new Error("no page");
      let call: ALSyntaxNode | undefined;
      visit(p, (n) => {
        if (call === undefined && n.rawKind === "call_expression" && n.text.startsWith("Validate"))
          call = n;
      });
      if (call === undefined) throw new Error("no call");
      return bareReceiverText(call, ctx);
    };
    expect(receiverOf("")).toBe("Rec");
    expect(receiverOf(`tableextension 50302 ParExt extends Par\n${fieldBody}`)).toBeNull();
    expect(
      receiverOf(`${header("tableextension", "50302 ParExt extends Par")}${fieldBody}`),
    ).toBeNull();
  });
});
