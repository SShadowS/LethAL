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

/**
 * R454 shapes 1 and 2: a literal that sits in a loop's exit test but that the R164/R239 walks
 * missed. Both refusals are SILENT (not the hang check), so `refusesHangCapable` stays false.
 */
describe("R454: literals in a loop's exit test the older walks missed", () => {
  const CUST = "Done: Boolean; Go: Boolean; Total: Integer; Cust: Record Customer;";

  it("shift-integer: a literal in a loop condition's `#if` tail is refused; the body is claimed", () => {
    const src = unit(
      [
        "        while false", // 7
        "#if LETHALX",
        "            or (Cust.Next() <> 0)", // 9 refused
        "#endif",
        "        do", // 11
        "            Total := 7;", // 12 same-loop control
      ].join("\n"),
      CUST,
    );
    for (const b of [["LETHALX"], undefined])
      expect(claimedSites(shiftInteger, src, b), `[${b}]`).toEqual(["12|7"]);
  });

  it("flip-boolean-literal: a literal inside a comparison in an until condition is refused", () => {
    expect(
      claimedSites(
        flipBooleanLiteral,
        unit("        repeat\n            Go := Done = true;\n        until Done = true;"),
      ),
    ).toEqual(["8|true"]);
  });

  it("flip-boolean-literal: a literal inside a comparison in an in-loop `if` guard is refused", () => {
    expect(
      claimedSites(
        flipBooleanLiteral,
        unit(
          "        while Go do begin\n            Total += 1;\n            if Done = true then exit;\n        end;",
        ),
      ),
    ).toEqual([]);
  });

  it("neither refusal is counted as a hang refusal", () => {
    const root = wrapRoot(
      parseAL(
        unit(
          "        while false\n#if LETHALX\n            or (Cust.Next() <> 0)\n#endif\n        do;\n        repeat until Done = true;",
          CUST,
        ),
      ),
    );
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const seen: string[] = [];
    visit(root, (n: ALSyntaxNode) => {
      if (n.rawKind === "integer" && n.text === "0") {
        seen.push("0");
        expect(shiftInteger.targets(n, ctx)).toBe(false);
        expect(shiftInteger.refusesHangCapable?.(n, ctx)).toBe(false);
      }
      if (n.rawKind === "boolean" && n.text === "true") {
        seen.push("true");
        expect(flipBooleanLiteral.targets(n, ctx)).toBe(false);
        expect(flipBooleanLiteral.refusesHangCapable?.(n, ctx)).toBe(false);
      }
    });
    expect(seen.sort()).toEqual(["0", "true"]);
  });
});

/**
 * R446: a loop whose condition reads no name and calls nothing (`while true`, `until false`) ends
 * only through its body exits, so the guards of those exits count as its condition. Every case keeps
 * a same-loop sibling write that must still be claimed. Each `it` names the revert that turns it red.
 */
