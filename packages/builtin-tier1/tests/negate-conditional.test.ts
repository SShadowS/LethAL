import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { negateConditional } from "../src/negate-conditional";

describe("negateConditional", () => {
  beforeAll(async () => { await initParser(); });

  it("generates specs for =/<> as statement-position, and/or as short-circuit-operand", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/negate-conditional.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const candidates = [
      ...findAll(root, ALNodeKind.comparison_expression),
      ...findAll(root, ALNodeKind.logical_expression),
    ];
    const specs = candidates
      .filter((n) => negateConditional.targets(n, ctx))
      .flatMap((n) => negateConditional.generate(n, ctx));

    expect(specs).toHaveLength(4);

    const byBefore = new Map(specs.map((s) => [s.before.text, s]));
    expect(byBefore.get("A = 0")?.after.text).toBe("A <> 0");
    expect(byBefore.get("A = 0")?.parentContext).toBe("statement-position");
    expect(byBefore.get("A <> 5")?.after.text).toBe("A = 5");
    expect(byBefore.get("A <> 5")?.parentContext).toBe("statement-position");
    expect(byBefore.get("B and C")?.after.text).toBe("B or C");
    expect(byBefore.get("B and C")?.parentContext).toBe("short-circuit-operand");
    expect(byBefore.get("B or C")?.after.text).toBe("B and C");
    expect(byBefore.get("B or C")?.parentContext).toBe("short-circuit-operand");
  });

  it("skips non-target operators in comparison_expression", () => {
    const src = `codeunit 51401 "X" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "x.al", root }]);
    const specs: unknown[] = [];
    visit(root, (n) => {
      if (negateConditional.targets(n, ctx)) specs.push(...negateConditional.generate(n, ctx));
    });
    expect(specs).toHaveLength(0);
  });
});
