import { beforeAll, describe, expect, it } from "bun:test";
/**
 * Receiver resolution — the predicate every Tier-2 operator depends on.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4.1.
 *
 * The asymmetry that shapes every case below: missing a site costs one
 * operator's signal (Tier-1 `void-method-call` still covers it), while
 * claiming a wrong site emits a mislabelled mutation AND, under §3.2 dedup
 * precedence, suppresses the correct Tier-1 mutant at that site. Every
 * uncertainty therefore resolves to "do not claim", and each refusal below
 * is red-checked individually.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { claimsRecordMethod } from "../src/receiver";

// --- fixture plumbing ------------------------------------------------------
// Same shape as packages/builtin-tier1/tests/*: parse a snippet, build the
// semantic context over it, locate the node, call the predicate.

/**
 * Parse and fail loudly if the fixture itself is malformed — a snippet that
 * does not parse would make the predicate return `false` for a reason that has
 * nothing to do with the rule under test.
 */
function parseClean(src: string): ALSyntaxNode {
  const root = wrapRoot(parseAL(src));
  const bad: string[] = [];
  visit(root, (n) => {
    if (n.rawKind === "ERROR" || n.rawKind === "MISSING") {
      bad.push(`${n.rawKind}@${n.startIndex}:${JSON.stringify(n.text.slice(0, 40))}`);
    }
  });
  if (bad.length > 0) {
    throw new Error(`test fixture does not parse cleanly: ${bad.join(", ")}\n---\n${src}`);
  }
  return root;
}

function contextFor(root: ALSyntaxNode): SemanticContext {
  return buildSemanticContext([{ path: "fixture.al", root }]);
}

/** The single `call_expression` in a snippet; throws if there is not exactly one. */
function onlyCall(root: ALSyntaxNode): ALSyntaxNode {
  const calls = findAll(root, ALNodeKind.procedure_call);
  const [first] = calls;
  if (first === undefined || calls.length !== 1) {
    throw new Error(`expected exactly one call_expression, found ${calls.length}`);
  }
  return first;
}

interface TableOptions {
  readonly stmt: string;
  /** name -> full AL type text, e.g. `{ Validator: 'Codeunit "My Validator"' }` */
  readonly vars?: Readonly<Record<string, string>>;
  /** whole `procedure ...` members appended after the trigger */
  readonly procs?: readonly string[];
  readonly trigger?: string;
}

/**
 * A table carrying the statement inside a trigger body — the site shape Tier 2
 * exists for. `var` sits after `fields` and before the triggers, the ordering
 * `alc` accepts (spec §3.1).
 */
function tableSource(opts: TableOptions): string {
  const entries = Object.entries(opts.vars ?? {});
  const varSection =
    entries.length === 0
      ? ""
      : `\n    var\n${entries.map(([n, t]) => `        ${n}: ${t};`).join("\n")}\n`;
  const procs = (opts.procs ?? []).map((p) => `\n    ${p}\n`).join("");
  return `table 50000 "My Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
${varSection}
    trigger ${opts.trigger ?? "OnInsert"}()
    begin
        ${opts.stmt}
    end;
${procs}}`;
}

function claimsIn(src: string, methodName: string): boolean {
  const root = parseClean(src);
  return claimsRecordMethod(onlyCall(root), contextFor(root), methodName);
}

/** The brief's primary helper: statement inside a table trigger body. */
function claimsRecordMethodFor(
  stmt: string,
  methodName: string,
  vars?: Readonly<Record<string, string>>,
  trigger?: string,
): boolean {
  return claimsIn(
    tableSource({
      stmt,
      ...(vars !== undefined ? { vars } : {}),
      ...(trigger !== undefined ? { trigger } : {}),
    }),
    methodName,
  );
}

/**
 * Same table, but the object also declares a procedure of that name. The call
 * site is deliberately the *implicit-receiver* form inside a table trigger —
 * every other guard would claim it, so only the shadowing guard can refuse.
 */
function claimsRecordMethodWithLocalProc(
  stmt: string,
  methodName: string,
  declaredAs = methodName,
): boolean {
  return claimsIn(
    tableSource({
      stmt,
      procs: [`procedure ${declaredAs}(V: Integer)\n    begin\n    end;`],
    }),
    methodName,
  );
}

function codeunitSource(stmt: string, locals: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(locals);
  const varSection =
    entries.length === 0
      ? ""
      : `    var\n${entries.map(([n, t]) => `        ${n}: ${t};`).join("\n")}\n`;
  return `codeunit 50000 "My Cu"
{
    procedure P()
${varSection}    begin
        ${stmt}
    end;
}`;
}

