import { Database } from "bun:sqlite";
import type { TestMethodRef, TestOutcome } from "./backend";
import { type IdentityKey, serializeKey } from "./selection";

export type MutantVerdict =
  | "killed"
  | "survived"
  | "no-coverage"
  | "timeout-killed"
  | "known-survivor"
  | "error";

export interface MutantRow {
  readonly mutantCode: string;
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
  readonly file: string;
  readonly line: number;
  readonly verdict: MutantVerdict;
  readonly killingTest?: string;
  /**
   * Human-readable diagnostic for an `error`-verdict row: a bisected compile
   * failure's culprit note (file/line/operator), a deadline/unstable
   * confirmation message, or the raw backend error text — whatever
   * `orchestrator.ts`'s `record()` was given as `failureNote`. Persisted so a
   * post-hoc query (or a future CLI surface) can find the culprit without
   * re-running the session; not just held in memory for the one report.
   */
  readonly failureNote?: string;
  readonly durationMs: number;
  /**
   * Which batch produced this verdict. Added by R47 so `invalidateBatch` can reach exactly the rows
   * one artifact's verdicts came from — `mutant_code` restarts numbering per batch and cannot
   * identify them.
   */
  readonly batchIndex: number;
}

/**
 * A prior run's recorded verdict for one mutant, as `--resume` (R47) reads it back.
 *
 * Carries the IDENTITY components rather than `mutant_code`: `assignMutantIds` restarts numbering
 * per batch, so "M0013" names a different mutant depending on how the run was batched, and a
 * resume that re-planned into different batches would silently reattribute every verdict. The
 * `(astHash, codeunitName, operatorName, operatorMajor)` tuple is stable across batching AND
 * encodes the mutated subtree, so a source edit changes it and the stale verdict simply stops
 * matching instead of being carried onto changed code.
 */
export interface MutantVerdictRow {
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
  readonly verdict: MutantVerdict;
  readonly killingTest?: string;
  readonly failureNote?: string;
  readonly durationMs: number;
}

