import {
  ALNodeKind,
  type ALSyntaxNode,
  resolveReceiverTable,
  type SemanticContext,
  type SymbolTable,
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
 * writes strictly LESS than the unmutated program and can add no error. Forcing writes MORE. Any
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
  return findTableTrigger(table.node, triggerName);
}

/** Does the trigger body contain a statement that can raise? See the module comment for the list. */
export function forcedTriggerCanRaise(trigger: ALSyntaxNode): boolean {
  let found = false;
  const walk = (n: ALSyntaxNode): void => {
    if (found) return;
    if (n.kind === ALNodeKind.procedure_call) {
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

/**
 * A TABLE-level trigger declaration by name, never a field's.
 *
 * Direct members only: a field's `OnValidate` sits inside a `field_declaration` inside a
 * `fields_section`, and a recursive search would find one and call it the table's `OnInsert`.
 */
function findTableTrigger(tableNode: ALSyntaxNode, triggerName: string): ALSyntaxNode | null {
  const body = tableNode.namedChildren.find((c) => c.rawKind === "declaration_body") ?? tableNode;
  for (const member of body.namedChildren) {
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
