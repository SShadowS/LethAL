/**
 * Receiver resolution — the single predicate every operator that needs it depends on.
 *
 * MOVED here from `builtin-tier2/src/receiver.ts` (R159 spike, 2026-08-26). It served Tier 2
 * alone, so a Tier-1 operator that had to CEDE to a Tier-2 one could not ask the same question
 * and had to re-state the predicate — which is how `flip-boolean-literal` came to cede by method
 * name while `swap-modify-flag` claims by name AND a resolved receiver, orphaning 55 sites that
 * neither then claimed. That is R171's seam bug, and a shared predicate is what makes it
 * structurally impossible rather than a thing to remember.
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
import { soleArgument } from "../ast/arguments";
import { maskAlNonCode } from "../ast/mask";
import { ALNodeKind } from "../ast/node-kinds";
import { fieldSegments, nameSegments } from "../ast/qualified-name";
import type { ALSyntaxNode } from "../ast/syntax-node";
import {
  allProcedureLikes,
  declarationMembers,
  findEnclosingProcedure,
  isProcedureLike,
  memberArms,
} from "../ast/tree-walks";
import { type NodeArm, type SemanticContext, rawArmOf } from "./context";

/** R405 (a): the context's raw arm reader (`rawArmOf`); `undefined` without an arm map. */
type ArmReader = ((node: ALSyntaxNode) => NodeArm) | undefined;
import {
  type ObjectSymbol,
  type ProcedureSymbol,
  type SymbolTable,
  type VarSymbol,
  collectVarDeclarations,
  enclosingTrigger,
  extensionScopeKey,
  objectScopeKeyOfNode,
  qualifiedObjectName,
  triggerLocalNames,
} from "./symbol-table";

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
 *
 * - `reportextension` (R-463) — PARTIAL. Its own variables resolve under
 *   `extensionScopeKey("reportextension", name)`, and a data item it ADDS (`addfirst(X) {
 *   dataitem(D; T) }`) binds `T` like a report's own data item. A `modify(X)` block's implicit
 *   record stays unresolved (see `recordScopesAt`), so does its request page, and `claimsSystemCall`
 *   refuses every site in one (a bare `Commit()` there may bind a base-report procedure).
 */
const OBJECT_KINDS: ReadonlySet<string> = new Set<string>([
  ALNodeKind.codeunit,
  ALNodeKind.table,
  ALNodeKind.page,
  ALNodeKind.report,
  ALNodeKind.tableextension,
  ALNodeKind.pageextension,
  ALNodeKind.reportextension,
]);

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
  // R405 (a): rule 3 ignores a namesake declared only in an arm the build compiles out.
  const armOf = rawArmOf(ctx);

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
    // R-464: the record a bare call binds to, from the one resolver (`recordScopesAt`): the
    // innermost `with` subject, report dataitem or implicit record (a TableNo codeunit's `OnRun`
    // too). A `with` subject wins over the implicit record.
    const implicitTable = bareRecordAt(node, symbols)?.table ?? null;
    if (implicitTable === null) return false;
    // GUARD: project-declared procedure (rule 3). The table itself, AND any `tableextension` of
    // it — an extension's procedure is callable on the implicit `Rec` here exactly as the table's
    // own is. Keyed on the EXTENDED table, so a site inside one extension is still guarded by a
    // procedure another extension declares on the same table.
    if (declaresProcedure(objectNode, target.name, armOf)) return false;
    if (projectDeclaresProcedureOnTable(symbols, implicitTable, target.name, armOf)) return false;
    return true;
  }

  const receiver = resolveReceiver(target.receiver, node, symbols);

  // GUARD: unresolvable receiver (rule 4).
  if (receiver.kind === "unresolved") return false;
  // GUARD: receiver resolves to a non-record in source (rule 2).
  if (receiver.kind === "non-record") return false;

  // GUARD (rule 3, qualified form): the receiver is a record, and this project declares a
  // procedure of that name ON that table — in the table itself or in a `tableextension` of it —
  // so the call is that procedure and not the builtin.
  if (
    receiver.tableRef !== null &&
    projectDeclaresProcedureOnTable(symbols, receiver.tableRef, target.name, armOf)
  ) {
    return false;
  }

  return true;
}

/** The Record methods whose RunTrigger `lethal.swap-modify-flag` claims. */
export const RUN_TRIGGER_METHODS = ["Modify", "Insert", "Delete"] as const;
export type RunTriggerMethod = (typeof RUN_TRIGGER_METHODS)[number];

/**
 * WHICH of `RUN_TRIGGER_METHODS` does `node` call on a proven record receiver, or `null`? This
 * file's spelling of the name, matched case-insensitively through `claimsRecordMethod`.
 */
export function claimedRunTriggerMethod(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): RunTriggerMethod | null {
  return RUN_TRIGGER_METHODS.find((m) => claimsRecordMethod(node, ctx, m)) ?? null;
}

/**
 * R-459: the SKIP site `lethal.swap-modify-flag` claims, as the method and the literal it flips:
 * a claimed `RUN_TRIGGER_METHODS` call whose SOLE argument (comment-aware, `soleArgument`) is the
 * literal `true`. Else `null`: `Insert()` has no literal, `Insert(true, X)` and longer are not
 * claimed, and an unresolved receiver or a project namesake is refused by `claimsRecordMethod`.
 *
 * ONE answer for two operators: Tier 2 claims what this returns, and `flip-boolean-literal` cedes
 * exactly the literal it returns, so the seam cannot orphan or duplicate a site (R171, R-459).
 */
export function claimedRunTriggerSkip(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): { method: RunTriggerMethod; literal: ALSyntaxNode } | null {
  const only = soleArgument(node);
  if (only === null || only.kind !== ALNodeKind.boolean_literal) return null;
  if (only.text.toLowerCase() !== "true") return null;
  const method = claimedRunTriggerMethod(node, ctx);
  return method === null ? null : { method, literal: only };
}

/**
 * R-364: is `node` a call to `methodName` whose receiver this project's source cannot resolve
 * (`claimsRecordMethod`'s rule 4)? R479: a BARE call too, through `implicitRecordUnresolved`.
 * For conservative screen TAGGING only, never for
 * claiming: a platform-kill tag must stay where nothing proves the skip harmless, and an
 * unresolved receiver proves nothing (R143). Inside an object the symbol table does not index
 * (R343) every receiver outside a trigger's own `var` section is unresolved.
 *
 * R-254, R-463: inside a `reportextension` a qualified receiver resolves like anywhere else (its
 * own variables, an added data item), so one that resolves loses the tag; a `modify(X)` record or
 * a base report's `protected var` stays unresolved and keeps it. An extension whose name did not
 * parse keeps every tag.
 */
