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

/** R484: a report with one data item `D` over `table`: `props` and `triggers` inside it, nested
 *  items `inner`, and report-level code `top`. */
const report = (
  table: string,
  props: string[],
  triggers: string[],
  inner: string[] = [],
  top: string[] = [],
) =>
  [
    "report 50000 P",
    "{",
    "    dataset",
    "    {",
    `        dataitem(D; ${table})`,
    "        {",
    ...props.map((p) => `            ${p}`),
    ...triggers.map((t) => `            ${t}`),
    ...inner.map((t) => `            ${t}`),
    "        }",
    "    }",
    ...top.map((t) => `    ${t}`),
    "    var",
    "        Continue: Boolean; Other: Integer; Skipping: Boolean; NoOfLoops: Integer; Stop: Boolean;",
    "}",
  ].join("\n");

/** The R484 shape: a Break guarded by `Continue`, the `Continue` write, and a sibling `Other`. */
const dimLoop = [
  "trigger OnAfterGetRecord()",
  "begin",
  "    if Number > 1 then",
  "        if not Continue then",
  "            CurrReport.Break();",
  "    Continue := false;",
  "    Other := Other + 1;",
  "end;",
];
const pre = (...lines: string[]) => [
  "trigger OnPreDataItem()",
  "begin",
  ...lines.map((l) => `    ${l}`),
  "end;",
];
const onPreReport = (...lines: string[]) => [
  "trigger OnPreReport()",
  "begin",
  ...lines.map((l) => `    ${l}`),
  "end;",
];
const texts = (sites: string[]) => sites.map((s) => s.split("|")[1]);
const removed = (src: string, symbols?: string[] | "undecided") =>
  texts(claimedSites(removeAssignment, src, symbols));
/** R487 blanket rule: in an OPEN item every site is refused, so nothing is claimed. The claimed
 *  control of each certificate test is its BOUNDED twin in the same describe (`CLAIMED`). */
const REFUSED: string[] = [];
const CLAIMED = ["Continue := false", "Other := Other + 1"];
const integer = (props: string[], triggers: string[], inner?: string[]) =>
  report('"Integer"', props, triggers, inner);
const CONST_VIEW = "DataItemTableView = where(Number = const(1));";
const CLOSED_VIEW = "DataItemTableView = where(Number = filter(1 .. 5));";
const childSetRange = [
  'dataitem(Child; "Sales Line")',
  "{",
  "    trigger OnPreDataItem()",
  "    begin",
  "        D.SetRange(Number, 1, 2147483647);",
  "    end;",
  "}",
];

// R487 blanket rule: the R484 tests of WHICH guards are exits (OnPreDataItem Break/Quit, Skip,
// OnPostDataItem, any-guard, a child's Quit/Error/Break) are deleted with the guard collection they
// tested: in an open item every site is refused whatever the guards say, so that code is gone.
describe("R484/R487: an open `Integer` data item refuses every site; a bounded twin claims them", () => {
  it("an open `filter(1 ..)` view refuses every write and literal; with `MaxIteration = 10` both are claimed (revert to red: drop the blanket check, or treat `filter(1 ..)` as closed)", () => {
    const view = "DataItemTableView = where(Number = filter(1 ..));";
    const src = integer([view], dimLoop);
    expect(removed(src)).toEqual(REFUSED);
    expect(texts(claimedSites(flipBooleanLiteral, src))).toEqual([]);
    const twin = integer([view, "MaxIteration = 10;"], dimLoop);
    expect(removed(twin)).toEqual(CLAIMED);
    expect(texts(claimedSites(flipBooleanLiteral, twin))).toEqual(["false"]);
  });

  it("a namespace-qualified `System.Utilities.Integer` item is an Integer item: open refuses, a `MaxIteration` twin claims (revert to red: read the FIRST `table_name` child)", () => {
    const view = "DataItemTableView = where(Number = filter(1 ..));";
    expect(removed(report("System.Utilities.Integer", [view], dimLoop))).toEqual(REFUSED);
    expect(
      removed(report("System.Utilities.Integer", [view, "MaxIteration = 10;"], dimLoop)),
    ).toEqual(CLAIMED);
  });

  it("a real table is bounded (revert to red: drop the `Integer` check)", () => {
    expect(removed(report('"Sales Header"', [], dimLoop))).toEqual(CLAIMED);
  });

  it("swap-additive: an open item refuses every literal operand; a bounded twin claims both (revert to red: drop the blanket check)", () => {
    const trig = [
      "trigger OnAfterGetRecord()",
      "begin",
      "    Other := 2 - 1;",
      "    NoOfLoops := 2 + 1;",
      "    if Other = 1 then",
      "        CurrReport.Break();",
      "end;",
    ];
    expect(texts(claimedSites(swapAdditive, integer([], trig)))).toEqual([]);
    expect(texts(claimedSites(swapAdditive, integer(["MaxIteration = 10;"], trig)))).toEqual([
      "2 - 1",
      "2 + 1",
    ]);
  });

  it("a variable SetRange bound is no bound: every write and shift refused; a literal twin is bounded and claims them (revert to red: accept a variable bound in the certificate)", () => {
    const at = (setRange: string) =>
      integer(
        [],
        [
          "trigger OnAfterGetRecord()",
          "begin",
          "    Other := Other + 1;",
          "end;",
          ...pre("NoOfLoops := 3;", setRange),
        ],
      );
    expect(removed(at("SetRange(Number, 1, NoOfLoops);"))).toEqual(REFUSED);
    expect(texts(claimedSites(shiftInteger, at("SetRange(Number, 1, NoOfLoops);")))).toEqual([]);
    expect(removed(at("SetRange(Number, 1, 3);"))).toEqual([
      "Other := Other + 1",
      "NoOfLoops := 3",
    ]);
  });
});

