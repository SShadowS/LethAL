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
  findAll,
  initParser,
  visit,
} from "@lethal/engine";
import { claimsRecordMethod } from "../src/receiver";
import { contextFor, parseClean, projectContextFor } from "./parse-clean";

// --- fixture plumbing ------------------------------------------------------
// Same shape as packages/builtin-tier1/tests/*: parse a snippet, build the
// semantic context over it, locate the node, call the predicate. `parseClean`
// and the two context builders are shared with the four operator suites via
// `./parse-clean.ts`.

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

/** A table that declares its OWN `SetRange`, shadowing the builtin for every receiver of its type. */
const SHADOWING_TABLE = `table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    procedure SetRange(A: Integer; B: Integer)
    begin
    end;
}`;

/** The same table WITHOUT the shadowing procedure — the extension below supplies it instead. */
const PLAIN_TABLE = `table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }
}`;

/**
 * A `tableextension` declaring `SetRange` on `Other Table`. In AL an extension's public
 * procedures are callable on a variable of the EXTENDED table's type, so this shadows the builtin
 * for every `Record "Other Table"` in the project exactly as a procedure on the table itself does.
 */
const SHADOWING_EXTENSION = `tableextension 50002 "Other Ext" extends "Other Table"
{
    fields { field(50000; MyField; Integer) { } }

    procedure SetRange(FromNo: Code[20]; ToNo: Code[20])
    begin
    end;
}`;

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

