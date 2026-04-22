/**
 * Caller index (Layer 1).
 *
 * Builds an intra-codeunit index of which procedures call a given target.
 * Method calls whose receiver is another object are out of scope at
 * Layer 1: we resolve only bare `identifier`-style call targets against
 * the enclosing object's own procedures.
 *
 * Grammar note (SShadowS/tree-sitter-al v2.5.0):
 *   - There is no distinct `method_call` node. Method invocations and
 *     procedure invocations both appear as `call_expression`
 *     (ALNodeKind.procedure_call). A `call_expression` has a `function`
 *     field which is either `identifier` (bare call) or `member_expression`
 *     (qualified call). Task 11 only follows the bare-identifier case.
 */
import type { ALSyntaxNode } from "../ast/syntax-node";
import { findAll } from "../ast/syntax-node";
import { ALNodeKind } from "../ast/node-kinds";
import type { SourceFile, SymbolTable } from "./symbol-table";

export interface CallerIndex {
  callersOf(ownerName: string, procName: string): readonly CallSite[];
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
      const target = resolveCallTarget(call, obj.name, symbols);
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
    callersOf(ownerName, procName) {
      return index.get(siteKey(ownerName, procName)) ?? [];
    },
  };
}

function siteKey(owner: string, proc: string): string {
  return `${owner}::${proc}`;
}

function resolveCallTarget(
  call: ALSyntaxNode,
  fallbackOwner: string,
  symbols: SymbolTable,
): { owner: string; procedure: string } | null {
  const fn = call.childForFieldName("function");
  // Layer 1 handles only unqualified calls (bare identifier target).
  // Qualified calls (member_expression) are deferred to Layer 6.
  if (fn === null || fn.kind !== ALNodeKind.identifier) return null;
  const procName = fn.text;
  if (symbols.resolveProcedure(fallbackOwner, procName) === null) return null;
  return { owner: fallbackOwner, procedure: procName };
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
