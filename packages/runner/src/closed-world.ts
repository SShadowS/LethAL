/**
 * R389 guard (coord guard-build-plan.md). The test digest traces a Variant parameter through its
 * test-app callers only when no other app can call the procedure. A `local` procedure is always
 * such a one. A public or internal one is such a one only when NO published app on the server
 * declares the test app as a dependency (an app that does could call it with a test-app codeunit,
 * and its code is in no digest); `internal` also needs the test app's app.json to name no
 * `internalsVisibleTo`.
 *
 * The count comes from the control app's `DependentCount` (1.0.0.21), so only bcdev can answer.
 * Every other case falls back (`OPEN_WORLD`): al-runner, an older control app, an error, a count
 * above 0, or an app.json without an id.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionBackend } from "./backend";
import { DependentCountUnavailableError } from "./harness";
import { type ClosedWorld, OPEN_WORLD } from "./testpage-scan";

export interface ClosedWorldResult {
  readonly closedWorld: ClosedWorld;
  /** Why, in a sentence, for the run's record. */
  readonly why: string;
  /** The server was asked and failed: worth a warning. An older control app is not. */
  readonly warn: boolean;
}

const open = (why: string, warn = false): ClosedWorldResult => ({
  closedWorld: OPEN_WORLD,
  why,
  warn,
});

/** The guard over a parsed test-app app.json. */
export async function closedWorldOf(
  appJson: unknown,
  backend: Pick<ExecutionBackend, "dependentCount">,
): Promise<ClosedWorldResult> {
  if (backend.dependentCount === undefined)
    return open("this backend cannot ask the server which apps depend on the test app");
  const j = (typeof appJson === "object" && appJson !== null ? appJson : {}) as Record<
    string,
    unknown
  >;
  if (typeof j.id !== "string") return open("the test app's app.json names no id", true);
  let count: number;
  try {
    count = await backend.dependentCount(j.id);
  } catch (err) {
    if (err instanceof DependentCountUnavailableError)
      return open("the deployed LethAL Control predates DependentCount (1.0.0.21)");
    return open(`DependentCount failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (count > 0) return open(`${count} published app(s) declare the test app as a dependency`);
  // Any `internalsVisibleTo` value at all, even a malformed one, keeps internal open.
  const internal = !("internalsVisibleTo" in j);
  return {
    closedWorld: { public: true, internal },
    why: `no published app declares the test app as a dependency${internal ? "" : "; its app.json names internalsVisibleTo, so internal procedures stay open"}`,
    warn: false,
  };
}

/** The guard over the test project's app.json on disk. */
export async function closedWorldGuard(
  backend: Pick<ExecutionBackend, "dependentCount">,
  testDir: string,
): Promise<ClosedWorldResult> {
  let json: unknown;
  try {
    json = JSON.parse((await readFile(join(testDir, "app.json"), "utf8")).replace(/^﻿/, ""));
  } catch (err) {
    return open(
      `the test app's app.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  return closedWorldOf(json, backend);
}
