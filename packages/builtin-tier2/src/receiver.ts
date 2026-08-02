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
 * for the receiver's table AND for any `tableextension` of it, so it can only
 * fire over a semantic context built across the WHOLE project (spec §4.1: "a
 * procedure declared in the project"). Handed a one-file context while the
 * table (or the extension) lives in its own file — the normal AL layout — the
 * guard finds neither and the site is claimed. That is why `generateMutationSet`
 * (`packages/runner/src/orchestrator.ts`) parses every file first and builds a
 * single project-wide context for the operator walk, and why the tests for this
 * guard build the context the same way.
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
  collectVarDeclarations,
  declarationMembers,
  extensionScopeKey,
  findEnclosingProcedure,
  objectScopeKeyOfNode,
} from "@lethal/engine";

/**
 * Object declaration kinds a call SITE can sit inside.
 *
 * R30: extension objects were absent, so every Tier-2 operator refused every site written INSIDE a
 * `tableextension` or `pageextension` — `enclosingObject` found no enclosing object and
 * `claimsRecordMethod` returned `false`. Safe (a missed site costs one operator's signal, and
 * Tier-1 `void-method-call` still covers it) but a real hole, since a great deal of BC code lives
 * in extension objects and it is exactly the `Rec.TestField(...)` / `Rec.Modify(true)` shape these
 * operators exist for.
 *
 * What admitting them actually buys, and what it does not:
 *
 * - `tableextension` — FULL. An implicit `Rec`/`xRec` resolves to the EXTENDED table, which the
 *   header names in its `base_object` field (`tableextension 50100 "X" extends Customer`, measured
 *   against the vendored grammar). Rule 3's `projectDeclaresProcedureOnTable` then applies to that
 *   table exactly as for a site written in the table itself, including the `tableextension`-
 *   declares-a-builtin guard.
 * - `pageextension` — PARTIAL, deliberately. A page's `Rec` is its `SourceTable`, declared on the
 *   EXTENDED PAGE, which is routinely a dependency this project cannot see. Resolving it would mean
 *   guessing, and a wrong receiver is the direction that CLAIMS a site wrongly — mislabelling the
 *   mutation and, under §3.2 dedup precedence, suppressing the correct Tier-1 mutant at the same
 *   site. So `Rec` stays unresolved there and only explicitly-typed record variables can claim.
 *   That refusal is now MEASURED rather than argued: on Continia Document Output Cloud there are
 *   ZERO Tier-2-shaped calls on a `pageextension`'s implicit `Rec`, and zero of its 93
 *   `pageextension`s extend a page the project declares — so the `SourceTable` needed to resolve
 *   `Rec` is not available even in principle (`scripts/probe-r30-pageext.ts`).
 *
 * Variables DECLARED inside an extension DO resolve, for both kinds: `buildSymbolTable` indexes an
 * extension's own members (globals, procedure locals, parameters) under `extensionScopeKey(kind,
 * name)`, so `lookupVar` finds them here while `resolveProcedure("My Ext", ...)` keeps answering
 * null. Measured value of that half: +18 mutants on Document Output for the `tableextension` kind,
 * and 18 more sites for the `pageextension` kind.
 */
const OBJECT_KINDS: ReadonlySet<string> = new Set<string>([
  ALNodeKind.codeunit,
  ALNodeKind.table,
  ALNodeKind.page,
  ALNodeKind.report,
  ALNodeKind.tableextension,
  ALNodeKind.pageextension,
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
    //
    // R30: a `tableextension` has the same implicit `Rec`, and it is the EXTENDED table's. This
    // is the shape that actually occurs — measured on Continia Document Output, whose 31
    // tableextensions contain ZERO `Rec.`-qualified calls but do contain bare `SetRange(...)` /
    // `TestField(...)`. Handling only the qualified form gained exactly nothing there.
    //
    // R67: a plain `page`'s implicit `Rec` is its own `SourceTable`, declared in the same file.
    // Reading a property that is PRESENT is resolution; a `pageextension` is still refused because
    // ITS implicit record is the EXTENDED page's SourceTable, in an object this project usually
    // cannot see, and guessing that would be the R29 shape.
    const implicitTable =
      objectNode.kind === ALNodeKind.table
        ? objectName
        : objectNode.kind === ALNodeKind.tableextension
          ? (extendedTableOf(objectNode) ?? null)
          : objectNode.kind === ALNodeKind.page
            ? sourceTableOf(objectNode)
            : null;
    if (implicitTable === null) return false;
    // GUARD: project-declared procedure (rule 3). The table itself, AND any `tableextension` of
    // it — an extension's procedure is callable on the implicit `Rec` here exactly as the table's
    // own is. Keyed on the EXTENDED table, so a site inside one extension is still guarded by a
    // procedure another extension declares on the same table.
    if (declaresProcedure(objectNode, target.name)) return false;
    if (projectDeclaresProcedureOnTable(symbols, implicitTable, target.name)) return false;
    return true;
  }

  const receiver = resolveReceiver(target.receiver, node, objectNode, objectName, symbols);

  // GUARD: unresolvable receiver (rule 4).
  if (receiver.kind === "unresolved") return false;
  // GUARD: receiver resolves to a non-record in source (rule 2).
  if (receiver.kind === "non-record") return false;

  // GUARD (rule 3, qualified form): the receiver is a record, and this project declares a
  // procedure of that name ON that table — in the table itself or in a `tableextension` of it —
  // so the call is that procedure and not the builtin.
  if (
    receiver.tableRef !== null &&
    projectDeclaresProcedureOnTable(symbols, receiver.tableRef, target.name)
  ) {
    return false;
  }

  return true;
}

