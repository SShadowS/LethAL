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
    rewrites.set(
      component.root,
      wrapIfSingleStatementSlot(component.root, emitDispatch(component)),
    );
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
 * A component's dispatch chain must be wrapped in `begin ... end` whenever
 * `statement` is not already a plain member of an existing `begin ... end`
 * — `emitDispatch`'s chain is itself shaped like a complete, self-terminating
 * `if ... then ... else ...;`, and splicing that in unwrapped is unsafe in
 * two positions:
 *
 * - **`statement.kind === ALNodeKind.block`** — `findEnclosingStatement`
 *   (packages/engine) treats a `code_block` whose parent is a
 *   procedure/trigger/branch as itself the "enclosing statement". That
 *   parent isn't always a procedure/trigger: `packages/builtin-tier1`'s
 *   `empty-block` operator also targets a block that is the bare body of an
 *   `if`/`while`/`for`/`repeat`/`case` branch (no separate begin/end of its
 *   own containing THIS block — the block itself IS that branch's body). A
 *   procedure/trigger body must literally be a `code_block` — verified
 *   against the real AL compiler, which rejects a bare `if` as a procedure
 *   body with AL0104/AL0198 — so this case always needs the wrap.
 *
 * - **`statement.parent` is not a `code_block`** — the root sits in a bare
 *   BRANCH position instead: the single then/else statement of an `if`, or
 *   the single body of a `while`/`for`/`repeat`/`case`, with no surrounding
 *   `begin ... end` of its own (e.g. `if X then Y := 1 else Y := 2;` —
 *   `Y := 1`'s parent is the `if_statement`, not a block).
 *
 * In BOTH cases, splicing the chain in unwrapped embeds a complete nested
 * `if ... then ... else ...;` directly as that branch: if its own trailing
 * `;` survives, it closes the OUTER `if` before the outer `else` is reached
 * — AL0110 "Orphaned ELSE statement" (the exact failure the `begin...end`
 * wrap around EVERY branch inside `emitDispatch`/`wrapStatement` already
 * defends against one level down) — and even with no following `else`, an
 * unwrapped chain is itself an `if`, so a dangling-else ambiguity exists
 * regardless of what follows. This bug pre-dates flat-dispatch coalescing:
 * the old `applyWrap` path had the identical exposure for statement-position
 * specs; only `applyLift`'s hoist-in-place approach (never replacing the
 * enclosing statement) shielded expression-position specs from it, and lift
 * is no longer routed to (see above).
 *
 * **Whether the wrap's own closing needs a trailing `;` is answered by what
 * was actually consumed, not by `kind`.** `printWithRewrites` replaces
 * exactly `[statement.startIndex, statement.endIndex)`, so the replacement
 * must reproduce a `;` if and only if `statement.text` itself already ended
 * in one — that's true or false independently of `kind`/parent: a
 * procedure-body block conventionally does (`begin ... end;`), but the SAME
 * block kind used as a bare `if`-branch does NOT when an `else` follows
 * directly in source (`if X then begin ... end else ...` — no `;` before
 * `else`, exactly as for any other bare branch); conversely a nested
 * `if_statement` used as a bare `while`/`for` body DOES already include its
 * own trailing `;` in `.text` (unlike `exit_statement`/`assignment_statement`
 * bare statements, which never do). In valid AL a trailing `;` and a
 * following `else` are mutually exclusive (a `;` right before `else` is
 * AL0110 in the ORIGINAL source too), so reproducing exactly what was
 * consumed can neither orphan an `else` nor drop a terminator the next
 * statement needs.
 *
 * Only a genuine `code_block` member (root is one of possibly several
 * statements inside an existing `begin ... end`) needs no wrap at all — the
 * next token there can never be a misattributed `else`.
 */
function wrapIfSingleStatementSlot(statement: ALSyntaxNode, text: string): string {
  const needsWrap =
    statement.kind === ALNodeKind.block ||
    (statement.parent !== null && statement.parent.kind !== ALNodeKind.block);
  if (!needsWrap) return text;
  const consumedTerminator = statement.text.trimEnd().endsWith(";");
  return `begin\n${text}\nend${consumedTerminator ? ";" : ""}`;
}
