/**
 * R143: can skipping a table's `OnInsert` ADD an error the unmutated program cannot raise?
 *
 * R-459: MOVED here from `builtin-tier2/src` so Tier-1 `flip-boolean-literal` can tag the
 * RunTrigger of a two-argument `Insert(true, X)` against the same rule.
 *
 * `lethal.swap-modify-flag` rewrites `Insert(true)` to `Insert(false)`, which skips the target
 * table's `OnInsert`. That is a platform-artifact risk only under one specific shape: the trigger
 * assigns the PRIMARY KEY. Skipped, the key stays blank; the first blank-key insert succeeds and a
 * second raises a duplicate primary key, so the test dies on the platform before any assertion runs
 * and the mutant is scored `killed` without the suite earning it.
 *
 * Where `OnInsert` does something else — sets a Boolean, stamps a timestamp — or does not exist at
 * all, `Insert(false)` writes strictly LESS than the unmutated program. A kill there comes from a
 * changed value of the record's own non-key fields, which R138 and R452 rule an ordinary
 * changed-value kill even when a later statement raises on that value (`Get(Rec.LookupCode)`), not
 * a platform artifact; screening it would be noise. That is a ruling, not a proof that nothing can
 * raise.
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
 *   - receiver or table NOT resolvable, or its file's arm undecided -> tag (cannot prove otherwise)
 *   - a project insert-event subscriber or tableextension insert trigger -> tag (R-476)
 *   - `OnInsert` holds a call not proven harmless (R-452's list)  -> tag (R-476)
 *   - `OnInsert` assigns a primary-key field, or all of `Rec`  -> tag (the measured mechanism)
 *   - no readable primary key                                 -> tag (R378)
 *   - otherwise, or no `OnInsert` at all                      -> NO tag
 * Read with the build's arm map, as the orchestrator always builds it. Without one, a member-level
 * `#if` trigger is not seen (`liveMembers`), the same as for `Modify` and `Delete`.
 *
 * That is a strict narrowing of R138: every mutant that loses the tag lost it to a proof, never to
 * an unknown.
 *
 * R-476 closed all three limits below with R-452's conservative cut (`skipCanRaise(.., "insert")`,
 * checked FIRST): the tag also stays when `OnInsert` holds any call not proven harmless (a helper,
 * a No. Series call, any write), when a project codeunit subscribes to the table's insert events,
 * or when a project tableextension declares `OnBeforeInsert`/`OnAfterInsert`. Measured: BaseApp's
 * `Sales Header` (`OnInsert` -> `InitInsert`) had lost the tag. A subscriber or tableextension in
 * ANOTHER app is still not seen.
 *
 * ## Limits as R143 measured them (historical; closed by R-476)
 *
 * 1. **Indirect key assignment.** An `OnInsert` may reach the key through a helper or a No. Series
 *    call, which this predicate does not follow and would therefore mis-classify as "proven
 *    unavailable". CENSUSED 2026-08-14 on the 554-file Continia Document Output snapshot
 *    (`scripts/r143-insert-census/`): 62 tables, 15 with an `OnInsert`, of which 6 assign a
 *    primary-key field DIRECTLY and 9 do not assign the key at all — every one of the 9 read by
 *    hand, and none reaches a key through its helper. Zero No. Series calls appear inside any
 *    `OnInsert` in that corpus. So on the one real corpus this repo has, the direct-assignment
 *    predicate misses nothing. That is a 15-table population and no rate should be read off it.
 * 2. **`OnBeforeInsertEvent` subscribers** (R-476 correction: table events fire with `RunTrigger`
 *    false too, but a subscriber can branch on it; R143 wrote that they run only when it is true),
 *    and one could
 *    assign the key of a table whose own `OnInsert` does not. Censused in the same snapshot: ONE
 *    subscriber in 554 files, and it targets a base-app table (`Integration Table Mapping`), which
 *    this predicate cannot resolve and therefore tags anyway. The blind spot is real and its
 *    measured population is zero project tables.
 * 3. **`tableextension`** members are not consulted: AL declares table-level triggers on the table
 *    itself, so an extension has no `OnInsert` to contribute. (R-476: it can declare
 *    `OnBeforeInsert`/`OnAfterInsert`, which also run only with `RunTrigger` true.)
 */
import { ALNodeKind } from "../ast/node-kinds";
import { type ALSyntaxNode, findAll, visit } from "../ast/syntax-node";
import { liveMembers } from "../ast/tree-walks";
import { type NodeArm, type SemanticContext, armOfNode, rawArmOf } from "./context";
import { resolveReceiverTable } from "./receiver";
import type { SymbolTable } from "./symbol-table";
import { skipCanRaise } from "./trigger-skip";

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
 * An empty list (no compiled key, or a first compiled key whose field list cannot be read) proves
 * nothing: `onInsertAssignsPrimaryKey` answers "not assigned" for it, which would land on NO tag,
 * the wrong direction for a screen. So `insertSkipCanRaise` checks for an empty list first and
 * KEEPS the tag (R378). It also calls this only for a table it resolved.
 */
