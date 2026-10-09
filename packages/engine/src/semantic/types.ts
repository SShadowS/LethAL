import { ALNodeKind, isBinaryExpressionKind } from "../ast/node-kinds";
/**
 * Type table (Layer 1).
 *
 * Answers "what is the AL type of this expression?" for a minimal set of
 * node kinds: literals, identifiers (resolved via the symbol table), and
 * binary/unary expressions over built-in types.
 *
 * Grammar adjustments (SShadowS/tree-sitter-al v3.0.1):
 *   - There is no single `binary_expression` kind; binary ops are split
 *     across four precedence classes. We dispatch on `isBinaryExpressionKind`.
 *   - Operators are named leaf children (e.g. `comparison_operator`). We
 *     prefer the `operator` field when present and fall back to searching
 *     for a namedChild whose kind ends in `_operator`.
 *   - Literal kinds are `integer`, `decimal`, `string_literal`, `boolean`
 *     (mapped via ALNodeKind.integer_literal etc.).
 */
import { nameSegments } from "../ast/qualified-name";
import type { ALSyntaxNode } from "../ast/syntax-node";
import { declarationMembers, findEnclosingProcedure } from "../ast/tree-walks";
import {
  enclosingObjectScopeKey,
  enclosingTrigger,
  objectScopeKey,
  qualifiedObjectName,
  triggerHeaderSymbols,
  triggerLocalNames,
} from "./symbol-table";
import type { SourceFile, SymbolTable } from "./symbol-table";

export interface TypeTable {
  typeOf(node: ALSyntaxNode): string | null;
}

export function buildTypeTable(_files: readonly SourceFile[], symbols: SymbolTable): TypeTable {
  return {
    typeOf(node) {
      return computeType(node, symbols);
    },
  };
}

function computeType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  if (isBinaryExpressionKind(node.kind)) {
    return binaryType(node, symbols);
  }
  switch (node.kind) {
    case ALNodeKind.integer_literal:
      return "Integer";
    case ALNodeKind.decimal_literal:
      return "Decimal";
    case ALNodeKind.text_literal:
      return "Text";
    case ALNodeKind.boolean_literal:
      return "Boolean";
    case ALNodeKind.parenthesized_expression: {
      const inner = node.namedChildren[0];
      return inner === undefined ? null : computeType(inner, symbols);
    }
    case ALNodeKind.unary_expression: {
      const operand = findUnaryOperand(node);
      if (operand === null) return null;
      const op = findOperator(node);
      if (op === "not") return "Boolean";
      if (op === "-" || op === "+") return computeType(operand, symbols);
      return computeType(operand, symbols);
    }
    case ALNodeKind.identifier:
      return resolveIdentifierType(node, symbols);
    case ALNodeKind.field_access:
      return memberType(node, symbols);
    case ALNodeKind.procedure_call:
      return callType(node, symbols);
    default:
      return null;
  }
}

/** `Record "Data Main"` / `Record DataMain` -> `Data Main`; anything else -> `null`. */
function recordTableName(typeText: string | null, symbols: SymbolTable): string | null {
  if (typeText === null) return null;
  const match = /^\s*Record\s+(.+?)\s*$/i.exec(typeText);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const unquoted = objectNameIn(raw, "table", symbols);
  return unquoted.length === 0 ? null : unquoted;
}

/** A name, possibly dotted (`System.Utilities.Integer`, `"Sales Line"`). */
const NAME_PATH = /^(?:"[^"]*"|[^\s".]+)(?:\.(?:"[^"]*"|[^\s".]+))*$/;

/**
 * R509: the keyword a `Record` type may end in. It is part of the type TEXT, never of the name, and
 * leaving it on made every temporary record's name unreadable, so its fields had no type.
 */
const TEMPORARY_SUFFIX = /\s+temporary$/i;

/**
 * R502: the object name a type's reference text means. A clean dotted path
 * (`System.Utilities.Integer`) goes through `qualifiedObjectName`, as the receiver's AST reads do;
 * anything else is unquoted as before. R509: a trailing `temporary` is dropped first.
 */