export function receiverUnresolved(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  methodName: string,
): boolean {
  if (node.kind !== ALNodeKind.procedure_call) return false;
  const callee = node.childForFieldName("function");
  if (callee === null) return false;
  const target = describeCallee(callee);
  if (target === null) return false;
  if (!equalsIgnoreCase(target.name, methodName)) return false;
  if (target.receiver === null) return implicitRecordUnresolved(node, ctx, target.name);
  const objectNode = enclosingObject(node);
  if (objectNode === null) return false;
  const objectName = objectNameOf(objectNode);
  if (objectName === null) return objectNode.kind === ALNodeKind.reportextension;
  return resolveReceiver(target.receiver, node, ctx.symbols).kind === "unresolved";
}

/**
 * R479: the BARE form of `receiverUnresolved`. A bare call binds the innermost record scope
 * (`recordScopesAt`). It is unresolved when that record exists but its table is not provable (a
 * pageextension's `Rec`, a reportextension request page or `modify`, a `with` subject that is not
 * a provable table), or when it sits outside `OBJECT_KINDS` or in an object whose name did not
 * parse, where `claimsRecordMethod` refuses every call (R-463: a reportextension's added data item
 * now resolves like a report's). NOT unresolved, checked first: no record scope at all (a
 * codeunit outside a TableNo `OnRun`, a page without `SourceTable`: the call is not a record
 * method); a procedure of that name declared by the
 * enclosing object, or by the project on the scope's known table or a tableextension of it (rule
 * 3); a `with` subject DECLARED as a non-record (R460's control). A `with` subject that is not
 * declared where the index can see it counts as unresolved and is tagged.
 */
function implicitRecordUnresolved(node: ALSyntaxNode, ctx: SemanticContext, name: string): boolean {
  const symbols = ctx.symbols;
  const armOf = rawArmOf(ctx);
  const [scope] = recordScopesAt(node, symbols);
  if (scope === undefined) return false;
  const objectNode = enclosingObject(node);
  if (objectNode !== null && declaresProcedure(objectNode, name, armOf)) return false;
  if (scope.table !== null && projectDeclaresProcedureOnTable(symbols, scope.table, name, armOf))
    return false;
  if (scope.kind === "with" && scope.at !== undefined && withSubjectIsNonRecord(scope.at, symbols))
    return false;
  if (objectNode === null || objectNameOf(objectNode) === null) return true;
  return scope.table === null;
}

/** R479: is a `with` statement's subject declared as a non-record (a codeunit, a Text...)? */
function withSubjectIsNonRecord(at: ALSyntaxNode, symbols: SymbolTable): boolean {
  const subject = at.childForFieldName("record");
  const subjectName = subject === null ? null : identifierText(subject);
  if (subjectName === null) return false;
  return resolveReceiverName(subjectName, at, symbols).kind === "non-record";
}

/**
 * R143: the TABLE a claimed record call's receiver resolves to, by name, or `null` when this
 * project's source cannot prove one.
 *
 * Exists because a tag or a refusal sometimes depends on the target TABLE rather than on the call
 * — `swap-modify-flag` needs the receiver's `OnInsert` to decide whether skipping it can raise a
 * platform error. It lives here, beside `claimsRecordMethod`, and shares that predicate's
 * `describeCallee` / `enclosingObject` / `resolveReceiver` path rather than resolving a receiver a
 * second way. Two parsers for one node shape is the mistake ROADMAP R80 already records.
 *
 * `null` covers three genuinely different situations and deliberately does not distinguish them,
 * because no caller so far can act on the difference: the node is not a call at all, the receiver
 * is not provably a record, or it IS a record whose table this project cannot name (a base-app
 * `Record Customer`, whose `tableRef` is `null`). A caller that needs "resolved to nothing" to be
 * safe must decide what `null` means for ITS question — see `insertSkipCanRaise`
 * (`insert-key-assignment.ts`), which treats it as "cannot prove otherwise" and keeps its tag.
 *
 * Handles the implicit-receiver form the same way `claimsRecordMethod` does, and that is most of
 * the value: inside a table (or a `tableextension`, or a `page` with a `SourceTable`) a bare
 * `Insert(true)` has no receiver node to resolve, and a caller reaching for `resolveReceiver`
 * directly would silently answer `null` for every one of those sites.
 */
export function resolveReceiverTable(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) {
    throw new Error("resolveReceiverTable: a SemanticContext with a symbol table is required");
  }
  if (node.kind !== ALNodeKind.procedure_call) return null;
  const callee = node.childForFieldName("function");
  if (callee === null) return null;
  const target = describeCallee(callee);
  if (target === null) return null;
  const objectNode = enclosingObject(node);
  if (objectNode === null) return null;
  const objectName = objectNameOf(objectNode);
  if (objectName === null) return null;

  if (target.receiver === null) {
    // Implicit `Rec`, resolved exactly as `claimsRecordMethod` resolves it — including the
    // `pageextension` refusal, whose implicit record is the extended page's `SourceTable` and is
    // not visible here.
    return bareRecordAt(node, symbols)?.table ?? null;
  }

  const receiver = resolveReceiver(target.receiver, node, symbols);
  return receiver.kind === "record" ? receiver.tableRef : null;
}

/**
 * R564: the PROJECT table object a bare-name argument (`xRec`, a `Record X` variable or parameter)
 * binds to at `at`, or `null` unless that is certain. Loop-hazard narrows a callee's overloads with
 * it, and a wrong answer there re-deploys a hang, so every doubt is `null`:
 *   - the name's declaration is "unknown" (`lookupDeclaredState`: an ambiguous `#if` local, an
 *     unindexed member, a `#if` trigger-header name). `lookupVar` would answer `null` there and the
 *     resolver would fall through to the implicit record (opus R-564 plan review, I1);
 *   - a record field shadows the declaration (`fieldShadows`), or the declared type is not a Record;
 *   - an undeclared name: not exactly one implicit record spelled that way, or inside a `with`;
 *   - the table does not resolve to exactly one project table (`tableObjectOfRef`).
 */
