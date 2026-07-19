import type { ALSyntaxNode, MutationSpec, SemanticContext } from "@lethal/engine";
import {
  ALNodeKind,
  buildSemanticContext,
  findEnclosingCodeBlock,
  findEnclosingProcedure,
  findFirst,
  printWithRewrites,
} from "@lethal/engine";
import { duplicateEnclosing } from "./duplicate";
import { resolveSite } from "./enclosing";
import { assignMutantIds, type IdedSpec } from "./ids";
import { liftExpression } from "./lift";
import { wrapStatement } from "./wrap";

export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
  ided?: readonly IdedSpec[],
): string {
  // Semantic context is built lazily for type inference in lift. When no lift
  // is present it's unused and costs one empty-symbol-table build.
  const ctx = buildSemanticContext([{ path: "<file>", root }]);
  // Mutant ids must be allocated exactly once, artifact-wide (see
  // `writeInstrumentedProject`), so multi-file callers pass their
  // pre-assigned ids in verbatim. Only single-file callers (tests, or
  // callers that genuinely have just one file) fall back to allocating
  // ids locally here.
  const resolvedIded = ided ?? assignMutantIds(new Map([["<file>", specs]])).get("<file>") ?? [];

  const rewrites = new Map<ALSyntaxNode, string>();
  const codeBlockInserts = new Map<ALSyntaxNode, string[]>();
  const procedureInjects = new Map<ALSyntaxNode, string[]>();
  const blockExprRewrites = new Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>();

  for (const entry of resolvedIded) {
    dispatch(entry, ctx, rewrites, codeBlockInserts, procedureInjects, blockExprRewrites);
  }

  commitLiftRewrites(rewrites, codeBlockInserts, procedureInjects, blockExprRewrites);

  // Every wrap/duplicate/lift composition above emits a bare
  // `MutationSelector.Active(...)` call — verified against a real AL
  // compiler: AL has no implicit access to a codeunit by object name, so
  // without a `var MutationSelector: Codeunit "Mutation Selector";`
  // declaration in scope, every guard site fails with AL0118 ("The name
  // 'MutationSelector' does not exist in the current context"). Inject one
  // declaration per codeunit that actually has a mutation in it.
  if (specs.length > 0) injectMutationSelectorVar(root, rewrites);

  return printWithRewrites(source, root, rewrites);
}

/** Raw grammar kinds of a `codeunit_declaration`'s three header tokens. */
const CODEUNIT_HEADER_KINDS: ReadonlySet<string> = new Set([
  "codeunit_keyword",
  ALNodeKind.integer_literal,
  "quoted_identifier",
  ALNodeKind.identifier,
]);

/**
 * Insert `var MutationSelector: Codeunit "Mutation Selector";` into the
 * file's codeunit — reusing its existing `var_section` if present, or
 * inserting a fresh one right before the first member (field/procedure)
 * otherwise. A zero-width edit (`start === end`) anchored on the first
 * member's own start index is used for the "no existing var_section" case:
 * `printWithRewrites` keys rewrites by node identity and applies each as
 * `[start, end)`, so a synthetic node with `start === end === firstMember.
 * startIndex` inserts text there without consuming (or conflicting with)
 * any other rewrite targeting the first member's own contents.
 */
function injectMutationSelectorVar(root: ALSyntaxNode, rewrites: Map<ALSyntaxNode, string>): void {
  const codeunit = findFirst(root, ALNodeKind.codeunit);
  if (codeunit === null) return; // not a codeunit object — no guard call is ever emitted there

  const existingVar = codeunit.namedChildren.find((c) => c.kind === ALNodeKind.var_section);
  if (existingVar !== undefined) {
    if (rewrites.has(existingVar)) {
      throw new Error(
        "compileSchemataForFile: codeunit var_section already targeted by another rewrite",
      );
    }
    rewrites.set(
      existingVar,
      `${existingVar.text.replace(/\s+$/, "")}\n        MutationSelector: Codeunit "Mutation Selector";`,
    );
    return;
  }

  const firstMember = codeunit.namedChildren.find((c) => !CODEUNIT_HEADER_KINDS.has(c.kind));
  if (firstMember === undefined) return; // header-only codeunit (no members) — nothing to guard

  const insertionPoint: ALSyntaxNode = {
    kind: firstMember.kind,
    rawKind: firstMember.rawKind,
    text: "",
    startIndex: firstMember.startIndex,
    endIndex: firstMember.startIndex,
    startPosition: firstMember.startPosition,
    endPosition: firstMember.startPosition,
    parent: firstMember.parent,
    children: [],
    namedChildren: [],
    fieldName: null,
    childForFieldName: () => null,
  };
  rewrites.set(
    insertionPoint,
    `    var\n        MutationSelector: Codeunit "Mutation Selector";\n\n`,
  );
}