/**
 * R33: does `node` call the AL SYSTEM function `name` — the receiverless kind, of which `Commit()`
 * is the case Phase 2 needs — rather than a procedure this project declares under the same name?
 *
 * A separate predicate from `claimsRecordMethod`, deliberately. That one asks "is the receiver a
 * record?"; `Commit()` has no receiver at all, so every part of that question is the wrong one, and
 * threading a null-receiver special case through it would put the record rules on a path that has
 * no record.
 *
 * The refusals, both in the safe direction:
 *
 *   1. Any RECEIVER at all refuses. `Shadow.Commit()` is a call on something, and the AL system
 *      `Commit` has no qualified form — so a qualified call of that name is by construction a
 *      project-declared procedure. The fixture has exactly this shape (`Data Shadow` declares
 *      `Commit`, `Data Ops.ShadowedBuiltins` calls it).
 *   2. The ENCLOSING object declaring a procedure of that name refuses, and so does a
 *      `tableextension` of the enclosing table declaring one — an unqualified call binds to the
 *      object's own procedure before the system function, which is `Data Shadow.BumpViaCommit`'s
 *      bare `Commit()` in the fixture.
 *
 * Arguments are the caller's rule, not this predicate's: `Commit()` takes none, but a shared
 * predicate that hardcoded that would be wrong for the next system call.
 *
 * Shares the parenthesis-less limitation documented on `claimsRecordMethod`: `Commit;` parses as a
 * `call_statement`, never reaches here, and is silently not claimed.
 */
