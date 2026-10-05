import { ALNodeKind } from "../ast/node-kinds";
import { type ALSyntaxNode, visit } from "../ast/syntax-node";
import { liveMembers } from "../ast/tree-walks";
import { type NodeArm, type SemanticContext, armOfNode, rawArmOf } from "./context";
import { claimsRecordMethod, claimsSystemCall, resolveReceiverTable } from "./receiver";
import type { ObjectSymbol, SymbolTable } from "./symbol-table";

/**
 * R281's SKIP-direction detector, MOVED here from `builtin-tier2/src/forced-trigger-raise.ts`
 * (R-452) so a Tier-1 operator (`flip-boolean-literal`) can tag a `ModifyAll`/`DeleteAll` RunTrigger
 * flip against the SAME predicate `swap-modify-flag` tags with. Tier 2 re-exports it.
 */

/** Record methods that write nothing. A call to one is harmless only when `claimsRecordMethod`
 *  proves it is the builtin on a record (not a project procedure of that name, not a codeunit). */
const NON_WRITING_RECORD_METHODS: ReadonlySet<string> = new Set([
  "get",
  "find",
  "findfirst",
  "findlast",
  "findset",
  "next",
  "isempty",
  "count",
  "setrange",
  "setfilter",
  "reset",
  "calcfields",
  "testfield",
  "fielderror",
  "fieldcaption",
  "tablecaption",
  "init",
]);

/** The table triggers `isHarmlessTriggerCall` can judge a call for. */
export type HarmlessTriggerKind = "delete" | "modify";

/**
 * Single-row writes that are harmless only on the trigger's OWN record (`Rec`, `xRec`, implicit),
 * per trigger. Inside `OnDelete` the row is going anyway, so `Rec.Delete()` adds nothing. Inside
 * `OnModify` it does: skip the trigger and the row survives, so a later insert can collide.
 */
const OWN_ROW_WRITES: Readonly<Record<HarmlessTriggerKind, ReadonlySet<string>>> = {
  delete: new Set(["modify", "delete"]),
  modify: new Set(["modify"]),
};

/** System calls that write nothing. Harmless only UNQUALIFIED and not shadowed (`claimsSystemCall`). */
const NON_WRITING_SYSTEM_CALLS: ReadonlySet<string> = new Set(["error", "message", "confirm"]);

const OWN_RECORD_NAMES: ReadonlySet<string> = new Set(["rec", "xrec"]);
const DELETE_EVENTS: ReadonlySet<string> = new Set(["onbeforedeleteevent", "onafterdeleteevent"]);
const EXTENSION_DELETE_TRIGGERS = ["OnBeforeDelete", "OnAfterDelete"] as const;
const EVENT_NAME_KINDS: ReadonlySet<string> = new Set([
  "string_literal",
  "identifier",
  "quoted_identifier",
]);

/**
 * R281, shared with R-213: is SKIPPING this call, inside the table's `trigger` (`OnDelete` or
 * `OnModify`), proven unable to leave a row behind that a later statement could collide with?
 * `false` means "not proven", never "proven harmful".
 *
 * Harmless only when:
 *   (a) it is a non-writing Record method (`NON_WRITING_RECORD_METHODS`) and `claimsRecordMethod`
 *       claims it, so the receiver is a record and the project declares no method of that name;
 *   (b) it is a write `OWN_ROW_WRITES[trigger]` allows on the trigger's own record (`Rec`, `xRec` or
 *       implicit), claimed the same way: `Modify`/`Delete` in `OnDelete`, `Modify` only in `OnModify`;
 *   (c) it is an unqualified `Error`, `Message` or `Confirm` that `claimsSystemCall` claims.
 * Every other call is not proven: a write to another record, `DeleteAll`/`ModifyAll`/`DeleteLinks`,
 * `Validate`, any project or codeunit call, and ANY call inside a `with` statement, whose bare names
 * bind to the `with` record rather than to `Rec`.
 */
export function isHarmlessTriggerCall(
  call: ALSyntaxNode,
  ctx: SemanticContext,
  trigger: HarmlessTriggerKind,
): boolean {
  if (call.kind !== ALNodeKind.procedure_call) return false;
  for (let p = call.parent; p !== null; p = p.parent) {
    if (p.rawKind === "with_statement") return false;
  }
  const callee = call.childForFieldName("function");
  const name = calleeName(call);
  if (callee === null || name === null) return false;
  const lower = name.toLowerCase();
  if (NON_WRITING_SYSTEM_CALLS.has(lower)) {
    return callee.kind === ALNodeKind.identifier && claimsSystemCall(call, ctx, name);
  }
  if (NON_WRITING_RECORD_METHODS.has(lower)) return claimsRecordMethod(call, ctx, name);
  if (OWN_ROW_WRITES[trigger].has(lower)) {
    return onOwnRecord(callee) && claimsRecordMethod(call, ctx, name);
  }
  return false;
}