export function recordTableObjectOfName(
  name: ALSyntaxNode,
  at: ALSyntaxNode,
  ctx: SemanticContext,
): ObjectSymbol | null {
  const symbols = ctx.symbols;
  const text = identifierText(name);
  const objectNode = enclosingObject(at);
  const objectName = objectNode === null ? null : objectNameOf(objectNode);
  if (text === null || objectNode === null || objectName === null) return null;
  const scopeOwner = scopeOwnerOf(objectNode, objectName);
  if (scopeOwner === null) return null;
  const found = lookupDeclaredState(text, at, scopeOwner, symbols);
  if (found === "unknown") return null;
  let ref: string | null;
  if (found !== null) {
    if (fieldShadows(text, at, symbols, symbols.globalsOf(scopeOwner).includes(found))) return null;
    const r = classifyDeclaredType(found, symbols);
    if (r.kind !== "record") return null;
    ref = r.tableRef;
  } else {
    const scopes = recordScopesAt(at, symbols);
    const want = lower(text);
    const hits = scopes.filter((s) => {
      const own = lower(stripQuotes(s.receiver));
      return s.kind !== "with" && (own === want || (want === "xrec" && own === "rec" && s.xRec));
    });
    const [only] = hits;
    if (scopes.some((s) => s.kind === "with") || hits.length !== 1 || only === undefined)
      return null;
    // A qualified `extends Ns."X"` parses as an ERROR node plus `base_object` "X", so the
    // extension's table reads as a project table that may not be the one it extends.
    if (objectNode.namedChildren.some((c) => c.rawKind === "ERROR")) return null;
    ref = only.table;
  }
  return ref === null ? null : tableObjectOfRef(ref, ctx);
}

/**
 * R564: the ONE project table a `Record` reference names, by id or by name (quotes stripped), or
 * `null`. Stricter than `resolveTable`, which returns the first of several same-named tables: two
 * tables sharing a name or an id make the reference unresolved, never a guess. So does any object the
 * symbol table does not index (`#if`-split header, `#if`-wrapped, unparsed) whose text MENTIONS the
 * reference: it may declare a second table of that name. Over-broad on purpose (it only keeps all).
 */
export function tableObjectOfRef(idOrName: string, ctx: SemanticContext): ObjectSymbol | null {
  const ref = stripQuotes(idOrName.trim());
  const { splitObjects, unindexedObjects, unparsedObjects } = ctx.symbols;
  if (
    [...splitObjects, ...unindexedObjects, ...unparsedObjects].some((o) =>
      lower(o.text).includes(lower(ref)),
    )
  )
    return null;
  const hits = ctx.symbols.objects.filter(
    (o) => o.kind === "table" && (equalsIgnoreCase(o.name, ref) || String(o.id) === ref),
  );
  const [only] = hits;
  return hits.length === 1 && only !== undefined ? only : null;
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
  // R405 (a): guard 2 ignores a namesake declared only in an arm the build compiles out.
  const armOf = rawArmOf(ctx);
  const callee = node.childForFieldName("function");
  if (callee === null) return false;
  const target = describeCallee(callee);
  if (target === null) return false;
  // GUARD 1: a qualified call of this name is a project procedure, never the system function.
  if (target.receiver !== null) return false;
  if (!equalsIgnoreCase(target.name, name)) return false;

  const objectNode = enclosingObject(node);
  if (objectNode === null) return false;
  // R-463: never inside a reportextension. A bare `Commit()` there may bind a procedure of the BASE
  // report (alc compiles `I := Commit();` against a base `procedure Commit(): Integer`), which this
  // guard cannot see when the base report is a dependency. Master never claimed here either.
  if (objectNode.kind === ALNodeKind.reportextension) return false;
  const objectName = objectNameOf(objectNode);
  if (objectName === null) return false;

  // GUARD 2: the enclosing object's own declaration wins over the system function.
  if (declaresProcedure(objectNode, target.name, armOf)) return false;
  // R549: inside a pageextension a bare call binds a VISIBLE procedure of the BASE page (alc 18.0.43,
  // R-547 measurement), so any project base-page candidate declaring one refuses.
  if (
    objectNode.kind === ALNodeKind.pageextension &&
    basePageDeclaresVisible(symbols, objectNode, target.name, armOf)
  )
    return false;
  // …and so does one added to the enclosing TABLE by an extension, which is callable on the
  // implicit `Rec` here exactly as the table's own is.
  // R67, R-464: every record a bare name here can bind to (each `with` subject, dataitem, and the
  // implicit record, a TableNo `OnRun`'s included); any of them declaring the name refuses.
  for (const scope of recordScopesAt(node, symbols)) {
    if (
      scope.table !== null &&
      projectDeclaresProcedureOnTable(symbols, scope.table, target.name, armOf)
    )
      return false;
  }
  return true;
}

// --- callee shape ----------------------------------------------------------

/**
 * The AST node holding a `procedure_call`'s method-NAME span: the callee itself for an unqualified
 * call (`TestField(...)`), or the `member` field of a qualified one's `field_access` callee
 * (`Rec.TestField(...)`). Reads exactly the `function` field and `field_access` member path
 * `describeCallee` already resolves for `claimsRecordMethod`, below, so a caller that needs the
 * name's OWN span shares that resolution instead of re-deriving "which node is the name" a second
 * time — precisely the second-parser-for-one-node-shape mistake this file's own module doc warns
 * drifts (R80).
 *
 * Two Tier-2 operators share this (docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md
 * §2.5): `lethal.swap-find-direction` splices its replacement over this node's own span (§2.2);
 * `lethal.validate-to-assign` slices the call's text UP TO this node's start as its receiver prefix
 * for the qualified form (§2.3, amendment 2). Both read the same node, so the two operators cannot
 * disagree with each other about where the method name starts or ends.
 *
 * Returns `null` for anything `describeCallee` itself cannot resolve: `node` is not a
 * `procedure_call`, the `function` field is missing, or the callee is a shape neither branch below
 * covers (a chained call, an arbitrary expression). Refuses rather than guesses, matching every
 * other predicate in this file.
 */