function dispatch(
  entry: IdedSpec,
  ctx: SemanticContext,
  rewrites: Map<ALSyntaxNode, string>,
  codeBlockInserts: Map<ALSyntaxNode, string[]>,
  procedureInjects: Map<ALSyntaxNode, string[]>,
  blockExprRewrites: Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>,
): void {
  const { mutantId, spec } = entry;
  if (spec.parentContext === "statement-position") {
    applyWrap(mutantId, spec, rewrites);
    return;
  }
  if (spec.parentContext === "expression-position") {
    applyLift(mutantId, spec, ctx, codeBlockInserts, procedureInjects, blockExprRewrites);
    return;
  }
  if (spec.parentContext === "short-circuit-operand") {
    applyDuplicate(mutantId, spec, rewrites);
    return;
  }
  throw new Error(
    `compileSchemataForFile: unknown parentContext "${spec.parentContext}"`,
  );
}

function applyWrap(
  mutantId: string,
  spec: MutationSpec,
  rewrites: Map<ALSyntaxNode, string>,
): void {
  const afterText = (spec.after as unknown as { text?: string }).text ?? "";
  const site = resolveSite(spec.before, afterText);
  const replacement =
    afterText === ""
      ? wrapStatement({ mutantId, original: site.statement, replacement: null })
      : wrapStatement({
          mutantId,
          original: site.statement,
          replacement: site.mutatedText,
        });
  assertNoDuplicateRewrite(rewrites, site.statement);
  rewrites.set(site.statement, wrapIfBodyBlock(site.statement, replacement));
}

/**
 * `findEnclosingStatement` (packages/engine) treats a `code_block` whose
 * parent is a procedure/trigger/branch as itself the "enclosing statement"
 * — this is the only way `resolveSite`'s `site.statement` can come back as
 * an `ALNodeKind.block` (only `empty-block` ever sets `before` to a block
 * node). `wrapStatement`/`duplicateEnclosing` both emit a bare
 * `if ... then ... else ...;` construct, which is a valid REPLACEMENT for
 * an ordinary statement position — an `if`/`while`/`for`/`repeat`/`case`
 * branch accepts a single bare statement in place of a `begin...end` block.
 * A **procedure or trigger body**, however, must literally be a
 * `code_block` (`begin ... end`) — verified against the real AL compiler,
 * which rejects a bare `if` as a procedure body with AL0104/AL0198. Since
 * wrapping in `begin...end` is always valid wherever a bare statement was
 * also valid, re-wrap unconditionally instead of special-casing by the
 * block's parent kind.
 *
 * The `block` node's own range includes its trailing `;` (verified: for
 * `begin ... end;`, `block.text` ends in `"end;"`, not `"end"` — the `;` is
 * not a sibling token of the enclosing procedure/trigger/branch). Since the
 * printer replaces exactly `[statement.startIndex, statement.endIndex)`,
 * the replacement must reproduce that trailing `;` itself.
 */
function wrapIfBodyBlock(statement: ALSyntaxNode, text: string): string {
  if (statement.kind !== ALNodeKind.block) return text;
  return `begin\n${text}\nend;`;
}

