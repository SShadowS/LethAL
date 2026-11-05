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
import { removeAssignment } from "../src/remove-assignment";

// SCRATCH probe (R-818). Each shape marks assignments `// H` (removing it makes the loop endless),
// `// S` (loop still ends / unrelated). Prints claimed (mutant kept) or refused per assignment.
beforeAll(async () => {
  await initParser();
});

const SHAPES: Array<[string, string, string]> = [
  [
    "a-issue",
    "Text: Text; Pos: Integer; Result: Text;",
    `Pos := Text.IndexOf('{{');
     while Pos > 0 do begin
       Result += Text.Substring(1, Pos - 1); // S
       Text := Text.Substring(Pos + 2); // H
       Pos := Text.IndexOf('{{'); // H(step)
     end;`,
  ],
  [
    "b-two-hops",
    "A: Integer; B: Integer; Pos: Integer; Z: Integer;",
    `Pos := 5;
     while Pos > 0 do begin
       B := B - 1; // H
       A := B + 1; // H
       Pos := A; // H(step)
       Z := Z + 1; // S
     end;`,
  ],
  [
    "c-record-field",
    "Rec: Record Customer; Pos: Integer;",
    `Pos := 5;
     while Pos > 0 do begin
       Rec.Amount := Rec.Amount - 1; // H
       Pos := Rec.Amount; // H(step)
     end;`,
  ],
  [
    "d-write-after-step",
    "Text: Text; Pos: Integer;",
    `Pos := Text.IndexOf('{{');
     while Pos > 0 do begin
       Pos := Text.IndexOf('{{'); // H(step)
       Text := Text.Substring(Pos + 2); // H
     end;`,
  ],
  [
    "e-nested-if",
    "Text: Text; Pos: Integer; Flag: Boolean;",
    `Pos := Text.IndexOf('{{');
     while Pos > 0 do begin
       if Flag then begin
         Text := Text.Substring(Pos + 2); // H
       end;
       Pos := Text.IndexOf('{{'); // H(step)
     end;`,
  ],
  [
    "f-repeat",
    "Text: Text; Pos: Integer;",
    `repeat
       Text := Text.Substring(Pos + 2); // H
       Pos := Text.IndexOf('{{'); // H(step)
     until Pos = 0;`,
  ],
  [
    "f-for-step-var",
    "N: Integer; K: Integer; Q: Integer;",
    `for N := 1 to K do begin
       K := Q + 1; // ?
       Q := Q + 1; // S
     end;`,
  ],
  [
    "g-break-guard",
    "Text: Text; Pos: Integer;",
    `while true do begin
       Pos := Text.IndexOf('{{'); // H(step)
       if Pos = 0 then break;
       Text := Text.Substring(Pos + 2); // H
     end;`,
  ],
  [
    "g-break-guard-namecond",
    "Text: Text; Pos: Integer; Go: Boolean;",
    `while Go do begin
       Pos := Text.IndexOf('{{'); // H(step)
       if Pos = 0 then break;
       Text := Text.Substring(Pos + 2); // H
     end;`,
  ],
  [
    "h-byvar",
    "Text: Text; Pos: Integer;",
    `Pos := Text.IndexOf('{{');
     while Pos > 0 do begin
       Chop(Text, Pos); // H
       Pos := Text.IndexOf('{{'); // H(step)
     end;`,
  ],
  [
    "i-reset-elsewhere",
    "Text: Text; Pos: Integer;",
    `Pos := Text.IndexOf('{{');
     while Pos > 0 do begin
       Text := Text.Substring(Pos + 2); // S(reset below)
       Pos := Text.IndexOf('{{'); // H(step)
       Text := ''; // S
     end;`,
  ],
  [
    "j-second-exit",
    "Text: Text; Pos: Integer; N: Integer;",
    `Pos := Text.IndexOf('{{');
     while Pos > 0 do begin
       N += 1; // S
       if N > 10 then exit;
       Text := Text.Substring(Pos + 2); // S(second exit)
       Pos := Text.IndexOf('{{'); // H(step)
     end;`,
  ],
  [
    "k-unrelated",
    "Text: Text; Pos: Integer; Out: Text;",
    `Pos := Text.IndexOf('{{');
     while Pos > 0 do begin
       Out := Out + 'x'; // S
       Out := Text; // S
       Pos := Text.IndexOf('{{'); // H(step)
     end;`,
  ],
  [
    "l-param-var-direct",
    "Text: Text; Pos: Integer;",
    `Pos := 1;
     while Pos <= StrLen(Text) do begin
       Pos := NextPos(Text, Pos); // H(step)
     end;`,
  ],
];

it("probe", () => {
  for (const [name, vars, body] of SHAPES) {
    const src = `codeunit 50000 P\n{\n    procedure Go2()\n    var\n        ${vars}\n    begin\n${body}\n    end;\n    local procedure Chop(var T: Text; P: Integer) begin T := T.Substring(P + 2); end;\n    local procedure NextPos(T: Text; P: Integer): Integer begin exit(P + 1); end;\n}`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "f.al", root }], new Map([[root, evaluateArms(root, src, [])]]));
    const rows: string[] = [];
    visit(root, (n: ALSyntaxNode) => {
      if (n.rawKind !== "assignment_statement" && n.kind !== "assignment_statement") return;
      const claimed = removeAssignment.targets(n, ctx);
      const line = src.split("\n")[n.startPosition.row] ?? "";
      const tag = /\/\/\s*(.*)$/.exec(line)?.[1] ?? "-";
      rows.push(`${claimed ? "CLAIMED" : "refused"} [${tag}] ${n.text.slice(0, 40).replace(/\n/g, " ")}`);
    });
    console.log(`## ${name}\n${rows.join("\n")}`);
  }
});