function objectNameIn(
  typeRef: string,
  kind: "table" | "codeunit",
  symbols: Pick<SymbolTable, "objects">,
): string {
  const raw = typeRef.replace(TEMPORARY_SUFFIX, "");
  if (NAME_PATH.test(raw)) return qualifiedObjectName(nameSegments(raw), kind, symbols) ?? "";
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

/**
 * The declared type of `<receiver>.<member>`, when the receiver resolves to a project table and
 * that table (or a `tableextension` on it) declares the member as a field.
 *
 * R160. `computeType` had no case for this at all and answered `null`, which is where BC keeps its
 * numbers: measured on `do-rel2/Cloud`, 49 of the 170 untypeable arithmetic operands were a
 * `member_expression`.
 *
 * Deliberately narrow. It resolves ONE shape, a field on a record variable, and answers `null` for
 * everything else a `member_expression` can be — a page control, a chained access, an enum value,
 * a member of a codeunit. For a type table the unsafe direction is a confident wrong answer:
 * `swap-call-arguments` emits AL from a type equality, and R87 is the row recording what a wrong
 * type there costs (`AL0133`, a whole-project compile failure after the expensive step).
 */
function memberType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  const objectNode = node.childForFieldName("object");
  const memberNode = node.childForFieldName("member");
  if (objectNode === null || memberNode === null) return null;
  // Only a plain identifier receiver. A chained `A.B.C` would need the middle to resolve to a
  // record type, which this layer does not model, so it refuses rather than guessing.
  if (objectNode.kind !== ALNodeKind.identifier) return null;
  const tableName = recordTableName(resolveIdentifierType(objectNode, symbols), symbols);
  if (tableName === null) return null;
  const memberName = stripQuotes(memberNode.text).toLowerCase();
  for (const field of symbols.fieldsOf(tableName)) {
    if (field.name.toLowerCase() === memberName) return field.typeText;
  }
  return null;
}

/**
 * The declared return type of a call, when the call resolves to a procedure THIS PROJECT declares.
 *
 * R160. 81 of the 170 untypeable arithmetic operands on `do-rel2/Cloud` were a `call_expression`,
 * the largest single group.
 *
 * A platform method (`Rec.Count()`, `StrLen(...)`, `Rec.Get(...)`) keeps answering `null`, and that
 * is the honest shape rather than a gap to fill later: this project indexes the AL it can see, and
 * inventing return types for the base application would be a table of guesses that goes stale
 * silently. Answering `null` costs sites; answering wrongly costs a compile.
 */
function callType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  const callee = node.childForFieldName("function");
  if (callee === null) return null;

  // R455: against a record scope an unqualified call binds to the TABLE's method before the
  // object's own procedure (alc 18.0.43: AL0122 in `with R do I := F()`, the same on a page with a
  // `SourceTable` and in a `TableNo` OnRun). This layer does not read table methods, so such a call
  // types as nothing, by the same context tests R294 uses for names. A quoted callee too.
  if (callee.kind === ALNodeKind.identifier || callee.rawKind === "quoted_identifier") {
    if (insideWithBody(node) || implicitRecordShadowsGlobals(node)) return null;
  }

  if (callee.kind === ALNodeKind.identifier) {
    // Unqualified: a procedure of the object the call sits in.
    const owner = enclosingObjectScopeKey(node);
    if (owner === null) return null;
    return symbols.uniqueProcedure(owner, callee.text)?.returnType ?? null;
  }

  if (callee.kind === ALNodeKind.field_access) {
    const receiver = callee.childForFieldName("object");
    const method = callee.childForFieldName("member");
    if (receiver === null || method === null) return null;
    if (receiver.kind !== ALNodeKind.identifier) return null;
    const receiverType = resolveIdentifierType(receiver, symbols);
    if (receiverType === null) return null;
    // `Codeunit "X"` and `Record "X"` are the two receivers whose procedures this project declares.
    const match = /^\s*(?:Codeunit|Record)\s+(.+?)\s*$/i.exec(receiverType);
    const raw = match?.[1];
    if (raw === undefined) return null;
    const kind = /^\s*Codeunit\b/i.test(receiverType) ? "codeunit" : "table";
    const ownerName = objectNameIn(raw, kind, symbols);
    return (
      symbols.uniqueProcedure(objectScopeKey(kind, ownerName), method.text)?.returnType ?? null
    );
  }

  return null;
}