export function calleeNameNode(node: ALSyntaxNode): ALSyntaxNode | null {
  if (node.kind !== ALNodeKind.procedure_call) return null;
  const callee = node.childForFieldName("function");
  if (callee === null) return null;
  if (isIdentifierLike(callee)) return callee;
  if (callee.kind === ALNodeKind.field_access) {
    return callee.childForFieldName("member");
  }
  return null;
}

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
  symbols: SymbolTable,
): ResolvedReceiver {
  const receiverName = identifierText(receiver);
  if (receiverName === null) return { kind: "unresolved" };
  return resolveReceiverName(receiverName, callNode, symbols);
}

/** R-464: `resolveReceiver` by NAME at a position, so a `with` subject resolves the same way. */
function resolveReceiverName(
  receiverName: string,
  callNode: ALSyntaxNode,
  symbols: SymbolTable,
): ResolvedReceiver {
  const objectNode = enclosingObject(callNode);
  if (objectNode === null) return { kind: "unresolved" };
  const objectName = objectNameOf(objectNode);
  if (objectName === null) return { kind: "unresolved" };

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
  const scopeOwner = scopeOwnerOf(objectNode, objectName);
  if (scopeOwner === null) return { kind: "unresolved" };
  const declared = lookupVar(receiverName, callNode, scopeOwner, symbols);
  if (declared !== null) return classifyDeclaredType(declared, symbols);

  // Not declared anywhere the symbol table can see. R-464: an implicit record by the name it is
  // spelled with here (`Rec`, `xRec` where it exists, an enclosing dataitem's name), from the one
  // resolver. A `with` subject is never a qualified receiver's binding. A scope whose table is not
  // provable stays unresolved: a `pageextension`'s `Rec` is the extended PAGE's `SourceTable`,
  // which lives in an object this project usually cannot see (R30), and a reportextension `modify`.
  const want = lower(receiverName);
  for (const scope of recordScopesAt(callNode, symbols)) {
    if (scope.kind === "with") continue;
    const own = lower(stripQuotes(scope.receiver));
    if (own !== want && !(want === "xrec" && own === "rec" && scope.xRec)) continue;
    return scope.table === null
      ? { kind: "unresolved" }
      : { kind: "record", tableRef: scope.table };
  }
  return { kind: "unresolved" };
}

/** The symbol table's scope key for an object or extension node (R30, R70). */
function scopeOwnerOf(objectNode: ALSyntaxNode, objectName: string): string | null {
  return objectNode.kind === ALNodeKind.tableextension
    ? extensionScopeKey("tableextension", objectName)
    : objectNode.kind === ALNodeKind.pageextension
      ? extensionScopeKey("pageextension", objectName)
      : objectNode.kind === ALNodeKind.reportextension
        ? extensionScopeKey("reportextension", objectName)
        : objectScopeKeyOfNode(objectNode, objectName);
}

/** R-464: one record a bare name or a bare record-method call can bind to at some position. */
export interface RecordScope {
  readonly kind:
    | "with"
    | "table"
    | "tableextension"
    | "page"
    | "pageextension"
    | "codeunit"
    | "dataitem"
    | "requestpage"
    | "modify";
  /** How the record is spelled when qualified: `Rec`, a dataitem's name, a `with` subject's text
   *  (`""` when the subject is not a plain name). Raw source text, quotes kept. */
  readonly receiver: string;
  /** The table, or `null` where this source cannot prove it (pageextension, reportextension
   *  `modify` or request page, a `with` subject that does not resolve to a record). A data item a
   *  reportextension ADDS has its own table (R-463). */
  readonly table: string | null;
  /** Does `xRec` exist beside `Rec` here? */
  readonly xRec: boolean;
  /** The `with` statement, for a `with` scope. */
  readonly at?: ALSyntaxNode;
}

/**
 * R-464: every record a bare name at `node` can bind to, INNERMOST FIRST. The one implicit-record
 * resolver: bare and qualified claims, rule 3, `receiverUnresolved` and `lookupVar`'s guard read it.
 *   - each enclosing `with` BODY's subject, resolved by the same receiver resolver;
 *   - each enclosing report dataitem (an outer one's fields are visible too);
 *   - then the object's implicit record, per R294's measured rules (`types.ts`
 *     `implicitRecordShadowsGlobals`): table and tableextension `Rec`/`xRec`; a page's
 *     `SourceTable`; a pageextension (table unknown); a TableNo codeunit's `OnRun` only (`Rec`, no
 *     `xRec`: alc 18.0.43, AL0118 / AL0161); a request page with a `SourceTable` (any
 *     reportextension request page, table unknown); a reportextension `modify(X)`'s X (unknown).
 * Loop-hazard's `implicitRecordsAt` stays separate on purpose: a hang refusal needs "could bind"
 * (an `#if`-arm-aware over-approximation), a claim needs "does bind" (this one).
 */
