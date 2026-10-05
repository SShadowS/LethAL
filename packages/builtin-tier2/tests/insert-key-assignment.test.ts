import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R143 — the narrowing of `run-trigger-skipped-insert`.
 *
 * R138 tagged EVERY `Insert` mutant, with no detector, and the tables gate measured the cost: the
 * screen fired on two kills and exactly one was a platform artifact. This suite pins the detector
 * that removes the other one, and — as much of the point — pins the four cases the ruling in
 * `insert-key-assignment.ts` names, including the one that keeps the tag when nothing can be proved.
 *
 * Every assertion here is about a DIAGNOSIS. None of them may move a mutant, so each tag assertion
 * is paired with the `before`/`after` text of the same spec: R72's discipline, applied at the layer
 * that produces the tag rather than only at the report that renders it.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  findAll,
  initParser,
  onInsertAssignsPrimaryKey,
  primaryKeyFields,
} from "@lethal/engine";
import { swapModifyFlag } from "../src/swap-modify-flag";
import { parseClean, projectContextFor } from "./parse-clean";

/** Every spec the operator produces over a whole PROJECT — the context shape `generateMutationSet`
 *  builds, and the only one in which a receiver's table can be resolved at all. */
function specsForProject(sources: readonly string[]) {
  const roots = sources.map(parseClean);
  const ctx: SemanticContext = projectContextFor(roots);
  return roots.flatMap((root) => {
    const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
    return calls
      .filter((n) => swapModifyFlag.targets(n, ctx))
      .flatMap((n) => swapModifyFlag.generate(n, ctx));
  });
}

/** A codeunit inserting into `tableName` through a declared record variable. */
function inserter(id: number, tableName: string): string {
  return `codeunit ${id} "Caller ${id}" { procedure P() var Target: Record "${tableName}"; begin Target.Insert(true); end; }`;
}

const KEY_ASSIGNING_TABLE = `table 50190 "Key Assigning"
{
    fields { field(1; "No."; Code[20]) { } field(2; Flag; Boolean) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        if "No." = '' then
            "No." := 'K-1';
    end;
}`;

const BOOLEAN_ONLY_TABLE = `table 50191 "Boolean Only"
{
    fields { field(1; "No."; Code[20]) { } field(2; Flag; Boolean) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        Flag := true;
    end;
}`;

const NO_TRIGGER_TABLE = `table 50192 "No Trigger"
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { Clustered = true; } }
}`;

