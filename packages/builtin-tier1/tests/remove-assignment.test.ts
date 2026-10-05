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

  // Same-loop controls and the targets()/generate() agreement check: loop-exit-refusal.test.ts.
  it("REFUSES an in-loop assignment that advances the condition (R196), and claims the preheader one", () => {
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

    expect(specs.map((s) => s.before.text)).toEqual(["Remaining := 3"]);
    for (const s of specs) expect(s.hangCapable).toBeUndefined();
  });
});