${SHADOWING_TABLE}`;
      expect(claimsIn(src, "SetRange")).toBe(false);
    });

    /**
     * The same rule, but with the two objects in SEPARATE FILES — one AL object per file is the
     * normal layout, and `generateMutationSet` (packages/runner/src/orchestrator.ts) builds ONE
     * semantic context across every file precisely so this guard can fire there.
     *
     * The single-file case above is genuinely red-checkable but certifies a configuration the
     * pipeline never produced: while the orchestrator built a context PER FILE, the codeunit's
     * context held no table at all, the guard could not fire, and this site was CLAIMED in every
     * real run. This case is the one that observes the pipeline's actual shape.
     */
    it("REFUSES it across FILES, with the context built the way the orchestrator builds it", () => {
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' }),
      );
      const tableRoot = parseClean(SHADOWING_TABLE);
      const ctx = projectContextFor([cuRoot, tableRoot]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(false);
    });

    /**
     * `R: Record 50004` is legal AL, and the grammar reports the record_type reference as the
     * INTEGER `50004`, not a name. A guard that resolves the receiver's table by name alone never
     * matches that spelling, so the shadowed call was claimed as the builtin.
     */
    it("REFUSES a receiver declared by table ID whose table declares that procedure", () => {
      const cuRoot = parseClean(codeunitSource("Other.SetRange(A, B);", { Other: "Record 50001" }));
      const tableRoot = parseClean(SHADOWING_TABLE);
      const ctx = projectContextFor([cuRoot, tableRoot]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(false);
    });

    it("REFUSES a receiver whose table name differs only in case from the declaration", () => {
      // AL is case-insensitive; `resolveObject`'s own name comparison is not.
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "other table"' }),
      );
      const tableRoot = parseClean(SHADOWING_TABLE);
      const ctx = projectContextFor([cuRoot, tableRoot]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(false);
    });

    /**
     * The counterweight to the three cases above: with the table present but declaring NO
     * `SetRange`, the very same project-wide context must still CLAIM. Without this, all four
     * could pass by refusing every cross-file receiver for some unrelated reason.
     */
    it("still CLAIMS across files when the table declares no such procedure", () => {
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' }),
      );
      const tableRoot = parseClean(PLAIN_TABLE);
      const ctx = projectContextFor([cuRoot, tableRoot]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(true);
    });

    /**
     * Rule 3 through a `tableextension` — the same defect one object kind over, and it pointed
     * the DANGEROUS way. In AL an extension's public procedures are callable on a variable of the
     * extended table's type, so this call is `Other Ext`'s procedure, not the builtin. Measured
     * `true` (a wrong claim) before `symbols.tableExtensions` existed: it mislabels the mutation
     * and, under §3.2 dedup precedence, suppresses the correct Tier-1 `void-method-call` mutant
     * at the same site.
     *
     * Note the counterweight two cases above is `PLAIN_TABLE` + no extension, and still CLAIMS —
     * so these cannot pass by refusing every cross-file receiver.
     */
    it("REFUSES a receiver whose table is extended by a tableextension declaring that procedure", () => {
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' }),
      );
      const ctx = projectContextFor([
        cuRoot,
        parseClean(PLAIN_TABLE),
        parseClean(SHADOWING_EXTENSION),
      ]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(false);
    });

    /**
     * The common real-world spelling: a project `tableextension` over a BASE-APP table, which a
     * source-only symbol table can never see. Requiring the base table to resolve first would
     * leave exactly the same wrong claim standing for `extends Customer`.
     */
    it("REFUSES it even when the extended table is not in the project at all", () => {
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' }),
      );
      const ctx = projectContextFor([cuRoot, parseClean(SHADOWING_EXTENSION)]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(false);
    });

    it("REFUSES it when the receiver names the table by ID and the extension extends it by name", () => {
      // `R: Record 50001` is legal AL; the extends target is always a NAME, so the two spellings
      // have to be bridged through the resolved table rather than compared directly.
      const cuRoot = parseClean(codeunitSource("Other.SetRange(A, B);", { Other: "Record 50001" }));
      const ctx = projectContextFor([
        cuRoot,
        parseClean(PLAIN_TABLE),
        parseClean(SHADOWING_EXTENSION),
      ]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(false);
    });

    it("REFUSES it when the extends target differs from the table name only in case", () => {
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' }),
      );
      const ext = parseClean(
        SHADOWING_EXTENSION.replace('extends "Other Table"', 'extends "OTHER TABLE"'),
      );
      const ctx = projectContextFor([cuRoot, parseClean(PLAIN_TABLE), ext]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(false);
    });

    it("REFUSES the IMPLICIT-receiver form when a tableextension of the enclosing table declares it", () => {
      // Inside `Other Table` itself, `SetRange(A, B)` binds to the extension's procedure exactly
      // as it would to one declared on the table.
      const tableRoot = parseClean(`table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    trigger OnInsert()
    begin
        SetRange(A, B);
    end;
}`);
      const ctx = projectContextFor([tableRoot, parseClean(SHADOWING_EXTENSION)]);
      expect(claimsRecordMethod(onlyCall(tableRoot), ctx, "SetRange")).toBe(false);
    });

    /**
     * The counterweight for the extension cases: an extension that exists but extends a DIFFERENT
     * table must not refuse. Without this, every case above could pass by refusing whenever any
     * `tableextension` is present anywhere in the project.
     */
    it("still CLAIMS when the only tableextension present extends a different table", () => {
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' }),
      );
      const ext = parseClean(
        SHADOWING_EXTENSION.replace('extends "Other Table"', 'extends "Unrelated Table"'),
      );
      const ctx = projectContextFor([cuRoot, parseClean(PLAIN_TABLE), ext]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(true);
    });

    it("still CLAIMS when the tableextension declares some OTHER procedure", () => {
      const cuRoot = parseClean(
        codeunitSource("Other.SetRange(A, B);", { Other: 'Record "Other Table"' }),
      );
      const ext = parseClean(
        SHADOWING_EXTENSION.replace("procedure SetRange", "procedure Unrelated"),
      );
      const ctx = projectContextFor([cuRoot, parseClean(PLAIN_TABLE), ext]);
      expect(claimsRecordMethod(onlyCall(cuRoot), ctx, "SetRange")).toBe(true);
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

/**
 * R30 — sites written INSIDE an extension object.
 *
 * Every Tier-2 operator used to refuse these outright: `enclosingObject` walked past a
 * `tableextension`/`pageextension` and found nothing. Safe, but a great deal of real BC code lives
 * in extensions, and it is exactly the `Rec.TestField(...)` / `Rec.Modify(true)` shape these
 * operators exist for.
 */
describe("extension objects (R30)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const BASE_TABLE = `table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }
}`;

  function extensionSource(stmt: string): string {
    return `tableextension 50002 "My Ext" extends "Other Table"
{
    fields { field(50000; MyField; Integer) { } }

    procedure P()
    begin
        ${stmt}
    end;
}`;
  }

  it("claims a qualified Rec method inside a tableextension", () => {
    const src = extensionSource('Rec.TestField("No.");');
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "TestField",
      ),
    ).toBe(true);
  });

  it("claims xRec too — same implicit-record rule", () => {
    const src = extensionSource("xRec.Modify(true);");
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "Modify",
      ),
    ).toBe(true);
  });

  it("resolves Rec to the EXTENDED table, so a shadowing procedure THERE still refuses", () => {
    // The whole point of resolving to `base_object` rather than to the extension's own name: rule
    // 3 must be able to see a procedure declared on the extended table. A resolution that returned
    // the extension's name would look successful and silently bypass this guard.
    const shadowed = `table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    procedure TestField(A: Code[20])
    begin
    end;
}`;
    const src = extensionSource('Rec.TestField("No.");');
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(shadowed)]),
        "TestField",
      ),
    ).toBe(false);
  });

  it("claims the RECEIVERLESS form inside a tableextension — the shape that actually occurs", () => {
    // Measured on Continia Document Output: its 31 tableextensions contain ZERO `Rec.`-qualified
    // calls, but do contain bare `SetRange(...)` / `TestField(...)`. Handling only the qualified
    // form gained exactly nothing there — the totals were byte-identical with and without it.
    const src = `tableextension 50002 "My Ext" extends "Other Table"
{
    procedure P()
    begin
        TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "TestField",
      ),
    ).toBe(true);
  });

  it("guards the receiverless form on the EXTENDED table's procedures, not the extension's name", () => {
    // Rule 3 keyed on the wrong table would look successful and silently claim a site that is
    // really a call to a project-declared procedure.
    const shadowed = `table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    procedure TestField(A: Code[20])
    begin
    end;
}`;
    const src = `tableextension 50002 "My Ext" extends "Other Table"
{
    procedure P()
    begin
        TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(shadowed)]),
        "TestField",
      ),
    ).toBe(false);
  });

  it("REFUSES the receiverless form inside a pageextension", () => {
    const src = `pageextension 50003 "My Page Ext" extends "Customer Card"
{
    procedure P()
    begin
        TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "TestField",
      ),
    ).toBe(false);
  });

  it("REFUSES an implicit Rec inside a pageextension — deliberately, not incidentally", () => {
    // A page's `Rec` is the extended PAGE's SourceTable, declared in an object this project
    // routinely cannot see. Guessing it would CLAIM the site wrongly, which mislabels the mutation
    // and, under the §3.2 dedup precedence, suppresses the correct Tier-1 mutant at that site.
    const src = `pageextension 50003 "My Page Ext" extends "Customer Card"
{
    procedure P()
    begin
        Rec.TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "TestField",
      ),
    ).toBe(false);
  });

  it("claims a variable DECLARED inside an extension (R30, second half)", () => {
    // `SymbolTable` used to skip an extension's members entirely, so `lookupVar` found nothing and
    // every call on a declared record variable inside an extension was refused as unresolvable.
    // Measured on Continia Document Output: that is the shape its extension code overwhelmingly
    // uses — its 31 tableextensions contain no `Rec.`-qualified calls at all, so the implicit-Rec
    // half alone gained just two mutants there.
    const src = `tableextension 50002 "My Ext" extends "Other Table"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "TestField",
      ),
    ).toBe(true);
  });

  it("claims a variable DECLARED inside a pageextension (R30, third half)", () => {
    // The `pageextension`'s own `Rec` stays unresolvable (above) — but a variable declared INSIDE
    // one is declared right there, with an explicit `Record` type, and nothing about it is a guess.
    // `buildSymbolTable` indexed a `pageextension`'s members nowhere at all, so `lookupVar` found
    // nothing and every such call was refused as an unresolvable receiver.
    //
    // Measured on Continia Document Output Cloud (`scripts/probe-r30-pageext.ts`): 18 such sites,
    // against ZERO calls on a `pageextension`'s implicit `Rec` — so this is the whole of what is
    // left to win in a `pageextension`.
    const src = `pageextension 50003 "My Page Ext" extends "Customer Card"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "TestField",
      ),
    ).toBe(true);
  });

  it("guards a pageextension's declared variable by procedures on ITS table too", () => {
    // Rule 3 is not skipped for the new object kind: the receiver names `Other Table`, and the
    // project declares `TestField` on it, so the call is that procedure and not the builtin.
    const shadowed = `table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    procedure TestField(A: Code[20])
    begin
    end;
}`;
    const src = `pageextension 50003 "My Page Ext" extends "Customer Card"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(shadowed)]),
        "TestField",
      ),
    ).toBe(false);
  });

  it("does not let a same-named tableextension and pageextension share variables", () => {
    // AL permits both kinds to carry one name, so the scope key carries the KIND. Collapsing it to
    // the bare name makes both extensions index their members under ONE key, and `indexMembers`
    // ends with `procedures.set(owner, procs)` — a wholesale overwrite, so whichever declaration is
    // processed LAST owns the key and the other's variables vanish.
    //
    // The assertion direction is therefore load-bearing, and this test was WRONG the first time:
    // written with the tableextension first and asserting `false`, it passed under the collapsed
    // key too — not because the receiver was correctly classified as an Integer, but because the
    // tableextension's whole procedure had been overwritten and the receiver became UNRESOLVABLE,
    // which is also `false`. A red-check caught it (the project's signature "passes for the wrong
    // reason" shape, inside a test written to prevent exactly that).
    //
    // Now the PAGEEXTENSION is declared first and the site that must be CLAIMED lives in it, so the
    // collapsed key hands `tableextension:Dup` to the tableextension's same-named procedure, whose
    // `Other` is an Integer — a non-record, refused. Correct namespacing claims; a collision does
    // not. One boolean, two mechanisms, opposite answers.
    const src = `pageextension 50003 "Dup" extends "Customer Card"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.TestField("No.");
    end;
}
tableextension 50002 "Dup" extends "Other Table"
{
    procedure P()
    var
        Other: Integer;
    begin
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(BASE_TABLE)]),
        "TestField",
      ),
    ).toBe(true);
  });

  it("still guards a declared variable by procedures on ITS table, not the extension's name", () => {
    // Scope and callability are different questions, and this pins the split: the extension owns
    // the VARIABLE, while the extended table owns the procedure that may shadow the builtin.
    const shadowed = `table 50001 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    procedure TestField(A: Code[20])
    begin
    end;
}`;
    const src = `tableextension 50002 "My Ext" extends "Other Table"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.TestField("No.");
    end;
}`;
    const root = parseClean(src);
    expect(
      claimsRecordMethod(
        onlyCall(root),
        projectContextFor([root, parseClean(shadowed)]),
        "TestField",
      ),
    ).toBe(false);
  });
});

// ————————————————————————————————————————————————————————————————————————
// R70, AT THE LAYER THAT ACTUALLY CLAIMS. `symbol-table.test.ts` proves the scope key is
// kind-namespaced; this proves the consequence the row was filed for, through
// `claimsRecordMethod` itself.
//
// Added because a red-check found the gap: reverting the fix in `receiver.ts` reddened 23 tests,
// but every one of them was a generic "can it find a variable at all" test that would break for
// ANY key mismatch. None constructed two objects of different kinds sharing a name, so none was
// evidence for the property. A test that goes red for the wrong reason is this project's signature
// failure, and it applies to red-checks too.
// ————————————————————————————————————————————————————————————————————————
describe("claimsRecordMethod — a page named after its table (R70)", () => {
  // The ordinary BC convention: a card page named after its table. Measured on Continia Document
  // Output Cloud as 13 shared names, 12 of them page+table.
  const TABLE = `table 50000 "CDO Setup"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnInsert()
    begin
        Helper.SetRange("No.", 'X');
    end;
}`;

  // Same name, different kind, and `Helper` here IS a Record — so a lookup that crossed the two
  // would find a plausible-looking declaration and CLAIM the table's site.
  const PAGE = `page 50000 "CDO Setup"
{
    SourceTable = "CDO Setup";

    var
        Helper: Record Customer;
}`;

  it("refuses a receiver the TABLE never declares, even though the same-named PAGE declares it", () => {
    // The unsafe direction, stated as a test: the table declares no `Helper` at all, so rule 4
    // must refuse. Under a bare-name scope key the page's `Helper: Record Customer` answered for
    // the table and the site was CLAIMED — a wrong claim that, under §3.2 dedup precedence,
    // DELETES the correct Tier-1 mutant at that site.
    const table = parseClean(TABLE);
    const ctx = projectContextFor([table, parseClean(PAGE)]);
    expect(claimsRecordMethod(onlyCall(table), ctx, "SetRange")).toBe(false);
  });

  it("still claims when the TABLE itself declares the receiver, page or no page", () => {
    // The counterweight: kind-namespacing must not cost a legitimate claim. Without this, the
    // test above would pass just as well if scope lookup were broken outright.
    const withVar = `table 50000 "CDO Setup"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    var
        Helper: Record Customer;

    trigger OnInsert()
    begin
        Helper.SetRange("No.", 'X');
    end;
}`;
    const table = parseClean(withVar);
    const ctx = projectContextFor([table, parseClean(PAGE)]);
    expect(claimsRecordMethod(onlyCall(table), ctx, "SetRange")).toBe(true);
  });
});

// ————————————————————————————————————————————————————————————————————————
// R68 — a receiver declared in a TRIGGER's own `var` section now resolves.
//
// `buildSymbolTable` indexes `procedure` members only, so a trigger's `var` section used to be
// invisible in EVERY object kind — table triggers, page triggers, `OnRun`, field `OnValidate` —
// and Tier 2 refused every site whose receiver lived there. Safe direction (Tier-1
// `void-method-call` still covered the site) but a real coverage loss, and trigger bodies are
// where a great deal of BC logic lives. Measured incidentally under R30: moving a pageextension's
// declarations out of `OnOpenPage` into the object's `var` section turned four specs into a
// claimable `remove-setrange` site.
//
// Trigger scope is resolved from the AST NODE, not from a name-keyed map, and that is forced
// rather than stylistic: trigger names repeat across an object (every field may declare its own
// `OnValidate`), so a name key would be ambiguous. The node is the unambiguous identity.
//
// THIS TEST REPLACES the R68-is-open premise pin that guarded the R70 live detector. That pin did
// its job — it named, in advance and in an executable form, that landing R68 would silently
// disarm that detector. The alarm now lives offline in `symbol-table.test.ts`'s order-invariance
// property, which does not depend on R68 either way.
// ————————————————————————————————————————————————————————————————————————
describe("a receiver declared in a trigger's own var section (R68)", () => {
  const TRIGGER_LOCAL = `table 50160 "Scope Probe"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnInsert()
    var
        Helper: Record "Data Related";
    begin
        Helper.SetRange("No.", 'X');
    end;
}`;

  it("claims it — the declaration is right there in the trigger", () => {
    const root = parseClean(TRIGGER_LOCAL);
    expect(claimsRecordMethod(onlyCall(root), contextFor(root), "SetRange")).toBe(true);
  });

  it("still refuses a receiver declared nowhere at all", () => {
    // The counterweight. Without it, "resolve trigger vars" could be satisfied by resolving
    // anything, and rule 4's refusal — the thing that keeps an unprovable site out of Tier 2 —
    // would be gone with no test noticing.
    const undeclared = `table 50161 "Scope Probe 2"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnInsert()
    begin
        Ghost.SetRange("No.", 'X');
    end;
}`;
    const root = parseClean(undeclared);
    expect(claimsRecordMethod(onlyCall(root), contextFor(root), "SetRange")).toBe(false);
  });

  it("a field OnValidate's own var section resolves too, not just table-level triggers", () => {
    const fieldTrigger = `table 50162 "Scope Probe 3"
{
    fields
    {
        field(1; Amount; Decimal)
        {
            trigger OnValidate()
            var
                Helper: Record "Data Related";
            begin
                Helper.SetRange("No.", 'X');
            end;
        }
    }
}`;
    const root = parseClean(fieldTrigger);
    expect(claimsRecordMethod(onlyCall(root), contextFor(root), "SetRange")).toBe(true);
  });
});