describe("R143: the Insert tag follows the target table's OnInsert", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("TAGS an Insert whose table's OnInsert assigns the primary key", () => {
    const specs = specsForProject([inserter(50193, "Key Assigning"), KEY_ASSIGNING_TABLE]);
    expect(specs.map((s) => s.before.text)).toEqual(["Target.Insert(true)"]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  it("does NOT tag an Insert whose table's OnInsert only sets a Boolean — the fixture's arm A shape", () => {
    const specs = specsForProject([inserter(50194, "Boolean Only"), BOOLEAN_ONLY_TABLE]);
    // The mutant is unchanged in every way that reaches a verdict. Only the diagnosis moved.
    expect(specs.map((s) => s.before.text)).toEqual(["Target.Insert(true)"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Target.Insert(false)"]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });

  it("does NOT tag an Insert into a table with no OnInsert at all — there is nothing to skip", () => {
    const specs = specsForProject([inserter(50195, "No Trigger"), NO_TRIGGER_TABLE]);
    expect(specs.map((s) => s.before.text)).toEqual(["Target.Insert(true)"]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });

  /**
   * THE RULING, pinned. A base-app record resolves to no table this project can see, and for a
   * SCREEN the unsafe direction is under-tagging: an untagged platform kill is a platform refusal
   * credited to the suite. So an unresolvable receiver keeps the tag it had before R143.
   */
  it("KEEPS the tag when the receiver's table cannot be resolved (a base-app record)", () => {
    const specs = specsForProject([inserter(50196, "Customer")]);
    expect(specs.map((s) => s.before.text)).toEqual(["Target.Insert(true)"]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  it("TAGS the Rec-qualified assignment form", () => {
    const table = `table 50197 "Rec Qualified"
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        Rec."No." := 'K-1';
    end;
}`;
    const specs = specsForProject([inserter(50198, "Rec Qualified"), table]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  it("TAGS a Validate of the primary key — it assigns the field through OnValidate", () => {
    const table = `table 50199 "Validated Key"
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        Validate("No.", 'K-1');
    end;
}`;
    const specs = specsForProject([inserter(50200, "Validated Key"), table]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  it("TAGS an assignment to the SECOND field of a composite primary key", () => {
    const table = `table 50201 "Composite Key"
{
    fields { field(1; "Header No."; Code[20]) { } field(2; "Line No."; Integer) { } }
    keys { key(PK; "Header No.", "Line No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        "Line No." := 10000;
    end;
}`;
    const specs = specsForProject([inserter(50202, "Composite Key"), table]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  /**
   * The predicate must read the record being INSERTED, not any record. An `OnInsert` that stamps
   * another table's key leaves its own key blank exactly as a Boolean-only trigger does.
   * R-476: the TAG is now kept anyway, by R-452's cut (a write through another record is not a
   * proven-harmless statement), so the reader itself is what this pins.
   */
  it("the key reader does NOT count ANOTHER record's key field of the same name", () => {
    const table = `table 50203 "Other Record Key"
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    var
        Helper: Record "No Trigger";
    begin
        Helper."No." := 'K-1';
    end;
}`;
    const tableNode = findAll(parseClean(table), ALNodeKind.table)[0];
    expect(tableNode).toBeDefined();
    if (tableNode === undefined) return;
    expect(onInsertAssignsPrimaryKey(tableNode)).toBe(false);
    const specs = specsForProject([inserter(50204, "Other Record Key"), table, NO_TRIGGER_TABLE]);
    const outer = specs.find((s) => s.before.text === "Target.Insert(true)");
    expect(outer?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  it("does NOT tag when the OnInsert assigns a non-key field of its own record", () => {
    const table = `table 50205 "Non Key Field"
{
    fields { field(1; "No."; Code[20]) { } field(2; Name; Text[50]) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        Name := 'x';
    end;
}`;
    const specs = specsForProject([inserter(50206, "Non Key Field"), table]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });

  /**
   * CONTROLS — these pass whether or not R143's detector exists, and exist so the narrowing cannot
   * be "achieved" by simply switching the mechanism off.
   */
  it("still tags NOTHING on Delete and Modify, key-assigning table or not", () => {
    const caller = `codeunit 50207 "C" { procedure P() var Target: Record "Key Assigning"; begin Target.Modify(true); Target.Delete(true); end; }`;
    const specs = specsForProject([caller, KEY_ASSIGNING_TABLE]);
    expect(specs.map((s) => s.before.text)).toEqual(["Target.Modify(true)", "Target.Delete(true)"]);
    expect(specs.map((s) => s.platformKillMechanism)).toEqual([undefined, undefined]);
  });

  it("still emits the same mutant for every case above — the diagnosis never moves the mutation", () => {
    const tagged = specsForProject([inserter(50208, "Key Assigning"), KEY_ASSIGNING_TABLE]);
    const untagged = specsForProject([inserter(50209, "Boolean Only"), BOOLEAN_ONLY_TABLE]);
    expect(tagged).toHaveLength(1);
    expect(untagged).toHaveLength(1);
    expect(tagged[0]?.after.text).toBe("Target.Insert(false)");
    expect(untagged[0]?.after.text).toBe("Target.Insert(false)");
    expect(tagged[0]?.operatorVersion).toBe(untagged[0]?.operatorVersion);
  });
});

describe("R378 review r1: the primary key is the FIRST active key, readable or not", () => {
  // No parse yields a `key_declaration` without a `field_list` (measured: `key(PK)`, `key(PK; 1)`
  // and `key(PK; 'Code')` become ERROR, while `key(PK; )` keeps an EMPTY field_list), so the
  // unreadable shape is hand-built: an unreadable first key, then a readable `"Code"` key.
  const node = (rawKind: string, children: ALSyntaxNode[] = [], text = ""): ALSyntaxNode =>
    ({ rawKind, text, children, namedChildren: children }) as unknown as ALSyntaxNode;
  const table = node("table_declaration", [
    node("keys_section", [
      node("key_declaration", [node("identifier", [], "PK")]),
      node("key_declaration", [
        node("identifier", [], "SK"),
        node("field_list", [node("quoted_identifier", [], '"Code"')]),
      ]),
    ]),
  ]);

  it("stops at an unreadable first active key instead of reading the next one", () => {
    expect(primaryKeyFields(table)).toEqual([]);
  });

  it("a key in an inactive arm is still skipped, so the next active key is read", () => {
    const first = table.children[0]?.children[0];
    expect(primaryKeyFields(table, (n) => n !== first)).toEqual(["Code"]);
  });
});

/**
 * R-476: R-452's conservative cut. R143 read only DIRECT key assignments, so an `OnInsert` that
 * fills the key through a procedure (BaseApp `Sales Header` -> `InitInsert`) proved "not assigned"
 * and dropped the tag: the under-tag direction. Now any `OnInsert` call not proven harmless, a
 * project insert-event subscriber, or a tableextension insert trigger keeps it.
 */
describe("R-476: an Insert keeps its tag unless skipping OnInsert is proven harmless", () => {
  beforeAll(async () => {
    await initParser();
  });

  const tagOf = (sources: readonly string[]) => {
    const outer = specsForProject(sources).find((s) => s.before.text === "Target.Insert(true)");
    expect(outer?.after.text).toBe("Target.Insert(false)");
    return outer?.platformKillMechanism;
  };

  it("TAGS an OnInsert that assigns the key through its own procedure", () => {
    const table = `table 50210 "Helper Key"
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        InitInsert();
    end;
    procedure InitInsert()
    begin
        "No." := 'K-1';
    end;
}`;
    expect(tagOf([inserter(50211, "Helper Key"), table])).toBe("run-trigger-skipped-insert");
  });

  it("TAGS an OnInsert that inserts another row (a later Get of it raises when skipped)", () => {
    const table = `table 50212 "Inserts Other"
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    var
        Helper: Record "No Trigger";
    begin
        Helper."No." := 'K-1';
        Helper.Insert(false);
    end;
}`;
    expect(tagOf([inserter(50213, "Inserts Other"), table, NO_TRIGGER_TABLE])).toBe(
      "run-trigger-skipped-insert",
    );
  });

  it("TAGS when a project codeunit subscribes to the table's OnBeforeInsertEvent", () => {
    const subscriber = `codeunit 50214 "Subscriber"
{
    [EventSubscriber(ObjectType::Table, Database::"Boolean Only", 'OnBeforeInsertEvent', '', false, false)]
    local procedure SetKey(var Rec: Record "Boolean Only")
    begin
        Rec."No." := 'K-1';
    end;
}`;
    expect(tagOf([inserter(50215, "Boolean Only"), BOOLEAN_ONLY_TABLE, subscriber])).toBe(
      "run-trigger-skipped-insert",
    );
  });

  it("TAGS when a project tableextension declares OnBeforeInsert", () => {
    const ext = `tableextension 50216 "Boolean Only Ext" extends "Boolean Only"
{
    trigger OnBeforeInsert()
    begin
        Rec."No." := 'K-1';
    end;
}`;
    expect(tagOf([inserter(50217, "Boolean Only"), BOOLEAN_ONLY_TABLE, ext])).toBe(
      "run-trigger-skipped-insert",
    );
  });

  it("does NOT tag an OnInsert whose only calls are proven harmless (TestField)", () => {
    const table = `table 50218 "Harmless Calls"
{
    fields { field(1; "No."; Code[20]) { } field(2; Flag; Boolean) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        TestField(Flag);
        Flag := true;
    end;
}`;
    expect(tagOf([inserter(50219, "Harmless Calls"), table])).toBeUndefined();
  });
});
