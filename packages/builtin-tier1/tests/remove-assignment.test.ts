import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { removeAssignment } from "../src/remove-assignment";

describe("removeAssignment", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("tags an in-loop assignment that advances the condition (R196), and does NOT tag the preheader one", () => {
    const src = `codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 3;
        while Remaining > 0 do
            Remaining := Remaining - 1;
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    const specs = findAll(root, ALNodeKind.assignment_statement)
      .filter((n) => removeAssignment.targets(n, ctx))
      .flatMap((n) => removeAssignment.generate(n, ctx));

    const inLoop = specs.filter((s) => s.before.text === "Remaining := Remaining - 1");
    expect(inLoop.length).toBeGreaterThan(0);
    for (const s of inLoop) expect(s.hangCapable).toBe("loop-condition-target");

    const preheader = specs.filter((s) => s.before.text === "Remaining := 3");
    expect(preheader.length).toBeGreaterThan(0);
    for (const s of preheader) expect(s.hangCapable).toBeUndefined();
  });
});
