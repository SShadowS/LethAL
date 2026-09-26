import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import { InstalledArtifactError } from "./artifact";
import type { BoundArtifact } from "./backend";
import { describeThrown } from "./describe-error";
import type { ResultsStore } from "./store";

/** Where the installed artifact came from. The record, not the caller, supplies its identity. */
export interface InstalledArtifactRef {
  /** The run that published it, and its batch index in that run. */
  readonly fromRunId: number;
  readonly batchIndex: number;
  /** The compiled .app: `<sha256[0:16]>-<artifactId>.app` in the compiler outputDir. */
  readonly appPath: string;
  /** Its batch dir: `run-<fromRunId>-batch-<batchIndex>` under the session's instrumentedDir. */
  readonly instrumentedDir: string;
}

async function readLocal<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new InstalledArtifactError("local-copy-unreadable", `${what}: ${describeThrown(err)}`);
  }
}

/**
 * Links 1 and 2 of decision 1: the trusted store record exists and carries a manifest hash, and
 * the local .app and manifest are exactly the recorded ones. Reads only the store and local files;
 * never a backend. Returns the PARSED manifest; names are resolved in it and nowhere else.
 */
export async function loadInstalledArtifact(
  store: ResultsStore,
  ref: InstalledArtifactRef,
): Promise<{ artifact: BoundArtifact; manifest: MutantManifest }> {
  const record = store.trustedArtifactRecord(ref.fromRunId, ref.batchIndex);
  if (record === null) {
    throw new InstalledArtifactError(
      "no-record",
      `run ${ref.fromRunId} recorded no artifact for batch ${ref.batchIndex}`,
    );
  }
  if (record.manifestSha256 === null) {
    throw new InstalledArtifactError(
      "no-record",
      `run ${ref.fromRunId} batch ${ref.batchIndex} was recorded without a manifest hash (written before that column existed), so it cannot be trusted`,
    );
  }
  const manifestPath = join(ref.instrumentedDir, "mutant-manifest.json");
  const appBytes = await readLocal(ref.appPath, () => readFile(ref.appPath));
  const manifestText = await readLocal(manifestPath, () => readFile(manifestPath, "utf8"));
  const manifest = await readLocal(
    manifestPath,
    async () => JSON.parse(manifestText) as MutantManifest,
  );

  const appSha = Bun.SHA256.hash(appBytes, "hex");
  if (appSha !== record.sha256) {
    throw new InstalledArtifactError(
      "local-copy-differs",
      `${ref.appPath} hashes to ${appSha}, the record says ${record.sha256}`,
    );
  }
  // Hash of the RE-STRINGIFIED object, matching what step 3d hashed (the compiler's object), so
  // whitespace in the file does not matter and a different mutant list does.
  const manifestSha = Bun.SHA256.hash(JSON.stringify(manifest), "hex");
  if (manifestSha !== record.manifestSha256) {
    throw new InstalledArtifactError(
      "manifest-differs",
      `${manifestPath} hashes to ${manifestSha}, the record says ${record.manifestSha256}`,
    );
  }
  if (manifest.artifactId !== record.artifactId) {
    throw new InstalledArtifactError(
      "manifest-differs",
      `${manifestPath} names artifact ${String(manifest.artifactId)}, the record says ${record.artifactId}`,
    );
  }
  return {
    artifact: {
      appId: record.appId,
      artifactId: record.artifactId,
      sha256: record.sha256,
      appPath: ref.appPath,
      instrumentedDir: ref.instrumentedDir,
    },
    manifest,
  };
}