describe("R484: MaxIteration, an independent bound", () => {
  it("`MaxIteration = 10` bounds it (revert to red: drop the MaxIteration check)", () => {
    expect(removed(integer(["MaxIteration = 10;"], dimLoop))).toEqual(CLAIMED);
  });

  it("`MaxIteration = 0` (no limit) does not (revert to red: accept 0)", () => {
    expect(removed(integer(["MaxIteration = 0;"], dimLoop))).toEqual(REFUSED);
  });

  it("a MaxIteration above the cap is no bound (revert to red: drop the cap on MaxIteration)", () => {
    expect(removed(integer(["MaxIteration = 100000000;"], dimLoop))).toEqual(REFUSED);
  });

  it("MaxIteration stays a bound under a widening filter (revert to red: MaxIteration needs the mention scan)", () => {
    const src = integer(
      ["MaxIteration = 10;"],
      [...dimLoop, ...pre("D.SetRange(Number, 1, 2147483647);")],
    );
    expect(removed(src)).toEqual(CLAIMED);
  });

  const ifMax = integer(["#if FOO", "MaxIteration = 10;", "#endif"], dimLoop);

  it("a MaxIteration in an undecided `#if` arm is no bound (revert to red: certificates read undecided `#if` arms)", () => {
    expect(removed(ifMax, "undecided")).toEqual(REFUSED);
  });

  it("a MaxIteration in an active `#if` arm bounds it (revert to red: certificates ignore `#if` arms)", () => {
    expect(removed(ifMax, ["FOO"])).toEqual(CLAIMED);
  });

  it("a direct MaxIteration in an undecided file still bounds it, as the engine's `liveMembers` keeps it (revert to red: certificates need an active arm everywhere)", () => {
    expect(removed(integer(["MaxIteration = 10;"], dimLoop), "undecided")).toEqual(CLAIMED);
  });
});

describe("R484: a view bound holds only with zero mentions of the record", () => {
  const ifView = integer(["#if FOO", CONST_VIEW, "#endif"], dimLoop);

  it("a view in an undecided `#if` arm is no bound (revert to red: certificates read undecided `#if` arms)", () => {
    expect(removed(ifView, "undecided")).toEqual(REFUSED);
  });

  it("a view in an active `#if` arm bounds it (revert to red: certificates ignore `#if` arms)", () => {
    expect(removed(ifView, ["FOO"])).toEqual(CLAIMED);
  });

  it("a `const(1)` view bounds it (revert to red: ignore `const`)", () => {
    expect(removed(integer([CONST_VIEW], dimLoop))).toEqual(CLAIMED);
  });

  it("a closed `filter(1 .. 5)` view bounds it (revert to red: `closedFilter` answers false)", () => {
    expect(removed(integer([CLOSED_VIEW], dimLoop))).toEqual(CLAIMED);
  });

  it("a closed view above the cap is no bound (revert to red: drop the cap on views)", () => {
    const src = integer(["DataItemTableView = where(Number = filter(1 .. 2147483647));"], dimLoop);
    expect(removed(src)).toEqual(REFUSED);
  });

  it("a reversed view range `filter(5 .. 1)` is no bound (revert to red: drop the reversed check)", () => {
    expect(
      removed(integer(["DataItemTableView = where(Number = filter(5 .. 1));"], dimLoop)),
    ).toEqual(REFUSED);
  });

  it("a view union at exactly the cap bounds it (revert to red: `<` instead of `<=`)", () => {
    const view = "DataItemTableView = where(Number = filter(1 .. 500000 | 500001 .. 1000000));";
    expect(removed(integer([view], dimLoop))).toEqual(CLAIMED);
  });

  it("a view union whose parts are under the cap but whose total is over does not (revert to red: cap each part, not the sum)", () => {
    const view = "DataItemTableView = where(Number = filter(1 .. 600000 | 700001 .. 1300000));";
    expect(removed(integer([view], dimLoop))).toEqual(REFUSED);
  });

  it("a const view replaced by D.SetRange is no bound (revert to red: view bounds skip the mention scan)", () => {
    const src = integer([CONST_VIEW], [...dimLoop, ...pre("D.SetRange(Number, 1, 2147483647);")]);
    expect(removed(src)).toEqual(REFUSED);
  });

  it("a closed view replaced by D.SetFilter is no bound (revert to red: view bounds skip the mention scan)", () => {
    const src = integer([CLOSED_VIEW], [...dimLoop, ...pre("D.SetFilter(Number, '1..');")]);
    expect(removed(src)).toEqual(REFUSED);
  });

  it("a closed view replaced through a CopyFilter destination is no bound (revert to red: view bounds skip the mention scan)", () => {
    const src = report(
      '"Integer"',
      [CLOSED_VIEW],
      dimLoop,
      [],
      onPreReport("Src.CopyFilter(Number, D.Number);"),
    );
    expect(removed(src)).toEqual(REFUSED);
  });

  it("a const view replaced in a child trigger is no bound (revert to red: view bounds skip the mention scan)", () => {
    expect(removed(integer([CONST_VIEW], dimLoop, childSetRange))).toEqual(REFUSED);
  });
});

