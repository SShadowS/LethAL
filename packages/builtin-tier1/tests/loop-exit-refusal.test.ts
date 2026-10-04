import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  type MutationOperator,
  buildSemanticContext,
  evaluateArms,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";
import { removeAssignment } from "../src/remove-assignment";
import { shiftInteger } from "../src/shift-integer";
import { swapAdditive } from "../src/swap-additive";

/**
 * R196 and R239: a value operator REFUSES a site that governs a loop's exit. No live gate can prove
 * an absence safely (R164), so this file proves it offline and POSITIONALLY: each refused site sits
 * in a loop next to a CONTROL in the same loop that must still be claimed, so a rule that refused
 * every in-loop site goes red here.
 *
 * `claimedSites` calls `targets()` AND `generate()` on every node and fails if they disagree, so a
 * refusal made in `generate()` alone (the prototype's shape) is caught, not only an emitted mutant.
 */
function claimedSites(op: MutationOperator, src: string, symbols?: string[]): string[] {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext(
    [{ path: "fixture.al", root }],
    symbols === undefined ? undefined : new Map([[root, evaluateArms(root, src, symbols)]]),
  );
  const out: string[] = [];
  visit(root, (n: ALSyntaxNode) => {
    const claimed = op.targets(n, ctx);
    const specs = op.generate(n, ctx);
    const at = `${n.startPosition.row + 1}|${n.text}`;
    expect(claimed, `targets() and generate() disagree at ${at}`).toBe(specs.length > 0);
    if (claimed) out.push(at);
  });
  return out;
}

const unit = (body: string, vars = "Done: Boolean; Go: Boolean; I: Integer; Total: Integer;") =>
  `codeunit 50000 P\n{\n    procedure Go2()\n    var\n        ${vars}\n    begin\n${body}\n    end;\n}`;

beforeAll(async () => {
  await initParser();
});

describe("R196: a value written to a loop's condition variable is refused", () => {
  it("remove-assignment: the in-loop counter step is refused; preheader and same-loop sibling claimed", () => {
    const src = unit(
      [
        "        I := 3;", // 7
        "        while I > 0 do begin", // 8
        "            I := I - 1;", // 9 refused
        "            Total := Total + 1;", // 10 same-loop control
        "        end;",
      ].join("\n"),
    );
    expect(claimedSites(removeAssignment, src)).toEqual(["7|I := 3", "10|Total := Total + 1"]);
  });

  it("shift-integer: the in-loop value is refused; preheader and same-loop sibling claimed", () => {
    const src = unit(
      [
        "        I := 1;", // 7
        "        while I > 0 do begin", // 8 (the condition's 0 is R164's older refusal)
        "            I := 0;", // 9 refused
        "            Total := 7;", // 10 same-loop control
        "        end;",
      ].join("\n"),
    );
    expect(claimedSites(shiftInteger, src)).toEqual(["7|1", "10|7"]);
  });

  it("swap-additive: the in-loop step is refused; preheader and same-loop sibling claimed", () => {
    const src = unit(
      [
        "        Total := I + 1;", // 7
        "        while I > 0 do begin", // 8
        "            I := I - 1;", // 9 refused
        "            Total := Total + 2;", // 10 same-loop control
        "        end;",
      ].join("\n"),
    );
    expect(claimedSites(swapAdditive, src)).toEqual(["7|I + 1", "10|Total + 2"]);
  });

  it("flip-boolean-literal: the in-loop exit flag is refused; preheader and same-loop sibling claimed", () => {
    const src = unit(
      [
        "        Done := true;", // 7
        "        while Done do begin", // 8
        "            Done := false;", // 9 refused
        "            Go := false;", // 10 same-loop control
        "        end;",
      ].join("\n"),
    );
    expect(claimedSites(flipBooleanLiteral, src)).toEqual(["7|true", "10|false"]);
  });

  // A `#if` tail of the assigned VALUE sits beside the assignment's `right` field, so the refusal
  // must read it too: with LETHALX, flipping the tail `true` makes `Done` permanently false.
  const tailed = (target: string, value: string, tail: string, until: string) =>
    unit(
      [
        "        repeat", // 7
        `            ${target} := ${value}`, // 8
        "#if LETHALX",
        `                ${tail}`, // 10
        "#endif",
        "            ;",
        `        until ${until};`,
      ].join("\n"),
    );
  const BUILDS = [["LETHALX"], []];
  // [operator, refused source, control source (the target governs no exit), control's claim].
  // remove-assignment claims the whole statement, tail included, so only these three operators,
  // which mutate a node INSIDE the value, can reach a tail.
  const TAIL_CASES = [
    [
      flipBooleanLiteral,
      tailed("Done", "Go", "and true", "Done"),
      tailed("Go", "Done", "and true", "Done"),
      "10|true",
    ],
    [
      shiftInteger,
      tailed("Done", "Go", "and (I = 5)", "Done"),
      tailed("Go", "Done", "and (I = 5)", "Done"),
      "10|5",
    ],
    [
      swapAdditive,
      tailed("I", "Total", "+ (Total + 2)", "I > 5"),
      tailed("Total", "I", "+ (I + 2)", "I > 5"),
      "10|I + 2",
    ],
  ] as const;

  for (const [op, refusedSrc, controlSrc, controlClaim] of TAIL_CASES) {
    it(`${op.name}: a \`#if\` tail of an exit variable's value is refused, tail active or inactive`, () => {
      for (const b of BUILDS) expect(claimedSites(op, refusedSrc, b), `[${b}]`).toEqual([]);
    });

    it(`${op.name} CONTROL: the same tail on a variable no loop exit reads is still claimed`, () => {
      for (const b of BUILDS)
        expect(claimedSites(op, controlSrc, b), `[${b}]`).toEqual([controlClaim]);
    });
  }
});

