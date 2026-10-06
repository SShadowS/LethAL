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
function claimedSites(
  op: MutationOperator,
  src: string,
  symbols?: string[] | "undecided",
): string[] {
  const root = wrapRoot(parseAL(src));
  const built = buildSemanticContext(
    [{ path: "fixture.al", root }],
    symbols === undefined || symbols === "undecided"
      ? undefined
      : new Map([[root, evaluateArms(root, src, symbols)]]),
  );
  // "undecided": every node answers as in a file whose directives could not be evaluated.
  const ctx = symbols === "undecided" ? { ...built, armOf: () => "undecided" as const } : built;
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
  const claims = (
    op: MutationOperator,
    lines: string[],
    vars = V,
    symbols?: string[] | "undecided",
  ) => claimedSites(op, unit(lines.join("\n"), vars), symbols);
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

  it("R480: a loop whose condition reads a name now gets body guards too; a same-loop sibling is still claimed", () => {
    // Was "NOT over-refused" (J claimed): R480 shape 1 refuses a body-exit guard's write under a
    // name-reading condition, so the old exclusion is intentionally gone. `Total` is the control.
    const src = [
      "        while I < 10 do begin",
      "            I += 1;", // 8 refused by the condition itself
      "            J += 1;", // 9 refused: a body guard reads J
      "            Total += 1;", // 10 claimed
      "            if J > 3 then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["10|Total += 1"]);
  });

  it("NOT over-refused: a cursor condition keeps body guards out (revert: always add guards)", () => {
    const src = [
      "        while Cust.Next() <> 0 do begin",
      "            I += 1;", // 8 claimed: only a body guard reads I
      "            if I > 3 then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src, `${V} Cust: Record Customer;`)).toEqual(["8|I += 1"]);
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

  it("a loop condition's `#if` tail: active and naming a cursor, guards stay out; inactive, they count (reverts: read inactive arms; skip tails)", () => {
    // R480: the tail was `and Go`, which now gets guards in either build (shape 1), so the tail
    // names a cursor instead and keeps both reverts meaningful.
    const src = [
      "        while true",
      "#if LETHALX",
      "            and (Cust.Next() <> 0)",
      "#endif",
      "        do begin",
      "            I += 1;", // 12
      "            Total += 1;", // 13
      "            if I > 3 then exit;",
      "        end;",
    ];
    const vars = `${V} Cust: Record Customer;`;
    expect(claims(removeAssignment, src, vars, ["LETHALX"])).toEqual([
      "12|I += 1",
      "13|Total += 1",
    ]);
    expect(claims(removeAssignment, src, vars, [])).toEqual(["13|Total += 1"]);
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
 * R480: four of R446's six excluded shapes are now refused. Each refused write sits beside a
 * same-loop control that must stay claimed. Each `it` names the revert that turns it red.
 */
describe("R480: hang-capable writes R446 did not see, now refused", () => {
  const V =
    "Done: Boolean; Flag: Boolean; Go: Boolean; A, B: Integer; I: Integer; J: Integer; K: Integer; N: Integer; Total: Integer; Cust: Record Customer;";
  const claims = (
    op: MutationOperator,
    lines: string[],
    vars = V,
    symbols?: string[] | "undecided",
  ) => claimedSites(op, unit(lines.join("\n"), vars), symbols);
  /** A counter loop and a flag loop under `head` ... `tail`: line 8 is the refused write, line 9
   *  the same-loop control. */
  const counter = (head: string, tail: string, step = "+= 1") => [
    `        ${head}`, // 7
    `            I ${step};`, // 8
    `            Total ${step};`, // 9
    "            if I > 3 then exit;",
    `        ${tail}`,
  ];
  const flag = (head: string, tail: string) => [
    `        ${head}`, // 7
    "            Done := true;", // 8
    "            Flag := true;", // 9
    "            if Done then exit;",
    `        ${tail}`,
  ];
  const LOOPS = [
    ["while Go do begin", "end;"],
    ["repeat", "until Go;"],
  ] as const;

  // Shape 1. Revert: `loopExitParts` adds body guards only to a name- and call-free condition.
  for (const [head, tail] of LOOPS) {
    it(`shape 1, \`${head}\`: a body-exit guard's write is refused through all four operators`, () => {
      expect(claims(removeAssignment, counter(head, tail))).toEqual(["9|Total += 1"]);
      expect(claims(shiftInteger, counter(head, tail))).toEqual(["9|1"]);
      expect(claims(swapAdditive, counter(head, tail, ":= I + 1"))).toEqual(["9|I + 1"]);
      expect(claims(flipBooleanLiteral, flag(head, tail))).toEqual(["9|true"]);
    });
  }

  it("shape 1 CONTROL: under a cursor condition the same writes are still claimed (revert: drop the cursor exemption)", () => {
    const [head, tail] = ["while Cust.Next() <> 0 do begin", "end;"];
    expect(claims(removeAssignment, counter(head, tail))).toEqual(["8|I += 1", "9|Total += 1"]);
    expect(claims(flipBooleanLiteral, flag(head, tail))).toEqual(["8|true", "9|true"]);
  });

  // Shape 3n: a call in the condition that names no cursor method gets body guards too.
  const called = (cond: string) => flag(`while ${cond} do begin`, "end;");
  it("shape 3n: a call that names no cursor method gets body guards (revert: guards only for a call-free condition)", () => {
    for (const cond of ["not Cust.IsEmpty()", "Ready()", "Cust.NextOne() <> 0"]) {
      expect(claims(removeAssignment, called(cond)), cond).toEqual(["9|Flag := true"]);
    }
  });

  it("shape 3n: each cursor name, any case, quoted, bare member or call, keeps guards out (revert: drop the cursor exemption)", () => {
    for (const cond of [
      "Cust.Next() <> 0",
      "Cust.NEXT(1) <> 0",
      'Cust."Next"() <> 0',
      "X.Next <> 0", // a bare member, no parentheses
      "not InS.EOS()",
      "not InS.eos",
      "Rd.Read()",
      "Enum.MoveNext()",
      "Next()", // a bare callee: a user procedure named Next is a known exclusion, by name
    ]) {
      expect(claims(removeAssignment, called(cond)), cond).toEqual([
        "8|Done := true",
        "9|Flag := true",
      ]);
    }
  });

  it("shape 3n: a condition `#if` tail naming a cursor exempts when active or undecided, not when inactive", () => {
    const src = [
      "        while not Cust.IsEmpty()", // 7
      "#if LETHALX",
      "            or (Cust.Next() <> 0)",
      "#endif",
      "        do begin",
      "            Done := true;", // 12
      "            Flag := true;", // 13
      "            if Done then exit;",
      "        end;",
    ];
    const both = ["12|Done := true", "13|Flag := true"];
    expect(claims(removeAssignment, src, V, ["LETHALX"])).toEqual(both);
    expect(claims(removeAssignment, src, V, "undecided")).toEqual(both);
    expect(claims(removeAssignment, src, V, [])).toEqual(["13|Flag := true"]);
  });

  // Shape 2: in a `while true` loop, a write that FEEDS a guard's variable is refused.
  it("shape 2: a chain whose hops run forward in source order needs a fixpoint (revert: one pass)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;", // 8 refused: feeds J
      "            J := I;", // 9 refused: feeds Done
      "            Done := J >= 3;", // 10 refused: the guard reads Done
      "            Total += 1;", // 11 claimed
      "            if Done then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["11|Total += 1"]);
    expect(claims(shiftInteger, src)).toEqual(["11|1"]);
  });

  it("shape 2: the same chain in reverse source order (revert: follow one hop only)", () => {
    const src = [
      "        while true do begin",
      "            Done := J >= 3;", // 8
      "            J := I;", // 9
      "            I += 1;", // 10
      "            Total += 1;", // 11 claimed
      "            if Done then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["11|Total += 1"]);
  });

  it("shape 2: a cycle ends, and both of its writes are refused", () => {
    const src = [
      "        while true do begin",
      "            I := J + 1;", // 8 refused: the guard reads I
      "            J := I;", // 9 refused: feeds I
      "            Total += 1;", // 10 claimed
      "            if I > 5 then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["10|Total += 1"]);
  });

  it("shape 2: `A, B: Integer` share a declaration, but only A feeds the guard", () => {
    const src = [
      "        while true do begin",
      "            A += 1;", // 8 refused
      "            B += 1;", // 9 claimed
      "            Done := A > 3;", // 10 refused
      "            if Done then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["9|B += 1"]);
  });

  const TABLE = "table 50496 T { fields { field(1; Done; Boolean) { } } }";
  const member = (feed: string, guard: string) => `${TABLE}
codeunit 50497 C { procedure P() var R: Record T; Done: Boolean; I: Integer; Total: Integer; begin
  while true do begin
    I += 1;
    ${feed};
    Total += 1;
    if ${guard} then exit;
  end;
end; }`;

  it("shape 2: a member target `R.Done := I >= 3` feeds `if R.Done` (revert: follow bare targets only)", () => {
    expect(claimedSites(removeAssignment, member("R.Done := I >= 3", "R.Done"))).toEqual([
      "6|Total += 1",
    ]);
  });

  it("shape 2 BY NAME: a local `Done` feeds a guard reading `R.Done` (accepted over-refusal of `I`)", () => {
    expect(claimedSites(removeAssignment, member("Done := I >= 3", "R.Done"))).toEqual([
      "5|Done := I >= 3",
      "6|Total += 1",
    ]);
  });

  it("shape 2 boundary (B1): a name-reading condition gets guards but no feeds (revert: close feeds for every loop)", () => {
    for (const head of ["while Go do begin", "while Ready() do begin"]) {
      const src = [
        `        ${head}`,
        "            I += 1;", // 8 claimed: it only feeds Done
        "            Done := I >= 3;", // 9 refused through shape 1 / 3n
        "            Total += 1;", // 10 claimed
        "            if Done then exit;",
        "        end;",
      ];
      expect(claims(removeAssignment, src), head).toEqual(["8|I += 1", "10|Total += 1"]);
    }
  });

  it("shape 2: a feed's own `#if` tail counts when active or undecided, not when inactive", () => {
    const src = [
      "        while true do begin",
      "            I += 1;", // 8
      "            Done := false", // 9
      "#if LETHALX",
      "                or (I >= 3)",
      "#endif",
      "            ;",
      "            Total += 1;", // 14
      "            if Done then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src, V, ["LETHALX"])).not.toContain("8|I += 1");
    expect(claims(removeAssignment, src, V, "undecided")).not.toContain("8|I += 1");
    expect(claims(removeAssignment, src, V, [])).toContain("8|I += 1");
    expect(claims(removeAssignment, src, V, ["LETHALX"])).toContain("14|Total += 1");
  });

  it("shape 2: a feed in an inactive arm is skipped, with the names it reads; active or undecided, it is followed (revert: collect names from inactive arms)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;", // 8
      "            J := I;", // 9
      "#if LETHALX",
      "            Done := J >= 3;",
      "#endif",
      "            Total += 1;", // 13
      "            if Done then exit;",
      "        end;",
    ];
    const builds: (string[] | "undecided")[] = [["LETHALX"], "undecided"];
    for (const b of builds) {
      const got = claims(removeAssignment, src, V, b);
      expect(got, `[${b}]`).not.toContain("8|I += 1");
      expect(got, `[${b}]`).not.toContain("9|J := I");
    }
    expect(claims(removeAssignment, src, V, [])).toEqual(["8|I += 1", "9|J := I", "13|Total += 1"]);
  });

  // Shape 4n: a write to an enclosing `for`'s control variable. Revert: drop the 4n check.
  for (const dir of ["to", "downto"]) {
    it(`shape 4n, \`${dir}\`: a control-variable write is refused through all four operators`, () => {
      const head = dir === "to" ? "for I := 1 to N do begin" : "for I := N downto 1 do begin";
      expect(
        claims(removeAssignment, [
          `        ${head}`,
          "            I += 1;",
          "            Total += 1;",
          "        end;",
        ]),
      ).toEqual(["9|Total += 1"]);
      expect(
        claims(shiftInteger, [
          `        ${head}`,
          "            I := 1;",
          "            Total := 7;",
          "        end;",
        ]),
      ).toEqual(["9|7"]);
      expect(
        claims(swapAdditive, [
          `        ${head}`,
          "            I := I - 1;",
          "            Total := Total + 1;",
          "        end;",
        ]),
      ).toEqual(["9|Total + 1"]);
      expect(
        claims(flipBooleanLiteral, [
          `        ${head}`,
          "            I := I + Delta(true);",
          "            Total := Total + Delta(true);",
          "        end;",
        ]),
      ).toEqual(["9|true"]);
    });
  }

  it("shape 4n CONTROLS: a preheader write, an end-bound write and a guard-only write are still claimed", () => {
    const src = [
      "        I := 5;", // 7 preheader
      "        for I := 1 to N do begin",
      "            N += 1;", // 9 end bound: a known exclusion
      "            I += 1;", // 10 refused
      "            Done := true;", // 11 guard-only: a `for` gets no body guards
      "            if Done then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["7|I := 5", "9|N += 1", "11|Done := true"]);
  });

  it("shape 4n: `A, B: Integer` share a declaration, but a write to B is not A's (revert: compare declarations by position only)", () => {
    const src = [
      "        for A := 1 to N do begin",
      "            B += 1;", // 8 claimed
      "            A += 1;", // 9 refused
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["8|B += 1"]);
  });

  it("shape 4n M2: a `for` is still no loop for flip-boolean-literal's in-loop `if` rule", () => {
    expect(
      claims(flipBooleanLiteral, [
        "        for I := 1 to 3 do",
        "            if true then Total += 1;",
      ]),
    ).toEqual(["8|true"]);
  });

  it("shape 4n: a trigger-local control variable is refused too (sol final r1 minor 3)", () => {
    const src = [
      "codeunit 50000 P",
      "{",
      "    trigger OnRun()",
      "    var",
      "        I: Integer;",
      "        Total: Integer;",
      "    begin",
      "        for I := 1 to 3 do begin",
      "            I := 1;", // 9 refused
      "            Total := 7;", // 10 claimed
      "        end;",
      "    end;",
      "}",
    ].join("\n");
    expect(claimedSites(removeAssignment, src)).toEqual(["10|Total := 7"]);
  });

  it("shape 2: a feed found only inside a nested body (sol final r1 minor 2; revert: scan the loop's own statements only)", () => {
    const src = [
      "        while true do begin",
      "            I += 1;", // 8 refused: feeds Done inside the `for`
      "            for J := 1 to 1 do",
      "                Done := I >= 3;", // 10 refused: the guard reads Done
      "            Total += 1;", // 11 claimed
      "            if Done then exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["11|Total += 1"]);
  });

  // Nesting (B4): each enclosing loop checks the write against ITS OWN exit parts.
  it("nesting: an inner `break` does not exit the outer loop; an inner `exit` does", () => {
    const nested = (leave: string) => [
      "        while Go do begin",
      "            K := 3;", // 8
      "            repeat",
      `                if K > 2 then ${leave};`,
      "            until false;",
      "            exit;",
      "        end;",
    ];
    expect(claims(removeAssignment, nested("break"))).toEqual(["8|K := 3"]);
    expect(claims(removeAssignment, nested("exit"))).toEqual([]);
  });

  it("nesting: a control-variable write inside an inner `while` is refused by the outer `for`", () => {
    const src = [
      "        for I := 1 to N do begin",
      "            J := 0;", // 8 claimed
      "            while J < 3 do begin",
      "                I += 1;", // 10 refused by the for
      "                J += 1;", // 11 refused by the while
      "                Total += 1;", // 12 claimed
      "            end;",
      "        end;",
    ];
    expect(claims(removeAssignment, src)).toEqual(["8|J := 0", "12|Total += 1"]);
  });
});

/**
 * R480's KNOWN EXCLUSIONS: shapes that can hang but that this rule does not extend to. Each pins the
 * write as CLAIMED; a change that starts refusing one must change it here. None is proven safe.
 */
describe("R480 known exclusions: hang-capable writes still claimed", () => {
  const V =
    "Done: Boolean; Go: Boolean; KeepGoing: Boolean; I: Integer; J: Integer; N: Integer; Total: Integer; Cust: Record Customer;";
  const claims = (lines: string[], vars = V) =>
    claimedSites(removeAssignment, unit(lines.join("\n"), vars));

  it("a cursor condition, including a mixed one (`(Cust.Next() <> 0) or KeepGoing`)", () => {
    for (const cond of ["Cust.Next() <> 0", "(Cust.Next() <> 0) or KeepGoing"]) {
      expect(
        claims([
          `        while ${cond} do begin`,
          "            Done := true;",
          "            if Done then exit;",
          "        end;",
        ]),
        cond,
      ).toEqual(["8|Done := true"]);
    }
  });

  it("an outer `for` whose end bound the body moves", () => {
    expect(claims(["        for I := 1 to N do", "            N += 1;"])).toEqual(["8|N += 1"]);
  });

  it("an outer `foreach` whose list the body replaces", () => {
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