describe("R484: the single-mention SetRange certificate", () => {
  /** One literal SetRange in OnPreDataItem (plus `setRange`'s other lines), report-level code
   *  `top`, nested items `inner`. */
  const bounded = (setRange: string, top: string[] = [], inner: string[] = []) =>
    report('"Integer"', [], [...dimLoop, ...pre(setRange)], inner, top);

  it("control: the one literal SetRange alone bounds it (revert to red: drop the certificate)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3);"))).toEqual(CLAIMED);
  });

  const armed = integer([], [...dimLoop, ...pre("#if FOO", "SetRange(Number, 1, 3);", "#endif")]);

  it("a bound in a compiled-out `#if` arm does not hold (revert to red: drop the active-arm check)", () => {
    expect(removed(armed, [])).toEqual(REFUSED);
  });

  it("a bound in an undecided `#if` arm does not hold (revert to red: drop the active-arm check)", () => {
    expect(removed(armed, "undecided")).toEqual(REFUSED);
  });

  it("a bound in an active `#if` arm holds (revert to red: refuse any bound inside `#if`)", () => {
    expect(removed(armed, ["FOO"])).toEqual(CLAIMED);
  });

  it("a bound set in OnAfterGetRecord, too late, does not hold (revert to red: accept any trigger)", () => {
    const late = [...dimLoop.slice(0, 2), "    SetRange(Number, 1, 3);", ...dimLoop.slice(2)];
    expect(removed(integer([], late))).toEqual(REFUSED);
  });

  it("a conditional bound does not hold (revert to red: `unconditional` answers true)", () => {
    expect(removed(bounded("if Skipping then SetRange(Number, 1, 3);"))).toEqual(REFUSED);
  });

  it("a bound after an `exit` does not hold (revert to red: drop the exit-before check)", () => {
    expect(removed(bounded("if Skipping then exit; SetRange(Number, 1, 3);"))).toEqual(REFUSED);
  });

  it("an inverted SetRange(Number, 3, 1) is no bound (revert to red: drop lo <= hi)", () => {
    expect(removed(bounded("SetRange(Number, 3, 1);"))).toEqual(REFUSED);
  });

  it("SetRange at exactly the cap bounds it (revert to red: `<` instead of `<=`)", () => {
    expect(removed(bounded("SetRange(Number, 1, 1000000);"))).toEqual(CLAIMED);
  });

  it("SetRange one above the cap does not (revert to red: drop the SetRange cap)", () => {
    expect(removed(bounded("SetRange(Number, 1, 1000001);"))).toEqual(REFUSED);
  });

  it("a second SetRange widening to 2147483647 voids it (revert to red: count the implicit calls once)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3); SetRange(Number, 1, 2147483647);"))).toEqual(
      REFUSED,
    );
  });

  it("`SetRange(Number)` clearing it voids it (revert to red: count the implicit calls once)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3); SetRange(Number);"))).toEqual(REFUSED);
  });

  it("a bare `Reset;` voids it (revert to red: drop the implicit-call count)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3); Reset;"))).toEqual(REFUSED);
  });

  it("a bare `D.Reset;` voids it (revert to red: drop the name-mention count)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3); D.Reset;"))).toEqual(REFUSED);
  });

  it("a CopyFilter whose DESTINATION is the item voids it (revert to red: count only the receiver of a called method, so `D.Number` as an argument is not a mention)", () => {
    const src = bounded(
      "SetRange(Number, 1, 3);",
      onPreReport("Src.CopyFilter(Number, D.Number);"),
    );
    expect(removed(src)).toEqual(REFUSED);
  });

  it("`D.Copy(Src)` voids it (revert to red: drop the name-mention count)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3);", onPreReport("D.Copy(Src);")))).toEqual(
      REFUSED,
    );
  });

  it("`Clear(D)` outside the item voids it (revert to red: count only method receivers)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3);", onPreReport("Clear(D);")))).toEqual(REFUSED);
  });

  it("D passed to a procedure voids it (revert to red: count only method receivers)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3);", onPreReport("Widen(D);")))).toEqual(REFUSED);
  });

  it("a child trigger naming the parent's record voids it (revert to red: scan only the item's own triggers)", () => {
    expect(removed(bounded("SetRange(Number, 1, 3);", [], childSetRange))).toEqual(REFUSED);
  });
});

