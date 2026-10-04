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

  // Same-loop controls and the targets()/generate() agreement check: loop-exit-refusal.test.ts.
  it("REFUSES an in-loop additive expression that advances the condition (R196), and claims the preheader one", () => {
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

    expect(specs.map((s) => s.before.text)).toEqual(["Remaining + 1"]);
    for (const s of specs) expect(s.hangCapable).toBeUndefined();
  });
});
