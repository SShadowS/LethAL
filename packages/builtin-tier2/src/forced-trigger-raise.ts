import {
  ALNodeKind,
  type ALSyntaxNode,
  type NodeArm,
  type ObjectSymbol,
  type SemanticContext,
  type SymbolTable,
  armOfNode,
  claimsRecordMethod,
  claimsSystemCall,
  liveMembers,
  rawArmOf,
  resolveReceiverTable,
  visit,
} from "@lethal/engine";

/**
 * R165: can FORCING a table trigger to run add an error the unmutated program cannot raise?
 *
 * `lethal.swap-modify-flag`'s forward direction rewrites `Rec.Modify()` to `Rec.Modify(true)`.
 * `Rec.Modify()` means `RunTrigger = false`, so the mutant makes `OnModify` run where it did not.
 *
 * ## Why this needs a screen at all, and why the SKIP direction did not
 *
 * R138 ruled that `Delete` and `Modify` need no mechanism when SKIPPING a trigger, because skipping
 * writes strictly LESS than the unmutated program and can add no error. (R281 overturned that for
 * `Delete`, see `deleteSkipCanRaise` below: skipped child deletes leave rows a later insert hits.)
 * Forcing writes MORE. Any
 * statement the trigger runs can raise: an `Error`, a `TestField`, a `FieldError`, a write to
 * another table that hits a duplicate key or a locked row. So all three methods can produce a kill
 * the suite did not earn, where the skip direction could only do it through `Insert`.
 *
 * ## Why this predicate can be PRECISE where R143's is a refusal detector
 *
 * `insertSkipCanRaise` tags unless it can prove the mechanism unavailable, and keeps the tag for a
 * receiver it cannot resolve, because an untagged platform kill is a platform refusal credited to
 * the suite. That asymmetry is right there and would be useless here: the forward operator is SCOPED
 * to receivers whose table this project declares AND that declare the trigger, so by construction
 * this predicate always has the trigger body in front of it. A tag on every mutant would separate
 * nothing, which is the `vacuous` state R132 exists to distinguish from a real finding.
 *
 * So this reads the trigger and answers from what is in it:
 *
 *   - the trigger body contains a raise-capable statement  -> TAG (a kill here can be the platform)
 *   - it does not                                          -> NO tag (a kill is assertion-earned)
 *
 * ## What counts as raise-capable, and why the list is what it is
 *
 * `Error` and `FieldError` raise unconditionally. `TestField` raises on a blank or mismatched field.
 * A record write (`Insert`, `Modify`, `Delete`, `Rename`, `ModifyAll`, `DeleteAll`) can hit a
 * duplicate key, a missing record or a locked row. `Validate` runs another field's `OnValidate`,
 * which is the same question one level down and is treated as raise-capable rather than followed.
 *
 * Deliberately NOT here: a call to a project procedure, which could raise anything. Following it
 * would need a call graph and would end at "almost everything can raise", which is the tag that
 * separates nothing. So this predicate UNDER-tags for indirect raises, and that is the honest
 * direction for a screen whose whole value is that a tag means something.
 */
const RAISE_CAPABLE_METHODS: ReadonlySet<string> = new Set([
  "error",
  "fielderror",
  "testfield",
  "insert",
  "modify",
  "delete",
  "rename",
  "modifyall",
  "deleteall",
  "validate",
]);

/** The table trigger each run-trigger method runs. */
const TRIGGER_OF: Readonly<Record<string, string>> = {
  insert: "OnInsert",
  modify: "OnModify",
  delete: "OnDelete",
};

/**
 * The table this call's receiver resolves to, together with the trigger declaration named by
 * `method`, or `null` when either cannot be found.
 *
 * `null` is the operator's REFUSAL signal, not a screen answer: the forward direction claims a site
 * only when both are present, because a mutant that forces a trigger the project cannot see is one
 * no screen can classify, and a mutant that forces a trigger which does not exist is close enough to
 * equivalent to be a survivor factory.
 */
export function resolveForcedTrigger(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  method: string,
): ALSyntaxNode | null {
  const triggerName = TRIGGER_OF[method.toLowerCase()];
  if (triggerName === undefined) return null;
  const tableRef = resolveReceiverTable(node, ctx);
  if (tableRef === null) return null;
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) return null;
  const table = symbols.resolveObject({ kind: "table", idOrName: tableRef });
  if (table === null) return null;
  // R378: a trigger declared in an arm this build compiles out is not in the build. An undecided
  // file keeps today's lookup of DIRECT triggers (only "inactive" is skipped). R405 (a): a trigger
  // inside a member-level `#if` is found only when its arm is active; never in an undecided file.
  return findTableTrigger(table.node, triggerName, rawArmOf(ctx));
}

/**
 * Does the trigger body contain a statement that can raise? See the module comment for the list.
 *
 * R378: a call in an arm the build compiles out never runs, so it is skipped. A trigger whose file
 * is UNDECIDED keeps the tag without a scan: an undecided arm could hold the raise, and for a
 * screen the unsafe direction is under-tagging.
 */
export function forcedTriggerCanRaise(trigger: ALSyntaxNode, ctx?: SemanticContext): boolean {
  if (armOfNode(ctx, trigger) === "undecided") return true;
  let found = false;
  const walk = (n: ALSyntaxNode): void => {
    if (found) return;
    if (n.kind === ALNodeKind.procedure_call && armOfNode(ctx, n) !== "inactive") {
      const name = calleeName(n);
      if (name !== null && RAISE_CAPABLE_METHODS.has(name.toLowerCase())) {
        found = true;
        return;
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(trigger);
  return found;
}

// --- R281: the SKIP direction for `Delete` -------------------------------------------------------

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
function findTableTrigger(
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
