/**
 * `resolveVarRef` — which declaration an identifier refers to.
 *
 * A thin adapter over `receiver.ts`'s `lookupVar` / `enclosingObject` / `objectNameOf`, not a
 * second resolver. That file's own module doc (R80) warns that a second parser for the same node
 * shape is exactly what drifts, and `lookupVar` already resolves in the order R196's classifier
 * needs: a TRIGGER's own `var` section first, then the enclosing procedure's locals, then its
 * parameters, then the object's globals, case-insensitively throughout. This module exists only to
 * expose that resolution under names Task 2 (`builtin-tier1`) can import through `@lethal/engine`.
 *
 * `null` is a REFUSAL, not an absence: R196's classifier declines an unresolved site rather than
 * falling back to a name match, because a tag it produces can force LethAL to end a BC session and
 * a guess must never do that (spec §3.1).
 */
import type { ALSyntaxNode } from "../ast/syntax-node";
import { findEnclosingProcedure } from "../ast/tree-walks";
import type { SemanticContext } from "./context";
import { enclosingObject, lookupVar, objectNameOf } from "./receiver";
import { enclosingObjectScopeKey } from "./symbol-table";
import type { VarSymbol } from "./symbol-table";

/** The object and (optionally) the procedure an identifier sits in. */
export interface VarScope {
  readonly ownerName: string;
  readonly procName: string | null;
}

/**
 * AL names are case-insensitive and may be quoted (`"No."`). This strips one layer of quoting and
 * leaves case alone: `lookupVar` already compares names via `equalsIgnoreCase`, so lowercasing here
 * would be redundant, not a fix. Do not add it back.
 */
export function normalizeAlName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * The enclosing object and, where there is one, the enclosing procedure's name.
 *
 * `procName` is `null` when `node` sits directly at object level or inside a TRIGGER: triggers are
 * not indexed by name (trigger names repeat across an object; see `lookupVar`'s doc), so there is
 * no name a caller could use to ask the symbol table about one, and this deliberately does not
 * invent one.
 *
 * Returns `null` when `node` has no enclosing object, or that object's name cannot be read — a
 * caller must treat this as "cannot classify", not as an empty scope.
 */
export function enclosingScope(node: ALSyntaxNode): VarScope | null {
  const objectNode = enclosingObject(node);
  if (objectNode === null) return null;
  const ownerName = objectNameOf(objectNode);
  if (ownerName === null) return null;
  const procedureNode = findEnclosingProcedure(node);
  if (procedureNode === null) return { ownerName, procName: null };
  const nameNode = procedureNode.childForFieldName("name");
  const procName = nameNode === null ? null : normalizeAlName(nameNode.text);
  return { ownerName, procName };
}

/**
 * The declaration `node` (an identifier) refers to, or `null` when it cannot be established:
 * `node` has no enclosing object, or no declaration of that name is visible from the call site
 * (see `lookupVar`'s resolution order).
 *
 * `lookupVar`'s third argument is NOT the plain object name `objectNameOf` returns — despite its
 * parameter being called `objectName` in receiver.ts, `resolveReceiver` there always passes it a
 * SCOPE KEY (`"codeunit:R"`, or `"tableextension:My Ext"` inside an extension), because
 * `globalsOf`/`localsOf`/`resolveProcedure` are indexed under that key, not under the bare name
 * (`objectScopeKey`/`extensionScopeKey`, in `symbol-table.ts`; see R70 and R30 there for why a bare
 * name is ambiguous). Passing the bare name here silently finds nothing for every plain object,
 * which a hand test with a codeunit global caught. `enclosingObjectScopeKey` is the walk-up that
 * already derives this key for either an object or an extension in one place (used the same way by
 * `types.ts`), so this reuses it rather than re-deriving the object/extension branch a second time.
 */
export function resolveVarRef(node: ALSyntaxNode, ctx: SemanticContext): VarSymbol | null {
  const scopeKey = enclosingObjectScopeKey(node);
  if (scopeKey === null) return null;
  return lookupVar(normalizeAlName(node.text), node, scopeKey, ctx.symbols);
}