/** The callee is implicit (`Modify()`) or qualified by `Rec`/`xRec`. */
function onOwnRecord(callee: ALSyntaxNode): boolean {
  if (callee.kind === ALNodeKind.identifier) return true;
  if (callee.kind !== ALNodeKind.field_access) return false;
  const object = callee.childForFieldName("object");
  return object?.kind === ALNodeKind.identifier && OWN_RECORD_NAMES.has(object.text.toLowerCase());
}

/**
 * R281's decision for one `Delete(true)` site: does this mutant keep `run-trigger-skipped-delete`?
 *
 * The same refusal detector as R143's `insertSkipCanRaise`: TRUE (keep the tag) unless skipping the
 * table's delete code is PROVEN harmless. In order:
 *   - receiver or table not resolved, or the table's file arm undecided (R378)        -> keep
 *   - the project subscribes to the table's delete events, or a tableextension of it
 *     declares `OnBeforeDelete`/`OnAfterDelete`                                     -> keep
 *   - no `OnDelete` in this build                                                      -> drop
 *   - `OnDelete` holds a live call not proven harmless (`isHarmlessTriggerCall`), or a
 *     call written without parentheses that is not a project field read              -> keep
 *   - otherwise                                                                         -> drop
 * A subscriber or tableextension in ANOTHER app is not visible here (stated in the explanation).
 * Subscribers are matched in every `#if` arm, which can only over-tag.
 */
export function deleteSkipCanRaise(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const tableRef = resolveReceiverTable(node, ctx);
  if (tableRef === null) return true;
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) return true;
  const table = symbols.resolveObject({ kind: "table", idOrName: tableRef });
  if (table === null) return true;
  if (armOfNode(ctx, table.node) === "undecided") return true;
  if (projectObservesDelete(table, symbols, ctx)) return true;
  const trigger = findTableTrigger(table.node, "OnDelete", rawArmOf(ctx));
  if (trigger === null) return false;
  return !onlyHarmlessCalls(trigger, ctx, symbols, procedureNamesOn(table, symbols));
}

/** Every procedure name declared on the table or a project tableextension of it, in every `#if`
 *  arm (over-inclusive, which can only over-tag). Lowercase, quotes stripped. */
