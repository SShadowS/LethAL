/**
 * R143: can skipping a table's `OnInsert` ADD an error the unmutated program cannot raise?
 *
 * `lethal.swap-modify-flag` rewrites `Insert(true)` to `Insert(false)`, which skips the target
 * table's `OnInsert`. That is a platform-artifact risk only under one specific shape: the trigger
 * assigns the PRIMARY KEY. Skipped, the key stays blank; the first blank-key insert succeeds and a
 * second raises a duplicate primary key, so the test dies on the platform before any assertion runs
 * and the mutant is scored `killed` without the suite earning it.
 *
 * Where `OnInsert` does something else — sets a Boolean, stamps a timestamp — or does not exist at
 * all, `Insert(false)` writes strictly LESS than the unmutated program and can raise nothing new.
 * A kill there is assertion-earned, and screening it as a platform artifact is noise.
 *
 * R138 shipped the tag on EVERY `Insert` mutant because this question is not visible at the call
 * site. It is visible one step away, through the receiver's table, which is what this module reads.
 *
 * ## The ruling on what cannot be resolved
 *
 * A base-app record (`Record Customer`) resolves to no table this project can see, and the semantic
 * layer is source-derived by design (see `receiver.ts`). For every OTHER Tier-2 guard the safe
 * direction is to REFUSE — claiming a wrong site both mislabels a mutant and suppresses the correct
 * Tier-1 one. **For this screen the safe direction is the opposite**, and the difference is worth
 * stating rather than assuming: an untagged platform kill is a platform refusal credited to the
 * suite, which is the failure the screen exists to prevent. An over-tagged kill costs a reader one
 * look.
 *
 * So this module tags unless it can PROVE the mechanism is unavailable:
 *
 *   - table resolved, `OnInsert` assigns a primary-key field  -> tag (the measured mechanism)
 *   - table resolved, `OnInsert` exists and does not          -> NO tag (proven unavailable)
 *   - table resolved, no `OnInsert` at all                    -> NO tag (nothing to skip)
 *   - receiver or table NOT resolvable                        -> tag (cannot prove otherwise)
 *
 * That is a strict narrowing of R138: every mutant that loses the tag lost it to a proof, never to
 * an unknown.
 *
 * ## Measured limits, all three stated rather than hidden
 *
 * 1. **Indirect key assignment.** An `OnInsert` may reach the key through a helper or a No. Series
 *    call, which this predicate does not follow and would therefore mis-classify as "proven
 *    unavailable". CENSUSED 2026-08-14 on the 554-file Continia Document Output snapshot
 *    (`scripts/r143-insert-census/`): 62 tables, 15 with an `OnInsert`, of which 6 assign a
 *    primary-key field DIRECTLY and 9 do not assign the key at all — every one of the 9 read by
 *    hand, and none reaches a key through its helper. Zero No. Series calls appear inside any
 *    `OnInsert` in that corpus. So on the one real corpus this repo has, the direct-assignment
 *    predicate misses nothing. That is a 15-table population and no rate should be read off it.
 * 2. **`OnBeforeInsertEvent` subscribers** also run only when `RunTrigger` is true, and one could
 *    assign the key of a table whose own `OnInsert` does not. Censused in the same snapshot: ONE
 *    subscriber in 554 files, and it targets a base-app table (`Integration Table Mapping`), which
 *    this predicate cannot resolve and therefore tags anyway. The blind spot is real and its
 *    measured population is zero project tables.
 * 3. **`tableextension`** members are not consulted: AL declares table-level triggers on the table
 *    itself, so an extension has no `OnInsert` to contribute. If that ever changes, this predicate
 *    would under-tag, and the fix belongs here rather than at the call site.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  type SymbolTable,
  declarationMembers,
  findAll,
  visit,
} from "@lethal/engine";
import { resolveReceiverTable } from "./receiver";

/** Grammar node kinds this module reads. Local consts for the same reason `receiver.ts` keeps its
 *  own: `ALNodeKind` enumerates what the mutation pipeline TARGETS, and widening it widens
 *  `isALNodeKind`, which every `ALSyntaxNode.kind` consumer reads. Verified against the vendored
 *  tree-sitter-al 4.0.0 grammar, 2026-08-14. */
const KEYS_SECTION = "keys_section";
const KEY_DECLARATION = "key_declaration";
const FIELD_LIST = "field_list";
const MEMBER_EXPRESSION = "member_expression";
const CALL_EXPRESSION = "call_expression";
const ARGUMENT_LIST = "argument_list";
const IDENTIFIER_KINDS = new Set(["identifier", "quoted_identifier"]);

/** The record a table trigger's unqualified field names belong to. `xRec` is included because
 *  `xRec."No." := …` is legal AL, even though assigning through it is unusual. */
const IMPLICIT_RECORD_NAMES = new Set(["rec", "xrec"]);

/** Every descendant of `node` with this RAW grammar kind, in document order. `findAll` keys on
 *  `ALNodeKind`, which deliberately does not enumerate the container kinds read here. */
