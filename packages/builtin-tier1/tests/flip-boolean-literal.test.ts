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
