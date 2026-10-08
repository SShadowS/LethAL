import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R343: an object wrapped whole in `#if` is indexed like a root object when the BUILD compiles it
 * (its arm decided active under the build's symbols), and stays unindexed otherwise, as R331 and
 * R-364 rely on. Each rule here is one direction of that, red-checked.
 */
import { evaluateArms } from "../../src/ast/preproc-arms";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";

/** One file; with an arm map under `symbols`, as `generateMutationSet` builds it, or none. */
function symbolsOf(src: string, symbols?: readonly string[]) {
  const root = wrapRoot(parseAL(src));
  const arms =
    symbols === undefined ? undefined : new Map([[root, evaluateArms(root, src, symbols)]]);
  return buildSemanticContext([{ path: "t.al", root }], arms).symbols;
}
const names = (s: ReturnType<typeof symbolsOf>) => s.objects.map((o) => o.name).sort();
const unindexedNames = (s: ReturnType<typeof symbolsOf>) =>
  s.unindexedObjects
    .filter((o) => o.rawKind.endsWith("_declaration") && o.rawKind !== "namespace_declaration")
    .map((o) => /"([^"]+)"/.exec(o.text)?.[1] ?? "?")
    .sort();

const W = 'codeunit 50100 "W" { procedure P() begin end; }';

describe("R343: which wrapped objects the symbol table indexes", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Revert: push every wrapped object to `unindexedObjects` again.
  it("an object in an arm the build compiles is indexed, and not left unindexed", () => {
    const s = symbolsOf(`#if not CLEANX\n${W}\n#endif\n`, []);
    expect(names(s)).toEqual(["W"]);
    expect(unindexedNames(s)).toEqual([]);
  });

  // Revert: drop the `armOf !== undefined` condition. With no arm map every arm looks live.
  it("with no arm map it stays unindexed", () => {
    const s = symbolsOf(`#if not CLEANX\n${W}\n#endif\n`);
    expect(names(s)).toEqual([]);
    expect(unindexedNames(s)).toEqual(["W"]);
  });

  // Revert: index regardless of the arm.
  it("an object in an arm the build compiles OUT is not indexed", () => {
    const s = symbolsOf(`#if CLEANX\n${W}\n#endif\n`, []);
    expect(names(s)).toEqual([]);
  });

  it("an object in an undecided file stays unindexed", () => {
    const s = symbolsOf(`#if (CLEANX\n${W}\n#endif\n`, []);
    expect(names(s)).toEqual([]);
  });

  // Revert: drop `isCleanObjectDeclaration`. R-364's by-name fallback covers this object.
  it("an object with a parse error inside stays unindexed", () => {
    const s = symbolsOf(`#if not CLEANX\n${W.replace("{", "{ Bogus")}\n#endif\n`, []);
    expect(names(s)).toEqual([]);
    expect(unindexedNames(s)).toEqual(["W"]);
  });

  it("nested: an outer arm compiled out covers the inner one; both live is indexed", () => {
    const nested = (outer: string) => `#if ${outer}\n#if not CLEANY\n${W}\n#endif\n#endif\n`;
    expect(names(symbolsOf(nested("CLEANX"), []))).toEqual([]);
    expect(names(symbolsOf(nested("not CLEANX"), []))).toEqual(["W"]);
  });

  it("two objects in one live arm are both indexed", () => {
    const s = symbolsOf(
      `#if not CLEANX\n${W}\ncodeunit 50101 "V" { procedure Q() begin end; }\n#endif\n`,
      [],
    );
    expect(names(s)).toEqual(["V", "W"]);
  });

  it("a same-name #if/#else pair yields exactly one object, the compiled arm's", () => {
    const pair = `#if CLEANX\ncodeunit 50100 "W" { procedure Old() begin end; }\n#else\ncodeunit 50100 "W" { procedure New() begin end; }\n#endif\n`;
    const s = symbolsOf(pair, []);
    expect(names(s)).toEqual(["W"]);
    expect(s.uniqueProcedure("codeunit:W", "New")).not.toBeNull();
    expect(s.uniqueProcedure("codeunit:W", "Old")).toBeNull();
  });

  // Opus plan review M1. Revert: give a wrapped object the file's (root) namespace only.
  it("a namespace declared inside the live arm is the wrapped object's namespace", () => {
    const s = symbolsOf(`#if not CLEANX\nnamespace Contoso.Sales;\n\n${W}\n#endif\n`, []);
    expect(s.objects.map((o) => o.namespace)).toEqual(["Contoso.Sales"]);
  });
});
