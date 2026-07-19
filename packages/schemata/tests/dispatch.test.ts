import { describe, expect, it } from "bun:test";
import { emitDispatch } from "../src/dispatch";

/** Minimal stand-ins — emitDispatch only reads ranges and text. */
function node(text: string, startIndex: number) {
  return { text, startIndex, endIndex: startIndex + text.length } as never;
}

function member(mutantId: string, beforeText: string, beforeStart: number, afterText: string) {
  return {
    mutantId,
    spec: { before: node(beforeText, beforeStart), operatorName: "op" },
    statement: node(beforeText, beforeStart),
    afterText,
  } as never;
}

describe("emitDispatch", () => {
  it("emits one branch per mutant plus an original branch", () => {
    const root = node("exit(A > B);", 100);
    const out = emitDispatch({
      root,
      members: [
        member("M0002", "exit(A > B);", 100, "exit(false);"),
        member("M0001", "A > B", 105, "A >= B"),
      ],
    } as never);

    // One guard per mutant, in order, and the original last.
    expect(out).toContain("if MutationSelector.Active('M0002') then begin");
    expect(out).toContain("end else if MutationSelector.Active('M0001') then begin");
    expect(out).toContain("exit(false);"); // outer variant
    expect(out).toContain("exit(A >= B);"); // inner variant spliced into the ROOT
    expect(out).toContain("exit(A > B);"); // original branch
    expect(out.trimEnd().endsWith("end;")).toBe(true);
    // Linear, not nested: exactly one `if` per mutant, no nested guard inside a branch.
    expect(out.match(/MutationSelector\.Active/g)).toHaveLength(2);
  });

  it("a deletion mutant's branch omits the deleted span", () => {
    const root = node("LogAudit(Amount);", 50);
    const out = emitDispatch({
      root,
      members: [member("M0001", "LogAudit(Amount)", 50, "")],
    } as never);
    expect(out).toContain("if MutationSelector.Active('M0001') then begin");
    expect(out).toContain("LogAudit(Amount);"); // original branch still present
    // The mutated branch contains only the residual separator, not the call.
    const mutatedBranch = out.slice(0, out.indexOf("end else"));
    expect(mutatedBranch).not.toContain("LogAudit(Amount)");
  });

  it("a single-mutant component still emits a two-branch chain", () => {
    const root = node("exit(V);", 10);
    const out = emitDispatch({
      root,
      members: [member("M0001", "exit(V);", 10, "exit(0);")],
    } as never);
    expect(out.match(/MutationSelector\.Active/g)).toHaveLength(1);
    expect(out).toContain("exit(0);");
    expect(out).toContain("exit(V);");
  });
});
