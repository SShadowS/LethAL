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
import { removeAssignment } from "../src/remove-assignment";
import { shiftInteger } from "../src/shift-integer";
import { swapAdditive } from "../src/swap-additive";

// SCRATCH DRAFT (R-818 plan): synthetic shapes only. Run with LETHAL_R818=B (green) and unset (red).
function claimedSites(op: MutationOperator, src: string, symbols?: string[]): string[] {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext(
    [{ path: "fixture.al", root }],
    symbols === undefined ? undefined : new Map([[root, evaluateArms(root, src, symbols)]]),
  );
  const out: string[] = [];
  visit(root, (n: ALSyntaxNode) => {
    const claimed = op.targets(n, ctx);
    expect(claimed, `targets/generate disagree at ${n.text}`).toBe(op.generate(n, ctx).length > 0);
    if (claimed) out.push(`${n.startPosition.row + 1}|${n.text}`);
  });
  return out;
}
const unit = (body: string, vars: string) =>
  `codeunit 50000 P\n{\n    procedure Go2()\n    var\n        ${vars}\n    begin\n${body}\n    end;\n}`;
const V = "Text: Text; Pos: Integer; Result: Text; Out: Text; A: Integer; B: Integer;";
const claims = (op: MutationOperator, lines: string[], symbols?: string[]) =>
  claimedSites(op, unit(lines.join("\n"), V), symbols);

beforeAll(async () => {
  await initParser();
});

describe("R818 draft: a write the loop's step reads", () => {
  const ISSUE = [
    "        Pos := Text.IndexOf('{{');", // 7 claimed (before the loop)
    "        while Pos > 0 do begin", // 8
    "            Result += Text.Substring(1, Pos - 1);", // 9 claimed: nothing reads Result
    "            Text := Text.Substring(Pos + 2);", // 10 REFUSED (the step reads Text)
    "            Pos := Text.IndexOf('{{');", // 11 refused (condition)
    "            Out := Out + 'x';", // 12 claimed: unrelated
    "        end;",
  ];
  it("remove-assignment: the issue's write is refused, the unrelated writes stay", () => {
    expect(claims(removeAssignment, ISSUE).map((s) => s.split("|")[0])).toEqual(["7", "9", "12"]);
  });
  it("swap-additive and shift-integer on the same write are refused too", () => {
    expect(claims(swapAdditive, ISSUE).map((s) => s.split("|")[0])).toEqual(["9"]);
    expect(claims(shiftInteger, ISSUE).map((s) => s.split("|")[0])).toEqual(["9"]);
  });
  it("two hops: a write the step's feeder reads", () => {
    const src = [
      "        Pos := 5;", // 7
      "        while Pos > 0 do begin", // 8
      "            B := B - 1;", // 9 refused (feeds A)
      "            A := B + 1;", // 10 refused (feeds Pos)
      "            Pos := A;", // 11 refused
      "            Out := Out + 'x';", // 12 claimed
      "        end;",
    ];
    expect(claims(removeAssignment, src).map((s) => s.split("|")[0])).toEqual(["7", "12"]);
  });
  it("a write below the step, or under an if, is refused the same way", () => {
    const src = [
      "        Pos := Text.IndexOf('{{');", // 7
      "        repeat", // 8
      "            Pos := Text.IndexOf('{{');", // 9 refused
      "            if Pos > 0 then", // 10
      "                Text := Text.Substring(Pos + 2);", // 11 refused
      "            Out := Out + 'x';", // 12 claimed
      "        until Pos = 0;",
    ];
    expect(claims(removeAssignment, src).map((s) => s.split("|")[0])).toEqual(["7", "12"]);
  });
  it("a condition that names a cursor method keeps its own rule (no feeds)", () => {
    const src = [
      "        while Pos > 0 do begin", // 7
      "            Text := Text.Substring(Pos + 2);", // 8 claimed under the cursor exemption
      "            Pos := Text.IndexOf('{{') + A;", // 9
      "            if Pos < 0 then exit;",
      "        end;",
    ];
    // control: a plain while with no cursor refuses line 8 (see the first test).
    expect(claims(removeAssignment, src).length).toBeGreaterThan(0);
  });
  it("a feed inside an INACTIVE #if arm adds nothing; an active or undecided one counts", () => {
    const src = [
      "        while Pos > 0 do begin", // 7
      "            Pos := A", // 8
      "#if LETHALX",
      "                + B",
      "#endif",
      "            ;",
      "            B := B + 1;", // 13
      "        end;",
    ];
    const inactive = claims(removeAssignment, src, []).map((s) => s.split("|")[0]);
    const active = claims(removeAssignment, src, ["LETHALX"]).map((s) => s.split("|")[0]);
    expect({ inactive, active }).toEqual({ inactive: ["13"], active: [] });
  });
});