/** A run row, as `--resume` reads it back to check the candidate is actually resumable. */
export interface RunRow {
  readonly id: number;
  readonly projectPath: string;
  readonly backend: string;
  readonly configFingerprint: string | null;
  readonly finished: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  project_path TEXT NOT NULL,
  backend TEXT NOT NULL,
  app_version TEXT NOT NULL,
  batch_count INTEGER,
  baseline_green INTEGER,
  app_id TEXT,
  artifact_id TEXT,
  artifact_sha256 TEXT,
  config_fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS mutants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  mutant_code TEXT NOT NULL,
  ast_hash TEXT NOT NULL,
  codeunit_name TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  operator_major INTEGER NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  killing_test TEXT,
  failure_note TEXT,
  duration_ms INTEGER NOT NULL,
  batch_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mutants_identity
  ON mutants(ast_hash, codeunit_name, operator_name, operator_major);
CREATE TABLE IF NOT EXISTS test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  mutant_row_id INTEGER REFERENCES mutants(id),
  mutant_code TEXT,
  codeunit_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  failure_message TEXT
);
`;

export class ResultsStore {
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Guarded, idempotent migrations for persistent databases created before a
   * column existed. `SCHEMA` is `CREATE TABLE IF NOT EXISTS` only — it never
   * reconciles an EXISTING table's columns — and persistent result DBs are a
   * supported workflow (`priorSurvivorKeys` history, runId monotonicity for
   * BC app-version stamping), so a `lethal.sqlite` created before Layer 4.3
   * has a `mutants` table without `failure_note`, against which every
   * `recordMutant` INSERT would throw mid-run.
   */
  private migrate(): void {
    const cols = this.db.query("PRAGMA table_info(mutants)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "failure_note")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN failure_note TEXT");
    }
    // R47: `invalidateBatch` needs to name one artifact's rows, and `mutant_code` restarts per
    // batch. Pre-R47 rows keep NULL, which no `invalidateBatch` call will ever match — those runs
    // are also unresumable (their run row has no `config_fingerprint`), so the two gaps line up.
    if (!cols.some((c) => c.name === "batch_index")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN batch_index INTEGER");
    }
    // Layer 5A: runs gained deployment provenance. A pre-5A lethal.sqlite has a runs table
    // without these, against which recordArtifact's UPDATE would throw mid-run.
    const runCols = this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    // R47 added `config_fingerprint` to this same list: a pre-R47 lethal.sqlite has runs without
    // it, and `createRun`'s INSERT would throw mid-run. It stays NULL for those rows, which
    // `findResumableRun` treats as "not resumable" rather than "matches anything" — a run recorded
    // before fingerprints existed cannot prove it was scoped the same way this one is.
    for (const col of ["app_id", "artifact_id", "artifact_sha256", "config_fingerprint"]) {
      if (!runCols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${col} TEXT`);
      }
    }
  }

  createRun(info: {
    projectPath: string;
    backend: string;
    appVersion: string;
    configFingerprint?: string;
  }): number {
    const r = this.db
      .query(
        "INSERT INTO runs (project_path, backend, app_version, config_fingerprint) " +
          "VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(info.projectPath, info.backend, info.appVersion, info.configFingerprint ?? null) as {
      id: number;
    };
    return r.id;
  }

  /**
   * R47: the most recent UNFINISHED run this session could resume — same project, same backend,
   * same configuration fingerprint. `null` when there is none.
   *
   * "Unfinished" (`finished_at IS NULL`) is the whole point: `finishRun` stamps it, so a run that
   * completed has nothing left to do and resuming it would re-deploy and re-baseline for zero
   * mutants. An aborted run — the R47 case, where a per-mutant timeout quarantined at mutant 13 of
   * 138 — never reaches `finishRun` and is exactly what this finds.
   *
   * The fingerprint is compared, never ignored: resuming a run scoped by a DIFFERENT `--only`
   * would carry verdicts measured over one slice of the project into a report describing another.
   * A NULL fingerprint (a pre-R47 row) never matches — see `migrate`.
   */
  findResumableRun(q: {
    projectPath: string;
    backend: string;
    configFingerprint: string;
    /** Verdicts a resume may reuse — `CARRYABLE_VERDICTS` (resume.ts), passed in so the SQL and the
     *  carry rule cannot drift apart. */
    carryableVerdicts: readonly string[];
  }): number | null {
    // R52: "most recent unfinished" is NOT sufficient — it must also HAVE something to carry.
    // Measured 2026-07-27: an attempted resume aborted at lease acquisition before scoring a single
    // mutant, and the next `--resume` dutifully selected that empty run over the one holding 12 real
    // verdicts, reporting "0 verdict(s) carried". Not silently wrong (the report says so), but
    // useless exactly when recovery matters — and an aborted run is precisely the kind most likely
    // to have recorded nothing.
    const placeholders = q.carryableVerdicts.map(() => "?").join(", ");
    const row = this.db
      .query(
        `SELECT id FROM runs WHERE project_path = ? AND backend = ? AND config_fingerprint = ? AND finished_at IS NULL AND EXISTS (SELECT 1 FROM mutants m WHERE m.run_id = runs.id AND m.verdict IN (${placeholders})) ORDER BY id DESC LIMIT 1`,
      )
      .get(q.projectPath, q.backend, q.configFingerprint, ...q.carryableVerdicts) as {
      id: number;
    } | null;
    return row === null ? null : row.id;
  }

  /** R47: one run row by id, or `null`. Used to explain WHY an explicitly named `--resume-run`
   *  cannot be resumed (wrong project, wrong backend, different scope, already finished) rather
   *  than silently finding nothing. */
  getRun(runId: number): RunRow | null {
    const row = this.db
      .query(
        "SELECT id, project_path, backend, config_fingerprint, finished_at FROM runs WHERE id = ?",
      )
      .get(runId) as {
      id: number;
      project_path: string;
      backend: string;
      config_fingerprint: string | null;
      finished_at: string | null;
    } | null;
    if (row === null) return null;
    return {
      id: row.id,
      projectPath: row.project_path,
      backend: row.backend,
      configFingerprint: row.config_fingerprint,
      finished: row.finished_at !== null,
    };
  }

  /** R47: every mutant verdict a prior run recorded, keyed by identity rather than mutant code —
   *  see `MutantVerdictRow`. */
  mutantVerdicts(runId: number): MutantVerdictRow[] {
    const rows = this.db
      .query(
        "SELECT ast_hash, codeunit_name, operator_name, operator_major, verdict, killing_test, " +
          "failure_note, duration_ms FROM mutants WHERE run_id = ?",
      )
      .all(runId) as Array<{
      ast_hash: string;
      codeunit_name: string;
      operator_name: string;
      operator_major: number;
      verdict: string;
      killing_test: string | null;
      failure_note: string | null;
      duration_ms: number;
    }>;
    return rows.map((r) => ({
      astHash: r.ast_hash,
      codeunitName: r.codeunit_name,
      operatorName: r.operator_name,
      operatorMajor: r.operator_major,
      verdict: r.verdict as MutantVerdict,
      durationMs: r.duration_ms,
      ...(r.killing_test !== null ? { killingTest: r.killing_test } : {}),
      ...(r.failure_note !== null ? { failureNote: r.failure_note } : {}),
    }));
  }

  finishRun(runId: number, info: { batchCount: number; baselineGreen: boolean }): void {
    this.db
      .query(
        "UPDATE runs SET finished_at = datetime('now'), batch_count = ?, baseline_green = ? WHERE id = ?",
      )
      .run(info.batchCount, info.baselineGreen ? 1 : 0, runId);
  }

  /**
   * Corrects the run row after compilation. `createRun` runs before the version is derived, so
   * it can only write a placeholder; leaving it there made runs.app_version wrong for every run
   * ever recorded. 5C needs this provenance, and retrofitting it after pooled runs exist would
   * make historical diagnostics ambiguous.
   */
  recordArtifact(
    runId: number,
    info: { appVersion: string; appId: string; artifactId: string; sha256: string },
  ): void {
    this.db
      .query(
        "UPDATE runs SET app_version = ?, app_id = ?, artifact_id = ?, artifact_sha256 = ? WHERE id = ?",
      )
      .run(info.appVersion, info.appId, info.artifactId, info.sha256, runId);
  }

  /** Returns the `mutants.id` row id SQLite assigned this insert (see I5: `mutant_code` alone
   *  is only unique within a batch, so callers need this to disambiguate test_results rows
   *  across batches). */
  recordMutant(runId: number, row: MutantRow): number {
    const r = this.db
      .query(
        `INSERT INTO mutants (run_id, mutant_code, ast_hash, codeunit_name, operator_name,
         operator_major, file, line, verdict, killing_test, failure_note, duration_ms, batch_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        runId,
        row.mutantCode,
        row.astHash,
        row.codeunitName,
        row.operatorName,
        row.operatorMajor,
        row.file,
        row.line,
        row.verdict,
        row.killingTest ?? null,
        row.failureNote ?? null,
        row.durationMs,
        row.batchIndex,
      ) as { id: number };
    return r.id;
  }

  /**
   * Rewrites one batch's stored verdicts to `error` — the durable half of the attestation gate
   * (`invalidateBatchVerdicts`, orchestrator.ts).
   *
   * That gate fires when no covered run ever proved the deployed binary was actually the
   * instrumented one, which means every verdict the batch produced may be a false `survived`. It
   * used to correct only the in-memory `outcomes[]`, on the stated grounds that a quarantined run
   * is never `finishRun`-ed and `priorSurvivorKeys` therefore skips it. **R47's `--resume` reads by
   * `finished_at IS NULL` — the exact complement** — so it would have read precisely the rows that
   * argument relied on nobody reading. Persisting the correction closes that, and removes the
   * dependency on a filter in an unrelated query.
   *
   * `error` and `known-survivor` rows are left alone, mirroring the in-memory rule: an already-
   * classified error carries a more specific diagnosis than this generic note, and a known survivor
   * was never run against this binary at all, so its attestation says nothing about it.
   *
   * Returns the number of rows changed, so a caller can state what it corrected.
   */
  invalidateBatch(runId: number, batchIndex: number, note: string): number {
    this.db
      .query(
        "UPDATE mutants SET verdict = 'error', failure_note = ?, killing_test = NULL " +
          "WHERE run_id = ? AND batch_index = ? AND verdict NOT IN ('error', 'known-survivor')",
      )
      .run(note, runId, batchIndex);
    const r = this.db.query("SELECT changes() AS n").get() as { n: number };
    return r.n;
  }

  recordTestResult(
    runId: number,
    mutantRowId: number | null,
    mutantCode: string | null,
    ref: TestMethodRef,
    outcome: TestOutcome,
    durationMs: number,
    failureMessage?: string,
  ): void {
    this.db
      .query(
        `INSERT INTO test_results (run_id, mutant_row_id, mutant_code, codeunit_id, method, outcome, duration_ms, failure_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        mutantRowId,
        mutantCode,
        ref.codeunitId,
        ref.method,
        outcome,
        durationMs,
        failureMessage ?? null,
      );
  }

  /** A prior "known-survivor" verdict counts exactly like "survived" here (I4) — it means the
   *  identity key was skipped rather than re-tested, so it must remain skippable/filterable in
   *  the run after that, not silently fall out of history after one `--skip-known-survivors` pass. */
  priorSurvivorKeys(projectPath: string): Set<string> {
    const run = this.db
      .query(
        "SELECT id FROM runs WHERE project_path = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(projectPath) as { id: number } | null;
    if (!run) return new Set();
    const rows = this.db
      .query(
        "SELECT ast_hash, codeunit_name, operator_name, operator_major FROM mutants " +
          "WHERE run_id = ? AND verdict IN ('survived', 'known-survivor')",
      )
      .all(run.id) as Array<{
      ast_hash: string;
      codeunit_name: string;
      operator_name: string;
      operator_major: number;
    }>;
    return new Set(
      rows.map((r) =>
        serializeKey({
          astHash: r.ast_hash,
          codeunitName: r.codeunit_name,
          operatorName: r.operator_name,
          operatorMajor: r.operator_major,
        } satisfies IdentityKey),
      ),
    );
  }

  close(): void {
    this.db.close();
  }
}
