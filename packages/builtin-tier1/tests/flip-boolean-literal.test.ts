import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  buildSemanticContext,
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

  /** `<before>-><after> <tag or ->` for every flip in the codeunit, across one project context. */
  function tagged(files: Readonly<Record<string, string>>): string[] {
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
      "false->true -",
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

  // F6 (sol plan r2 finding 6). The false -> true flip FORCES the trigger (R165's class, filed
  // separately) and is not tagged here. Revert: tag regardless of the literal's value.
  it("does NOT tag a false RunTrigger on ModifyAll or DeleteAll", () => {
    const files = {
      "P.al": par(`${harmful("OnModify")}${harmful("OnDelete")}`),
      "K.al": KID,
      "O.al": caller("Par.ModifyAll(Amount, 1, false); Par.DeleteAll(false);"),
    };
    expect(tagged(files)).toEqual(["false->true -", "false->true -"]);
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
});
