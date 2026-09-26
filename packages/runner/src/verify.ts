import { hashTargetSource } from "./baseline-snapshot";
import type { InstalledArtifactRef } from "./named-mutants";
import type { ResultsStore } from "./store";

/** C02-06 decision 7: every reason `lethal verify` can refuse for, before it measures anything. */
export const VERIFY_REFUSALS = [
  "malformed-request",
  "unknown-artifact",
  "batch-not-installed",
  "wrong-batch",
  "unknown-mutant",
  "not-a-survivor",
  "carried",
  "source-predates-verify",
  "source-changed",
  "covering-test-unmatched",
  "no-tests-to-run",
  "unsupported-config",
  // InstalledArtifactError
  "stale-artifact",
  "artifact-files-unusable",
  // TestAppError
  "test-app-compile-failed",
  "test-app-version-below-resident",
  "test-app-publish-failed",
  "test-app-resident-unreadable",
] as const;

export type VerifyRefusal = (typeof VERIFY_REFUSALS)[number];

/** A refusal before any measurement. Extends Error directly, never another typed error. */
export class VerifyError extends Error {
  constructor(
    readonly reason: VerifyRefusal,
    readonly detail: string,
  ) {
    super(`verify refused (${reason}): ${detail}`);
    this.name = "VerifyError";
  }
}

export interface VerifyRequest {
  readonly artifactId: string;
  readonly ids: ReadonlyArray<{ readonly batchIndex: number; readonly mutantCode: string }>;
}

const ARTIFACT_ID = /^[0-9a-f]{32}$/;
const SURVIVOR_ID = /^(0|[1-9]\d*)\/(M\d{4,})$/;

/**
 * Decisions 1 and 2. The artifact is 32 lowercase hex. Each `--survivors` value is a comma list of
 * `<batchIndex>/<mutantCode>` ids, and repeated flags add to one list. An empty list, a malformed
 * id or the same id twice is refused, never dropped or merged.
 */
export function parseVerifyRequest(artifact: string, survivors: readonly string[]): VerifyRequest {
  if (!ARTIFACT_ID.test(artifact)) {
    throw new VerifyError(
      "malformed-request",
      `--artifact "${artifact}" is not a 32-character lowercase hex artifact id`,
    );
  }
  const raw = survivors.flatMap((v) => v.split(",")).map((s) => s.trim());
  if (raw.length === 0) {
    throw new VerifyError("malformed-request", "--survivors names no mutant");
  }
  const bad = raw.filter((s) => !SURVIVOR_ID.test(s));
  if (bad.length > 0) {
    throw new VerifyError(
      "malformed-request",
      `not a <batchIndex>/<mutantCode> id (for example 0/M0004): ${bad.map((s) => `"${s}"`).join(", ")}`,
    );
  }
  const repeated = [...new Set(raw.filter((s, i) => raw.indexOf(s) !== i))];
  if (repeated.length > 0) {
    throw new VerifyError("malformed-request", `named more than once: ${repeated.join(", ")}`);
  }
  const ids = raw.map((s) => {
    const [batch, code] = s.split("/");
    if (batch === undefined || code === undefined) throw new Error(`verify.ts: unparsed id ${s}`);
    return { batchIndex: Number(batch), mutantCode: code };
  });
  return { artifactId: artifact, ids };
}

export interface VerifySource {
  readonly runId: number;
  readonly projectPath: string;
  readonly artifactSha256: string;
  readonly sourceSha256: string;
  readonly installed: InstalledArtifactRef;
  readonly targets: ReadonlyArray<{
    readonly batchIndex: number;
    readonly mutantCode: string;
    readonly coveringTests: readonly string[];
  }>;
}

// Which reason a refusal carries when ids fail for different reasons. The detail names them all.
const PER_ID_ORDER: readonly VerifyRefusal[] = [
  "wrong-batch",
  "unknown-mutant",
  "source-predates-verify",
  "carried",
  "not-a-survivor",
];

/**
 * Decision 3. Resolves the request inside the NAMED artifact only, never by recency. Store only:
 * never touches a file or a server. A per-id refusal names every offending id, not only the first.
 */
