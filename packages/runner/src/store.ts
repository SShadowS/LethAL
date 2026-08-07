import { Database } from "bun:sqlite";
import type { TestMethodRef, TestOutcome } from "./backend";
import type { PublishOutcome } from "./deployment-verifier";
import { type IdentityKey, serializeKey } from "./selection";

export type MutantVerdict =
  | "killed"
  | "survived"
  | "no-coverage"
  | "timeout-killed"
  | "known-survivor"
  | "error";

/**
 * Which execution path produced a verdict — R69 Phase 2's second measured path alongside the one
 * every verdict has come from until now. `"fenced"` is the `GuiAllowed=No`, `ClientType=ODataV4`
 * `RunMutant` path (measured, R57). `"client-services"` is the `GuiAllowed=Yes`, `ClientType=Web`
 * batch-runner path (R69) — under it an UNHANDLED `Confirm` RAISES rather than returning its
 * default, so a mutant inside a `Confirm` branch can genuinely reach a different verdict than it
 * would on the fenced path. That is why this is not cosmetic: a report that cannot say which path
 * produced a verdict cannot tell a reader whether two differing verdicts are a regression or two
 * different, both-correct measurements.
 *
 * Optional everywhere it is threaded (`MutantVerdictRow`, `MutantRow`): every verdict recorded
 * before this type existed, and every verdict recorded by a call site that does not yet route
 * through client-services (Task 6 wires that), has no tag at all. `undefined` there means
 * `"fenced"` — the only path that ever existed before R69 Phase 2 — and callers must read the
 * absence that way rather than as a third, unknown state. `MutantOutcome.runner` (report.ts) is
 * deliberately NOT optional, precisely so a report consumer performs that "absent means fenced"
 * translation exactly once, in `buildReport`, rather than at every read site downstream.
 */
export type RunnerKind = "fenced" | "client-services";

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
  /**
   * R86: the failure text of the run that KILLED this mutant — BC's own words for why the test
   * went red, verbatim. Present only on a `killed`/`timeout-killed` row, and only when the backend
   * gave text (al-runner's `error` paths and bcdev's both do; a backend that reports a bare failure
   * leaves this absent, which is the honest statement that no text was reported).
   *
   * This is NOT a second `failureNote`. `failureNote` accounts for an `error` verdict — LethAL's own
   * machinery failing — and is written by the orchestrator. This is the TARGET's failure, written by
   * the backend, on a mutant that was successfully scored. The two never co-occur.
   *
   * It exists because a kill BC produced by rejecting the mutated data (an overflow, a division by
   * zero, a failed field load) was stored byte-identically to a kill an assertion earned: measured
   * on the R82 gate run, where `failure_note` was NULL for all 109 kills. The error direction is the
   * flattering one — the reader is told their tests caught something when the platform did.
   * LethAL does not classify which is which (the discriminator R86 first proposed was measured
   * WRONG at a 75% false-positive rate, and the text is prose that localises), so this records the
   * evidence and leaves the judgement to a reader who can see it.
   */
  readonly killingTestFailure?: string;
  readonly durationMs: number;
  /**
   * Which batch produced this verdict. Added by R47 so `invalidateBatch` can reach exactly the rows
   * one artifact's verdicts came from — `mutant_code` restarts numbering per batch and cannot
   * identify them.
   */
  readonly batchIndex: number;
  /** R69 Phase 2 Task 5 — see `RunnerKind`. Absent means fenced (every call site that predates
   *  Task 6's routing). */
  readonly runner?: RunnerKind;
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
  /** R86 — see `MutantRow.killingTestFailure`. Threaded through so `--resume` carries a kill's own
   *  account of why it died instead of quietly dropping it on the second run. */
  readonly killingTestFailure?: string;
  readonly durationMs: number;
  /**
   * R69 Phase 2 Task 5 — see `RunnerKind`. Threaded through so `--resume` can carry it: without
   * this, a mutant killed under `GuiAllowed=Yes` in run 1 is re-recorded with no tag on `--resume`,
   * and a report defined as "contexts used in THIS run" would truthfully — and wrongly — report
   * fenced-only. Absent on every row recorded before this column existed.
   */
  readonly runner?: RunnerKind;
}

