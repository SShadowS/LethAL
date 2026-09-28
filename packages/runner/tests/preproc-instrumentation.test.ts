import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ALSyntaxNode, initParser, parseAL, visit, wrapRoot } from "@lethal/engine";
import type { MutantManifest } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

// R297 and its successors: preprocessor shapes through the real operator set and the real writer.
// Every repro is hand-written (no corpus text).

const APP_JSON = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "repro",
  publisher: "repro",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 50100, to: 50149 }],
};

/** Instruments `files` (relative path to AL source) as one project; returns the manifest and each
 *  input file's emitted text, keyed by the same relative path. */
async function instrument(
  files: Record<string, string>,
  appJsonExtra?: Record<string, unknown>,
): Promise<{ manifest: MutantManifest; emitted: Map<string, string> }> {
  const src = await mkdtemp(join(tmpdir(), "lethal-preproc-src-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-preproc-out-"));
  try {
    await writeFile(join(src, "app.json"), JSON.stringify({ ...APP_JSON, ...appJsonExtra }));
    for (const [name, text] of Object.entries(files)) await writeFile(join(src, name), text);
    const set = await generateMutationSet(src);
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: APP_JSON.id,
      operatorTiers,
    });
    const manifest = JSON.parse(
      await readFile(join(out, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
    const emitted = new Map<string, string>();
    for (const name of Object.keys(files))
      emitted.set(name, await readFile(join(out, name), "utf8"));
    return { manifest, emitted };
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

const SELECTOR = 'MutationSelector: Codeunit "Mutation Selector";';
const MEMBER_KINDS = new Set([
  "procedure",
  "trigger_declaration",
  "preproc_split_procedure",
  "preproc_split_procedure_preamble",
]);
const ATTRIBUTE_KINDS = new Set(["attribute_item", "var_attribute_item"]);
const SKIPPED = new Set([
  "comment",
  "multiline_comment",
  "pragma",
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

function holdsMember(n: ALSyntaxNode): boolean {
  let found = false;
  visit(n, (d) => {
    if (MEMBER_KINDS.has(d.rawKind)) found = true;
  });
  return found;
}

/** The last named child that is not a comment, a pragma or a `#if` marker. */
function lastMeaningful(nodes: readonly ALSyntaxNode[]): ALSyntaxNode | undefined {
  return nodes.filter((c) => !SKIPPED.has(c.rawKind)).at(-1);
}

/**
 * The placement oracle (R297 ruling): re-parse the emission and require the ONE selector
 * declaration to sit in an object-level var section, outside any procedure, trigger or `#if`
 * block, and not directly after an attribute or after anything holding a member. Deliberately
 * written as a denylist, independently of the injector's allowlist, so the two cannot share a gap.
 */
function assertSelectorPlacement(emitted: string): void {
  expect(emitted.split(SELECTOR).length - 1).toBe(1);
  const root = wrapRoot(parseAL(emitted));
  const hits: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.rawKind === "variable_declaration" && n.text.startsWith("MutationSelector")) hits.push(n);
  });
  expect(hits).toHaveLength(1);
  const [decl] = hits;
  if (decl === undefined) throw new Error("unreachable");
  const ancestors: string[] = [];
  for (let p = decl.parent; p !== null; p = p.parent) ancestors.push(p.rawKind);
  expect(ancestors.slice(0, 3)).toEqual(["var_body", "var_section", "declaration_body"]);
  const siblings = decl.parent?.namedChildren ?? [];
  const before = lastMeaningful(
    siblings.slice(
      0,
      siblings.findIndex((s) => s === decl),
    ),
  );
  if (before === undefined) return;
  expect(ATTRIBUTE_KINDS.has(before.rawKind)).toBe(false);
  expect(holdsMember(before)).toBe(false);
  if (before.rawKind === "preproc_conditional_var") {
    const last = lastMeaningful(before.namedChildren);
    expect(last !== undefined && ATTRIBUTE_KINDS.has(last.rawKind)).toBe(false);
  }
}
/** Hand-written repros (R297 Task 0), keyed by the scratch repro directory name. */
const REPRO: Record<string, string> = {
  "a-swallow": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
#endif

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "a-only-swallow": `codeunit 50100 "Repro A"
{
    var
#if not CLEAN27
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        Message('%1', L);
    end;
#endif

    procedure B()
    var
        G: Integer;
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "a-mixed": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        H: Integer;

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        H := L;
        Message('%1', H);
    end;
#endif

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "a-attr": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    [Obsolete('x', '27.0')]
#endif
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "a-attr-proc": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    [Obsolete('x', '27.0')]
    procedure A(X: Integer)
    begin
    end;
#endif
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
}
`,
  "a-ordinary-plain": `codeunit 50100 "Repro A"
{
    var
        G: Integer;

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
}
`,
  "a-ordinary-ifdecl": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        H: Integer;
#endif

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
}
`,
  "a-ordinary-varattr": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        [NonDebuggable]
        S: Text;

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
}
`,
  "a-ordinary-pragma": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#pragma warning disable AL0432

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
}
`,
  "a-ordinary-pragma-mid": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#pragma warning disable AL0432
        H: Integer;

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        H := G;
        Message('%1', H);
    end;
}
`,
  "a-ordinary-comment": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        // a trailing comment

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
}
`,
  "a-ordinary-comment-mid": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        // a comment between declarations
        H: Integer;

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        H := G;
        Message('%1', H);
    end;
}
`,
};