function descendantsOfRawKind(node: ALSyntaxNode, rawKind: string): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visit(node, (n) => {
    if (n.rawKind === rawKind) out.push(n);
  });
  return out;
}

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The FIRST `key(...)` entry's field names — AL's primary key — or an empty list when the table
 * declares no `keys` section this parser can read.
 *
 * An empty list makes every question below answer "no key field was assigned", which lands on NO
 * tag. That is the wrong direction for a screen, so callers must not reach this with an unresolved
 * table; `insertSkipCanRaise` only calls it for a table it resolved, and a resolved AL table
 * without a primary key does not exist (the compiler requires one).
 */
export function primaryKeyFields(tableNode: ALSyntaxNode): readonly string[] {
  for (const section of descendantsOfRawKind(tableNode, KEYS_SECTION)) {
    for (const key of descendantsOfRawKind(section, KEY_DECLARATION)) {
      const list = key.namedChildren.find((c) => c.rawKind === FIELD_LIST);
      if (list === undefined) continue;
      return list.namedChildren
        .filter((c) => IDENTIFIER_KINDS.has(c.rawKind))
        .map((c) => stripQuotes(c.text));
    }
  }
  return [];
}

/** The table's own `OnInsert` trigger, or `null`. Name-matched, case-insensitively. */
export function onInsertTrigger(tableNode: ALSyntaxNode): ALSyntaxNode | null {
  const named = (n: ALSyntaxNode): string | null => {
    const id = n.namedChildren.find((c) => c.rawKind === "identifier");
    return id === null || id === undefined ? null : id.text;
  };
  for (const member of declarationMembers(tableNode)) {
    if (member.kind !== ALNodeKind.trigger) continue;
    const name = named(member);
    if (name !== null && equalsIgnoreCase(name, "OnInsert")) return member;
  }
  return null;
}

/**
 * Is `node` a reference to `field` on the trigger's OWN record — bare (`"No."`) or through the
 * implicit record (`Rec."No."`)?
 *
 * `Helper."No."` is deliberately NOT a match: that assigns a different record's key and says
 * nothing about the record being inserted here.
 */
function referencesOwnField(node: ALSyntaxNode, field: string): boolean {
  if (IDENTIFIER_KINDS.has(node.rawKind)) return equalsIgnoreCase(stripQuotes(node.text), field);
  if (node.rawKind !== MEMBER_EXPRESSION) return false;
  const parts = node.namedChildren.filter((c) => IDENTIFIER_KINDS.has(c.rawKind));
  if (parts.length !== 2) return false;
  const [base, member] = parts;
  if (base === undefined || member === undefined) return false;
  return (
    IMPLICIT_RECORD_NAMES.has(stripQuotes(base.text).toLowerCase()) &&
    equalsIgnoreCase(stripQuotes(member.text), field)
  );
}

/**
 * Does this `OnInsert` body assign a primary-key field of its own record?
 *
 * Two shapes count, and both were measured in the Document Output census: a direct
 * `assignment_statement` whose target is the field, and a `Validate("<field>", …)` call, which
 * assigns it through the field's own `OnValidate`. Any other route (a helper procedure, a No.
 * Series call) is out of scope — see this module's limit 1.
 */
export function onInsertAssignsPrimaryKey(tableNode: ALSyntaxNode): boolean {
  const trigger = onInsertTrigger(tableNode);
  if (trigger === null) return false;
  const key = primaryKeyFields(tableNode);
  if (key.length === 0) return false;

  for (const assignment of findAll(trigger, ALNodeKind.assignment_statement)) {
    const target = assignment.namedChildren[0];
    if (target === undefined) continue;
    if (key.some((f) => referencesOwnField(target, f))) return true;
  }

  for (const call of descendantsOfRawKind(trigger, CALL_EXPRESSION)) {
    const callee = call.namedChildren[0];
    if (callee === undefined) continue;
    const calleeName =
      callee.rawKind === MEMBER_EXPRESSION
        ? (callee.namedChildren.filter((c) => IDENTIFIER_KINDS.has(c.rawKind)).at(-1)?.text ?? "")
        : callee.text;
    if (!equalsIgnoreCase(stripQuotes(calleeName), "Validate")) continue;
    const args = call.namedChildren.find((c) => c.rawKind === ARGUMENT_LIST);
    const first = args?.namedChildren[0];
    if (first === undefined) continue;
    if (key.some((f) => referencesOwnField(first, f))) return true;
  }

  return false;
}

/**
 * R143's decision for one `Insert(true)` site: does this mutant keep the
 * `run-trigger-skipped-insert` tag?
 *
 * True unless the target table is resolvable AND its `OnInsert` is proven not to assign the primary
 * key — see this module's doc comment for why the unresolvable case keeps the tag rather than
 * losing it.
 */
export function insertSkipCanRaise(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const tableRef = resolveReceiverTable(node, ctx);
  if (tableRef === null) return true;
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) return true;
  const table = symbols.resolveObject({ kind: "table", idOrName: tableRef });
  if (table === null) return true;
  return onInsertAssignsPrimaryKey(table.node);
}
