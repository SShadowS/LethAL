import { ALNodeKind } from "../ast/node-kinds";
import { type ALSyntaxNode, visit } from "../ast/syntax-node";
import { liveMembers } from "../ast/tree-walks";
import { type NodeArm, type SemanticContext, armOfNode, rawArmOf } from "./context";
import { claimsRecordMethod, claimsSystemCall, resolveReceiverTable } from "./receiver";
import { resolveVarRef } from "./resolve-var-ref";
import { type ObjectSymbol, type SymbolTable, triggerLocalNames } from "./symbol-table";

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

/** The table triggers a skip can be judged for. */
export type HarmlessTriggerKind = "delete" | "modify";

/** R-457: the table triggers a RunTrigger argument can force or skip. */
export type RunTriggerKind = HarmlessTriggerKind | "insert";

/** System calls that write nothing. Harmless only UNQUALIFIED and not shadowed (`claimsSystemCall`). */
const NON_WRITING_SYSTEM_CALLS: ReadonlySet<string> = new Set(["error", "message", "confirm"]);

const OWN_RECORD_NAMES: ReadonlySet<string> = new Set(["rec", "xrec"]);

/** Per trigger kind: the table trigger, its table events, the tableextension triggers that observe
 *  it, and the text an unindexed object is matched by. */
const SKIP_KINDS: Readonly<
  Record<
    RunTriggerKind,
    {
      readonly trigger: string;
      readonly events: ReadonlySet<string>;
      readonly extensionTriggers: readonly string[];
      readonly unindexedText: RegExp;
    }
  >
> = {
  delete: {
    trigger: "OnDelete",
    events: new Set(["onbeforedeleteevent", "onafterdeleteevent"]),
    extensionTriggers: ["OnBeforeDelete", "OnAfterDelete"],
    unindexedText: /on(before|after)delete/i,
  },
  modify: {
    trigger: "OnModify",
    events: new Set(["onbeforemodifyevent", "onaftermodifyevent"]),
    extensionTriggers: ["OnBeforeModify", "OnAfterModify"],
    unindexedText: /on(before|after)modify/i,
  },
  insert: {
    trigger: "OnInsert",
    events: new Set(["onbeforeinsertevent", "onafterinsertevent"]),
    extensionTriggers: ["OnBeforeInsert", "OnAfterInsert"],
    unindexedText: /on(before|after)insert/i,
  },
};
const EVENT_NAME_KINDS: ReadonlySet<string> = new Set([
  "string_literal",
  "identifier",
  "quoted_identifier",
]);

/**
 * R281, shared with R-213: is SKIPPING this call, inside a table's `OnDelete` or `OnModify`, proven
 * unable to leave a row behind that a later statement could collide with? `false` means "not
 * proven", never "proven harmful". The answer is the same for both triggers.
 *
 * Harmless only when:
 *   (a) it is a non-writing Record method (`NON_WRITING_RECORD_METHODS`) and `claimsRecordMethod`
 *       claims it, so the receiver is a record and the project declares no method of that name;
 *   (b) it is an unqualified `Error`, `Message` or `Confirm` that `claimsSystemCall` claims.
 * Every other call is not proven: ANY `Modify`/`Delete`, `DeleteAll`/`ModifyAll`/`DeleteLinks`,
 * `Validate`, any project or codeunit call, and ANY call inside a `with` statement, whose bare names
 * bind to the `with` record rather than to `Rec`.
 *
 * R-452 rule D: R281 accepted `Modify`/`Delete` on the trigger's own record. Own record is not own
 * row (`xRec.Get(X); xRec.Delete()` deletes another row), and `Rec.Modify(true)` runs `OnModify`,
 * which nothing read. So no `Modify`/`Delete` is harmless.
 */
export function isHarmlessTriggerCall(call: ALSyntaxNode, ctx: SemanticContext): boolean {
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
  return false;
}

/**
 * R281 (`Delete`), R-452 (`Modify`): for a call that SKIPS the receiver table's `kind` trigger
 * (`Delete(false)` from `Delete(true)`, `ModifyAll(F, V, false)` from `..., true)`), does the
 * mutant keep its `run-trigger-skipped-<kind>` tag?
 *
 * The same refusal detector as R143's `insertSkipCanRaise`: TRUE (keep the tag) unless skipping the
 * table's `kind` code is PROVEN harmless. In order:
 *   - receiver or table not resolved, or the table's file arm undecided (R378)        -> keep
 *   - the project subscribes to the table's `kind` events, or a tableextension of it
 *     declares `OnBefore<Kind>`/`OnAfter<Kind>`                                     -> keep
 *   - no `On<Kind>` trigger in this build                                              -> drop
 *   - the trigger holds a live call not proven harmless (`isHarmlessTriggerCall`), or a
 *     call written without parentheses that is not an own field read                 -> keep
 *   - otherwise                                                                         -> drop
 * A subscriber or tableextension in ANOTHER app is not visible here (stated in the explanation).
 * Subscribers are matched in every `#if` arm, which can only over-tag.
 */
