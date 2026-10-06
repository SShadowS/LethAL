import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type ArmEvaluation,
  buildSemanticContext,
  claimedRunTriggerSkip,
  evaluateArms,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";

function flipsIn(src: string): string[] {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  return findAll(root, ALNodeKind.boolean_literal)
    .filter((n) => flipBooleanLiteral.targets(n, ctx))
    .flatMap((n) => flipBooleanLiteral.generate(n, ctx))
    .map((s) => `${s.before.text}->${s.after.text}`);
}

describe("flipBooleanLiteral", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Same-loop controls, R239's shapes and the targets()/generate() agreement check:
  // loop-exit-refusal.test.ts.
  it("REFUSES an in-loop boolean guard that advances the condition (R196), and claims the preheader ones", () => {
    const src = `codeunit 50000 P
{
    procedure Go()
    var
        Continue: Boolean;
        Started: Boolean;
    begin
        Started := true;
        Continue := true;
        while Continue do
            Continue := false;
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const specs = findAll(root, ALNodeKind.boolean_literal)
      .filter((n) => flipBooleanLiteral.targets(n, ctx))
      .flatMap((n) => flipBooleanLiteral.generate(n, ctx));

    // Only the two preheader `true`s; the in-loop `Continue := false` is refused.
    expect(specs.map((s) => `${s.before.text}->${s.after.text}`)).toEqual([
      "true->false",
      "true->false",
    ]);
    for (const s of specs) expect(s.hangCapable).toBeUndefined();
  });

  /**
   * Issue #7. `repeat ... until false;` is an ordinary AL idiom for a loop whose exits all sit in
   * the body. `loop-truncate` rewrites a repeat's exit condition to `true`, and this operator was
   * flipping the same `false` to the same `true` at the same span, so both claimed one identity and
   * `dedupeSpecs` threw rather than let registration order decide. A whole-project run stopped at
   * planning, before a single mutant was measured.
   */
  it("REFUSES a repeat's exit condition, which loop-truncate owns (issue #7)", () => {
    const src = `codeunit 50000 R
{
    procedure P()
    var
        I: Integer;
    begin
        I := 0;
        repeat
            I += 1;
            if I >= 3 then
                exit;
        until false;
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const specs = findAll(root, ALNodeKind.boolean_literal)
      .filter((n) => flipBooleanLiteral.targets(n, ctx))
      .flatMap((n) => flipBooleanLiteral.generate(n, ctx));
    expect(specs).toEqual([]);
  });

  /**
   * The half nobody reported, and the worse one. `until true` runs the body once; flipping it to
   * `until false` is a loop that never ends. R164 exists because a non-terminating mutant strands
   * its tier, and `shift-integer`, `negate-guard` and `negate-conditional` already refuse a loop
   * condition for exactly this reason. `loop-truncate` emits nothing here, so without this refusal
   * the ONLY mutant at the site was the hang.
   */
  it("REFUSES `until true`, whose flip is a loop that never ends", () => {
    const src = `codeunit 50000 R
{
    procedure P()
    var
        I: Integer;
    begin
        I := 0;
        repeat
            I += 1;
        until true;
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const specs = findAll(root, ALNodeKind.boolean_literal)
      .filter((n) => flipBooleanLiteral.targets(n, ctx))
      .flatMap((n) => flipBooleanLiteral.generate(n, ctx));
    expect(specs).toEqual([]);
  });

  it("REFUSES a parenthesised exit condition too, since `until (false)` is the same site", () => {
    const src = `codeunit 50000 R
{
    procedure P()
    var
        I: Integer;
    begin
        I := 0;
        repeat
            I += 1;
        until (false);
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const specs = findAll(root, ALNodeKind.boolean_literal)
      .filter((n) => flipBooleanLiteral.targets(n, ctx))
      .flatMap((n) => flipBooleanLiteral.generate(n, ctx));
    expect(specs).toEqual([]);
  });

  /**
   * `while true do` is loop-skip's site (R179): it emits the same `false` at the same span, and two
   * operators on one identity make dedupeSpecs throw. The collision itself is pinned in
   * operator-collisions.test.ts; this pins the refusal on this operator alone.
   */
  it("REFUSES a `while` loop's whole condition, which loop-skip owns (GH-07 follow-up)", () => {
    expect(
      flipsIn(
        "codeunit 50000 R { procedure P() var I: Integer; begin while true do begin I += 1; if I > 3 then exit; end; end; }",
      ),
    ).toEqual([]);
  });

  /**
   * `while false do` never runs its body. Flipped to `while true do`, it runs until the body exits,
   * and this body never does. loop-skip refuses `while false` (it is already the skipped form), so
   * before this refusal the site's ONLY mutant was a hang (R164).
   */
  it("REFUSES `while false`, whose flip is a loop that never ends", () => {
    expect(
      flipsIn(
        "codeunit 50000 R { procedure P() var I: Integer; begin while false do I += 1; end; }",
      ),
    ).toEqual([]);
  });

  it("REFUSES a parenthesised while condition too", () => {
    expect(
      flipsIn(
        "codeunit 50000 R { procedure P() var I: Integer; begin while (true) do exit; while (false) do I += 1; end; }",
      ),
    ).toEqual([]);
  });

  /**
   * R239 refuses a literal nested in a compound loop condition in BOTH polarities. The terminating
   * flips (`while Go and true` -> `and false`, `until Done or false` -> `or true`) are lost with the
   * hanging ones: a polarity-aware rule was measured at zero sites and is more code to get wrong.
   * The in-loop writes to `Go` and `Done` are R196's refusal (the condition reads them).
   */
  it("REFUSES a boolean nested inside a compound loop condition, in both polarities (R239)", () => {
    expect(
      flipsIn(
        "codeunit 50000 R { procedure P() var Go: Boolean; begin while Go and true do Go := false; end; }",
      ),
    ).toEqual([]);
    expect(
      flipsIn(
        "codeunit 50000 R { procedure P() var Done: Boolean; begin repeat Done := true; until Done or false; end; }",
      ),
    ).toEqual([]);
  });
});

/**
 * R-452: a `true` -> `false` flip of a Record `ModifyAll`'s RunTrigger (argument 3) or a
 * `DeleteAll`'s (argument 1) skips `OnModify`/`OnDelete` for every affected row, the same mechanism
 * `swap-modify-flag` tags on `Modify(true)`/`Delete(true)`, through the same engine detector.
 * Each test names the revert that turns it red.
 */
describe("flipBooleanLiteral RunTrigger tags (R-452)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const KID = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } }`;
  const harmful = (trigger: string): string =>
    `    trigger ${trigger}()\n    var Kid: Record "Kid";\n    begin\n        Kid.SetRange("Parent No.", "No.");\n        Kid.DeleteAll();\n    end;\n`;
  const par = (members: string): string =>
    `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; Amount; Decimal) { } field(3; Flag; Boolean) { } }\n    keys { key(PK; "No.") { } }\n${members}}\n`;
  const caller = (body: string, vars = `Par: Record "Par";`): string =>
    `codeunit 50301 "Ops" { procedure P() var ${vars} begin ${body} end; }`;

  /** `<before>-><after> <tag or ->` for every flip in the codeunit, across one project context.
   *  `symbols` null: no arm map (no `#if` evaluated). */
  function tagged(
    files: Readonly<Record<string, string>>,
    symbols: readonly string[] | null = null,
  ): string[] {
    const parsed = Object.entries(files).map(([path, text]) => ({
      path,
      text,
      root: wrapRoot(parseAL(text)),
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
    const ops = parsed.find((p) => p.path === "O.al");
    if (ops === undefined) throw new Error("no O.al");
    return findAll(ops.root, ALNodeKind.boolean_literal)
      .filter((n) => flipBooleanLiteral.targets(n, ctx))
      .flatMap((n) => flipBooleanLiteral.generate(n, ctx))
      .map((s) => `${s.before.text}->${s.after.text} ${s.platformKillMechanism ?? "-"}`);
  }

  // F1. Reverts: judge ModifyAll by the delete kind (this Par has no OnDelete); never tag.
  it("tags a ModifyAll RunTrigger flip when OnModify writes other rows", () => {
    const files = {
      "P.al": par(harmful("OnModify")),
      "K.al": KID,
      "O.al": caller("Par.ModifyAll(Amount, 1, true);"),
    };
    expect(tagged(files)).toEqual(["true->false run-trigger-skipped-modify"]);
  });

  // F2. Revert: always tag.
  it("does NOT tag it when the table has no OnModify", () => {
    const files = { "P.al": par(""), "O.al": caller("Par.ModifyAll(Amount, 1, true);") };
    expect(tagged(files)).toEqual(["true->false -"]);
  });

  // F3. Revert: tag any `true` argument of a claimed ModifyAll.
  it("tags only the RunTrigger literal, never the value literal, in one ModifyAll", () => {
    const files = {
      "P.al": par(harmful("OnModify")),
      "K.al": KID,
      "O.al": caller("Par.ModifyAll(Flag, true, true);"),
    };
    expect(tagged(files)).toEqual(["true->false -", "true->false run-trigger-skipped-modify"]);
  });

  // F4. Revert: index the raw `namedChildren` of the argument list (comments included).
  it("sees through comments: the RunTrigger after a comment tags, the value before one does not", () => {
    const files = {
      "P.al": par(harmful("OnModify")),
      "K.al": KID,
      "O.al": caller(
        "Par.ModifyAll(Amount, 1, /* c */ true); Par.ModifyAll(Flag, /* c */ true, false);",
      ),
    };
    expect(tagged(files)).toEqual([
      "true->false run-trigger-skipped-modify",
      "true->false -",
      "false->true run-trigger-forced",
    ]);
  });

  // F5. Revert: accept a literal nested inside the argument (a descendant), not only the argument.
  it("does NOT tag a parenthesised (true) RunTrigger", () => {
    const files = {
      "P.al": par(harmful("OnModify")),
      "K.al": KID,
      "O.al": caller("Par.ModifyAll(Amount, 1, (true));"),
    };
    expect(tagged(files)).toEqual(["true->false -"]);
  });

  // F6 (R-457). The false -> true flip FORCES the trigger and carries `run-trigger-forced`, never a
  // skip tag. Revert: R-452's rule, a `false` returns no tag.
  it("tags a false RunTrigger on ModifyAll and DeleteAll as forced", () => {
    const files = {
      "P.al": par(`${harmful("OnModify")}${harmful("OnDelete")}`),
      "K.al": KID,
      "O.al": caller("Par.ModifyAll(Amount, 1, false); Par.DeleteAll(false);"),
    };
    expect(tagged(files)).toEqual([
      "false->true run-trigger-forced",
      "false->true run-trigger-forced",
    ]);
  });

  // F7. Reverts: judge DeleteAll by the modify kind (this Par has no OnModify); always tag; raw
  // `namedChildren` index (the commented one).
  it("tags a DeleteAll(true) flip by OnDelete: harmful, harmless, commented", () => {
    const body = "Par.DeleteAll(true); Par.DeleteAll(/* c */ true);";
    const harm = { "P.al": par(harmful("OnDelete")), "K.al": KID, "O.al": caller(body) };
    expect(tagged(harm)).toEqual([
      "true->false run-trigger-skipped-delete",
      "true->false run-trigger-skipped-delete",
    ]);
    const none = { "P.al": par(""), "O.al": caller(body) };
    expect(tagged(none)).toEqual(["true->false -", "true->false -"]);
  });

  // F9 (R-364). A caller wrapped whole in `#if` is not indexed, so its receiver does not resolve and
  // nothing proves the skip harmless: the tag is KEPT. The same `Par` without `OnDelete`, called
  // from an indexed caller, still drops it (F7's control). Revert: drop the unresolved-receiver
  // branch in `runTriggerSkipTag`.
  it("KEEPS the DeleteAll(true) tag when the receiver does not resolve (wrapped caller)", () => {
    const body = "Par.DeleteAll(true);";
    const wrappedCaller = { "P.al": par(""), "O.al": `#if not CLEANX\n${caller(body)}\n#endif\n` };
    expect(tagged(wrappedCaller)).toEqual(["true->false run-trigger-skipped-delete"]);
    expect(tagged({ "P.al": par(""), "O.al": caller(body) })).toEqual(["true->false -"]);
  });

  // F10 (R460). The forcing direction of F9: a `false` RunTrigger on a receiver that does not
  // resolve is tagged `run-trigger-forced` at all five methods, because nothing proves the forced
  // trigger harmless. Controls: the same calls from an indexed caller on a `Par` with no triggers
  // stay untagged (`forceCanRaise` proves it), and a codeunit receiver that RESOLVES to a non-record
  // stays untagged. Reverts: drop the forcing half of the unresolved branch (the wrapped half goes
  // untagged); tag every unclaimed `false` (the codeunit control goes red).
  it("tags a false RunTrigger as forced when the receiver does not resolve (wrapped caller)", () => {
    const body =
      "Par.ModifyAll(Amount, 1, false); Par.DeleteAll(false); Par.Modify(false); Par.Delete(false); Par.Insert(false);";
    const FORCED = "false->true run-trigger-forced";
    const UNTAGGED = "false->true -";
    const wrappedCaller = { "P.al": par(""), "O.al": `#if not CLEANX\n${caller(body)}\n#endif\n` };
    expect(tagged(wrappedCaller)).toEqual([FORCED, FORCED, FORCED, FORCED, FORCED]);
    expect(tagged({ "P.al": par(""), "O.al": caller(body) })).toEqual([
      UNTAGGED,
      UNTAGGED,
      UNTAGGED,
      UNTAGGED,
      UNTAGGED,
    ]);
    const mgt = `codeunit 50303 "Mgt" { procedure DeleteAll(Run: Boolean) begin end; procedure Modify(Run: Boolean) begin end; }`;
    const resolvedNonRecord = {
      "M.al": mgt,
      "O.al": caller("Mgt.DeleteAll(false); Mgt.Modify(false);", `Mgt: Codeunit "Mgt";`),
    };
    expect(tagged(resolvedNonRecord)).toEqual([UNTAGGED, UNTAGGED]);
  });

  // F12 (R473). The skip direction of F10 at the three sole-argument methods: a `true` RunTrigger
  // on a receiver that does not resolve is not claimed by `swap-modify-flag`, so this operator
  // flips it, and nothing proves the skipped trigger harmless, so it keeps the skip tag of its
  // kind. Controls: from an indexed caller the same `true`s are ceded (no flip; Tier 2's mutants
  // and their tags are pinned in `r459-run-trigger-seam.test.ts`), and a codeunit receiver that
  // RESOLVES to a non-record stays flipped and untagged. Reverts: put `skip: null` back on any one
  // of the three count-1 rows (that kind goes untagged); tag every unclaimed `true` without the
  // `receiverUnresolved` check (the codeunit control goes red); stop ceding (the indexed control
  // goes red).
  it("tags a sole true RunTrigger by kind when the receiver does not resolve (wrapped caller)", () => {
    const body = "Par.Modify(true); Par.Delete(true); Par.Insert(true);";
    const wrappedCaller = { "P.al": par(""), "O.al": `#if not CLEANX\n${caller(body)}\n#endif\n` };
    expect(tagged(wrappedCaller)).toEqual([
      "true->false run-trigger-skipped-modify",
      "true->false run-trigger-skipped-delete",
      "true->false run-trigger-skipped-insert",
    ]);
    expect(tagged({ "P.al": par(""), "O.al": caller(body) })).toEqual([]);
    const mgt = `codeunit 50303 "Mgt" { procedure Modify(Run: Boolean) begin end; procedure Delete(Run: Boolean) begin end; procedure Insert(Run: Boolean) begin end; }`;
    const resolvedNonRecord = {
      "M.al": mgt,
      "O.al": caller(
        "Mgt.Modify(true); Mgt.Delete(true); Mgt.Insert(true);",
        `Mgt: Codeunit "Mgt";`,
      ),
    };
    expect(tagged(resolvedNonRecord)).toEqual(["true->false -", "true->false -", "true->false -"]);
  });

  // F13 (R479). The BARE form of F10/F12: in a pageextension the implicit `Rec` is the extended
  // page's `SourceTable`, which the project cannot see, so `claimsRecordMethod` refuses the call
  // (and `swap-modify-flag` does not claim it: `claimedRunTriggerSkip` stays null) and this operator
  // flips it. Nothing proves the trigger harmless, so both directions keep their tag, as
  // `Rec.Insert(true)` in the same place already does; a reportextension `modify(X)` trigger the
  // same. Revert: give `receiverUnresolved` back `target.receiver === null -> false` (every bare
  // row goes untagged).
  it("tags a bare RunTrigger call on a pageextension's implicit Rec, both directions", () => {
    const body =
      "Insert(true); Modify(true); Delete(true); Insert(false); Modify(false); Delete(false); Rec.Insert(true);";
    const ext = `pageextension 50310 "Ext" extends "Customer Card" { trigger OnOpenPage() begin ${body} end; }`;
    expect(tagged({ "O.al": ext })).toEqual([
      "true->false run-trigger-skipped-insert",
      "true->false run-trigger-skipped-modify",
      "true->false run-trigger-skipped-delete",
      "false->true run-trigger-forced",
      "false->true run-trigger-forced",
      "false->true run-trigger-forced",
      "true->false run-trigger-skipped-insert",
    ]);
    const root = wrapRoot(parseAL(ext));
    const ctx = buildSemanticContext([{ path: "O.al", root }]);
    const calls = findAll(root, ALNodeKind.procedure_call);
    expect(calls.length).toBe(7);
    for (const c of calls) expect(claimedRunTriggerSkip(c, ctx)).toBeNull();
    const repExt = `reportextension 50314 "RX" extends "Customer - List" { dataset { modify(Customer) { trigger OnAfterAfterGetRecord() begin Modify(true); Insert(false); end; } } }`;
    expect(tagged({ "O.al": repExt })).toEqual([
      "true->false run-trigger-skipped-modify",
      "false->true run-trigger-forced",
    ]);
  });

  // F14 (R479). Controls: a bare call whose binding IS known keeps today's behaviour.
  // - a page whose `SourceTable` (Par, no triggers) resolves: `Modify(true)` is ceded to
  //   `swap-modify-flag` (no flip) and `Modify(false)` is proven harmless (untagged).
  //   Revert: stop ceding in `isCededRunTriggerFlag` (a `true->false` row appears).
  // - the same page on a Par that DECLARES `Modify`: rule 3 refuses the claim, the call is Par's own
  //   procedure, untagged. Revert: drop `scope.table !== null` in `implicitRecordUnresolved`.
  // - a pageextension that declares its own `Delete`: untagged. Revert: drop the
  //   `declaresProcedure` guard.
  // - `with Mgt do Modify(true)`, Mgt a codeunit: untagged. Revert: drop the non-record check.
  it("keeps a bare call untagged where its binding is known (resolved Rec, namesake, codeunit with)", () => {
    const page = `page 50311 "Pg" { SourceTable = "Par"; trigger OnOpenPage() begin Modify(true); Modify(false); end; }`;
    expect(tagged({ "P.al": par(""), "O.al": page })).toEqual(["false->true -"]);
    const own = par("    procedure Modify(Run: Boolean) begin end;\n");
    expect(tagged({ "P.al": own, "O.al": page })).toEqual(["true->false -", "false->true -"]);
    const extOwn = `pageextension 50312 "Ext2" extends "Customer Card" { trigger OnOpenPage() begin Delete(true); Delete(false); end; local procedure Delete(Run: Boolean) begin end; }`;
    expect(tagged({ "O.al": extOwn })).toEqual(["true->false -", "false->true -"]);
    const mgt = `codeunit 50303 "Mgt" { procedure Modify(Run: Boolean) begin end; }`;
    const withCu = `pageextension 50313 "Ext3" extends "Customer Card" { trigger OnOpenPage() var Mgt: Codeunit "Mgt"; begin with Mgt do begin Modify(true); Modify(false); end; end; }`;
    expect(tagged({ "M.al": mgt, "O.al": withCu })).toEqual(["true->false -", "false->true -"]);
  });

  // F15 (R479, sol final r1). The reportextension case (outside the claimable object kinds, so every
  // bare record call there counts as unresolved) still honours both exclusions, both directions:
  // - an added dataitem on Par: tagged (the control); on a Par that DECLARES `Modify`, the call is
  //   Par's own procedure, untagged. Revert: drop the `projectDeclaresProcedureOnTable` check.
  // - `with Mgt do`, Mgt a codeunit declared in the extension: untagged. Revert: drop the
  //   `withSubjectIsNonRecord` check.
  it("keeps a reportextension's bare project procedure and codeunit `with` untagged", () => {
    const rx = (body: string, vars = "") =>
      `reportextension 50315 "RX2" extends "Customer - List" { dataset { add(Customer) { dataitem(ParItem; "Par") { trigger OnAfterGetRecord() ${vars} begin ${body} end; } } } }`;
    const both = "Modify(true); Modify(false);";
    expect(tagged({ "P.al": par(""), "O.al": rx(both) })).toEqual([
      "true->false run-trigger-skipped-modify",
      "false->true run-trigger-forced",
    ]);
    const own = par("    procedure Modify(Run: Boolean) begin end;\n");
    expect(tagged({ "P.al": own, "O.al": rx(both) })).toEqual(["true->false -", "false->true -"]);
    const mgt = `codeunit 50303 "Mgt" { procedure Modify(Run: Boolean) begin end; }`;
    const withCu = rx(`with Mgt do begin ${both} end;`, `var Mgt: Codeunit "Mgt";`);
    expect(tagged({ "P.al": par(""), "M.al": mgt, "O.al": withCu })).toEqual([
      "true->false -",
      "false->true -",
    ]);
  });

  // F8. Revert: drop `claimsRecordMethod` (tag by method name alone).
  it("does NOT tag a codeunit's or a table procedure's ModifyAll/DeleteAll", () => {
    const mgt = `codeunit 50303 "Mgt" { procedure ModifyAll(A: Integer; B: Integer; Run: Boolean) begin end; procedure DeleteAll(Run: Boolean) begin end; }`;
    const own = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } }\n    keys { key(PK; "No.") { } }\n${harmful("OnDelete")}    procedure DeleteAll(Run: Boolean) begin end;\n}\n`;
    const files = {
      "P.al": own,
      "K.al": KID,
      "M.al": mgt,
      "O.al": caller(
        "Mgt.ModifyAll(1, 2, true); Mgt.DeleteAll(true); Par.DeleteAll(true);",
        `Par: Record "Par"; Mgt: Codeunit "Mgt";`,
      ),
    };
    expect(tagged(files)).toEqual(["true->false -", "true->false -", "true->false -"]);
  });

  // F11 (R-254, review R-254-001). Inside a `reportextension` (admitted by R-254) the receiver is
  // treated as UNRESOLVED for tagging, so every RunTrigger flip keeps its tag even on a `Par` with
  // no triggers. Controls: the same calls from a codeunit keep today's behaviour (resolved receiver,
  // no trigger, untagged). Revert: `receiverUnresolved` returns false outside `OBJECT_KINDS`.
  it("KEEPS the RunTrigger tags inside a reportextension (receiver unresolved for tagging)", () => {
    const body = "Par.Insert(false); Par.ModifyAll(Amount, 1, true); Par.DeleteAll(true);";
    const repExt = `reportextension 50304 "RX" extends "Base"\n{\n    procedure P()\n    var\n        Par: Record "Par";\n    begin\n        ${body}\n    end;\n}\n`;
    expect(tagged({ "P.al": par(""), "O.al": repExt })).toEqual([
      "false->true run-trigger-forced",
      "true->false run-trigger-skipped-modify",
      "true->false run-trigger-skipped-delete",
    ]);
    expect(tagged({ "P.al": par(""), "O.al": caller(body) })).toEqual([
      "false->true -",
      "true->false -",
      "true->false -",
    ]);
  });

  // R-457. A `false` RunTrigger flipped to `true` FORCES the trigger. `forceCanRaise` keeps
  // `run-trigger-forced` unless the table resolves, is decided, and has no `On<X>` (any arm not
  // compiled out), no project tableextension `OnBefore/OnAfter<X>` and no subscriber to its two
  // `<X>` events. No trigger body is read. Each test names the revert that turns it red.
  describe("false RunTrigger flips force the trigger (R-457)", () => {
    const FORCED = "false->true run-trigger-forced";
    const PLAIN = "false->true -";
    const trig = (name: string, body = ""): string =>
      `    trigger ${name}()\n    begin\n${body}\n    end;\n`;
    const ext = (...triggers: string[]): string =>
      `tableextension 50305 "Par Ext" extends "Par" { ${triggers.map((t) => `trigger ${t}() begin end;`).join(" ")} }`;
    const sub = (...events: string[]): string =>
      `codeunit 50304 "Sub" {\n${events
        .map(
          (e, i) =>
            `  [EventSubscriber(ObjectType::Table, Database::"Par", '${e}', '', false, false)]\n  local procedure X${i}(var Rec: Record "Par"; RunTrigger: Boolean) begin end;\n`,
        )
        .join("")}}`;
    const KINDS = ["Insert", "Modify", "Delete"] as const;

    // Per kind: its base trigger, each tableextension trigger, each table event. Reverts: rename
    // `SKIP_KINDS[kind].trigger`; drop that name from `extensionTriggers`; drop that event.
    for (const k of KINDS) {
      it(`${k}(false): the table's own On${k} keeps the tag`, () => {
        const files = { "P.al": par(trig(`On${k}`)), "O.al": caller(`Par.${k}(false);`) };
        expect(tagged(files)).toEqual([FORCED]);
      });
      for (const t of [`OnBefore${k}`, `OnAfter${k}`]) {
        it(`${k}(false): a project tableextension ${t} alone keeps the tag`, () => {
          const files = { "P.al": par(""), "X.al": ext(t), "O.al": caller(`Par.${k}(false);`) };
          expect(tagged(files)).toEqual([FORCED]);
        });
      }
      for (const e of [`OnBefore${k}Event`, `OnAfter${k}Event`]) {
        it(`${k}(false): a project subscriber to ${e} alone keeps the tag`, () => {
          const files = { "P.al": par(""), "S.al": sub(e), "O.al": caller(`Par.${k}(false);`) };
          expect(tagged(files)).toEqual([FORCED]);
        });
      }
      // Wrong-kind controls: every trigger, extension trigger and event of ANOTHER kind is there.
      // Revert: judge `k` by `other`'s kind in `RUN_TRIGGER_ARGUMENTS`.
      for (const other of KINDS.filter((o) => o !== k)) {
        it(`${k}(false): only ${other}'s trigger, extension triggers and events drop the tag`, () => {
          const files = {
            "P.al": par(trig(`On${other}`)),
            "X.al": ext(`OnBefore${other}`, `OnAfter${other}`),
            "S.al": sub(`OnBefore${other}Event`, `OnAfter${other}Event`),
            "O.al": caller(`Par.${k}(false);`),
          };
          expect(tagged(files)).toEqual([PLAIN]);
        });
      }
    }

    // Revert: `forceCanRaise` ends `return true` (always tag).
    it("drops the tag on a resolved table with no trigger and no observer, every method", () => {
      const files = {
        "P.al": par(""),
        "O.al": caller(
          "Par.Insert(false); Par.Modify(false); Par.Delete(false); Par.ModifyAll(Amount, 1, false); Par.DeleteAll(false);",
        ),
      };
      expect(tagged(files)).toEqual([PLAIN, PLAIN, PLAIN, PLAIN, PLAIN]);
    });

    // Reverts: ModifyAll's kind -> delete (resp. DeleteAll's -> modify).
    it("ModifyAll(..., false) is judged by OnModify and DeleteAll(false) by OnDelete", () => {
      const body = "Par.ModifyAll(Amount, 1, false); Par.DeleteAll(false);";
      expect(tagged({ "P.al": par(trig("OnModify")), "O.al": caller(body) })).toEqual([
        FORCED,
        PLAIN,
      ]);
      expect(tagged({ "P.al": par(trig("OnDelete")), "O.al": caller(body) })).toEqual([
        PLAIN,
        FORCED,
      ]);
    });

    // Revert: keep the tag when the table declares any trigger anywhere (a recursive search).
    it("a field's OnValidate alone drops the tag", () => {
      const t = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } field(2; Amount; Decimal) { trigger OnValidate() begin Error('x'); end; } }\n    keys { key(PK; "No.") { } }\n}\n`;
      const body = "Par.Insert(false); Par.Modify(false); Par.Delete(false);";
      expect(tagged({ "P.al": t, "O.al": caller(body) })).toEqual([PLAIN, PLAIN, PLAIN]);
    });

    // Revert: keep the tag when the table declares any table-level trigger.
    it("OnRename alone drops the tag", () => {
      const body = "Par.Insert(false); Par.Modify(false); Par.Delete(false);";
      const files = { "P.al": par(trig("OnRename", "Error('x');")), "O.al": caller(body) };
      expect(tagged(files)).toEqual([PLAIN, PLAIN, PLAIN]);
    });

    // Rename and Validate have no RunTrigger argument. Revert: add `Validate` (2 arguments, index
    // 1) and `Rename` (1, index 0) to `RUN_TRIGGER_ARGUMENTS` with the modify kind.
    it("a Boolean argument of Rename or Validate stays an ordinary flip", () => {
      const all = par(
        `${trig("OnInsert")}${trig("OnModify")}${trig("OnDelete")}${trig("OnRename")}`,
      );
      const files = {
        "P.al": all,
        "O.al": caller("Par.Validate(Flag, false); Par.Rename(false);"),
      };
      expect(tagged(files)).toEqual([PLAIN, PLAIN]);
    });

    // Revert: an unresolved receiver or table returns false.
    it("keeps the tag on a base-app table the project does not declare", () => {
      const files = { "O.al": caller("Par.Modify(false);", "Par: Record Customer;") };
      expect(tagged(files)).toEqual([FORCED]);
    });

    // Revert: the undecided-file check returns false. The table has no trigger at all, so nothing
    // else keeps the tag.
    it("keeps the tag on a table whose file is undecided", () => {
      const t = par("#if and\n    procedure Noop() begin end;\n#endif\n");
      expect(tagged({ "P.al": t, "O.al": caller("Par.Modify(false);") }, ["X"])).toEqual([FORCED]);
    });

    // An undecided member arm makes the whole file undecided, so this hits the file check AND
    // `anyArm`. Revert: both (the file check returns false and `anyArm` is `rawArmOf(ctx)`).
    it("keeps the tag on an On<X> inside an undecided member-level #if", () => {
      const t = par(`#if and\n${trig("OnModify")}#endif\n`);
      expect(tagged({ "P.al": t, "O.al": caller("Par.Modify(false);") }, ["X"])).toEqual([FORCED]);
    });

    const armed = par(`#if X\n${trig("OnModify")}#endif\n`);
    // `anyArm` alone. Revert: pass `rawArmOf(ctx)`, which with no arm map reads direct members only.
    it("keeps the tag on a conditional On<X> when no arm map is given", () => {
      expect(tagged({ "P.al": armed, "O.al": caller("Par.Modify(false);") })).toEqual([FORCED]);
    });
    // Revert: pass `undefined` as the arm reader (direct members only).
    it("keeps the tag on an On<X> in an evaluated ACTIVE arm", () => {
      expect(tagged({ "P.al": armed, "O.al": caller("Par.Modify(false);") }, ["X"])).toEqual([
        FORCED,
      ]);
    });
    // Revert: `anyArm` answers "active" for every node.
    it("drops the tag on an On<X> in an evaluated INACTIVE arm", () => {
      expect(tagged({ "P.al": armed, "O.al": caller("Par.Modify(false);") }, [])).toEqual([PLAIN]);
    });

    // sol final r1 finding 2: `anyArm` as passed to `projectObserves`. A tableextension trigger
    // inside a member-level `#if`, no trigger on the table. Revert: pass `rawArmOf(ctx)` there.
    const condExt = (t: string): string =>
      `tableextension 50305 "Par Ext" extends "Par"\n{\n#if X\n    trigger ${t}()\n    begin\n    end;\n#endif\n}\n`;
    for (const [t, call] of [
      ["OnBeforeModify", "Par.Modify(false);"],
      ["OnAfterModify", "Par.Modify(false);"],
      ["OnAfterInsert", "Par.Insert(false);"],
    ] as const) {
      it(`keeps the tag on a conditional tableextension ${t} when no arm map is given`, () => {
        const files = { "P.al": par(""), "X.al": condExt(t), "O.al": caller(call) };
        expect(tagged(files)).toEqual([FORCED]);
      });
    }
    // Revert: pass `projectObserves` a reader that answers "active" for every node.
    it("drops the tag on a tableextension OnAfterModify in an evaluated INACTIVE arm", () => {
      const files = {
        "P.al": par(""),
        "X.al": condExt("OnAfterModify"),
        "O.al": caller("Par.Modify(false);"),
      };
      expect(tagged(files, [])).toEqual([PLAIN]);
    });

    // Revert: drop the unindexed-object check in `projectObserves`.
    it("keeps the tag when an #if-wrapped project tableextension of the table exists", () => {
      const wrapped = `#if X\ntableextension 50305 "Par Ext" extends "Par"\n{\n}\n#endif\n`;
      const files = { "P.al": par(""), "X.al": wrapped, "O.al": caller("Par.Modify(false);") };
      expect(tagged(files)).toEqual([FORCED]);
    });

    // sol plan r1 finding 2. Revert: drop the subscriber check in `projectObserves`.
    it("keeps the tag when a subscriber raises only if RunTrigger", () => {
      const s = `codeunit 50304 "Sub" {\n  [EventSubscriber(ObjectType::Table, Database::"Par", 'OnBeforeModifyEvent', '', false, false)]\n  local procedure X(var Rec: Record "Par"; var xRec: Record "Par"; RunTrigger: Boolean) begin if RunTrigger then Error('forced'); end;\n}`;
      const files = { "P.al": par(""), "S.al": s, "O.al": caller("Par.Modify(false);") };
      expect(tagged(files)).toEqual([FORCED]);
    });

    // sol plan r1 finding 1: R165's recogniser saw none of these. Revert (each): decide the trigger
    // step by that recogniser (a parenthesised call to a raise-capable name in the body).
    const kid = `table 50302 "Kid" { fields { field(1; "Parent No."; Code[20]) { } } procedure CheckIt(): Boolean begin Error('x'); end; }`;
    it("keeps the tag on an OnModify holding only a call without parentheses", () => {
      const t = par(
        `${trig("OnModify", "        Check;")}    local procedure Check() begin Error('x'); end;\n`,
      );
      expect(tagged({ "P.al": t, "O.al": caller("Par.Modify(false);") })).toEqual([FORCED]);
    });
    it("keeps the tag on an OnModify holding only a `with`", () => {
      const t = par(
        `    trigger OnModify()\n    var Kid: Record "Kid";\n    begin\n        with Kid do if CheckIt then Amount := 1;\n    end;\n`,
      );
      const files = { "P.al": t, "K.al": kid, "O.al": caller("Par.Modify(false);") };
      expect(tagged(files)).toEqual([FORCED]);
    });
    it("keeps the tag on an OnModify holding only an assignment", () => {
      const t = par(trig("OnModify", "        Amount := 100 / Amount;"));
      expect(tagged({ "P.al": t, "O.al": caller("Par.Modify(false);") })).toEqual([FORCED]);
    });

    // sol plan r1 finding 5: the two directions disagree on a trigger that only checks. Revert:
    // judge a `false` by the skip detector (`canRaise`).
    it("an OnModify of only TestField: the forced flip tags, the skipped flip does not", () => {
      const t = par(trig("OnModify", `        TestField("No.");`));
      const body = "Par.ModifyAll(Amount, 1, false); Par.ModifyAll(Amount, 1, true);";
      expect(tagged({ "P.al": t, "O.al": caller(body) })).toEqual([FORCED, "true->false -"]);
    });

    const every = par(`${trig("OnInsert")}${trig("OnModify")}${trig("OnDelete")}`);
    // Revert: drop `claimsRecordMethod` (tag by method name alone).
    it("does NOT tag a codeunit's ModifyAll or a table procedure's DeleteAll", () => {
      const mgt = `codeunit 50303 "Mgt" { procedure ModifyAll(A: Integer; B: Integer; Run: Boolean) begin end; }`;
      const own = `table 50300 "Par"\n{\n    fields { field(1; "No."; Code[20]) { } }\n    keys { key(PK; "No.") { } }\n${trig("OnDelete")}    procedure DeleteAll(Run: Boolean) begin end;\n}\n`;
      const files = {
        "P.al": own,
        "M.al": mgt,
        "O.al": caller(
          "Mgt.ModifyAll(1, 2, false); Par.DeleteAll(false);",
          `Par: Record "Par"; Mgt: Codeunit "Mgt";`,
        ),
      };
      expect(tagged(files)).toEqual([PLAIN, PLAIN]);
    });

    // Revert: index the raw `namedChildren` of the argument list (comments included).
    it("tags the RunTrigger, not the value, in ModifyAll(Flag, /* c */ false, false)", () => {
      const files = { "P.al": every, "O.al": caller("Par.ModifyAll(Flag, /* c */ false, false);") };
      expect(tagged(files)).toEqual([PLAIN, FORCED]);
    });

    // Revert: accept a literal nested inside the argument (a descendant).
    it("does NOT tag a parenthesised (false) RunTrigger", () => {
      const files = { "P.al": every, "O.al": caller("Par.Modify((false));") };
      expect(tagged(files)).toEqual([PLAIN]);
    });
  });

  // R459. `Insert(RunTrigger, InsertWithSystemId)`: `swap-modify-flag` claims a SOLE `true` only
  // (`claimedRunTriggerSkip`), so both literals of a two-argument Insert are this operator's. The
  // first is RunTrigger and is tagged both ways; the second gets NO RunTrigger tag (it runs no
  // trigger; a SystemId mechanism is R472, not this). Each test names its revert.
  describe("two-argument Insert (R459)", () => {
    const FORCED = "false->true run-trigger-forced";
    const SKIPPED = "true->false run-trigger-skipped-insert";
    const T_PLAIN = "true->false -";
    const F_PLAIN = "false->true -";
    const trig = (name: string, body = ""): string =>
      `    trigger ${name}()\n    begin\n${body}\n    end;\n`;
    const keyInsert = par(trig("OnInsert", `        "No." := 'X';`));
    const flagInsert = par(trig("OnInsert", "        Flag := true;"));

    /** `<offset in O.al>:<tagged()'s line>`, so a test pins WHICH literal carries the tag. */
    function at(files: Readonly<Record<string, string>>): string[] {
      const parsed = Object.entries(files).map(([path, text]) => ({
        path,
        root: wrapRoot(parseAL(text)),
      }));
      const ctx = buildSemanticContext(parsed);
      const ops = parsed.find((p) => p.path === "O.al");
      if (ops === undefined) throw new Error("no O.al");
      return findAll(ops.root, ALNodeKind.boolean_literal)
        .filter((n) => flipBooleanLiteral.targets(n, ctx))
        .flatMap((n) => flipBooleanLiteral.generate(n, ctx))
        .map(
          (s) =>
            `${s.before.startIndex}:${s.before.text}->${s.after.text} ${s.platformKillMechanism ?? "-"}`,
        );
    }
    /** Offset of the `n`th (0-based) literal inside `call` in `src`. */
    const lit = (src: string, call: string, n: number): number => {
      const start = src.indexOf(call);
      if (start < 0) throw new Error(`no ${call}`);
      const open = start + call.indexOf("(") + 1;
      const parts = call.slice(call.indexOf("(") + 1, call.lastIndexOf(")")).split(",");
      let off = open;
      for (let i = 0; i < n; i++) off += (parts[i] ?? "").length + 1;
      return off + ((parts[n] ?? "").length - (parts[n] ?? "").trimStart().length);
    };

    // T1. Reverts: drop the count-2 Insert row (arg 0 loses the tag); cede every `true` of a claimed
    // Insert, as before R459 (arg 1 disappears).
    it("Insert(false, true) on a table with OnInsert: arg 0 forced, arg 1 an untagged flip", () => {
      const src = caller("Par.Insert(false, true);");
      const call = "Par.Insert(false, true)";
      expect(at({ "P.al": flagInsert, "O.al": src })).toEqual([
        `${lit(src, call, 0)}:${FORCED}`,
        `${lit(src, call, 1)}:${T_PLAIN}`,
      ]);
    });

    // T2. Revert: the count-2 row returns `run-trigger-forced` without asking `forceCanRaise`.
    it("Insert(false, true) on a table with no trigger and no observer: both untagged", () => {
      expect(tagged({ "P.al": par(""), "O.al": caller("Par.Insert(false, true);") })).toEqual([
        F_PLAIN,
        T_PLAIN,
      ]);
    });

    // T3. Reverts: the count-2 row's `skip: null` (tag lost); cede every `true` (arg 0 disappears).
    it("Insert(true, false) where OnInsert assigns the key: arg 0 skip-tagged", () => {
      const src = caller("Par.Insert(true, false);");
      const call = "Par.Insert(true, false)";
      expect(at({ "P.al": keyInsert, "O.al": src })).toEqual([
        `${lit(src, call, 0)}:${SKIPPED}`,
        `${lit(src, call, 1)}:${F_PLAIN}`,
      ]);
    });

    // T4. Revert: the count-2 row's skip judged by `canRaise: () => true`.
    it("Insert(true, false) where OnInsert sets a non-key field: arg 0 untagged", () => {
      expect(tagged({ "P.al": flagInsert, "O.al": caller("Par.Insert(true, false);") })).toEqual([
        T_PLAIN,
        F_PLAIN,
      ]);
    });

    // T5. Revert: the count-2 row at index 1 (or an extra index-1 row) moves or adds the tag.
    it("Insert(true, true) where OnInsert assigns the key: only arg 0 tagged, spans pinned", () => {
      const src = caller("Par.Insert(true, true);");
      const call = "Par.Insert(true, true)";
      expect(at({ "P.al": keyInsert, "O.al": src })).toEqual([
        `${lit(src, call, 0)}:${SKIPPED}`,
        `${lit(src, call, 1)}:${T_PLAIN}`,
      ]);
    });

    // T6 (as F10). Revert: drop the count-2 row (the unresolved branch then tags neither).
    it("unresolved receiver (wrapped caller): arg 0 tagged both ways, arg 1 never", () => {
      const body = "Par.Insert(true, true); Par.Insert(false, true);";
      const files = { "P.al": par(""), "O.al": `#if not CLEANX\n${caller(body)}\n#endif\n` };
      expect(tagged(files)).toEqual([SKIPPED, T_PLAIN, FORCED, T_PLAIN]);
    });

    // T7. The sole-argument cession stays. Reverts: drop the cession (both reappear); read the sole
    // argument by raw `namedChildren[0]` in `claimedRunTriggerSkip` (the commented one reappears).
    it("still cedes a sole Insert(true), comment or not", () => {
      const files = {
        "P.al": keyInsert,
        "O.al": caller("Par.Insert(true); Par.Insert(/* c */ true);"),
      };
      expect(tagged(files)).toEqual([]);
    });

    // sol 2: InsertWithSystemId runs no trigger, so it carries NO RunTrigger tag even with every
    // insert observer present. This pins the ABSENCE of a RunTrigger tag, not harmlessness (R472).
    // Revert: add an index-1 Insert row.
    it("arg 1 (InsertWithSystemId) carries no RunTrigger tag with every observer present", () => {
      const ext = `tableextension 50305 "Par Ext" extends "Par" { trigger OnBeforeInsert() begin end; trigger OnAfterInsert() begin end; }`;
      const sub = `codeunit 50304 "Sub" {\n  [EventSubscriber(ObjectType::Table, Database::"Par", 'OnBeforeInsertEvent', '', false, false)]\n  local procedure X(var Rec: Record "Par"; RunTrigger: Boolean) begin end;\n}`;
      const files = {
        "P.al": keyInsert,
        "X.al": ext,
        "S.al": sub,
        "O.al": caller("Par.Insert(false, false); Par.Insert(true, true);"),
      };
      expect(tagged(files)).toEqual([FORCED, F_PLAIN, SKIPPED, T_PLAIN]);
    });

    // Count-2 forcing controls: an extension trigger alone, a subscriber alone, and the wrong kind.
    // Revert (all three red): judge the count-2 row by the modify kind. The last one is also red
    // when the count-2 row forces without asking `forceCanRaise`.
    it("Insert(false, true): an extension OnAfterInsert alone keeps the forced tag", () => {
      const ext = `tableextension 50305 "Par Ext" extends "Par" { trigger OnAfterInsert() begin end; }`;
      const files = { "P.al": par(""), "X.al": ext, "O.al": caller("Par.Insert(false, true);") };
      expect(tagged(files)).toEqual([FORCED, T_PLAIN]);
    });
    it("Insert(false, true): a subscriber to OnAfterInsertEvent alone keeps the forced tag", () => {
      const sub = `codeunit 50304 "Sub" {\n  [EventSubscriber(ObjectType::Table, Database::"Par", 'OnAfterInsertEvent', '', false, false)]\n  local procedure X(var Rec: Record "Par"; RunTrigger: Boolean) begin end;\n}`;
      const files = { "P.al": par(""), "S.al": sub, "O.al": caller("Par.Insert(false, true);") };
      expect(tagged(files)).toEqual([FORCED, T_PLAIN]);
    });
    it("Insert(false, true): only OnModify on the table drops the forced tag", () => {
      const files = { "P.al": par(trig("OnModify")), "O.al": caller("Par.Insert(false, true);") };
      expect(tagged(files)).toEqual([F_PLAIN, T_PLAIN]);
    });

    // Three arguments is no Insert overload: neither ceded nor RunTrigger-tagged. Revert: give the
    // count-2 row count 3 (or cede every `true`).
    it("Insert(true, true, true): three untagged flips", () => {
      const files = { "P.al": keyInsert, "O.al": caller("Par.Insert(true, true, true);") };
      expect(tagged(files)).toEqual([T_PLAIN, T_PLAIN, T_PLAIN]);
    });
  });
});