export function primaryKeyFields(
  tableNode: ALSyntaxNode,
  isLive: (node: ALSyntaxNode) => boolean = () => true,
): readonly string[] {
  for (const section of descendantsOfRawKind(tableNode, KEYS_SECTION)) {
    for (const key of descendantsOfRawKind(section, KEY_DECLARATION)) {
      // R378: the build's primary key is its first COMPILED key; a key in an arm it compiles out
      // is not the table's key in this build.
      if (!isLive(key)) continue;
      const list = key.namedChildren.find((c) => c.rawKind === FIELD_LIST);
      // R378 review r1: the FIRST active key is the primary key even when its field list cannot be
      // read. Reading the next key instead could prove "not assigned" against the wrong key.
      if (list === undefined) return [];
      return list.namedChildren
        .filter((c) => IDENTIFIER_KINDS.has(c.rawKind))
        .map((c) => stripQuotes(c.text));
    }
  }
  return [];
}

/**
 * The table's own `OnInsert` trigger, or `null`. Name-matched, case-insensitively.
 *
 * R405 (a): `armOf` is the context's RAW arm reader (`rawArmOf`). With it, a trigger inside a
 * member-level `#if` is found when its arm is active (`liveMembers`); without it, direct members
 * only, as before.
 */
export function onInsertTrigger(
  tableNode: ALSyntaxNode,
  isLive: (node: ALSyntaxNode) => boolean = () => true,
  armOf?: (node: ALSyntaxNode) => NodeArm,
): ALSyntaxNode | null {
  const named = (n: ALSyntaxNode): string | null => {
    const id = n.namedChildren.find((c) => c.rawKind === "identifier");
    return id === null || id === undefined ? null : id.text;
  };
  for (const { node: member } of liveMembers(tableNode, armOf)) {
    if (member.kind !== ALNodeKind.trigger) continue;
    if (!isLive(member)) continue;
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
 * assigns it through the field's own `OnValidate`. R-476 adds a whole-record assignment to the
 * implicit record (`Rec := Seed`). Any other route (a helper procedure, a No. Series call) is left
 * to `insertSkipCanRaise`'s call check.
 */
export function onInsertAssignsPrimaryKey(
  tableNode: ALSyntaxNode,
  isLive: (node: ALSyntaxNode) => boolean = () => true,
  armOf?: (node: ALSyntaxNode) => NodeArm,
): boolean {
  const trigger = onInsertTrigger(tableNode, isLive, armOf);
  if (trigger === null) return false;
  const key = primaryKeyFields(tableNode, isLive);
  if (key.length === 0) return false;

  for (const assignment of findAll(trigger, ALNodeKind.assignment_statement)) {
    // R378: an assignment in an arm the build compiles out never runs.
    if (!isLive(assignment)) continue;
    const target = assignment.namedChildren[0];
    if (target === undefined) continue;
    if (key.some((f) => referencesOwnField(target, f))) return true;
    // R-476 (sol final r1): `Rec := Seed` copies a whole record, key included.
    if (
      IDENTIFIER_KINDS.has(target.rawKind) &&
      IMPLICIT_RECORD_NAMES.has(stripQuotes(target.text).toLowerCase())
    )
      return true;
  }

  for (const call of descendantsOfRawKind(trigger, CALL_EXPRESSION)) {
    if (!isLive(call)) continue;
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
  // R-476: R-452's conservative cut first. An `OnInsert` call not proven harmless (a helper that
  // fills the key, a No. Series call), a project insert-event subscriber or a tableextension
  // `OnBefore/AfterInsert` keeps the tag; only then can the direct-assignment proof drop it.
  return skipCanRaise(node, ctx, "insert") || directKeySkipCanRaise(node, ctx);
}

/** R143's direct-assignment proof, unchanged: the tag unless `OnInsert` provably does not assign
 *  the primary key itself. */
function directKeySkipCanRaise(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const tableRef = resolveReceiverTable(node, ctx);
  if (tableRef === null) return true;
  const symbols = (ctx as { symbols?: SymbolTable } | undefined)?.symbols;
  if (symbols === undefined) return true;
  const table = symbols.resolveObject({ kind: "table", idOrName: tableRef });
  if (table === null) return true;
  // R378: proof needs the table's file to be decided. An undecided file KEEPS the tag: for a screen
  // the unsafe direction is under-tagging, and an undecided arm could hold the key assignment.
  if (armOfNode(ctx, table.node) === "undecided") return true;
  const isLive = (n: ALSyntaxNode): boolean => armOfNode(ctx, n) === "active";
  // R405 (a): the raw arm reader, so an `OnInsert` inside an active member-level `#if` is found.
  const armOf = rawArmOf(ctx);
  // No compiled `OnInsert`: `Insert(false)` skips nothing, so there is no mechanism to tag.
  if (onInsertTrigger(table.node, isLive, armOf) === null) return false;
  // R378: "not assigned" is proven only against a readable, non-empty primary key. No compiled key,
  // or one whose field list this parser cannot read, proves nothing, so the tag stays.
  if (primaryKeyFields(table.node, isLive).length === 0) return true;
  return onInsertAssignsPrimaryKey(table.node, isLive, armOf);
}