function applyLift(
  mutantId: string,
  spec: MutationSpec,
  ctx: SemanticContext,
  codeBlockInserts: Map<ALSyntaxNode, string[]>,
  procedureInjects: Map<ALSyntaxNode, string[]>,
  blockExprRewrites: Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>,
): void {
  const enclosingBlock = findEnclosingCodeBlock(spec.before);
  const enclosingProc = findEnclosingProcedure(spec.before);
  if (enclosingBlock === null || enclosingProc === null) {
    throw new Error(
      `compileSchemataForFile: lift target at ${spec.before.startIndex} has no enclosing procedure/block`,
    );
  }
  const inferredType = ctx.types.typeOf(spec.before) ?? "Variant";
  const afterText = (spec.after as unknown as { text?: string }).text ?? "";
  const artifacts = liftExpression({
    mutantId,
    original: spec.before,
    replacementSource: afterText,
    inferredType,
  });

  // Fold the expression-level rewrite into the block-level rewrite rather
  // than registering a separate printer edit — the two would overlap.
  pushExprRewrite(blockExprRewrites, enclosingBlock, spec.before, artifacts.replacementReference);
  pushMulti(codeBlockInserts, enclosingBlock, artifacts.conditionalAssign);
  pushMulti(procedureInjects, enclosingProc, artifacts.varDeclaration);
}

function applyDuplicate(
  mutantId: string,
  spec: MutationSpec,
  rewrites: Map<ALSyntaxNode, string>,
): void {
  const afterText = (spec.after as unknown as { text?: string }).text ?? "";
  const site = resolveSite(spec.before, afterText);
  assertNoDuplicateRewrite(rewrites, site.statement);
  const duplicated = duplicateEnclosing({
    mutantId,
    enclosingStatement: site.statement,
    mutatedStatement: site.mutatedText,
  });
  rewrites.set(site.statement, wrapIfBodyBlock(site.statement, duplicated));
}

function pushMulti<K>(m: Map<K, string[]>, k: K, v: string): void {
  const existing = m.get(k);
  if (existing === undefined) m.set(k, [v]);
  else existing.push(v);
}

function pushExprRewrite(
  m: Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>,
  block: ALSyntaxNode,
  node: ALSyntaxNode,
  text: string,
): void {
  const existing = m.get(block);
  if (existing === undefined) m.set(block, [{ node, text }]);
  else existing.push({ node, text });
}

/**
 * Commit all lift-derived edits to `rewrites` in one coordinated pass.
 *
 * A procedure without an existing `var_section` needs its `var` block created
 * *before* its body `code_block`. The same body may also need a prelude
 * conditional-assign inserted after `begin`. Both edits land on the same
 * body node — so we merge them into one rewrite per block to avoid the
 * printer's no-overlap invariant.
 */
