import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R549 (coord task R-547): a bare `Commit()` in a pageextension binds a VISIBLE procedure of the
 * BASE page (alc 18.0.43, measured in the R-547 plan). `claimsSystemCall` refuses when any project
 * base-page candidate declares one, and keeps the claim otherwise. Each test names the revert that
 * turns it red; the red checks are recorded in the R-547 build log.
 */
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { evaluateArms } from "../../src/ast/preproc-arms";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { claimsSystemCall } from "../../src/semantic/receiver";

beforeAll(async () => {
  await initParser();
});

const EXT = `pageextension 50601 "Base Ext" extends "Base Page"
{
    trigger OnOpenPage()
    begin
        Commit();
    end;
}`;

const page = (members: string, id = 50600) => `page ${id} "Base Page"
{
${members}
}`;

/** `claimsSystemCall(.., "Commit")` at every call in the extension. `symbols`: evaluate every
 *  file's arms under those preprocessor symbols; "undecided": every node answers undecided. */
function claims(bases: string[], symbols?: string[] | "undecided"): boolean[] {
  const srcs = [...bases, EXT];
  const parsed = srcs.map((src, i) => ({ path: `f${i}.al`, root: wrapRoot(parseAL(src)) }));
  const built = buildSemanticContext(
    parsed,
    Array.isArray(symbols)
      ? new Map(parsed.map((p, i) => [p.root, evaluateArms(p.root, srcs[i] ?? "", symbols)]))
      : undefined,
  );
  const ctx = symbols === "undecided" ? { ...built, armOf: () => "undecided" as const } : built;
  const out: boolean[] = [];
  visit(parsed[parsed.length - 1]?.root as ALSyntaxNode, (n: ALSyntaxNode) => {
    if (n.kind === ALNodeKind.procedure_call) out.push(claimsSystemCall(n, ctx, "Commit"));
  });
  return out;
}

const PUBLIC = "    procedure Commit(): Integer\n    begin\n    end;";
const OTHER = "    procedure Other()\n    begin\n    end;";

describe("R549: claimsSystemCall inside a pageextension", () => {
  // Red: drop the R549 guard in `claimsSystemCall`.
  it("refuse: the project base page declares a public Commit", () => {
    expect(claims([page(PUBLIC)])).toEqual([false]);
  });
  // Red: make `basePageDeclaresVisible` answer true for every pageextension.
  it("keep: the base page declares no Commit", () => {
    expect(claims([page(OTHER)])).toEqual([true]);
  });
  // Red: treat a `local` procedure as visible.
  it("keep: the base page's Commit is local (invisible)", () => {
    expect(claims([page(`    local ${PUBLIC.trim()}`)])).toEqual([true]);
  });
  // Red: refuse when there is no candidate.
  it("keep: the base page is not in the project (the named residual)", () => {
    expect(claims([])).toEqual([true]);
  });
  // Red: treat `internal` as invisible.
  it("refuse: an internal Commit is visible (same app)", () => {
    expect(claims([page(`    internal ${PUBLIC.trim()}`)])).toEqual([false]);
  });
  // Red: consult the candidates only when there is exactly one.
  it("refuse: two same-named base pages, one declaring Commit", () => {
    expect(claims([page(OTHER), page(PUBLIC, 50602)])).toEqual([false]);
  });
  // Red: drop `unindexedObjects` from the candidates.
  it("refuse: a base page wrapped in an undecided `#if` arm declaring Commit", () => {
    expect(claims([`#if V2\n${page(PUBLIC)}\n#endif\n`], "undecided")).toEqual([false]);
  });
  // Red: drop `splitObjects` from the token fallback.
  it("refuse: a split-header base page declaring Commit", () => {
    const split = `#if CLEAN\npage 50600 "Base Page"\n#else\npage 50603 "Base Page"\n#endif\n{\n${PUBLIC}\n}`;
    expect(claims([split])).toEqual([false]);
  });
  // A split procedure is visible if any arm the build keeps is non-local.
  // Red (first): ignore each arm's activity. Red (second): require every arm to be non-local.
  const SPLIT_PROC =
    "#if CLEAN\n    local procedure Commit(): Integer\n#else\n    procedure Commit(): Integer\n#endif\n    begin\n    end;";
  it("keep: a split Commit whose only live arm is local", () => {
    expect(claims([page(SPLIT_PROC)], ["CLEAN"])).toEqual([true]);
  });
  it("refuse: a split Commit whose live arm is non-local", () => {
    expect(claims([page(SPLIT_PROC)], [])).toEqual([false]);
  });
});
