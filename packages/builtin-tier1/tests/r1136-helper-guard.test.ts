import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ALSyntaxNode,
  type MutationOperator,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { blankArgument } from "../src/blank-argument";
import { conditionTrue } from "../src/condition-true";
import { tier1Operators } from "../src/index";

/**
 * R1136 (PR-209). A same-object helper whose result is a loop's exit value: `repeat ... until
 * NextRow() = 0`. `condition-true` on the helper's `if ... exit(...)` guard, and `blank-argument`
 * on a site inside the helper, are refused BY NAME, both polarities (a name rule cannot tell the
 * endless one from the terminating one; R829). Every test parses real AL.
 */
beforeAll(async () => {
  await initParser();
});

interface Seen {
  readonly claimed: string[];
  readonly hang: string[];
}

function seen(op: MutationOperator, src: string): Seen {
  const root = wrapRoot(parseAL(src));
  expect(root.hasError).toBe(false);
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  const claimed: string[] = [];
  const hang: string[] = [];
  visit(root, (n: ALSyntaxNode) => {
    const on = op.targets(n, ctx);
    expect(on, `targets() and generate() disagree at ${n.text}`).toBe(
      op.generate(n, ctx).length > 0,
    );
    if (on) claimed.push(n.text);
    if (op.refusesHangCapable?.(n, ctx) === true) hang.push(n.text);
  });
  return { claimed, hang };
}

const unit = (helper: string, loop: string): string => `codeunit 51690 "C"
{
    var
        Walked: Integer;
        Rows: Integer;

${helper}

    procedure Walk(): Integer
    begin
        Rows := 1;
        Walked := 0;
${loop}
        exit(Walked);
    end;
}`;

const UNTIL_NEXT = `        repeat
            Walked += 1;
        until NextRow() = 0;`;

describe("R1136: condition-true on a helper guard whose exit is a loop's exit value", () => {
  it("refuses the ENDLESS polarity (`if Walked < Rows then exit(1)`)", () => {
    const src = unit(
      `    local procedure NextRow(): Integer
    begin
        if Walked < Rows then
            exit(1);
        exit(0);
    end;`,
      UNTIL_NEXT,
    );
    const s = seen(conditionTrue, src);
    expect(s.hang.some((t) => t.startsWith("if Walked < Rows then"))).toBe(true);
    expect(s.claimed.some((t) => t.startsWith("if Walked < Rows then"))).toBe(false);
  });

  it("refuses the TERMINATING polarity too: sandbox-hang's NextRow (line 63), by parsing the fixture", () => {
    const path = join(import.meta.dir, "../../../fixtures/sandbox-hang/src/HangLogic.Codeunit.al");
    const s = seen(conditionTrue, readFileSync(path, "utf8"));
    expect(s.hang.some((t) => t.startsWith("if Walked >= Rows then"))).toBe(true);
    expect(s.claimed.some((t) => t.startsWith("if Walked >= Rows then"))).toBe(false);
    // Line 141 (`SpinUntil`'s early exit) is not a loop-test helper: it is still made.
    expect(s.claimed.some((t) => t.startsWith("if Target <= 0 then"))).toBe(true);
  });

  it("refuses a `while` exit test and a `this.` call too", () => {
    const helper = `    local procedure More(): Boolean
    begin
        if Walked < Rows then
            exit(true);
        exit(false);
    end;`;
    for (const loop of [
      `        while this.More() do
            Walked += 1;`,
      `        while More() do
            Walked += 1;`,
    ]) {
      const s = seen(conditionTrue, unit(helper, loop));
      expect(s.hang.some((t) => t.startsWith("if Walked < Rows then"))).toBe(true);
    }
  });

  it("still makes a helper guard that no loop's exit test calls", () => {
    const src = unit(
      `    local procedure NextRow(): Integer
    begin
        if Walked < Rows then
            exit(1);
        exit(0);
    end;`,
      `        repeat
            Walked += 1;
        until Walked >= 3;
        if NextRow() = 0 then
            Walked := 9;`,
    );
    const s = seen(conditionTrue, src);
    expect(s.claimed.some((t) => t.startsWith("if Walked < Rows then"))).toBe(true);
  });

  it("still makes a guard in a called helper whose then-arm does not exit", () => {
    const src = unit(
      `    local procedure NextRow(): Integer
    begin
        if Walked < Rows then
            Rows := Rows;
        exit(0);
    end;`,
      UNTIL_NEXT,
    );
    const s = seen(conditionTrue, src);
    expect(s.claimed.some((t) => t.startsWith("if Walked < Rows then"))).toBe(true);
  });
});

describe("R1136: blank-argument on a site inside a procedure a loop's exit test calls", () => {
  const useProc = `    local procedure Use(X: Integer)
    begin
        Rows := X;
    end;`;
  const helpers = `${useProc}

    local procedure NextRow(): Integer
    var
        TA: Integer;
    begin
        TA := Walked;
        Use(TA);
        exit(Walked);
    end;

    local procedure Other(): Integer
    var
        TB: Integer;
    begin
        TB := Walked;
        Use(TB);
        exit(Walked);
    end;`;

  it("refuses it inside the called helper and keeps the control", () => {
    const s = seen(blankArgument, unit(helpers, UNTIL_NEXT));
    expect(s.hang).toContain("TA");
    expect(s.claimed).not.toContain("TA");
    // `Other` is called by no exit test: its site is made.
    expect(s.claimed).toContain("TB");
  });

  it("makes both when no loop's exit test calls the helper", () => {
    const s = seen(
      blankArgument,
      unit(
        helpers,
        `        repeat
            Walked += 1;
        until Walked >= 3;`,
      ),
    );
    expect(s.claimed).toContain("TA");
    expect(s.claimed).toContain("TB");
  });
});

describe("R1136: both operators are default operators", () => {
  it("carry no optIn flag, so a default run walks them", () => {
    for (const op of [conditionTrue, blankArgument]) expect(op.optIn).toBeUndefined();
    expect(tier1Operators).toContain(conditionTrue);
    expect(tier1Operators).toContain(blankArgument);
  });
});
