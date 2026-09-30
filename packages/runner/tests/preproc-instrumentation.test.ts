import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ALSyntaxNode, initParser, parseAL, visit, wrapRoot } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { coverageArmNamesComputed, writeInstrumentedProject } from "@lethal/schemata";
import {
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
} from "../src/al-runner-coverage";
import type { TestMethodRef } from "../src/backend";
import type { RunEvent, RunEventInput } from "../src/events";
import { explain } from "../src/explain";
import { buildLineMap, lineMapFromSources, renamedMemberAttempts } from "../src/line-map";
import { generateMutationSet, operatorTiers, reachLatchRefusals } from "../src/orchestrator";
import { buildReport, renderConsole } from "../src/report";
import {
  buildCoverageIndex,
  coverageFilter,
  identityKeyOf,
  memberGroupNameOf,
  serializeKey,
} from "../src/selection";
import { newKillLedger, orderCoveringTests, procedureScopeOf, recordKill } from "../src/test-order";

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
): Promise<{
  manifest: MutantManifest;
  emitted: Map<string, string>;
  declarativeSites: Awaited<ReturnType<typeof generateMutationSet>>["declarativeSites"];
}> {
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
    // A file with no mutant (a table with only an empty procedure) is not written.
    for (const name of Object.keys(files)) {
      const text = await readFile(join(out, name), "utf8").catch(() => undefined);
      if (text !== undefined) emitted.set(name, text);
    }
    return { manifest, emitted, declarativeSites: set.declarativeSites };
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
 *
 * POSITIONAL only: it checks where the selector sits in the parse tree. It is NOT a warnings-clean
 * `alc` compile (no test here runs `alc`), so an emission placed right that still draws an AL
 * warning passes it. The two-symbol `alc` proof of the R-297 shapes was a manual scratch step.
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
      expect(m.coverageArmNames).toEqual(["AIf", "AElse"]);
    }
  });

  // R302 flipped this pin. It was a literal list of the sites HEAD found, which pinned the
  // blindness (the split body had no `empty-block`). The oracle is now the member's twin: the same
  // text with the markers and the `#else` arm blanked, every line kept.
  test("c-split: the split body's site set equals its twin's (line and operator multiset)", async () => {
    const twin = C_SPLIT.replace("#if CLEAN27", "").replace(
      "#else\n    internal procedure A(X: Integer)\n#endif",
      "\n\n",
    );
    expect(twin.split("\n")).toHaveLength(C_SPLIT.split("\n").length);
    expect(twin).not.toContain("#");
    const ops = async (src: string) =>
      (await instrument({ "Split.Codeunit.al": src })).manifest.mutants
        .filter(inSplit)
        .map((m) => `${m.startLine} ${m.operatorName}`)
        .sort();
    const want = await ops(twin);
    expect(want).toContain("18 lethal.empty-block");
    expect(await ops(C_SPLIT)).toEqual(want);
  });
});