function commitLiftRewrites(
  rewrites: Map<ALSyntaxNode, string>,
  codeBlockInserts: ReadonlyMap<ALSyntaxNode, readonly string[]>,
  procedureInjects: ReadonlyMap<ALSyntaxNode, readonly string[]>,
  blockExprRewrites: ReadonlyMap<ALSyntaxNode, ReadonlyArray<{ node: ALSyntaxNode; text: string }>>,
): void {
  // Wrapper nodes produced by `.namedChildren` are fresh objects on every
  // access, so object identity is unreliable — a body block found via
  // `findEnclosingCodeBlock` will be a different wrapper than the one
  // found via `proc.namedChildren.find`, yet refer to the same tree-sitter
  // node. Key everything by startIndex..endIndex to dedupe.
  const blockKey = (n: ALSyntaxNode): string => `${n.startIndex}..${n.endIndex}`;
  const blockByKey = new Map<string, ALSyntaxNode>();
  const insertsByKey = new Map<string, readonly string[]>();
  const exprEditsByKey = new Map<string, ReadonlyArray<{ node: ALSyntaxNode; text: string }>>();
  for (const [b, v] of codeBlockInserts) {
    const k = blockKey(b);
    blockByKey.set(k, b);
    insertsByKey.set(k, v);
  }
  for (const [b, v] of blockExprRewrites) {
    const k = blockKey(b);
    blockByKey.set(k, b);
    exprEditsByKey.set(k, v);
  }

  // Step 1: resolve each procedure's var-declaration target.
  const bodyVarPreludes = new Map<string, readonly string[]>();
  for (const [proc, decls] of procedureInjects) {
    const existingVar = proc.namedChildren.find(
      (c) => c.kind === ALNodeKind.var_section,
    );
    if (existingVar !== undefined) {
      if (rewrites.has(existingVar)) {
        throw new Error("var_section already targeted by another rewrite");
      }
      const declText = decls.map((d) => `        ${d}`).join("\n");
      rewrites.set(
        existingVar,
        `${existingVar.text.replace(/\s+$/, "")}\n${declText}`,
      );
      continue;
    }
    const body = proc.namedChildren.find((c) => c.kind === ALNodeKind.block);
    if (body === undefined) {
      throw new Error("procedure has no code_block body — cannot inject var_section");
    }
    const k = blockKey(body);
    bodyVarPreludes.set(k, decls);
    if (!blockByKey.has(k)) blockByKey.set(k, body);
  }

  // Step 2: rewrite each code_block that needs prelude inserts, inner
  // expression rewrites, and/or a prepended var_section. One unified
  // rewrite per block.
  for (const [k, block] of blockByKey) {
    if (rewrites.has(block)) {
      throw new Error(
        "compileSchemataForFile: a code_block is both a lift host and a direct rewrite target — not supported in Layer 3",
      );
    }
    // Apply inner expression rewrites to the block's text first. Edits are
    // sorted by startIndex (descending) so each splice's remaining offsets
    // stay valid as we go.
    const exprEdits = (exprEditsByKey.get(k) ?? [])
      .slice()
      .sort((a, b) => b.node.startIndex - a.node.startIndex);
    let blockText = block.text;
    for (const e of exprEdits) {
      const relStart = e.node.startIndex - block.startIndex;
      const relEnd = e.node.endIndex - block.startIndex;
      if (relStart < 0 || relEnd > blockText.length) {
        throw new Error(
          `commitLiftRewrites: expression at ${e.node.startIndex}..${e.node.endIndex} outside block ${block.startIndex}..${block.endIndex}`,
        );
      }
      blockText = blockText.slice(0, relStart) + e.text + blockText.slice(relEnd);
    }

    const preludes = insertsByKey.get(k) ?? [];
    let blockReplacement: string;
    if (preludes.length > 0) {
      const indent = detectIndent(block.text);
      const joined = preludes
        .map((p) => indentMultiline(p, indent))
        .join("\n");
      const body = stripBeginEnd(blockText);
      blockReplacement = `begin\n${joined}\n${body}\nend`;
    } else {
      blockReplacement = blockText;
    }
    const varDecls = bodyVarPreludes.get(k);
    if (varDecls !== undefined) {
      const declText = varDecls.map((d) => `        ${d}`).join("\n");
      rewrites.set(block, `var\n${declText}\n    ${blockReplacement}`);
    } else {
      rewrites.set(block, blockReplacement);
    }
  }
}

function detectIndent(blockText: string): string {
  const lines = blockText.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed === "end" || trimmed.startsWith("end")) continue;
    const lead = line.slice(0, line.length - trimmed.length);
    if (lead.length > 0) return lead;
  }
  return "  ";
}

function indentMultiline(s: string, indent: string): string {
  return s
    .split("\n")
    .map((ln) => (ln.length === 0 ? ln : `${indent}${ln}`))
    .join("\n");
}

function stripBeginEnd(blockText: string): string {
  const trimmed = blockText.trim();
  const withoutBegin = trimmed.replace(/^begin\b\s*/, "");
  const withoutEnd = withoutBegin.replace(/\s*end\s*$/, "");
  return withoutEnd;
}

function assertNoDuplicateRewrite(
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
  node: ALSyntaxNode,
): void {
  if (rewrites.has(node)) {
    throw new Error(
      `compileSchemataForFile: two specs resolved to the same AST node at ${node.startIndex}..${node.endIndex}`,
    );
  }
}
