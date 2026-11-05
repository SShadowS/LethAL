import { beforeAll, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  evaluateArms,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { voidMethodCall } from "../src/void-method-call";

// SCRATCH (R-818): does the call-removal operator get any hang check? (shape h)
beforeAll(async () => {
  await initParser();
});

it("probe2", () => {
  const body = `Pos := 1;
     while Pos > 0 do begin
       Chop(Text, Pos);
       Pos := Text.IndexOf('x');
     end;
     while Pos < 10 do
       Inc(Pos);`;
  const src = `codeunit 50000 P\n{\n    procedure Go2()\n    var\n        Text: Text; Pos: Integer;\n    begin\n${body}\n    end;\n    local procedure Chop(var T: Text; P: Integer) begin T := T.Substring(P + 2); end;\n}`;
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "f.al", root }], new Map([[root, evaluateArms(root, src, [])]]));
  visit(root, (n: ALSyntaxNode) => {
    if (voidMethodCall.targets(n, ctx)) console.log(`void-method-call CLAIMS: ${n.text.slice(0, 40)}`);
  });
});
