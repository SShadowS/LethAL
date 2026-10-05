import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `SwapModifyFlag` — rewrite `<rec>.Modify(true)` -> `<rec>.Modify(false)`.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table + §4 intro.
 * `claimsRecordMethod` itself is exhaustively tested in `receiver.test.ts`; this file exercises
 * the operator's own guards, and — the point of this operator — that it claims a site in an
 * `if`'s then-branch, NOT just statement position.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type ArmEvaluation,
  type SemanticContext,
  buildSemanticContext,
  evaluateArms,
  findAll,
  initParser,
  isStatementPosition,
} from "@lethal/engine";
import { isHarmlessTriggerCall } from "../src/forced-trigger-raise";
import { swapModifyFlag } from "../src/swap-modify-flag";
import { contextFor, parseClean, projectContextFor } from "./parse-clean";

/**
 * `parseClean` rather than a bare `parseAL`: most assertions below are REFUSALS, and a snippet
 * that failed to parse would produce no `call_expression` at all — the operator would "refuse" it
 * whatever its guards did.
 */
function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => swapModifyFlag.targets(n, ctx))
    .flatMap((n) => swapModifyFlag.generate(n, ctx));
}

/** Same walk as `specsFor`, but with an extra `isStatementPosition` guard spliced in — used only
 * by the red-check test below to prove the then-branch case depends on NOT having that guard. */
function specsForWithStatementPositionGuard(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => isStatementPosition(n) && swapModifyFlag.targets(n, ctx))
    .flatMap((n) => swapModifyFlag.generate(n, ctx));
}

