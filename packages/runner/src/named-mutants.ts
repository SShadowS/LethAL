import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { InstalledArtifactError } from "./artifact";
import type { BoundArtifact, TestMethodRef } from "./backend";
import { describeThrown } from "./describe-error";
import { openInstalledBundle } from "./installed-bundle";
import { manifestObjectKeys, renamedMemberNamesOf } from "./line-map";
import { testKeyOf } from "./selection";
import { PRUNED_BY_ENV_TEARDOWN, type ResultsStore } from "./store";

/** Where the installed artifact came from. The record, not the caller, supplies its identity. */
export interface InstalledArtifactRef {
  /** The run that published it, and its batch index in that run. */
  readonly fromRunId: number;
  readonly batchIndex: number;
  /** Where step 3d found the compiled .app. R360: a label for messages only; the bytes come from
   *  the store, and the file is removed with the run's scratch folder. */
  readonly appPath: string;
  /** Where step 3d found the batch dir. R360: a label for messages only, like `appPath`. */
  readonly instrumentedDir: string;
}

/** R360: why a row written before R360 has no stored files. Shared with `lethal verify`. */
export function predatesR360Detail(runId: number, batchIndex: number): string {
  return `run ${runId} batch ${batchIndex} was recorded before R360; its files were kept in the temp folder then, not in the store; run lethal run again, then verify`;
}

/**
 * R360: what pruned a batch's stored files. Shared with `lethal verify` and `--resume`.
 * `resourceKey` is the run's: a NULL key groups with NULL, so no server is claimed then (review
 * M-4). `PRUNED_BY_ENV_TEARDOWN` means the environment they were installed on was deleted.
 */
export function prunedDetail(
  runId: number,
  batchIndex: number,
  prunedBy: number,
  resourceKey: string | null,
): string {
  if (prunedBy === PRUNED_BY_ENV_TEARDOWN) {
    return `run ${runId}'s installed files were removed when the environment they were installed on was deleted at teardown`;
  }
  if (prunedBy === runId) {
    return `run ${runId}'s installed files for batch ${batchIndex} were replaced when a later batch of the same run was published`;
  }
  const group = resourceKey === null ? "same app, no recorded server" : "same app, same server";
  return `run ${runId}'s installed files were pruned when run ${prunedBy} finished (${group}), so they were replaced`;
}

/**
 * Links 1 and 2 of decision 1: the trusted store record exists and carries a manifest hash, and
 * the stored .app and manifest are exactly the recorded ones. Reads only the store (R360: the
 * installed files live there, checked against the payload digest recorded at publish); never a
 * file or a backend. Returns the PARSED manifest; names are resolved in it and nowhere else. The
 * returned artifact carries the verified .app bytes, `app.json` and every `.al` source, so no
 * later step reads anything this check did not see.
 *
 * Trust assumption: an artifactId is assumed to name one source set. A forged or partial build
 * carrying the same id is NOT detected here, so a named guard absent from it could still score
 * `survived`. Per-mutant proof is GH-24's guard-reach attestation, not this function.
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
  // Review r1 fix 3: the record is validated here, typed, before anything reaches a verifier.
  if (record.appId === null) {
    throw new InstalledArtifactError(
      "no-record",
      `run ${ref.fromRunId} recorded batch ${ref.batchIndex} but no app id, so it cannot be trusted`,
    );
  }
  if (!/^[0-9a-f]{32}$/.test(record.artifactId)) {
    throw new InstalledArtifactError(
      "no-record",
      `run ${ref.fromRunId} batch ${ref.batchIndex} records artifact id "${record.artifactId}", which is not 32 lowercase hex, so it cannot be trusted`,
    );
  }
  // R360: no path fallback. A pre-R360 row is refused even when its temp folder still exists.
  if (record.payloadSha256 === null) {
    throw new InstalledArtifactError(
      "no-record",
      predatesR360Detail(ref.fromRunId, ref.batchIndex),
    );
  }
  if (record.bundlePrunedBy !== null) {
    throw new InstalledArtifactError(
      "replaced",
      prunedDetail(ref.fromRunId, ref.batchIndex, record.bundlePrunedBy, record.resourceKey),
    );
  }
  const rows = store.installedBundle(ref.fromRunId, ref.batchIndex);
  if (rows === null) {
    throw new InstalledArtifactError(
      "payload-differs",
      `run ${ref.fromRunId} batch ${ref.batchIndex} records an instrumented payload digest but the store holds no installed files for it (a corrupt store)`,
    );
  }
  const stored = openInstalledBundle(rows, {
    runId: ref.fromRunId,
    batchIndex: ref.batchIndex,
    payloadSha256: record.payloadSha256,
  });
  const where = `the stored files of run ${ref.fromRunId} batch ${ref.batchIndex}`;
  let manifest: MutantManifest;
  try {
    manifest = JSON.parse(stored.manifestText) as MutantManifest;
  } catch (err) {
    throw new InstalledArtifactError(
      "manifest-differs",
      `${where}: the manifest does not parse: ${describeThrown(err)}`,
    );
  }

  const appSha = Bun.SHA256.hash(stored.appBytes, "hex");
  if (appSha !== record.sha256) {
    throw new InstalledArtifactError(
      "local-copy-differs",
      `${where}: the .app hashes to ${appSha}, the record says ${record.sha256}`,
    );
  }
  // Hash of the RE-STRINGIFIED object, matching what step 3d hashed (the compiler's object), so
  // whitespace in the file does not matter and a different mutant list does.
  const manifestSha = Bun.SHA256.hash(JSON.stringify(manifest), "hex");
  if (manifestSha !== record.manifestSha256) {
    throw new InstalledArtifactError(
      "manifest-differs",
      `${where}: the manifest hashes to ${manifestSha}, the record says ${record.manifestSha256}`,
    );
  }
  if (manifest.artifactId !== record.artifactId) {
    throw new InstalledArtifactError(
      "manifest-differs",
      `${where}: the manifest names artifact ${String(manifest.artifactId)}, the record says ${record.artifactId}`,
    );
  }
  return {
    artifact: {
      appId: record.appId,
      artifactId: record.artifactId,
      sha256: record.sha256,
      appPath: ref.appPath,
      instrumentedDir: ref.instrumentedDir,
      appBytes: stored.appBytes,
      appJsonText: stored.appJsonText,
      alSources: stored.alSources,
      renamedMemberNames: renamedMemberNamesOf(manifest.mutants),
      manifestObjectKeys: manifestObjectKeys(manifest.mutants),
    },
    manifest,
  };
}

/** Decision 3's request-shape refusals (context.md). Plain messages naming every offending id;
 *  extends `Error` directly, like `InstalledArtifactError` beside it, and never either of it. */