describe("R303: a member whose var section is split by #if gets a latch, or is refused by name", () => {
  beforeAll(async () => {
    await initParser();
  });
  const SRC = `codeunit 50100 "Repro D"
{
    trigger OnRun()
#if not CLEAN27
    var
        L: Integer;
#else
    var
        M: Integer;
#endif
    begin
        if Glob > 1 then
            Glob := Glob + 1;
    end;

    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        if X > 1 then
            exit(X + 1);
        exit(0);
    end;

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        P := X + 2;
        exit(P);
    end;

    procedure Prag(X: Integer): Integer
#if not CLEAN27
#pragma warning disable AL0432
#endif
#if not CLEAN27
    var
        Q: Integer;
#endif
    begin
        if X > 3 then
            exit(X + 3);
        exit(0);
    end;

    procedure Twin(X: Integer): Integer
#if A
    var K: Integer;
#endif
#if not A
    var N: Integer;
#endif
    begin
        if X > 4 then
            exit(X + 4);
        exit(0);
    end;

    var
        Glob: Integer;
#if not CLEAN27
        Old: Integer;
#endif
}
`;

  test("header-anchored members get one latch on the header line; the pragma-first and the unparsed members are refused by name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r303-"));
    try {
      await writeFile(join(dir, "app.json"), JSON.stringify(APP_JSON));
      await writeFile(join(dir, "Repro.Codeunit.al"), SRC);
      const warnings: { code: string; message: string }[] = [];
      await generateMutationSet(dir, {
        emit: (e) => {
          if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
        },
      });
      const refused = warnings.filter((w) => w.code === "reach-latch-refused");
      expect(refused.map((w) => w.message.split("'s var section")[0])).toEqual([
        "[lethal] Repro.Codeunit.al: procedure Prag",
        "[lethal] Repro.Codeunit.al: procedure Twin",
      ]);
      const [prag, twin] = refused;
      expect(prag?.message).toContain("R303");
      expect(prag?.message).toContain("is not the end of its header");
      expect(prag?.message).not.toContain("did not parse cleanly");
      // Two #if var blocks in a row: tree-sitter-al leaves ERROR nodes, so the sentence names that.
      expect(twin?.message).toContain("R313");
      expect(twin?.message).toContain("var section did not parse cleanly");
      expect(twin?.message).not.toContain("is not the end of its header");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": SRC });
    const grains = new Map<string, Set<string>>();
    for (const m of manifest.mutants) {
      const who = m.triggerName ?? m.procedureName;
      grains.set(who, new Set([...(grains.get(who) ?? []), m.reachGrain ?? "none"]));
    }
    expect(grains.get("OnRun")?.has("statement")).toBe(true);
    expect(grains.get("Pick")?.has("statement")).toBe(true);
    expect([...(grains.get("Prag") ?? [])]).toEqual(["unplaced"]);
    expect([...(grains.get("Twin") ?? [])]).toEqual(["unplaced"]);
    expect(grains.get("Plain")?.has("statement")).toBe(true);
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    expect(text).toContain("trigger OnRun() var LethALReachLatch: Boolean;");
    expect(text).toContain("procedure Pick(X: Integer): Integer var LethALReachLatch: Boolean;");
    expect(text).toContain("P: Integer; LethALReachLatch: Boolean;");
    expect(text.split("LethALReachLatch: Boolean;").length - 1).toBe(3);
    expect(text.split(SELECTOR).length - 1).toBe(1);
    // R-297: the selector goes after a declaration-only #if block's #endif, on its own line.
    expect(text).toContain(
      `        Glob: Integer;\n#if not CLEAN27\n        Old: Integer;\n#endif\n        ${SELECTOR}`,
    );
  });

  test("S3's emission re-parses with ERROR nodes, yet both line maps give every line to its own member", async () => {
    // The hoist turns S3's nested #if into a nested #if inside an ordinary var section, which
    // tree-sitter-al cannot parse (SShadowS/tree-sitter-al #30). The bcdev line map and the
    // al-runner coverage index both re-parse the instrumented bundle, so pin that the ERRORs stay
    // inside Pick and the member boundaries survive.
    const S3 = `codeunit 50100 "Repro S"
{
    procedure Pick(X: Integer); // header note
#if not CLEAN27
    var
        K: Integer;
#if A
        N: Integer;
#endif
#endif
    begin
        Glob := X + 1;
    end;

    procedure After(X: Integer)
    begin
        Glob := X + 7;
    end;

    var
        Glob: Integer;
}
`;
    const src = await mkdtemp(join(tmpdir(), "lethal-r303-s3-src-"));
    const out = await mkdtemp(join(tmpdir(), "lethal-r303-s3-out-"));
    try {
      await writeFile(join(src, "app.json"), JSON.stringify(APP_JSON));
      await writeFile(join(src, "Repro.Codeunit.al"), S3);
      const set = await generateMutationSet(src);
      await writeInstrumentedProject({
        targetDir: out,
        files: set.files,
        selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: APP_JSON.id,
        operatorTiers,
      });
      const text = await readFile(join(out, "Repro.Codeunit.al"), "utf8");
      expect(text).toContain("procedure Pick(X: Integer); var LethALReachLatch: Boolean;");
      let errors = 0;
      visit(wrapRoot(parseAL(text)), (n) => {
        if (n.rawKind === "ERROR") errors++;
      });
      expect(errors).toBeGreaterThan(0);
      const lines = text.split("\n");
      const lineOf = (needle: string, from = 0): number => {
        const i = lines.findIndex((l, k) => k >= from && l.startsWith(needle));
        if (i < 0) throw new Error(`fixture drift: no line starting ${JSON.stringify(needle)}`);
        return i + 1;
      };
      // A whole-body mutant rewrites the member's own `end;` to column 0, so a member ends at the
      // last non-blank line before the next header.
      const lastBefore = (line: number): number => {
        let n = line - 1;
        while (n > 1 && (lines[n - 1] ?? "").trim() === "") n--;
        return n;
      };
      const pick = lineOf("    procedure Pick(");
      const after = lineOf("    procedure After(");
      const pickEnd = lastBefore(after);
      // The object's own var section; After's latch line also starts with "    var".
      const objectVar = lines.findIndex((l, k) => k >= after && l.trimEnd() === "    var") + 1;
      expect(objectVar).toBeGreaterThan(after);
      const afterEnd = lastBefore(objectVar);
      const expected = new Map<number, string | undefined>();
      for (let n = 1; n <= lines.length; n++) {
        expected.set(
          n,
          n >= pick && n <= pickEnd ? "Pick" : n >= after && n <= afterEnd ? "After" : undefined,
        );
      }
      const bcdev = await lineMapFromSources(
        [{ path: "Repro.Codeunit.al", text }],
        new Set(["codeunit:50100"]),
      );
      const alr = await buildAlRunnerCoverageIndex(out);
      expect(alr.refusedFiles).toEqual([]);
      expect(alr.multiObjectFiles).toEqual([]);
      for (const [n, who] of expected) {
        expect([n, bcdev.lookup("Codeunit", 50100, n)]).toEqual([n, who]);
        expect([n, alr.lineMap.lookup("Codeunit", 50100, n)]).toEqual([n, who]);
      }
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("R316: a split-header procedure whose arms each have their own var section takes one reach latch per arm", () => {
  beforeAll(async () => {
    await initParser();
  });
  const SRC = `codeunit 50100 "Repro P"
{
    var
        Glob: Integer;
#if not CLEAN27
        Old: Integer;
#endif

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        P := X + 3;
        exit(P);
    end;

#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
    begin
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

    procedure Hoist(X: Integer): Integer
#if not CLEAN27
    var
        H: Integer;
#endif
    begin
        if X > 4 then
            exit(X + 4);
        exit(0);
    end;

#if CLEAN27
    procedure Pick2(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Choose(X: Integer): Integer
#endif
    begin
        Glob := X + 7;
        exit(Glob);
    end;

#if CLEAN27
    procedure Twin(X: Integer): Integer
#if A
    var
        K: Integer;
#endif
#if not A
    var
        N: Integer;
#endif
#else
    procedure Twin(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := X + 8;
        exit(Glob);
    end;
}
`;
  const lines = SRC.split("\n");
  /** 1-based number of the first line at or after line `from` that starts with `prefix`. */
  const lineOf = (prefix: string, from = 1): number => {
    const i = lines.findIndex((l, k) => k + 1 >= from && l.startsWith(prefix));
    if (i < 0) throw new Error(`fixture drift: no line starting ${JSON.stringify(prefix)}`);
    return i + 1;
  };
  /** A member from its first line (the `#if` for a split header) through its closing `end;`. */
  const member = (name: string, prefix: string, from: number, grain: "statement" | "unplaced") => {
    const first = lineOf(prefix, from);
    return { name, first, last: lineOf("    end;", first), grain };
  };
  const plain = member("Plain", "    procedure Plain(", 1, "statement");
  const pick = member("Pick", "#if CLEAN27", plain.last, "statement");
  const hoist = member("Hoist", "    procedure Hoist(", pick.last, "statement");
  const pick2 = member("Pick2", "#if CLEAN27", hoist.last, "statement");
  // One arm's var section is two #if blocks in a row, which tree-sitter-al leaves as ERROR nodes
  // (R313): refused by R313's predicate, which runs before the preamble's own rule.
  const twin = member("Twin", "#if CLEAN27", pick2.last, "unplaced");
  const members = [plain, pick, hoist, pick2, twin];

  test("the only reach-latch-refused warning is the unparsed arm's, with R313's sentence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r316-"));
    try {
      await writeFile(join(dir, "app.json"), JSON.stringify(APP_JSON));
      await writeFile(join(dir, "Repro.Codeunit.al"), SRC);
      const warnings: { code: string; message: string }[] = [];
      await generateMutationSet(dir, {
        emit: (e) => {
          if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
        },
      });
      const refused = warnings.filter((w) => w.code === "reach-latch-refused");
      expect(refused.map((w) => w.message.split("'s var section")[0])).toEqual([
        "[lethal] Repro.Codeunit.al: procedure Twin",
      ]);
      const [w] = refused;
      expect(w?.message).toContain("did not parse cleanly");
      expect(w?.message).toContain("R313");
      expect(w?.message).not.toContain("R316");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("each member's sites carry its grain, and each admitted preamble arm gets its own latch", async () => {
    const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": SRC });
    // Every mutant sits in exactly one member, each bounded through its closing `end;`.
    for (const m of manifest.mutants) {
      const owners = members.filter((x) => m.startLine >= x.first && m.startLine <= x.last);
      expect(owners).toHaveLength(1);
    }
    for (const x of members) {
      const grains = manifest.mutants
        .filter((m) => m.startLine >= x.first && m.startLine <= x.last)
        .map((m) => m.reachGrain);
      expect(grains.length).toBeGreaterThan(0);
      expect([x.name, ...new Set(grains)]).toEqual([x.name, x.grain]);
    }
    const keys = manifest.mutants.map((m) => serializeKey(identityKeyOf(m)));
    expect(new Set(keys).size).toBe(keys.length);
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    const latch = " var LethALReachLatch: Boolean;";
    expect(text).toContain("P: Integer; LethALReachLatch: Boolean;");
    expect(text).toContain(`procedure Hoist(X: Integer): Integer${latch}`);
    expect(text.split(`    procedure Pick(X: Integer): Integer${latch}`).length - 1).toBe(2);
    expect(text).toContain(`    procedure Pick2(X: Integer): Integer${latch}`);
    expect(text).toContain(`    procedure Choose(X: Integer): Integer${latch}`);
    expect(text).not.toContain(`procedure Twin(X: Integer): Integer${latch}`);
    // Plain, Hoist, both Pick arms, Pick2 and Choose; none for Twin.
    expect(text.split("LethALReachLatch: Boolean;").length - 1).toBe(6);
    expect(text.split(SELECTOR).length - 1).toBe(1);
    expect(text).toContain(
      `        Glob: Integer;\n#if not CLEAN27\n        Old: Integer;\n#endif\n        ${SELECTOR}`,
    );
  });

  // Task 2 review: a parse error in a LATER arm's header (here the #else arm's parameter list) is
  // refused the same way as one in the first arm (P16): R313's predicate scans the whole preamble
  // before its body, so the member is unplaced, gets no latch, and is named by R313's sentence.
  test("P16 a later arm's header does not parse: refused by R313's sentence, all unplaced, no latch", async () => {
    const BAD = `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer Y: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
    begin
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;
    const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": BAD });
    expect(manifest.mutants.length).toBeGreaterThan(0);
    expect([...new Set(manifest.mutants.map((m) => m.reachGrain))]).toEqual(["unplaced"]);
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    expect(text).not.toContain("LethALReachLatch");
    expect(text).not.toContain("MutationSelector.Reached(");
    const dir = await mkdtemp(join(tmpdir(), "lethal-r316-"));
    try {
      await writeFile(join(dir, "app.json"), JSON.stringify(APP_JSON));
      await writeFile(join(dir, "Repro.Codeunit.al"), BAD);
      const warnings: { code: string; message: string }[] = [];
      await generateMutationSet(dir, {
        emit: (e) => {
          if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
        },
      });
      const refused = warnings.filter((w) => w.code === "reach-latch-refused");
      expect(refused.map((w) => w.message.split("'s var section")[0])).toEqual([
        "[lethal] Repro.Codeunit.al: procedure Pick",
      ]);
      const [w] = refused;
      expect(w?.message).toContain("did not parse cleanly");
      expect(w?.message).toContain("R313");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("R309 review: a refused member's name label drops blank arms and dedupes case/quote-insensitively", () => {
  // Hand-built nodes, not parsed: tree-sitter-al is not known to produce a MISSING `name` field on
  // a real preamble arm, so these two shapes are exercised directly through the exported
  // `reachLatchRefusals`, the same way `packages/schemata/tests/compile.test.ts` builds a node by
  // hand for a shape "not reachable through tree-sitter-al 4.4.1".
  const POS = { row: 0, column: 0 };
  function fakeNode(overrides: Partial<ALSyntaxNode> = {}): ALSyntaxNode {
    return {
      kind: "preproc_split_procedure_preamble" as ALSyntaxNode["kind"],
      rawKind: "preproc_split_procedure_preamble",
      text: "",
      startIndex: 0,
      endIndex: 0,
      startPosition: POS,
      endPosition: POS,
      parent: null,
      children: [],
      namedChildren: [],
      fieldName: null,
      isMissing: false,
      hasError: false,
      childForFieldName: () => null,
      ...overrides,
    };
  }
  /** A fake `name`-field child, as every arm's own header exposes one directly (see "The grammar"). */
  function fakeName(text: string): ALSyntaxNode {
    return fakeNode({
      rawKind: "identifier",
      kind: "identifier" as ALSyntaxNode["kind"],
      text,
      fieldName: "name",
    });
  }
  /** The one `reach-latch-refused` member label `reachLatchRefusals` computes for a preamble
   *  `owner` whose arm `name` children are exactly `armNames`. */
  function labelFor(armNames: readonly string[]): string {
    const owner = fakeNode({ children: armNames.map(fakeName) });
    const spec: MutationSpec = {
      operatorName: "lethal.op",
      operatorVersion: "1.0.0",
      astNodeId: "0-0",
      before: owner,
      after: { ...owner, text: "" } as never,
      parentContext: "statement-position",
    };
    const [refusal] = reachLatchRefusals([spec]);
    if (refusal === undefined) throw new Error("fixture drift: reachLatchRefusals refused nothing");
    return refusal.member;
  }

  test("R316: a preamble whose arms give no header end to anchor on is refused, cause preamble", () => {
    const owner = fakeNode({ children: [fakeName("Pick")] });
    const spec: MutationSpec = {
      operatorName: "lethal.op",
      operatorVersion: "1.0.0",
      astNodeId: "0-0",
      before: owner,
      after: { ...owner, text: "" } as never,
      parentContext: "statement-position",
    };
    expect(reachLatchRefusals([spec]).map((r) => r.cause)).toEqual(["preamble"]);
  });

  test("an arm with a missing (blank) name, leaving only one real name, gives <unnamed> rather than a misleading rename", () => {
    expect(labelFor(["Pick", ""])).toBe("procedure <unnamed>");
  });

  test("names that agree case- and quote-insensitively count once, keeping the first spelling", () => {
    expect(labelFor(["Pick", '"pick"', "Other"])).toBe(
      "procedure <renamed per #if arm: Pick, Other>",
    );
  });

  // Controls: the shapes the review already measured as correct, unchanged by this fix.
  test("control: three arms that really do all differ list every one", () => {
    expect(labelFor(["Pick", "Choose", "Take"])).toBe(
      "procedure <renamed per #if arm: Pick, Choose, Take>",
    );
  });

  test("control: two arms sharing one exact name among three collapse to two", () => {
    expect(labelFor(["Pick", "Pick", "Choose"])).toBe(
      "procedure <renamed per #if arm: Pick, Choose>",
    );
  });
});

describe("R-309 review run 002, I1: unnamedMemberLabel is also the fallback for an R303-refused split-header procedure", () => {
  beforeAll(async () => {
    await initParser();
  });
  // R301's shape (preproc_split_procedure: one header per arm, no var section of its own), whose
  // arms rename the procedure, followed by ONE shared var section that is itself split by #if
  // (r2-split-header in the R-303 plan). splitVarHoistAnchor finds no single header end for a
  // split header, so this member is refused by R303's cause, not R309's: this is the combination
  // the run 001 review found untested (Important finding).
  const SRC = `codeunit 50100 "Repro R"
{
#if A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        if X > 1 then
            exit(X + 1);
        exit(0);
    end;
}
`;

  test("the R303 warning for a renamed split-header procedure uses the new <renamed per #if arm: ...> label, not <unnamed>", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r309-r002-i1-"));
    try {
      await writeFile(join(dir, "app.json"), JSON.stringify(APP_JSON));
      await writeFile(join(dir, "Repro.Codeunit.al"), SRC);
      const warnings: { code: string; message: string }[] = [];
      await generateMutationSet(dir, {
        emit: (e) => {
          if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
        },
      });
      const refused = warnings.filter((w) => w.code === "reach-latch-refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.message.split("'s var section")[0]).toBe(
        "[lethal] Repro.Codeunit.al: procedure <renamed per #if arm: Pick, Choose>",
      );
      expect(refused[0]?.message).toContain("R303");
      expect(refused[0]?.message).not.toContain("R309");
      expect(refused[0]?.message).not.toContain("<unnamed>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("R316: a split-header procedure whose arms each have their own var section is a member", () => {
  beforeAll(async () => {
    await initParser();
  });
  const SRC = `codeunit 50100 "Repro M"
{
    procedure Plain(X: Integer): Integer
    begin
        Glob := Glob + 1;
        exit(Glob);
    end;

#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
    begin
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

#if CLEAN27
    local procedure LPick(X: Integer): Integer
    var
        K: Integer;
#else
    local procedure LPick(X: Integer): Integer
#endif
    begin
        Glob := Glob + 3;
        exit(Glob);
    end;

#if CLEAN27
    local procedure MPick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure MPick(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 4;
        exit(Glob);
    end;

#if CLEAN27
    procedure Pick2(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Choose(X: Integer): Integer
#endif
    begin
        Glob := Glob + 5;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;
  const lines = SRC.split("\n");
  /** 1-based number of the first line at or after line `from` that starts with `prefix`. */
  const lineOf = (prefix: string, from = 1): number => {
    const i = lines.findIndex((l, k) => k + 1 >= from && l.startsWith(prefix));
    if (i < 0) throw new Error(`fixture drift: no line starting ${JSON.stringify(prefix)}`);
    return i + 1;
  };
  /** A member from its first line (the `#if` for a split header) through its closing `end;`. */
  const member = (
    label: string,
    prefix: string,
    from: number,
    name: string,
    scope: "local" | "public",
  ) => {
    const first = lineOf(prefix, from);
    const begin = lineOf("    begin", first);
    return { label, name, scope, first, begin, last: lineOf("    end;", first) };
  };
  const plain = member("Plain", "    procedure Plain(", 1, "Plain", "public");
  const pick = member("Pick", "#if CLEAN27", plain.last, "Pick", "public");
  const lpick = member("LPick", "#if CLEAN27", pick.last, "LPick", "local");
  const mpick = member("MPick", "#if CLEAN27", lpick.last, "MPick", "public");
  // Arms that rename the procedure: which arm is compiled is not known here (R301's rule).
  const renamed = member("Pick2/Choose", "#if CLEAN27", mpick.last, "", "public");
  const members = [plain, pick, lpick, mpick, renamed];
  const ownerOf = (line: number) => {
    const owners = members.filter((x) => line >= x.first && line <= x.last);
    expect(owners).toHaveLength(1);
    const [owner] = owners;
    if (owner === undefined) throw new Error("unreachable");
    return owner;
  };

  test("name, scope, member lines and gap block for every member, each bounded through its end;", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": SRC });
    for (const x of members) {
      expect(manifest.mutants.filter((m) => ownerOf(m.startLine) === x).length).toBeGreaterThan(0);
    }
    for (const m of manifest.mutants) {
      const x = ownerOf(m.startLine);
      expect([x.label, m.procedureName]).toEqual([x.label, x.name]);
      expect([x.label, m.procedureScope]).toEqual([x.label, x.scope]);
      expect([x.label, m.procedureStartLine, m.procedureEndLine]).toEqual([
        x.label,
        x.first,
        x.last,
      ]);
      // The shared body or a branch inside it, never the file root.
      expect(m.blockStartLine ?? 0).toBeGreaterThanOrEqual(x.begin);
      expect(m.blockEndLine ?? 0).toBeLessThanOrEqual(x.last);
    }
  });

  test("identity keys carry the member's name, and no two mutants share one", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": SRC });
    const keys = manifest.mutants.map((m) => serializeKey(identityKeyOf(m)));
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of manifest.mutants) {
      expect(serializeKey(identityKeyOf(m)).split("|")[2]).toBe(ownerOf(m.startLine).name);
    }
  });

  // Review r1, I1: an identity key carries an ordinal among its twins (same hash, object, member
  // name, operator), numbered in SOURCE order. An agreeing preamble used to sit in the "" group
  // and now sits in its name's group, so an identical site AFTER it in the same object is
  // renumbered: a renamed R301 split procedure's ordinal drops, a same-named overload's rises.
  // Both need a preamble in the object, which no fixture or measured corpus has. Pinned so the
  // effect stays deliberate.
  test("ordinals: a preamble leaves the empty-name group and joins its name's group", async () => {
    const PRE = `#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 2;
    end;
`;
    const RENAMED = `#if CLEAN27
    procedure AIf(X: Integer): Integer
#else
    procedure AElse(X: Integer): Integer
#endif
    var
        S: Integer;
    begin
        Glob := Glob + 2;
    end;
`;
    const OVERLOAD = `    procedure Pick(X: Text): Integer
    begin
        Glob := Glob + 2;
    end;
`;
    const file = (a: string, b: string): string =>
      `codeunit 50100 "Repro K"
{
${a}
${b}
    var
        Glob: Integer;
}
`;
    const ordinals = async (src: string) => {
      const { manifest } = await instrument({ "Repro.Codeunit.al": src });
      return manifest.mutants
        .filter((m) => m.operatorName === "lethal.remove-assignment")
        .sort((a, b) => a.startIndex - b.startIndex)
        .map((m) => `${m.procedureName}#${m.identityOrdinal ?? 0}`);
    };
    // Before R316 these read ["#0", "#1"] and ["#0", "Pick#0"].
    expect(await ordinals(file(PRE, RENAMED))).toEqual(["Pick#0", "#0"]);
    expect(await ordinals(file(PRE, OVERLOAD))).toEqual(["Pick#0", "Pick#1"]);
    // A renamed split procedure BEFORE the preamble keeps its ordinal.
    expect(await ordinals(file(RENAMED, PRE))).toEqual(["#0", "Pick#0"]);
  });

  test("both line maps, built from the EMITTED target, name every dispatch line of a split member, a renamed one by its first coverage name (R318)", async () => {
    // Fenced bcdev (`buildLineMap` over the instrumented dir) and al-runner's Cobertura index both
    // read the emitted source, whose lines differ from SRC. al-runner's --server path does not
    // use a line map at all (`st.scope`), so it needs a probe of its own.
    const { emitted } = await instrument({ "Repro.Codeunit.al": SRC });
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    const dir = await mkdtemp(join(tmpdir(), "lethal-r316-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), text);
      const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
      const alr = await buildAlRunnerCoverageIndex(dir);
      expect(alr.refusedFiles).toEqual([]);
      const out = text.split("\n");
      const starts = out.flatMap((l, k) =>
        l.startsWith("#if CLEAN27") || l.startsWith("    procedure Plain(") ? [k + 1] : [],
      );
      expect(starts).toHaveLength(members.length);
      const ends = [...starts.slice(1), out.length + 1];
      let checked = 0;
      for (const [i, x] of members.entries()) {
        const from = starts[i] ?? 0;
        const to = (ends[i] ?? 0) - 1;
        for (let n = from; n <= to; n++) {
          if (!(out[n - 1] ?? "").includes("MutationSelector.Active(")) continue;
          expect([n, bcdev.lookup("Codeunit", 50100, n)]).toEqual([
            n,
            x === renamed ? "Pick2" : x.name,
          ]);
          expect([n, alr.lineMap.lookup("Codeunit", 50100, n)]).toEqual([
            n,
            x === renamed ? "Pick2" : x.name,
          ]);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(members.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// R327: a split member placed after the object's global `var` section parses INSIDE that section,
// so the symbol table does not index it. Before the fix its names typed by the object's GLOBALS
// (swap-call-arguments at the Show call failed `alc` with AL0133 in both builds), a swallowed
// overload left the plain one "unique" (swap-additive on Text failed `alc` with AL0175), and a
// swallowed `SetRange` did not stop a Tier-2 claim. The repros are hand-written; `alc` of each
// instrumented project passes under [] and [CLEAN27] (logged in the R-302 task report).
const R327_SWALLOW = `codeunit 50100 "Repro R327"
{
    var
        Glob: Integer;
        X: Integer;
        Y: Integer;

#if CLEAN27
    procedure Pick(X: Integer; Y: Text): Integer
#else
    procedure Pick(X: Integer; Y: Text): Integer
#endif
    var
        K: Integer;
    begin
        Show(X, Y);
        K := X + 1;
        exit(K);
    end;

    procedure Show(A: Integer; B: Text)
    begin
        Glob := A;
    end;
}
`;
const R327_OVERLOAD = `codeunit 50100 "Repro R327O"
{
    var
        Glob: Integer;

#if CLEAN27
    procedure Foo(T: Text): Text
#else
    procedure Foo(T: Text): Text
#endif
    begin
        exit(T);
    end;

    procedure Foo(X: Integer): Integer
    begin
        exit(X);
    end;

    procedure Caller(): Text
    begin
        exit(Foo('x') + Foo('y'));
    end;
}
`;
const R327_TABLE = `table 50100 "Repro Tab"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }

    var
        Glob: Integer;

#if CLEAN27
    procedure SetRange(F: Code[20]; V: Code[20])
#else
    procedure SetRange(F: Code[20]; V: Code[20])
#endif
    begin
        Glob := 1;
    end;
}
`;
const R327_CALLER = `codeunit 50101 "Repro R327S"
{
    procedure Pick(C: Code[20])
    var
        R: Record "Repro Tab";
    begin
        R.SetRange(Code, C);
    end;
}
`;

describe("R327: a split member swallowed by the global var section gets no site typed by a global", () => {
  beforeAll(async () => {
    await initParser();
  });
  const sites = (m: MutantManifest) =>
    m.mutants.map((x) => `${x.file} L${x.startLine} ${x.operatorName}`).sort();

  // The whole-body `empty-block` (L15) needs no type, so Task 2's body walks admit it; `alc`
  // passes on it in both builds (scratch, logged in the R-302 task report).
  test("swallow: no swap at Show(X, Y), no swap-additive on X + 1", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R327_SWALLOW });
    expect(sites(manifest)).toEqual([
      "Repro.Codeunit.al L15 lethal.empty-block",
      "Repro.Codeunit.al L16 lethal.void-method-call",
      "Repro.Codeunit.al L17 lethal.remove-assignment",
      "Repro.Codeunit.al L18 lethal.return-value",
      "Repro.Codeunit.al L22 lethal.empty-block",
      "Repro.Codeunit.al L23 lethal.remove-assignment",
    ]);
  });

  test("overload: no swap-additive at the call a swallowed overload makes ambiguous", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R327_OVERLOAD });
    expect(sites(manifest)).not.toContain("Repro.Codeunit.al L22 lethal.swap-additive");
    expect(sites(manifest)).toContain("Repro.Codeunit.al L21 lethal.empty-block");
  });

  test("setrange: a swallowed SetRange stops the Tier-2 claim; the Tier-1 site stays", async () => {
    const { manifest } = await instrument({
      "Tab.Table.al": R327_TABLE,
      "Repro.Codeunit.al": R327_CALLER,
    });
    const got = sites(manifest);
    expect(got).not.toContain("Repro.Codeunit.al L7 lethal.remove-setrange");
    expect(got).toContain("Repro.Codeunit.al L7 lethal.void-method-call");
  });
});

// R-302 Task 3: runner-level pins, through the real pipeline (generate, instrument, manifest).
// Each source is copied byte for byte from the named scratch repro (hand-written, invented names),
// whose rows were pre-committed before any fix existed.
const T3_Q2 = `codeunit 50100 "Repro P"
{
    procedure Twin(X: Integer): Integer
    var
        K: Integer;
    begin
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

#if CLEAN27
    procedure Pick(X: Integer): Integer
#else
    procedure Pick(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;
const T3_D1 = `codeunit 50100 "Repro D1"
{
#if CLEAN27
    procedure Pick(X: Integer; Y: Integer): Integer
#else
    procedure Pick(X: Integer; Y: Text): Integer
#endif
    var
        K: Integer;
    begin
        Show(X, Y);
        K := X + 1;
        exit(K);
    end;

    procedure Show(A: Integer; B: Integer)
    begin
        Glob := A;
    end;

    procedure Show(A: Integer; B: Text)
    begin
        Glob := A;
    end;

    var
        Glob: Integer;
        Y: Integer;
}
`;
const T3_D3 = `codeunit 50100 "Repro D3"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        N: Integer;
#else
    procedure Pick(X: Integer): Integer
#endif
    begin
#if CLEAN27
        N := X;
        Glob := N + 1;
#endif
        exit(Glob);
    end;

    var
        Glob: Integer;
        N: Text;
}
`;
const T3_D7 = `codeunit 50100 "Repro D7"
{
#if CLEAN27
    procedure Same(X: Integer): Integer
#else
    procedure Same(X: Integer): Integer
#endif
    begin
    end;

#if CLEAN27
    procedure Differs(X: Integer): Decimal
#else
    procedure Differs(X: Integer): Integer
#endif
    begin
    end;

    procedure Caller()
    begin
        Glob := Same(1) + 1;
        Glob := Differs(1) + 1;
    end;

    var
        Glob: Decimal;
}
`;
const T3_D6_CU = `codeunit 50100 "Repro D6"
{
    procedure Pick(C: Code[20])
    var
        R: Record "Repro Tab S";
    begin
        R.SetRange(Code, C);
    end;
}
`;
const T3_D6_TAB = `table 50101 "Repro Tab S"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }

#if CLEAN27
    procedure SetRange(F: Code[20]; V: Code[20])
#else
    procedure SetRangeOld(F: Code[20]; V: Code[20])
#endif
    begin
    end;
}
`;
const T3_A1 = `codeunit 50100 "Repro A1"
{
#if CLEAN27
    [Obsolete('Old.', '27.0')]
    procedure Pick(X: Integer): Boolean
#else
    procedure Pick(X: Integer): Boolean
#endif
    var
        T: Text;
    begin
        T := 'abc';
        exit(X > 1);
    end;

#if CLEAN27
    [IntegrationEvent(false, false)]
    local procedure OnPick(var Handled: Boolean)
#else
    [IntegrationEvent(true, false)]
    local procedure OnPick(var Handled: Boolean)
#endif
    begin
    end;
}
`;
const T3_HANG = `codeunit 50112 "Hang C"
{
#if CLEAN27
    procedure A()
#else
    internal procedure A()
#endif
    var
        I: Integer;
        Done: Boolean;
    begin
        while I < 10 do
            I := I + 1;
        repeat
            Done := true;
        until Done;
    end;
}
`;
const T3_C3 = `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 2;
        exit(Glob);
    end;

    procedure Pick(X: Text): Integer
    begin
        Glob := Glob + 2;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;
const T3_C1 = `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 2;
        exit(Glob);
    end;

#if CLEAN27
    procedure AIf(X: Integer): Integer
#else
    procedure AElse(X: Integer): Integer
#endif
    var
        S: Integer;
    begin
        Glob := Glob + 2;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;
const T3_O1 = `codeunit 50100 "Repro O1"
{
#if CLEAN27
    procedure Foo(X: Integer): Integer
#else
    procedure Foo(X: Integer): Integer
#endif
    begin
        exit(X);
    end;

    procedure Foo(T: Text): Text
    begin
        exit(T);
    end;

    procedure Caller(): Text
    begin
        exit(Foo('x') + Foo('y'));
    end;
}
`;
const T3_O2 = `codeunit 50100 "Repro O2"
{
    procedure Foo(X: Integer): Integer
    begin
        exit(X);
    end;

    procedure Foo(T: Text): Text
    begin
        exit(T);
    end;

    procedure Caller(): Text
    begin
        exit(Foo('x') + Foo('y'));
    end;
}
`;
const T3_O3 = `codeunit 50100 "Repro O3"
{
    procedure Foo(X: Integer): Integer
    begin
        exit(X);
    end;

    procedure Caller(): Integer
    begin
        exit(FOO(1) + 1);
    end;
}
`;
const T3_E1 = `codeunit 50100 "Repro E1"
{
    procedure Pick(X: Integer; y: Text): Integer
    var
        K: Integer;
    begin
        Show(X, Y);
        K := X + 1;
        exit(K);
    end;

    procedure Show(A: Integer; B: Integer)
    begin
        Glob := A;
    end;

    procedure Show(A: Integer; B: Text)
    begin
        Glob := A;
    end;

    var
        Glob: Integer;
        Y: Integer;
}
`;
const T3_E2 = `codeunit 50100 "Repro E2"
{
#if CLEAN27
    procedure Pick(X: Integer; y: Text): Integer
#else
    procedure Pick(X: Integer; y: Text): Integer
#endif
    var
        K: Integer;
    begin
        Show(X, Y);
        K := X + 1;
        exit(K);
    end;

    procedure Show(A: Integer; B: Integer)
    begin
        Glob := A;
    end;

    procedure Show(A: Integer; B: Text)
    begin
        Glob := A;
    end;

    var
        Glob: Integer;
        Y: Integer;
}
`;
const T3_E3 = `codeunit 50100 "Repro E3"
{
    procedure Total(amount: Decimal): Decimal
    var
        Rate: Decimal;
    begin
        Rate := 2;
        exit(Amount + rate);
    end;
}
`;

describe("R302: split-member sites through the real pipeline", () => {
  beforeAll(async () => {
    await initParser();
  });
  const rows = (m: MutantManifest, file = "Repro.Codeunit.al") =>
    m.mutants.filter((x) => x.file === file).map((x) => `L${x.startLine} ${x.operatorName}`);
  const one = async (src: string) => (await instrument({ "Repro.Codeunit.al": src })).manifest;
  const keyAt = (m: MutantManifest, line: number, op: string): string => {
    const hits = m.mutants.filter((x) => x.startLine === line && x.operatorName === op);
    const [hit] = hits;
    if (hit === undefined || hits.length !== 1) throw new Error(`not one ${op} at L${line}`);
    return serializeKey(identityKeyOf(hit));
  };

  test("q2: the split member's (relative line, operator) multiset equals its plain twin's, and every one names it", async () => {
    const m = await one(T3_Q2);
    const twin = m.mutants.filter((x) => x.procedureName === "Twin");
    const pick = m.mutants.filter((x) => x.startLine >= 13 && x.startLine <= 25);
    expect(pick.length).toBe(7);
    for (const x of pick) expect(x.procedureName).toBe("Pick");
    const rel = (xs: typeof twin, base: number) =>
      xs.map((x) => `${x.startLine - base} ${x.operatorName}`).sort();
    expect(rel(pick, 20)).toEqual(rel(twin, 6));
  });

  test("d1: no swap-call-arguments at Show(X, Y), where Y is ambiguous and a global Y exists", async () => {
    const got = rows(await one(T3_D1));
    expect(got).not.toContain("L11 lethal.swap-call-arguments");
    expect(got).toContain("L12 lethal.swap-additive");
  });

  test("d3: no swap-additive on a name only one arm declares", async () => {
    const got = rows(await one(T3_D3));
    expect(got).not.toContain("L13 lethal.swap-additive");
    expect(got).toContain("L15 lethal.return-value");
  });

  test("d7: swap-additive on the call whose arms agree on the return type, not on the other", async () => {
    const got = rows(await one(T3_D7));
    expect(got).toContain("L21 lethal.swap-additive");
    expect(got).not.toContain("L22 lethal.swap-additive");
  });

  test("d6: a SetRange one arm declares stops the Tier-2 claim; void-method-call stays", async () => {
    const { manifest } = await instrument({
      "Repro.Codeunit.al": T3_D6_CU,
      "Tab.Table.al": T3_D6_TAB,
    });
    const got = rows(manifest);
    expect(got).toContain("L7 lethal.void-method-call");
    expect(got).not.toContain("L7 lethal.remove-setrange");
  });

  test("a1: no mutant on an attribute inside an arm, and no site dropped as not executable", async () => {
    const { manifest, declarativeSites } = await instrument({ "Repro.Codeunit.al": T3_A1 });
    const lines = new Set(manifest.mutants.map((x) => x.startLine));
    for (const attr of [4, 17, 20]) expect(lines.has(attr)).toBe(false);
    expect(rows(manifest).sort()).toEqual(
      [
        "L11 lethal.empty-block",
        "L12 lethal.remove-assignment",
        "L12 lethal.toggle-blank-string",
        "L13 lethal.conditional-boundary",
        "L13 lethal.return-value",
      ].sort(),
    );
    expect(declarativeSites).toEqual([]);
  });

  test("t5-hang: both remove-assignment mutants carry the loop hang tag", async () => {
    const { manifest } = await instrument({ "H.Codeunit.al": T3_HANG });
    const ra = manifest.mutants.filter((x) => x.operatorName === "lethal.remove-assignment");
    expect(ra.map((x) => [x.startLine, x.hangCapable])).toEqual([
      [13, "loop-condition-target"],
      [15, "loop-condition-target"],
    ]);
  });

  test("c3: the overload after the preamble takes ordinal 1; the preamble's keys have none", async () => {
    const m = await one(T3_C3);
    expect(keyAt(m, 12, "lethal.empty-block").endsWith("|1|1")).toBe(false);
    expect(keyAt(m, 14, "lethal.return-value").endsWith("|1|1")).toBe(false);
    expect(keyAt(m, 18, "lethal.empty-block")).toBe(`${keyAt(m, 12, "lethal.empty-block")}|1`);
    expect(keyAt(m, 20, "lethal.return-value")).toBe(`${keyAt(m, 14, "lethal.return-value")}|1`);
  });

  test("c1: the renamed member's new mutants name no procedure", async () => {
    const m = await one(T3_C1);
    const renamed = m.mutants.filter((x) => x.startLine >= 24 && x.startLine <= 26);
    expect(renamed.map((x) => `L${x.startLine} ${x.operatorName}`).sort()).toContain(
      "L24 lethal.empty-block",
    );
    for (const x of renamed) expect(x.procedureName).toBe("");
  });

  test("o1: no swap-additive at the overloaded call; the plain overload's empty-block takes ordinal 1", async () => {
    const m = await one(T3_O1);
    expect(rows(m)).not.toContain("L19 lethal.swap-additive");
    expect(keyAt(m, 13, "lethal.empty-block")).toBe(`${keyAt(m, 8, "lethal.empty-block")}|1`);
  });

  test("o2: no swap-additive at a call to an overloaded plain procedure (R324)", async () => {
    expect(rows(await one(T3_O2))).not.toContain("L15 lethal.swap-additive");
  });

  test("e1 and e2: no swap-call-arguments where the parameter is spelled in other casing (R322)", async () => {
    expect(rows(await one(T3_E1))).not.toContain("L7 lethal.swap-call-arguments");
    expect(rows(await one(T3_E2))).not.toContain("L11 lethal.swap-call-arguments");
  });

  test("o3 and e3: the sites a case-insensitive name adds", async () => {
    expect(rows(await one(T3_O3))).toContain("L10 lethal.swap-additive");
    expect(rows(await one(T3_E3))).toContain("L8 lethal.swap-additive");
  });
});

// R330, run 002: a name declared in a `#if` region the symbol table does not index is UNKNOWN.
// Sources copied byte for byte from the scratch repros pre-committed in the plan's run 002 addendum.
// Before the fix each emitted a `swap-additive` in `Bar` that fails `alc` with AL0175 (i1 under
// [X] and [X,Y]; i2 under []; p1, master's older plain form, under [X]).
const R330_I1 = `codeunit 50100 "Repro R330A"
{
#if Y
    procedure Foo(A: Integer): Integer
#else
    procedure Foo(A: Integer): Integer
#endif
    begin
        exit(A);
    end;

#if X
    procedure Foo(A: Text): Text
    begin
        exit(A);
    end;

    procedure Bar(): Text
    begin
        exit(Foo('x') + Foo('y'));
    end;
#endif
}
`;
const R330_I2 = `codeunit 50100 "Repro R330B"
{
    var
        AMT: Integer;

    procedure Bar()
#if not CLEAN27
    var
        Amt: Text;
#endif
    begin
        Message('%1', Amt + Amt);
    end;
}
`;
const R330_P1 = `codeunit 50100 "Repro R330P"
{
    procedure Foo(A: Integer): Integer
    begin
        exit(A);
    end;

#if X
    procedure Foo(A: Text): Text
    begin
        exit(A);
    end;

    procedure Bar(): Text
    begin
        exit(Foo('x') + Foo('y'));
    end;
#endif
}
`;

describe("R330: no typed site from a name declared in an unindexed #if region", () => {
  beforeAll(async () => {
    await initParser();
  });
  const ops = async (src: string) =>
    (await instrument({ "Repro.Codeunit.al": src })).manifest.mutants
      .map((x) => `${x.procedureName} ${x.operatorName}`)
      .sort();

  test("i1: a split member beside a #if-wrapped overload gives Bar no swap-additive", async () => {
    expect(await ops(R330_I1)).toEqual([
      "Bar lethal.empty-block",
      "Foo lethal.empty-block",
      "Foo lethal.empty-block",
      "Foo lethal.return-value",
    ]);
  });

  test("i2: a #if var-block local hides the differently-cased global", async () => {
    expect(await ops(R330_I2)).toEqual(["Bar lethal.empty-block", "Bar lethal.void-method-call"]);
  });

  test("p1: master's older plain form gives Bar no swap-additive either", async () => {
    expect(await ops(R330_P1)).toEqual([
      "Bar lethal.empty-block",
      "Foo lethal.empty-block",
      "Foo lethal.empty-block",
      "Foo lethal.return-value",
    ]);
  });
});

// R330, run 002 fix round: a trigger's own locals hide the globals. Sources copied byte for byte
// from the repros pre-committed in the plan's addendum 2. Before the fix each emitted a
// `swap-additive` on `Amt + Amt` that fails `alc` with AL0175 (t3s is master's older same-case form).
const R330_T1C = `codeunit 50100 "Repro R330T1"
{
    trigger OnRun()
#if not CLEAN27
    var
        Amt: Text;
#endif
    begin
        Message('%1', Amt + Amt);
    end;

    var
        AMT: Integer;
}
`;
const R330_T3 = `codeunit 50100 "Repro R330T3"
{
    trigger OnRun()
    var
        Amt: Text;
    begin
        Message('%1', Amt + Amt);
    end;

    var
        AMT: Integer;
}
`;
const R330_T3S = `codeunit 50100 "Repro R330T3S"
{
    trigger OnRun()
    var
        Amt: Text;
    begin
        Message('%1', Amt + Amt);
    end;

    var
        Amt: Integer;
}
`;
const R330_T2 = `table 50100 "Repro R330T2"
{
    fields
    {
        field(1; Code; Code[20])
        {
            trigger OnValidate()
#if not CLEAN27
            var
                Amt: Text;
#endif
            begin
                Message('%1', Amt + Amt);
            end;
        }
    }

    var
        AMT: Integer;
}
`;

describe("R330: no typed site from a name a trigger declares in its own header", () => {
  beforeAll(async () => {
    await initParser();
  });
  const ops = async (file: string, src: string) =>
    (await instrument({ [file]: src })).manifest.mutants.map((x) => x.operatorName).sort();
  const WANT = ["lethal.empty-block", "lethal.void-method-call"];

  test("t1c: a #if trigger local hides the differently-cased global", async () => {
    expect(await ops("Repro.Codeunit.al", R330_T1C)).toEqual(WANT);
  });
  test("t3: a plain trigger local hides the differently-cased global", async () => {
    expect(await ops("Repro.Codeunit.al", R330_T3)).toEqual(WANT);
  });
  test("t3s: a plain trigger local hides the same-cased global (master's older form)", async () => {
    expect(await ops("Repro.Codeunit.al", R330_T3S)).toEqual(WANT);
  });
  test("t2: a #if local of a field's OnValidate hides the global", async () => {
    expect(await ops("Tab.Table.al", R330_T2)).toEqual(WANT);
  });
});

// R331 (run 003): unindexed means unknown, for every member shape and for rule 3. Sources copied
// byte for byte from the repros pre-committed in the plan's addendum 3. Before the fix: c1 and c1s
// emitted a `swap-additive` failing `alc` with AL0175 under [X]; c2, c2o and c2x emitted a
// `validate-to-assign` that assigns a field that does not exist (AL0132) in every build.
const R331_C1 = `codeunit 50100 "Repro R331C1"
{
#if X
    procedure Foo(V: Text): Text
    begin
        exit(V + V);
    end;
#endif

    var
        v: Integer;
}
`;
const R331_C1S = `codeunit 50100 "Repro R331C1S"
{
#if X
    procedure Foo(V: Text): Text
    begin
        exit(V + V);
    end;
#endif

    var
        V: Integer;
}
`;
const R331_C2_CU = `codeunit 50100 "Repro R331C2"
{
    procedure Pick()
    var
        R: Record "Repro Tab C2";
        N: Integer;
    begin
        R.Validate(N, 5);
    end;
}
`;
const R331_C2_TAB = `table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }

#if X
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
#else
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
#endif
}
`;
const R331_C2O_TAB = `#if X
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }

    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#else
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }

    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#endif
`;
const R331_C2X_TAB = `table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
`;
const R331_C2X_EXT = `#if X
tableextension 50102 "Repro Tab C2 Ext" extends "Repro Tab C2"
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#else
tableextension 50102 "Repro Tab C2 Ext" extends "Repro Tab C2"
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#endif
`;

describe("R331: no typed site in an unindexed member, and rule 3 sees #if-wrapped declarations", () => {
  beforeAll(async () => {
    await initParser();
  });
  const ops = async (files: Record<string, string>) =>
    (await instrument(files)).manifest.mutants.map((x) => x.operatorName).sort();

  test("c1: no swap-additive inside a #if-wrapped plain procedure (global in other casing)", async () => {
    expect(await ops({ "Repro.Codeunit.al": R331_C1 })).toEqual(["lethal.empty-block"]);
  });
  test("c1s: nor with the global in the same casing", async () => {
    expect(await ops({ "Repro.Codeunit.al": R331_C1S })).toEqual(["lethal.empty-block"]);
  });
  const C2_WANT = ["lethal.empty-block", "lethal.void-method-call"];
  test("c2: a #if-wrapped table Validate stops validate-to-assign", async () => {
    expect(await ops({ "Repro.Codeunit.al": R331_C2_CU, "Tab.Table.al": R331_C2_TAB })).toEqual(
      C2_WANT,
    );
  });
  test("c2o: so does a table wrapped whole in #if", async () => {
    expect(await ops({ "Repro.Codeunit.al": R331_C2_CU, "Tab.Table.al": R331_C2O_TAB })).toEqual(
      C2_WANT,
    );
  });
  test("c2x: so does a #if-wrapped tableextension", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_C2_CU,
        "Tab.Table.al": R331_C2X_TAB,
        "TabExt.TableExt.al": R331_C2X_EXT,
      }),
    ).toEqual(C2_WANT);
  });
});

// R330 (run 003 fix round): a trigger's parameters hide the globals. Sources copied byte for byte
// from the scratch repros r330-tp1 and r330-tp1s. Before the fix each emitted `Which - Which`,
// which fails `alc` with AL0175 (tp1s, the same-case form, on master too).
const R330_TP1 = `page 50100 "Repro R330TP1"
{
    PageType = List;
    SourceTable = "Repro Tab TP";

    trigger OnFindRecord(Which: Text): Boolean
    begin
        Message('%1', Which + Which);
        exit(Rec.Find(Which));
    end;

    var
        WHICH: Integer;
}
`;
const R330_TP1S = `page 50100 "Repro R330TP1S"
{
    PageType = List;
    SourceTable = "Repro Tab TP";

    trigger OnFindRecord(Which: Text): Boolean
    begin
        Message('%1', Which + Which);
        exit(Rec.Find(Which));
    end;

    var
        Which: Integer;
}
`;
const R330_TP_TAB = `table 50101 "Repro Tab TP"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
`;

describe("R330: no typed site from a trigger's parameter", () => {
  beforeAll(async () => {
    await initParser();
  });
  const ops = async (page: string) =>
    (await instrument({ "Repro.Page.al": page, "Tab.Table.al": R330_TP_TAB })).manifest.mutants
      .map((x) => x.operatorName)
      .sort();
  const WANT = ["lethal.empty-block", "lethal.void-method-call"];
  test("tp1: a page trigger parameter hides the differently-cased global", async () => {
    expect(await ops(R330_TP1)).toEqual(WANT);
  });
  test("tp1s: and the same-cased one", async () => {
    expect(await ops(R330_TP1S)).toEqual(WANT);
  });
});

// R331 (run 004): a table's id and name are aliases for rule 3, whether the table is indexed or
// wrapped whole in `#if`. Sources copied byte for byte from the scratch repros r331-n1 to n4.
// Before the fix n1, n1w, n2 and n4 emitted a `validate-to-assign` assigning a field that does not
// exist (AL0132); n3 is the control that already refused.
const R331_N1_CU = `codeunit 50100 "Repro R331N"
{
    procedure Pick()
    var
        R: Record 50101;
        N: Integer;
    begin
        R.Validate(N, 5);
    end;
}
`;
const R331_N1_TAB = `#if X
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
#else
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
#endif
`;
const R331_N1_EXT = `tableextension 50102 "Repro Tab C2 Ext" extends "Repro Tab C2"
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
`;
const R331_N1W_CU = `codeunit 50100 "Repro R331N"
{
    procedure Pick()
    var
        R: Record 50101;
        N: Integer;
    begin
        R.Validate(N, 5);
    end;
}
`;
const R331_N1W_TAB = `#if X
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
#else
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
#endif
`;
const R331_N1W_EXT = `#if X
tableextension 50102 "Repro Tab C2 Ext" extends "Repro Tab C2"
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#else
tableextension 50102 "Repro Tab C2 Ext" extends "Repro Tab C2"
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#endif
`;
const R331_N2_CU = `codeunit 50100 "Repro R331N"
{
    procedure Pick()
    var
        R: Record "Repro Tab C2";
        N: Integer;
    begin
        R.Validate(N, 5);
    end;
}
`;
const R331_N2_TAB = `#if X
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
#else
table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
#endif
`;
const R331_N2_EXT = `tableextension 50102 "Repro Tab C2 Ext" extends 50101
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
`;
const R331_N3_CU = `codeunit 50100 "Repro R331N"
{
    procedure Pick()
    var
        R: Record 50101;
        N: Integer;
    begin
        R.Validate(N, 5);
    end;
}
`;
const R331_N3_TAB = `table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
`;
const R331_N3_EXT = `tableextension 50102 "Repro Tab C2 Ext" extends "Repro Tab C2"
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
`;
const R331_N4_CU = `codeunit 50100 "Repro R331N"
{
    procedure Pick()
    var
        R: Record "Repro Tab C2";
        N: Integer;
    begin
        R.Validate(N, 5);
    end;
}
`;
const R331_N4_TAB = `table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
`;
const R331_N4_EXT = `tableextension 50102 "Repro Tab C2 Ext" extends 50101
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
`;

describe("R331: the table's id and name are one table for rule 3", () => {
  beforeAll(async () => {
    await initParser();
  });
  const ops = async (files: Record<string, string>) =>
    (await instrument(files)).manifest.mutants.map((x) => x.operatorName).sort();
  const WANT = ["lethal.empty-block", "lethal.void-method-call"];
  test("n1: a numeric receiver of a #if-wrapped table extended by name", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_N1_CU,
        "Tab.Table.al": R331_N1_TAB,
        "TabExt.TableExt.al": R331_N1_EXT,
      }),
    ).toEqual(WANT);
  });
  test("n1w: the same with the extension wrapped in #if too", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_N1W_CU,
        "Tab.Table.al": R331_N1W_TAB,
        "TabExt.TableExt.al": R331_N1W_EXT,
      }),
    ).toEqual(WANT);
  });
  test("n2: a named receiver of a #if-wrapped table extended by number", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_N2_CU,
        "Tab.Table.al": R331_N2_TAB,
        "TabExt.TableExt.al": R331_N2_EXT,
      }),
    ).toEqual(WANT);
  });
  test("n3 (control): a numeric receiver of an indexed table extended by name", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_N3_CU,
        "Tab.Table.al": R331_N3_TAB,
        "TabExt.TableExt.al": R331_N3_EXT,
      }),
    ).toEqual(WANT);
  });
  test("n4: a named receiver of an indexed table extended by number", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_N4_CU,
        "Tab.Table.al": R331_N4_TAB,
        "TabExt.TableExt.al": R331_N4_EXT,
      }),
    ).toEqual(WANT);
  });
});

