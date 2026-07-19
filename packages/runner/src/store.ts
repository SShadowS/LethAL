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
  artifact_sha256 TEXT
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
  duration_ms INTEGER NOT NULL
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
    // Layer 5A: runs gained deployment provenance. A pre-5A lethal.sqlite has a runs table
    // without these, against which recordArtifact's UPDATE would throw mid-run.
    const runCols = this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    for (const col of ["app_id", "artifact_id", "artifact_sha256"]) {
      if (!runCols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${col} TEXT`);
      }
    }
  }

  createRun(info: { projectPath: string; backend: string; appVersion: string }): number {
    const r = this.db
      .query("INSERT INTO runs (project_path, backend, app_version) VALUES (?, ?, ?) RETURNING id")
      .get(info.projectPath, info.backend, info.appVersion) as { id: number };
    return r.id;
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
         operator_major, file, line, verdict, killing_test, failure_note, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
      ) as { id: number };
    return r.id;
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