describe("R484: nested data items", () => {
  const parentWrites = [
    "trigger OnAfterGetRecord()",
    "begin",
    "    Continue := false;",
    "    Other := Other + 1;",
    "end;",
  ];
  const child = (stmt: string) => [
    'dataitem(Child; "Sales Line")',
    "{",
    "    trigger OnAfterGetRecord()",
    "    begin",
    "        if not Continue then",
    `            ${stmt}`,
    "    end;",
    "}",
  ];

  it("a write in a child's trigger is inside the open parent's loop: refused; under a bounded parent: claimed (revert to red: drop the blanket check)", () => {
    const inner = [
      'dataitem(Child; "Sales Line")',
      "{",
      "    trigger OnAfterGetRecord()",
      "    begin",
      "        Continue := true;",
      "    end;",
      "}",
    ];
    expect(removed(integer([], dimLoop, inner))).toEqual(REFUSED);
    expect(removed(integer(["MaxIteration = 10;"], dimLoop, inner))).toEqual([
      ...CLAIMED,
      "Continue := true",
    ]);
  });

  it("an unread write in a BOUNDED Integer child of an open parent: refused; under a bounded parent: claimed (revert to red: `insideOpenItem` stops at the nearest item)", () => {
    const inner = [
      'dataitem(Child; "Integer")',
      "{",
      "    MaxIteration = 1;",
      "    trigger OnAfterGetRecord()",
      "    begin",
      "        NoOfLoops := 1;",
      "    end;",
      "}",
    ];
    expect(removed(integer([], dimLoop, inner))).toEqual(REFUSED);
    expect(removed(integer(["MaxIteration = 10;"], dimLoop, inner))).toEqual([
      ...CLAIMED,
      "NoOfLoops := 1",
    ]);
  });

  it("an open parent's writes are refused even when only a child's Break (which ends just the child) reads them; bounded parent: claimed (revert to red: drop the blanket check)", () => {
    expect(removed(integer([], parentWrites, child("CurrReport.Break();")))).toEqual(REFUSED);
    expect(
      removed(integer(["MaxIteration = 10;"], parentWrites, child("CurrReport.Break();"))),
    ).toEqual(CLAIMED);
  });
});

// ---- R487 blanket rule ----
/** An `OnAfterGetRecord` trigger with these statements. */
const agr = (...lines: string[]) => [
  "trigger OnAfterGetRecord()",
  "begin",
  ...lines.map((l) => `    ${l}`),
  "end;",
];
const proc = (header: string, ...lines: string[]) => [
  `local procedure ${header}`,
  "begin",
  ...lines.map((l) => `    ${l}`),
  "end;",
];
const withTop = (props: string[], triggers: string[], top: string[]) =>
  report('"Integer"', props, triggers, [], top);
const flips = (src: string) => texts(claimedSites(flipBooleanLiteral, src));
const shifts = (src: string) => texts(claimedSites(shiftInteger, src));

describe("R487 blanket rule: sol-r3's four scenarios are refused", () => {
  it("#1 input parameter: `Other += 1; Step(Other)` with `if N > 3 then Break` in Step: refused (revert to red: drop the blanket check)", () => {
    const src = withTop(
      [],
      agr("Other += 1;", "Step(Other);"),
      proc("Step(N: Integer)", "if N > 3 then", "    CurrReport.Break();"),
    );
    expect(removed(src)).toEqual([]);
    expect(shifts(src)).toEqual([]);
  });
  it("#1 literal argument: `Step(true)` with `if B then Break` in Step: the flip is refused (revert to red: drop the blanket check)", () => {
    const src = withTop(
      [],
      agr("Step(true);"),
      proc("Step(B: Boolean)", "if B then", "    CurrReport.Break();"),
    );
    expect(flips(src)).toEqual([]);
  });
  it("#2 control across a call: `if Other > 3 then MarkDone()`, MarkDone sets Stop: both writes refused (revert to red: drop procedure reachability)", () => {
    const src = withTop(
      [],
      agr(
        "Other += 1;",
        "if Other > 3 then",
        "    MarkDone();",
        "if Stop then",
        "    CurrReport.Break();",
      ),
      proc("MarkDone()", "Stop := true;"),
    );
    expect(removed(src)).toEqual([]);
  });
  it("#2 early return: `if Other <= 3 then exit; Stop := true`: refused (revert to red: drop the blanket check)", () => {
    const src = withTop(
      [],
      agr(
        "Other += 1;",
        "if Other <= 3 then",
        "    exit;",
        "Stop := true;",
        "if Stop then",
        "    CurrReport.Break();",
      ),
      [],
    );
    expect(removed(src)).toEqual([]);
  });
  it("#3 record alias: `NoOfLoops := 3; SetBound(D, NoOfLoops)` with `R.SetRange(Number, 1, Upper)`: refused (revert to red: drop the blanket check)", () => {
    const src = withTop(
      [],
      [
        "trigger OnPreDataItem()",
        "begin",
        "    NoOfLoops := 3;",
        "    SetBound(D, NoOfLoops);",
        "end;",
      ],
      proc("SetBound(var R: Record Integer; Upper: Integer)", "R.SetRange(Number, 1, Upper);"),
    );
    expect(removed(src)).toEqual([]);
  });
  it("transitive: a write two calls deep from an open item: refused (revert to red: reachability stops at direct callees)", () => {
    const src = withTop([], agr("Outer();"), [
      ...proc("Outer()", "Inner();"),
      ...proc("Inner()", "Other := 0;"),
    ]);
    expect(removed(src)).toEqual([]);
  });
  it("a column source's callee in an open item: refused (revert to red: drop `report_column` from `codeScope`)", () => {
    const src = withTop(
      ["column(Col; Calc())", "{", "}"],
      agr("CurrReport.Break();"),
      proc("Calc(): Integer", "Other := 0;"),
    );
    expect(removed(src)).toEqual([]);
  });
});