// R331 (run 005): the unparsed fallback reads any ERROR node, at any depth, by identifier token with
// comments stripped. Sources copied byte for byte from the scratch repros r331-u1 to u3; before the
// fix each emitted a `validate-to-assign` assigning a field that does not exist (AL0132).
const R331_U1_EXT = `tableextension 50102 "Repro Tab C2 Ext" extends 50101
{
    procedure /* note */ Validate(A: Integer; B: Integer)
    begin
    end;
}
`;
const R331_U2_EXT = `#if X
tableextension 50102 "Repro Tab C2 Ext" extends 50101
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#else
tableextension 50102 "Repro Tab C2 Ext" extends 50101
{
    procedure Validate(A: Integer; B: Integer)
    begin
    end;
}
#endif
`;
const R331_U3_EXT = `// an extension that extends its table by number
tableextension 50102 "Repro Tab C2 Ext" extends 50101
{
    procedure // the custom one
        Validate(A: Integer; B: Integer)
    begin
    end;
}
`;
const R331_U_CU = `codeunit 50100 "Repro R331N"
{
    procedure Pick()
    var
        R: Record "Repro Tab C2";
        N: Integer;
    begin
        R.Validate(N, 5);
    end;
}
`;
const R331_U_TAB = `table 50101 "Repro Tab C2"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
`;

