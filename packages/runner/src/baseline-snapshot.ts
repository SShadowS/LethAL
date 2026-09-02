/**
 * R192, second half: a batch's baseline is reused on `--resume` when nothing it measured can have
 * changed.
 *
 * The baseline does four jobs for a batch: it establishes the green set (R55), collects the
 * coverage every mutant is attributed with, measures the durations the mutant budgets are derived
 * from, and proves the published test app is the one the source declares (R56/R139). Every one of
 * those is a function of two things: the INSTRUMENTED SOURCE the batch published, and the TEST APP
 * the server holds. When both are byte-identical to what a prior run measured, re-running the
 * baseline re-measures the same function of the same inputs. Measured 2026-09-02 on a hosted
 * sandbox: 407 tests, 197 to 242 s, on every one of twelve resumes, for a batch that still had
 * mutants to run and could not be skipped by the first half.
 *
 * What is deliberately NOT covered by the two hashes, and is the caveat a reader of a resumed
 * report is given: the environment's DATA. A test that was green at the prior baseline and would
 * be red now because the sandbox changed underneath is not re-detected. That risk already exists
 * inside every run (the baseline runs once, the mutants minutes later), and a resume within the
 * same lineage is not a different kind of risk; it is stated rather than measured away.
 *
 * The batch hash covers the `.al` files of the instrumented artifact directory EXCEPT the three
 * control files LethAL emits, because `MutationSelector.Codeunit.al` embeds the artifact id, which
 * is random per artifact by design (`newArtifactId`), and it carries no target code whose lines a
 * coverage row could name. Two artifacts of one batch therefore hash the same, which is what makes
 * a prior run's fenced line-number coverage apply to this run's artifact.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_UPGRADE_FILENAME,
} from "@lethal/schemata";
import type { TestMethodRef, TestVerdict } from "./backend";

const CONTROL_FILES: ReadonlySet<string> = new Set([
  CONTROL_SELECTOR_FILENAME,
  CONTROL_REGISTER_FILENAME,
  CONTROL_UPGRADE_FILENAME,
]);

/** One baseline observation as the orchestrator holds it; the payload a snapshot stores verbatim. */
export interface BaselineObservation {
  readonly ref: TestMethodRef;
  readonly verdict: TestVerdict;
}

export interface BaselineSnapshot {
  readonly runId: number;
  readonly batchIndex: number;
  readonly batchHash: string;
  readonly testAppHash: string;
  readonly baseline: readonly BaselineObservation[];
}

/**
 * SHA-256 over every `.al` file under `dir` (recursively, sorted, path and bytes), skipping the
 * control files. Deterministic across two artifacts of the same batch, different for any change
 * to any instrumented line.
 */
export async function hashAlTree(dir: string): Promise<string> {
  const all = await readdir(dir, { recursive: true });
  const entries = all
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.toLowerCase().endsWith(".al"))
    .filter((f) => !CONTROL_FILES.has(f.split("/").at(-1) ?? ""))
    .sort();
  const h = createHash("sha256");
  for (const rel of entries) {
    h.update(`${rel}\n`);
    h.update(await readFile(join(dir, rel)));
    h.update("\n");
  }
  return h.digest("hex");
}

/** SHA-256 of a published package's bytes, the test app as the SERVER holds it. */
export function hashPackage(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The test app's identity for the snapshot key. The published package when the backend can read
 * it (bcdev), else the test project's own `.al` tree (al-runner compiles the test bundle itself, so
 * the source IS what runs). `undefined` when neither can be established, which means "do not
 * reuse": an unknown test app is not an unchanged one.
 */
export async function testAppHashFor(
  fetchPackage: (() => Promise<Uint8Array | null | undefined>) | undefined,
  testDir: string,
): Promise<string | undefined> {
  if (fetchPackage !== undefined) {
    const bytes = await fetchPackage();
    if (bytes instanceof Uint8Array) return `package:${hashPackage(bytes)}`;
    if (bytes === null) return undefined; // the read failed; not the same as "no package concept"
    // `undefined`: the backend cannot form the request (env-tool path). Fall through to source.
  }
  try {
    return `source:${await hashAlTree(testDir)}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a stored snapshot may stand in for this batch's baseline. Both hashes must match; a
 * snapshot from any earlier run in the same database qualifies, since the hashes are the identity
 * and the run id is provenance.
 */
export function snapshotApplies(
  snapshot: BaselineSnapshot | null,
  batchHash: string,
  testAppHash: string | undefined,
): snapshot is BaselineSnapshot {
  if (snapshot === null || testAppHash === undefined) return false;
  return snapshot.batchHash === batchHash && snapshot.testAppHash === testAppHash;
}