export class NamedMutantError extends Error {}

export interface ResolvedNamedMutant {
  readonly mutant: MutantManifestEntry;
  readonly methods: readonly TestMethodRef[];
}

/** A caller-named mutant plus the methods to run against it. Chosen by the caller (C02-06: the
 *  report's coveringTests plus new tests). */
export interface NamedMutantRequest {
  readonly mutantId: string;
  readonly methods: readonly TestMethodRef[];
}

/**
 * Decision 3's refusals, all `NamedMutantError`, all before any backend call, in this order: an
 * empty request list; a repeated mutant id; a mutant id `manifest` does not contain (naming
 * every unknown one); a request with no methods; a repeated method within one request.
 * `manifest` is the one `loadInstalledArtifact` matched, so a name is resolved only inside it.
 * Never returns `[]`.
 */
export function resolveNamedMutants(
  manifest: MutantManifest,
  requests: readonly NamedMutantRequest[],
): readonly ResolvedNamedMutant[] {
  if (requests.length === 0) {
    throw new NamedMutantError(
      "resolveNamedMutants refuses an empty request list: name at least one mutant",
    );
  }

  const seenIds = new Set<string>();
  const repeatedIds: string[] = [];
  for (const { mutantId } of requests) {
    if (seenIds.has(mutantId)) repeatedIds.push(mutantId);
    seenIds.add(mutantId);
  }
  if (repeatedIds.length > 0) {
    throw new NamedMutantError(
      `resolveNamedMutants refuses repeated mutant id(s): ${repeatedIds.join(", ")}`,
    );
  }

  const byId = new Map(manifest.mutants.map((mutant) => [mutant.mutantId, mutant] as const));
  const unknownIds = requests.map((request) => request.mutantId).filter((id) => !byId.has(id));
  if (unknownIds.length > 0) {
    throw new NamedMutantError(
      `resolveNamedMutants refuses mutant id(s) not in artifact ${manifest.artifactId}: ${unknownIds.join(", ")}`,
    );
  }

  for (const { mutantId, methods } of requests) {
    if (methods.length === 0) {
      throw new NamedMutantError(`resolveNamedMutants refuses ${mutantId}: it names no methods`);
    }
    const seenMethods = new Set<string>();
    const repeatedMethods: string[] = [];
    for (const method of methods) {
      const key = testKeyOf(method);
      if (seenMethods.has(key)) repeatedMethods.push(key);
      seenMethods.add(key);
    }
    if (repeatedMethods.length > 0) {
      throw new NamedMutantError(
        `resolveNamedMutants refuses ${mutantId}: repeated method(s) ${repeatedMethods.join(", ")}`,
      );
    }
  }

  // Every id was checked against byId above, so this never falls through to the throw below;
  // it exists only to satisfy noUncheckedIndexedAccess-style narrowing without a `!` assertion.
  return requests.map((request) => {
    const mutant = byId.get(request.mutantId);
    if (mutant === undefined) {
      throw new NamedMutantError(`resolveNamedMutants: ${request.mutantId} is not in the manifest`);
    }
    return { mutant, methods: request.methods };
  });
}

/** Every method any request names, deduplicated by `testKeyOf` (selection.ts), first-seen order. */
export function baselineTestsOf(named: readonly ResolvedNamedMutant[]): readonly TestMethodRef[] {
  const seen = new Set<string>();
  const out: TestMethodRef[] = [];
  for (const { methods } of named) {
    for (const method of methods) {
      const key = testKeyOf(method);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(method);
      }
    }
  }
  return out;
}
