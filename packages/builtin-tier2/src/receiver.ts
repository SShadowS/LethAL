/**
 * Receiver resolution — the single predicate every Tier-2 operator depends on.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4.1.
 *
 * The question is narrow: *is this call actually the AL record method, on a
 * record?* The semantic layer is source-derived and cannot prove a receiver is
 * a base-app `Record` (§2), so the answer must be wrong in the safe direction:
 *
 *   - Missing a site costs one operator's signal. Tier-1 `void-method-call`
 *     still covers it.
 *   - Claiming a wrong site emits a mislabelled mutation AND, because Tier 2
 *     outranks Tier 1 in the §3.2 dedup precedence, suppresses the correct
 *     Tier-1 mutant at that site. Two failures for the price of one.
 *
 * Every uncertainty therefore resolves to "do not claim". The three refusals
 * (non-record receiver / project-declared procedure / unresolvable receiver)
 * are each individually load-bearing and are red-checked as such.
 *
 * CONTRACT ON THE CALLER'S CONTEXT: the shadowing refusal reads `ctx.symbols`
 * for the receiver's table, so it can only fire over a semantic context built
 * across the WHOLE project (spec §4.1: "a procedure declared in the project").
 * Handed a one-file context while the table lives in its own file — the normal
 * AL layout — the guard finds no table and the site is claimed. That is why
 * `generateMutationSet` (`packages/runner/src/orchestrator.ts`) parses every
 * file first and builds a single project-wide context for the operator walk,
 * and why the tests for this guard build the context the same way.
 *
 * Imports come from `@lethal/engine` rather than `@lethal/operator-sdk`
 * because the SDK deliberately re-exports only the operator-facing subset;
 * `declarationMembers`, `SymbolTable`, `ObjectSymbol` and `VarSymbol` are
 * engine surface. Both are declared dependencies of this package.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type ObjectSymbol,
  type SemanticContext,
  type SymbolTable,
  type VarSymbol,
  declarationMembers,
  findEnclosingProcedure,
} from "@lethal/engine";

/**
 * Object declaration kinds a call site can sit inside.
 *
 * DOCUMENTED LIMIT — extension objects are absent, and every Tier-2 operator therefore refuses
 * every site inside a `tableextension` or `pageextension`: `enclosingObject` finds no enclosing
 * object and `claimsRecordMethod` returns `false`. That is the safe direction (a missed site costs
 * one operator's signal; Tier-1 `void-method-call` still covers it), but it is a real hole: a lot
 * of BC code lives in extension objects, including the `Rec.TestField(...)` / `Rec.Modify(true)`
 * shapes these operators exist for.
 *
 * The list mirrors `ObjectSymbol["kind"]` in `@lethal/engine`'s symbol table, which itself indexes
 * only these four — closing the hole means widening the symbol table first (an implicit `Rec`
 * inside a `tableextension` resolves to the EXTENDED table, which the extension object header
 * names rather than declares), so it is deliberately out of scope for this pass rather than
 * papered over here.
 */
const OBJECT_KINDS: ReadonlySet<string> = new Set<string>([
  ALNodeKind.codeunit,
  ALNodeKind.table,
  ALNodeKind.page,
  ALNodeKind.report,
]);

/**
 * Receiver names that denote the implicit record of a table object. They are
 * not declared anywhere, so the symbol table cannot see them.
 */
const IMPLICIT_RECORD_NAMES: ReadonlySet<string> = new Set(["rec", "xrec"]);

/** The grammar's quoted-identifier kind; not declared in `ALNodeKind`. */
const QUOTED_IDENTIFIER = "quoted_identifier";

/**
 * Does `node` — a `call_expression` — call the AL record method `methodName`
 * on something this project's source proves is a record?
 *
 * Returns `false` for anything it cannot establish, including a node that is
 * not a call at all (operators walk every node, so a non-call is a normal
 * negative rather than a contract violation).
 *
 * Throws on a caller-contract violation: a missing node or context, or a
 * method name that is blank or carries surrounding whitespace. Such a name
 * would silently never match, which is exactly the "empty-vs-empty matches"
 * failure this project refuses to ship.
 *
 * Known gap, shared with Tier-1 `void-method-call`: AL's parenthesis-less call
 * form is not a `call_expression`. `Commit;` parses as `call_statement` and
 * `Rec.Modify;` as a bare `member_expression`, so neither ever reaches this
 * predicate. Measured against the vendored v3.0.1 grammar; see the
 * "documented grammar gap" test in `tests/receiver.test.ts`.
 */