function stripQuotes(text: string): string {
  return text.startsWith('"') && text.endsWith('"') && text.length >= 2 ? text.slice(1, -1) : text;
}

function binaryType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  const op = findOperator(node) ?? "";
  const [left, right] = findBinaryOperands(node);
  if (left === null || right === null) return null;

  const comparison = new Set(["<", "<=", ">", ">=", "=", "<>"]);
  const logical = new Set(["and", "or", "xor"]);
  if (comparison.has(op) || logical.has(op)) return "Boolean";

  const leftType = computeType(left, symbols);
  const rightType = computeType(right, symbols);
  if (leftType === null || rightType === null) return null;
  if (leftType === rightType) return leftType;
  if (
    (leftType === "Integer" && rightType === "Decimal") ||
    (leftType === "Decimal" && rightType === "Integer")
  ) {
    return "Decimal";
  }
  return leftType;
}

function findOperator(node: ALSyntaxNode): string | null {
  const field = node.childForFieldName("operator");
  if (field !== null) return field.text;
  for (const c of node.namedChildren) {
    if (c.kind.endsWith("_operator")) return c.text;
  }
  return null;
}

function findUnaryOperand(node: ALSyntaxNode): ALSyntaxNode | null {
  const field = node.childForFieldName("operand");
  if (field !== null) return field;
  for (const c of node.namedChildren) {
    if (!c.kind.endsWith("_operator")) return c;
  }
  return null;
}

function findBinaryOperands(
  node: ALSyntaxNode,
): readonly [ALSyntaxNode | null, ALSyntaxNode | null] {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left !== null && right !== null) return [left, right];
  const nonOperatorChildren = node.namedChildren.filter((c) => !c.kind.endsWith("_operator"));
  return [nonOperatorChildren[0] ?? null, nonOperatorChildren[1] ?? null];
}

/**
 * The declared type of an identifier, resolved in the scope the identifier ACTUALLY sits in.
 *
 * R87. This used to iterate `symbols.objects` and, for each, call
 * `findEnclosingProcedure(node, obj.node)` — a walk up from the identifier that stopped at either a
 * `procedure` or `obj.node`. The identifier's own enclosing procedure is always reached first, so
 * the `current !== objectNode` guard gated nothing and every object answered with the SAME
 * procedure name. The loop therefore resolved against whichever object declared a procedure of that
 * name FIRST IN PARSE ORDER, and then `return null`ed rather than trying the rest.
 *
 * Both halves were measured on `do-rel2/Cloud` (244 objects, 1,793 distinct procedure names, 184 of
 * them declared by more than one object — the precondition is ordinary):
 *
 *   - WRONG TYPE: 27 of 390 claimed sites were typed by an object other than the one declaring the
 *     enclosing procedure. Zero were wrong on that project, by luck of naming rather than by
 *     construction — a two-codeunit counterexample makes `swap-call-arguments` claim a site it
 *     must refuse and emit AL that `alc` 18.0 rejects with `AL0133: cannot convert from
 *     'Record "Data Related"' to 'Record "Data Main"'`, i.e. a whole-project compile failure after
 *     the expensive part of a run.
 *   - LOST SITES: 73 of 463 candidates (15.8%), from the `return null` that gave up after a
 *     first name match in an object that did not declare the identifier.
 *
 * Now it asks one question — which declaration is this identifier inside? — and resolves there.
 * A node has exactly one enclosing declaration, so there is nothing to iterate and no order to
 * depend on.
 */