export function recordScopesAt(node: ALSyntaxNode, symbols: SymbolTable): RecordScope[] {
  const out: RecordScope[] = [];
  for (let p = node.parent; p !== null; p = p.parent) {
    switch (p.rawKind) {
      case "with_statement": {
        const body = p.childForFieldName("body");
        if (body === null || node.startIndex < body.startIndex || node.endIndex > body.endIndex)
          continue;
        const subject = p.childForFieldName("record");
        const name = subject === null ? null : identifierText(subject);
        const resolved = name === null ? null : resolveReceiverName(name, p, symbols);
        out.push({
          kind: "with",
          receiver: name === null || subject === null ? "" : subject.text,
          table: resolved?.kind === "record" ? resolved.tableRef : null,
          xRec: false,
          at: p,
        });
        continue;
      }
      case "report_dataitem": {
        const name = p.childForFieldName("name");
        out.push({
          kind: "dataitem",
          receiver: name?.text ?? "",
          // R502: every segment of `System.Utilities.Integer`, not the first.
          table: qualifiedObjectName(fieldSegments(p, "table_name"), "table", symbols),
          xRec: false,
        });
        continue;
      }
      case "modify_modification": {
        // Only a reportextension dataset's `modify(X)`; a tableextension field's or pageextension
        // control's `modify` has the same node kind and binds nothing new.
        if (!hasAncestor(p, (a) => a.rawKind === "reportextension_declaration")) continue;
        // R-463, a NAMED refusal: the record is the base report's data item X, whose table is
        // knowable when the base report is in the project. It stays `null` (unresolved, refused):
        // resolving X through the base report (unique report, unique data item) added 0 claimed
        // sites on every corpus, measured 2026-10-09 (BC.History's four projects with
        // reportextensions and the tables fixture), so it would be code no gate exercises.
        const name = p.childForFieldName("target");
        out.push({ kind: "modify", receiver: name?.text ?? "", table: null, xRec: false });
        continue;
      }
      case "requestpage_section": {
        const inExtension = p.parent?.parent?.rawKind === "reportextension_declaration";
        const table = inExtension ? null : sourceTableOf(p, symbols);
        if (inExtension || table !== null)
          out.push({ kind: "requestpage", receiver: "Rec", table, xRec: false });
        return out;
      }
      case "reportextension_declaration":
        return out;
    }
    switch (p.kind) {
      case ALNodeKind.table:
        out.push({ kind: "table", receiver: "Rec", table: objectNameOf(p), xRec: true });
        return out;
      case ALNodeKind.tableextension:
        out.push({
          kind: "tableextension",
          receiver: "Rec",
          table: extendedTableOf(p),
          xRec: true,
        });
        return out;
      case ALNodeKind.page: {
        const table = sourceTableOf(p, symbols);
        if (table !== null) out.push({ kind: "page", receiver: "Rec", table, xRec: true });
        return out;
      }
      case ALNodeKind.pageextension:
        out.push({ kind: "pageextension", receiver: "Rec", table: null, xRec: true });
        return out;
      case ALNodeKind.codeunit: {
        const table = propertyValueOf(p, "TableNo", symbols);
        const trigger = enclosingTrigger(node)?.childForFieldName("name")?.text;
        if (table !== null && trigger !== undefined && equalsIgnoreCase(trigger, "OnRun"))
          out.push({ kind: "codeunit", receiver: "Rec", table, xRec: false });
        return out;
      }
      case ALNodeKind.report:
        return out;
    }
  }
  return out;
}

/** R-464: the record a BARE record-method call binds to (the innermost scope), when provable. */
function bareRecordAt(node: ALSyntaxNode, symbols: SymbolTable): RecordScope | null {
  const [innermost] = recordScopesAt(node, symbols);
  return innermost !== undefined && innermost.table !== null ? innermost : null;
}

/**
 * R-464: the receiver a bare record-method call at `node` binds to, spelled out (`Rec`, a
 * dataitem's name, a `with` subject), for an operator that must write it (`validate-to-assign`).
 * `null` unless PROVEN: the spelling is not the binding. The name, resolved at the call, must bind
 * the very record the call binds to (sol r1-r3, Opus r4-r5):
 *   - every record a bare name reaches here has a table DECLARED in this project, and none of them
 *     (nor any project tableextension of it, in any `#if` arm) has a field or procedure of that
 *     name, which would capture the qualification;
 *   - for an implicit record or dataitem, the name is PROVABLY undeclared here (a local `Rec`
 *     would capture it; an `#if`-only or unindexed declaration counts as declared), and the first
 *     implicit scope spelled that way is this one;
 *   - for a `with` subject, the name means the same declaration at the call as at the `with`.
 */
export function bareReceiverText(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  const symbols = ctx.symbols;
  const scopes = recordScopesAt(node, symbols);
  const [scope] = scopes;
  if (scope === undefined || scope.table === null || scope.receiver === "") return null;
  const name = stripQuotes(scope.receiver);
  for (const s of scopes) {
    if (s.table === null) return null;
    const table = resolveTable(symbols, s.table);
    if (table === null || mayHaveMember(symbols, table, name)) return null;
  }
  const atCall = declarationAt(name, node, symbols);
  if (atCall === "unknown") return null;
  if (scope.kind === "with") {
    if (scope.at === undefined || atCall === null) return null;
    const atWith = declarationAt(name, scope.at, symbols);
    return atWith !== null &&
      atWith !== "unknown" &&
      atWith.node.startIndex === atCall.node.startIndex
      ? scope.receiver
      : null;
  }
  if (atCall !== null) return null;
  const named = scopes.find(
    (s) => s.kind !== "with" && lower(stripQuotes(s.receiver)) === lower(name),
  );
  return named === scope ? scope.receiver : null;
}

/**
 * R477: may the BARE assignment `field := V` stand for a bare `Validate(field, V)` at `node` whose
 * receiver spelling `bareReceiverText` cannot prove? Only where the call's innermost record scope
 * has a table and `field` is PROVABLY undeclared at the call (`declarationAt` is `null`): no
 * trigger local, local, parameter, named return value or object global, matched case-insensitively
 * with quotes stripped; an `#if`-only, unindexed or symbol-less declaration is `"unknown"` and
 * refuses. Measured with alc 18.0.43 (coord handoff `R-477`): a local, parameter or return value
 * captures a bare assignment everywhere but inside `with`, and an object global does in a table or
 * tableextension, so all of those are refused (globals elsewhere too, conservatively). With nothing
 * declared the name binds the innermost record's field: the `with` subject over a competing `Rec`,
 * the inner dataitem. Not checked, and measured harmless: a field named like a system method or an
 * enum type binds the field; a procedure named like the field (another tableextension, a
 * dependency table) breaks the original `Validate` too; a dependency table's or page's global
 * does not capture.
 */
export function bareFieldAssignable(
  node: ALSyntaxNode,
  field: string,
  ctx: SemanticContext,
): boolean {
  const [scope] = recordScopesAt(node, ctx.symbols);
  if (scope === undefined || scope.table === null) return false;
  return declarationAt(stripQuotes(field), node, ctx.symbols) === null;
}

/**
 * R-464: the declaration a bare `name` binds to at `node`, in three states: `null` only when
 * PROVABLY absent; `"unknown"` for any refusal that is not absence (`lookupDeclaredState`), and
 * also whenever the visible source text declares `name` where the index does not show it (inside
 * `#if`, in an unindexed member, swallowed by the grammar).
 */
function declarationAt(
  name: string,
  node: ALSyntaxNode,
  symbols: SymbolTable,
): VarSymbol | null | "unknown" {
  const objectNode = enclosingObject(node);
  const objectName = objectNode === null ? null : objectNameOf(objectNode);
  if (objectNode === null || objectName === null) return "unknown";
  const scopeOwner = scopeOwnerOf(objectNode, objectName);
  if (scopeOwner === null) return "unknown";
  const found = lookupDeclaredState(name, node, scopeOwner, symbols);
  if (found !== null) return found;
  return declaresName(visibleDeclarationText(node, objectNode), name) ? "unknown" : null;
}