function procedureNamesOn(table: ObjectSymbol, symbols: SymbolTable): ReadonlySet<string> {
  const names = new Set<string>();
  const owners = [
    table.node,
    ...symbols.tableExtensions
      .filter((e) => e.baseObject.toLowerCase() === table.name.toLowerCase())
      .map((e) => e.node),
  ];
  for (const owner of owners) {
    visit(owner, (n) => {
      if (n.rawKind !== "procedure") return;
      const id = n.namedChildren.find(
        (c) => c.rawKind === "identifier" || c.rawKind === "quoted_identifier",
      );
      if (id !== undefined) names.add(id.text.replace(/"/g, "").toLowerCase());
    });
  }
  return names;
}

/** Does the project subscribe to this table's delete events, or extend its delete triggers? */
function projectObservesDelete(
  table: ObjectSymbol,
  symbols: SymbolTable,
  ctx: SemanticContext,
): boolean {
  const tableName = table.name.toLowerCase();
  for (const ext of symbols.tableExtensions) {
    if (ext.baseObject.toLowerCase() !== tableName) continue;
    if (armOfNode(ctx, ext.node) === "undecided") return true;
    for (const t of EXTENSION_DELETE_TRIGGERS) {
      if (findTableTrigger(ext.node, t, rawArmOf(ctx)) !== null) return true;
    }
  }
  // Objects the symbol table does not index (wrapped whole in `#if`, or unparsable) are read by
  // their text, for any table: over-tagging is the safe direction.
  for (const n of [...symbols.unindexedObjects, ...symbols.unparsedObjects]) {
    if (/on(before|after)delete/i.test(n.text)) return true;
  }
  const names = new Set([tableName, String(table.id)]);
  let found = false;
  for (const cu of symbols.objects) {
    if (cu.kind !== "codeunit") continue;
    visit(cu.node, (n) => {
      if (!found && n.rawKind === "attribute_argument_list") found = subscribesToDelete(n, names);
    });
    if (found) return true;
  }
  return false;
}

/** An `[EventSubscriber(...)]` argument list naming a delete event of one of `tableNames`. An
 *  unreadable `Database::` target counts as a match. The event name may be quoted (`'On...'`) or
 *  not (`OnAfterDeleteEvent`, which alc 18.0.43 compiles; an unknown unquoted name is AL0280). */
function subscribesToDelete(args: ALSyntaxNode, tableNames: ReadonlySet<string>): boolean {
  const isDeleteEvent = args.namedChildren.some(
    (c) =>
      EVENT_NAME_KINDS.has(c.rawKind) &&
      DELETE_EVENTS.has(c.text.replace(/['"]/g, "").toLowerCase()),
  );
  if (!isDeleteEvent) return false;
  const ref = args.namedChildren.find((c) => c.rawKind === "database_reference");
  const target = ref?.namedChildren.at(-1);
  if (target === undefined) return true;
  return tableNames.has(target.text.replace(/"/g, "").toLowerCase());
}

/**
 * Every live call in the trigger is proven harmless. A call written WITHOUT parentheses is not a
 * `call_expression`: `CleanUp;` parses as a `call_statement` and `Kid.DeleteAll;` as a bare
 * `member_expression`. The first is never proven; the second only when its member names a field of
 * a project table (a field read). An unqualified call without parentheses used as a VALUE
 * (`if CheckIt then`) looks like a variable, so ANY identifier naming a procedure of the table or
 * its project tableextensions keeps the tag. Still unseen: such a call to a procedure declared in
 * another app's tableextension.
 */
function onlyHarmlessCalls(
  trigger: ALSyntaxNode,
  ctx: SemanticContext,
  symbols: SymbolTable,
  tableProcedures: ReadonlySet<string>,
): boolean {
  let harmless = true;
  let fields: ReadonlySet<string> | undefined;
  const walk = (n: ALSyntaxNode): void => {
    if (!harmless || armOfNode(ctx, n) === "inactive") return;
    if (n.kind === ALNodeKind.procedure_call) {
      if (!isHarmlessTriggerCall(n, ctx, "delete")) harmless = false;
    } else if (
      (n.rawKind === "identifier" || n.rawKind === "quoted_identifier") &&
      tableProcedures.has(n.text.replace(/"/g, "").toLowerCase())
    ) {
      harmless = false;
    } else if (n.rawKind === "call_statement") {
      harmless = false;
    } else if (n.kind === ALNodeKind.field_access && n.parent?.kind !== ALNodeKind.procedure_call) {
      fields ??= projectFieldNames(symbols);
      const member = n.childForFieldName("member");
      if (member === null || !fields.has(member.text.replace(/"/g, "").toLowerCase())) {
        harmless = false;
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(trigger);
  return harmless;
}

function projectFieldNames(symbols: SymbolTable): ReadonlySet<string> {
  return new Set(
    symbols.objects
      .filter((o) => o.kind === "table")
      .flatMap((t) => symbols.fieldsOf(t.name))
      .map((f) => f.name.toLowerCase()),
  );
}

/**
 * A TABLE-level trigger declaration by name, never a field's.
 *
 * Members only (`liveMembers`), never a recursive search: a field's `OnValidate` sits inside a
 * `field_declaration` inside a `fields_section`, and a recursive search would find one and call it
 * the table's `OnInsert`. R405 (a): `liveMembers` also yields a trigger inside a member-level
 * `#if` whose arm is active, and drops a direct one the build compiles out.
 */
export function findTableTrigger(
  tableNode: ALSyntaxNode,
  triggerName: string,
  armOf: ((node: ALSyntaxNode) => NodeArm) | undefined,
): ALSyntaxNode | null {
  for (const { node: member } of liveMembers(tableNode, armOf)) {
    if (member.rawKind !== "trigger_declaration") continue;
    const name = member.namedChildren.find(
      (c) => c.rawKind === "identifier" || c.rawKind === "quoted_identifier",
    );
    if (name !== undefined && name.text.toLowerCase() === triggerName.toLowerCase()) return member;
  }
  return null;
}

/** The bare method name of a call, qualified or not. Same as the copy in Tier 2's
 *  `forced-trigger-raise.ts`, which its forcing half still uses. */
function calleeName(call: ALSyntaxNode): string | null {
  const callee = call.childForFieldName("function");
  if (callee === null) return null;
  if (callee.kind === ALNodeKind.identifier) return callee.text;
  if (callee.kind === ALNodeKind.field_access) {
    return callee.childForFieldName("member")?.text ?? null;
  }
  return null;
}
