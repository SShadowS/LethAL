import { describe, it, expect, beforeAll } from "bun:test";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { duplicateEnclosing } from "../src/duplicate";

describe("duplicateEnclosing", () => {
  beforeAll(async () => { await initParser(); });

  it("wraps the enclosing statement twice with mutated / original bodies", () => {
    const src = `codeunit 51020 "D" { procedure P(A: Boolean; B: Boolean) begin if A and B then DoThing(); end; }`;
    const root = wrapRoot(parseAL(src));
    const ifStmt = findFirst(root, ALNodeKind.if_statement);
    if (ifStmt === null) throw new Error("no if_statement");
    const out = duplicateEnclosing({
      mutantId: "M0001",
      enclosingStatement: ifStmt,
      mutatedStatement: ifStmt.text.replace(" and ", " or "),
    });
    expect(out).toContain("if MutationSelector.Active('M0001') then begin");
    expect(out).toContain("end else begin");
    expect(out).toContain("or B then DoThing()");
    expect(out).toContain("and B then DoThing()");
  });
});