export function claimsSystemCall(node: ALSyntaxNode, ctx: SemanticContext, name: string): boolean {
  const callKind = (node as ALSyntaxNode | undefined)?.kind;
  if (callKind === undefined) {
    throw new Error("claimsSystemCall: node is required (received null/undefined)");
  }
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) {
    throw new Error("claimsSystemCall: a SemanticContext with a symbol table is required");
  }
  if (typeof name !== "string" || name === "" || name.trim() !== name) {
    throw new Error(
      `claimsSystemCall: name must be non-empty and free of surrounding whitespace, got ${JSON.stringify(name)}`,
    );
  }

  if (callKind !== ALNodeKind.procedure_call) return false;
  const callee = node.childForFieldName("function");
  if (callee === null) return false;
  const target = describeCallee(callee);
  if (target === null) return false;
  // GUARD 1: a qualified call of this name is a project procedure, never the system function.
  if (target.receiver !== null) return false;
  if (!equalsIgnoreCase(target.name, name)) return false;

  const objectNode = enclosingObject(node);
  if (objectNode === null) return false;
  const objectName = objectNameOf(objectNode);
  if (objectName === null) return false;

  // GUARD 2: the enclosing object's own declaration wins over the system function.
  if (declaresProcedure(objectNode, target.name)) return false;
  // …and so does one added to the enclosing TABLE by an extension, which is callable on the
  // implicit `Rec` here exactly as the table's own is.
  const enclosingTable =
    objectNode.kind === ALNodeKind.table
      ? objectName
      : objectNode.kind === ALNodeKind.tableextension
        ? extendedTableOf(objectNode)
        : // R67: same resolution as the implicit-receiver branch above, so rule 3 reaches the
          // page's SourceTable exactly as it reaches a tableextension's base object. Omitting it
          // here would bypass the shadowing guard for a whole object kind.
          objectNode.kind === ALNodeKind.page
          ? sourceTableOf(objectNode)
          : null;
  if (
    enclosingTable !== null &&
    projectDeclaresProcedureOnTable(symbols, enclosingTable, target.name)
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

  // R30: inside an extension object, the declaring SCOPE is the extension itself — its locals,
  // parameters and globals are visible only there. `SymbolTable` indexes them under a namespaced
  // key so that `resolveProcedure("My Ext", ...)` keeps answering null for a receiver no AL call
  // can name; scope asks a different question from callability. The key carries the KIND because
  // AL lets a `tableextension` and a `pageextension` share a name.
  //
  // R70: the non-extension branch is kind-keyed for the same reason. `table 50000 "CDO Setup"` and
  // `page 50000 "CDO Setup"` — a card page named after its table, the ordinary BC convention —
  // shared one scope key, so whichever parsed last supplied the variables for BOTH. A receiver that
  // should be refused here could then resolve through the other object's declaration and be
  // CLAIMED. `objectScopeKeyOfNode` returns null for a node this table does not index; falling back
  // to the bare name there would reintroduce exactly the collision.
  const scopeOwner =
    objectNode.kind === ALNodeKind.tableextension
      ? extensionScopeKey("tableextension", objectName)
      : objectNode.kind === ALNodeKind.pageextension
        ? extensionScopeKey("pageextension", objectName)
        : objectScopeKeyOfNode(objectNode, objectName);
  if (scopeOwner === null) return { kind: "unresolved" };
  const declared = lookupVar(receiverName, callNode, scopeOwner, symbols);
  if (declared !== null) return classifyDeclaredType(declared);

  // Not declared anywhere the symbol table can see. The cases still PROVABLE from source:
  if (IMPLICIT_RECORD_NAMES.has(lower(receiverName))) {
    // A table's own implicit `Rec` / `xRec`.
    if (objectNode.kind === ALNodeKind.table) return { kind: "record", tableRef: objectName };
    // R30: inside a `tableextension`, `Rec`/`xRec` is the EXTENDED table — named by the header's
    // `base_object` field, not declared anywhere. A `pageextension` is deliberately NOT handled:
    // its `Rec` is the extended PAGE's `SourceTable`, which lives in an object this project
    // usually cannot see, and guessing it would claim sites wrongly.
    if (objectNode.kind === ALNodeKind.tableextension) {
      const tableRef = extendedTableOf(objectNode);
      if (tableRef !== null) return { kind: "record", tableRef };
    }
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

  // R68: a TRIGGER's own `var` section, resolved from the AST node rather than from a name-keyed
  // map. `buildSymbolTable` indexes `procedure` members only — deliberately, because trigger names
  // repeat across an object (every field may declare its own `OnValidate`) and a name key would be
  // ambiguous. The enclosing node is the unambiguous identity, and the call site already has it.
  //
  // Checked FIRST, ahead of globals: a trigger-local shadows an object global of the same name, the
  // same way a procedure local does below.
  const triggerLocal = triggerScopeVar(name, callNode, matches);
  if (triggerLocal !== null) return triggerLocal;

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
 * The declaration of `name` in the nearest enclosing TRIGGER's own `var` section, or `null`.
 *
 * Stops at the FIRST enclosing trigger and does not keep walking: an outer trigger cannot be an
 * enclosing scope for an inner one in AL, and continuing would invent a nesting the language does
 * not have. A call in no trigger at all returns `null` and the ordinary procedure/global path
 * below handles it unchanged.
 *
 * `collectVarDeclarations` is shared with `buildSymbolTable` rather than reimplemented here, so a
 * grammar change moves both together — a second parser for the same node shape is exactly what
 * drifts (see ROADMAP R80 for the version of this mistake that is already in the tree).
 */
function triggerScopeVar(
  name: string,
  callNode: ALSyntaxNode,
  matches: (v: VarSymbol) => boolean,
): VarSymbol | null {
  void name;
  let current: ALSyntaxNode | null = callNode.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.trigger) {
      const varSection = declarationMembers(current).find((c) => c.kind === ALNodeKind.var_section);
      if (varSection === undefined) return null;
      return collectVarDeclarations(varSection).find(matches) ?? null;
    }
    current = current.parent;
  }
  return null;
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
 * hence `projectDeclaresProcedureOnTable` resolving it through `resolveObject` (which matches id
 * and name alike) rather than by name comparison.
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
 * Does this project declare a procedure named `procName` ON the table `tableRef` — in the table's
 * own declaration, or in any `tableextension` of it?
 *
 * `tableRef` is whatever the `record_type`'s `reference` field held, which is a table NAME
 * (`Record Customer`, `Record "Sales Line"`) or a table ID — `R: Record 50004` is legal AL and
 * measures as `reference: integer "50004"`. Resolution therefore goes through
 * `symbols.resolveObject`, which matches id and name alike
 * (`packages/engine/src/semantic/symbol-table.ts`); a hand-rolled name-only loop silently never
 * matched the id form, so `R.SetRange(...)` on a table declaring its own `SetRange` was CLAIMED.
 *
 * THE EXTENSION HALF is the same defect one object kind over. In AL a `tableextension`'s public
 * procedures are callable on a variable of the extended table's type, so
 * `tableextension "Ext" extends "Other Table" { procedure SetRange(A; B) }` makes
 * `Other.SetRange('A','B')` that procedure — measured true against the vendored grammar before
 * this guard existed, which is a WRONG CLAIM: it mislabels the mutation and, under §3.2 dedup
 * precedence, suppresses the correct Tier-1 `void-method-call` mutant at the same site. Unlike
 * the missing-call-site limit in `OBJECT_KINDS` (safe direction, still open) this one pointed the
 * dangerous way, so it is closed rather than documented.
 *
 * The extension scan does NOT require the base table to be in the project. A project
 * `tableextension` over a base-app table (`extends Customer`) is ordinary BC, the extended table
 * is invisible to a source-only symbol table, and refusing to look would leave exactly the same
 * wrong claim standing for the most common real-world spelling of it.
 *
 * "In the project" means across every file in the semantic context, per spec §4.1 — see
 * `generateMutationSet` in `packages/runner/src/orchestrator.ts`, which builds one context over
 * every parsed file precisely so this guard can fire on the normal one-object-per-file layout.
 */
function projectDeclaresProcedureOnTable(
  symbols: SymbolTable,
  tableRef: string,
  procName: string,
): boolean {
  const table = resolveTable(symbols, tableRef);
  if (table !== null && declaresProcedure(table.node, procName)) return true;
  // Match extensions on the table's resolved NAME when we have one (so the `Record 50004` id
  // spelling still finds `extends "The Table"`), and on the raw reference otherwise.
  if (table !== null && extensionDeclaresProcedure(symbols, table.name, procName)) return true;
  return extensionDeclaresProcedure(symbols, tableRef, procName);
}

/**
 * Does any project `tableextension` whose `extends` target is `tableName` declare `procName`?
 *
 * Name comparison is case-insensitive because AL is; `ExtensionSymbol.baseObject` is the extends
 * target with quotes already stripped, so `extends "Other Table"` and `extends Customer` compare
 * the same way.
 */
function extensionDeclaresProcedure(
  symbols: SymbolTable,
  tableName: string,
  procName: string,
): boolean {
  for (const ext of symbols.tableExtensions) {
    if (!equalsIgnoreCase(ext.baseObject, tableName)) continue;
    if (declaresProcedure(ext.node, procName)) return true;
  }
  return false;
}

/**
 * The project's `table` object for an id-or-name reference.
 *
 * `resolveObject` handles the id form and an exact name match, but its name comparison is
 * case-SENSITIVE while AL is not, so a case-insensitive scan backs it up. Losing that would move
 * this guard in the dangerous direction (fewer refusals means more wrongly claimed sites), which
 * is why the fallback is here rather than left to `resolveObject`'s own semantics.
 *
 * `null` is NOT "no such table" — it is "no table DECLARED in this project", which a base-app
 * table also produces. Callers must not treat it as permission to claim; see
 * `projectDeclaresProcedureOnTable`, which still scans extensions when this returns null.
 */
/**
 * The table a `tableextension` extends, from its header's `base_object` field
 * (`tableextension 50100 "X" extends Customer`), or `null` when the grammar did not supply it.
 *
 * Never the extension's OWN name: rule 3 must be able to see a procedure declared on the EXTENDED
 * table, and a resolution returning the extension's name would look successful while silently
 * bypassing that guard. A test pins exactly that mistake.
 */
function extendedTableOf(objectNode: ALSyntaxNode): string | null {
  const base = objectNode.childForFieldName("base_object");
  if (base === null) return null;
  const name = stripQuotes(base.text);
  return name === "" ? null : name;
}

/**
 * R67: the table a plain `page` is sourced on, from its own `SourceTable = "X";` property.
 *
 * A page's implicit `Rec` is that table, named in the same file with nothing to guess — which is
 * why this is RESOLUTION and not the inference `resolveReceiver` refuses elsewhere. Measured with
 * `scripts/probe-r30-pageext.ts` on Continia Document Output Cloud: 66 Tier-2-shaped calls sit on
 * a page's implicit `Rec` (against 210 on record vars declared in the same page, which already
 * claimed).
 *
 * `SourceTable` is a PROPERTY, not a grammar field of the header, so it is read from the object's
 * members. The grammar exposes `name`/`value` fields on a `property` node (measured against the
 * vendored tree-sitter-al v3.0.1 wasm, not assumed), so this does not scrape text.
 *
 * Returns `null` when the page declares no `SourceTable` — a real shape (a card page over no
 * record) and the honest answer is "no implicit record", not a default.
 */
function sourceTableOf(objectNode: ALSyntaxNode): string | null {
  for (const member of declarationMembers(objectNode)) {
    if (member.kind !== ALNodeKind.property) continue;
    const name = member.childForFieldName("name");
    if (name === null || !equalsIgnoreCase(name.text, "SourceTable")) continue;
    const value = member.childForFieldName("value");
    if (value === null) return null;
    const table = stripQuotes(value.text);
    return table === "" ? null : table;
  }
  return null;
}

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