describe("R331: the unparsed-object fallback is conservative", () => {
  beforeAll(async () => {
    await initParser();
  });
  const ops = async (files: Record<string, string>) =>
    (await instrument(files)).manifest.mutants.map((x) => x.operatorName).sort();
  const WANT = ["lethal.empty-block", "lethal.void-method-call"];
  test("u1: a block comment inside an unparsed extension's procedure header", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_U_CU,
        "Tab.Table.al": R331_U_TAB,
        "TabExt.TableExt.al": R331_U1_EXT,
      }),
    ).toEqual(WANT);
  });
  test("u2: an unparsed extension wrapped whole in #if", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_U_CU,
        "Tab.Table.al": R331_U_TAB,
        "TabExt.TableExt.al": R331_U2_EXT,
      }),
    ).toEqual(WANT);
  });
  test("u3: a line comment inside the header, and a leading comment line", async () => {
    expect(
      await ops({
        "Repro.Codeunit.al": R331_U_CU,
        "Tab.Table.al": R331_U_TAB,
        "TabExt.TableExt.al": R331_U3_EXT,
      }),
    ).toEqual(WANT);
  });
});

/** R318 repros, hand-written. `R318_R1`: a public renamed split member (lines 3-16) and `Plain`.
 *  `R318_R4`: two renamed members that share `Beta` across builds (lines 3-13 and 15-25). */
