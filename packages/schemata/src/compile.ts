import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { ALNodeKind, findFirst, printWithRewrites } from "@lethal/engine";
import { buildComponents } from "./components";
import { emitDispatch } from "./dispatch";
import { type IdedSpec, assignMutantIds } from "./ids";

export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
  ided?: readonly IdedSpec[],
): string {
  // Mutant ids must be allocated exactly once, artifact-wide (see
  // `writeInstrumentedProject`), so multi-file callers pass their
  // pre-assigned ids in verbatim. Only single-file callers (tests, or
  // callers that genuinely have just one file) fall back to allocating
  // ids locally here.
  const resolvedIded = ided ?? assignMutantIds(new Map([["<file>", specs]])).get("<file>") ?? [];

  // Emission is a FLAT dispatch chain per containment component, never nested
  // guards: only one mutant is ever active, so mutants that overlap are siblings
  // in one if/else-if chain. Nesting wraps is what produced 2^depth growth.
  // lift.ts/duplicate.ts are intentionally no longer routed to — see the design
  // spec §4: hoisting into a temp breaks AL evaluation order, cannot be typed
  // reliably, and is unsafe around ternaries and `var` parameters.
  const components = buildComponents(resolvedIded);
  const rewrites = new Map<ALSyntaxNode, string>();
  for (const component of components) {
    rewrites.set(component.root, wrapIfBodyBlock(component.root, emitDispatch(component)));
  }

  // Every dispatch chain above emits a bare
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

/**
 * `findEnclosingStatement` (packages/engine) treats a `code_block` whose
 * parent is a procedure/trigger/branch as itself the "enclosing statement"
 * — this is the only way a containment component's `root` can come back as
 * an `ALNodeKind.block` (only `empty-block` ever resolves a spec's `before`
 * to a block node). `emitDispatch` emits a bare `if ... then ... else ...;`
 * construct, which is a valid REPLACEMENT for an ordinary statement position
 * — an `if`/`while`/`for`/`repeat`/`case` branch accepts a single bare
 * statement in place of a `begin...end` block. A **procedure or trigger
 * body**, however, must literally be a `code_block` (`begin ... end`) —
 * verified against the real AL compiler, which rejects a bare `if` as a
 * procedure body with AL0104/AL0198. Since wrapping in `begin...end` is
 * always valid wherever a bare statement was also valid, re-wrap
 * unconditionally instead of special-casing by the block's parent kind.
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
