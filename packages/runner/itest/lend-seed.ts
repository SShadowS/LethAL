import type { CoverageMode } from "../src/backend";
/**
 * R618: seeds a results store with a CLONE of a real run, changing only the fields an override
 * names, so a negative leg of `itest:lend` can only be refused by the field it changed (plan r2 §2).
 *
 * NOT a full copy (review M2). The run row copies every field `getRun` returns, which is every
 * field a lend check reads, `resource_key` included (R601: a pending prior resumes only on its own
 * server). It does NOT copy `app_id`, `test_digests` or `test_digest_parts`, `batch_artifacts`,
 * `installed_bundles` or `test_results`. So a seed holds no bundle to prune and cannot be
 * `lethal verify`-ed. Mutant rows are written back through
 * `recordMutant`; their identity key is never changed (I1).
 *
 * Every write goes through the store's API. The two raw SQL statements here are READS
 * (`mutants` and `baseline_snapshots` rows), because no API returns `mutant_code`, `line` or a
 * snapshot's batch hash by run id.
 */
import { PENDING_SUFFIX, REVOKED_SUFFIX } from "../src/closed-world";
import type { MutantRow, MutantVerdict, ResultsStore } from "../src/store";

export { PENDING_SUFFIX, REVOKED_SUFFIX };

/** The identity key `keyOf` (mutant-equality.ts) gives the same mutant in a report. */
export function rowKey(r: {
  readonly ast_hash: string;
  readonly codeunit_name: string;
  readonly procedure_name: string | null;
  readonly operator_name: string;
  readonly operator_major: number;
  readonly identity_ordinal: number | null;
}): string {
  const tuple = `${r.ast_hash}|${r.codeunit_name}|${r.procedure_name ?? ""}|${r.operator_name}|${r.operator_major}`;
  const ordinal = r.identity_ordinal ?? 0;
  return ordinal > 0 ? `${tuple}|${ordinal}` : tuple;
}

/** One `mutants` row as SQLite holds it (the columns `recordMutant` writes). */
export interface StoredMutant {
  readonly mutant_code: string;
  readonly ast_hash: string;
  readonly codeunit_name: string;
  readonly procedure_name: string | null;
  readonly operator_name: string;
  readonly operator_major: number;
  readonly identity_ordinal: number | null;
  readonly file: string;
  readonly line: number;
  readonly verdict: string;
  readonly killing_test: string | null;
  readonly failure_note: string | null;
  readonly killing_test_failure: string | null;
  readonly kill_position: number | null;
  readonly kill_reproduced: number | null;
  readonly reproduced_failure: string | null;
  readonly duration_ms: number;
  readonly batch_index: number;
  readonly runner: string | null;
  readonly covering_tests: string | null;
  readonly coverage_attribution: string | null;
  readonly unplaceable: number | null;
  readonly carried: number | null;
  readonly member_hash: string | null;
}

/** A run's mutant rows, in insert order. */
export function storedMutants(store: ResultsStore, runId: number): StoredMutant[] {
  return store.db
    .query("SELECT * FROM mutants WHERE run_id = ? ORDER BY id")
    .all(runId) as StoredMutant[];
}

export interface SeedOverrides {
  readonly backend?: string;
  readonly runnerBuild?: string;
  readonly coverageMode?: CoverageMode;
  /** R601: the test-app hash in place of the source run's (`hashSuffix` is still appended). */
  readonly testAppHash?: string;
  /** Appended to the source run's test-app hash (`PENDING_SUFFIX`, `REVOKED_SUFFIX`). */
  readonly hashSuffix?: string;
  readonly alRunnerNames?: boolean;
  /** Default true. `false` writes no mutant row. */
  readonly rows?: boolean;
  /** Only the rows whose identity key is in this set. Default: every row. */
  readonly keepKeys?: ReadonlySet<string>;
  /** Rows written as `error` (no killing fields), as an interrupted run's failed mutant is. */
  readonly errorKeys?: ReadonlySet<string>;
  /** I2: rotate `mutant_code` and `line` by one among the written rows; keys stay intact. */
  readonly permuteCodes?: boolean;
  /** I2: this key's row gets this `durationMs`, so a carry can be traced to this seed. */
  readonly sentinel?: { readonly key: string; readonly durationMs: number };
  /** Stamp the run finished (`finishRun`). Default false: an interrupted run. */
  readonly finished?: boolean;
  /** Copy the source run's batch-0 snapshot under the source run's key ("source") or under this
   *  seed's own run hash ("run"). Default: no snapshot. */
  readonly snapshot?: "source" | "run";
  /** After everything, `revokeTestAppHash(seed, REVOKED_SUFFIX)`: the run and its snapshots. */
  readonly revoke?: boolean;
}

const ERROR_NOTE = "R618 seed: an error row, as an interrupted run records one";