describe("R487 blanket rule: controls stay claimed", () => {
  it("a BOUNDED item (`MaxIteration = 10`): its writes and its callee's writes claimed (revert to red: drop the open check)", () => {
    const src = withTop(
      ["MaxIteration = 10;"],
      agr("Other += 1;", "Step();"),
      proc("Step()", "Stop := true;"),
    );
    expect(removed(src)).toEqual(["Other += 1", "Stop := true"]);
  });
  it("a procedure called only from OnPreReport: claimed (revert to red: reachability ignores the callee name)", () => {
    const src = report(
      '"Integer"',
      [],
      agr("Other2();"),
      [],
      [
        "trigger OnPreReport()",
        "begin",
        "    Init();",
        "end;",
        ...proc("Init()", "Other := 0;"),
        ...proc("Other2()"),
      ],
    );
    expect(removed(src)).toEqual(["Other := 0"]);
  });
  it("a pageextension `modify` block is not a data item: claimed (revert to red: count every `modify_modification`)", () => {
    const src = [
      'pageextension 50001 E extends "Customer Card"',
      "{",
      "    layout",
      "    {",
      "        modify(Name)",
      "        {",
      "            trigger OnAfterValidate()",
      "            begin",
      "                Other := 0;",
      "            end;",
      "        }",
      "    }",
      "    var",
      "        Other: Integer;",
      "}",
    ].join("\n");
    expect(removed(src)).toEqual(["Other := 0"]);
  });
  const ext = [
    'reportextension 50001 E extends "P"',
    "{",
    "    dataset",
    "    {",
    "        modify(D)",
    "        {",
    "            trigger OnAfterAfterGetRecord()",
    "            begin",
    "                Total := 0;",
    "            end;",
    "        }",
    "    }",
    "    var",
    "        Total: Integer;",
    "}",
  ].join("\n");
  const extClaims = (base: string | null) => {
    const files: { path: string; root: ALSyntaxNode }[] = [
      { path: "e.al", root: wrapRoot(parseAL(ext)) },
    ];
    if (base !== null) files.push({ path: "b.al", root: wrapRoot(parseAL(base)) });
    const ctx = buildSemanticContext(files);
    const out: string[] = [];
    visit(files[0]?.root as ALSyntaxNode, (n: ALSyntaxNode) => {
      if (removeAssignment.targets(n, ctx)) out.push(n.text);
    });
    return out;
  };
  it("reportextension `modify(D)` over a base report NOT in the project: refused (revert to red: drop the modify branch)", () => {
    expect(extClaims(null)).toEqual([]);
  });
  it("reportextension `modify(D)` whose base item in the project is bounded: claimed (revert to red: `modifiedItemOpen` answers true)", () => {
    expect(extClaims(report('"Integer"', ["MaxIteration = 10;"], []))).toEqual(["Total := 0"]);
  });
});

// ---- r5 (sol-r4): scope-boundary regressions, each with a BOUNDED twin that stays claimed ----
const BOUND = "MaxIteration = 1;";
/** A report whose top item `D` (over Integer) carries `props`, `body` lines (triggers, columns,
 *  child items) and report-level `top` lines. */
const rep5 = (props: string[], body: string[], top: string[] = []) =>
  [
    "report 50000 P",
    "{",
    "    dataset",
    "    {",
    '        dataitem(D; "Integer")',
    "        {",
    ...[...props, ...body].map((l) => `            ${l}`),
    "        }",
    "    }",
    ...top.map((l) => `    ${l}`),
    "    var",
    "        Continue: Boolean; Other: Integer; Stop: Boolean;",
    "}",
  ].join("\n");
/** Open (no props) -> every site refused; bounded twin (`BOUND`) -> exactly `claimed`. */
const openAndTwin = (
  body: string[],
  top: string[],
  claimed: { removed: string[]; flips: string[] },
  symbols?: string[],
) => {
  const at = (props: string[]) => rep5(props, body, top);
  expect(removed(at([]), symbols)).toEqual([]);
  expect(texts(claimedSites(flipBooleanLiteral, at([]), symbols))).toEqual([]);
  expect(removed(at([BOUND]), symbols)).toEqual(claimed.removed);
  expect(texts(claimedSites(flipBooleanLiteral, at([BOUND]), symbols))).toEqual(claimed.flips);
};
const STEP_BODY = [
  "begin",
  "    if true then",
  "        CurrReport.Break();",
  "    Other := 0;",
  "    Inner();",
  "end;",
];
const INNER = proc("Inner()", "Stop := true;");
const BOTH_CLAIMED = { removed: ["Other := 0", "Stop := true"], flips: ["true", "true"] };

