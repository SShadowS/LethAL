import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";

describe("flipBooleanLiteral", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("tags an in-loop boolean guard that advances the condition (R196), and does NOT tag the preheader one", () => {
    const src = `codeunit 50000 P
{
    procedure Go()
    var
        Continue: Boolean;
        Started: Boolean;
    begin
        Started := true;
        Continue := true;
        while Continue do
            Continue := false;
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const specs = findAll(root, ALNodeKind.boolean_literal)
      .filter((n) => flipBooleanLiteral.targets(n, ctx))
      .flatMap((n) => flipBooleanLiteral.generate(n, ctx));

    const inLoop = specs.filter((s) => s.before.text === "false");
    expect(inLoop.length).toBeGreaterThan(0);
    for (const s of inLoop) expect(s.hangCapable).toBe("loop-condition-target");

    const preheader = specs.filter((s) => s.before.text === "true" && s.after.text === "false");
    expect(preheader.length).toBeGreaterThan(0);
    for (const s of preheader) expect(s.hangCapable).toBeUndefined();
  });
});
