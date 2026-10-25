/**
 * R727, R733: before the first publish of the instrumented target, warn when INSTALLED apps other
 * than the run's tests app depend on it, and name them (control 1.0.0.24 `InstalledDependents`).
 * A refused upgrade removes them (R709). Warn only: a failed read warns too, and no outcome
 * refuses the run.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionBackend } from "./backend";
import type { InstalledDependent } from "./harness";

export interface DependentsTarget {
  readonly name: string;
  readonly id: string;
}

/** The tests app.json's own id, lowercased; undefined when unreadable (then nothing is excluded). */
export function testsAppIdOf(testAppJson: unknown): string | undefined {
  const id = (testAppJson as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id.toLowerCase() : undefined;
}

/** The warning text, or null. `read` is the installed dependents, or the error the read threw. */
export function dependentsWarning(
  read: readonly InstalledDependent[] | { readonly error: unknown },
  testsAppId: string | undefined,
  target: DependentsTarget,
): string | null {
  if (!Array.isArray(read)) {
    const e = (read as { readonly error: unknown }).error;
    const reason = e instanceof Error ? e.message : String(e);
    return `[lethal] R727: could not check which installed apps depend on the target ${target.name} (${reason}); if an installed app depends on it and this build breaks it, BC removes that app (R709).`;
  }
  const others = (read as readonly InstalledDependent[]).filter(
    (d) => d.id.toLowerCase() !== testsAppId,
  );
  if (others.length === 0) return null;
  const named = others.map((d) => `${d.name} ${d.version} by ${d.publisher} (${d.id})`).join("; ");
  return `[lethal] R727: ${others.length} installed app(s) other than this run's tests app depend on the target ${target.name} (${target.id}): ${named}. If this build breaks one of them, BC refuses the upgrade and removes it (R709).`;
}

/** One read-only call, then the message. No `installedDependents` on the backend: no call, no message. */
export async function checkDependents(
  backend: Pick<ExecutionBackend, "installedDependents">,
  testDir: string,
  target: DependentsTarget,
): Promise<string | null> {
  if (backend.installedDependents === undefined) return null;
  let read: readonly InstalledDependent[] | { readonly error: unknown };
  try {
    read = await backend.installedDependents(target.id);
  } catch (error) {
    read = { error };
  }
  let testsAppId: string | undefined;
  try {
    testsAppId = testsAppIdOf(
      JSON.parse((await readFile(join(testDir, "app.json"), "utf8")).replace(/^﻿/, "")),
    );
  } catch {
    // An unreadable tests app.json excludes nothing: the warning may over-report, never hide.
  }
  return dependentsWarning(read, testsAppId, target);
}
