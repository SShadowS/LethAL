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
  /** Target file path, used only to name the file in the "cannot instrument this object kind"
   *  error below. Single-file callers (tests) may omit it. */
  filePath?: string,
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
  // declaration per codeunit or TABLE that actually has a mutation in it — and throw for any
  // other object kind, since by this point the guard calls are already in `rewrites` and
  // shipping them without a declaration is precisely the AL0118 this injection prevents.
  // Per-object (R6): a file may legally declare more than one AL object, so this groups `specs`
  // by their OWN enclosing object rather than injecting into whichever object the file happens
  // to declare first — see `injectMutationSelectorVar`'s doc comment.
  if (specs.length > 0) injectMutationSelectorVar(specs, rewrites, filePath ?? "<file>");

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
 * Grammar kinds ending in `_declaration` that are NOT an AL object declaration — they name a
 * member (or a page control) inside one, so they must never be reported as "the object kind
 * this file declares".
 */
const NON_OBJECT_DECLARATION_KINDS: ReadonlySet<string> = new Set([
  "declaration_body",
  "trigger_declaration",
  "variable_declaration",
  "action_declaration",
]);

/**
 * True when this file's object declaration can carry the
 * `var MutationSelector: Codeunit "Mutation Selector";` declaration — i.e. it is a codeunit or a
 * table. Exported as the SINGLE construction point of that predicate: `generateMutationSet`
 * (@lethal/runner) drops a file's specs up front when this is false, and
 * `injectMutationSelectorVar` below throws on the same condition as the backstop. Two hand-rolled
 * copies of "codeunit or table" could drift, and the drift is silent in the dangerous direction
 * (specs generated for a file the injector will then refuse, aborting the session).
 */
export function canCarryMutationSelectorVar(root: ALSyntaxNode): boolean {
  return CARRIER_KINDS.some((k) => findFirst(root, k) !== null);
}

/**
 * Object kinds that can carry the injected selector var.
 *
 * The list used to be codeunit + table, on the stated grounds that no other kind could hold the
 * declaration and a guard in one "cannot compile (AL0118)". **Measured 2026-07-27 and disproven**
 * (R40): a probe declaring the exact var inside a `page` (with layout, actions and a trigger) and
 * a `report` (with dataset, requestpage and a trigger) compiles clean — `alc 17.0.29`, exit 0.
 * The real constraint was never the KIND, it was WHERE the var is anchored, exactly as R38 turned
 * out to be for codeunits. On Continia Document Output the old refusal cost 41% of the app's
 * mutation sites; pages and reports are 6,492 of those 8,259.
 *
 * `pageextension`/`tableextension` compile with the var too, and are deliberately NOT here yet:
 * they do not match `objectHeadersOf`'s header regex (project.ts), and it is unmeasured whether BC
 * attributes an extension's coverage to the extension's own id or the base object's. Guessing
 * that wrong mis-keys `coverageFilter` and manufactures false survivors — the R29 failure exactly.
 * Enums stay out for a simpler reason: they hold no code, so they can hold no var.
 */
const CARRIER_KINDS: readonly ALNodeKind[] = [
  ALNodeKind.codeunit,
  ALNodeKind.table,
  ALNodeKind.page,
  ALNodeKind.report,
];

/**
 * Names the object declaration(s) this file actually contains, for the "cannot instrument this
 * object kind" error below and for `generateMutationSet`'s skip warning. `wrapRoot(parseAL(src))`
 * yields a `source_file` whose named children are the object declarations; a caller that passed a
 * declaration node straight in is handled too.
 */