/** HEAD's emission of each control, captured by Task 0 before the R297 change. */
const HEAD_EMIT: Record<string, string> = {
  "a-ordinary-plain": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        MutationSelector: Codeunit "Mutation Selector";

    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        Message('%1', L);
    end
end else begin
  begin
        L := 1;
        G := L;
        Message('%1', L);
    end
end
end;
}
`,
  "a-ordinary-ifdecl": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        H: Integer;
#endif
        MutationSelector: Codeunit "Mutation Selector";

    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        Message('%1', L);
    end
end else begin
  begin
        L := 1;
        G := L;
        Message('%1', L);
    end
end
end;
}
`,
  "a-ordinary-varattr": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        [NonDebuggable]
        S: Text;
        MutationSelector: Codeunit "Mutation Selector";

    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        Message('%1', L);
    end
end else begin
  begin
        L := 1;
        G := L;
        Message('%1', L);
    end
end
end;
}
`,
  "a-ordinary-pragma": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        MutationSelector: Codeunit "Mutation Selector";
#pragma warning disable AL0432

    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        Message('%1', L);
    end
end else begin
  begin
        L := 1;
        G := L;
        Message('%1', L);
    end
end
end;
}
`,
  "a-ordinary-pragma-mid": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#pragma warning disable AL0432
        H: Integer;
        MutationSelector: Codeunit "Mutation Selector";

    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0006') then begin
  begin
        L := 1;
        G := L;
        H := G;
        if not LethALReachLatch then begin MutationSelector.Reached('M0006'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        H := G;
        Message('%1', H);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        H := G;
        Message('%1', H);
    end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
        Message('%1', H);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        H := G;
        Message('%1', H);
    end
end else begin
  begin
        L := 1;
        G := L;
        H := G;
        Message('%1', H);
    end
end
end;
}
`,
  "a-ordinary-comment": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        MutationSelector: Codeunit "Mutation Selector";
        // a trailing comment

    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        Message('%1', L);
    end
end else begin
  begin
        L := 1;
        G := L;
        Message('%1', L);
    end
end
end;
}
`,
  "a-ordinary-comment-mid": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        // a comment between declarations
        H: Integer;
        MutationSelector: Codeunit "Mutation Selector";

    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0006') then begin
  begin
        L := 1;
        G := L;
        H := G;
        if not LethALReachLatch then begin MutationSelector.Reached('M0006'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        H := G;
        Message('%1', H);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        H := G;
        Message('%1', H);
    end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
        Message('%1', H);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        H := G;
        Message('%1', H);
    end
end else begin
  begin
        L := 1;
        G := L;
        H := G;
        Message('%1', H);
    end
end
end;
}
`,
};

/** HEAD's WRONG emission of the two silent shapes, for the placement oracle's own red check. */
const HEAD_WRONG: Record<string, string> = {
  "a-attr": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    [Obsolete('x', '27.0')]
#endif
        MutationSelector: Codeunit "Mutation Selector";
    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        Message('%1', L);
    end
end else begin
  begin
        L := 1;
        G := L;
        Message('%1', L);
    end
end
end;

    procedure B()
    var LethALReachLatch: Boolean; begin
if MutationSelector.Active('M0006') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0006'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0009') then begin
  begin
        G := 2;
        if not LethALReachLatch then begin MutationSelector.Reached('M0009'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0007') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0007'); LethALReachLatch := true; end; ;
        Message('%1', G);
    end
end else if MutationSelector.Active('M0008') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0008'); LethALReachLatch := true; end; G := 3;
        Message('%1', G);
    end
end else begin
  begin
        G := 2;
        Message('%1', G);
    end
end
end;
}
`,
  "a-attr-proc": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    [Obsolete('x', '27.0')]
    procedure A(X: Integer)
    begin
    end;
#endif
        MutationSelector: Codeunit "Mutation Selector";
    procedure A()
    var
        L: Integer; LethALReachLatch: Boolean;
    begin
if MutationSelector.Active('M0001') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0001'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
        L := 1;
        G := L;
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; ;
    end
end else if MutationSelector.Active('M0002') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0002'); LethALReachLatch := true; end; ;
        G := L;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0004') then begin
  begin
        L := 1;
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        Message('%1', L);
    end
end else if MutationSelector.Active('M0003') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; L := 2;
        G := L;
        Message('%1', L);
    end
end else begin
  begin
        L := 1;
        G := L;
        Message('%1', L);
    end
end
end;
}
`,
};
describe("R297: the selector var through the real pipeline", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("a-swallow: instruments, with a mutant in the swallowed procedure A and one selector", async () => {
    const { manifest, emitted } = await instrument({
      "Repro.Codeunit.al": REPRO["a-swallow"] ?? "",
    });
    expect(manifest.mutants.some((m) => m.procedureName === "A")).toBe(true);
    expect((emitted.get("Repro.Codeunit.al") ?? "").split(SELECTOR).length - 1).toBe(1);
  });

  for (const name of Object.keys(HEAD_EMIT)) {
    test(`${name}: the emission is byte-identical to HEAD's (Review Focus 4)`, async () => {
      const { emitted } = await instrument({ "Repro.Codeunit.al": REPRO[name] ?? "" });
      expect(emitted.get("Repro.Codeunit.al")).toBe(HEAD_EMIT[name] ?? "");
    });
  }

  for (const name of Object.keys(REPRO)) {
    test(`${name}: the selector sits in the object's var section, after no attribute and no member`, async () => {
      const { emitted } = await instrument({ "Repro.Codeunit.al": REPRO[name] ?? "" });
      assertSelectorPlacement(emitted.get("Repro.Codeunit.al") ?? "");
    });
  }

  for (const name of Object.keys(HEAD_WRONG)) {
    test(`the placement oracle rejects HEAD's wrong emission of ${name}`, () => {
      expect(() => assertSelectorPlacement(HEAD_WRONG[name] ?? "")).toThrow();
    });
  }
});