const R318_R1 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := 1;
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob + K);
    end;

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 3);
    end;

    var
        Glob: Integer;
}
`;
const R318_R4 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Alpha(X: Integer): Integer
#else
    procedure Beta(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K);
    end;

#if R318A
    procedure Beta(X: Integer): Integer
#else
    procedure Gamma(X: Integer): Integer
#endif
    var
        L: Integer;
    begin
        L := X + 2;
        exit(L);
    end;
}
`;
const R318_R3 = R318_R1.replace(
  "    procedure Plain(",
  "#if R318A\n    procedure Choose(T: Text): Integer\n    begin\n        exit(StrLen(T) + 1);\n    end;\n#endif\n\n    procedure Plain(",
);

describe("R318: a renamed split member carries its coverage names, and no identity key tuple moves", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("r1: the renamed member's mutants list both arm names; Plain's carry none", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R1 });
    const inMember = manifest.mutants.filter((m) => m.startLine >= 3 && m.startLine <= 16);
    expect(inMember).toHaveLength(10);
    for (const m of inMember) {
      expect(m.procedureName).toBe("");
      expect(m.coverageArmNames).toEqual(["Pick", "Choose"]);
    }
    for (const m of manifest.mutants.filter((x) => x.startLine > 16)) {
      expect(m.procedureName).toBe("Plain");
      expect("coverageArmNames" in m).toBe(false);
    }
  });

  test("r1: the arm names are computed once per member, not once per mutant", async () => {
    coverageArmNamesComputed.count = 0;
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R1 });
    expect(manifest.mutants.filter((m) => m.startLine <= 16).length).toBe(10);
    // The renamed member and Plain: two members, ten plus three mutants.
    expect(coverageArmNamesComputed.count).toBe(2);
  });

  test("r4: each member keeps only the name the other never uses", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R4 });
    const got = [...manifest.mutants]
      .sort((a, b) => a.startIndex - b.startIndex)
      .map((m) => `L${m.startLine} ${(m.coverageArmNames ?? []).join("/")}`);
    expect(got).toEqual([
      "L10 Alpha",
      "L11 Alpha",
      "L11 Alpha",
      "L12 Alpha",
      "L22 Gamma",
      "L23 Gamma",
      "L23 Gamma",
      "L24 Gamma",
    ]);
  });

  // The pre-commitment: exactly HEAD b6562aba's keys (identical to b184dd5d's), measured by the
  // R-318 plan's dry run. The renamed members stay in the "" group, so r4's second return-value
  // keeps ordinal 1.
  test("identity keys are HEAD's, byte for byte", async () => {
    const keysOf = async (src: string): Promise<string[]> => {
      const { manifest } = await instrument({ "Repro.Codeunit.al": src });
      return [...manifest.mutants]
        .sort((a, b) => a.startIndex - b.startIndex || a.mutantId.localeCompare(b.mutantId))
        .map((m) => serializeKey(identityKeyOf(m)));
    };
    expect(await keysOf(R318_R1)).toEqual([
      "1bdfa00ed4f9f5b66393ce5fa68726410673f75c945f991bd88595fd5bcc3bef|Repro R||lethal.empty-block|1",
      "8c55bdb8637a08951045fee707015dc789f78464ec2849c92df3f575da6ac6df|Repro R||lethal.remove-assignment|1",
      "bfde8a9e5399719cb19619ee057c24eedd9306fcf2d76c657c6b4a4378b24f00|Repro R||lethal.shift-integer|1",
      "42f3c401fde31149e055dfec5842326f020390b03c7018fe168a642644df6a58|Repro R||lethal.conditional-boundary|1",
      "833313f8bb3ff0f9a49296706144f2ae48dacc26d9ccab4a6105590536136497|Repro R||lethal.remove-assignment|1",
      "7b5887f1e890752bf8945f1c1173b9d1f3eba13794951eafea141f3006c040a1|Repro R||lethal.swap-additive|1",
      "2f655ef42c7141d41be438ef0a09db0588720672f6a87a7d107927722cfa2e29|Repro R||lethal.remove-assignment|1",
      "eef6d8e81fd4fed479dc4d361b5659773e7bc7701c4979e492d5698229e30863|Repro R||lethal.swap-additive|1",
      "c9159b460433d7e0187b40a3e9f1c6b24fa17f5d81145d1a4f5e81e464586890|Repro R||lethal.return-value|1",
      "78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89|Repro R||lethal.swap-additive|1",
      "d1f83cdca147307b5525047ab73ef3b96e89e7d274d898a8a0c3975ef32aa9ca|Repro R|Plain|lethal.empty-block|1",
      "cf8233fb4c95eb8f641cac7ecd90d8bfc2f40fd8ec1a247b4cc9bbbc601c6528|Repro R|Plain|lethal.return-value|1",
      "1c7f31c8ee6e40da96b0888e7c02e8a3484f8cf46ecf000ca6650d3453cfa251|Repro R|Plain|lethal.swap-additive|1",
    ]);
    expect(await keysOf(R318_R4)).toEqual([
      "13926bb4e72d79aead21ac9263d2735b6aacd45904fbe9b058371f9115262cb2|Repro R||lethal.empty-block|1",
      "833313f8bb3ff0f9a49296706144f2ae48dacc26d9ccab4a6105590536136497|Repro R||lethal.remove-assignment|1",
      "7b5887f1e890752bf8945f1c1173b9d1f3eba13794951eafea141f3006c040a1|Repro R||lethal.swap-additive|1",
      "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Repro R||lethal.return-value|1",
      "d25d06cde1e1a4a5557adb12f3773916f28b8e80b8c21b4a9f8a158463163c1e|Repro R||lethal.empty-block|1",
      "37276285a29d8c4a38baf6d602a495db9e97d227b9b18c9b00901b65b1d5e2ab|Repro R||lethal.remove-assignment|1",
      "eef6d8e81fd4fed479dc4d361b5659773e7bc7701c4979e492d5698229e30863|Repro R||lethal.swap-additive|1",
      "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Repro R||lethal.return-value|1|1",
    ]);
  });
  const R318_R10 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K); end; procedure Other(X: Integer): Integer begin exit(X + 7); end;

    procedure After(X: Integer): Integer
    begin
        exit(X + 5);
    end;
}
`;

  test("both line maps, from the EMITTED target, name a renamed member by its first coverage name", async () => {
    // Line-based sources place a line by position, so this holds in EVERY build, a dropped name
    // included. The boundaries are the `#if R318A` / `procedure Plain(` lines of the emitted text.
    const cases: [string, string, string[]][] = [
      ["r1", R318_R1, ["Pick", "Plain"]],
      ["r3", R318_R3, ["Pick", "Choose", "Plain"]],
      ["r4", R318_R4, ["Alpha", "Gamma"]],
    ];
    for (const [label, src, owners] of cases) {
      const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": src });
      const text = emitted.get("Repro.Codeunit.al") ?? "";
      const dir = await mkdtemp(join(tmpdir(), "lethal-r318-"));
      try {
        await writeFile(join(dir, "Repro.Codeunit.al"), text);
        const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
        const alr = await buildAlRunnerCoverageIndex(dir);
        expect(alr.refusedFiles).toEqual([]);
        const out = text.split("\n");
        const starts = out.flatMap((l, k) =>
          l.startsWith("#if R318A") || l.startsWith("    procedure Plain(") ? [k + 1] : [],
        );
        expect([label, starts.length]).toEqual([label, owners.length]);
        const ends = [...starts.slice(1), out.length + 1];
        let checked = 0;
        for (const [i, who] of owners.entries()) {
          const renamed = who !== "Choose" && who !== "Plain";
          // The compiled arm's name as the server would send it in build [] (measured): the member's
          // `#else` arm, or the member's own name for an ordinary procedure.
          const scope =
            label === "r4" ? (who === "Alpha" ? "Beta" : "Gamma") : renamed ? "Choose" : who;
          for (let n = starts[i] ?? 0; n < (ends[i] ?? 0); n++) {
            if (!(out[n - 1] ?? "").includes("MutationSelector.Active(")) continue;
            expect([label, n, bcdev.lookup("Codeunit", 50100, n)]).toEqual([label, n, who]);
            expect([label, n, alr.lineMap.lookup("Codeunit", 50100, n)]).toEqual([label, n, who]);
            expect([label, n, alr.lineMap.renamedMemberAt("Codeunit", 50100, n, scope)]).toEqual([
              label,
              n,
              renamed ? who : undefined,
            ]);
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(owners.length);
        for (const m of manifest.mutants) {
          const first = m.coverageArmNames?.[0];
          if (first !== undefined) expect(owners).toContain(first);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("a line two members share names nobody; the re-key needs the member's own arm name (R318, review r2)", async () => {
    // r10 as written: line 12 holds the renamed member's `exit(K); end;` AND all of `Other`. The
    // ORIGINAL text stands in for an emission in which `Other` got no mutant (operator narrowing),
    // which leaves that line exactly as written (measured, R-318 plan, emit-r10-ra).
    const dir = await mkdtemp(join(tmpdir(), "lethal-r318-shared-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), R318_R10);
      const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
      const alr = await buildAlRunnerCoverageIndex(dir);
      for (const map of [bcdev, alr.lineMap]) {
        expect([10, 11, 12, 16].map((n) => map.lookup("Codeunit", 50100, n))).toEqual([
          "Pick",
          "Pick",
          undefined, // shared: names nobody, NOT the first span (Pick) and not Other either
          "After",
        ]);
      }
      const at = (n: number, scope: string) =>
        alr.lineMap.renamedMemberAt("Codeunit", 50100, n, scope);
      expect(at(11, "Choose")).toBe("Pick"); // inside the member only, an own arm name: re-keyed
      expect(at(11, "PICK")).toBe("Pick"); // case-insensitive, as AL is
      expect(at(11, "Other")).toBeUndefined(); // not an own arm name: never re-keyed
      expect(at(12, "Choose")).toBeUndefined(); // shared line: never re-keyed
      expect(at(12, "Other")).toBeUndefined();
      expect(at(16, "After")).toBeUndefined(); // an ordinary member
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Ruling A: the shared-line count takes EVERY declaration span of the object, not only the named
  // procedures `lookup` can return. Two neighbours checked here: a procedure inside a `#if` wrapper
  // in the object body, and a trigger. Both repros parse with no ERROR node (asserted), so
  // `renamedMemberCoverageNames` gives the member its names.
  const sharedLineCase = async (
    src: string,
    lines: { member: number; shared: number; after: number },
  ): Promise<void> => {
    expect(wrapRoot(parseAL(src)).hasError).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), "lethal-r318-shared-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), src);
      const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
      const alr = await buildAlRunnerCoverageIndex(dir);
      expect(alr.refusedFiles).toEqual([]);
      for (const map of [bcdev, alr.lineMap]) {
        expect(
          [lines.member, lines.shared, lines.after].map((n) => map.lookup("Codeunit", 50100, n)),
        ).toEqual(["Pick", undefined, "After"]);
      }
      const at = (n: number, scope: string) =>
        alr.lineMap.renamedMemberAt("Codeunit", 50100, n, scope);
      expect(at(lines.member, "Choose")).toBe("Pick");
      expect(at(lines.shared, "Choose")).toBeUndefined();
      expect(at(lines.shared, "Pick")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  // A directive must start its line, so a wrapped procedure can share a line with the member only
  // inside the same wrapper: line 13 closes the member and holds all of `Wrapped`.
  const R318_WRAPPED = `codeunit 50100 "Repro R"
{
#if R318B
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K); end; procedure Wrapped(X: Integer): Integer begin exit(X + 7); end;
#endif

    procedure After(X: Integer): Integer
    begin
        exit(X + 5);
    end;
}
`;

  test("a line the renamed member shares with a #if-wrapped procedure names nobody (R318, ruling A)", async () => {
    await sharedLineCase(R318_WRAPPED, { member: 12, shared: 13, after: 18 });
  });

  test("a line the renamed member shares with a trigger names nobody (R318, ruling A)", async () => {
    // Line 12 closes the member and holds all of `OnRun`. A trigger is never named, so without
    // ruling A this line would go to the member.
    const src = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K); end; trigger OnRun() begin Glob := 7; end;

    procedure After(X: Integer): Integer
    begin
        exit(X + 5);
    end;

    var
        Glob: Integer;
}
`;
    await sharedLineCase(src, { member: 11, shared: 12, after: 16 });
  });
  test("an emission that re-parses with ERROR leaves a renamed member named on the line legs, as a plain member is (R318, review I1)", async () => {
    // `Other`'s nested `#if` inside a conditional var section parses in the original but not once
    // instrumented (grammar issue #30), so the EMITTED object has an ERROR node. A plain member in
    // that object stays named on both line legs (measured, review fix 1); the renamed member must
    // too, under the manifest's `coverageArmNames[0]`, since the server leg covers it by `st.scope`.
    const HEAD_R =
      "#if R318A\n    procedure Pick(X: Integer): Integer\n#else\n    procedure Choose(X: Integer): Integer\n#endif\n";
    const HEAD_P = "    procedure Pick(X: Integer): Integer\n";
    const body = (head: string): string => `codeunit 50100 "Repro R"
{
${head}    var
        K: Integer;
    begin
        K := X + 1;
        exit(K);
    end;

    procedure Other(X: Integer);
#if not CLEAN27
    var
        K: Integer;
#if A
        N: Integer;
#endif
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`;
    for (const [label, src, renamed] of [
      ["renamed", body(HEAD_R), true],
      ["plain", body(HEAD_P), false],
    ] as const) {
      expect([label, wrapRoot(parseAL(src)).hasError]).toEqual([label, false]);
      const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": src });
      const inMember = manifest.mutants.filter((m) => m.procedureName !== "Other");
      expect(inMember.length).toBeGreaterThan(0);
      for (const m of inMember) {
        expect([label, m.coverageArmNames?.[0] ?? m.procedureName]).toEqual([label, "Pick"]);
      }
      const text = emitted.get("Repro.Codeunit.al") ?? "";
      expect([label, wrapRoot(parseAL(text)).hasError]).toEqual([label, true]);
      const dir = await mkdtemp(join(tmpdir(), "lethal-r318-i1-"));
      try {
        await writeFile(join(dir, "Repro.Codeunit.al"), text);
        await writeFile(join(dir, "mutant-manifest.json"), JSON.stringify(manifest));
        const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
        const alr = await buildAlRunnerCoverageIndex(dir);
        expect(alr.refusedFiles).toEqual([]);
        const out = text.split("\n");
        const end = out.findIndex((l) => l.startsWith("    procedure Other("));
        let checked = 0;
        for (let n = 1; n <= end; n++) {
          if (!(out[n - 1] ?? "").includes("MutationSelector.Active(")) continue;
          for (const map of [bcdev, alr.lineMap]) {
            expect([label, n, map.lookup("Codeunit", 50100, n)]).toEqual([label, n, "Pick"]);
            expect([label, n, map.isNamingGap("Codeunit", 50100, n)]).toEqual([label, n, false]);
          }
          expect([label, n, alr.lineMap.renamedMemberAt("Codeunit", 50100, n, "Choose")]).toEqual([
            label,
            n,
            renamed ? "Pick" : undefined,
          ]);
          checked++;
        }
        expect([label, checked]).toEqual([label, inMember.length]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("a line the renamed member shares with a NAMELESS renamed member names nobody (R318, ruling A)", async () => {
    // The first member's arm names are both taken (`Pick(Text)`, `Choose(Text)`), so it has no
    // coverage name and no named span. Line 9 closes it and holds all of `Other`.
    const src = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    begin
        exit(X + 1); end; procedure Other(X: Integer): Integer begin exit(X + 7); end;

    procedure Pick(T: Text): Integer
    begin
        exit(StrLen(T));
    end;

    procedure Choose(T: Text): Integer
    begin
        exit(StrLen(T) + 1);
    end;
}
`;
    expect(wrapRoot(parseAL(src)).hasError).toBe(false);
    const m = await lineMapFromSources(
      [{ path: "Repro.Codeunit.al", text: src }],
      new Set(["codeunit:50100"]),
    );
    expect([8, 9, 13].map((n) => m.lookup("Codeunit", 50100, n))).toEqual([
      undefined, // the nameless member: never named
      undefined, // shared with it: not `Other`
      "Pick",
    ]);
  });

  test("a line the renamed member shares with a member swallowed by the global var section names nobody (R318, ruling A)", async () => {
    // Placed after the object's global `var` section, both members parse INSIDE it (R327). Line 12
    // closes the renamed member and holds all of `Other`.
    const src = `codeunit 50100 "Repro R"
{
    var
        Glob: Integer;

#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    begin
        Glob := X; end; procedure Other(X: Integer): Integer begin exit(X + 7); end;

    procedure After(X: Integer): Integer
    begin
        exit(X + 5);
    end;
}
`;
    expect(wrapRoot(parseAL(src)).hasError).toBe(false);
    const m = await lineMapFromSources(
      [{ path: "Repro.Codeunit.al", text: src }],
      new Set(["codeunit:50100"]),
    );
    expect([11, 12, 16].map((n) => m.lookup("Codeunit", 50100, n))).toEqual([
      "Pick",
      undefined,
      "After",
    ]);
    expect(m.renamedMemberAt("Codeunit", 50100, 11, "Choose")).toBe("Pick");
    expect(m.renamedMemberAt("Codeunit", 50100, 12, "Choose")).toBeUndefined();
  });

  /** One `--server` per-test coverage record: every statement hit once, in one file. */
  const serverRun = (
    index: Awaited<ReturnType<typeof buildAlRunnerCoverageIndex>>,
    test: string,
    statements: { scope?: string; line?: number }[],
    file = "Repro.Codeunit.al",
  ) =>
    alRunnerCoverageFromServer(
      { test, coverage: [{ file, statements: statements.map((st) => ({ ...st, hits: 1 })) }] },
      index,
    );
  const keyed = (map: ReturnType<typeof serverRun>): string[] =>
    map.entries.map((e) => `${e.procedure ?? "-"}@${e.line ?? "-"}`);

  test("--server: a renamed member's statements are re-keyed by position; others keep st.scope", async () => {
    // Scopes as MEASURED on al-runner 2.12.0 (R-318 plan, raw-r3 and raw-r8 logs): the compiled
    // arm's name, unquoted. In r3's build [] the member is compiled as `Choose`, a name its list
    // dropped because the #if-wrapped Choose(T) also carries it. The `Choose` statement on the
    // wrapped member's line cannot occur in that build (Choose(T) is not compiled there); it is
    // here to pin that a line outside any renamed span keeps st.scope, whatever it says.
    const { emitted } = await instrument({ "Repro.Codeunit.al": R318_R3 });
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    const dir = await mkdtemp(join(tmpdir(), "lethal-r318-srv-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), text);
      const index = await buildAlRunnerCoverageIndex(dir);
      const lines = text.split("\n");
      const at = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
      const member = at("Glob := Glob + 2;");
      const wrapped = at("exit(StrLen(T) + 1)");
      const plain = at("exit(X + 3)");
      expect([member, wrapped, plain].every((n) => n > 0)).toBe(true);
      renamedMemberAttempts.count = 0;
      const map = serverRun(index, "Codeunit50150.PickFive", [
        { scope: "Choose", line: member },
        // A scope the member does not declare, on the member's own line: by the producer's account
        // some other member's statement, so never re-keyed (review M2).
        { scope: "Plain", line: member },
        { scope: "Choose", line: wrapped },
        { scope: "Plain", line: plain },
        { scope: "Choose Me" },
      ]);
      expect(keyed(map)).toEqual([
        `Pick@${member}`,
        `Plain@${member}`,
        `Choose@${wrapped}`,
        `Plain@${plain}`,
        "Choose Me@-",
      ]);
      // Keeps the large-object pin below honest: an object WITH a renamed member is searched once
      // per statement that carries a line.
      expect(renamedMemberAttempts.count).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--server: a line the renamed member shares with a #if-wrapped procedure is never re-keyed (R318, ruling A)", async () => {
    // Line 12 is the member's alone; line 13 closes it and holds all of `Wrapped`. A `Choose`
    // statement on line 13 carries the member's own arm name, and still keeps the producer's scope.
    expect(wrapRoot(parseAL(R318_WRAPPED)).hasError).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), "lethal-r318-srv-wrapped-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), R318_WRAPPED);
      const index = await buildAlRunnerCoverageIndex(dir);
      expect(index.refusedFiles).toEqual([]);
      const map = serverRun(index, "Codeunit50150.T", [
        { scope: "Choose", line: 12 },
        { scope: "Choose", line: 13 },
        { scope: "Wrapped", line: 13 },
        { scope: "After", line: 18 },
      ]);
      expect(keyed(map)).toEqual(["Pick@12", "Choose@13", "Wrapped@13", "After@18"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a shared line: OtherOnly never covers the renamed member, on either al-runner path (review r2)", async () => {
    // The producer rows below are r10's MEASURED rows (R-318 plan, raw-r10-shared-line.log, build
    // [] and [R318A] alike apart from the member's scope): MemberOnly hits 11 and 12, OtherOnly
    // hits 12 with scope Other, AfterOnly hits 16. The manifest is r10's, instrumented in full; the
    // lookup reads names, not lines, so it pairs with the original text's index.
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R10 });
    const dir = await mkdtemp(join(tmpdir(), "lethal-r318-own-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), R318_R10);
      const index = await buildAlRunnerCoverageIndex(dir);
      const ref = (method: string) => ({ codeunitId: 50150, codeunitName: "Repro Tests", method });
      const [memberOnly, otherOnly, afterOnly] = [
        ref("MemberOnly"),
        ref("OtherOnly"),
        ref("AfterOnly"),
      ];
      const server = (scope: string) => [
        {
          ref: memberOnly,
          coverage: serverRun(index, "Codeunit50150.MemberOnly", [
            { scope, line: 11 },
            { scope, line: 12 },
          ]),
        },
        {
          ref: otherOnly,
          coverage: serverRun(index, "Codeunit50150.OtherOnly", [{ scope: "Other", line: 12 }]),
        },
        {
          ref: afterOnly,
          coverage: serverRun(index, "Codeunit50150.AfterOnly", [{ scope: "After", line: 16 }]),
        },
      ];
      const cobertura = [
        { ref: memberOnly, lines: [11, 12] },
        { ref: otherOnly, lines: [12] },
        { ref: afterOnly, lines: [16] },
      ].map(({ ref: r, lines }) => ({
        ref: r,
        coverage: alRunnerCoverageFrom(
          lines.map((line) => ({ file: "Repro.Codeunit.al", line, hits: 1 })),
          index,
        ),
      }));
      const covering = (runs: ReturnType<typeof server>) => {
        const split = coverageFilter(
          manifest.mutants,
          buildCoverageIndex(runs),
          [memberOnly, otherOnly, afterOnly],
          undefined,
          false,
        );
        return manifest.mutants
          .map(
            (m) =>
              `L${m.startLine} ${(split.covered.get(m.mutantId) ?? []).map((t) => t.method).join(",") || "-"}`,
          )
          .sort();
      };
      // BOTH members' covering lists, pinned. The member (lines 10-12): MemberOnly only, never
      // OtherOnly. Other (line 12): OtherOnly on the server path, which keeps the producer's own
      // scope on a shared line; NO test on the line-only path, which cannot tell the two apart
      // (the stated cost of "names nobody").
      const memberAndOther = [
        "L10 MemberOnly",
        "L11 MemberOnly",
        "L11 MemberOnly",
        "L12 MemberOnly",
      ];
      for (const scope of ["Choose", "Pick"]) {
        expect([scope, covering(server(scope))]).toEqual([
          scope,
          [
            ...memberAndOther,
            "L12 OtherOnly",
            "L12 OtherOnly",
            "L12 OtherOnly",
            "L15 AfterOnly",
            "L16 AfterOnly",
            "L16 AfterOnly",
          ].sort(),
        ]);
      }
      expect(covering(cobertura)).toEqual(
        [
          ...memberAndOther,
          "L12 -",
          "L12 -",
          "L12 -",
          "L15 AfterOnly",
          "L16 AfterOnly",
          "L16 AfterOnly",
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a large ordinary object keeps every st.scope (no renamed member: the re-key exits at once)", async () => {
    // Cost pin (review r2, I4; pre-flight P8): 2,000 procedures, 200,000 positive statements, no
    // renamed member. Correctness is asserted, and so is the cost, by a counter rather than a
    // clock: an object with no renamed member never reaches the span search.
    const procs = Array.from(
      { length: 2000 },
      (_, i) =>
        `    procedure P${i}(X: Integer): Integer\n    begin\n        exit(X + ${i});\n    end;\n`,
    ).join("\n");
    const dir = await mkdtemp(join(tmpdir(), "lethal-r318-big-"));
    try {
      await writeFile(join(dir, "Big.Codeunit.al"), `codeunit 50100 "Big"\n{\n${procs}}\n`);
      const index = await buildAlRunnerCoverageIndex(dir);
      // `procedure P<i>` is on line 3 + 5i, its `exit` on 5 + 5i.
      const statements = Array.from({ length: 200_000 }, (_, k) => ({
        scope: `P${k % 2000}`,
        line: 5 + (k % 2000) * 5,
      }));
      renamedMemberAttempts.count = 0;
      const map = serverRun(index, "Codeunit50150.All", statements, "Big.Codeunit.al");
      expect(map.entries).toHaveLength(2000); // deduplicated by (procedure, line)
      expect(map.entries.every((e) => e.procedure === `P${((e.line ?? 0) - 5) / 5}`)).toBe(true);
      expect(renamedMemberAttempts.count).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** R351: a report from manifest entries and their verdicts, events built as report.test.ts does. */
function r351Report(
  rows: ReadonlyArray<readonly [MutantManifestEntry, "survived" | "no-coverage"]>,
) {
  const events: RunEventInput[] = [
    {
      type: "mutation-set-generated",
      siteCount: rows.length,
      deployedCount: rows.length,
      hangCapableCount: 0,
      totalFiles: 1,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      excludedByOnly: 0,
      excludedByExclude: 0,
      excludedByOperator: 0,
    },
    { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
    ...rows.map(
      ([mutant, verdict]): RunEventInput => ({
        type: "mutant-scored",
        mutant,
        verdict,
        batchIndex: 0,
        durationMs: 10,
        coveringTests: [],
        ...(verdict === "survived" ? { coverageAttribution: "exact" as const } : {}),
      }),
    ),
    { type: "session-finished", elapsedMs: 10 },
  ];
  return buildReport(
    { caps: { authoritative: true, coverage: "none", deploy: "publish", isolation: "session" } },
    events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent),
  );
}

describe("R351: a renamed split member is named by its arm names in the order, the report and explain; no fixture key moves", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("T4 r4: a kill in Alpha puts its killer first for Alpha only, never for Gamma", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R4 });
    const alpha = manifest.mutants.filter((m) => m.coverageArmNames?.[0] === "Alpha");
    const gamma = manifest.mutants.find((m) => m.coverageArmNames?.[0] === "Gamma");
    const [killed, next] = alpha;
    if (killed === undefined || next === undefined || gamma === undefined) {
      throw new Error("r4 lost a member's mutants");
    }
    const ref = (method: string): TestMethodRef => ({
      codeunitId: 50140,
      codeunitName: "Repro Tests",
      method,
    });
    const A = ref("A");
    const B = ref("B");
    const ledger = newKillLedger();
    recordKill(ledger, killed, B);
    const order = (m: MutantManifestEntry) =>
      orderCoveringTests([A, B], m, ledger, new Map()).map((r) => r.method);
    expect(order(next)).toEqual(["B", "A"]);
    expect(order(gamma)).toEqual(["A", "B"]);
    // D8: the ordering key is not the identity. Both members keep "" in the key's name segment.
    for (const m of [killed, next, gamma]) {
      expect(serializeKey(identityKeyOf(m)).split("|")[2]).toBe("");
    }
  });

  test("T1 r1: the member's row carries its arm names, Plain's row has no such key", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R1 });
    const member = manifest.mutants.find((m) => m.coverageArmNames !== undefined);
    const plain = manifest.mutants.find((m) => m.procedureName === "Plain");
    if (member === undefined || plain === undefined) throw new Error("r1 lost a member");
    const report = r351Report([
      [member, "survived"],
      [plain, "survived"],
    ]);
    const row = (id: string) => report.mutants.find((r) => r.mutantCode === id);
    expect(row(member.mutantId)?.coverageArmNames).toEqual(["Pick", "Choose"]);
    expect(row(plain.mutantId)).toBeDefined();
    expect("coverageArmNames" in (row(plain.mutantId) ?? {})).toBe(false);
  });

  test("T2 r4: two renamed members survive as two groups, each named on the console", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R4 });
    const alpha = manifest.mutants.find((m) => m.coverageArmNames?.[0] === "Alpha");
    const gamma = manifest.mutants.find((m) => m.coverageArmNames?.[0] === "Gamma");
    if (alpha === undefined || gamma === undefined) throw new Error("r4 lost a member");
    const report = r351Report([
      [alpha, "survived"],
      [gamma, "survived"],
    ]);
    expect(
      report.survivorsByProcedure.map((g) => [g.procedureName, g.coverageArmNames, g.survived]),
    ).toEqual([
      ["", ["Alpha"], 1],
      ["", ["Gamma"], 1],
    ]);
    const out = renderConsole(report);
    expect(out).toContain("Repro R.Alpha");
    expect(out).toContain("Repro R.Gamma");
    expect(out).not.toContain("<object>");
  });

  test("T3 r4: explain names each member on its survivors and its no-coverage block", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R4 });
    const alpha = manifest.mutants.find((m) => m.coverageArmNames?.[0] === "Alpha");
    const gammas = manifest.mutants.filter((m) => m.coverageArmNames?.[0] === "Gamma");
    const [gamma, gammaUncovered] = gammas;
    if (alpha === undefined || gamma === undefined || gammaUncovered === undefined) {
      throw new Error("r4 lost a member");
    }
    const out = explain(
      r351Report([
        [alpha, "survived"],
        [gamma, "survived"],
        [gammaUncovered, "no-coverage"],
      ]),
    );
    expect(out.survivors.map((s) => [s.mutantCode, s.procedureName, s.coverageArmNames])).toEqual([
      [alpha.mutantId, "", ["Alpha"]],
      [gamma.mutantId, "", ["Gamma"]],
    ]);
    expect(
      (out.noCoverageBlocks ?? []).map((b) => [b.members, b.procedureName, b.coverageArmNames]),
    ).toEqual([[[gammaUncovered.mutantId], "", ["Gamma"]]]);
  });

  // D7: coverageArmNames is positional and independent of preprocessor symbols, and R318's census
  // found no renamed member in the fixtures. So every fixture mutant's derived group name, and so
  // its kill-ledger scope, is exactly the pre-R351 string: no order, and no killingTest, can move.
  const CENSUS: Record<string, { selectorId: number; controlId: number; tableId: number }> = {
    "sandbox-app": { selectorId: 79199, controlId: 79198, tableId: 79197 },
    "sandbox-data": { selectorId: 79399, controlId: 79398, tableId: 79397 },
    "sandbox-hang": { selectorId: 79449, controlId: 79448, tableId: 79447 },
    "sandbox-symbols": { selectorId: 79649, controlId: 79648, tableId: 79647 },
  };
  for (const [fixture, selectorIds] of Object.entries(CENSUS)) {
    test(`T5 ${fixture}: every mutant's group name and ledger scope are the pre-R351 ones`, async () => {
      const out = await mkdtemp(join(tmpdir(), "lethal-r351-census-"));
      try {
        const set = await generateMutationSet(join(import.meta.dir, "../../../fixtures", fixture));
        await writeInstrumentedProject({
          targetDir: out,
          files: set.files,
          selectorIds,
          artifactId: "0123456789abcdef0123456789abcdef",
          targetAppId: "00000000-0000-0000-0000-000000000000",
          operatorTiers,
        });
        const manifest = JSON.parse(
          await readFile(join(out, "mutant-manifest.json"), "utf8"),
        ) as MutantManifest;
        expect(manifest.mutants.length).toBeGreaterThan(0);
        const moved = manifest.mutants
          .filter((m) => {
            const before = m.procedureName || m.triggerName || "";
            return (
              memberGroupNameOf(m) !== before ||
              procedureScopeOf(m) !== `${m.codeunitName}|${before}`
            );
          })
          .map((m) => `${m.file}:${m.startLine} ${m.operatorName}`);
        expect(moved).toEqual([]);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    });
  }
});