/**
 * One recorded publish attempt on one tier — R90's measured publish ceiling (publish-ceiling.ts).
 *
 * `outcome` is `decidePublishOutcome`'s CATEGORY, not a boolean: see `recordPublishOutcome`
 * (publish-ceiling.ts) for why the distinction between `failed` and `indeterminate` is the whole
 * point of the table.
 */
export interface PublishOutcomeRow {
  readonly tier: string;
  readonly guardCount: number;
  /** The one file this artifact's guards came from, when there was one — diagnostic only, so a
   *  `failed` row can say WHAT was too big. Absent for a multi-file artifact. */
  readonly file?: string;
  readonly outcome: PublishOutcome;
  /** SQLite's `datetime('now')` stamp (UTC, `YYYY-MM-DD HH:MM:SS`). A refusal dates its evidence
   *  from this. */
  readonly recordedAt: string;
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
  killing_test_failure TEXT,
  duration_ms INTEGER NOT NULL,
  batch_index INTEGER,
  runner TEXT
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
CREATE TABLE IF NOT EXISTS publish_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  tier TEXT NOT NULL,
  guard_count INTEGER NOT NULL,
  file TEXT,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_outcomes_tier ON publish_outcomes(tier);
`;

export class ResultsStore {
  readonly db: Database;
  /**
   * The path this store was opened at, verbatim.
   *
   * R90 fix round 2: `clear-ceiling`'s pre-filled command must name the database the measurement
   * was actually recorded in. Without it the command renders the DEFAULT `<project>/lethal.sqlite`,
   * and a session run with `--db X` would hand the operator an invocation that clears a different
   * file — printing "removed 0 row(s)", exiting 0, and leaving the refusal exactly where it was.
   * Captured here rather than read back off `db.filename` so it is the caller's own string, not
   * SQLite's normalization of it.
   */
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
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
    // R69 Phase 2 Task 5: `mutants` gained `runner` (see `RunnerKind`). A pre-Task-5 lethal.sqlite
    // has a `mutants` table without it, against which `recordMutant`'s INSERT would throw mid-run.
    // Pre-existing rows keep NULL, which `mutantVerdicts` reports as "no tag" — the honest answer,
    // since those verdicts were recorded before LethAL had a second execution path to distinguish.
    if (!cols.some((c) => c.name === "runner")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN runner TEXT");
    }
    // R86: `mutants` gained `killing_test_failure` (see `MutantRow.killingTestFailure`). Same
    // hazard as the three above — `recordMutant`'s INSERT names the column explicitly, so an
    // older lethal.sqlite would throw mid-run. Pre-R86 rows keep NULL, which reads as "no text was
    // recorded", not as "the platform produced no text": those runs never asked the question.
    if (!cols.some((c) => c.name === "killing_test_failure")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN killing_test_failure TEXT");
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
    // R90's `publish_outcomes` needs NOTHING here, and that is a property of it being a whole new
    // TABLE rather than a new column: `SCHEMA` runs `CREATE TABLE IF NOT EXISTS` on every open, so
    // a `lethal.sqlite` created before this table existed simply gains it — empty — the next time
    // it is opened. An empty ceiling table is also the correct starting state (see
    // `assertUnderCeiling`: with no recorded failure, nothing is refused), so there is no
    // backfill to get wrong either. This method exists only because `CREATE TABLE IF NOT EXISTS`
    // never reconciles an EXISTING table's columns.
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

  /**
   * Validates a `runner` column value read back from SQLite. NULL is the documented default (the
   * column is nullable — pre-Task-5 rows predate it, and `migrate()` widens existing tables without
   * backfilling a value) and callers read that absence as `"fenced"` exactly once, in `buildReport`
   * (report.ts) — see `RunnerKind`'s own doc comment above. Anything else that is not one of the two
   * known literals is a corrupt row, not a plausible third state: per this project's convention
   * (CLAUDE.md "fail loudly on caller-contract violations"), a corrupt DB value must throw naming
   * itself and the offending row, never get coerced into a guessed default.
   */
  private parseRunnerKind(
    value: string,
    row: { astHash: string; codeunitName: string; operatorName: string; operatorMajor: number },
  ): RunnerKind {
    if (value === "fenced" || value === "client-services") return value;
    throw new Error(
      `store.ts: mutant row (astHash=${row.astHash}, codeunitName=${row.codeunitName}, ` +
        `operatorName=${row.operatorName}, operatorMajor=${row.operatorMajor}) has a corrupt ` +
        `"runner" column value ${JSON.stringify(value)} — expected "fenced", "client-services", or NULL`,
    );
  }

  /** R47: every mutant verdict a prior run recorded, keyed by identity rather than mutant code —
   *  see `MutantVerdictRow`. */
  mutantVerdicts(runId: number): MutantVerdictRow[] {
    const rows = this.db
      .query(
        "SELECT ast_hash, codeunit_name, operator_name, operator_major, verdict, killing_test, " +
          "failure_note, killing_test_failure, duration_ms, runner FROM mutants WHERE run_id = ?",
      )
      .all(runId) as Array<{
      ast_hash: string;
      codeunit_name: string;
      operator_name: string;
      operator_major: number;
      verdict: string;
      killing_test: string | null;
      failure_note: string | null;
      killing_test_failure: string | null;
      duration_ms: number;
      runner: string | null;
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
      ...(r.killing_test_failure !== null ? { killingTestFailure: r.killing_test_failure } : {}),
      ...(r.runner !== null
        ? {
            runner: this.parseRunnerKind(r.runner, {
              astHash: r.ast_hash,
              codeunitName: r.codeunit_name,
              operatorName: r.operator_name,
              operatorMajor: r.operator_major,
            }),
          }
        : {}),
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
         operator_major, file, line, verdict, killing_test, failure_note, killing_test_failure,
         duration_ms, batch_index, runner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
        row.killingTestFailure ?? null,
        row.durationMs,
        row.batchIndex,
        row.runner ?? null,
      ) as { id: number };
    return r.id;
  }

  /**
   * Rewrites one batch's stored verdicts to `error` — the durable half of the attestation gate
   * (design §G, `orchestrator.ts`'s `contributed && !attestation.clean` check).
   *
   * That gate fires when no covered run ever proved the deployed binary was actually the
   * instrumented one, which means every verdict the batch produced may be a false `survived`. The
   * in-memory half now lives in the fold's own `batch-invalidated` handling (report-fold.ts),
   * which corrects the folded REPORT; this method is the SEPARATE durable half. The in-memory
   * correction used to be a same-process function (`invalidateBatchVerdicts`, deleted once the
   * report stopped reading the array it corrected — event-stream refactor, spec 2026-08-05 §A) that
   * corrected only that in-memory array, on the stated grounds that a quarantined run
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
        // R86: `killing_test_failure` is cleared alongside `killing_test` for the same reason —
        // this row is no longer a kill, so a leftover account of "why the test went red" would
        // describe a verdict that has just been withdrawn.
        "UPDATE mutants SET verdict = 'error', failure_note = ?, killing_test = NULL, " +
          "killing_test_failure = NULL " +
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

  /**
   * R90: records one publish attempt's outcome against a physical BC service TIER.
   *
   * Deliberately NOT keyed to `run_id`. The publish ceiling is a property of the topology, not of
   * a run: it must survive every run that measured it, be readable by `--dry-run` (which creates
   * no run row at all), and be consulted by the NEXT session's pre-flight before its own run row
   * has done anything. Tying it to a run would make it invisible exactly when it is needed.
   *
   * Call through `recordPublishOutcome` (publish-ceiling.ts) rather than directly — that is where
   * the caller-contract validation lives.
   */
  recordPublishOutcome(row: {
    readonly tier: string;
    readonly guardCount: number;
    readonly file: string | undefined;
    readonly outcome: PublishOutcome;
  }): void {
    this.db
      .query("INSERT INTO publish_outcomes (tier, guard_count, file, outcome) VALUES (?, ?, ?, ?)")
      .run(row.tier, row.guardCount, row.file ?? null, row.outcome);
  }

  /**
   * Validates an `outcome` column value read back from SQLite. Unlike `runner`, this column is NOT
   * nullable and has no documented absence to translate — every row was written by
   * `recordPublishOutcome` with one of `decidePublishOutcome`'s four values. Anything else is a
   * corrupt row, and per CLAUDE.md must throw naming itself rather than be coerced into a guess:
   * silently treating an unknown value as (say) `indeterminate` would drop a real `failed`
   * measurement and leave the ceiling permanently blind.
   */
  private parsePublishOutcome(value: string, tier: string, guardCount: number): PublishOutcome {
    if (
      value === "accepted" ||
      value === "indeterminate" ||
      value === "anomalous" ||
      value === "failed"
    ) {
      return value;
    }
    throw new Error(
      `store.ts: publish_outcomes row (tier=${tier}, guardCount=${guardCount}) has a corrupt ` +
        `"outcome" column value ${JSON.stringify(value)} — expected "accepted", "indeterminate", "anomalous" or "failed"`,
    );
  }

  /**
   * R90 fix round 1: the operator escape. Removes recorded publish outcomes for one tier —
   * every row, or only the rows recorded against one FILE.
   *
   * Necessary because the ceiling is a RATCHET that only ever tightens: `knownCeiling` takes the
   * minimum over `failed` rows, and a file once refused can never publish, so it can never produce
   * the counter-evidence that would widen the bracket again. Any throw out of
   * `deployer.publish()` — including a Bun spawn `ENOENT`, which R65 measured for real — records a
   * `failed` row at that artifact's guard count, and without this there is no way back but sqlite
   * surgery. This is the same hazard `knownCeiling` deliberately excludes `indeterminate` for; the
   * exclusion closed one door in, and a transient spawn failure walks through the other.
   *
   * Returns the number of rows deleted so the caller can state what it destroyed. Deleting real
   * measurements is real evidence loss, so the CLI wrapper names every row it removes.
   */
  deletePublishOutcomes(tier: string, file: string | undefined): number {
    if (file === undefined) {
      this.db.query("DELETE FROM publish_outcomes WHERE tier = ?").run(tier);
    } else {
      this.db.query("DELETE FROM publish_outcomes WHERE tier = ? AND file = ?").run(tier, file);
    }
    const r = this.db.query("SELECT changes() AS n").get() as { n: number };
    return r.n;
  }

  /**
   * R90 fix round 2: every tier this database has publish outcomes for, sorted.
   *
   * Exists so a `clear-ceiling` that matched NOTHING can say what the database does contain
   * instead of stopping at "removed 0 row(s)". That listing is the actual diagnosis for the two
   * ways to reach a no-op — the wrong database, or a tier identity that does not match how the
   * run recorded it (case and trailing slash are normalized by `quarantineResourceKey`, the host
   * spelling is not) — and it turns a dead end into a next step.
   */
  publishOutcomeTiers(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT tier FROM publish_outcomes ORDER BY tier ASC")
      .all() as Array<{ tier: string }>;
    return rows.map((r) => r.tier);
  }

  /** R90: every publish attempt recorded against one tier, oldest first. */
  publishOutcomes(tier: string): PublishOutcomeRow[] {
    const rows = this.db
      .query(
        "SELECT tier, guard_count, file, outcome, recorded_at FROM publish_outcomes " +
          "WHERE tier = ? ORDER BY id ASC",
      )
      .all(tier) as Array<{
      tier: string;
      guard_count: number;
      file: string | null;
      outcome: string;
      recorded_at: string;
    }>;
    return rows.map((r) => ({
      tier: r.tier,
      guardCount: r.guard_count,
      outcome: this.parsePublishOutcome(r.outcome, r.tier, r.guard_count),
      recordedAt: r.recorded_at,
      ...(r.file !== null ? { file: r.file } : {}),
    }));
  }

  close(): void {
    this.db.close();
  }
}