describe("R446: a write a body-exit guard reads, in a loop whose condition is name- and call-free", () => {
  const V = "Done: Boolean; Go: Boolean; I: Integer; J: Integer; K: Integer; Total: Integer;";
  const claims = (op: MutationOperator, lines: string[], vars = V, symbols?: string[]) =>
    claimedSites(op, unit(lines.join("\n"), vars), symbols);
  const COUNTER = [
    "        while true do begin", // 7
    "            I += 1;", // 8 refused
    "            Total += 1;", // 9 claimed
    "            if I > 3 then exit;", // 10
    "        end;",
  ];

  // Revert for every `it` in this block unless named: `loopExitParts` returns `loopConditionParts(loop)`.
  it("remove-assignment and shift-integer: `if I > 3 then exit` refuses `I += 1`, claims `Total += 1`", () => {
    expect(claims(removeAssignment, COUNTER)).toEqual(["9|Total += 1"]);
    expect(claims(shiftInteger, COUNTER)).toEqual(["9|1"]);
  });

  it("flip and remove-assignment: `if Done then exit` refuses `Done := true`, claims `Go := true`", () => {
    const src = [
      "        while true do begin",
      "            Done := true;", // 8 refused
      "            Go := true;", // 9 claimed
      "            if Done then exit;",
      "        end;",
    ];
    expect(claims(flipBooleanLiteral, src)).toEqual(["9|true"]);
    expect(claims(removeAssignment, src)).toEqual(["9|Go := true"]);
  });

  it("swap-additive: `repeat ... if I >= 5 then break; until false` refuses `I := I + 1`", () => {
    const src = [
      "        repeat",
      "            I := I + 1;", // 8 refused
      "            Total := Total + 1;", // 9 claimed
      "            if I >= 5 then break;",
      "        until false;",
    ];
    expect(claims(swapAdditive, src)).toEqual(["9|Total + 1"]);
  });

  it("an `Error` guard, a `case` guard and an `else exit` each refuse the write their guard reads", () => {
    const shape = (guard: string) => [
      "        while true do begin",
      "            I += 1;",
      "            Total += 1;",
      `            ${guard}`,
      "        end;",
    ];
    for (const g of [
      "if I > 3 then Error('x');",
      "case I of 5: exit; end;",
      "if I < 3 then Total += 0 else exit;",
    ]) {
      expect(claims(removeAssignment, shape(g)), g).toContain("9|Total += 1");
      expect(claims(removeAssignment, shape(g)), g).not.toContain("8|I += 1");
    }
  });

  it("an `Error` exit alone refuses (revert: drop `exitsLoop`'s `Error` branch)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;",
      "            Total += 1;",
      "            if I > 3 then Error('x');",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["9|Total += 1"]);
  });

  it("ANY, not ALL: two exits reading different variables refuse BOTH writes (revert: only the first exit's guards)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;", // 8 refused
      "            J += 1;", // 9 refused
      "            Total += 1;", // 10 claimed
      "            if I > 3 then exit;",
      "            if J > 3 then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["10|Total += 1"]);
  });

  it("NOT over-refused: a loop whose condition reads a name keeps body guards out (revert: always add guards)", () => {
    const src = [
      "        while I < 10 do begin",
      "            I += 1;", // 8 refused by the condition itself
      "            J += 1;", // 9 claimed: only a body guard reads J
      "            if J > 3 then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["9|J += 1"]);
  });

  it("an inner loop's `break` ends only the inner loop (revert: `exitsLoop` accepts any `break`)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;", // 8 refused: the outer exit guard reads I
      "            K := 0;", // 9 claimed: only the inner break's guard reads K
      "            repeat",
      "                K += 1;", // 11 refused by the inner loop's own break guard
      "                if K > 2 then break;",
      "            until false;",
      "            if I > 3 then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["9|K := 0"]);
  });

  it("an inner `while` condition guards the exit (revert: drop the `while`/`repeat` guard case)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;",
      "            Total += 1;",
      "            while I > 3 do exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["9|Total += 1"]);
  });

  it("a `for` bound guards the exit (revert: drop the `for_statement` guard case)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;",
      "            Total += 1;",
      "            for J := 3 to I do exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["9|Total += 1"]);
  });

  it("a `foreach` iterable guards the exit (revert: drop the `foreach_statement` guard case)", () => {
    const src = [
      "        while true do begin",
      "            L := L2;", // 8 refused
      "            L3 := L2;", // 9 claimed
      "            foreach J in L do exit;",
      "        end;",
    ];
    const vars = "J: Integer; L: List of [Integer]; L2: List of [Integer]; L3: List of [Integer];";
    expect(claims(removeAssignment, src, vars)).toEqual(["9|L3 := L2"]);
  });

  it("a loop condition's `#if` tail: active and reading a name, guards stay out; inactive, they count (reverts: read inactive arms; skip tails)", () => {
    const src = [
      "        while true",
      "#if LETHALX",
      "            and Go",
      "#endif",
      "        do begin",
      "            I += 1;", // 12
      "            Total += 1;", // 13
      "            if I > 3 then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src, V, ["LETHALX"])).toEqual(["12|I += 1", "13|Total += 1"]);
    expect(claims(removeAssignment, src, V, [])).toEqual(["13|Total += 1"]);
  });

  it("a guard's `#if` tail: active, its read counts; inactive, it does not (revert: drop the guard-tail loop)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;", // 8
      "            Total += 1;", // 9
      "            if false",
      "#if LETHALX",
      "                or (I > 3)",
      "#endif",
      "            then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src, V, ["LETHALX"])).toEqual(["9|Total += 1"]);
    expect(claims(removeAssignment, src, V, [])).toEqual(["8|I += 1", "9|Total += 1"]);
  });

  it("report exits: `CurrReport.Quit()` and a bare `CurrReport.Break` (revert: drop the `member_expression` branch)", () => {
    for (const exit of ["CurrReport.Quit()", "CurrReport.Break", "CurrXMLport.Quit()"]) {
      const src = [
        "        while true do begin",
        "            Done := true;",
        "            Go := true;",
        `            if Done then ${exit};`,
        "        end;",
      ];
      expect(claims(removeAssignment, src), exit).toEqual(["9|Go := true"]);
    }
  });

  it("the resolved-member reader: `if R.Qty > 3 then exit` refuses `R.Qty += 1` (revert: `conditionReadsMember` reads `loopConditionParts`)", () => {
    const src = `table 50490 T { fields { field(1; Qty; Integer) { } field(2; Other; Integer) { } } }
codeunit 50491 C { procedure P() var R: Record T; begin
  while true do begin
    R.Qty += 1;
    R.Other += 1;
    if R.Qty > 3 then exit;
  end;
end; }`;
    expect(claimedSites(removeAssignment, src)).toEqual(["5|R.Other += 1"]);
  });

  it("the by-name reader: `if Rec.Qty > 3 then exit` refuses an implicit `Qty += 1` (revert: `loopConditionReadsByName` reads `loopConditionParts`)", () => {
    const src = `table 50492 T { fields { field(1; Qty; Integer) { } field(2; Other; Integer) { } } }
page 50493 Pg { SourceTable = T; procedure P() begin
  while true do begin
    Qty += 1;
    Other += 1;
    if Rec.Qty > 3 then exit;
  end;
end; }`;
    expect(claimedSites(removeAssignment, src)).toEqual(["5|Other += 1"]);
  });
});

