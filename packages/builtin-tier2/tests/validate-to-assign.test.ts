import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `ValidateToAssign`: rewrite `<rec>.Validate(F, V)` to `<rec>.F := V`.
 *
 * Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.3.
 * `claimsRecordMethod` itself is exhaustively tested in `receiver.test.ts`; this file exercises the
 * operator's own guards (exact two-argument count, field-identifier shape, statement position) plus
 * the shared `calleeNameNode` splice point and the implicit-receiver emit path amendment 1 added.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  findAll,
  initParser,
} from "@lethal/engine";
import { validateToAssign } from "../src/validate-to-assign";
import { contextFor, parseClean, projectContextFor } from "./parse-clean";

function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => validateToAssign.targets(n, ctx))
    .flatMap((n) => validateToAssign.generate(n, ctx));
}

describe("validateToAssign", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("rewrites a qualified two-argument Validate into a receiver-preserving assignment", () => {
    const src = `codeunit 50200 "T" {
      procedure P(NewName: Text)
      var Rec: Record Customer;
      begin
        Rec.Validate(Name, NewName);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.before.text).toBe("Rec.Validate(Name, NewName)");
    expect(specs[0]?.after.text).toBe("Rec.Name := NewName");
    expect(specs[0]?.parentContext).toBe("statement-position");
    expect(specs[0]?.operatorName).toBe("lethal.validate-to-assign");
  });

  it("keeps quoted field identifiers quoted", () => {
    const src = `codeunit 50201 "T" {
      procedure P(NewNo: Code[20])
      var Rec: Record Customer;
      begin
        Rec.Validate("No.", NewNo);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs[0]?.before.text).toBe('Rec.Validate("No.", NewNo)');
    expect(specs[0]?.after.text).toBe('Rec."No." := NewNo');
  });

  it("accepts an arbitrary expression as the value argument", () => {
    const src = `codeunit 50202 "T" {
      procedure P(Base: Decimal)
      var Rec: Record Customer;
      begin
        Rec.Validate("Credit Limit (LCY)", Base * 2 + 1);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs[0]?.after.text).toBe('Rec."Credit Limit (LCY)" := Base * 2 + 1');
  });

  it("refuses the single-argument form: Validate(F) has no assignment equivalent", () => {
    const src = `codeunit 50203 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Validate(Name);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses a first argument that is a member access", () => {
    const src = `codeunit 50204 "T" {
      procedure P(V: Integer)
      var Rec: Record Customer;
      begin
        Rec.Validate(Rec.Name, V);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses a first argument that is a call", () => {
    const src = `codeunit 50205 "T" {
      procedure P(NewName: Text)
      var Rec: Record Customer;
      begin
        Rec.Validate(GetFieldName(), NewName);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses a first argument that is a literal", () => {
    const src = `codeunit 50206 "T" {
      procedure P(NewName: Text)
      var Rec: Record Customer;
      begin
        Rec.Validate(123, NewName);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  /**
   * R161 FLIPPED this test. The operator's guard 1 documented the refusal as an accepted cost, on
   * the grounds that the guarded dispatch chain can only be spliced where a statement is expected.
   * A `then_branch` is exactly where a statement is expected; the predicate was the narrower
   * `isStatementPosition`, which asks whether the node is one of SEVERAL statements in a block.
   * Measured on `do-rel2/Cloud`: this operator alone claims 19 more sites, 112 to 131.
   */
  it("claims a Validate sitting as an if's then-branch (R161)", () => {
    const src = `codeunit 50207 "T" {
      procedure P(NewName: Text; Cond: Boolean)
      var Rec: Record Customer;
      begin
        if Cond then Rec.Validate(Name, NewName);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe("Rec.Name := NewName");
  });

  /**
   * Named for what it actually exercises: `Mystery: Variant` is a DECLARED, resolvable receiver of
   * a non-record type, so this test is sensitive to `claimsRecordMethod`'s non-record guard
   * (`receiver.kind === "non-record"`), not its unresolved-receiver guard. An earlier version of
   * this test was named "refuses an unproven receiver", which overpromised: it never touched the
   * genuinely-unresolved path at all. That path gets its own test directly below.
   */
  it("refuses a receiver declared with a non-record type (Variant)", () => {
    const src = `codeunit 50208 "T" {
      procedure P(Mystery: Variant; NewName: Text)
      begin
        Mystery.Validate(Name, NewName);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  /**
   * The genuinely unresolved case (`claimsRecordMethod`'s `receiver.kind === "unresolved"` guard):
   * `Unknown` is never declared anywhere in this procedure (no var, no parameter, no object
   * global), which is the shape `receiver.test.ts`'s own "REFUSES when the receiver cannot be
   * resolved at all" test uses for `TestField`. This operator gets the same case for `Validate`.
   */
  it("refuses a receiver that cannot be resolved at all", () => {
    const src = `codeunit 50216 "T" {
      procedure P(NewName: Text)
      begin
        Unknown.Validate(Name, NewName);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses a receiver that resolves to a non-record", () => {
    const src = `codeunit 50209 "T" {
      procedure P(NewName: Text)
      var Validator: Codeunit "My Validator";
      begin
        Validator.Validate(Name, NewName);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("matches case-insensitively", () => {
    const src = `codeunit 50210 "T" {
      procedure P(NewName: Text)
      var Rec: Record Customer;
      begin
        Rec.VALIDATE(Name, NewName);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe("Rec.Name := NewName");
  });

  /**
   * Amendment 1 (spec §2.3): the implicit-receiver form emits `Rec.`-QUALIFIED, not bare, because
   * `Validate`'s first argument resolves in the record's field scope while a bare assignment target
   * resolves in ordinary identifier scope. This is the behaviour the brief's own sketch got wrong
   * and the adversarial review corrected, so it gets its own test rather than being folded into the
   * qualified-form cases above.
   */
  describe("implicit-receiver form (amendment 1)", () => {
    it("emits Rec.F := V for a bare field inside a table procedure", () => {
      const src = `table 50211 "Data Trigger Probe Test" {
        fields {
          field(1; "No."; Code[20]) { }
          field(2; Level; Integer) { }
        }
        procedure Bump(V: Integer)
        begin
          Validate(Level, V);
        end;
      }`;
      const specs = specsFor(src);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.before.text).toBe("Validate(Level, V)");
      expect(specs[0]?.after.text).toBe("Rec.Level := V");
    });

    it('emits Rec."F" := V for a quoted field inside a table procedure', () => {
      const src = `table 50212 "Data Trigger Probe Test 2" {
        fields {
          field(1; "No."; Code[20]) { }
          field(2; "Level Doubled"; Integer) { }
        }
        procedure Bump(V: Integer)
        begin
          Validate("Level Doubled", V);
        end;
      }`;
      const specs = specsFor(src);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.before.text).toBe('Validate("Level Doubled", V)');
      expect(specs[0]?.after.text).toBe('Rec."Level Doubled" := V');
    });
  });

  /**
   * Section 2.5 of the R136 trio spec: a shadowing refusal test built over a single-file context
   * passes even if the shadowing guard were deleted, because `claimsRecordMethod`'s project-declared-
   * procedure rule can only fire over a context built across the WHOLE project. `Validate` gets its
   * own refusal proven over a `projectContextFor` context, paired with a "still CLAIMS" counterweight.
   *
   * This block covers the QUALIFIED-receiver form only (`Other.Validate(...)`, `Other: Record
   * "..."`). `claimsRecordMethod` has a SECOND shadowing path for the implicit-receiver form (the
   * `target.receiver === null` branch, reached when a table's own code calls `Validate` with no
   * receiver at all); see "implicit-receiver form shadowing" below for that path's own tests.
   */
  describe("qualified-form shadowing refusal across files", () => {
    function specsForProject(sources: readonly string[]) {
      const roots = sources.map((s) => parseClean(s));
      const ctx: SemanticContext = projectContextFor(roots);
      const calls: ALSyntaxNode[] = roots.flatMap((root) =>
        findAll(root, ALNodeKind.procedure_call),
      );
      return calls
        .filter((n) => validateToAssign.targets(n, ctx))
        .flatMap((n) => validateToAssign.generate(n, ctx));
    }

    function caller(table: string): string {
      return `codeunit 50213 "C" { procedure P(NewName: Text) var Other: Record "${table}"; begin Other.Validate(Name, NewName); end; }`;
    }

    it("REFUSES Validate(...) when the project declares its own Validate on the table", () => {
      const table = `table 50214 "Other Table Val1" { fields { field(1; "No."; Code[20]) { } } procedure Validate(FieldNo: Integer; NewValue: Integer) begin end; }`;
      expect(specsForProject([caller("Other Table Val1"), table])).toEqual([]);
    });

    it("still CLAIMS Validate(...) across files when the table declares no such procedure", () => {
      const table = `table 50215 "Plain Table Val1" { fields { field(1; "No."; Code[20]) { } } }`;
      const specs = specsForProject([caller("Plain Table Val1"), table]);
      expect(specs.map((s) => s.before.text)).toEqual(["Other.Validate(Name, NewName)"]);
    });
  });

  /**
   * `claimsRecordMethod`'s implicit-receiver branch (`target.receiver === null`) has its OWN
   * shadowing rule, checked two ways: does the enclosing table itself declare a procedure of that
   * name (`declaresProcedure`), or does a `tableextension` of it (`projectDeclaresProcedureOnTable`,
   * the same helper the qualified-form block above exercises)? Neither was tested by any of the
   * three R136 trio operators for their own new method names (an independent audit found this: the
   * guard is real and method-name-agnostic, and IS tested generically elsewhere with `TestField`/
   * `SetRange`, but no trio test proved `Insert`/`Delete`/`FindFirst`/`FindLast`/`Validate` go
   * through this second path correctly). This block closes that gap for `Validate`.
   *
   * All three cases use `projectContextFor`, matching this file's own convention for every other
   * shadowing test, even though the first case below (the table shadowing itself) does not strictly
   * need cross-file resolution: `declaresProcedure` reads the SAME object node's own members
   * directly, so a single-file context sees it too. The second case (a `tableextension` in a
   * separate source declaring the procedure) is the one that genuinely cannot fire without a
   * project-wide context, mirroring why the qualified-form block above requires it.
   */
  describe("implicit-receiver form shadowing", () => {
    function specsForProject(sources: readonly string[]) {
      const roots = sources.map((s) => parseClean(s));
      const ctx: SemanticContext = projectContextFor(roots);
      const calls: ALSyntaxNode[] = roots.flatMap((root) =>
        findAll(root, ALNodeKind.procedure_call),
      );
      return calls
        .filter((n) => validateToAssign.targets(n, ctx))
        .flatMap((n) => validateToAssign.generate(n, ctx));
    }

    it("REFUSES the implicit-receiver form when the enclosing table declares its own Validate procedure", () => {
      const table = `table 50217 "Data Trigger Probe Test 3" {
        fields {
          field(1; "No."; Code[20]) { }
          field(2; Level; Integer) { }
        }
        procedure Bump(V: Integer)
        begin
          Validate(Level, V);
        end;
        procedure Validate(FieldNo: Integer; NewValue: Integer)
        begin
        end;
      }`;
      expect(specsForProject([table])).toEqual([]);
    });

    it("REFUSES the implicit-receiver form when a tableextension of the enclosing table declares Validate", () => {
      const table = `table 50218 "Data Trigger Probe Test 4" {
        fields {
          field(1; "No."; Code[20]) { }
          field(2; Level; Integer) { }
        }
        procedure Bump(V: Integer)
        begin
          Validate(Level, V);
        end;
      }`;
      const tableExtension = `tableextension 50219 "Ext Declares Validate" extends "Data Trigger Probe Test 4" {
        procedure Validate(FieldNo: Integer; NewValue: Integer)
        begin
        end;
      }`;
      expect(specsForProject([table, tableExtension])).toEqual([]);
    });

    it("still CLAIMS the implicit-receiver form when nothing declares such a procedure", () => {
      const table = `table 50220 "Data Trigger Probe Test 5" {
        fields {
          field(1; "No."; Code[20]) { }
          field(2; Level; Integer) { }
        }
        procedure Bump(V: Integer)
        begin
          Validate(Level, V);
        end;
      }`;
      const specs = specsForProject([table]);
      expect(specs.map((s) => s.before.text)).toEqual(["Validate(Level, V)"]);
    });
  });
});