export function claimsRecordMethod(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  methodName: string,
): boolean {
  const callKind = (node as ALSyntaxNode | undefined)?.kind;
  if (callKind === undefined) {
    throw new Error("claimsRecordMethod: node is required (received null/undefined)");
  }
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) {
    throw new Error("claimsRecordMethod: a SemanticContext with a symbol table is required");
  }
  if (typeof methodName !== "string" || methodName === "" || methodName.trim() !== methodName) {
    throw new Error(
      `claimsRecordMethod: method name must be non-empty and free of surrounding whitespace, got ${JSON.stringify(methodName)}`,
    );
  }

  if (callKind !== ALNodeKind.procedure_call) return false;

  const callee = node.childForFieldName("function");
  if (callee === null) return false;
  const target = describeCallee(callee);
  if (target === null) return false;

  // AL is case-insensitive: `Modify(TRUE)`, `MODIFY(True)` and
  // `Rec.SETRANGE(...)` are the same sites as their lowercase spellings.
  if (!equalsIgnoreCase(target.name, methodName)) return false;

  const objectNode = enclosingObject(node);
  if (objectNode === null) return false;
  const objectName = objectNameOf(objectNode);
  if (objectName === null) return false;

  if (target.receiver === null) {
    // Implicit-receiver form. Inside a table (its triggers, its field triggers
    // and its own methods) `Rec` is implicit — these are precisely the sites
    // Tier 2 exists to mutate. Anywhere else there is no implicit record we
    // can prove, so do not claim.
    if (objectNode.kind !== ALNodeKind.table) return false;
    // GUARD: project-declared procedure (rule 3).
    if (declaresProcedure(objectNode, target.name)) return false;
    return true;
  }

  const receiver = resolveReceiver(target.receiver, node, objectNode, objectName, symbols);

  // GUARD: unresolvable receiver (rule 4).
  if (receiver.kind === "unresolved") return false;
  // GUARD: receiver resolves to a non-record in source (rule 2).
  if (receiver.kind === "non-record") return false;

  // GUARD (rule 3, qualified form): the receiver is a record, but its table is
  // declared in this project and declares a procedure of that name, so the call
  // is that procedure and not the builtin.
  if (
    receiver.tableRef !== null &&
    projectTableDeclaresProcedure(symbols, receiver.tableRef, target.name)
  ) {
    return false;
  }

  return true;
}

// --- callee shape ----------------------------------------------------------

interface CallTarget {
  /** `null` for the implicit-receiver form (`TestField("No.")`). */
  readonly receiver: ALSyntaxNode | null;
  readonly name: string;
}

/**
 * Split a `call_expression`'s `function` field into receiver + method name.
 *
 * Grammar (v3.0.1): the field is an `identifier` for an unqualified call and a
 * `member_expression` (fields `object` / `member`) for a qualified one.
 * Anything else — a chained `Rec.Line.TestField`, a `GetRec().TestField` — is
 * a shape we cannot resolve, and returns `null`.
 */
function describeCallee(callee: ALSyntaxNode): CallTarget | null {
  if (isIdentifierLike(callee)) {
    return { receiver: null, name: stripQuotes(callee.text) };
  }
  if (callee.kind === ALNodeKind.field_access) {
    const object = callee.childForFieldName("object");
    const member = callee.childForFieldName("member");
    if (object === null || member === null) return null;
    return { receiver: object, name: stripQuotes(member.text) };
  }
  return null;
}

// --- receiver resolution ---------------------------------------------------

type ResolvedReceiver =
  | { readonly kind: "record"; readonly tableRef: string | null }
  | { readonly kind: "non-record" }
  | { readonly kind: "unresolved" };

function resolveReceiver(
  receiver: ALSyntaxNode,
  callNode: ALSyntaxNode,
  objectNode: ALSyntaxNode,
  objectName: string,
  symbols: SymbolTable,
): ResolvedReceiver {
  const receiverName = identifierText(receiver);
  if (receiverName === null) return { kind: "unresolved" };

  const declared = lookupVar(receiverName, callNode, objectName, symbols);
  if (declared !== null) return classifyDeclaredType(declared);

  // Not declared anywhere the symbol table can see. The one case that is still
  // provable from source: a table's implicit `Rec` / `xRec`.
  if (objectNode.kind === ALNodeKind.table && IMPLICIT_RECORD_NAMES.has(lower(receiverName))) {
    return { kind: "record", tableRef: objectName };
  }

  return { kind: "unresolved" };
}

/**
 * Find the declaration of `name` visible at the call site: procedure locals,
 * then procedure parameters, then the object's globals.
 *
 * Deliberately conservative: the symbol table indexes `procedure` members
 * only, so a var declared in a *trigger's* own `var` section is not found and
 * the site is refused (rule 4) rather than guessed at.
 */
