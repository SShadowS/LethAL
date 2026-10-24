/**
 * R727: before the first publish of the instrumented target, warn when published apps other than
 * the run's tests app depend on it. A refused upgrade removes them (R709). Warn only: a failed
 * read warns too, and no outcome refuses the run.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionBackend } from "./backend";

export interface DependentsTarget {
  readonly name: string;
  readonly id: string;
}

/** How many dependents the run accounts for: 1 when the tests app.json declares the target. */
export function accountedFor(testAppJson: unknown, targetId: string): number {
  const deps = (testAppJson as { dependencies?: unknown } | null | undefined)?.dependencies;
  if (!Array.isArray(deps)) return 0;
  const want = targetId.toLowerCase();
  return deps.some(
    (d) =>
      typeof (d as { id?: unknown })?.id === "string" &&
      (d as { id: string }).id.toLowerCase() === want,
  )
    ? 1
    : 0;
}

/** The warning text, or null. `read` is the count, or the error the read threw. */
export function dependentsWarning(
  read: number | { readonly error: unknown },
  k: number,
  target: DependentsTarget,
): string | null {
  if (typeof read !== "number") {
    const e = read.error;
    const reason = e instanceof Error ? e.message : String(e);
    return `[lethal] R727: could not check which installed apps depend on the target ${target.name} (${reason}); if an installed app depends on it and this build breaks it, BC removes that app (R709).`;
  }
  if (read <= k) return null;
  return `[lethal] R727: ${read} published app(s) depend on the target ${target.name} (${target.id}); this run accounts for ${k} (its tests app). If this build breaks one of the others, BC refuses the upgrade and removes it (R709). Names need LethAL Control 1.0.0.24; the count includes every published version.`;
}

/** One read-only call, then the message. No `dependentCount` on the backend: no call, no message. */
export async function checkDependents(
  backend: Pick<ExecutionBackend, "dependentCount">,
  testDir: string,
  target: DependentsTarget,
): Promise<string | null> {
  if (backend.dependentCount === undefined) return null;
  let read: number | { readonly error: unknown };
  try {
    read = await backend.dependentCount(target.id);
  } catch (error) {
    read = { error };
  }
  let k = 0;
  try {
    k = accountedFor(
      JSON.parse((await readFile(join(testDir, "app.json"), "utf8")).replace(/^﻿/, "")),
      target.id,
    );
  } catch {
    // An unreadable tests app.json accounts for nothing: the warning may over-report, never hide.
  }
  return dependentsWarning(read, k, target);
}