function resolveIdentifierType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  const scope = enclosingObjectScopeKey(node);
  if (scope === null) return null;
  if (insideWithBody(node)) return null;
  const proc = findEnclosingProcedure(node);
  // R330 (run 002 fix round): inside a trigger, a name the trigger declares in its own header is
  // unknown. Without this it fell through to the object's globals, and since R322 also to a global
  // whose casing differs: an `alc`-failing swap (AL0175).
  // R340: such a name is now typed by its own declaration in the trigger header, as a procedure's
  // is; a name declared in a `#if` region of the header, or any header name not parsed as a plain
  // parameter, local or named return, stays unknown (it still hides the global).
  if (proc === null) {
    const trigger = enclosingTrigger(node);
    const name = stripQuotes(node.text).toLowerCase();
    if (trigger !== null && triggerLocalNames(trigger).has(name)) {
      // R340 (review M1): a trigger that parsed with an ERROR (a header split by `#if`, which the
      // grammar attaches to one arm) types nothing, as an unindexed procedure has since R331.
      if (trigger.hasError) return null;
      const header = triggerHeaderSymbols(trigger);
      // A name declared in a `#if` region of the header. Unreachable by any shape measured today
      // (R-340 red-check): a `#if` var block's names never enter `locals` (direct children only),
      // and a `#if` inside the parameter list parses with an ERROR (caught above). Kept because
      // `collectParameters` walks recursively: if the grammar ever parsed a conditional parameter
      // cleanly, both arms would land in `parameters`, and this keeps such a name unknown.
      if (header.ambiguous.includes(name)) return null;
      const local = header.locals.find((v) => sameName(v.name, node.text));
      if (local !== undefined) return extractType(local.typeText);
      const param = header.parameters.find((p) => sameName(p.name, node.text));
      if (param !== undefined) return extractType(param.typeText);
      return null;
    }
  }
  // A member-level declaration wins over an object-level one, which is AL's own shadowing rule:
  // a procedure's local or parameter hides a global of the same name.
  if (proc !== null) {
    // R210: by the declaration's position, so an overloaded name cannot answer with a different
    // procedure's locals. The name lookup remains the fallback for a declaration this scope's
    // index does not hold, which is what this line did for every case before.
    // R327: a split member the symbol table did not index (the grammar swallowed it into the
    // global var section) types NOTHING. The name fallback would answer with another procedure's
    // declarations, and falling through to the globals typed its parameters by the object's
    // globals: an `alc`-failing swap. A plain procedure keeps the name fallback it had.
    // R331 (run 003): a member the table did not index, of ANY shape, types nothing. That covers a
    // plain procedure wrapped whole in `#if`: the name fallback would answer with another same-named
    // procedure's declarations, and falling through reached the object's globals (with R322, also
    // a differently-cased one), an `alc`-failing swap.
    const procSym = symbols.resolveProcedureAt(scope, proc.startIndex);
    if (procSym === null) return null;
    {
      // R302: a name a split member's arms declare differently types as nothing, and it HIDES a
      // global of that name: falling through would type it by a declaration no build uses here.
      if (procSym.ambiguous?.includes(stripQuotes(node.text).toLowerCase())) return null;
      const local = procSym.locals.find((v) => sameName(v.name, node.text));
      if (local !== undefined) return extractType(local.typeText);
      const param = procSym.parameters.find((p) => sameName(p.name, node.text));
      if (param !== undefined) return extractType(param.typeText);
    }
  }
  // Falling through to globals is deliberate, and it is a second R87 fix rather than a tidy-up:
  // the old code reached globals only on the object it had already (mis)chosen, so an identifier
  // referring to a global inside a procedure that a DIFFERENT object also declares resolved
  // against the wrong object's globals or not at all. Here the scope is the identifier's own by
  // construction, so this is the same object either way.
  if (implicitRecordShadowsGlobals(node)) return null;
  const global = symbols.globalsOf(scope).find((g) => sameName(g.name, node.text));
  if (global !== undefined) return extractType(global.typeText);
  return null;
}

/**
 * Inside `with R do <body>`, a bare name resolves to R's field of that name BEFORE any variable,
 * and this layer does not read R's fields, so a name there types as nothing. Measured with `alc`
 * 18.0 (R295 build): `with R do Take(Q, Z)` where R's table has a Text field Z and Q, Z are
 * Integer locals compiles, and the swap `Take(Z, Q)` that typing Z by the local emitted is
 * rejected (AL0133). R295 made later names of `Q, Z: Integer` visible, which widened this.
 */
function insideWithBody(node: ALSyntaxNode): boolean {
  for (let p = node.parent; p !== null; p = p.parent) {
    if (p.rawKind !== "with_statement") continue;
    const body = p.childForFieldName("body");
    if (body !== null && node.startIndex >= body.startIndex && node.endIndex <= body.endIndex)
      return true;
  }
  return false;
}