describe("R239: flip-boolean-literal refuses a literal that reaches a loop's exit", () => {
  const flips = (body: string) => claimedSites(flipBooleanLiteral, unit(body));

  it("nested `and` in an until condition, and the other polarity too", () => {
    expect(flips("        repeat Go := true; until Done and true;")).toEqual(["7|true"]);
    expect(flips("        repeat Go := true; until Done and false;")).toEqual(["7|true"]);
  });

  it("nested `or` in a while condition, and the other polarity too", () => {
    expect(flips("        while Go or false do Total := 1;")).toEqual([]);
    expect(flips("        while Go or true do Done := true;")).toEqual(["7|true"]);
  });

  it("under `not`, in while and in until", () => {
    expect(flips("        while not true do Done := true;")).toEqual(["7|true"]);
    expect(flips("        repeat Done := true; until not false;")).toEqual(["7|true"]);
  });

  it("through parentheses around a compound", () => {
    expect(flips("        while (Go and (not false)) do Done := true;")).toEqual(["7|true"]);
  });

  it("a body guard: an `if` literal inside a loop is refused, a flag set in that loop is not", () => {
    expect(
      flips(
        "        while Go do begin\n            Done := true;\n            if true then exit;\n        end;",
      ),
    ).toEqual(["8|true"]);
    expect(flips("        repeat if Done or false then exit; until Go;")).toEqual([]);
  });

  it("a `#if` tail of a loop condition, and of an in-loop `if` condition", () => {
    expect(
      flips(
        "        while false\n#if LETHALX\n            or false\n#endif\n        do begin end;",
      ),
    ).toEqual([]);
    expect(
      flips(
        "        while Go do begin\n            Done := true;\n            if false\n#if LETHALX\n                or true\n#endif\n            then exit;\n        end;",
      ),
    ).toEqual(["8|true"]);
  });

  it("CONTROL: the same `if` guard OUTSIDE any loop is still claimed, tail included", () => {
    expect(flips("        if true then exit;")).toEqual(["7|true"]);
    expect(
      flips("        if false\n#if LETHALX\n            or true\n#endif\n        then exit;"),
    ).toEqual(["7|false", "9|true"]);
  });

  it("ACCEPTED OVER-REFUSAL: an in-loop `if` literal is refused even when it guards no exit", () => {
    // The plan accepts this: zero such sites on the fixtures and the four reference corpora. A
    // future narrowing to exit-guarding `if`s must change this expectation deliberately.
    expect(
      flips(
        "        while I < 3 do begin\n            I += 1;\n            if true then Total += 1;\n        end;",
      ),
    ).toEqual([]);
  });

  it("CONTROL: a call ARGUMENT inside an in-loop `if` condition is still claimed", () => {
    expect(flips("        while Go do\n            if not Confirm('x', false) then exit;")).toEqual(
      ["8|false"],
    );
  });
});
