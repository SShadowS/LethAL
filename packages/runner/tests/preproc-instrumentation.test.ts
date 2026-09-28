import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ALSyntaxNode, initParser, parseAL, visit, wrapRoot } from "@lethal/engine";
import type { MutantManifest } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

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
  // By position, never by identity: `wrapRoot` wrappers are not the same objects across walks.
  const before = lastMeaningful(siblings.filter((s) => s.endIndex <= decl.startIndex));
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
  "a-bare-split": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if CLEAN27
    procedure A(X: Integer)
#else
    procedure A(X: Integer; Y: Integer)
#endif
    var
        L: Integer;
    begin
        L := X;
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
  // The reviewer's hunt shapes (Task 2 fix round 1), pinned through the placement oracle.
  "h-comment-before": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        // trailing comment
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
  "h-elif": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if CLEAN27
        H: Integer;
#elif CLEAN26
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
  "h-else-decl-then-proc": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if CLEAN27
        H: Integer;
#else
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
  "h-else-only": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if CLEAN27
#else
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
  "h-empty-var": `codeunit 50100 "Repro A"
{
    var
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
  "h-if-decl-plus-attr": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        H: Integer;
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
  "h-if-decl-plus-attr-else": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        [Obsolete('x', '27.0')]
#else
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

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "h-if-decl-then-bare-proc": `codeunit 50100 "Repro A"
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

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "h-if-proc-then-decl": `codeunit 50100 "Repro A"
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
        H: Integer;

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "h-if-varattr-var": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        [InDataSet]
        H: Boolean;
#endif
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
  "h-multiline-before": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        /* block */
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
  "h-nested": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
#if not CLEAN26
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
#endif
#endif

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "h-pragma-before": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#pragma warning disable AL0432
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
#pragma warning restore AL0432

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "h-region": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#region stuff
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
#endregion

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`,
  "h-varattr-dangling": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        [InDataSet]
#if not CLEAN27
        H: Boolean;
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
  "h-varattr-in-if-then-proc": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        [NonDebuggable]
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
  "h-varattr-then-if": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
        [NonDebuggable]
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
/** Hand-written WRONG mid-section emissions: the selector after an attribute in a `#if`, and after
 *  a `#if` procedure, each followed by another declaration. The oracle must reject both. */
const WRONG_MID: Record<string, string> = {
  "wrong-mid": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        [Obsolete('x', '27.0')]
#endif
        MutationSelector: Codeunit "Mutation Selector";
        H: Integer;

    procedure B()
    begin
        G := 2;
    end;
}
`,
  "wrong-mid2": `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    procedure A()
    begin
    end;
#endif
        MutationSelector: Codeunit "Mutation Selector";
        H: Integer;
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

  for (const name of Object.keys(WRONG_MID)) {
    test(`the placement oracle rejects the mid-section wrong emission ${name}`, () => {
      expect(() => assertSelectorPlacement(WRONG_MID[name] ?? "")).toThrow();
    });
  }

  for (const name of Object.keys(HEAD_WRONG)) {
    test(`the placement oracle rejects HEAD's wrong emission of ${name}`, () => {
      expect(() => assertSelectorPlacement(HEAD_WRONG[name] ?? "")).toThrow();
    });
  }
});

/** R298 repros (R297 Task 0's `b-*` directories), hand-written. */
const B_BODY = (name: string): string => `{
    procedure ${name}()
    var
        L: Integer;
    begin
        L := 1;
        Message('%1', L);
    end;
}
`;
const B_REPRO = {
  "b-single": `#if not CLEAN27\ncodeunit 50101 "Repro B"\n${B_BODY("P")}#endif\n`,
  "b-two-arm": `#if CLEAN27\ncodeunit 50103 "Repro B2"\n${B_BODY("AIf")}#else\ncodeunit 50103 "Repro B2"\n${B_BODY("AElse")}#endif\n`,
  "b-mixed-file": `codeunit 50104 Plain\n${B_BODY("P")}#if not CLEAN27\ncodeunit 50105 Wrapped\n${B_BODY("W")}#endif\ncodeunit 50106 After\n${B_BODY("Q")}`,
};

describe("R298: #if-wrapped objects through the real pipeline", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("b-single: entries carry objectType codeunit and objectId 50101", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": B_REPRO["b-single"] });
    expect(manifest.mutants.length).toBeGreaterThan(0);
    for (const m of manifest.mutants) {
      expect(m.objectType).toBe("codeunit");
      expect(m.codeunitId).toBe(50101);
      expect(m.procedureName).toBe("P");
    }
  });

  test("b-two-arm: each arm's entries name that arm's procedure, never the other's", async () => {
    const src = B_REPRO["b-two-arm"];
    const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": src });
    const elseLine = src.split("\n").findIndex((l) => l.startsWith("#else")) + 1;
    expect(elseLine).toBeGreaterThan(1);
    const before = manifest.mutants.filter((m) => m.startLine < elseLine);
    const after = manifest.mutants.filter((m) => m.startLine > elseLine);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(before.length + after.length).toBe(manifest.mutants.length);
    for (const m of manifest.mutants) {
      expect(m.objectType).toBe("codeunit");
      expect(m.codeunitId).toBe(50103);
    }
    for (const m of before) {
      expect(m.procedureName).toBe("AIf");
      expect(m.procedureName).not.toBe("AElse");
    }
    for (const m of after) {
      expect(m.procedureName).toBe("AElse");
      expect(m.procedureName).not.toBe("AIf");
    }
    const keys = manifest.mutants.map((m) => serializeKey(identityKeyOf(m)));
    expect(new Set(keys).size).toBe(keys.length);
    expect((emitted.get("Repro.Codeunit.al") ?? "").split(SELECTOR).length - 1).toBe(2);
  });

  test("b-mixed-file: entries carry objectId 50104, 50105 and 50106 by position", async () => {
    const src = B_REPRO["b-mixed-file"];
    const { manifest } = await instrument({ "Repro.Codeunit.al": src });
    const lines = src.split("\n");
    const lineOf = (needle: string): number => lines.findIndex((l) => l.startsWith(needle)) + 1;
    const wrapped = lineOf("codeunit 50105");
    const after = lineOf("codeunit 50106");
    const expected = (line: number): number =>
      line >= after ? 50106 : line >= wrapped ? 50105 : 50104;
    const byName: Record<number, string> = { 50104: "P", 50105: "W", 50106: "Q" };
    expect(new Set(manifest.mutants.map((m) => m.codeunitId))).toEqual(
      new Set([50104, 50105, 50106]),
    );
    for (const m of manifest.mutants) {
      expect(m.codeunitId).toBe(expected(m.startLine));
      expect(m.procedureName).toBe(byName[m.codeunitId] ?? "");
    }
  });
});
/** R301 (class C) repros, hand-written (R-297 Task 0's `c-split*`): a procedure whose HEADER is
 *  split by `#if`, sharing one var section and one body. Lines: First 3..9, `#if` 11, body 18..21. */
