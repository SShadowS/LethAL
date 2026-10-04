import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R302: every body walk treats a split member's BODY as a procedure body, and never its header
 * region.
 *
 * The oracle is the member's de-preprocessed TWIN: the same text with the `#if` markers and every
 * arm but the first replaced by blank lines, so every line number is kept. HEAD already handles a
 * plain procedure, so the twin's sites are what the split member must give, operator by operator,
 * in both split shapes: R301's `preproc_split_procedure` (one header per arm, one shared `var`
 * section) and R316's `preproc_split_procedure_preamble` (a header and a `var` section per arm).
 */
import {
  type ALSyntaxNode,
  type MutationOperator,
  buildSemanticContext,
  inMemberBody,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { emptyBlock } from "../src/empty-block";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";
import { loopSkip } from "../src/loop-skip";
import { loopTruncate } from "../src/loop-truncate";
import { removeAssignment } from "../src/remove-assignment";
import { shiftInteger } from "../src/shift-integer";
import { swapAdditive } from "../src/swap-additive";
import { swapCallArguments } from "../src/swap-call-arguments";
import { toggleBlankString } from "../src/toggle-blank-string";
import { toggleBlankTemporal } from "../src/toggle-blank-temporal";

const VARS = [
  "        I: Integer;",
  "        D: Date;",
  "        T: Text;",
  "        Done: Boolean;",
];

const BODY = [
  "    begin",
  "        I := 5;",
  "        D := 0D;",
  "        T := '';",
  "        if T <> 'x' then",
  "            T := 'y';",
  "        Done := false;",
  "        while I < 10 do",
  "            I := I + 1;",
  "        repeat",
  "            Done := true;",
  "        until Done;",
  "        Show(I, X);",
  // R196: an additive outside the loop, so swap-additive keeps a site (`I + 1` in the loop is refused).
  "        exit(I + 1);",
  "    end;",
];

const TAIL = ["", "    local procedure Show(A: Integer; B: Integer)", "    begin", "    end;", "}"];

/** A line of the split source and whether the twin keeps it (`false`: blanked). */
type Line = readonly [string, boolean];

/** R301's shape: one header per arm, then ONE shared `var` section and the body. */
function splitShape(): Line[] {
  return [
    ['codeunit 50100 "Repro"', true],
    ["{", true],
    ["#if CLEAN27", false],
    ["    procedure Pick(X: Integer): Integer", true],
    ["#else", false],
    ["    internal procedure Pick(X: Integer): Integer", false],
    ["#endif", false],
    ["    var", true],
    ...VARS.map((v): Line => [v, true]),
    ...BODY.map((b): Line => [b, true]),
    ...TAIL.map((t): Line => [t, true]),
  ];
}

/** R316's shape: each arm has its own header AND `var` section, then one shared body. */
function preambleShape(): Line[] {
  return [
    ['codeunit 50100 "Repro"', true],
    ["{", true],
    ["#if CLEAN27", false],
    ["    procedure Pick(X: Integer): Integer", true],
    ["    var", true],
    ...VARS.map((v): Line => [v, true]),
    ["#else", false],
    ["    procedure Pick(X: Integer): Integer", false],
    ["    var", false],
    ...VARS.map((v): Line => [v, false]),
    ["#endif", false],
    ...BODY.map((b): Line => [b, true]),
    ...TAIL.map((t): Line => [t, true]),
  ];
}

const splitOf = (lines: Line[]): string => `${lines.map(([t]) => t).join("\n")}\n`;
const twinOf = (lines: Line[]): string =>
  `${lines.map(([t, keep]) => (keep ? t : "")).join("\n")}\n`;

/** One operator over every node: `(line, before, after, hangCapable)` per spec, sorted. */
function sitesOf(op: MutationOperator, src: string): string[] {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  const out: string[] = [];
  visit(root, (n) => {
    if (!op.targets(n, ctx)) return;
    for (const s of op.generate(n, ctx)) {
      out.push(
        `${s.before.startPosition.row + 1}|${s.before.text}|${s.after.text}|${s.hangCapable ?? "-"}`,
      );
    }
  });
  return out.sort();
}

const OPERATORS: ReadonlyArray<readonly [string, MutationOperator]> = [
  ["empty-block", emptyBlock],
  ["flip-boolean-literal", flipBooleanLiteral],
  ["toggle-blank-string", toggleBlankString],
  ["toggle-blank-temporal", toggleBlankTemporal],
  ["shift-integer", shiftInteger],
  ["loop-skip", loopSkip],
  ["loop-truncate", loopTruncate],
  ["remove-assignment (the loop-hazard hang refusal)", removeAssignment],
  ["swap-additive (types only; a Task 1 regression pin)", swapAdditive],
  ["swap-call-arguments (types only; a Task 1 regression pin)", swapCallArguments],
];

for (const [shapeName, shape] of [
  ["preproc_split_procedure", splitShape],
  ["preproc_split_procedure_preamble", preambleShape],
] as const) {
  describe(`R302: a ${shapeName} member gives its twin's sites`, () => {
    beforeAll(async () => {
      await initParser();
    });
    const lines = shape();

    it("the fixture parses as that shape, and the twin as a plain procedure", () => {
      const kinds = (src: string): string[] => {
        const out: string[] = [];
        visit(wrapRoot(parseAL(src)), (n) => {
          if (
            n.rawKind.startsWith("preproc_split") ||
            (n.rawKind === "procedure" && n.childForFieldName("name") !== null)
          )
            out.push(n.rawKind);
        });
        return out;
      };
      expect(kinds(splitOf(lines))).toEqual([shapeName, "procedure"]);
      expect(kinds(twinOf(lines))).toEqual(["procedure", "procedure"]);
    });

    for (const [name, op] of OPERATORS) {
      it(`${name}: the same (line, before, after, hang tag) multiset as the twin`, () => {
        const twin = sitesOf(op, twinOf(lines));
        expect(twin.length).toBeGreaterThan(0);
        expect(sitesOf(op, splitOf(lines))).toEqual(twin);
      });
    }
  });
}

// Decision 3: an attribute inside an arm is a CHILD of the split node (a plain procedure's is a
// sibling), so "under a procedure-like node" is not "in executable code". Measured on the
// prototype: without `inMemberBody`, four such booleans in the `a1` repro were claimed and then
// dropped downstream as not executable.
describe("R302: nothing from an attribute inside an arm", () => {
  beforeAll(async () => {
    await initParser();
  });
  const src = `codeunit 50100 "Repro"
{
#if CLEAN27
    [IntegrationEvent(false, false)]
    local procedure OnPick(X: Integer)
#else
    [IntegrationEvent(true, false)]
    local procedure OnPick(X: Integer)
#endif
    begin
    end;
}
`;

  it("flip-boolean-literal finds nothing, and inMemberBody is false there", () => {
    expect(sitesOf(flipBooleanLiteral, src)).toEqual([]);
    const booleans: ALSyntaxNode[] = [];
    visit(wrapRoot(parseAL(src)), (n) => {
      if (n.rawKind === "boolean_literal" || n.text === "true" || n.text === "false")
        if (n.namedChildren.length === 0) booleans.push(n);
    });
    expect(booleans.length).toBeGreaterThanOrEqual(4);
    for (const b of booleans) expect(inMemberBody(b)).toBe(false);
  });
});