/**
 * R446's EXCLUSIONS (R480, measure-first): shapes that can hang but that this rule does not refuse
 * today. Each pins the write as CLAIMED; a change that starts refusing one must change it here.
 */
describe("R446 exclusions: hang-capable writes still claimed (R480)", () => {
  const V = "Done: Boolean; Go: Boolean; I: Integer; J: Integer; N: Integer; Total: Integer;";
  const claims = (lines: string[], vars = V) =>
    claimedSites(removeAssignment, unit(lines.join("\n"), vars));

  it("a body-exit flag under a condition that reads a name", () => {
    expect(
      claims([
        "        while Go do begin",
        "            Done := true;",
        "            if Done then exit;",
        "        end;",
      ]),
    ).toEqual(["8|Done := true"]);
  });

  it("an indirect guard: the write feeds the guard's variable", () => {
    expect(
      claims([
        "        while true do begin",
        "            I += 1;",
        "            Done := I >= 3;",
        "            if Done then exit;",
        "        end;",
      ]),
    ).toEqual(["8|I += 1"]);
  });

  it("a condition that calls something", () => {
    expect(
      claims(
        [
          "        while not Cust.IsEmpty() do begin",
          "            Done := true;",
          "            if Done then exit;",
          "        end;",
        ],
        `${V} Cust: Record Customer;`,
      ),
    ).toEqual(["8|Done := true"]);
  });

  it("an outer `for` whose bound the body moves, and an outer `foreach`", () => {
    expect(claims(["        for I := 1 to N do", "            N += 1;"])).toEqual(["8|N += 1"]);
    expect(
      claims(
        ["        foreach J in L do", "            L := L2;"],
        "J: Integer; L: List of [Integer]; L2: List of [Integer];",
      ),
    ).toEqual(["8|L := L2"]);
  });

  it("`asserterror` as the only exit (revert to red: let `Error` inside `asserterror` count)", () => {
    expect(
      claims([
        "        while true do begin",
        "            Done := true;",
        "            asserterror if not Done then Error('x');",
        "        end;",
      ]),
    ).toEqual(["8|Done := true"]);
  });

  it("`CurrReport.Skip()`, whose docs do not say it ends an AL loop (revert to red: add `skip`)", () => {
    expect(
      claims([
        "        while true do begin",
        "            Done := true;",
        "            if Done then CurrReport.Skip();",
        "        end;",
      ]),
    ).toEqual(["8|Done := true"]);
  });
});