/**
 * R294 review: some bodies have an IMPLICIT `with` over a record, and there a field of that record
 * wins over an object GLOBAL of the same name (a procedure's local or parameter still wins over the
 * field). This layer does not read the record's fields, so a name that would fall through to the
 * globals types as nothing. Measured with `alc` 18.0.43 (`I := Z` with an Integer global Z and a
 * Text field Z; AL0122 means the field won):
 *   - page with a `SourceTable`: every trigger, field trigger and procedure. Without one: global.
 *   - pageextension: every body (the extended page's source table is not visible here).
 *   - codeunit with `TableNo`: the `OnRun` trigger only; its other procedures see the global.
 *   - report: dataitem triggers, including a nested dataitem's (an OUTER dataitem's field wins
 *     too), and a request page that declares a `SourceTable`; report triggers and procedures see
 *     the global. reportextension: `modify` triggers measured; its request page is not, so it is
 *     refused as well.
 *   - safe, measured: table, tableextension, xmlport `tableelement` triggers.
 * Before this, `PTake(Q2, Z)` on a page over a table with a Text field Z, Q2 and Z Integer page
 * globals, was swapped to `PTake(Z, Q2)`, which `alc` rejects (AL0133).
 */
function implicitRecordShadowsGlobals(node: ALSyntaxNode): boolean {
  for (let p = node.parent; p !== null; p = p.parent) {
    switch (p.rawKind) {
      case "report_dataitem":
      case "dataset_section":
        return true;
      case "requestpage_section":
        return (
          hasProperty(p, "SourceTable") ||
          p.parent?.parent?.rawKind === "reportextension_declaration"
        );
      case ALNodeKind.pageextension:
        return true;
      case ALNodeKind.page:
        return hasProperty(p, "SourceTable");
      case ALNodeKind.codeunit: {
        if (!hasProperty(p, "TableNo")) return false;
        const name = enclosingTrigger(node)?.childForFieldName("name")?.text;
        return name !== undefined && sameName(name, "OnRun");
      }
      case ALNodeKind.report:
      case "reportextension_declaration":
      case ALNodeKind.table:
      case ALNodeKind.tableextension:
        return false;
    }
  }
  return false;
}

function hasProperty(objectNode: ALSyntaxNode, name: string): boolean {
  return declarationMembers(objectNode).some((m) => {
    if (m.kind !== ALNodeKind.property) return false;
    const n = m.childForFieldName("name");
    return n !== null && sameName(n.text, name);
  });
}

/** R322: AL compares names case-insensitively. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The type identity of a declaration — the WHOLE declared type, not its first token (R84).
 *
 * This function used to keep only the first whitespace-delimited token, so `Record "Sales Header"`
 * and `Record "Purchase Header"` both answered `Record`, as did two different `Codeunit`s, two
 * `List of [...]`s, two `Option`s and two `Enum`s. MEASURED on Continia Document Output while
 * counting R82 (`scripts/census-swap-call-arguments.ts`): of 893 call sites whose two arguments the
 * truncated head called same-typed, **135 (15.1%) are not** — 118 `Record`, 9 `Codeunit`, 4 `List`,
 * 2 `Option`, 2 `Enum`. An operator that trusted the head would emit an artifact that does not
 * compile, and the failure would arrive as an `AlcCompileError` on a whole project, i.e. after the
 * expensive part.
 *
 * Two things the grammar already gets right, so they need no handling here: the declaration's
 * `type` field carries the full text (`Record "Data Main"`), and a `Label` declaration's `type`
 * field is the bare word `Label` — its constant lives in a sibling `string_literal`. So two labels
 * with different text compare EQUAL, which is correct: they are the same type.
 *
 * `Code[20]` and `Code[10]` stay DISTINCT, and that is deliberate rather than incidental. It
 * refuses some swaps that would compile, and the conservative direction is the right one: a
 * `Code[20]` value moved into a `Code[10]` position compiles and then fails at RUNTIME on a length
 * overflow, which for a mutation operator is a kill nobody's assertion earned.
 */
function extractType(typeText: string): string {
  return typeText.replace(/\s+/g, " ").trim();
}