describe("R487 r5 sol-r4 #1: split-header procedures are procedures", () => {
  const split = (arm2: string) => [
    "#if CLEAN27",
    "local procedure Step()",
    "#else",
    `local procedure ${arm2}()`,
    "#endif",
    ...STEP_BODY,
    ...INNER,
  ];
  const preamble = (arm2: string) => [
    "#if CLEAN27",
    "local procedure Step()",
    "var",
    "    X: Integer;",
    "#else",
    `local procedure ${arm2}()`,
    "var",
    "    X: Integer;",
    "#endif",
    ...STEP_BODY,
    ...INNER,
  ];
  for (const [kind, shape] of [
    ["preproc_split_procedure", split],
    ["preproc_split_procedure_preamble", preamble],
  ] as const) {
    it(`${kind}: its body and its transitive callee are refused in an open item, claimed in a bounded twin (revert to red: \`kind === procedure\` in \`inOpenItemCode\`/\`openReachable\`)`, () => {
      openAndTwin(agr("Step();"), shape("Step"), BOTH_CLAIMED, ["CLEAN27"]);
    });
    it(`${kind} with a RENAMED arm, called by the other arm's name: refused (revert to red: read only the first arm's name)`, () => {
      openAndTwin(agr("Step2();"), shape("Step2"), BOTH_CLAIMED, ["CLEAN27"]);
    });
  }
  it("the split shapes really parse as split procedures (guards the two tests above)", () => {
    for (const shape of [split("Step2"), preamble("Step2")]) {
      const root = wrapRoot(parseAL(rep5([], agr("Step();"), shape)));
      const kinds: string[] = [];
      visit(root, (n: ALSyntaxNode) => {
        if (n.rawKind.startsWith("preproc_split_procedure")) kinds.push(n.rawKind);
      });
      expect(kinds.length).toBe(1);
    }
  });
});

describe("R487 r5: every call shape, and nested columns, with bounded twins", () => {
  const body = proc("Step()", "if true then", "    CurrReport.Break();", "Other := 0;", "Inner();");
  for (const call of ["Step();", "Step;", "this.Step();"]) {
    it(`\`${call}\` from an open item: callee and its callee refused; bounded twin claims (revert to red: \`bareCallee\` drops this shape)`, () => {
      openAndTwin(agr(call), [...body, ...INNER], BOTH_CLAIMED);
    });
  }
  it("a column of a CHILD item calling a procedure: refused under an open parent, claimed under a bounded one (revert to red: drop `report_column` from `codeScope`)", () => {
    const child = [
      'dataitem(C; "Sales Line")',
      "{",
      "    column(Col; Calc())",
      "    {",
      "    }",
      "}",
    ];
    openAndTwin(
      child,
      [...proc("Calc(): Integer", "Other := 0;", "Inner();", "exit(1);"), ...INNER],
      { removed: ["Other := 0", "Stop := true"], flips: ["true"] },
    );
  });
});

/** A one-file project: the base report (if any) and the extension, `symbols` evaluated. */
const extSites = (op: typeof removeAssignment, files: string[], symbols: string[]) => {
  const src = files.join("\n");
  return texts(claimedSites(op, src, symbols));
};
const EXT_TRIGGER = [
  "trigger OnAfterAfterGetRecord()",
  "begin",
  "    Stop := true;",
  "    if Stop then",
  "        CurrReport.Break();",
  "end;",
];
const ext5 = (target: string, wrapped: boolean) =>
  [
    ...(wrapped ? ["#if CLEAN27"] : []),
    'reportextension 50001 E extends "P"',
    "{",
    "    dataset",
    "    {",
    `        modify(${target})`,
    "        {",
    ...EXT_TRIGGER.map((l) => `            ${l}`),
    "        }",
    "    }",
    "}",
    ...(wrapped ? ["#endif"] : []),
  ].join("\n");

describe("R487 r5 sol-r4 #2: an `#if`-wrapped reportextension", () => {
  it("active arm, base absent: its modify trigger is refused; the same base in-project and bounded: claimed (revert to red: `objectOf` returns the file-root child)", () => {
    expect(extSites(removeAssignment, [ext5("D", true)], ["CLEAN27"])).toEqual([]);
    expect(extSites(flipBooleanLiteral, [ext5("D", true)], ["CLEAN27"])).toEqual([]);
    const bounded = rep5([BOUND], agr("Other := 0;"));
    expect(extSites(removeAssignment, [bounded, ext5("D", true)], ["CLEAN27"])).toEqual([
      "Other := 0",
      "Stop := true",
    ]);
  });
});

