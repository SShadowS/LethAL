/**
 * The RunTrigger argument of a record call, from its argument texts. `DeleteAll(RunTrigger)` takes
 * it FIRST; `ModifyAll(Field, Value, RunTrigger)` takes it THIRD. In `ModifyAll(F, true)` the `true`
 * is the VALUE, not a flag (R213's first probe read the last argument and got this wrong).
 */
export function runTriggerFlag(method: string, args: readonly string[]): "true" | "false" | null {
  const index = method === "DeleteAll" ? 0 : method === "ModifyAll" ? 2 : -1;
  const text = args[index]?.trim().toLowerCase();
  return text === "true" || text === "false" ? text : null;
}
