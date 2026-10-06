/**
 * R389 guard (coord guard-build-plan.md). The test digest traces a Variant parameter through its
 * test-app callers only when no other app can call the procedure. A `local` procedure is always
 * such a one. A public or internal one is such a one only when NO published app on the server
 * declares the test app as a dependency (an app that does could call it with a test-app codeunit,
 * and its code is in no digest); `internal` also needs no `internalsVisibleTo`, in the test
 * project's app.json nor in the digested package.
 *
 * The count comes from the control app's `DependentCount` (1.0.0.21), so only bcdev can answer.
 * It is asked for the app whose source is DIGESTED (the published package on bcdev), and only when
 * that id equals the test project's app.json id (sol's review: a disk id naming another app would
 * count that app's dependents). Every other case falls back (`OPEN_WORLD`): al-runner, an older
 * control app, an error, a count above 0, an unknown or mismatched id.
 *
 * Zero is a point-in-time observation: callers ask again after execution (`sameClosedWorld`) and
 * keep the open-world digests unless the second answer is the same closed one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readPackageEntry } from "./app-package";
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

/** The package whose source is digested: its app id and whether it names internalsVisibleTo. */
export interface DigestedApp {
  readonly appId: string | undefined;
  /** `undefined` is unknown, which keeps `internal` open. */
  readonly internalsVisibleTo: boolean | undefined;
}

const open = (why: string, warn = false): ClosedWorldResult => ({
  closedWorld: OPEN_WORLD,
  why,
  warn,
});

/** Whether an answer narrows anything (either flag closed). */
export const isClosedWorld = (cw: ClosedWorld): boolean => cw.public || cw.internal;
const isClosed = isClosedWorld;

/** The id and internalsVisibleTo of a package's `NavxManifest.xml`; unknowns stay undefined. */
export function digestedAppOfPackage(pkg: Uint8Array): DigestedApp {
  const xml = readPackageEntry(Buffer.from(pkg), "NavxManifest.xml")?.toString("utf8");
  if (xml === undefined) return { appId: undefined, internalsVisibleTo: undefined };
  const appId = /<App\b[^>]*\bId="([^"]+)"/.exec(xml)?.[1];
  // alc writes `<InternalsVisibleTo />` when there is none. Any other form, or none, counts as named.
  const tag = /<InternalsVisibleTo\b[^>]*>/.exec(xml)?.[0];
  return { appId, internalsVisibleTo: tag === undefined ? undefined : !/\/>$/.test(tag) };
}

/** The guard over a parsed test-project app.json and the digested package. */
export async function closedWorldOf(
  appJson: unknown,
  digested: DigestedApp,
  backend: Pick<ExecutionBackend, "dependentCount">,
): Promise<ClosedWorldResult> {
  if (backend.dependentCount === undefined)
    return open("this backend cannot ask the server which apps depend on the test app");
  const j = (typeof appJson === "object" && appJson !== null ? appJson : {}) as Record<
    string,
    unknown
  >;
  if (typeof j.id !== "string") return open("the test app's app.json names no id", true);
  if (digested.appId === undefined)
    return open("the digested test app package names no app id", true);
  if (digested.appId.toLowerCase() !== j.id.toLowerCase())
    return open(
      `the digested test app package is ${digested.appId}, but the test app.json names ${j.id}`,
      true,
    );
  let count: number;
  try {
    count = await backend.dependentCount(digested.appId);
  } catch (err) {
    if (err instanceof DependentCountUnavailableError)
      return open("the deployed LethAL Control predates DependentCount (1.0.0.21)");
    return open(`DependentCount failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (count > 0) return open(`${count} published app(s) declare the test app as a dependency`);
  // Any `internalsVisibleTo` value at all, even a malformed one, keeps internal open.
  const internal = !("internalsVisibleTo" in j) && digested.internalsVisibleTo === false;
  return {
    closedWorld: { public: true, internal },
    why: `no published app declares the test app as a dependency${internal ? "" : "; internalsVisibleTo is named or unknown, so internal procedures stay open"}`,
    warn: false,
  };
}

/** The test project's app.json, parsed; `undefined` when it cannot be read. */
async function readAppJson(testDir: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(join(testDir, "app.json"), "utf8")).replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/**
 * The guard for a test project. `digested` is the package whose source is digested; absent, the
 * disk source is what is digested (verify, al-runner), so its own app.json names it, and its
 * internalsVisibleTo is read from that app.json alone.
 */
export async function closedWorldGuard(
  backend: Pick<ExecutionBackend, "dependentCount">,
  testDir: string,
  digested?: DigestedApp,
): Promise<ClosedWorldResult> {
  const json = await readAppJson(testDir);
  if (json === undefined) return open("the test app's app.json could not be read", true);
  const id = (json as { id?: unknown }).id;
  return closedWorldOf(
    json,
    digested ?? { appId: typeof id === "string" ? id : undefined, internalsVisibleTo: false },
    backend,
  );
}

/** The race check: true only when both answers are closed-world and the same. */
export function sameClosedWorld(first: ClosedWorldResult, again: ClosedWorldResult): boolean {
  return (
    isClosed(first.closedWorld) &&
    first.closedWorld.public === again.closedWorld.public &&
    first.closedWorld.internal === again.closedWorld.internal
  );
}

/**
 * R389 carry binding: the test-app identity a run records and compares (resume,
 * `--skip-known-survivors`, baseline reuse), with the guard's answer appended when it is not
 * open. An open answer, and every run recorded before the guard, keeps the bare hash.
 */
export function guardedTestAppHash(hash: string, cw: ClosedWorld): string {
  if (!isClosed(cw)) return hash;
  return `${hash}|closed-world:${[cw.public ? "public" : "", cw.internal ? "internal" : ""].filter((s) => s !== "").join("+")}`;
}

/** Verify's plan relied on a closed-world answer that did not hold after execution. Extends
 *  `Error` directly (CLAUDE.md); never a verify refusal, so the refusal schema is unchanged. */
export class ClosedWorldChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClosedWorldChangedError";
  }
}

/** R389: the suffix a closed-world run's identity and snapshots carry until the post-execution
 *  recheck confirms them (`ResultsStore.confirmClosedWorld`). No session computes it, so a pending
 *  owner, a run killed before confirmation included, never supplies a verdict or a baseline. */
export const PENDING_SUFFIX = "|pending";

/** The suffix a run's recorded identity gets when its post-execution check failed: matches nothing. */
export const REVOKED_SUFFIX = "|closed-world:revoked";