/**
 * The source text whose declarations are visible at `node`: its own procedure or trigger, plus the
 * object with every OTHER procedure and trigger blanked out (offsets kept). With `node` null, every
 * procedure and trigger is blanked.
 */
function visibleDeclarationText(node: ALSyntaxNode | null, objectNode: ALSyntaxNode): string {
  const own = node === null ? null : (findEnclosingProcedure(node) ?? enclosingTrigger(node));
  const spans: [number, number][] = [];
  const walk = (n: ALSyntaxNode): void => {
    for (const c of n.namedChildren) {
      if (isProcedureLike(c) || c.kind === ALNodeKind.trigger)
        spans.push([c.startIndex, c.endIndex]);
      else walk(c);
    }
  };
  walk(objectNode);
  let text = objectNode.text;
  const base = objectNode.startIndex;
  for (const [a, b] of spans.reverse()) {
    if (own !== null && own.startIndex === a) continue;
    text = `${text.slice(0, a - base)}${" ".repeat(b - a)}${text.slice(b - base)}`;
  }
  return text;
}

/**
 * Does `text` declare `name`: `name :` alone or inside a comma-separated list (`Rec, Dummy: X`),
 * never `:=` or `::`? Read through the engine's lexer (`maskAlNonCode`, strings blanked), with
 * every preprocessor line blanked too, so all `#if` arms read together: that can only add refusals.
 */
function declaresName(text: string, name: string): boolean {
  const code = maskAlNonCode(text, { blankStringContents: true }).replace(/^[ \t]*#.*$/gm, (m) =>
    " ".repeat(m.length),
  );
  const esc = escapeRegExp(name);
  // Unicode letters (`u`): an ASCII-only class stopped a list at a name like `Beløb`.
  const id = `(?:"[^"\\n]*"|[\\p{L}_][\\p{L}\\p{N}_]*)`;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_".])("${esc}"|${esc})(\\s*,\\s*${id})*\\s*:(?![=:])`,
    "iu",
  ).test(code);
}

/**
 * Could a field or procedure named `member` exist on `table`? Read by TEXT through the engine's
 * lexer, so one in any `#if` arm counts: the table itself, every project tableextension of it
 * (indexed or wrapped whole in `#if`), and any unparsed object that says `tableextension`. A
 * procedure counts like a field (refused by ruling, not measured with alc).
 */