export function skipCanRaise(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  kind: RunTriggerKind,
): boolean {
  const tableRef = resolveReceiverTable(node, ctx);
  if (tableRef === null) return true;
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) return true;
  const table = symbols.resolveObject({ kind: "table", idOrName: tableRef });
  if (table === null) return true;
  if (armOfNode(ctx, table.node) === "undecided") return true;
  if (projectObserves(table, symbols, ctx, kind)) return true;
  const trigger = findTableTrigger(table.node, SKIP_KINDS[kind].trigger, rawArmOf(ctx));
  if (trigger === null) return false;
  return !onlyHarmlessCalls(trigger, ctx, table, symbols, procedureNamesOn(table, symbols));
}

/** R281: `skipCanRaise` for `Delete(true)` and `DeleteAll(true)`. */
export function deleteSkipCanRaise(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  return skipCanRaise(node, ctx, "delete");
}

/**
 * R-457: for a call that FORCES the receiver table's `kind` trigger (`Modify()` or `Modify(false)`
 * to `Modify(true)`, `ModifyAll(F, V, false)` to `..., true)`, `DeleteAll(false)` to
 * `DeleteAll(true)`), does the mutant keep `run-trigger-forced`? TRUE unless the table resolves, its
 * file is decided, the project neither subscribes to its `kind` events nor extends its `kind`
 * triggers, and it declares no `On<Kind>`. No trigger body is read: R165's reading of one missed
 * calls without parentheses, `with`, indirect calls and raising assignments. An UNDECIDED member
 * arm counts as present, and with no arm map so does every `#if` arm (only "inactive" is skipped).
 * A subscriber or tableextension in ANOTHER app is not visible here (stated in the explanation).
 */
export function forceCanRaise(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  kind: RunTriggerKind,
): boolean {
  const tableRef = resolveReceiverTable(node, ctx);
  if (tableRef === null) return true;
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) return true;
  const table = symbols.resolveObject({ kind: "table", idOrName: tableRef });
  if (table === null) return true;
  if (armOfNode(ctx, table.node) === "undecided") return true;
  const raw = rawArmOf(ctx);
  const anyArm = (n: ALSyntaxNode): NodeArm => (raw?.(n) === "inactive" ? "inactive" : "active");
  if (projectObserves(table, symbols, ctx, kind, anyArm)) return true;
  return findTableTrigger(table.node, SKIP_KINDS[kind].trigger, anyArm) !== null;
}

/** R-452: `skipCanRaise` for `Modify(true)` and `ModifyAll(F, V, true)`. */
export function modifySkipCanRaise(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  return skipCanRaise(node, ctx, "modify");
}

/** Every procedure name declared on the table or a project tableextension of it, in every `#if`
 *  arm (over-inclusive, which can only over-tag). Lowercase, quotes stripped. R-452: a split-header
 *  procedure (`preproc_split_procedure` and its `_preamble`) adds every arm's `name`. */
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
      if (
        n.rawKind === "preproc_split_procedure" ||
        n.rawKind === "preproc_split_procedure_preamble"
      ) {
        for (const c of n.children) {
          if (c.fieldName === "name") names.add(c.text.replace(/"/g, "").toLowerCase());
        }
        return;
      }
      if (n.rawKind !== "procedure") return;
      const id = n.namedChildren.find(
        (c) => c.rawKind === "identifier" || c.rawKind === "quoted_identifier",
      );
      if (id !== undefined) names.add(id.text.replace(/"/g, "").toLowerCase());
    });
  }
  return names;
}

/** Does the project subscribe to this table's `kind` events, or extend its `kind` triggers?
 *  `armOf` decides which member-level `#if` arms of an extension's triggers count. */
function projectObserves(
  table: ObjectSymbol,
  symbols: SymbolTable,
  ctx: SemanticContext,
  kind: RunTriggerKind,
  armOf: ((node: ALSyntaxNode) => NodeArm) | undefined = rawArmOf(ctx),
): boolean {
  const { events, extensionTriggers, unindexedText } = SKIP_KINDS[kind];
  const tableName = table.name.toLowerCase();
  for (const ext of symbols.tableExtensions) {
    if (ext.baseObject.toLowerCase() !== tableName) continue;
    if (armOfNode(ctx, ext.node) === "undecided") return true;
    for (const t of extensionTriggers) {
      if (findTableTrigger(ext.node, t, armOf) !== null) return true;
    }
  }
  // Objects the symbol table does not index (wrapped whole in `#if`, or unparsable) are read by
  // their text, for any table: over-tagging is the safe direction. One that looks like a
  // tableextension naming this table keeps the tag whatever its triggers, since its procedures
  // are not among `procedureNamesOn`'s and a trigger may call one without parentheses (sol final
  // r1 finding 2).
  for (const n of [...symbols.unindexedObjects, ...symbols.unparsedObjects]) {
    if (unindexedText.test(n.text)) return true;
    const text = n.text.toLowerCase();
    if (
      /\btableextension\b/.test(text) &&
      (text.includes(tableName) || text.includes(String(table.id)))
    ) {
      return true;
    }
  }
  const names = new Set([tableName, String(table.id)]);
  let found = false;
  for (const cu of symbols.objects) {
    if (cu.kind !== "codeunit") continue;
    visit(cu.node, (n) => {
      if (!found && n.rawKind === "attribute_argument_list") found = subscribesTo(n, names, events);
    });
    if (found) return true;
  }
  return false;
}