export function describeObjectKinds(root: ALSyntaxNode): string {
  const candidates = root.rawKind.endsWith("_declaration") ? [root] : root.namedChildren;
  const kinds = [
    ...new Set(
      candidates
        .map((c) => c.rawKind)
        .filter((k) => k.endsWith("_declaration") && !NON_OBJECT_DECLARATION_KINDS.has(k)),
    ),
  ];
  return kinds.length > 0 ? kinds.join(", ") : `no object declaration (root is ${root.rawKind})`;
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
 * `alc`, not assumed: in a TABLE, `var` before `fields` is a hard syntax
 * error (AL0107/AL0104/AL0198 — the parse does not recover). So for a table
 * the selector must go AFTER the section-like members (`fields`, `keys`,
 * `fieldgroups`) — before the first object-level trigger, or trailing (after
 * the last member) when the table has none. A table CAN have no object-level
 * trigger while still carrying a mutable trigger body: a field-level
 * `OnValidate` lives inside `fields_section`, not as an object-level member,
 * so it never becomes a `declarationMembers` anchor candidate.
 *
 * BOTH kinds must also clear the object's own PROPERTIES (R38). AL requires every object-level
 * property (`Permissions`, `Access`, `Subtype`, `SingleInstance`, `EventSubscriberInstance`,
 * `TableNo`, …) to precede any `var` section, so a codeunit anchored at `members[0]` emits
 * `{ var MutationSelector … Permissions = …` and `alc` reads `Permissions` as a variable name,
 * never recovering. This had gone unnoticed because every fixture codeunit declares no
 * properties: `members[0]` was a `procedure` and the emission was legal by accident. Measured on
 * the real Continia Document Output app — 19 of 162 instrumented files, 246 errors, whole-app
 * compile fails, so not one mutant could run. Note tree-sitter RECOVERS from the bad ordering
 * without an ERROR node, so re-parsing the emission does not catch it; only `alc` does.
 *
 * A table needed no separate fix for this: properties precede `fields`, and both table anchors
 * (before the first object-level trigger, or trailing) already sit after `fields`.
 *
 * "Before the first object-level trigger" is safe, not merely lucky, and the reason is about
 * where a TRIGGER may go, not only about where a `var` may go: in a table, an object-level
 * trigger may not precede `fields`, and may not sit between `fields` and `keys`. Both were
 * verified against `alc 18.0.2498801` — `trigger OnInsert` declared before `fields` is
 * `AL0104: Syntax error, 'fields' expected`, and `fields` → `trigger` → `keys` is
 * `AL0104`/`AL0198`. So the first object-level trigger, when there is one, always sits AFTER
 * every section-like member; anchoring immediately before it therefore lands the `var` after
 * `fields`/`keys`/`fieldgroups` by construction, for every table AL will accept.
 *
 * Only a codeunit and a table can carry the declaration today. Every other object kind THROWS
 * rather than returning: this runs only when `specs.length > 0`, i.e. after the guard calls have
 * already been spliced in, so a silent return emits `MutationSelector.Active(...)` with no
 * declaration in scope — AL0118, an `AlcCompileError`, and bisection then halves the mutant set
 * and converges on an innocent mutant.
 *
 * This throw is the BACKSTOP, not the primary handling: `generateMutationSet` (@lethal/runner)
 * already drops the specs of any file `canCarryMutationSelectorVar` rejects, so an ordinary
 * session with a `page` full of `OnAction` bodies skips that page rather than aborting. What
 * reaches here is a caller that assembled its own `InstrumentedFile` list without applying that
 * filter — a caller-contract violation, and refusing it loudly beats emitting AL that cannot
 * compile.
 */
function injectSelectorVarIntoObject(
  object: ALSyntaxNode,
  rewrites: Map<ALSyntaxNode, string>,
  filePath: string,
): void {
  const isTable = object.kind === ALNodeKind.table;
  // R40: a page/report carries structural sections (`layout`, `actions`, `dataset`,
  // `requestpage`) that a `var` may not precede, and unlike a table there is no member the var is
  // reliably allowed to sit BEFORE. Measured: trailing placement — after every member, including
  // object-level triggers — compiles clean for both kinds with realistic sections present. So they
  // take the same trailing branch a trigger-less table already uses, by having no anchor.
  const isTrailingOnly = object.kind === ALNodeKind.page || object.kind === ALNodeKind.report;
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

  // Header-only object: no member to anchor the insertion against. Unreachable in practice (a
  // spec implies mutable code, which lives in a member) but throws for the same reason the
  // unsupported-kind branch above does — the guard calls are already emitted, so returning here
  // ships AL that cannot compile.
  if (members.length === 0) {
    throw new Error(
      `compileSchemataForFile: cannot instrument ${filePath} — its object declaration has no members to anchor the selector var against, yet mutation guards were emitted for it.`,
    );
  }

  // A codeunit anchors before its first NON-PROPERTY member (R38) — `members[0]` would land the
  // `var` ahead of `Permissions`/`Access`/`Subtype`, which AL rejects. `undefined` here (a
  // codeunit whose members are all properties) falls through to the trailing branch below, the
  // same one the trigger-less table uses.
  const anchor = isTrailingOnly
    ? undefined
    : isTable
      ? members.find((c) => c.kind === ALNodeKind.trigger)
      : members.find((c) => c.kind !== ALNodeKind.property);

  if (anchor !== undefined) {
    rewrites.set(
      insertionNodeAt(anchor, anchor.startIndex),
      `    var\n        MutationSelector: Codeunit "Mutation Selector";\n\n`,
    );
    return;
  }

  // No member to anchor BEFORE: a table with no object-level trigger, a codeunit whose members are
  // all properties (R38), or a page/report, which is always trailing (R40). Appending after the last member is right for both — it
  // clears every property by construction, and for the table it also clears `fields`/`keys`.
  const lastMember = members.at(-1);
  if (lastMember === undefined) {
    // Unreachable — `members.length === 0` threw above — but a silent return here would ship the
    // already-emitted guard calls with no declaration in scope (AL0118), exactly like the two
    // branches above. Same failure, same answer.
    throw new Error(
      `compileSchemataForFile: cannot instrument ${filePath} — no member to anchor the selector var after, yet mutation guards were emitted for it.`,
    );
  }
  rewrites.set(
    insertionNodeAt(lastMember, lastMember.endIndex),
    `\n\n    var\n        MutationSelector: Codeunit "Mutation Selector";`,
  );
}

/**
 * Nearest ancestor AL object declaration containing `node` (`codeunit_declaration`,
 * `table_declaration`, `page_declaration`, ...) — the ancestor whose OWN parent is the
 * `source_file` root. AL object declarations are always direct top-level children of the file
 * (never nested inside another declaration), so this is exact regardless of which grammar kind
 * the object is, unlike matching on a `_declaration`-suffixed rawKind: a TABLE's field-level
 * trigger sits inside `field_declaration` (itself `_declaration`-suffixed, several levels below
 * the table), so a "first `_declaration` ancestor" walk stops there instead of at the table —
 * caught by `compile.test.ts`'s field-level-trigger case. `null` when `node` sits outside any
 * object — shouldn't happen for AL actually parsed from a file, but a caller-constructed tree
 * could hit it, and a defensive `null` beats silently walking off the top of the tree.
 *
 * This is a pure AST walk, so unlike `project.ts`'s regex-based `objectHeadersOf` it needs no
 * comment-stripping of its own: a comment is never a syntax node, so a commented-out object
 * simply isn't part of the tree to walk into.
 */
function enclosingObjectDeclaration(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null) {
    if (current.parent !== null && current.parent.kind === ALNodeKind.source_file) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Injects `var MutationSelector: Codeunit "Mutation Selector";` into every object this file's
 * `specs` actually put a guard in — not just the file's first object. A file may legally declare
 * more than one AL object (rare, but legal AL); the old version of this function picked exactly
 * one object for the whole file (`findFirst(codeunit) ?? findFirst(table)`), so for `table` +
 * `codeunit` in one file it injected into the codeunit only, leaving every guard inside the
 * table with no declaration in scope — AL0118 (R6).
 *
 * Per-object attribution here is the AST-accurate half of R6's fix: each spec's OWN enclosing
 * object is found by walking up from `spec.before` (`enclosingObjectDeclaration`), objects are
 * deduped by node identity (two specs in the same object must not double-inject), and each
 * distinct object gets exactly one declaration. The companion half — labelling each manifest
 * entry with ITS OWN object's `(objectType, objectId)` instead of the file's first header — is
 * `project.ts`'s `attributeHeader`.
 *
 * A spec whose enclosing object is missing, or present but not a codeunit/table, still throws
 * exactly as the single-object version did: the guard call is already spliced into `rewrites` by
 * this point, so shipping it without a declaration in scope is the AL0118 this function exists
 * to prevent. `writeInstrumentedProject` (@lethal/runner-adjacent, `project.ts`) is expected to
 * have already refused any file mixing an injectable object with a non-injectable one
 * (`assertNoUnsupportedObjectMix`) before this ever runs — what reaches here from an
 * unsupported-kind object is therefore either a caller that assembled its own `InstrumentedFile`
 * list without that check, or a mutation site sitting outside any object at all.
 */
function injectMutationSelectorVar(
  specs: readonly MutationSpec[],
  rewrites: Map<ALSyntaxNode, string>,
  filePath: string,
): void {
  const objects = new Set<ALSyntaxNode>();
  for (const spec of specs) {
    const object = enclosingObjectDeclaration(spec.before);
    if (object === null || !CARRIER_KINDS.includes(object.kind)) {
      const why =
        'the `var MutationSelector: Codeunit "Mutation Selector";` declaration can only be ' +
        `injected into ${CARRIER_KINDS.join(", ")}. Mutation guards were already emitted for this ` +
        "file, so every `MutationSelector.Active(...)` call would fail to compile with AL0118. " +
        "Spec generation is supposed to have dropped this file already (`generateMutationSet` " +
        "filters on `canCarryMutationSelectorVar`, `writeInstrumentedProject` on " +
        "`assertNoUnsupportedObjectMix`); a caller building its own file list must apply the " +
        "same filters, or add selector-var support for this object kind.";
      const kindText = object === null ? "no enclosing AL object declaration" : object.rawKind;
      throw new Error(
        `compileSchemataForFile: cannot instrument ${filePath} — a mutation guard sits inside ${kindText}, and ${why}`,
      );
    }
    objects.add(object);
  }
  for (const object of objects) {
    injectSelectorVarIntoObject(object, rewrites, filePath);
  }
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