function lookupVar(
  name: string,
  callNode: ALSyntaxNode,
  objectName: string,
  symbols: SymbolTable,
): VarSymbol | null {
  const matches = (v: VarSymbol): boolean => equalsIgnoreCase(v.name, name);

  const procedure = findEnclosingProcedure(callNode);
  if (procedure !== null) {
    const nameNode = procedure.childForFieldName("name");
    if (nameNode !== null) {
      const procName = stripQuotes(nameNode.text);
      const local = symbols.localsOf(objectName, procName).find(matches);
      if (local !== undefined) return local;
      const parameter = symbols.resolveProcedure(objectName, procName)?.parameters.find(matches);
      if (parameter !== undefined) return parameter;
    }
  }

  return symbols.globalsOf(objectName).find(matches) ?? null;
}

/**
 * Is the declared type a `Record`, and of which table?
 *
 * Read from the AST rather than from `VarSymbol.typeText`, so
 * `Record "Sales Line" temporary` and `Record Customer` classify identically:
 * `type_specification` wraps a `record_type` whose `reference` field names the
 * table.
 *
 * `tableRef` is that reference verbatim, and it is NOT always a name: `R: Record 50004` is legal
 * AL and measures as `reference: integer "50004"`. Hence `tableRef` rather than `tableName`, and
 * hence `projectTableDeclaresProcedure` resolving it through `resolveObject` (which matches id and
 * name alike) rather than by name comparison.
 */
function classifyDeclaredType(declaration: VarSymbol): ResolvedReceiver {
  const typeNode = declaration.node.childForFieldName("type");
  if (typeNode === null) return { kind: "unresolved" };
  const recordType = typeNode.namedChildren.find((c) => c.kind === ALNodeKind.record_type);
  if (recordType === undefined) return { kind: "non-record" };
  const reference = recordType.childForFieldName("reference");
  return { kind: "record", tableRef: reference === null ? null : stripQuotes(reference.text) };
}

// --- project-declared procedures ------------------------------------------

/**
 * Does this object declare a procedure of that name? Case-insensitively, and
 * through `declarationMembers` so v3's `declaration_body` container is skipped
 * — a hand-rolled `namedChildren` walk silently matches nothing here.
 */
function declaresProcedure(objectNode: ALSyntaxNode, name: string): boolean {
  for (const member of declarationMembers(objectNode)) {
    if (member.kind !== ALNodeKind.procedure) continue;
    const nameNode = member.childForFieldName("name");
    if (nameNode === null) continue;
    if (equalsIgnoreCase(stripQuotes(nameNode.text), name)) return true;
  }
  return false;
}

/**
 * Does the project's declaration of `tableRef` declare a procedure named `procName`?
 *
 * `tableRef` is whatever the `record_type`'s `reference` field held, which is a table NAME
 * (`Record Customer`, `Record "Sales Line"`) or a table ID — `R: Record 50004` is legal AL and
 * measures as `reference: integer "50004"`. Resolution therefore goes through
 * `symbols.resolveObject`, which matches id and name alike
 * (`packages/engine/src/semantic/symbol-table.ts`); a hand-rolled name-only loop silently never
 * matched the id form, so `R.SetRange(...)` on a table declaring its own `SetRange` was CLAIMED.
 *
 * "In the project" means across every file in the semantic context, per spec §4.1 — see
 * `generateMutationSet` in `packages/runner/src/orchestrator.ts`, which builds one context over
 * every parsed file precisely so this guard can fire on the normal one-object-per-file layout.
 */
function projectTableDeclaresProcedure(
  symbols: SymbolTable,
  tableRef: string,
  procName: string,
): boolean {
  const table = resolveTable(symbols, tableRef);
  if (table === null) return false;
  return declaresProcedure(table.node, procName);
}

/**
 * The project's `table` object for an id-or-name reference.
 *
 * `resolveObject` handles the id form and an exact name match, but its name comparison is
 * case-SENSITIVE while AL is not, so a case-insensitive scan backs it up. Losing that would move
 * this guard in the dangerous direction (fewer refusals means more wrongly claimed sites), which
 * is why the fallback is here rather than left to `resolveObject`'s own semantics.
 */
function resolveTable(symbols: SymbolTable, idOrName: string): ObjectSymbol | null {
  const direct = symbols.resolveObject({ kind: "table", idOrName });
  if (direct !== null) return direct;
  return (
    symbols.objects.find((o) => o.kind === "table" && equalsIgnoreCase(o.name, idOrName)) ?? null
  );
}

// --- small helpers ---------------------------------------------------------

function enclosingObject(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (OBJECT_KINDS.has(current.kind)) return current;
    current = current.parent;
  }
  return null;
}

function objectNameOf(objectNode: ALSyntaxNode): string | null {
  const nameNode = objectNode.childForFieldName("object_name");
  return nameNode === null ? null : stripQuotes(nameNode.text);
}

function isIdentifierLike(node: ALSyntaxNode): boolean {
  return node.kind === ALNodeKind.identifier || node.rawKind === QUOTED_IDENTIFIER;
}

function identifierText(node: ALSyntaxNode): string | null {
  return isIdentifierLike(node) ? stripQuotes(node.text) : null;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return lower(a) === lower(b);
}
