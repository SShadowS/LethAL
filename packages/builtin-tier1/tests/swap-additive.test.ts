import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { swapAdditive } from "../src/swap-additive";

describe("swapAdditive", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("tags an in-loop additive expression that advances the condition (R196), and does NOT tag the preheader one", () => {
    const src = `codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
        Total: Integer;
    begin
        Total := Remaining + 1;
        while Remaining > 0 do
            Remaining := Remaining - 1;
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const specs = findAll(root, ALNodeKind.additive_expression)
      .filter((n) => swapAdditive.targets(n, ctx))
      .flatMap((n) => swapAdditive.generate(n, ctx));

    const inLoop = specs.filter((s) => s.before.text === "Remaining - 1");
    expect(inLoop.length).toBeGreaterThan(0);
    for (const s of inLoop) expect(s.hangCapable).toBe("loop-condition-target");

    const preheader = specs.filter((s) => s.before.text === "Remaining + 1");
    expect(preheader.length).toBeGreaterThan(0);
    for (const s of preheader) expect(s.hangCapable).toBeUndefined();
  });
});