describe("R487 r5 sol-r4 #3: a modify(D) block runs inside every enclosing base item", () => {
  const child = (parentProps: string[], childProps: string[]) =>
    rep5(parentProps, [
      ...agr("if not Continue then", "    CurrReport.Break();"),
      'dataitem(C; "Integer")',
      "{",
      ...childProps.map((p) => `    ${p}`),
      "}",
    ]);
  it("a BOUNDED child inside an OPEN base parent: the extension's write is refused; parent bounded too: claimed (revert to red: check only the target item)", () => {
    expect(extSites(removeAssignment, [child([], [BOUND]), ext5("C", false)], [])).toEqual([]);
    expect(extSites(removeAssignment, [child([BOUND], [BOUND]), ext5("C", false)], [])).toEqual([
      "Stop := true",
    ]);
  });
  it("an ordinary-table child inside an open parent: refused (revert to red: check only the target item)", () => {
    const src = rep5(
      [],
      [
        ...agr("if not Continue then", "    CurrReport.Break();"),
        'dataitem(C; "Sales Line")',
        "{",
        "}",
      ],
    );
    expect(extSites(removeAssignment, [src, ext5("C", false)], [])).toEqual([]);
  });
  it("a base item bounded only by a view certificate counts as open once extended; a MaxIteration bound still holds (revert to red: trust the view certificate)", () => {
    expect(extSites(removeAssignment, [rep5([CONST_VIEW], []), ext5("D", false)], [])).toEqual([]);
    expect(extSites(removeAssignment, [rep5([BOUND], []), ext5("D", false)], [])).toEqual([
      "Stop := true",
    ]);
  });
});

// ---- r6 (sol-r5): extensions reach the BASE report's code, and add/addlast blocks ----
/** A reportextension of "P" (or `base`) with dataset `blocks`, report-level `top` lines. */
const extOf = (blocks: string[], top: string[] = [], base = "P") =>
  [
    `reportextension 50001 E extends "${base}"`,
    "{",
    "    dataset",
    "    {",
    ...blocks.map((l) => `        ${l}`),
    "    }",
    ...top.map((l) => `    ${l}`),
    "}",
  ].join("\n");
const WIDEN = extOf([
  "modify(D)",
  "{",
  "    trigger OnAfterPreDataItem()",
  "    begin",
  "        D.SetRange(Number, 1, 2147483647);",
  "    end;",
  "}",
]);

describe("R487 r6 sol-r5 #1: a project reportextension voids the BASE item's view certificate for the base code too", () => {
  it("base `const(1)` item, extended in the project: its own guard writes are refused; not extended: claimed; extended but `MaxIteration`-bounded: claimed (revert to red: `itemOpen` ignores `reportExtended`)", () => {
    expect(extSites(removeAssignment, [rep5([CONST_VIEW], dimLoop), WIDEN], [])).toEqual([]);
    expect(extSites(flipBooleanLiteral, [rep5([CONST_VIEW], dimLoop), WIDEN], [])).toEqual([]);
    expect(extSites(removeAssignment, [rep5([CONST_VIEW], dimLoop)], [])).toEqual(CLAIMED);
    expect(extSites(removeAssignment, [rep5([BOUND], dimLoop), WIDEN], [])).toEqual(CLAIMED);
  });
  it("a namespace-qualified `System.Utilities.Integer` base item: extended, refused; not extended, claimed (revert to red: `isIntegerItem` reads the FIRST `table_name` child)", () => {
    const q = rep5([CONST_VIEW], dimLoop).replace(
      'dataitem(D; "Integer")',
      "dataitem(D; System.Utilities.Integer)",
    );
    expect(extSites(removeAssignment, [q, WIDEN], [])).toEqual([]);
    expect(extSites(removeAssignment, [q], [])).toEqual(CLAIMED);
  });
  it("an extension of ANOTHER report leaves the certificate standing (revert to red: `reportExtended` answers true)", () => {
    const other = extOf(["modify(D)", "{", "}"], [], "Q");
    expect(extSites(removeAssignment, [rep5([CONST_VIEW], dimLoop), other], [])).toEqual(CLAIMED);
  });
  it("the base item's callee is refused too (revert to red: `itemOpen` ignores `reportExtended`)", () => {
    // `this.Step()`, not `Step()`: an unqualified call is itself a mention that voids the view.
    const base = rep5([CONST_VIEW], agr("this.Step();"), proc("Step()", "Other := 0;"));
    expect(extSites(removeAssignment, [base, WIDEN], [])).toEqual([]);
    expect(extSites(removeAssignment, [base], [])).toEqual(["Other := 0"]);
  });
});