function mayHaveMember(symbols: SymbolTable, table: ObjectSymbol, member: string): boolean {
  const esc = escapeRegExp(member);
  const field = new RegExp(`\\bfield\\s*\\(\\s*\\d+\\s*;\\s*("${esc}"|${esc})\\s*;`, "i");
  const proc = new RegExp(`\\bprocedure\\s+("${esc}"|${esc})\\s*\\(`, "i");
  const holds = (text: string): boolean => {
    const code = maskAlNonCode(text, { blankStringContents: true });
    return field.test(code) || proc.test(code);
  };
  if (holds(table.node.text)) return true;
  const name = table.name.toLowerCase();
  const id = table.node.childForFieldName("object_id")?.text ?? "";
  const extendsIt = (base: string): boolean => {
    const b = stripQuotes(base).toLowerCase();
    return b === name || (id !== "" && b === id);
  };
  for (const ext of symbols.tableExtensions)
    if (extendsIt(ext.baseObject) && holds(ext.node.text)) return true;
  for (const o of symbols.unindexedObjects) {
    const base = o.childForFieldName("base_object")?.text ?? "";
    if (o.kind === ALNodeKind.tableextension && extendsIt(base) && holds(o.text)) return true;
  }
  // R494: a split-header tableextension is in no index above, so it is read like unparsed source.
  return [...symbols.unparsedObjects, ...symbols.splitObjects].some(
    (o) => identifierTokens(o.text).has("tableextension") && holds(o.text),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * R-464, the PRECISE guard in `lookupVar`: does a bare `name` at `node` bind a record field before
 * the variable found? A `with` subject's field beats every variable; an implicit record's field
 * beats an object GLOBAL only (R294), never in a table or tableextension (there the global wins).
 * Only a field this project declares on that table counts: an unknown table proves nothing, so the
 * variable stands. Never `types.ts`'s blanket refusal, which would blind the hang check.
 */
function fieldShadows(
  name: string,
  node: ALSyntaxNode,
  symbols: SymbolTable,
  global: boolean,
): boolean {
  for (const scope of recordScopesAt(node, symbols)) {
    if (scope.table === null) continue;
    const implicit = scope.kind !== "with";
    if (implicit && (!global || scope.kind === "table" || scope.kind === "tableextension"))
      continue;
    const table = resolveTable(symbols, scope.table)?.name ?? scope.table;
    if (symbols.fieldsOf(table).some((f) => equalsIgnoreCase(f.name, name))) return true;
  }
  return false;
}

/**
 * Find the declaration of `name` visible at the call site: a TRIGGER's own `var` section first (if
 * the call sits inside one), then the enclosing procedure's locals (with its named return value,
 * R323), then its parameters, then the object's globals. A trigger's named return value is unknown
 * and resolves to nothing (R323, through `triggerLocalNames`).
 *
 * The trigger case is resolved from the AST node rather than from a name-keyed map (see
 * `triggerScopeVar`, below): `buildSymbolTable` indexes `procedure` members only, deliberately,
 * because trigger names repeat across an object (every field may declare its own `OnValidate`) and
 * a name key would be ambiguous there. This was a stale doc comment before R196: R68 added
 * `triggerScopeVar` directly beneath this function, so trigger locals ARE found; only a name
 * genuinely undeclared anywhere in scope falls through to `null`.
 */
export function lookupVar(
  name: string,
  callNode: ALSyntaxNode,
  objectName: string,
  symbols: SymbolTable,
): VarSymbol | null {
  const found = lookupDeclaredState(name, callNode, objectName, symbols);
  if (found === null || found === "unknown") return null;
  // R-464: the precise field-over-variable guard (`fieldShadows`).
  const global = symbols.globalsOf(objectName).includes(found);
  return fieldShadows(name, callNode, symbols, global) ? null : found;
}

/**
 * `lookupVar`'s search, in three states: `null` = provably no declaration of `name` here;
 * `"unknown"` = a refusal that is NOT absence (R330's trigger-header `#if` name, R331's unindexed
 * member, R302's ambiguous name; `lookupVar` answers `null` for both); else the declaration.
 */
function lookupDeclaredState(
  name: string,
  callNode: ALSyntaxNode,
  objectName: string,
  symbols: SymbolTable,
): VarSymbol | null | "unknown" {
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
  // R330 (run 002 fix round): a name the enclosing trigger declares elsewhere in its header (inside
  // a `#if` region, which `triggerScopeVar` does not read) is unknown, never a global.
  const trigger = enclosingTrigger(callNode);
  if (trigger !== null && triggerLocalNames(trigger).has(name.toLowerCase())) return "unknown";

  const procedure = findEnclosingProcedure(callNode);
  if (procedure !== null) {
    // R210: resolved by the declaration's POSITION, not its name. AL lets one object declare
    // several procedures with the same name distinguished by parameter list, and `alc` compiles
    // that, so asking by name answered every site inside the second or later declaration with the
    // FIRST one's locals and parameters. Not as null, which would have been noticed, but as a real
    // symbol belonging to a different procedure, which was measured as the largest single cause of
    // unresolved variable references on both reference corpora.
    //
    // The name lookup is kept as a fallback for the case the positional one cannot serve: a
    // procedure whose declaration node is not in this scope's index at all. That answers exactly
    // what it answered before, so the fallback cannot regress a project that has no overloads.
    // R327: an unindexed split member (swallowed into the global var section) resolves nothing,
    // neither by name nor through the globals below. See `resolveIdentifierType` (types.ts).
    // R331 (run 003): an unindexed member of ANY shape resolves nothing, neither by name nor
    // through the globals below. See `resolveIdentifierType` (types.ts).
    const symbol = symbols.resolveProcedureAt(objectName, procedure.startIndex);
    if (symbol === null) return "unknown";
    {
      // R302: an ambiguous name resolves to nothing, and never to a global of that name.
      if (symbol.ambiguous?.includes(name.toLowerCase())) return "unknown";
      const local = symbol.locals.find(matches);
      if (local !== undefined) return local;
      const parameter = symbol.parameters.find(matches);
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
 *
 * R502: a qualified `Record System.Utilities.Integer` is three `reference` children; the reference
 * is read through `qualifiedObjectName`, never by its first segment.
 */
function classifyDeclaredType(
  declaration: VarSymbol,
  symbols: Pick<SymbolTable, "objects">,
): ResolvedReceiver {
  // R323: a named return value's node is its `return_value` identifier; its type is the
  // `return_type` that follows it in the same parent (for a split member, in the same arm).
  const typeNode = declaration.node.childForFieldName("type") ?? returnTypeAfter(declaration.node);
  if (typeNode === null) return { kind: "unresolved" };
  const recordType = typeNode.namedChildren.find((c) => c.kind === ALNodeKind.record_type);
  if (recordType === undefined) return { kind: "non-record" };
  return {
    kind: "record",
    tableRef: qualifiedObjectName(fieldSegments(recordType, "reference"), "table", symbols),
  };
}

// --- project-declared procedures ------------------------------------------

/**
 * Does this object declare a procedure of that name? Case-insensitively, and
 * through `declarationMembers` so v3's `declaration_body` container is skipped
 * — a hand-rolled `namedChildren` walk silently matches nothing here.
 */
function declaresProcedure(objectNode: ALSyntaxNode, name: string, armOf: ArmReader): boolean {
  // R327: a split member swallowed into the global var section is still a member of the object.
  // R327, R331: every procedure-like declaration counts, wherever the grammar put it: a direct
  // member, one swallowed by the global var section, or one wrapped whole in `#if`.
  // R405 (a): except one the build compiles out (`inactive`). Deliberately NOT `liveMembers`, which
  // would drop the swallowed and `#if`-object ones, and an undecided one still counts: over-refusal
  // costs one site, a wrong claim costs a mislabelled mutant or the build.
  for (const member of allProcedureLikes(objectNode)) {
    if (!isProcedureLike(member)) continue;
    if (armOf !== undefined && armOf(member) === "inactive") continue;
    for (const nameNode of member.children.filter((c) => c.fieldName === "name"))
      if (equalsIgnoreCase(stripQuotes(nameNode.text), name)) return true;
  }
  return false;
}

/**
 * R549: does any project page a pageextension may extend declare a procedure `name` that the
 * extension can see? Candidates are every page of the `extends` name (indexed, or wrapped whole in
 * `#if`, any arm), plus any split-header or unparsed object whose text names a page, the base and
 * `name` (the conservative token rule of `projectDeclaresProcedureOnTable`; it over-matches: ANY
 * such object whose text holds those three tokens refuses, page or not, local or not). A `local`
 * procedure is invisible (alc: the system `Commit` wins); `internal` is visible, the base being in
 * this app. A split procedure is visible if any arm the build does not compile out is non-local. No candidate
 * (a dependency base page): false, the claim stands (a named residual in R549). No readable base
 * name: true, the safe direction.
 */
function basePageDeclaresVisible(
  symbols: SymbolTable,
  ext: ALSyntaxNode,
  name: string,
  armOf: ArmReader,
): boolean {
  const base = stripQuotes(ext.childForFieldName("base_object")?.text ?? "").toLowerCase();
  if (base === "") return true;
  const pages = [
    ...symbols.objects.filter((o) => o.kind === "page").map((o) => o.node),
    ...symbols.unindexedObjects.filter((o) => o.kind === ALNodeKind.page),
  ];
  const named = (p: ALSyntaxNode): boolean =>
    stripQuotes(p.childForFieldName("object_name")?.text ?? "").toLowerCase() === base;
  if (pages.some((p) => named(p) && declaresVisibleProcedure(p, name, armOf))) return true;
  return [...symbols.unparsedObjects, ...symbols.splitObjects].some((o) => {
    const tokens = identifierTokens(o.text);
    return tokens.has("page") && tokens.has(base) && tokens.has(name.toLowerCase());
  });
}

/** `declaresProcedure`, counting only an arm that is not `local` (see `basePageDeclaresVisible`). */
function declaresVisibleProcedure(
  objectNode: ALSyntaxNode,
  name: string,
  armOf: ArmReader,
): boolean {
  for (const member of allProcedureLikes(objectNode)) {
    if (armOf !== undefined && armOf(member) === "inactive") continue;
    for (const arm of memberArms(member)) {
      const [head] = arm;
      if (head === undefined || (armOf !== undefined && armOf(head) === "inactive")) continue;
      if (!arm.some((c) => c.fieldName === "name" && equalsIgnoreCase(stripQuotes(c.text), name)))
        continue;
      const local = arm.some(
        (c) => c.fieldName === "modifier" && c.children.some((k) => k.rawKind === "local_keyword"),
      );
      if (!local) return true;
    }
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
  armOf: ArmReader,
): boolean {
  // R331 (run 004): every spelling of the table, gathered BEFORE any extension is compared. A
  // receiver may name the table by id (`Record 50101`) and an extension may extend it by name, or
  // the other way round; the table itself may be indexed or wrapped whole in a `#if` object region
  // (R298). So the aliases are the reference itself, plus the name and id of every project table it
  // matches, indexed or not. Comparing only the reference missed a numeric receiver of a wrapped
  // table extended by name, and `validate-to-assign` assigned a field that does not exist (AL0132).
  const idOf = (o: ALSyntaxNode): string => o.childForFieldName("object_id")?.text ?? "";
  const nameOf = (o: ALSyntaxNode): string =>
    stripQuotes(o.childForFieldName("object_name")?.text ?? "");
  const aliases = new Set<string>([tableRef.toLowerCase()]);
  const matches = (name: string, id: string): boolean =>
    aliases.has(name.toLowerCase()) || (id !== "" && aliases.has(id));
  const tables: ALSyntaxNode[] = [];
  const indexed = resolveTable(symbols, tableRef);
  if (indexed !== null) tables.push(indexed.node);
  for (const o of symbols.unindexedObjects)
    if (o.kind === ALNodeKind.table && matches(nameOf(o), idOf(o))) tables.push(o);
  for (const t of tables) {
    aliases.add(nameOf(t).toLowerCase());
    if (idOf(t) !== "") aliases.add(idOf(t));
  }
  if (tables.some((t) => declaresProcedure(t, procName, armOf))) return true;
  for (const o of symbols.unindexedObjects) {
    const base = stripQuotes(o.childForFieldName("base_object")?.text ?? "").toLowerCase();
    if (
      o.kind === ALNodeKind.tableextension &&
      aliases.has(base) &&
      declaresProcedure(o, procName, armOf)
    )
      return true;
  }
  if ([...aliases].some((a) => extensionDeclaresProcedure(symbols, a, procName, armOf)))
    return true;
  // R331 (run 005): a CONSERVATIVE fallback for source the grammar could not parse, not a parser.
  // Any ERROR node, at any depth (under a `#if` wrapper too), that could be a table or
  // `tableextension` and that holds the called name as an identifier token once comments are
  // stripped, refuses the claim. Measured: `tableextension ... extends 50101` (by number) does not
  // parse (R336), and a claim there let `validate-to-assign` assign a field that does not exist
  // (AL0132). Over-refusal costs one site; a wrong claim costs the build.
  const wanted = procName.toLowerCase();
  // R494 (opus build review): a split-header object (`#if` around its header) is in no index above
  // either, so a split-header tableextension's procedure escaped this guard and its call was claimed
  // as the built-in. It joins the same conservative fallback.
  return [...symbols.unparsedObjects, ...symbols.splitObjects].some((o) => {
    const tokens = identifierTokens(o.text);
    const tableLike =
      tokens.has("table") ||
      tokens.has("tableextension") ||
      hasAncestor(
        o,
        (a) =>
          a.kind === ALNodeKind.table ||
          a.kind === ALNodeKind.tableextension ||
          // A header the grammar split across `#if` arms keeps its keyword as a direct child.
          a.children.some(
            (c) => c.rawKind === "table_keyword" || c.rawKind === "tableextension_keyword",
          ),
      );
    return tableLike && tokens.has(wanted);
  });
}

/** R331 (run 005): the lowercase identifier tokens of `text`, comments stripped. A quoted
 *  identifier counts as its inner text. Strings are not stripped: a false match only refuses.
 *  Exported for loop-hazard's R-547 base-report candidates (the same conservative rule). */
export function identifierTokens(text: string): ReadonlySet<string> {
  // R-464: the engine's lexer, so a `//` inside a string no longer hides the rest of the line.
  const code = maskAlNonCode(text, { blankStringContents: false });
  const out = new Set<string>();
  for (const m of code.matchAll(/"([^"\n]*)"|[\p{L}_][\p{L}\p{N}_]*/gu))
    out.add((m[1] ?? m[0]).toLowerCase());
  return out;
}

function hasAncestor(node: ALSyntaxNode, test: (n: ALSyntaxNode) => boolean): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) if (test(p)) return true;
  return false;
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
  armOf: ArmReader,
): boolean {
  for (const ext of symbols.tableExtensions) {
    if (!equalsIgnoreCase(ext.baseObject, tableName)) continue;
    if (declaresProcedure(ext.node, procName, armOf)) return true;
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
function sourceTableOf(
  objectNode: ALSyntaxNode,
  symbols: Pick<SymbolTable, "objects">,
): string | null {
  return propertyValueOf(objectNode, "SourceTable", symbols);
}

/** The value of a direct `property` member (`SourceTable`, R-464's `TableNo`), quotes stripped. */
function propertyValueOf(
  objectNode: ALSyntaxNode,
  property: string,
  symbols: Pick<SymbolTable, "objects">,
): string | null {
  for (const member of declarationMembers(objectNode)) {
    if (member.kind !== ALNodeKind.property) continue;
    const name = member.childForFieldName("name");
    if (name === null || !equalsIgnoreCase(name.text, property)) continue;
    const value = member.childForFieldName("value");
    if (value === null) return null;
    // R502: `SourceTable = Microsoft.Sales.Customer` through the namespace check, like a data item.
    const table = qualifiedObjectName(nameSegments(value.text), "table", symbols);
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

/** R323: the `return_type` that follows a `return_value` identifier, or `null` for any other node. */
function returnTypeAfter(node: ALSyntaxNode): ALSyntaxNode | null {
  if (node.fieldName !== "return_value") return null;
  const parent = node.parent;
  if (parent === null) return null;
  return (
    parent.children.find((c) => c.fieldName === "return_type" && c.startIndex > node.startIndex) ??
    null
  );
}