describe("swapModifyFlag", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("rewrites Modify(true) to Modify(false) in statement position", () => {
    const src = `codeunit 50140 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.Modify(true)"]);
    const [spec] = specs;
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.after.text).toBe("Cust.Modify(false)");
    expect(spec.operatorName).toBe("lethal.swap-modify-flag");
  });

  it("claims Modify(true) sitting as an if's then-branch — NOT statement position", () => {
    const src = `codeunit 50141 "C" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then Cust.Modify(true); end; }`;
    const calls: ALSyntaxNode[] = findAll(parseClean(src), ALNodeKind.procedure_call);
    const modifyCall = calls.find((n) => n.text.startsWith("Cust.Modify"));
    expect(modifyCall).toBeDefined();
    if (modifyCall === undefined) return;
    // The load-bearing structural fact this operator exists for: this call is
    // NOT in statement position (it's the un-braced then-branch of an if), yet
    // SwapModifyFlag must still claim it.
    expect(isStatementPosition(modifyCall)).toBe(false);

    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.Modify(true)"]);
    expect(specs[0]?.after.text).toBe("Cust.Modify(false)");
  });

  it("RED-CHECK: restricting to statement position drops the then-branch site", () => {
    const src = `codeunit 50142 "C" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then Cust.Modify(true); end; }`;
    // Un-restricted: claims the site.
    expect(specsFor(src).map((s) => s.before.text)).toEqual(["Cust.Modify(true)"]);
    // Restricted to statement position (the mistake this operator must NOT make):
    // the site is dropped entirely.
    expect(specsForWithStatementPositionGuard(src)).toEqual([]);
  });

  it("claims the implicit-receiver form inside a table trigger body", () => {
    const src = `table 50143 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin Modify(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Modify(true)"]);
    expect(specs[0]?.after.text).toBe("Modify(false)");
  });

  it("REFUSES Modify(SomeBoolean) — literal true only, never a variable", () => {
    const src = `codeunit 50144 "C" { procedure P() var Cust: Record Customer; SomeBoolean: Boolean; begin Cust.Modify(SomeBoolean); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES Modify() — no argument, so no literal true to swap", () => {
    const src = `codeunit 50145 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES Modify(false) — already the mutated value", () => {
    const src = `codeunit 50146 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(false); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES a receiver that resolves to a non-record (Validator.Modify)", () => {
    const src = `codeunit 50147 "C" { procedure P() var Validator: Codeunit "My Validator"; begin Validator.Modify(true); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("handles case variants: Modify(TRUE)", () => {
    const src = `codeunit 50148 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(TRUE); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.Modify(TRUE)"]);
    expect(specs[0]?.after.text).toBe("Cust.Modify(false)");
  });

  it("handles case variants: MODIFY(True)", () => {
    const src = `codeunit 50149 "C" { procedure P() var Cust: Record Customer; begin Cust.MODIFY(True); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.MODIFY(True)"]);
    expect(specs[0]?.after.text).toBe("Cust.MODIFY(false)");
  });

  /**
   * The grammar emits comments as **named** children of an `argument_list`, so a sole-argument
   * check reading `namedChildren.length === 1` sees two children and refuses. Here that is only a
   * missed site (the safe direction); in `RemoveSetRange` the identical blindness produced an
   * INVERTED mutation. Both operators now read the argument list through one shared helper
   * (`src/mutate-helpers.ts`) so they cannot drift apart on this grammar fact.
   */
  it("claims Modify(true) with a block comment inside the parentheses", () => {
    const src = `codeunit 50150 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(true /* run the trigger */); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.Modify(true /* run the trigger */)"]);
    expect(specs[0]?.after.text).toBe("Cust.Modify(false /* run the trigger */)");
  });

  it("claims Modify(true) with a trailing line comment on a multi-line call", () => {
    const src = `codeunit 50151 "C"
{
    procedure P()
    var
        Cust: Record Customer;
    begin
        Cust.Modify(
            true  // run the trigger
        );
    end;
}`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toContain("false");
    expect(specs[0]?.after.text).toContain("// run the trigger");
  });

  it("REFUSES Modify(false) even with a comment — still no literal true to swap", () => {
    // The counterweight: seeing through comments must not become "ignore what the argument is".
    const src = `codeunit 50152 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(false /* deliberate */); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  describe("parentContext hint", () => {
    /**
     * Nothing downstream branches on the hint (it is validated and reported), which is exactly why
     * it must not be allowed to drift into a lie: this operator deliberately claims sites that
     * `isStatementPosition` measures as false, so hardcoding `"statement-position"` there would
     * have every such spec assert something the AST contradicts.
     */
    it("says statement-position for a statement-position site", () => {
      const src = `codeunit 50153 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(true); end; }`;
      expect(specsFor(src).map((s) => s.parentContext)).toEqual(["statement-position"]);
    });

    it("says expression-position for an if's then-branch", () => {
      const src = `codeunit 50154 "C" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then Cust.Modify(true); end; }`;
      expect(specsFor(src).map((s) => s.parentContext)).toEqual(["expression-position"]);
    });

    it("says expression-position when the Boolean return is assigned", () => {
      const src = `codeunit 50155 "C" { procedure P() var Cust: Record Customer; Ok: Boolean; begin Ok := Cust.Modify(true); end; }`;
      expect(specsFor(src).map((s) => s.parentContext)).toEqual(["expression-position"]);
    });

    it("says expression-position inside an if condition", () => {
      const src = `codeunit 50156 "C" { procedure P() var Cust: Record Customer; begin if not Cust.Modify(true) then exit; end; }`;
      expect(specsFor(src).map((s) => s.parentContext)).toEqual(["expression-position"]);
    });
  });
});

describe("swap-modify-flag extension to Insert/Delete (R136)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("claims Insert(true) and Delete(true) on a proven record receiver", () => {
    const src = `codeunit 50157 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Insert(true);
        Rec.Delete(true);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.Insert(true)", "Rec.Delete(true)"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.Insert(false)", "Rec.Delete(false)"]);
  });

  /**
   * The implicit-receiver form (`Rec` implicit inside a table's own code) was only ever exercised
   * for `Modify` (the pre-existing test above, "claims the implicit-receiver form inside a table
   * trigger body"). Nothing proved the R136 extension's two new method names claim that form too,
   * so this pins both directly.
   */
  it("claims the implicit-receiver form of Insert(true) inside a table trigger body", () => {
    const src = `table 50165 "T1" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin Insert(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Insert(true)"]);
    expect(specs[0]?.after.text).toBe("Insert(false)");
  });

  it("claims the implicit-receiver form of Delete(true) inside a table trigger body", () => {
    const src = `table 50166 "T2" { fields { field(1; "No."; Code[20]) { } } trigger OnDelete() begin Delete(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Delete(true)"]);
    expect(specs[0]?.after.text).toBe("Delete(false)");
  });

  it("still refuses Insert(false): the direction is true->false only", () => {
    const src = `codeunit 50158 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Insert(false);
        Rec.Insert();
        Rec.Insert(true, true);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("reports version 1.2.0 so existing Modify mutant identities do not move", () => {
    // R165 bumped 1.1.0 -> 1.2.0 for the forward direction. MINOR either time, and the reason is
    // the same: the operator GAINED sites and changed nothing about the mutants it already emitted,
    // so `design.md` §5.1's history reset (MAJOR only) must not fire.
    expect(swapModifyFlag.version).toBe("1.2.0");
    const src = `codeunit 50159 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Modify(true);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    const only = specs[0];
    expect(only?.operatorVersion).toBe("1.2.0");
  });

  /**
   * Section 2.5 of the R136 trio spec: a shadowing refusal test built over a single-file context
   * passes even if the shadowing guard were deleted, because `claimsRecordMethod`'s project-
   * declared-procedure rule can only fire over a context built across the WHOLE project. Each new
   * method name this task adds (`Insert`, `Delete`) therefore gets its own refusal proven over a
   * `projectContextFor` context, with a "still CLAIMS" counterweight so the refusal cannot be
   * satisfied by something unrelated going wrong across the file boundary.
   */
  describe("shadowing refusal across files, per new method name", () => {
    function specsForProject(sources: readonly string[]) {
      const roots = sources.map((s) => parseClean(s));
      const ctx: SemanticContext = projectContextFor(roots);
      const calls: ALSyntaxNode[] = roots.flatMap((root) =>
        findAll(root, ALNodeKind.procedure_call),
      );
      return calls
        .filter((n) => swapModifyFlag.targets(n, ctx))
        .flatMap((n) => swapModifyFlag.generate(n, ctx));
    }

    function caller(method: string, table: string): string {
      return `codeunit 50160 "C" { procedure P() var Other: Record "${table}"; begin Other.${method}(true); end; }`;
    }

    it("REFUSES Insert(true) when the project declares its own Insert on the table", () => {
      const table = `table 50161 "Other Table" { fields { field(1; "No."; Code[20]) { } } procedure Insert(RunTrigger: Boolean): Boolean begin end; }`;
      expect(specsForProject([caller("Insert", "Other Table"), table])).toEqual([]);
    });

    it("still CLAIMS Insert(true) across files when the table declares no such procedure", () => {
      const table = `table 50162 "Plain Table" { fields { field(1; "No."; Code[20]) { } } }`;
      const specs = specsForProject([caller("Insert", "Plain Table"), table]);
      expect(specs.map((s) => s.before.text)).toEqual(["Other.Insert(true)"]);
    });

    it("REFUSES Delete(true) when the project declares its own Delete on the table", () => {
      const table = `table 50163 "Other Table 2" { fields { field(1; "No."; Code[20]) { } } procedure Delete(RunTrigger: Boolean): Boolean begin end; }`;
      expect(specsForProject([caller("Delete", "Other Table 2"), table])).toEqual([]);
    });

    it("still CLAIMS Delete(true) across files when the table declares no such procedure", () => {
      const table = `table 50164 "Plain Table 2" { fields { field(1; "No."; Code[20]) { } } }`;
      const specs = specsForProject([caller("Delete", "Plain Table 2"), table]);
      expect(specs.map((s) => s.before.text)).toEqual(["Other.Delete(true)"]);
    });
  });
});

// R138. `Insert(false)` can kill through a PLATFORM error rather than an assertion: with `OnInsert`
// skipped, a table whose `OnInsert` assigns the primary key leaves that key blank, the first
// blank-key insert succeeds and a second raises a duplicate primary key. The mutant is scored
// `killed` and the suite did not earn it. `Modify` has no such shape. `Delete` does since R281 (an
// `OnDelete` that deletes or writes other rows), so its mutants declare their own mechanism.
//
// The ruling and its cost are pre-committed in
// docs/superpowers/specs/2026-08-14-r138-insert-mechanism-precommitment.md.
describe("swap-modify-flag platform-kill mechanism (R138)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("declares run-trigger-skipped-insert on an Insert mutant", () => {
    const src = `codeunit 50170 "T" { procedure P() var Rec: Record Customer; begin Rec.Insert(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.Insert(true)"]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  // R281 FLIPPED THIS TEST. It used to pin "declares NOTHING on a Delete mutant", on R138's ruling
  // that skipping `OnDelete` only writes less. An `OnDelete` that deletes child rows breaks that: the
  // children stay and a later insert of one collides. A base-app `Record Customer` cannot be read,
  // so harmlessness is not proven and the tag stays.
  it("declares run-trigger-skipped-delete on a Delete mutant whose table it cannot resolve (R281)", () => {
    const src = `codeunit 50171 "T" { procedure P() var Rec: Record Customer; begin Rec.Delete(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.Delete(true)"]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-delete");
  });

  it("declares NOTHING on a Modify mutant", () => {
    const src = `codeunit 50172 "T" { procedure P() var Rec: Record Customer; begin Rec.Modify(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.Modify(true)"]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });

  // All three in one walk, so a change that tags by position, by order, or by "the first match
  // wins" rather than by the matched method name fails here.
  it("tags Insert and Delete by their own mechanism, and never Modify, in one procedure", () => {
    const src = `codeunit 50173 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Modify(true);
        Rec.Insert(true);
        Rec.Delete(true);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual([
      "Rec.Modify(true)",
      "Rec.Insert(true)",
      "Rec.Delete(true)",
    ]);
    expect(specs.map((s) => s.platformKillMechanism)).toEqual([
      undefined,
      "run-trigger-skipped-insert",
      "run-trigger-skipped-delete",
    ]);
  });

  // AL is case-insensitive, and the fixture's own `MODIFY(TRUE)` arm exists because a case-sensitive
  // method comparison is a real way to get this wrong. The tag must not depend on the spelling.
  it("tags a case-variant INSERT(True) exactly as it tags Insert(true)", () => {
    const src = `codeunit 50174 "T" { procedure P() var Rec: Record Customer; begin Rec.INSERT(True); end; }`;
    const specs = specsFor(src);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  // R143 CHANGED THIS CASE, deliberately. The implicit receiver resolves to the table itself, so
  // the detector can now READ that table's `OnInsert` — and this one assigns the key, so the tag
  // stays. The sibling below is the same shape with a trigger that does not, which is the mutant
  // R143 removed from the screen.
  it("tags the implicit-receiver form inside a table whose OnInsert assigns the key", () => {
    const src = `table 50175 "T3" { fields { field(1; "No."; Code[20]) { } } keys { key(PK; "No.") { } } trigger OnInsert() begin "No." := 'K'; Insert(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Insert(true)"]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-insert");
  });

  it("does NOT tag the implicit-receiver form when that table's OnInsert leaves the key alone", () => {
    const src = `table 50176 "T4" { fields { field(1; "No."; Code[20]) { } field(2; Flag; Boolean) { } } keys { key(PK; "No.") { } } trigger OnInsert() begin Flag := true; Insert(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Insert(true)"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Insert(false)"]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });
});

// R281. `Delete(true)` -> `Delete(false)` skips `OnDelete`. When that trigger deletes or writes other
// rows (child lines, a log row), they are left behind, and a later insert of one can hit a
// duplicate key that no test asserted. The tag is kept unless the table is resolved and skipping
// its delete code is PROVEN harmless; each test below names the revert that turns it red.
describe("swap-modify-flag Delete mechanism (R281)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const KID = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } }`;
  const CALLER = `codeunit 50301 "Ops" { procedure P() var Par: Record "Par"; begin Par.Delete(true); end; }`;
  const par = (members: string): string =>
    `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } }\n    keys { key(PK; "No.") { } }\n${members}}\n`;

  /** The tag on the one `Par.Delete(true)` mutant. `symbols` null: no arm map (no `#if` read). */
  function deleteTag(
    files: Readonly<Record<string, string>>,
    symbols: readonly string[] | null = null,
  ): string | undefined {
    const parsed = Object.entries(files).map(([path, text]) => ({
      path,
      text,
      root: parseClean(text),
    }));
    const arms =
      symbols === null
        ? undefined
        : new Map<ALSyntaxNode, ArmEvaluation>(
            parsed.map((p) => [p.root, evaluateArms(p.root, p.text, symbols)]),
          );
    const ctx = buildSemanticContext(
      parsed.map(({ path, root }) => ({ path, root })),
      arms,
    );
    const specs = parsed
      .flatMap((p) => findAll(p.root, ALNodeKind.procedure_call))
      .filter((n) => n.text === "Par.Delete(true)" && swapModifyFlag.targets(n, ctx))
      .flatMap((n) => swapModifyFlag.generate(n, ctx));
    expect(specs.map((s) => s.after.text)).toEqual(["Par.Delete(false)"]);
    return specs[0]?.platformKillMechanism;
  }

  const onDelete = (vars: string, body: string): string =>
    `    trigger OnDelete()\n    ${vars}\n    begin\n${body}\n    end;\n`;
  const KID_VAR = `var Kid: Record "Kid";`;

  // Revert: return false whenever an OnDelete exists.
  it("tags an OnDelete that DeleteAll()s child rows", () => {
    const t = par(onDelete(KID_VAR, `Kid.SetRange("Parent No.", "No."); Kid.DeleteAll();`));
    expect(deleteTag({ "P.al": t, "K.al": KID, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Revert: drop the Rec-only receiver check (allow Modify/Delete on any record).
  it("tags an OnDelete that Delete()s ANOTHER record", () => {
    const t = par(onDelete(KID_VAR, "if Kid.FindFirst() then Kid.Delete();"));
    expect(deleteTag({ "P.al": t, "K.al": KID, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Revert: always true.
  it("does NOT tag an OnDelete of only TestField, Error and Rec.Modify", () => {
    const t = par(onDelete("", `TestField("No."); if "No." = 'X' then Error('no'); Rec.Modify();`));
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBeUndefined();
  });

  it("does NOT tag a resolved table with no OnDelete", () => {
    expect(deleteTag({ "P.al": par(""), "O.al": CALLER })).toBeUndefined();
  });

  // Revert: unresolved returns false.
  it("tags a receiver whose table is not in the project", () => {
    const caller = `codeunit 50301 "Ops" { procedure P() var Par: Record Customer; begin Par.Delete(true); end; }`;
    expect(deleteTag({ "O.al": caller })).toBe("run-trigger-skipped-delete");
  });

  // Revert: allow every call that is not a write method.
  it("tags an OnDelete that calls an unknown procedure", () => {
    const t = par(`${onDelete("", "CleanUp();")}    local procedure CleanUp() begin end;\n`);
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  // Revert: treat a statement-level call without parentheses as harmless (skip it in the walk).
  it("tags an OnDelete whose writes are written without parentheses", () => {
    const deleteAll = par(onDelete(KID_VAR, "Kid.DeleteAll;"));
    expect(deleteTag({ "P.al": deleteAll, "K.al": KID, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
    const cleanUp = par(`${onDelete("", "CleanUp;")}    local procedure CleanUp() begin end;\n`);
    expect(deleteTag({ "P.al": cleanUp, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  // Revert: match the bare name instead of using claimsRecordMethod.
  it("tags an allow-listed name the table declares itself (its own Reset)", () => {
    const t = par(`${onDelete("", "Reset();")}    procedure Reset() begin end;\n`);
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  it("tags an allow-listed name called on a codeunit (Mgt.Get())", () => {
    const mgt = `codeunit 50303 "Mgt" { procedure Get() begin end; }`;
    const t = par(onDelete(`var Mgt: Codeunit "Mgt";`, "Mgt.Get();"));
    expect(deleteTag({ "P.al": t, "M.al": mgt, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Revert: drop the subscriber check.
  it("tags a table with no OnDelete when the project subscribes to its delete event", () => {
    const sub = `codeunit 50304 "Sub" {\n  [EventSubscriber(ObjectType::Table, Database::"Par", 'OnAfterDeleteEvent', '', false, false)]\n  local procedure X(var Rec: Record "Par"; RunTrigger: Boolean) begin end;\n}`;
    expect(deleteTag({ "P.al": par(""), "S.al": sub, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Revert: drop the tableextension check.
  it("tags a table with no OnDelete when a project tableextension has OnBeforeDelete", () => {
    const ext = `tableextension 50305 "Par Ext" extends "Par" { trigger OnBeforeDelete() begin end; }`;
    expect(deleteTag({ "P.al": par(""), "X.al": ext, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Revert: stop skipping inactive calls.
  it("#if: a write only in an INACTIVE arm does not tag", () => {
    const t = par(
      onDelete(KID_VAR, `#if X\n        Kid.DeleteAll();\n#endif\n        TestField("No.");`),
    );
    expect(deleteTag({ "P.al": t, "K.al": KID, "O.al": CALLER }, [])).toBeUndefined();
  });

  it("#if: the same write in an ACTIVE arm tags", () => {
    const t = par(
      onDelete(KID_VAR, `#if X\n        Kid.DeleteAll();\n#endif\n        TestField("No.");`),
    );
    expect(deleteTag({ "P.al": t, "K.al": KID, "O.al": CALLER }, ["X"])).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Revert: drop the R378 undecided-file check. In an undecided file `liveMembers` does not find a
  // trigger inside `#if`, so without the check the table reads as "no OnDelete" and loses the tag.
  it("#if: an UNDECIDED table file tags", () => {
    const t = par(`#if and\n${onDelete(KID_VAR, "Kid.DeleteAll();")}#endif\n`);
    expect(deleteTag({ "P.al": t, "K.al": KID, "O.al": CALLER }, ["X"])).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Final review fix 1. Revert: drop the `with_statement` check in `isHarmlessTriggerCall`. The
  // bare `Delete()` reads as an implicit-`Rec` call, but `with` makes it delete a Kid row.
  it("tags a Delete() inside `with Kid do` (another record's row)", () => {
    const t = par(onDelete(KID_VAR, "with Kid do Delete();"));
    expect(deleteTag({ "P.al": t, "K.al": KID, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Final review fix 2. Revert: accept only a `string_literal` event name. alc 18.0.43 (Linux)
  // compiles the unquoted `OnAfterDeleteEvent` and refuses an unknown unquoted name with AL0280,
  // measured 2026-10-05, so this form is real AL.
  it("tags a table whose delete subscriber names the event unquoted", () => {
    const sub = `codeunit 50304 "Sub" {\n  [EventSubscriber(ObjectType::Table, Database::Par, OnAfterDeleteEvent, '', false, false)]\n  local procedure X(var Rec: Record "Par"; RunTrigger: Boolean) begin end;\n}`;
    expect(deleteTag({ "P.al": par(""), "S.al": sub, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // Final review fix 4. Revert: drop the project-procedure identifier check. A parenthesis-less
  // call used as a value looks like a variable to the grammar.
  it("tags an OnDelete that calls a table procedure without parentheses, as a value", () => {
    const t = par(
      `${onDelete("", "if CleanUpChildren then Error('x');")}    local procedure CleanUpChildren(): Boolean begin end;\n`,
    );
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  // Final review fix 3 (for R-213). Revert: one own-row allow-list for every trigger kind.
  it("isHarmlessTriggerCall: Rec.Delete() is harmless for OnDelete, not for OnModify", () => {
    const root = parseClean(par(onDelete("", "Rec.Delete();")));
    const ctx = contextFor(root);
    const call = findAll(root, ALNodeKind.procedure_call).find((c) => c.text === "Rec.Delete()");
    if (call === undefined) throw new Error("no Rec.Delete() call");
    expect(isHarmlessTriggerCall(call, ctx, "delete")).toBe(true);
    expect(isHarmlessTriggerCall(call, ctx, "modify")).toBe(false);
  });
});
