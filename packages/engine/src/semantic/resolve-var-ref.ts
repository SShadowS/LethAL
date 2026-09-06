/**
 * `resolveVarRef` — which declaration an identifier refers to.
 *
 * A thin adapter over `receiver.ts`'s `lookupVar`, not a second resolver. That file's own module
 * doc (R80) warns that a second parser for the same node shape is exactly what drifts, and
 * `lookupVar` already resolves in the order R196's classifier needs: a TRIGGER's own `var` section
 * first, then the enclosing procedure's locals, then its parameters, then the object's globals,
 * case-insensitively throughout. This module exists only to expose that resolution under a name
 * Task 2 (`builtin-tier1`) can import through `@lethal/engine`.
 *
 * `null` is a REFUSAL, not an absence: R196's classifier declines an unresolved site rather than
 * falling back to a name match, because a tag it produces can force LethAL to end a BC session and
 * a guess must never do that (spec §3.1).
 *
 * Spec §3.1 names exactly one function here, `resolveVarRef(node, ctx)`. An earlier version of
 * this file also exported `enclosingScope`/`VarScope`, built for a resolution shape the plan
 * changed before any task called them; removed rather than kept as unused public API (R196 fix
 * round 2) — see the module's git history if a later task needs a scope helper again, built
 * against a real caller.
 */
import { ALNodeKind } from "../ast/node-kinds";
import type { ALSyntaxNode } from "../ast/syntax-node";
import type { SemanticContext } from "./context";
import { lookupVar } from "./receiver";
import { enclosingObjectScopeKey } from "./symbol-table";
import type { VarSymbol } from "./symbol-table";

/**
 * AL names are case-insensitive and may be quoted (`"No."`). This strips one layer of quoting AND
 * lowercases. `normalizeAlName` is PUBLIC (re-exported through `@lethal/engine`, for Task 2), so a
 * consumer that normalizes two identifier texts and compares them directly needs a lowercase
 * answer, not just quote-stripping — `lookupVar`'s own `equalsIgnoreCase` comparison only helps a
 * caller that goes through `lookupVar`, not one that compares two normalized names itself.
 * `resolveVarRef`'s own lookup is unaffected either way, since `lookupVar` compares
 * case-insensitively regardless of what case its `name` argument carries.
 */
export function normalizeAlName(raw: string): string {
  const trimmed = raw.trim();
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.toLowerCase();
}

/**
 * Is this identifier a MEMBER name rather than a variable read? `Rec.Name` parses as a
 * `member_expression` (`ALNodeKind.field_access`) whose first named child is the receiver; every
 * later child is a member name and refers to no declaration `lookupVar` can see.
 *
 * Without this guard, a member name that happens to collide with a declared variable of the same
 * name resolves to that UNRELATED declaration instead of refusing — silently wrong, not merely
 * incomplete, so this is checked before anything else.
 */
function isMemberName(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null || parent.kind !== ALNodeKind.field_access) return false;
  return parent.namedChildren[0] !== node;
}

/**
 * The declaration `node` (an identifier) refers to, or `null` when it cannot be established:
 * `node` is a member name rather than a variable read, has no enclosing object, or no declaration
 * of that name is visible from the call site (see `lookupVar`'s resolution order).
 *
 * `lookupVar`'s third argument is NOT the plain object name `objectNameOf` (in `receiver.ts`)
 * returns — despite its parameter being called `objectName` in receiver.ts, `resolveReceiver`
 * there always passes it a SCOPE KEY (`"codeunit:R"`, or `"tableextension:My Ext"` inside an
 * extension), because `globalsOf`/`localsOf`/`resolveProcedure` are indexed under that key, not
 * under the bare name (`objectScopeKey`/`extensionScopeKey`, in `symbol-table.ts`; see R70 and R30
 * there for why a bare name is ambiguous). Passing the bare name here silently finds nothing for
 * every plain object, which a hand test with a codeunit global caught. `enclosingObjectScopeKey`
 * is the walk-up that already derives this key for either an object or an extension in one place
 * (used the same way by `types.ts`), so this reuses it rather than re-deriving the object/extension
 * branch a second time.
 */
export function resolveVarRef(node: ALSyntaxNode, ctx: SemanticContext): VarSymbol | null {
  if (isMemberName(node)) return null;
  const scopeKey = enclosingObjectScopeKey(node);
  if (scopeKey === null) return null;
  return lookupVar(normalizeAlName(node.text), node, scopeKey, ctx.symbols);
}