const C_SPLIT_OF = (ifArm: string, elseArm: string): string => `codeunit 50100 "Repro C"
{
    procedure First()
    var
        L: Integer;
    begin
        L := 1;
        Message('%1', L);
    end;

#if CLEAN27
    ${ifArm}
#else
    ${elseArm}
#endif
    var
        L: Integer;
    begin
        L := X;
        Message('%1', L);
    end;
}
`;
const C_SPLIT = C_SPLIT_OF("procedure A(X: Integer)", "internal procedure A(X: Integer)");
const C_SPLIT_LOCAL = C_SPLIT_OF("local procedure A(X: Integer)", "local procedure A(X: Integer)");
const C_SPLIT_MIXED = C_SPLIT_OF("local procedure A(X: Integer)", "procedure A(X: Integer)");
/** The rename case R301 leaves open: which arm is live depends on symbols the writer does not see. */
const C_SPLIT_RENAMED = C_SPLIT_OF("procedure AIf(X: Integer)", "procedure AElse(X: Integer)");

describe("R301: split-header procedures get their manifest fields", () => {
  beforeAll(async () => {
    await initParser();
  });

  const inSplit = (m: { startLine: number }): boolean => m.startLine >= 18 && m.startLine <= 21;

  test("c-split: every entry in the split body names A, and First's name First", async () => {
    const { manifest } = await instrument({ "Split.Codeunit.al": C_SPLIT });
    const split = manifest.mutants.filter(inSplit);
    expect(split.length).toBeGreaterThan(0);
    for (const m of manifest.mutants) expect(m.procedureName).toBe(inSplit(m) ? "A" : "First");
  });

  test("c-split: the member span of a split-body entry is the split procedure's lines", async () => {
    const { manifest } = await instrument({ "Split.Codeunit.al": C_SPLIT });
    for (const m of manifest.mutants) {
      expect([m.procedureStartLine, m.procedureEndLine]).toEqual(inSplit(m) ? [11, 21] : [3, 9]);
    }
  });

  test("scope: public for c-split, local for c-split-local, public when arms disagree", async () => {
    const cases: [string, "local" | "public"][] = [
      [C_SPLIT, "public"],
      [C_SPLIT_LOCAL, "local"],
      [C_SPLIT_MIXED, "public"],
    ];
    for (const [src, scope] of cases) {
      const { manifest } = await instrument({ "Split.Codeunit.al": src });
      const split = manifest.mutants.filter(inSplit);
      expect(split.length).toBeGreaterThan(0);
      for (const m of split) expect(m.procedureScope).toBe(scope);
    }
  });

  test("c-split: the split body is the gap block, shared by its statements", async () => {
    const { manifest } = await instrument({ "Split.Codeunit.al": C_SPLIT });
    const split = manifest.mutants.filter(inSplit);
    for (const m of split) expect([m.blockStartLine, m.blockEndLine]).toEqual([18, 21]);
    expect(new Set(split.filter((m) => m.startLine === 19).map((m) => m.gapId)).size).toBe(1);
    const lines = new Set(split.map((m) => m.startLine));
    expect(lines.has(19) && lines.has(20)).toBe(true);
    expect(new Set(split.map((m) => m.gapId)).size).toBe(1);
  });

  test("a renamed arm names neither arm: the writer cannot tell which one is compiled", async () => {
    const { manifest } = await instrument({ "Split.Codeunit.al": C_SPLIT_RENAMED });
    const split = manifest.mutants.filter(inSplit);
    expect(split.length).toBeGreaterThan(0);
    for (const m of split) {
      expect(m.procedureName).not.toBe("AIf");
      expect(m.procedureName).not.toBe("AElse");
      expect(m.procedureName).toBe("");
    }
  });

  test("c-split: the site set is unchanged by the manifest fixes (operator multiset)", async () => {
    const { manifest } = await instrument({ "Split.Codeunit.al": C_SPLIT });
    const ops = manifest.mutants
      .filter(inSplit)
      .map((m) => `${m.startLine} ${m.operatorName}`)
      .sort();
    expect(ops).toEqual(SPLIT_SITES);
  });
});
/** Captured after R301's latch fix (Step 4a), before the manifest fixes; see the test above. */
const SPLIT_SITES: string[] = ["19 lethal.remove-assignment", "20 lethal.void-method-call"];
