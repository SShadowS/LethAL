import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ALSyntaxNode,
  type MutationSpec,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { shiftInteger } from "../src/shift-integer";

/**
 * R159. The interesting half of this operator is what it REFUSES, and one refusal cannot be proven
 * by any live gate: R164 rules that a hang-capable site must not enter a scored gate, and there is
 * no safe version of one. A loop whose exit depends on a counter is turned non-terminating by
 * `remove-assignment`, by `swap-additive`, and by this operator itself, so an arm that witnessed
 * the loop refusal live would plant a landmine to prove an ABSENCE.
 *
 * An absence needs no server. A refused site produces no mutant, so the server never sees one
 * either way, and the mutant INVENTORY is computed offline and deterministically from the AST.
 * That makes this file the whole proof of the loop cession, and it asserts it POSITIONALLY: the
 * literal in the loop's exit condition is refused while the one in its body is still claimed.
 */
describe("shiftInteger", () => {
  let root: ALSyntaxNode;
  let specs: MutationSpec[];

  beforeAll(async () => {
    await initParser();
    const src = await readFile(resolve(__dirname, "./fixtures/al/shift-integer.al"), "utf8");
    root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    specs = [];
    visit(root, (n) => {
      if (shiftInteger.targets(n, ctx)) specs.push(...shiftInteger.generate(n, ctx));
    });
  });

  it("claims equality-comparison operands and assigned values, and nothing else", () => {
    // `1` here is `Seen += 1` in the loop BODY. The `exit(1)`/`exit(0)` literals three procedures
    // over are call arguments and are absent, which is why this list can be compared by text at all.
    expect(specs.map((s) => `${s.before.text}->${s.after.text}`).sort()).toEqual([
      "1->2",
      "41->42",
      "5->6",
      "7->8",
      "9->10",
    ]);
    for (const s of specs) {
      expect(s.operatorName).toBe("lethal.shift-integer");
      expect(s.parentContext).toBe("statement-position");
    }
  });

  it("refuses the loop's EXIT CONDITION while still claiming its BODY", () => {
    let condition: ALSyntaxNode | null = null;
    let body: ALSyntaxNode | null = null;
    visit(root, (n) => {
      if (n.rawKind !== "repeat_statement") return;
      condition = n.childForFieldName("condition");
      body = n;
    });
    const cond = condition as ALSyntaxNode | null;
    const loop = body as ALSyntaxNode | null;
    if (cond === null || loop === null) throw new Error("fixture lost its repeat loop");

    const inside = (s: MutationSpec, n: ALSyntaxNode): boolean =>
      s.before.startIndex >= n.startIndex && s.before.endIndex <= n.endIndex;

    // The `0` of `until Cust.Next() = 0`, shifting it never terminates once the set is exhausted.
    expect(specs.filter((s) => inside(s, cond))).toEqual([]);
    // ...but `Seen += 1`, in the same loop, is claimed. A whole-loop refusal would lose this.
    expect(specs.filter((s) => inside(s, loop)).map((s) => s.before.text)).toEqual(["1"]);
  });

  it("refuses a literal at AL's 32-bit ceiling, where n + 1 does not fit", () => {
    expect(specs.some((s) => s.before.text === "2147483647")).toBe(false);
  });

  it("cedes an ordering comparison to conditional-boundary, which shifts the same boundary", () => {
    expect(specs.some((s) => s.before.text === "13")).toBe(false);
  });
});