export function resolveVerifySource(store: ResultsStore, req: VerifyRequest): VerifySource {
  const rec = store.artifactRecordById(req.artifactId);
  if (rec === null) {
    throw new VerifyError(
      "unknown-artifact",
      `the store records no artifact ${req.artifactId}; copy the id from the run's report (artifacts[].artifactId)`,
    );
  }
  if (rec.batchIndex !== rec.highestBatchIndex) {
    throw new VerifyError(
      "batch-not-installed",
      `artifact ${req.artifactId} is batch ${rec.batchIndex} of run ${rec.runId}, but batch ${rec.highestBatchIndex} was published after it and replaced it on the server`,
    );
  }
  // Checked BEFORE reading any mutant row: a store from before C02-06 must get this typed
  // refusal, not batchMutantRows' throw on an old row.
  const { appPath, instrumentedDir, sourceSha256 } = rec;
  if (appPath === null || instrumentedDir === null || sourceSha256 === null) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${rec.runId} did not record its installed files or its source hash (recorded before lethal verify existed, or its source changed during the run); run lethal run again, then verify`,
    );
  }

  const rows = new Map<string, ReturnType<ResultsStore["batchMutantRows"]>[number]>();
  for (const r of store.batchMutantRows(rec.runId, rec.batchIndex)) {
    if (rows.has(r.mutantCode)) {
      throw new Error(
        `verify.ts: run ${rec.runId} batch ${rec.batchIndex} records mutant ${r.mutantCode} twice`,
      );
    }
    rows.set(r.mutantCode, r);
  }

  const offending: Array<{ id: string; reason: VerifyRefusal; why: string }> = [];
  const targets: Array<VerifySource["targets"][number]> = [];
  for (const { batchIndex, mutantCode } of req.ids) {
    const id = `${batchIndex}/${mutantCode}`;
    const refuse = (reason: VerifyRefusal, why: string) => {
      offending.push({ id, reason, why });
    };
    if (batchIndex !== rec.batchIndex) {
      refuse(
        "wrong-batch",
        `artifact ${req.artifactId} is batch ${rec.batchIndex}, not ${batchIndex}`,
      );
      continue;
    }
    const row = rows.get(mutantCode);
    if (row === undefined) {
      refuse("unknown-mutant", `batch ${batchIndex} of run ${rec.runId} has no ${mutantCode}`);
    } else if (row.carried === null) {
      refuse("source-predates-verify", "recorded before the carried column existed");
    } else if (row.carried) {
      refuse("carried", "carried by --resume from an earlier run, not measured by this artifact");
    } else if (row.verdict === "known-survivor") {
      refuse(
        "not-a-survivor",
        "known-survivor was skipped, not measured; re-run without --skip-known-survivors",
      );
    } else if (row.verdict !== "survived" && row.verdict !== "no-coverage") {
      refuse("not-a-survivor", `its verdict is ${row.verdict}`);
    } else {
      targets.push({ batchIndex, mutantCode, coveringTests: row.coveringTests });
    }
  }
  const first = PER_ID_ORDER.find((reason) => offending.some((o) => o.reason === reason));
  if (first !== undefined) {
    throw new VerifyError(
      first,
      offending.map((o) => `${o.id} (${o.reason}: ${o.why})`).join("; "),
    );
  }

  return {
    runId: rec.runId,
    projectPath: rec.projectPath,
    artifactSha256: rec.artifactSha256,
    sourceSha256,
    installed: { fromRunId: rec.runId, batchIndex: rec.batchIndex, appPath, instrumentedDir },
    targets,
  };
}

/**
 * Decision 8. Recomputes the target's source hash with the SAME function and preprocessor symbols
 * the source run recorded it with. Reads the project's files; never a server.
 */
export async function assertSourceUnchanged(
  source: VerifySource,
  preprocessorSymbols: readonly string[],
): Promise<void> {
  const now = await hashTargetSource(source.projectPath, preprocessorSymbols);
  if (now !== source.sourceSha256) {
    throw new VerifyError(
      "source-changed",
      `the installed build was made from other source than ${source.projectPath} holds now (a .al file, app.json or a preprocessor symbol changed; a version-only bump counts too); run lethal run again, then verify with its artifact id`,
    );
  }
}
