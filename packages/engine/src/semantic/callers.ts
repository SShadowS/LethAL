import { ALNodeKind } from "../ast/node-kinds";
/**
 * Caller index (Layer 1).
 *
 * Builds an intra-codeunit index of which procedures call a given target.
 * Method calls whose receiver is another object are out of scope at
 * Layer 1: we resolve only bare `identifier`-style call targets against
 * the enclosing object's own procedures.
 *
 * Grammar note (SShadowS/tree-sitter-al v3.0.1):
 *   - There is no distinct `method_call` node. Method invocations and
 *     procedure invocations both appear as `call_expression`
 *     (ALNodeKind.procedure_call). A `call_expression` has a `function`
 *     field which is either `identifier` (bare call) or `member_expression`
 *     (qualified call). Task 11 only follows the bare-identifier case.
 */
import type { ALSyntaxNode } from "../ast/syntax-node";
import { findAll } from "../ast/syntax-node";
import { objectScopeKey } from "./symbol-table";
import type { SourceFile, SymbolTable } from "./symbol-table";

export interface CallerIndex {
  /**
   * Callers of `<ownerScope>.<procName>`, where `ownerScope` is an `objectScopeKey(kind, name)` —
   * NOT a bare object name.
   *
   * R81: the index used to key on the bare name, so `table 50000 "CDO Setup".Configure` and
   * `page 50000 "CDO Setup".Configure` landed in ONE bucket and each was reported as a caller of
   * the other. R70 fixed the same defect in the scope maps and deliberately left this one, on the
   * stated grounds that the bare-name key was this method's public contract and widening it would
   * change a second consumer under the same commit. R81's measurement is that **there is no second
   * consumer**: no package's `src` reads `callersOf`, `SemanticCapability` has no value an
   * operator could use to request it, and its only reader in the repo is a test. So the merge could
   * never reach a claim or a verdict — and the key was fixed while that was still free, rather than
   * left for the first real consumer to inherit silently.
   */
  callersOf(ownerScope: string, procName: string): readonly CallSite[];
}

export interface CallSite {
  readonly fromOwner: string;
  readonly fromProcedure: string;
  readonly node: ALSyntaxNode;
}

export function buildCallerIndex(
  // TODO(Layer 6): `_files` is unused in Layer 1's intra-codeunit scope but is
  // retained in the signature for Layer 6's cross-codeunit expansion, where the
  // index may need to be sharded or incrementally rebuilt per file.
  _files: readonly SourceFile[],
  symbols: SymbolTable,
): CallerIndex {
  const index = new Map<string, CallSite[]>();

  for (const obj of symbols.objects) {
    const calls = findAll(obj.node, ALNodeKind.procedure_call);
    for (const call of calls) {
      // R70 keyed the SCOPE lookup by (kind, name); R81 keys the INDEX the same way, so two
      // same-named objects of different kinds no longer share one bucket. `fromOwner` on the
      // emitted site stays the bare display name — it is what a reader wants to see, and it is
      // not a lookup key.
      const ownerScope = objectScopeKey(obj.kind, obj.name);
      const target = resolveCallTarget(call, ownerScope, symbols);
      if (target === null) continue;
      const enclosing = enclosingProcedureName(call);
      if (enclosing === null) continue;
      const key = siteKey(target.owner, target.procedure);
      const site: CallSite = {
        fromOwner: obj.name,
        fromProcedure: enclosing,
        node: call,
      };
      const list = index.get(key);
      if (list === undefined) index.set(key, [site]);
      else list.push(site);
    }
  }

  return {
    callersOf(ownerScope, procName) {
      return index.get(siteKey(ownerScope, procName)) ?? [];
    },
  };
}

/** `<objectScopeKey(kind, name)>::<procedure>` — see `CallerIndex.callersOf` for why the kind. */
function siteKey(ownerScope: string, proc: string): string {
  return `${ownerScope}::${proc}`;
}

/**
 * Layer 1 resolves only UNQUALIFIED calls, against the enclosing object's own scope — so the
 * target's owner IS that scope. One parameter, not two: the lookup scope and the recorded owner
 * were the same value passed twice, which invited a future edit to diverge them silently.
 */
function resolveCallTarget(
  call: ALSyntaxNode,
  ownerScope: string,
  symbols: SymbolTable,
): { owner: string; procedure: string } | null {
  const fn = call.childForFieldName("function");
  // Layer 1 handles only unqualified calls (bare identifier target).
  // Qualified calls (member_expression) are deferred to Layer 6.
  if (fn === null || fn.kind !== ALNodeKind.identifier) return null;
  const procName = fn.text;
  if (symbols.resolveProcedure(ownerScope, procName) === null) return null;
  return { owner: ownerScope, procedure: procName };
}

function enclosingProcedureName(node: ALSyntaxNode): string | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null) {
    if (current.kind === ALNodeKind.procedure) {
      return current.childForFieldName("name")?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}