/** An `[EventSubscriber(...)]` argument list naming one of `events` of one of `tableNames`. An
 *  unreadable `Database::` target counts as a match. The event name may be quoted (`'On...'`) or
 *  not (`OnAfterDeleteEvent`, which alc 18.0.43 compiles; an unknown unquoted name is AL0280). */
function subscribesTo(
  args: ALSyntaxNode,
  tableNames: ReadonlySet<string>,
  events: ReadonlySet<string>,
): boolean {
  const isEvent = args.namedChildren.some(
    (c) => EVENT_NAME_KINDS.has(c.rawKind) && events.has(c.text.replace(/['"]/g, "").toLowerCase()),
  );
  if (!isEvent) return false;
  const ref = args.namedChildren.find((c) => c.rawKind === "database_reference");
  const target = ref?.namedChildren.at(-1);
  if (target === undefined) return true;
  return tableNames.has(target.text.replace(/"/g, "").toLowerCase());
}

/**
 * Every live call in the trigger is proven harmless. A call written WITHOUT parentheses is not a
 * `call_expression`: `CleanUp;` parses as a `call_statement` and `Kid.DeleteAll;` as a bare
 * `member_expression`. The first is never proven. The second only when it is a read of the
 * trigger's OWN table's field through its OWN `Rec`/`xRec` (`ownFieldRead`). An unqualified call
 * without parentheses used as a VALUE (`if CheckIt then`) looks like a variable, so ANY identifier
 * naming a procedure of the table or its project tableextensions keeps the tag. Still unseen: such
 * a call to a procedure declared in another app's tableextension.
 */
function onlyHarmlessCalls(
  trigger: ALSyntaxNode,
  ctx: SemanticContext,
  table: ObjectSymbol,
  symbols: SymbolTable,
  tableProcedures: ReadonlySet<string>,
): boolean {
  let harmless = true;
  let fields: ReadonlySet<string> | undefined;
  const walk = (n: ALSyntaxNode): void => {
    if (!harmless || armOfNode(ctx, n) === "inactive") return;
    if (n.kind === ALNodeKind.procedure_call) {
      if (!isHarmlessTriggerCall(n, ctx)) harmless = false;
    } else if (
      (n.rawKind === "identifier" || n.rawKind === "quoted_identifier") &&
      tableProcedures.has(n.text.replace(/"/g, "").toLowerCase())
    ) {
      harmless = false;
    } else if (n.rawKind === "call_statement" || n.rawKind === "with_statement") {
      // A live `with` keeps the tag whole (sol final r1 finding 1): its bare names bind to the
      // `with` record, so a parenthesis-less call inside it escapes every check here.
      harmless = false;
    } else if (n.kind === ALNodeKind.field_access && n.parent?.kind !== ALNodeKind.procedure_call) {
      fields ??= new Set(symbols.fieldsOf(table.name).map((f) => f.name.toLowerCase()));
      if (!ownFieldRead(n, trigger, ctx, fields)) harmless = false;
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(trigger);
  return harmless;
}

/**
 * R-452 (post-merge finding 2, sol plan r2 finding 1): a bare `X.Y` is a field read only when `X`
 * is the trigger's own implicit `Rec`/`xRec` and `Y` is a field of the trigger's OWN table. The
 * binding is checked, not the spelling: alc 18.0.43 (Linux) compiles a trigger-local
 * `Rec: Record "Kid"` in a table trigger, and `Rec.Y` then binds to that local. So any declaration
 * of the name in the trigger's header (any `#if` arm, `triggerLocalNames`) or one the engine's
 * var-ref resolution finds (a global) keeps the tag.
 */
function ownFieldRead(
  access: ALSyntaxNode,
  trigger: ALSyntaxNode,
  ctx: SemanticContext,
  ownFields: ReadonlySet<string>,
): boolean {
  const object = access.childForFieldName("object");
  const member = access.childForFieldName("member");
  if (object?.kind !== ALNodeKind.identifier || member === null) return false;
  const name = object.text.toLowerCase();
  if (!OWN_RECORD_NAMES.has(name)) return false;
  if (triggerLocalNames(trigger).has(name) || resolveVarRef(object, ctx) !== null) return false;
  return ownFields.has(member.text.replace(/"/g, "").toLowerCase());
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

/** The bare method name of a call, qualified or not. */
function calleeName(call: ALSyntaxNode): string | null {
  const callee = call.childForFieldName("function");
  if (callee === null) return null;
  if (callee.kind === ALNodeKind.identifier) return callee.text;
  if (callee.kind === ALNodeKind.field_access) {
    return callee.childForFieldName("member")?.text ?? null;
  }
  return null;
}
