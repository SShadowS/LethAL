import { describe, expect, it } from "bun:test";
import { emitDispatch } from "../src/dispatch";

/**
 * Minimal stand-ins. `parent` is explicit and `null` rather than absent: R161's `emptiedSlotFiller`
 * asks whether the deleted node sits in a single-statement slot, which reads `parent`, and
 * `ALSyntaxNode` declares it required. A stub that omitted it threw rather than answering, and a
 * stub that does not satisfy the interface is the test double's bug, not the caller's.
 */
function node(text: string, startIndex: number) {
  return {
    text,
    startIndex,
    endIndex: startIndex + text.length,
    parent: null,
    fieldName: null,
  } as never;
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

describe("emitDispatch — member splice reproduces the consumed terminator (C1)", () => {
  // The discriminator is what the consumed span's TEXT actually ends with,
  // never the node's kind — inferring from kind regressed emission in both
  // directions once already (Task 3). These two tests pin both directions
  // with exact strings.

  it("re-appends a consumed trailing ';' so a sibling statement stays separated", () => {
    // Inner if-branch block followed by a sibling statement: the grammar
    // includes the trailing ';' in the block node (verified against the real
    // parser), so the consumed span ends in ';' and `begin end` does not.
    const rootText =
      "begin\n    if A <> 0 then begin\n        A := A;\n    end;\n    A := 2;\nend;";
    const innerText = "begin\n        A := A;\n    end;";
    const rootStart = 100;
    const innerStart = rootStart + rootText.indexOf(innerText);
    const out = emitDispatch({
      root: node(rootText, rootStart),
      members: [member("M0001", innerText, innerStart, "begin end")],
    } as never);
    const mutatedBranch = out.slice(0, out.indexOf("end else begin"));
    // Exact string: the splice must reproduce the ';' the consumed span had,
    // or the branch reads `... begin end\n    A := 2;` — invalid AL.
    expect(mutatedBranch).toContain("if A <> 0 then begin end;\n    A := 2;");
    expect(mutatedBranch).not.toContain("begin end\n    A := 2;");
  });

  it("does not add a ';' when the consumed span had none (an else follows)", () => {
    // Inner if-branch block directly followed by `else`: the grammar gives
    // the block node NO trailing ';' (verified against the real parser), and
    // inserting one would orphan the else inside this branch (AL0110).
    const rootText =
      "begin\n    if X then begin\n        Y := 1;\n    end\n    else\n        Y := 2;\nend;";
    const innerText = "begin\n        Y := 1;\n    end";
    const rootStart = 200;
    const innerStart = rootStart + rootText.indexOf(innerText);
    const out = emitDispatch({
      root: node(rootText, rootStart),
      members: [member("M0001", innerText, innerStart, "begin end")],
    } as never);
    const mutatedBranch = out.slice(0, out.indexOf("end else begin"));
    expect(mutatedBranch).toContain("if X then begin end\n    else\n        Y := 2;");
    expect(mutatedBranch).not.toContain("begin end;");
  });

  it("does not double a ';' when the replacement text already ends in one", () => {
    // Statement-for-statement replacement: consumed span AND afterText both
    // end in ';' — the splice must not stack a second one.
    const rootText = "begin\n    exit(A > B);\nend;";
    const innerText = "exit(A > B);";
    const rootStart = 300;
    const innerStart = rootStart + rootText.indexOf(innerText);
    const out = emitDispatch({
      root: node(rootText, rootStart),
      members: [member("M0001", innerText, innerStart, "exit(false);")],
    } as never);
    const mutatedBranch = out.slice(0, out.indexOf("end else begin"));
    expect(mutatedBranch).toContain("exit(false);");
    expect(mutatedBranch).not.toContain("exit(false);;");
  });
});
