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

  // R463 (kept by R-254 review R-254-001): a site inside a `reportextension` is never claimed, even
  // where Tier-1's RunTrigger tag now treats its receiver as unresolved. Control: the codeunit above.
  it("does NOT claim Insert/Modify/Delete inside a reportextension", () => {
    const src = `reportextension 50158 "RX" extends "Base"
    {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Insert(true);
        Rec.Modify(true);
        Rec.Delete(true);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
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

  // R-452 FLIPPED THIS TEST (M1). It pinned R138's "declares NOTHING on a Modify mutant". An
  // `OnModify` that writes other rows leaves them unwritten when skipped, the same route as R281's
  // `Delete`, and a base-app `Record Customer` cannot be read. Revert: drop the Modify arm.
  it("declares run-trigger-skipped-modify on a Modify mutant whose table it cannot resolve", () => {
    const src = `codeunit 50172 "T" { procedure P() var Rec: Record Customer; begin Rec.Modify(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.Modify(true)"]);
    expect(specs[0]?.platformKillMechanism).toBe("run-trigger-skipped-modify");
  });

  // All three in one walk, so a change that tags by position, by order, or by "the first match
  // wins" rather than by the matched method name fails here.
  it("tags Modify, Insert and Delete each by its own mechanism, in one procedure", () => {
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
      "run-trigger-skipped-modify",
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
    // R-476: the site sits in a procedure, not in `OnInsert`: an `Insert` inside `OnInsert` is a
    // write there, which R-452's cut keeps tagged.
    const src = `table 50176 "T4" { fields { field(1; "No."; Code[20]) { } field(2; Flag; Boolean) { } } keys { key(PK; "No.") { } } trigger OnInsert() begin Flag := true; end; procedure P() begin Insert(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Insert(true)"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Insert(false)"]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });
});

/**
 * The tag on the one `<call>(true)` mutant across `files` (one context, like the orchestrator).
 * `symbols` null: no arm map (no `#if` read).
 */
function skipTag(
  files: Readonly<Record<string, string>>,
  call: string,
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
    .filter((n) => n.text === `${call}(true)` && swapModifyFlag.targets(n, ctx))
    .flatMap((n) => swapModifyFlag.generate(n, ctx));
  expect(specs.map((s) => s.after.text)).toEqual([`${call}(false)`]);
  return specs[0]?.platformKillMechanism;
}

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
  const deleteTag = (
    files: Readonly<Record<string, string>>,
    symbols: readonly string[] | null = null,
  ): string | undefined => skipTag(files, "Par.Delete", symbols);

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

  // Revert: always true. The drop control: only Error and TestField, nothing that writes.
  it("does NOT tag an OnDelete of only TestField and Error", () => {
    const t = par(onDelete("", `TestField("No."); if "No." = 'X' then Error('no');`));
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBeUndefined();
  });

  // R-452 rule D (sol plan r1 finding 1, post-merge finding 1). Own record is not own row, and a
  // RunTrigger=true write runs a trigger nobody read, so no Modify/Delete is ever harmless.
  // Revert for each: restore R281's own-row allow-list (`OWN_ROW_WRITES` + `onOwnRecord`).
  it("rule D: tags an OnDelete that loads another row into xRec and deletes it", () => {
    const t = par(onDelete("", "xRec.Get('X'); xRec.Delete();"));
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  it("rule D: tags an OnDelete that calls Rec.Modify(true), which runs OnModify", () => {
    const t = par(onDelete("", "Rec.Modify(true);"));
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  it("rule D: tags an OnDelete that calls Rec.Modify() (the R281 drop this flips)", () => {
    const t = par(onDelete("", "Rec.Modify();"));
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  // sol plan r2 finding 6: one rejection per write, transaction or Run method, each on its own so
  // no call keeps the tag for another. Revert: add the method to `NON_WRITING_RECORD_METHODS` (or,
  // for the unqualified system calls, to `NON_WRITING_SYSTEM_CALLS`).
  const KID_PAR = `var Kid: Record "Kid"; Num: Integer;`;
  for (const body of [
    "Kid.Insert();",
    "Kid.Rename('X');",
    `Kid.ModifyAll("Parent No.", 'X');`,
    "Kid.DeleteAll();",
    `Kid.Validate("Parent No.", 'X');`,
    "Kid.LockTable();",
    "Commit();",
    "Codeunit.Run(50303);",
    "Report.Run(50303);",
    "Page.Run(50303);",
  ]) {
    it(`rejects \`${body}\` in OnDelete`, () => {
      const t = par(onDelete(KID_PAR, body));
      expect(deleteTag({ "P.al": t, "K.al": KID, "O.al": CALLER })).toBe(
        "run-trigger-skipped-delete",
      );
    });
  }

  // Post-merge finding 2, split headers. Revert: collect raw `procedure` names only.
  it("tags an OnDelete that calls a SPLIT-HEADER table procedure without parentheses", () => {
    const split =
      "#if X\n    local procedure CleanUpChildren(): Boolean\n#else\n    local procedure CleanUpChildren(A: Integer): Boolean\n#endif\n    begin\n    end;\n";
    const t = par(`${onDelete("", "if CleanUpChildren then Error('x');")}${split}`);
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  // Post-merge finding 2, the receiver. `Mgt.Flag` is a codeunit procedure called without
  // parentheses, whose name is also a field of Par itself. Revert: accept any receiver whose member
  // names a field, not only the own `Rec`/`xRec` (R281's rule).
  it("tags a parenthesis-less Mgt.Flag even when Flag is also the table's own field", () => {
    const mgt = `codeunit 50303 "Mgt" { procedure Flag(): Boolean var K: Record "Kid"; begin K.DeleteAll(); exit(true); end; }`;
    const p = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; Flag; Boolean) { } }\n    keys { key(PK; "No.") { } }\n${onDelete(`var Mgt: Codeunit "Mgt";`, "if Mgt.Flag then Error('x');")}}\n`;
    expect(deleteTag({ "P.al": p, "K.al": KID, "M.al": mgt, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // The same finding through the own record: `Rec.Archive` names no field of Par (it can only be a
  // procedure from another app's tableextension of Par), only a field of Kid. Revert: accept a field
  // of any project table.
  it("tags a parenthesis-less Rec.Archive whose name is only another table's field", () => {
    const kid = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } field(2; Archive; Boolean) { } } }`;
    const t = par(onDelete("", "if Rec.Archive then Error('x');"));
    expect(deleteTag({ "P.al": t, "K.al": kid, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // The drop control for the strict field read: `Rec.<own field>` and `xRec.<own field>`.
  // Revert: refuse every bare member read.
  it("does NOT tag an OnDelete that reads its own fields through Rec and xRec", () => {
    const t = par(onDelete("", `if Rec."No." <> xRec."No." then Error('x');`));
    expect(deleteTag({ "P.al": t, "O.al": CALLER })).toBeUndefined();
  });

  // sol plan r2 finding 1. alc 18.0.43 (Linux) compiles a trigger-local `Rec: Record "Kid"` in a
  // table trigger, and `Rec.CleanUp` then binds to the LOCAL (a type probe: Kid.CleanUp returning
  // Integer against Par's Boolean field gives AL0122). So the spelling `Rec` proves nothing.
  // Revert: accept a `Rec`/`xRec` receiver by spelling, without the binding check.
  it("tags a bare Rec.CleanUp when a trigger-local Rec of another table shadows the own record", () => {
    const kid = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } procedure CleanUp(): Boolean var K: Record "Kid"; begin K.DeleteAll(); exit(true); end; }`;
    const p = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; CleanUp; Boolean) { } }\n    keys { key(PK; "No.") { } }\n${onDelete(`var Rec: Record "Kid";`, "if Rec.CleanUp then Error('x');")}}\n`;
    expect(deleteTag({ "P.al": p, "K.al": kid, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // sol final r1 finding 4: the GLOBAL half of the binding check, on its own. alc 18.0.43 refuses a
  // table global named `Rec` (AL0155, already defined), so this shape does not compile today; the
  // test pins the guard against the engine's var-ref resolution, not against a real program.
  // Revert: drop `resolveVarRef` from `ownFieldRead`.
  it("tags a bare Rec.CleanUp when a GLOBAL Rec of another table shadows the own record", () => {
    const kid = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } procedure CleanUp(): Boolean var K: Record "Kid"; begin K.DeleteAll(); exit(true); end; }`;
    const p = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; CleanUp; Boolean) { } field(3; Done; Boolean) { } }\n    keys { key(PK; "No.") { } }\n    var\n        Rec: Record "Kid";\n${onDelete("", "if Rec.CleanUp then Done := true;")}}\n`;
    expect(deleteTag({ "P.al": p, "K.al": kid, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // sol final r1 finding 1. A parenthesis-less call inside `with` binds to the `with` record, and
  // only a call with parentheses met the `with` check. No other statement keeps the tag here.
  // Revert: drop the `with_statement` check in `onlyHarmlessCalls`.
  it("tags a parenthesis-less call inside `with Kid do` in OnDelete", () => {
    const kid = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } procedure CleanUpChildren(): Boolean var K: Record "Kid"; begin K.DeleteAll(); exit(true); end; }`;
    const t = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; Done; Boolean) { } }\n    keys { key(PK; "No.") { } }\n${onDelete(KID_VAR, "with Kid do if CleanUpChildren then Done := true;")}}\n`;
    expect(deleteTag({ "P.al": t, "K.al": kid, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
  });

  // sol final r1 finding 2. A same-project tableextension wrapped whole in `#if` is not indexed, so
  // its procedures were not table procedures. Revert: drop the unindexed-extension check.
  it("tags a parenthesis-less call to a procedure of an #if-wrapped project tableextension", () => {
    const ext = `#if X\ntableextension 50305 "Par Ext" extends "Par"\n{\n    procedure CleanUpChildren(): Boolean\n    begin\n        exit(true);\n    end;\n}\n#endif\n`;
    const t = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; Done; Boolean) { } }\n    keys { key(PK; "No.") { } }\n${onDelete("", "if CleanUpChildren then Done := true;")}}\n`;
    expect(deleteTag({ "P.al": t, "X.al": ext, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
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
  // R-452: `ExtCleanUp;` is declared nowhere in the project (another app's tableextension of Par),
  // so the table-procedure identifier check cannot also catch it, as it did the old `CleanUp;`.
  it("tags an OnDelete whose writes are written without parentheses", () => {
    const deleteAll = par(onDelete(KID_VAR, "Kid.DeleteAll;"));
    expect(deleteTag({ "P.al": deleteAll, "K.al": KID, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
    const cleanUp = par(onDelete("", "ExtCleanUp;"));
    expect(deleteTag({ "P.al": cleanUp, "O.al": CALLER })).toBe("run-trigger-skipped-delete");
  });

  // Post-merge weak test (a): the old version called the table's OWN `Reset`, which the
  // table-procedure identifier check also refuses, so it passed with this guard gone. `Other` is a
  // second project table that declares a writing `Reset`, so only `claimsRecordMethod` refuses it.
  // Revert: accept a NON_WRITING_RECORD_METHODS name without asking `claimsRecordMethod`.
  it("tags an allow-listed name another project table declares itself (Other.Reset())", () => {
    const other = `table 50306 "Other" { fields { field(1; "No."; Code[20]) { } } procedure Reset() var K: Record "Kid"; begin K.DeleteAll(); end; }`;
    const t = par(onDelete(`var Other: Record "Other";`, "Other.Reset();"));
    expect(deleteTag({ "P.al": t, "X.al": other, "K.al": KID, "O.al": CALLER })).toBe(
      "run-trigger-skipped-delete",
    );
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

  // Final review fix 1, re-aimed by sol plan r2 finding 2. Revert: drop BOTH `with_statement`
  // checks (since sol final r1, `onlyHarmlessCalls` refuses any live `with` too; the
  // `isHarmlessTriggerCall` one is pinned on its own below). Rule D refuses every `Delete()`, so the old `with Kid do Delete()`
  // stayed tagged without the guard. `Reset` is otherwise allow-listed (Par declares none), and
  // `with` binds it to Kid, whose own `Reset` deletes rows.
  it("tags an allow-listed Reset() inside `with Kid do` (Kid's own writing Reset)", () => {
    const kid = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } procedure Reset() var K: Record "Kid"; begin K.DeleteAll(); end; }`;
    const t = par(onDelete(KID_VAR, "with Kid do Reset();"));
    expect(deleteTag({ "P.al": t, "K.al": kid, "O.al": CALLER })).toBe(
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

  // R-452 rule D replaces R281's per-trigger own-row allow-list. Revert: restore it.
  it("isHarmlessTriggerCall: no own-record Modify or Delete is harmless", () => {
    const root = parseClean(par(onDelete("", "Rec.Delete(); xRec.Modify(); Modify(false);")));
    const ctx = contextFor(root);
    const calls = findAll(root, ALNodeKind.procedure_call);
    expect(calls.map((c) => c.text)).toEqual(["Rec.Delete()", "xRec.Modify()", "Modify(false)"]);
    expect(calls.map((c) => isHarmlessTriggerCall(c, ctx))).toEqual([false, false, false]);
  });

  // The exported helper's own `with` refusal, now that `onlyHarmlessCalls` also refuses a live
  // `with`. Revert: drop the `with_statement` check in `isHarmlessTriggerCall`.
  it("isHarmlessTriggerCall: an allow-listed Reset() inside `with` is not harmless", () => {
    const root = parseClean(par(onDelete(KID_VAR, "with Kid do Reset(); Reset();")));
    const ctx = contextFor(root);
    const calls = findAll(root, ALNodeKind.procedure_call);
    expect(calls.map((c) => c.text)).toEqual(["Reset()", "Reset()"]);
    expect(calls.map((c) => isHarmlessTriggerCall(c, ctx))).toEqual([false, true]);
  });
});

// R-452. `Modify(true)` -> `Modify(false)` skips `OnModify` (its events still fire, RunTrigger false). The
// same refusal detector as R281's `Delete`, with the modify trigger, events and extension triggers.
// Each test names the revert that turns it red.
describe("swap-modify-flag Modify mechanism (R-452)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const KID = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } procedure Reset() var K: Record "Kid"; begin K.DeleteAll(); end; }`;
  const CALLER = `codeunit 50301 "Ops" { procedure P() var Par: Record "Par"; begin Par.Modify(true); end; }`;
  const par = (members: string): string =>
    `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; Amount; Decimal) { } }\n    keys { key(PK; "No.") { } }\n${members}}\n`;
  const onModify = (vars: string, body: string): string =>
    `    trigger OnModify()\n    ${vars}\n    begin\n${body}\n    end;\n`;
  const KID_VAR = `var Kid: Record "Kid";`;
  const MOD = "run-trigger-skipped-modify";
  const tag = (
    files: Readonly<Record<string, string>>,
    symbols: readonly string[] | null = null,
  ): string | undefined => skipTag(files, "Par.Modify", symbols);

  // M2. Revert: always tag.
  it("does NOT tag an OnModify of own-field assignments and xRec comparisons", () => {
    const t = par(onModify("", "if Amount <> xRec.Amount then Amount := Amount + 1;"));
    expect(tag({ "P.al": t, "O.al": CALLER })).toBeUndefined();
  });

  // M3. Revert: always tag.
  it("does NOT tag a resolved table with no OnModify", () => {
    expect(tag({ "P.al": par(""), "O.al": CALLER })).toBeUndefined();
  });

  // M4. Revert: skip the scan (drop the tag whenever OnModify exists).
  it("tags an OnModify that DeleteAll()s child rows", () => {
    const t = par(onModify(KID_VAR, `Kid.SetRange("Parent No.", "No."); Kid.DeleteAll();`));
    expect(tag({ "P.al": t, "K.al": KID, "O.al": CALLER })).toBe(MOD);
  });

  // T3, rule D in OnModify. Revert: restore R281's own-row allow-list (`Modify` on `Rec` in
  // OnModify). The `Rec.Delete()` half never was allow-listed in OnModify; it pins that it stays so.
  it("rule D: tags an OnModify that assigns the key and calls Rec.Modify()", () => {
    const t = par(onModify("", `Rec."No." := 'X'; Rec.Modify();`));
    expect(tag({ "P.al": t, "O.al": CALLER })).toBe(MOD);
  });

  it("rule D: tags an OnModify that calls Rec.Delete()", () => {
    const t = par(onModify("", "Rec.Delete();"));
    expect(tag({ "P.al": t, "O.al": CALLER })).toBe(MOD);
  });

  // M5, two separate drop controls: raising is not evidence that SKIPPING adds an error.
  // Revert: treat Error (resp. TestField) as unproven.
  it("does NOT tag an OnModify of only Error", () => {
    const t = par(onModify("", "if Amount < 0 then Error('negative');"));
    expect(tag({ "P.al": t, "O.al": CALLER })).toBeUndefined();
  });

  it("does NOT tag an OnModify of only TestField", () => {
    const t = par(onModify("", `TestField("No.");`));
    expect(tag({ "P.al": t, "O.al": CALLER })).toBeUndefined();
  });

  // M6. Revert: allow-list Validate.
  it("tags an OnModify that calls Validate", () => {
    const t = par(onModify("", "Validate(Amount, 1);"));
    expect(tag({ "P.al": t, "O.al": CALLER })).toBe(MOD);
  });

  // M7 (sol plan r2 finding 2). Revert: drop both `with_statement` checks.
  it("tags an allow-listed Reset() inside `with Kid do` (Kid's own writing Reset)", () => {
    const t = par(onModify(KID_VAR, "with Kid do Reset();"));
    expect(tag({ "P.al": t, "K.al": KID, "O.al": CALLER })).toBe(MOD);
  });

  // M8. Revert: the delete event set for the modify kind. The OnAfterDeleteEvent-only control:
  // revert, the union of both sets.
  const sub = (event: string): string =>
    `codeunit 50304 "Sub" {\n  [EventSubscriber(ObjectType::Table, Database::"Par", '${event}', '', false, false)]\n  local procedure X(var Rec: Record "Par"; RunTrigger: Boolean) begin end;\n}`;
  for (const event of ["OnBeforeModifyEvent", "OnAfterModifyEvent"]) {
    it(`tags a table with no OnModify when the project subscribes to ${event}`, () => {
      expect(tag({ "P.al": par(""), "S.al": sub(event), "O.al": CALLER })).toBe(MOD);
    });
  }
  it("does NOT tag a table whose only subscriber is OnAfterDeleteEvent", () => {
    expect(tag({ "P.al": par(""), "S.al": sub("OnAfterDeleteEvent"), "O.al": CALLER })).toBe(
      undefined,
    );
  });

  // M9. Revert: the delete extension triggers for the modify kind (resp. their union).
  const ext = (trigger: string): string =>
    `tableextension 50305 "Par Ext" extends "Par" { trigger ${trigger}() begin end; }`;
  for (const trigger of ["OnBeforeModify", "OnAfterModify"]) {
    it(`tags a table with no OnModify when a project tableextension has ${trigger}`, () => {
      expect(tag({ "P.al": par(""), "X.al": ext(trigger), "O.al": CALLER })).toBe(MOD);
    });
  }
  it("does NOT tag a table whose tableextension has only OnAfterDelete", () => {
    expect(tag({ "P.al": par(""), "X.al": ext("OnAfterDelete"), "O.al": CALLER })).toBe(undefined);
  });

  // M10. Reverts: skip `call_statement` (resp. the table-procedure identifier check).
  it("tags an OnModify that calls a procedure without parentheses, as a statement", () => {
    // Declared nowhere in the project, so only the `call_statement` check sees it.
    const t = par(onModify("", "ExtCleanUp;"));
    expect(tag({ "P.al": t, "O.al": CALLER })).toBe(MOD);
  });

  it("tags an OnModify that calls a table procedure without parentheses, as a value", () => {
    const t = par(
      `${onModify("", "if CheckIt then Error('x');")}    local procedure CheckIt(): Boolean begin end;\n`,
    );
    expect(tag({ "P.al": t, "O.al": CALLER })).toBe(MOD);
  });

  // M11. Reverts: stop skipping inactive calls; drop the R378 undecided-file check.
  const armed = par(
    onModify(KID_VAR, `#if X\n        Kid.DeleteAll();\n#endif\n        TestField("No.");`),
  );
  it("#if: a write only in an INACTIVE arm does not tag", () => {
    expect(tag({ "P.al": armed, "K.al": KID, "O.al": CALLER }, [])).toBeUndefined();
  });
  it("#if: the same write in an ACTIVE arm tags", () => {
    expect(tag({ "P.al": armed, "K.al": KID, "O.al": CALLER }, ["X"])).toBe(MOD);
  });
  it("#if: an UNDECIDED table file tags", () => {
    const t = par(`#if and\n${onModify(KID_VAR, "Kid.DeleteAll();")}#endif\n`);
    expect(tag({ "P.al": t, "K.al": KID, "O.al": CALLER }, ["X"])).toBe(MOD);
  });

  // sol final r1 finding 1, OnModify. Revert: drop the `with_statement` check in `onlyHarmlessCalls`.
  it("tags a parenthesis-less call inside `with Kid do` in OnModify", () => {
    const kid = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } procedure CleanUpChildren(): Boolean var K: Record "Kid"; begin K.DeleteAll(); exit(true); end; }`;
    const t = par(onModify(KID_VAR, "with Kid do if CleanUpChildren then Amount := 1;"));
    expect(tag({ "P.al": t, "K.al": kid, "O.al": CALLER })).toBe(MOD);
  });

  // Delete is still judged by OnDelete, not OnModify: the kind is not crossed. Revert: pass
  // "modify" for Delete (or "delete" for Modify).
  it("judges Delete by OnDelete and Modify by OnModify on the same table", () => {
    const t = par(onModify(KID_VAR, "Kid.DeleteAll();"));
    const both = `codeunit 50301 "Ops" { procedure P() var Par: Record "Par"; begin Par.Modify(true); Par.Delete(true); end; }`;
    expect(tag({ "P.al": t, "K.al": KID, "O.al": both })).toBe(MOD);
    expect(skipTag({ "P.al": t, "K.al": KID, "O.al": both }, "Par.Delete")).toBeUndefined();
  });
});

// R-457. The forward direction (`Modify()` -> `Modify(true)`) keeps `run-trigger-forced` wherever
// the trigger exists: no trigger body is read, so a "harmless-looking" one keeps it too.
describe("swap-modify-flag forward mechanism (R-457)", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Revert: decide by R165's recogniser (a parenthesised raise-capable call in the body).
  it("tags Modify() on a table whose OnModify only increments a field", () => {
    const t = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; Amount; Decimal) { } }\n    keys { key(PK; "No.") { } }\n    trigger OnModify()\n    begin\n        Amount := Amount + 1;\n    end;\n}\n`;
    const caller = `codeunit 50301 "Ops" { procedure P() var Par: Record "Par"; begin Par.Modify(); end; }`;
    const roots = [parseClean(t), parseClean(caller)];
    const ctx = projectContextFor(roots);
    const specs = roots
      .flatMap((r) => findAll(r, ALNodeKind.procedure_call))
      .filter((n) => n.text === "Par.Modify()" && swapModifyFlag.targets(n, ctx))
      .flatMap((n) => swapModifyFlag.generate(n, ctx));
    expect(specs.map((s) => `${s.after.text} ${s.platformKillMechanism ?? "-"}`)).toEqual([
      "Par.Modify(true) run-trigger-forced",
    ]);
  });
});