/** Clones run `fromRunId` into a new run of the same store and returns its id. */
export function seedRunFrom(store: ResultsStore, fromRunId: number, o: SeedOverrides = {}): number {
  const src = store.getRun(fromRunId);
  if (src === null) throw new Error(`seedRunFrom: no run ${fromRunId}`);
  if (src.buildSymbols === null || src.coverageMode === null || src.configFingerprint === null) {
    throw new Error(
      `seedRunFrom: run ${fromRunId} records no build symbols, coverage mode or fingerprint; it is not a clone source`,
    );
  }
  if (src.testAppHash === null || src.testAppDeps === null || !src.testAppProven) {
    throw new Error(`seedRunFrom: run ${fromRunId} has no proven test-app identity to clone`);
  }
  // R585: a clone with a NULL scope would lend no history, and N0 would fail for that reason.
  if (src.testScope === null) {
    throw new Error(
      `seedRunFrom: run ${fromRunId} records no test scope; it is not a clone source`,
    );
  }
  const backend = o.backend ?? src.backend;
  const runnerBuild = o.runnerBuild ?? src.runnerBuild ?? undefined;
  const testAppHash = `${o.testAppHash ?? src.testAppHash}${o.hashSuffix ?? ""}`;
  const id = store.createRun({
    projectPath: src.projectPath,
    backend,
    appVersion: "0.0.0.0",
    configFingerprint: src.configFingerprint,
    identityScheme: src.identityScheme,
    buildSymbols: src.buildSymbols,
    coverageMode: o.coverageMode ?? src.coverageMode,
    testAppHash,
    testAppProven: true,
    testAppDeps: src.testAppDeps,
    carryHidden: src.carryHidden,
    generationSourceSha256: src.generationSourceSha256,
    twinTuples: src.twinTuples,
    numberingDigest: src.numberingDigest,
    dependencySourceSha256: src.dependencySourceSha256,
    alRunnerNames: o.alRunnerNames ?? src.alRunnerNames,
    testScope: src.testScope,
    ...(runnerBuild !== undefined ? { runnerBuild } : {}),
    ...(src.resourceKey !== null ? { resourceKey: src.resourceKey } : {}),
  });
  if (o.rows !== false) {
    const rows = storedMutants(store, fromRunId).filter(
      (r) => o.keepKeys === undefined || o.keepKeys.has(rowKey(r)),
    );
    if (o.keepKeys !== undefined && rows.length !== o.keepKeys.size) {
      throw new Error(
        `seedRunFrom: ${o.keepKeys.size} keys asked, ${rows.length} rows of run ${fromRunId} match`,
      );
    }
    rows.forEach((r, i) => {
      const at = o.permuteCodes === true ? rows[(i + 1) % rows.length] : r;
      if (at === undefined) throw new Error("seedRunFrom: unreachable");
      store.recordMutant(id, toMutantRow(r, at, o));
    });
  }
  if (o.snapshot !== undefined) {
    const snap = store.db
      .query(
        "SELECT batch_index, batch_hash, test_app_hash, payload FROM baseline_snapshots WHERE run_id = ? AND batch_index = 0",
      )
      .get(fromRunId) as {
      batch_index: number;
      batch_hash: string;
      test_app_hash: string;
      payload: string;
    } | null;
    if (snap === null) throw new Error(`seedRunFrom: run ${fromRunId} has no batch-0 snapshot`);
    store.recordBaselineSnapshot({
      runId: id,
      batchIndex: snap.batch_index,
      batchHash: snap.batch_hash,
      testAppHash: o.snapshot === "source" ? snap.test_app_hash : testAppHash,
      baseline: JSON.parse(snap.payload),
    });
  }
  if (o.finished === true) store.finishRun(id, { batchCount: 1, baselineGreen: true });
  if (o.revoke === true) store.revokeTestAppHash(id, REVOKED_SUFFIX);
  return id;
}

function toMutantRow(r: StoredMutant, at: StoredMutant, o: SeedOverrides): MutantRow {
  const key = rowKey(r);
  const error = o.errorKeys?.has(key) === true;
  const covering =
    r.covering_tests === null ? undefined : (JSON.parse(r.covering_tests) as string[]);
  return {
    mutantCode: at.mutant_code,
    line: at.line,
    astHash: r.ast_hash,
    codeunitName: r.codeunit_name,
    procedureName: r.procedure_name ?? "",
    operatorName: r.operator_name,
    operatorMajor: r.operator_major,
    identityOrdinal: r.identity_ordinal ?? 0,
    file: r.file,
    verdict: (error ? "error" : r.verdict) as MutantVerdict,
    durationMs: o.sentinel?.key === key ? o.sentinel.durationMs : r.duration_ms,
    batchIndex: r.batch_index,
    ...(error ? { failureNote: ERROR_NOTE } : {}),
    ...(!error && r.killing_test !== null ? { killingTest: r.killing_test } : {}),
    ...(!error && r.failure_note !== null ? { failureNote: r.failure_note } : {}),
    ...(!error && r.killing_test_failure !== null
      ? { killingTestFailure: r.killing_test_failure }
      : {}),
    ...(!error && r.kill_position !== null ? { killPosition: r.kill_position } : {}),
    ...(!error && r.kill_reproduced === 1 ? { killReproduced: true as const } : {}),
    ...(!error && r.reproduced_failure !== null ? { reproducedFailure: r.reproduced_failure } : {}),
    ...(r.runner === "fenced" || r.runner === "client-services" ? { runner: r.runner } : {}),
    ...(covering !== undefined ? { coveringTests: covering } : {}),
    ...(r.coverage_attribution === "exact" ||
    r.coverage_attribution === "object" ||
    r.coverage_attribution === "all-green"
      ? { coverageAttribution: r.coverage_attribution }
      : {}),
    ...(r.unplaceable !== null ? { unplaceable: r.unplaceable !== 0 } : {}),
    ...(r.carried !== null ? { carried: r.carried !== 0 } : {}),
    ...(r.member_hash !== null ? { memberHash: r.member_hash } : {}),
  };
}
