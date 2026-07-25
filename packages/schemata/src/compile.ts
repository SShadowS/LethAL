import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import {
  ALNodeKind,
  declarationMembers,
  findFirst,
  isStatementPosition,
  printWithRewrites,
} from "@lethal/engine";
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

/** Raw grammar kinds of a `table_declaration`'s three header tokens. */
const TABLE_HEADER_KINDS: ReadonlySet<string> = new Set([
  "table_keyword",
  ALNodeKind.integer_literal,
  "quoted_identifier",
  ALNodeKind.identifier,
]);

/** Builds the zero-width synthetic node `printWithRewrites` inserts text at. */
function insertionNodeAt(anchor: ALSyntaxNode, index: number): ALSyntaxNode {
  const position = index === anchor.startIndex ? anchor.startPosition : anchor.endPosition;
  return {
    kind: anchor.kind,
    rawKind: anchor.rawKind,
    text: "",
    startIndex: index,
    endIndex: index,
    startPosition: position,
    endPosition: position,
    parent: anchor.parent,
    children: [],
    namedChildren: [],
    fieldName: null,
    childForFieldName: () => null,
  };
}

/**
 * Insert `var MutationSelector: Codeunit "Mutation Selector";` into the
 * file's codeunit or table — reusing its existing `var_section` if present,
 * or inserting a fresh one otherwise. A zero-width edit (`start === end`) is
 * used for the "no existing var_section" case: `printWithRewrites` keys
 * rewrites by node identity and applies each as `[start, end)`, so a
 * synthetic node with `start === end` inserts text there without consuming
 * (or conflicting with) any other rewrite targeting a real member's own
 * contents.
 *
 * A codeunit's/table's members (`var_section`, `procedure`, `trigger`, ...)
 * sit inside v3's `declaration_body` container, not as direct
 * `namedChildren` of the object itself — reading `object.namedChildren`
 * straight finds neither an existing `var_section` nor a first member under
 * v3, so every object silently fell through to the "no existing var_section"
 * branch and got a second, separate object-level `var` section instead of
 * reusing the one it already had. `declarationMembers` skips the container
 * (and is a no-op under a grammar without one).
 *
 * The insertion ANCHOR differs by object kind, and this is measured against
 * `alc`, not assumed: in a codeunit, `var` before the first member compiles
 * clean, but in a TABLE, `var` before `fields` is a hard syntax error
 * (AL0107/AL0104/AL0198 — the parse does not recover). So for a table the
 * selector must go AFTER the section-like members (`fields`, `keys`,
 * `fieldgroups`) — before the first object-level trigger, or trailing (after
 * the last member) when the table has none. A table CAN have no object-level
 * trigger while still carrying a mutable trigger body: a field-level
 * `OnValidate` lives inside `fields_section`, not as an object-level member,
 * so it never becomes a `declarationMembers` anchor candidate.
 */
function injectMutationSelectorVar(root: ALSyntaxNode, rewrites: Map<ALSyntaxNode, string>): void {
  const object = findFirst(root, ALNodeKind.codeunit) ?? findFirst(root, ALNodeKind.table);
  if (object === null) return; // no object we know how to guard — no guard call is ever emitted there

  const isTable = object.kind === ALNodeKind.table;
  const headerKinds = isTable ? TABLE_HEADER_KINDS : CODEUNIT_HEADER_KINDS;
  // Under the current v3 grammar `declarationMembers` already strips the
  // `declaration_body` container, so header tokens never actually reach
  // `members` here — this filter only matters as a defensive fallback for a
  // grammar without that container (see `declarationMembers`'s own fallback).
  const members = declarationMembers(object).filter((c) => !headerKinds.has(c.kind));

  const existingVar = members.find((c) => c.kind === ALNodeKind.var_section);
  if (existingVar !== undefined) {
    if (rewrites.has(existingVar)) {
      throw new Error(
        "compileSchemataForFile: object's var_section already targeted by another rewrite",
      );
    }
    rewrites.set(
      existingVar,
      `${existingVar.text.replace(/\s+$/, "")}\n        MutationSelector: Codeunit "Mutation Selector";`,
    );
    return;
  }

  if (members.length === 0) return; // header-only object (no members) — nothing to guard

  const anchor = isTable ? members.find((c) => c.kind === ALNodeKind.trigger) : members[0];

  if (anchor !== undefined) {
    rewrites.set(
      insertionNodeAt(anchor, anchor.startIndex),
      `    var\n        MutationSelector: Codeunit "Mutation Selector";\n\n`,
    );
    return;
  }

  // Table with no object-level trigger to anchor before (only ever reached
  // for a table: the codeunit branch's anchor is always `members[0]`, which
  // is defined whenever `members.length > 0`, already checked above).
  const lastMember = members.at(-1);
  if (lastMember === undefined) return;
  rewrites.set(
    insertionNodeAt(lastMember, lastMember.endIndex),
    `\n\n    var\n        MutationSelector: Codeunit "Mutation Selector";`,
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
 * - **`!isStatementPosition(statement)`** — the root sits in a bare BRANCH
 *   position instead: the single then/else statement of an `if`, or the
 *   single body of a `while`/`for`/`repeat`/`case`, with no surrounding
 *   `begin ... end` of its own (e.g. `if X then Y := 1 else Y := 2;` —
 *   `Y := 1`'s parent is the `if_statement`, not a block's statement list).
 *   `isStatementPosition` (packages/engine) answers this by the statement's
 *   immediate parent rather than a fixed container kind: the grammar
 *   interposes a `statement_block` between a `code_block` and its
 *   statements, so a genuine statement-list member's parent is the
 *   `statement_block`, not the `code_block` itself — keying on `code_block`
 *   directly would misclassify every ordinary statement as a bare branch
 *   and wrap it unnecessarily.
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
 * Only a genuine statement-position member (root is one of possibly several
 * statements inside an existing `begin ... end`, per `isStatementPosition`)
 * needs no wrap at all — the next token there can never be a misattributed
 * `else`.
 */
function wrapIfSingleStatementSlot(statement: ALSyntaxNode, text: string): string {
  const isBlockOrNonStatementChild =
    statement.kind === ALNodeKind.block || !isStatementPosition(statement);
  if (!isBlockOrNonStatementChild) return text;
  const consumedTerminator = statement.text.trimEnd().endsWith(";");
  return `begin\n${text}\nend${consumedTerminator ? ";" : ""}`;
}