function claimsRecordMethodInCodeunit(
  stmt: string,
  methodName: string,
  locals?: Readonly<Record<string, string>>,
): boolean {
  return claimsIn(codeunitSource(stmt, locals), methodName);
}

// --- the rules -------------------------------------------------------------

describe("claimsRecordMethod", () => {
  beforeAll(async () => {
    await initParser();
  });

  describe("claims", () => {
    it("claims the implicit-receiver form inside a table trigger body", () => {
      // `Rec` is implicit here. A predicate requiring `<rec>.` would miss the
      // very sites Tier 2 exists to mutate.
      expect(claimsRecordMethodFor('TestField("No.");', "TestField")).toBe(true);
    });

    it("claims the implicit-receiver form inside a field trigger body", () => {
      const src = `table 50000 "My Table"
{
    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                TestField("No.");
            end;
        }
    }
}`;
      expect(claimsIn(src, "TestField")).toBe(true);
    });

    it("claims a qualified `Rec.` receiver", () => {
      expect(claimsRecordMethodFor('Rec.TestField("No.");', "TestField")).toBe(true);
    });

    it("claims a qualified `xRec.` receiver", () => {
      expect(claimsRecordMethodFor("xRec.Modify(true);", "Modify", undefined, "OnModify")).toBe(
        true,
      );
    });

    it("claims a receiver declared `Record` in source, in a codeunit", () => {
      expect(
        claimsRecordMethodInCodeunit("Cust.SetRange(A, B);", "SetRange", {
          Cust: "Record Customer",
        }),
      ).toBe(true);
    });

    it("claims a receiver declared `Record` with a quoted, temporary table reference", () => {
      expect(
        claimsRecordMethodInCodeunit('Line.CalcFields("Amount");', "CalcFields", {
          Line: 'Record "Sales Line" temporary',
        }),
      ).toBe(true);
    });

    it("claims a record-typed global of the enclosing object", () => {
      expect(
        claimsRecordMethodFor("Cust.CalcFields(Balance);", "CalcFields", {
          Cust: "Record Customer",
        }),
      ).toBe(true);
    });

    it("claims a call that is not in statement position (SwapModifyFlag's then-branch case)", () => {
      // Statement-position filtering belongs to the operators, not this predicate:
      // `SwapModifyFlag` must reach `if Rec.FindSet() then Rec.Modify(true);`.
      const root = parseClean(tableSource({ stmt: "if Rec.FindSet() then Rec.Modify(true);" }));
      const ctx = contextFor(root);
      const call = findAll(root, ALNodeKind.procedure_call).find(
        (c) => c.text === "Rec.Modify(true)",
      );
      expect(call).toBeDefined();
      if (call === undefined) return;
      expect(claimsRecordMethod(call, ctx, "Modify")).toBe(true);
    });

    it("is case-insensitive on a qualified method name", () => {
      expect(claimsRecordMethodFor('Rec.TESTFIELD("No.");', "TestField")).toBe(true);
    });

    it("is case-insensitive on an implicit-receiver method name", () => {
      // AL is case-insensitive: `MODIFY(TRUE)` is the same site as `Modify(true)`.
      expect(claimsRecordMethodFor("MODIFY(TRUE);", "Modify")).toBe(true);
    });

    it("is case-insensitive on the `Rec` receiver itself", () => {
      expect(claimsRecordMethodFor("REC.SETRANGE(A, B);", "SetRange")).toBe(true);
    });
  });

  describe("refuses", () => {
    it("REFUSES a receiver that resolves to a non-record in source", () => {
      // `Validator: Codeunit "My Validator"` — a call on it is not the AL record method.
      expect(
        claimsRecordMethodFor("Validator.TestField(X);", "TestField", {
          Validator: 'Codeunit "My Validator"',
        }),
      ).toBe(false);
    });

    it("REFUSES a receiver that resolves to a non-record procedure local", () => {
      expect(
        claimsRecordMethodInCodeunit("Loader.SetRange(A, B);", "SetRange", {
          Loader: 'Codeunit "My Loader"',
        }),
      ).toBe(false);
    });

    it("REFUSES a receiver that resolves to a plain built-in type", () => {
      expect(
        claimsRecordMethodInCodeunit("Total.CalcFields(X);", "CalcFields", { Total: "Decimal" }),
      ).toBe(false);
    });

    it("REFUSES a name that resolves to a procedure declared in the project", () => {
      // A local `procedure TestField()` shadows the builtin for matching purposes.
      expect(claimsRecordMethodWithLocalProc("TestField(X);", "TestField")).toBe(false);
    });

    it("REFUSES a project-declared procedure whose name differs only in case", () => {
      expect(claimsRecordMethodWithLocalProc("TestField(X);", "TestField", "testfield")).toBe(
        false,
      );
    });

    it("REFUSES a record receiver whose table declares that procedure in the project", () => {
      const src = `${codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' })}

table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    procedure SetRange(A: Integer; B: Integer)
    begin
    end;
}`;
      expect(claimsIn(src, "SetRange")).toBe(false);
    });

    it("REFUSES when the receiver cannot be resolved at all", () => {
      // Missing a Tier-2 site costs one operator's signal; claiming a wrong one
      // emits a mislabelled mutation AND can suppress a correct Tier-1 mutant.
      expect(claimsRecordMethodFor("Unknown.TestField(X);", "TestField")).toBe(false);
    });

    it("REFUSES `Rec` where there is no implicit record — a codeunit", () => {
      expect(claimsRecordMethodInCodeunit("Rec.TestField(X);", "TestField")).toBe(false);
    });

    it("REFUSES the implicit-receiver form outside a table", () => {
      expect(claimsRecordMethodInCodeunit('TestField("No.");', "TestField")).toBe(false);
    });

    it("REFUSES a chained-member receiver it cannot resolve", () => {
      expect(claimsRecordMethodFor("Rec.Line.TestField(X);", "TestField")).toBe(false);
    });

    it("REFUSES a call-expression receiver", () => {
      const root = parseClean(tableSource({ stmt: 'GetRec().TestField("No.");' }));
      const ctx = contextFor(root);
      const call = findAll(root, ALNodeKind.procedure_call).find(
        (c) => c.text === 'GetRec().TestField("No.")',
      );
      expect(call).toBeDefined();
      if (call === undefined) return;
      expect(claimsRecordMethod(call, ctx, "TestField")).toBe(false);
    });

    it("REFUSES a call whose method name is a different builtin", () => {
      expect(claimsRecordMethodFor("Rec.SetRange(A, B);", "TestField")).toBe(false);
    });

    it("REFUSES a node that is not a call at all", () => {
      const root = parseClean(tableSource({ stmt: 'Rec.TestField("No.");' }));
      const ctx = contextFor(root);
      const [ident] = findAll(root, ALNodeKind.identifier).filter((n) => n.text === "Rec");
      expect(ident).toBeDefined();
      if (ident === undefined) return;
      expect(claimsRecordMethod(ident, ctx, "TestField")).toBe(false);
    });
  });

  describe("caller contract", () => {
    it("throws on a blank method name rather than silently never matching", () => {
      const root = parseClean(tableSource({ stmt: 'Rec.TestField("No.");' }));
      const ctx = contextFor(root);
      const call = onlyCall(root);
      expect(() => claimsRecordMethod(call, ctx, "  ")).toThrow(/method name/i);
    });

    it("throws when handed a missing node or context", () => {
      const root = parseClean(tableSource({ stmt: 'Rec.TestField("No.");' }));
      const ctx = contextFor(root);
      const call = onlyCall(root);
      const bad = undefined as unknown as ALSyntaxNode;
      const badCtx = undefined as unknown as SemanticContext;
      expect(() => claimsRecordMethod(bad, ctx, "TestField")).toThrow();
      expect(() => claimsRecordMethod(call, badCtx, "TestField")).toThrow();
    });
  });

  describe("documented grammar gap", () => {
    it("never sees the parenthesis-less call form — it is not a call_expression", () => {
      // `Commit;` parses as `call_statement`; `Rec.Modify;` as a bare
      // `member_expression`. Neither is a `call_expression`, so no Tier-2
      // operator (nor Tier-1 `void-method-call`, which has the same gap)
      // reaches these sites. Documented here so the gap is measured, not assumed.
      const root = parseClean(tableSource({ stmt: "Commit;\n        Rec.Modify;" }));
      expect(findAll(root, ALNodeKind.procedure_call).length).toBe(0);
      const kinds = new Set<string>();
      visit(root, (n) => kinds.add(n.rawKind));
      expect(kinds.has("call_statement")).toBe(true);
    });
  });
});
