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
  /** R845: dependents of the dependents, breadth first. BC removes them too (U4). */
  transitive: readonly InstalledDependent[] = [],
): string | null {
  if (!Array.isArray(read)) {
    const e = (read as { readonly error: unknown }).error;
    const reason = e instanceof Error ? e.message : String(e);
    return `[lethal] R727: could not check which installed apps depend on the target ${target.name} (${reason}); if an installed app depends on it and this build breaks it, BC removes that app (R709).`;
  }
  const others = [...(read as readonly InstalledDependent[]), ...transitive].filter(
    (d) => d.id.toLowerCase() !== testsAppId,
  );
  if (others.length === 0) return null;
  const named = others
    .map(
      (d) =>
        `${d.name} ${d.version} by ${d.publisher} (${d.id})${transitive.includes(d) ? " [transitive]" : ""}`,
    )
    .join("; ");
  return `[lethal] R727: ${others.length} installed app(s) other than this run's tests app depend on the target ${target.name} (${target.id}), directly or through another: ${named}. If this build breaks one of them, BC refuses the upgrade and removes it, and every app that depends on it (R709, R845).`;
}

/** What one read of the installed dependents gave, with the tests app's id (R843 shares it). */
export interface DependentsRead {
  readonly read: readonly InstalledDependent[] | { readonly error: unknown };
  readonly testsAppId: string | undefined;
  /** R845: the dependents of the dependents, breadth first, without repeats. Empty when `read` is an error. */
  readonly transitive: readonly InstalledDependent[];
  /** R845: warnings from the walk: a level that could not be read, or the bound. */
  readonly walkWarnings: readonly string[];
  /** R845: `now()` when the walk began, for the bound on the reads that follow. */
  readonly startedMs: number;
}

/** R845: the walk reads at most this many apps, in at most this long (ms), in all. */
export const WALK_MAX_APPS = 40;
export const WALK_MAX_MS = 120_000;

/**
 * R845: the apps that depend on the direct dependents, and so on, breadth first, the tests app's
 * branch first. `installedDependents` takes any app id. The visited set starts with the target's own
 * id, lower-cased, or a stray row would put the target in its own list. A level that cannot be read
 * warns by name and ends that branch. Past the bound the walk stops, warns, and never fails.
 */
export async function walkTransitiveDependents(
  list: (appId: string) => Promise<readonly InstalledDependent[]>,
  targetId: string,
  direct: readonly InstalledDependent[],
  testsAppId: string | undefined,
  clock: { readonly now: () => number; readonly startedMs: number },
): Promise<{ transitive: InstalledDependent[]; warnings: string[] }> {
  const visited = new Set<string>([
    targetId.toLowerCase(),
    ...direct.map((d) => d.id.toLowerCase()),
  ]);
  const queue = [...direct].sort(
    (a, b) => Number(b.id.toLowerCase() === testsAppId) - Number(a.id.toLowerCase() === testsAppId),
  );
  const transitive: InstalledDependent[] = [];
  const warnings: string[] = [];
  for (let at = 0; at < queue.length; at++) {
    const d = queue[at];
    if (d === undefined) break;
    if (
      direct.length + transitive.length >= WALK_MAX_APPS ||
      clock.now() - clock.startedMs >= WALK_MAX_MS
    ) {
      const rest = queue.slice(at);
      warnings.push(
        `[lethal] R845: stopped listing dependents after ${at} app(s) (the bound is ${WALK_MAX_APPS} apps and ${WALK_MAX_MS / 1000} s): the dependents of ${rest.length} app(s) were NOT read, first ${rest
          .slice(0, 3)
          .map((r) => `${r.name} ${r.version}`)
          .join(", ")}. An app that depends on them is not listed.`,
      );
      break;
    }
    let next: readonly InstalledDependent[];
    try {
      next = await list(d.id);
    } catch (err) {
      warnings.push(
        `[lethal] R845: could not read which installed apps depend on ${d.name} ${d.version} (${err instanceof Error ? err.message : String(err)}); apps that depend on it, and on those, are not listed.`,
      );
      continue;
    }
    for (const n of next) {
      const key = n.id.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      transitive.push(n);
      queue.push(n);
    }
  }
  return { transitive, warnings };
}

/** One read-only call, then the walk (R845). `null` when the backend has no `installedDependents`: no call was made. */
export async function readDependents(
  backend: Pick<ExecutionBackend, "installedDependents">,
  testDir: string,
  target: DependentsTarget,
  now: () => number,
): Promise<DependentsRead | null> {
  const list = backend.installedDependents?.bind(backend);
  if (list === undefined) return null;
  const startedMs = now();
  let read: readonly InstalledDependent[] | { readonly error: unknown };
  try {
    read = await list(target.id);
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
  const walked = Array.isArray(read)
    ? await walkTransitiveDependents(list, target.id, read, testsAppId, { now, startedMs })
    : { transitive: [], warnings: [] };
  return {
    read,
    testsAppId,
    transitive: walked.transitive,
    walkWarnings: walked.warnings,
    startedMs,
  };
}
