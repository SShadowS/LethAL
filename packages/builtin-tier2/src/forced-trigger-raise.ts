import {
  type ALSyntaxNode,
  type SemanticContext,
  type SymbolTable,
  findTableTrigger,
  rawArmOf,
  resolveReceiverTable,
} from "@lethal/engine";

// R-452: R281's SKIP half moved to `@lethal/engine` (`semantic/trigger-skip.ts`) so a Tier-1
// operator can tag against the same predicate. Re-exported so every Tier-2 import stays as it was.
export {
  type HarmlessTriggerKind,
  deleteSkipCanRaise,
  isHarmlessTriggerCall,
} from "@lethal/engine";

/**
 * R165: `lethal.swap-modify-flag`'s forward direction rewrites `Rec.Modify()` to `Rec.Modify(true)`.
 * `Rec.Modify()` means `RunTrigger = false`, so the mutant makes `OnModify` run where it did not.
 * This file holds only that direction's SITE test (`resolveForcedTrigger`).
 *
 * R-457: whether the mutant carries `run-trigger-forced` is `forceCanRaise` in `@lethal/engine`,
 * which reads no trigger body. R165's body reader (`forcedTriggerCanRaise`, a list of ten
 * raise-capable call names) was unsound and is gone: it missed calls without parentheses, `with`,
 * indirect calls, raising assignments and subscribers that branch on `RunTrigger`.
 */

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