describe("R487 r6 sol-r5 #2: add/addfirst/addlast blocks run under their base anchor", () => {
  const CALC = proc("Calc(): Integer", "Stop := false;", "exit(1);");
  const addCol = (kind: string) =>
    extOf([`${kind}(D)`, "{", "    column(Col; Calc())", "    {", "    }", "}"], CALC);
  for (const kind of ["add", "addfirst", "addlast"]) {
    it(`\`${kind}(D)\` column calling the extension's Calc(): refused under an open base D, claimed under a bounded one (revert to red: \`isExtensionBlock\` reads only \`modify\`)`, () => {
      expect(extSites(removeAssignment, [rep5([], []), addCol(kind)], [])).toEqual([]);
      expect(extSites(removeAssignment, [rep5([BOUND], []), addCol(kind)], [])).toEqual([
        "Stop := false",
      ]);
    });
  }
  it("a BOUNDED child item added under an open base D: its write is refused; under a bounded D: claimed (revert to red: stop at the added item)", () => {
    const addItem = extOf([
      "addlast(D)",
      "{",
      '    dataitem(X; "Integer")',
      "    {",
      "        MaxIteration = 1;",
      "        trigger OnAfterGetRecord()",
      "        begin",
      "            Stop := true;",
      "        end;",
      "    }",
      "}",
    ]);
    expect(extSites(removeAssignment, [rep5([], []), addItem], [])).toEqual([]);
    expect(extSites(removeAssignment, [rep5([BOUND], []), addItem], [])).toEqual(["Stop := true"]);
  });
  it("an add block whose base report is absent: refused (revert to red: an unresolved anchor counts as bounded)", () => {
    expect(extSites(removeAssignment, [addCol("add")], [])).toEqual([]);
  });
});

// ---- r7 (sol-r6): the extended-report list, across SEPARATE files ----
/** Sites `op` claims in the FIRST file of a multi-file project (arms evaluated with `symbols`);
 *  `noFiles`: the context without its file list, as a hand-built context has. */
const baseSites = (
  op: typeof removeAssignment,
  files: string[],
  symbols: string[] = [],
  noFiles = false,
) => {
  const parsed = files.map((text, i) => ({
    path: `f${i}.al`,
    text,
    root: wrapRoot(parseAL(text)),
  }));
  const built = buildSemanticContext(
    parsed.map(({ path, root }) => ({ path, root })),
    new Map(parsed.map((p) => [p.root, evaluateArms(p.root, p.text, symbols)])),
  );
  const { files: _dropped, ...withoutFiles } = built;
  const ctx = noFiles ? withoutFiles : built;
  const out: string[] = [];
  const [first] = parsed;
  if (first === undefined) return out;
  visit(first.root, (n: ALSyntaxNode) => {
    if (op.targets(n, ctx)) out.push(n.text);
  });
  return out;
};
const BASE7 = rep5([CONST_VIEW], dimLoop);
const extNamed = (head: string) =>
  [
    "namespace Ext.Space;",
    "",
    `reportextension 50001 E extends ${head}`,
    "{",
    "    dataset",
    "    {",
    "        modify(D)",
    "        {",
    "            trigger OnAfterPreDataItem()",
    "            begin",
    "                D.SetRange(Number, 1, 2147483647);",
    "            end;",
    "        }",
    "    }",
    "}",
  ].join("\n");

describe("R487 r7 sol-r6 #1: a namespace-qualified extension in another file voids the BASE certificate", () => {
  it("the pinned grammar puts only the LAST name segment in `base_object` (sol-r7 #2: fails if a grammar change puts the qualifier there)", () => {
    const baseObjectOf = (head: string): string | null => {
      let found: string | null = null;
      visit(wrapRoot(parseAL(extNamed(head))), (n: ALSyntaxNode) => {
        if (n.rawKind === "reportextension_declaration") {
          found = n.childForFieldName("base_object")?.text ?? null;
        }
      });
      return found;
    };
    expect(baseObjectOf("My.Reports.P")).toBe("P");
    expect(baseObjectOf('"My"."Reports"."P"')).toBe('"P"');
    expect(baseObjectOf('"P"')).toBe('"P"');
  });
  it('`extends My.Reports.P` and `"My"."Reports"."P"`: the base file\'s assignment is refused; `My.Reports.Q`: claimed (revert to red: match the whole `extends` clause text, qualifier included)', () => {
    expect(baseSites(removeAssignment, [BASE7, extNamed("My.Reports.P")])).toEqual([]);
    expect(baseSites(removeAssignment, [BASE7, extNamed('"My"."Reports"."P"')])).toEqual([]);
    expect(baseSites(flipBooleanLiteral, [BASE7, extNamed("My.Reports.P")])).toEqual([]);
    expect(baseSites(removeAssignment, [BASE7, extNamed("My.Reports.Q")])).toEqual(CLAIMED);
  });
  it("an extension with no base name at all counts as extending every report (revert to red: drop `ANY_REPORT`)", () => {
    expect(baseSites(removeAssignment, [BASE7, extNamed("")])).toEqual([]);
  });
  it("a context WITHOUT its file list answers `extended`; with it and no extension, the certificate holds (revert to red: no file list answers `not extended`)", () => {
    expect(baseSites(removeAssignment, [BASE7], [], true)).toEqual([]);
    expect(baseSites(removeAssignment, [BASE7])).toEqual(CLAIMED);
  });
  it("an `#if`-wrapped extension in another file, active arm: the base certificate is voided; inactive arm counts too (revert to red: read only the file root's direct children)", () => {
    const wrapped = ["#if CLEAN27", extNamed("P"), "#endif"].join("\n");
    expect(baseSites(removeAssignment, [BASE7, wrapped], ["CLEAN27"])).toEqual([]);
    expect(baseSites(removeAssignment, [BASE7, wrapped], [])).toEqual([]);
  });
});
