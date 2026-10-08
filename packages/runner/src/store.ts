import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { IDENTITY_SCHEME, coarseIdentityTupleOf } from "@lethal/schemata";
import type { CoverageMode, TestMethodRef, TestOutcome } from "./backend";
import type { BaselineObservation, BaselineSnapshot } from "./baseline-snapshot";
import type { PublishOutcome } from "./deployment-verifier";
import type { InstalledBundleRows, InstalledBundleWrite } from "./installed-bundle";
import { normalizeRelPath } from "./line-filter";
import { sameBuildSymbols } from "./preprocessor-symbols";
import type { CoverageAttribution, PriorSurvivors } from "./selection";
import {
  type IdentityKey,
  NO_PRIOR_SURVIVORS,
  memberSiteOf,
  serializeKey,
  twinSiteOf,
} from "./selection";

/** C02-06: `artifactRecordById` found one artifact id on more than one batch row, a corrupt store.
 *  Typed so `lethal verify` can refuse it without matching message text. */
export class DuplicateArtifactRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateArtifactRecordError";
  }
}

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

/**
 * C02-02: one published batch's artifact provenance. `runs.artifact_id` etc. only ever held the
 * LAST batch's values (each `recordArtifact` call overwrote the row); a multi-batch run needs
 * every batch's id to bisect or reproduce a specific one. Declared once here; report.ts re-exports
 * it rather than redeclaring it.
 *
 * After a multi-batch run, only the entry with the HIGHEST `batchIndex` is still installed on the
 * server: every batch publishes the same app id, and a later publish replaces the one before it.
 * The other entries are a record of what WAS published and verified at the time, not of what is
 * on the server now. C02-04 relies on this.
 */
export interface BatchArtifact {
  readonly batchIndex: number;
  readonly artifactId: string;
  readonly sha256: string;
  readonly appVersion: string;
}

export interface MutantRow {
  readonly mutantCode: string;
  readonly astHash: string;
  readonly codeunitName: string;
  /** Enclosing procedure or trigger, empty at object level. Part of the identity since R166. */
  readonly procedureName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
  /** R193: position among identity twins in source order; 0 (or absent) for a singleton. */
  readonly identityOrdinal?: number;
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
  /**
   * R206 §2.4: on a `killed`/`timeout-killed`, one plus the number of test methods that ran before
   * the killer IN THE SESSION THAT RAN IT, i.e. its 1-based position within its call (1 on the
   * sequential path, where every call runs one method). Greater than 1 means the kill was
   * measured warm: the session already held state the earlier methods had left. Absent on a row
   * recorded before the field existed and on every non-kill verdict.
   */
  readonly killPosition?: number;
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
  /**
   * R192: the coverage facts this verdict was measured under, persisted so that `--resume` can
   * carry a batch WITHOUT republishing and re-baselining it. Until R192 the covering-test list and
   * attribution lived only in the report, which is why a resume had to redeploy every batch,
   * including one whose every mutant it carried (measured: about 8.5 minutes per resume on a
   * hosted sandbox, half of it on a batch with nothing left to run).
   *
   * `coveringTests` holds qualified test names; `coverageAttribution` is `CoverageAttribution`;
   * `unplaceable` is R175's flag. All three are absent on a row recorded before the columns
   * existed, and `--resume` treats that absence as "cannot skip this batch" rather than as an
   * empty covering list, which would carry a verdict with a confidently wrong "no test ran it".
   */
  readonly coveringTests?: readonly string[];
  readonly coverageAttribution?: CoverageAttribution;
  readonly unplaceable?: boolean;
  /**
   * C02-06: true when `--resume` carried this verdict from a prior run instead of measuring it.
   * `record()` always passes it; absent writes NULL, which `lethal verify` reads as "unknown" and
   * refuses, never as "not carried".
   */
  readonly carried?: boolean;
  /** R474: `MutantManifestEntry.memberHash`. Absent writes NULL: no rule-2 carry from the row. */
  readonly memberHash?: string;
}

/**
 * A prior run's recorded verdict for one mutant, as `--resume` (R47) reads it back.
 *
 * Carries the IDENTITY components rather than `mutant_code`: `assignMutantIds` restarts numbering
 * per batch, so "M0013" names a different mutant depending on how the run was batched, and a
 * resume that re-planned into different batches would silently reattribute every verdict. The
 * `(astHash, codeunitName, procedureName, operatorName, operatorMajor)` tuple is stable across
 * batching AND encodes the mutated subtree, so a source edit changes it and the stale verdict
 * simply stops matching instead of being carried onto changed code.
 *
 * `procedureName` joined the tuple in R166. Rows written before that column existed read back as
 * `null`, and `resumeIndex` treats a null as NOT MATCHING rather than as a wildcard: the unsafe
 * direction here is carrying a verdict onto the wrong mutant, and re-running one mutant is the
 * cheap failure.
 */
export interface MutantVerdictRow {
  readonly astHash: string;
  readonly codeunitName: string;
  readonly procedureName: string | null;
  readonly operatorName: string;
  readonly operatorMajor: number;
  /** R391: the row's file, which rule 2 matches on together with the tuple. */
  readonly file: string;
  /** R193 — see `MutantRow.identityOrdinal`. A pre-R193 row reads back 0: its twins, if it had
   *  any, then still collide on resume and are re-run, which is the cheap direction. */
  readonly identityOrdinal: number;
  readonly verdict: MutantVerdict;
  readonly killingTest?: string;
  readonly failureNote?: string;
  /** R86 — see `MutantRow.killingTestFailure`. Threaded through so `--resume` carries a kill's own
   *  account of why it died instead of quietly dropping it on the second run. */
  readonly killingTestFailure?: string;
  /** R206 — see `MutantRow.killPosition`. Threaded through for the same reason. */
  readonly killPosition?: number;
  readonly durationMs: number;
  /**
   * R69 Phase 2 Task 5 — see `RunnerKind`. Threaded through so `--resume` can carry it: without
   * this, a mutant killed under `GuiAllowed=Yes` in run 1 is re-recorded with no tag on `--resume`,
   * and a report defined as "contexts used in THIS run" would truthfully — and wrongly — report
   * fenced-only. Absent on every row recorded before this column existed.
   */
  readonly runner?: RunnerKind;
  /** R192 — see `MutantRow.coveringTests`. Present only on rows written since the columns exist. */
  readonly coveringTests?: readonly string[];
  readonly coverageAttribution?: CoverageAttribution;
  readonly unplaceable?: boolean;
  /** R474: `MutantRow.memberHash`; `null` on a row from before R474, which is no rule-2 site. */
  readonly memberHash: string | null;
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

/** R496: a session's PROVEN test-app identity: the test app's hash (R247) and its dependency
 *  fingerprint (R-371's `dependencyFingerprint`, taken under the lease). Both must equal a run's
 *  for that run to lend anything. */
export interface TestAppIdentity {
  readonly hash: string;
  readonly deps: string;
}

/** A run row, as `--resume` reads it back to check the candidate is actually resumable. */
export interface RunRow {
  readonly id: number;
  readonly projectPath: string;
  readonly backend: string;
  readonly configFingerprint: string | null;
  readonly finished: boolean;
  /** R325: the identity scheme the run's keys were made under. A row recorded before the column
   *  existed reads as 1. */
  readonly identityScheme: number;
  /** R214: the effective build symbols the run's keys were made under. `null` on a row recorded
   *  before the column existed: unknown, and never equal to any set. */
  readonly buildSymbols: readonly string[] | null;
  /** R354: the coverage mode the run measured under. `null` on a row recorded before the column
   *  existed: unknown, and never equal to any mode. */
  readonly coverageMode: CoverageMode | null;
  /** R247: the test app the run measured against (`testAppHashFor`'s value: `package:<sha256>` or
   *  `source:<hash>`). `null` when unknown, including every row recorded before the column: never
   *  equal to anything, NULL included. */
  readonly testAppHash: string | null;
  /** R495: the recorded `testAppHash` was PROVEN to be the test app the run measured (the hook's
   *  read-back proof, the installed check of the served package, or al-runner compiling its own
   *  test source). Every consumer (resume, history, the R192 snapshot) requires it. `false` on every
   *  row recorded before the column. */
  readonly testAppProven: boolean;
  /** R496: the dependency fingerprint (R-371's `dependencyFingerprint`) of the test app the run
   *  measured, taken under the lease with every extension in it proven installed. `testAppProven`
   *  implies it is set. `null` on every row recorded before the column, and on an unproven run:
   *  never equal to anything. */
  readonly testAppDeps: string | null;
  /** R442: what the run numbered no ordinal for. `null` on a row recorded before the column, or a
   *  run that died before generation: untrusted, so no history or resume carries from it. */
  readonly carryHidden: CarryHidden | null;
  /** R391: the source hash taken at generation (`sourceHashAtGeneration`), written by
   *  `createRun`. `null` when not recorded (before R391): no rule-1 carry from that run. */
  readonly generationSourceSha256: string | null;
  /** R391: sorted `twinSiteOf` pairs with a twin in their file. `null` is "not measured" (before
   *  R391, or the run died before generation): no rule-2 carry. `[]` is "measured, no twins". */
  readonly twinTuples: readonly string[] | null;
  /** R443: the run's `numberingDigestOf` (selection.ts), written beside `twin_tuples`. `null` when
   *  not recorded (before R443, or the run died before generation). */
  readonly numberingDigest: string | null;
}

/** R391: a stored `twin_tuples`, checked. NULL stays `null`; anything but a JSON string array
 *  is a corrupt row and throws. */
function parseTwinTuples(value: string | null, runId: number): readonly string[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) return parsed;
  throw new Error(
    `store.ts: run ${runId} has a corrupt "twin_tuples" column value ${JSON.stringify(value.slice(0, 200))} — expected a JSON array of strings or NULL`,
  );
}

/**
 * R442: what one run numbered no identity ordinal for, so a twin's ordinal there may differ from a
 * run that did number it. `tuples`: sorted `coarseIdentityTupleOf` strings of sites the run
 * generated but did not number. `files`: sorted paths of files hidden whole (their sites cannot be
 * listed). A file hidden in both runs moves no ordinal, so carry needs equal `files` lists.
 */
export interface CarryHidden {
  readonly tuples: readonly string[];
  readonly files: readonly string[];
}

/** R442: two `files` lists are equal (both sorted by their writer). */
export function sameHiddenFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/** R442: a stored `carry_hidden`, checked. NULL stays `null`; anything that is not
 *  `{"tuples": string[], "files": string[]}` is a corrupt row and throws. */
function parseCarryHidden(value: string | null, runId: number): CarryHidden | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === "string");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !strings((parsed as { tuples?: unknown }).tuples) ||
    !strings((parsed as { files?: unknown }).files)
  ) {
    throw new Error(`store.ts: run ${runId} has a corrupt "carry_hidden" column value`);
  }
  const { tuples, files } = parsed as CarryHidden;
  return { tuples, files };
}

/**
 * R360 I-1: the `bundle_pruned_by` value for a bundle dropped because the environment it was
 * installed on was deleted at env-tool teardown. Run ids start at 1, so 0 names no run.
 */
export const PRUNED_BY_ENV_TEARDOWN = 0;

/**
 * Review M-8: how long a write waits for another process's write lock before SQLITE_BUSY. A
 * BaseApp-sized bundle transaction was measured at 0.6 s (R360 I5), so 5 s covers it several times
 * over while a writer that is really stuck still fails loudly within seconds.
 */
export const STORE_BUSY_TIMEOUT_MS = 5000;

/** R354: the closed set a `coverage_mode` column may hold. Exhaustive by type. */
const COVERAGE_MODES: Record<CoverageMode, true> = {
  none: true,
  procedure: true,
  line: true,
  fenced: true,
  "al-runner": true,
};

/** R354: a stored `coverage_mode`, checked. NULL is "unknown"; any other string is a corrupt row. */
function parseCoverageMode(value: string | null, runId: number): CoverageMode | null {
  if (value === null) return null;
  if (Object.hasOwn(COVERAGE_MODES, value)) return value as CoverageMode;
  throw new Error(
    `store.ts: run ${runId} has a corrupt "coverage_mode" column value ${JSON.stringify(value)}; expected one of ${Object.keys(COVERAGE_MODES).join(", ")}, or NULL`,
  );
}

/** R214: a stored `build_symbols`, checked. NULL is "unknown" and stays `null`; a value that is
 *  not a JSON array of strings is a corrupt row and throws. */
function parseBuildSymbols(value: string | null): readonly string[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
    throw new Error(`store.ts: corrupt "build_symbols" column value ${JSON.stringify(value)}`);
  }
  return parsed as string[];
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
  config_fingerprint TEXT,
  source_sha256 TEXT,
  identity_scheme INTEGER,
  coverage_mode TEXT,
  test_app_hash TEXT,
  test_app_proven INTEGER,
  test_app_deps TEXT,
  test_digests TEXT,
  test_digest_parts TEXT
);
CREATE TABLE IF NOT EXISTS mutants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  mutant_code TEXT NOT NULL,
  ast_hash TEXT NOT NULL,
  codeunit_name TEXT NOT NULL,
  procedure_name TEXT,
  operator_name TEXT NOT NULL,
  operator_major INTEGER NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  killing_test TEXT,
  failure_note TEXT,
  killing_test_failure TEXT,
  kill_position INTEGER,
  duration_ms INTEGER NOT NULL,
  batch_index INTEGER,
  runner TEXT,
  covering_tests TEXT,
  coverage_attribution TEXT,
  unplaceable INTEGER,
  identity_ordinal INTEGER,
  carried INTEGER
);
-- idx_mutants_identity is created by migrate(), NOT here. It covers procedure_name, which R166
-- added by ALTER, and SCHEMA runs BEFORE migrate() -- so naming that column here throws
-- "no such column" on every pre-R166 database, from inside the constructor, which also leaks the
-- open handle. The index has to be created after the column is guaranteed to exist.
-- (No backticks in this comment: SCHEMA is a template literal and a backtick ends it.)
CREATE TABLE IF NOT EXISTS test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  mutant_row_id INTEGER REFERENCES mutants(id),
  mutant_code TEXT,
  codeunit_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  failure_message TEXT,
  op_kind TEXT,
  session_id INTEGER,
  codeunit_name TEXT
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
-- R192 (second half): a batch's completed baseline, keyed by what it measured. Reused on --resume
-- when both hashes match; see baseline-snapshot.ts.
CREATE TABLE IF NOT EXISTS baseline_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  batch_index INTEGER NOT NULL,
  batch_hash TEXT NOT NULL,
  test_app_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_key ON baseline_snapshots(batch_hash, test_app_hash);
-- C02-02: one row per PUBLISHED batch, alongside the runs columns above which stay last-batch-wins
-- (unchanged, for every existing reader). A whole new TABLE needs no migrate() step: see the R90
-- publish_outcomes comment below.
CREATE TABLE IF NOT EXISTS batch_artifacts (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  batch_index INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  app_version TEXT NOT NULL,
  -- C02-04b: SHA-256 of JSON.stringify(the manifest the compiler was given). NULL on a row written
  -- before the column existed, which trustedArtifactRecord's callers refuse rather than trust.
  manifest_sha256 TEXT,
  -- C02-06: where step 3d found the compiled package and batch dir. Provenance only since R360:
  -- verify reads the stored bundle (installed_bundles), never these paths.
  app_path TEXT,
  instrumented_dir TEXT,
  PRIMARY KEY (run_id, batch_index)
);
-- R360: the installed batch's files, kept in the store so the run's temp folder can be removed.
-- Looked up by exact (run_id, batch_index) only. One row per .al file, so neither side ever builds
-- one giant string. Pruned by recordArtifact (the same run's lower batches) and by finishRun.
CREATE TABLE IF NOT EXISTS installed_bundles (
  run_id INTEGER NOT NULL,
  batch_index INTEGER NOT NULL,
  app_bytes BLOB NOT NULL,
  app_json_text TEXT NOT NULL,
  manifest_gz BLOB NOT NULL,
  PRIMARY KEY (run_id, batch_index)
);
CREATE TABLE IF NOT EXISTS installed_bundle_files (
  run_id INTEGER NOT NULL,
  batch_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  text_gz BLOB NOT NULL,
  PRIMARY KEY (run_id, batch_index, path)
);
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
    this.db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS};`);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // R449: SQLite's default (FULL) fsyncs the WAL on EVERY commit, and opening a new store alone
    // is about 16 commits (90 ms on Linux ext4). An fsync waits on the whole machine's disk, so
    // under other load one store-backed unit test took 3 s here and 6.7 to 8.3 s on GitHub's
    // Windows runner. NORMAL, the setting SQLite recommends for WAL, fsyncs at checkpoints only:
    // a crashed or killed process loses nothing, and an OS crash or power cut can lose the last
    // commits but never corrupts the file. A lost verdict row is a mutant resume runs again.
    this.db.exec("PRAGMA synchronous = NORMAL;");
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
    // R166: `mutants` gained `procedure_name`, which joined the semantic identity (see
    // `IdentityKey` in selection.ts). Same hazard as the three above — `recordMutant`'s INSERT
    // names the column explicitly, so an older lethal.sqlite would throw mid-run. Pre-R166 rows
    // keep NULL, and both readers DROP a null rather than coercing it to `""`: an empty procedure
    // name is a real value (object-level mutants carry it), so coercing would let an old row match
    // a genuine object-level mutant and either skip it as a known survivor or carry a stale verdict
    // onto it. Dropping costs one re-run; matching wrongly costs a verdict.
    if (!cols.some((c) => c.name === "procedure_name")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN procedure_name TEXT");
    }
    // The identity index lives here rather than in `SCHEMA` (see the note there). Rebuilt only when
    // the stored definition does not already cover `procedure_name`, so this is a one-time cost on
    // an old database rather than a DROP/CREATE on every open.
    const idx = this.db
      .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_mutants_identity'")
      .get() as { sql: string | null } | null;
    if (idx === null || !(idx.sql ?? "").includes("procedure_name")) {
      this.db.exec("DROP INDEX IF EXISTS idx_mutants_identity");
      this.db.exec(
        "CREATE INDEX idx_mutants_identity " +
          "ON mutants(ast_hash, codeunit_name, procedure_name, operator_name, operator_major)",
      );
    }
    if (!cols.some((c) => c.name === "killing_test_failure")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN killing_test_failure TEXT");
    }
    // R192: the coverage facts behind a verdict (see `MutantRow.coveringTests`). NULL on every
    // pre-R192 row, which `--resume` reads as "this batch cannot be skipped", never as "no test".
    for (const col of [
      "covering_tests TEXT",
      "coverage_attribution TEXT",
      "unplaceable INTEGER",
      // R193: the sixth identity component. NULL on a pre-R193 row, read back as 0.
      "identity_ordinal INTEGER",
    ]) {
      const name = col.split(" ")[0] ?? "";
      if (!cols.some((c) => c.name === name)) {
        this.db.exec(`ALTER TABLE mutants ADD COLUMN ${col}`);
      }
    }
    // R198: which call produced a test-result row, `single` (RunMutant) or `many` (one method of
    // a RunMutantMany call). NULL on a pre-R198 row, and on rows written by a backend that has no
    // such call; the itests count `many` rows per mutant against a pre-committed number.
    const trCols = this.db.query("PRAGMA table_info(test_results)").all() as Array<{
      name: string;
    }>;
    if (!trCols.some((c) => c.name === "op_kind")) {
      this.db.exec("ALTER TABLE test_results ADD COLUMN op_kind TEXT");
    }
    // R206: `mutants` gained `kill_position` and `test_results` gained `session_id`. Same hazard
    // as the columns above (explicit INSERT lists); pre-R206 rows keep NULL, which both readers
    // DROP rather than default: a kill without a position predates the field, and says so.
    if (!cols.some((c) => c.name === "kill_position")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN kill_position INTEGER");
    }
    if (!trCols.some((c) => c.name === "session_id")) {
      this.db.exec("ALTER TABLE test_results ADD COLUMN session_id INTEGER");
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
    // C02-04b: batch_artifacts gained manifest_sha256. A C02-02 database has the table without
    // it; its old rows stay NULL, which reads as "no trusted record", never as a match.
    const baCols = this.db.query("PRAGMA table_info(batch_artifacts)").all() as Array<{
      name: string;
    }>;
    if (!baCols.some((c) => c.name === "manifest_sha256")) {
      this.db.exec("ALTER TABLE batch_artifacts ADD COLUMN manifest_sha256 TEXT");
    }
    // C02-06: the five columns lethal verify reads. Every one stays NULL on an older row, and
    // verify refuses a NULL as "recorded before verify existed", never reads it as a value.
    for (const [table, col, known] of [
      ["batch_artifacts", "app_path TEXT", baCols],
      ["batch_artifacts", "instrumented_dir TEXT", baCols],
      ["mutants", "carried INTEGER", cols],
      // R474: the enclosing member's hash. NULL on an older row: rule 2 carries nothing from it.
      ["mutants", "member_hash TEXT", cols],
      ["runs", "source_sha256 TEXT", runCols],
      // R325: NULL on an older row, and read as scheme 1, the only scheme there was.
      ["runs", "identity_scheme INTEGER", runCols],
      // R214: NULL on an older row, and read as "unknown", which matches no build.
      ["runs", "build_symbols TEXT", runCols],
      // R354: NULL on an older row, read as "coverage mode unknown", which never equals a mode.
      ["runs", "coverage_mode TEXT", runCols],
      // R247: NULL on an older row, read as "test app unknown", which never matches.
      ["runs", "test_app_hash TEXT", runCols],
      // R495: NULL on an older row, read as "not proven": it lends nothing to any session.
      ["runs", "test_app_proven INTEGER", runCols],
      // R496: NULL on an older row, read as "no dependency fingerprint": it lends nothing.
      ["runs", "test_app_deps TEXT", runCols],
      // R-278: NULL on an older row; verify refuses it as source-predates-verify.
      ["runs", "test_digests TEXT", runCols],
      // R-371: NULL on an older row; verify's too-many-new-tests refusal then names no cause.
      ["runs", "test_digest_parts TEXT", runCols],
      ["test_results", "codeunit_name TEXT", trCols],
      // R360: the instrumented payload digest, and which run pruned the batch's bundle. NULL on an
      // older row, which verify refuses as "recorded before R360", never reads as a value.
      ["batch_artifacts", "payload_sha256 TEXT", baCols],
      ["batch_artifacts", "bundle_pruned_by INTEGER", baCols],
      // R360: the quarantine resource key of the run's server; NULL for al-runner and for a
      // backend with no server. `finishRun` prunes within (app_id, resource_key).
      ["runs", "resource_key TEXT", runCols],
      // R442: NULL on an older row, read as untrusted: no history or resume carries from it.
      ["runs", "carry_hidden TEXT", runCols],
      // R391: NULL on an older row, read as "not recorded": no rule-1 carry from it.
      ["runs", "generation_source_sha256 TEXT", runCols],
      // R391: NULL on an older row, read as "not measured": no rule-2 carry from it.
      ["runs", "twin_tuples TEXT", runCols],
      // R443: NULL on an older row, read as "not recorded".
      ["runs", "numbering_digest TEXT", runCols],
    ] as const) {
      const name = col.split(" ")[0] ?? "";
      if (!known.some((c) => c.name === name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
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
    /** R325: the identity scheme the run's mutant rows are keyed under. Required, so a caller
     *  that records keys made by another build (verify records the SOURCE run's manifest keys)
     *  must say so rather than inherit this build's `IDENTITY_SCHEME`. */
    identityScheme: number;
    /** R214: the effective preprocessor symbols (config plus app.json) the run's keys were made
     *  under. Required for the reason identityScheme is. */
    buildSymbols: readonly string[];
    /** R354: the coverage mode the run measures under (`caps.coverage`). Required, so no run is
     *  recorded without one: a verdict is only comparable to one scored under the same mode. */
    coverageMode: CoverageMode;
    /** R360: `quarantineResourceKey` of the run's server. Absent (al-runner, a backend with no
     *  server) writes NULL, which groups with NULL when `finishRun` prunes. */
    resourceKey?: string;
    /** R247: the test app this run measures against. Absent is recorded NULL, "unknown", which
     *  no resume or history read ever matches. */
    testAppHash?: string;
    /** R495: `testAppHash` is proven to be the test app this run measures. Recorded as the run's
     *  `test_app_proven` (only together with a hash); absent is "not proven". */
    testAppProven?: boolean;
    /** R496: the test app's dependency fingerprint. A run is recorded proven only with a hash AND
     *  this (`test_app_proven = 1` implies `test_app_deps IS NOT NULL`). */
    testAppDeps?: string;
    /** R-278: every discovered test's source digest, by `testDigestKey`. Absent is recorded NULL,
     *  which `lethal verify` refuses as a run that predates it. */
    testDigests?: Readonly<Record<string, string>>;
    /** R-371: the parts those digests are made of (`TestDigestParts`), recorded with them. */
    testDigestParts?: unknown;
    /** R442: what the run's keys numbered no ordinal for. Absent or `null` writes NULL (untrusted).
     *  `runSession` writes it after generation (`setCarryHidden`); verify copies its source's here. */
    carryHidden?: CarryHidden | null;
    /** R391: the source hash taken at generation. Absent or `null` writes NULL (no rule-1 carry). */
    generationSourceSha256?: string | null;
    /** R391: the run's `twin_tuples`. Absent or `null` writes NULL ("not measured"). `runSession`
     *  writes it after generation (`setTwinTuples`); verify copies its source's here. */
    twinTuples?: readonly string[] | null;
    /** R443: the run's numbering digest. Absent or `null` writes NULL. `runSession` writes it
     *  after generation (`setNumberingDigest`); verify copies its source's here. */
    numberingDigest?: string | null;
  }): number {
    // R325: every run records the identity scheme its keys are made under, so no later session
    // can read them as keys of another scheme.
    // R496: proven only with a hash AND a dependency fingerprint, and the fingerprint only with it.
    const proven =
      info.testAppHash !== undefined &&
      info.testAppProven === true &&
      info.testAppDeps !== undefined;
    const r = this.db
      .query(
        "INSERT INTO runs (project_path, backend, app_version, config_fingerprint, identity_scheme, build_symbols, coverage_mode, resource_key, test_app_hash, test_app_proven, test_app_deps, test_digests, test_digest_parts, carry_hidden, generation_source_sha256, twin_tuples, numbering_digest) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(
        info.projectPath,
        info.backend,
        info.appVersion,
        info.configFingerprint ?? null,
        info.identityScheme,
        JSON.stringify([...new Set(info.buildSymbols)].sort()),
        info.coverageMode,
        info.resourceKey ?? null,
        info.testAppHash ?? null,
        proven ? 1 : null,
        proven ? (info.testAppDeps ?? null) : null,
        info.testDigests !== undefined ? JSON.stringify(info.testDigests) : null,
        info.testDigestParts !== undefined ? JSON.stringify(info.testDigestParts) : null,
        info.carryHidden != null ? JSON.stringify(info.carryHidden) : null,
        info.generationSourceSha256 ?? null,
        info.twinTuples != null ? JSON.stringify(info.twinTuples) : null,
        info.numberingDigest ?? null,
      ) as {
      id: number;
    };
    return r.id;
  }

  /** R391: records the run's `twin_tuples` once generation has numbered its sites. Called before
   *  any mutant row is written, so a run that dies before it holds no verdict and stays NULL. */
  setTwinTuples(runId: number, twinTuples: readonly string[]): void {
    const changed = this.db
      .query("UPDATE runs SET twin_tuples = ? WHERE id = ?")
      .run(JSON.stringify(twinTuples), runId).changes;
    if (changed !== 1) throw new Error(`store.ts: setTwinTuples: no run ${runId}`);
  }

  /** R443: records the run's numbering digest, beside `setTwinTuples` and at the same moment. */
  setNumberingDigest(runId: number, digest: string): void {
    const changed = this.db
      .query("UPDATE runs SET numbering_digest = ? WHERE id = ?")
      .run(digest, runId).changes;
    if (changed !== 1) throw new Error(`store.ts: setNumberingDigest: no run ${runId}`);
  }

  /**
   * R373: records an env-tool run's test digests, taken after its lease-held hook published the
   * test app. Writes only a row that holds none yet: zero rows changed (no such run, or digests
   * already recorded) is a caller-contract violation and throws, never an overwrite.
   */
  setRunTestDigests(
    runId: number,
    digests: Readonly<Record<string, string>>,
    parts: unknown,
  ): void {
    const changed = this.db
      .query(
        "UPDATE runs SET test_digests = ?, test_digest_parts = ? WHERE id = ? AND test_digests IS NULL",
      )
      .run(JSON.stringify(digests), JSON.stringify(parts), runId).changes;
    if (changed !== 1) {
      throw new Error(
        `store.ts: setRunTestDigests: run ${runId} does not exist or already records test digests`,
      );
    }
  }

  /** R486, R495, R496: the run's test-app identity, whether it is proven, and its dependency
   *  fingerprint, written TOGETHER in one UPDATE so a hash never stands without its flag and a flag
   *  never without its fingerprint. `null` records "unknown", which no resume, history or snapshot
   *  matches; `proven` is stored only with a hash and a fingerprint, and the fingerprint only with
   *  the flag. */
  setRunTestAppHash(
    runId: number,
    testAppHash: string | null,
    proven: boolean,
    deps: string | null,
  ): void {
    const flag = testAppHash !== null && deps !== null && proven;
    const changed = this.db
      .query(
        "UPDATE runs SET test_app_hash = ?, test_app_proven = ?, test_app_deps = ? WHERE id = ?",
      )
      .run(testAppHash, flag ? 1 : null, flag ? deps : null, runId).changes;
    if (changed !== 1) throw new Error(`store.ts: setRunTestAppHash: no run ${runId}`);
  }

  /** R496: withdraws a run's test digests and their parts (F9: a dependency changed while the
   *  session waited for the lease, so the pre-lease digests no longer describe what runs). Zero
   *  rows changed (no such run) is a caller-contract violation and throws. */
  clearRunTestDigests(runId: number): void {
    const changed = this.db
      .query("UPDATE runs SET test_digests = NULL, test_digest_parts = NULL WHERE id = ?")
      .run(runId).changes;
    if (changed !== 1) throw new Error(`store.ts: clearRunTestDigests: no run ${runId}`);
  }

  /** R442: records what the run numbered no ordinal for, once generation knows it. Called before
   *  any mutant row is written, so a run that dies before it holds no verdict and stays NULL. */
  setCarryHidden(runId: number, hidden: CarryHidden): void {
    const changed = this.db
      .query("UPDATE runs SET carry_hidden = ? WHERE id = ?")
      .run(JSON.stringify({ tuples: hidden.tuples, files: hidden.files }), runId).changes;
    if (changed !== 1) throw new Error(`store.ts: setCarryHidden: no run ${runId}`);
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
        `SELECT id FROM runs WHERE project_path = ? AND backend = ? AND config_fingerprint = ? AND COALESCE(identity_scheme, 1) = ? AND finished_at IS NULL AND EXISTS (SELECT 1 FROM mutants m WHERE m.run_id = runs.id AND m.verdict IN (${placeholders})) ORDER BY id DESC LIMIT 1`,
      )
      .get(
        q.projectPath,
        q.backend,
        q.configFingerprint,
        IDENTITY_SCHEME,
        ...q.carryableVerdicts,
      ) as {
      id: number;
    } | null;
    return row === null ? null : row.id;
  }

  /**
   * R325: the most recent unfinished run for this project and backend that holds something to
   * carry but was keyed under ANOTHER identity scheme. `--resume` never resumes it; this exists so
   * the refusal can name it instead of reporting that no run was found.
   */
  unfinishedRunUnderOtherScheme(q: {
    projectPath: string;
    backend: string;
    carryableVerdicts: readonly string[];
  }): { runId: number; identityScheme: number } | null {
    const placeholders = q.carryableVerdicts.map(() => "?").join(", ");
    const row = this.db
      .query(
        `SELECT id, COALESCE(identity_scheme, 1) AS scheme FROM runs WHERE project_path = ? AND backend = ? AND COALESCE(identity_scheme, 1) <> ? AND finished_at IS NULL AND EXISTS (SELECT 1 FROM mutants m WHERE m.run_id = runs.id AND m.verdict IN (${placeholders})) ORDER BY id DESC LIMIT 1`,
      )
      .get(q.projectPath, q.backend, IDENTITY_SCHEME, ...q.carryableVerdicts) as {
      id: number;
      scheme: number;
    } | null;
    return row === null ? null : { runId: row.id, identityScheme: row.scheme };
  }

  /** R214: the latest unfinished run for this project, backend and scheme that holds something to
   *  carry but was built under OTHER preprocessor symbols, or unrecorded ones (NULL). `--resume
   *  last` names it. */
  unfinishedRunUnderOtherSymbols(q: {
    projectPath: string;
    backend: string;
    buildSymbols: readonly string[];
    carryableVerdicts: readonly string[];
  }): { runId: number; buildSymbols: readonly string[] | null } | null {
    const placeholders = q.carryableVerdicts.map(() => "?").join(", ");
    const row = this.db
      .query(
        `SELECT id, build_symbols FROM runs WHERE project_path = ? AND backend = ? AND COALESCE(identity_scheme, 1) = ? AND (build_symbols IS NULL OR build_symbols <> ?) AND finished_at IS NULL AND EXISTS (SELECT 1 FROM mutants m WHERE m.run_id = runs.id AND m.verdict IN (${placeholders})) ORDER BY id DESC LIMIT 1`,
      )
      .get(
        q.projectPath,
        q.backend,
        IDENTITY_SCHEME,
        JSON.stringify([...new Set(q.buildSymbols)].sort()),
        ...q.carryableVerdicts,
      ) as { id: number; build_symbols: string | null } | null;
    return row === null
      ? null
      : { runId: row.id, buildSymbols: parseBuildSymbols(row.build_symbols) };
  }

  /**
   * R354: the most recent unfinished run for this project and backend, under this build's identity
   * scheme, that holds something to carry but was measured under ANOTHER coverage mode, or under an
   * unrecorded one (NULL: `IS NOT` counts it). `--resume` never resumes it; this exists so the
   * refusal can name it.
   */
  unfinishedRunUnderOtherCoverageMode(q: {
    projectPath: string;
    backend: string;
    coverageMode: CoverageMode;
    carryableVerdicts: readonly string[];
  }): { runId: number; coverageMode: CoverageMode | null } | null {
    const placeholders = q.carryableVerdicts.map(() => "?").join(", ");
    const row = this.db
      .query(
        `SELECT id, coverage_mode FROM runs WHERE project_path = ? AND backend = ? AND COALESCE(identity_scheme, 1) = ? AND coverage_mode IS NOT ? AND finished_at IS NULL AND EXISTS (SELECT 1 FROM mutants m WHERE m.run_id = runs.id AND m.verdict IN (${placeholders})) ORDER BY id DESC LIMIT 1`,
      )
      .get(q.projectPath, q.backend, IDENTITY_SCHEME, q.coverageMode, ...q.carryableVerdicts) as {
      id: number;
      coverage_mode: string | null;
    } | null;
    return row === null
      ? null
      : { runId: row.id, coverageMode: parseCoverageMode(row.coverage_mode, row.id) };
  }

  /** R-278: the run's recorded test digests, or `null` for a run recorded before them. A value
   *  that is not a JSON object of strings is a corrupt row and throws. */
  testDigests(runId: number): Record<string, string> | null {
    const row = this.db.query("SELECT test_digests FROM runs WHERE id = ?").get(runId) as {
      test_digests: string | null;
    } | null;
    if (row === null) throw new Error(`store.ts: no run ${runId}`);
    if (row.test_digests === null) return null;
    const parsed: unknown = JSON.parse(row.test_digests);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((v) => typeof v !== "string")
    ) {
      throw new Error(`store.ts: run ${runId} has a corrupt "test_digests" column value`);
    }
    return parsed as Record<string, string>;
  }

  /** R-371: the parts the run's test digests are made of, or `null` when it recorded none. Read
   *  only to explain a too-many-new-tests refusal; a malformed value throws. */
  testDigestParts(runId: number): unknown {
    const row = this.db.query("SELECT test_digest_parts FROM runs WHERE id = ?").get(runId) as {
      test_digest_parts: string | null;
    } | null;
    if (row === null) throw new Error(`store.ts: no run ${runId}`);
    return row.test_digest_parts === null ? null : JSON.parse(row.test_digest_parts);
  }

  /** R47: one run row by id, or `null`. Used to explain WHY an explicitly named `--resume-run`
   *  cannot be resumed (wrong project, wrong backend, different scope, already finished) rather
   *  than silently finding nothing. */
  getRun(runId: number): RunRow | null {
    const row = this.db
      .query(
        "SELECT id, project_path, backend, config_fingerprint, finished_at, COALESCE(identity_scheme, 1) AS identity_scheme, build_symbols, coverage_mode, test_app_hash, test_app_proven, test_app_deps, carry_hidden, generation_source_sha256, twin_tuples, numbering_digest FROM runs WHERE id = ?",
      )
      .get(runId) as {
      test_app_proven: number | null;
      test_app_deps: string | null;
      carry_hidden: string | null;
      generation_source_sha256: string | null;
      twin_tuples: string | null;
      numbering_digest: string | null;
      id: number;
      project_path: string;
      backend: string;
      config_fingerprint: string | null;
      finished_at: string | null;
      identity_scheme: number;
      build_symbols: string | null;
      coverage_mode: string | null;
      test_app_hash: string | null;
    } | null;
    if (row === null) return null;
    return {
      id: row.id,
      projectPath: row.project_path,
      backend: row.backend,
      configFingerprint: row.config_fingerprint,
      finished: row.finished_at !== null,
      identityScheme: row.identity_scheme,
      buildSymbols: parseBuildSymbols(row.build_symbols),
      coverageMode: parseCoverageMode(row.coverage_mode, row.id),
      testAppHash: row.test_app_hash,
      testAppProven: row.test_app_proven === 1,
      testAppDeps: row.test_app_deps,
      carryHidden: parseCarryHidden(row.carry_hidden, row.id),
      generationSourceSha256: row.generation_source_sha256,
      twinTuples: parseTwinTuples(row.twin_tuples, row.id),
      numberingDigest: row.numbering_digest,
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

  /** R192: `covering_tests` is a JSON array of strings, and anything else is a corrupt row, not a
   *  plausible empty list — the same rule `parseRunnerKind` applies. */
  private parseCoveringTests(
    value: string,
    row: { ast_hash: string; codeunit_name: string; operator_name: string },
  ): readonly string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) return parsed;
    throw new Error(
      `store.ts: mutant row (astHash=${row.ast_hash}, codeunitName=${row.codeunit_name}, ` +
        `operatorName=${row.operator_name}) has a corrupt "covering_tests" column value ` +
        `${JSON.stringify(value.slice(0, 200))} — expected a JSON array of test names or NULL`,
    );
  }

  private parseAttribution(
    value: string,
    row: { ast_hash: string; codeunit_name: string; operator_name: string },
  ): CoverageAttribution {
    if (value === "exact" || value === "object" || value === "all-green") return value;
    throw new Error(
      `store.ts: mutant row (astHash=${row.ast_hash}, codeunitName=${row.codeunit_name}, ` +
        `operatorName=${row.operator_name}) has a corrupt "coverage_attribution" column value ` +
        `${JSON.stringify(value)} — expected "exact", "object", "all-green", or NULL`,
    );
  }

  /** R47: every mutant verdict a prior run recorded, keyed by identity rather than mutant code —
   *  see `MutantVerdictRow`. */
  mutantVerdicts(runId: number): MutantVerdictRow[] {
    const rows = this.db
      .query(
        "SELECT ast_hash, codeunit_name, procedure_name, operator_name, operator_major, verdict, " +
          "killing_test, failure_note, killing_test_failure, kill_position, duration_ms, runner, " +
          "covering_tests, coverage_attribution, unplaceable, identity_ordinal, file, member_hash " +
          "FROM mutants WHERE run_id = ?",
      )
      .all(runId) as Array<{
      file: string;
      member_hash: string | null;
      ast_hash: string;
      codeunit_name: string;
      procedure_name: string | null;
      operator_name: string;
      operator_major: number;
      verdict: string;
      killing_test: string | null;
      failure_note: string | null;
      killing_test_failure: string | null;
      kill_position: number | null;
      duration_ms: number;
      runner: string | null;
      covering_tests: string | null;
      coverage_attribution: string | null;
      unplaceable: number | null;
      identity_ordinal: number | null;
    }>;
    return rows.map((r) => ({
      identityOrdinal: r.identity_ordinal ?? 0,
      file: r.file,
      memberHash: r.member_hash,
      ...(r.covering_tests !== null
        ? { coveringTests: this.parseCoveringTests(r.covering_tests, r) }
        : {}),
      ...(r.coverage_attribution !== null
        ? { coverageAttribution: this.parseAttribution(r.coverage_attribution, r) }
        : {}),
      ...(r.unplaceable !== null ? { unplaceable: r.unplaceable !== 0 } : {}),
      astHash: r.ast_hash,
      codeunitName: r.codeunit_name,
      procedureName: r.procedure_name,
      operatorName: r.operator_name,
      operatorMajor: r.operator_major,
      verdict: r.verdict as MutantVerdict,
      durationMs: r.duration_ms,
      ...(r.killing_test !== null ? { killingTest: r.killing_test } : {}),
      ...(r.failure_note !== null ? { failureNote: r.failure_note } : {}),
      ...(r.killing_test_failure !== null ? { killingTestFailure: r.killing_test_failure } : {}),
      ...(r.kill_position !== null ? { killPosition: r.kill_position } : {}),
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

  /**
   * Stamps the run finished and, in the same transaction, prunes installed bundles (R360 I1) in
   * the finishing run's group, the runs with its `app_id` and `resource_key` (`IS`, so NULL groups
   * with NULL). The group's most recently PUBLISHED bundle (highest `installed_bundles` rowid, i.e.
   * insert order) is the build on the server and is never pruned, whichever run finishes last
   * (review r1 #2: an older run finishing after a newer one must not prune the newer bundle).
   * Every OLDER-published bundle goes if its run is finished or started no later than this one
   * (ruling Q1); an unfinished run that started after this one keeps its bundle. `runSession` calls
   * this only for a run that did not throw and did not latch unsafe, so a failed run prunes nothing.
   */
  finishRun(runId: number, info: { batchCount: number; baselineGreen: boolean }): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          "UPDATE runs SET finished_at = datetime('now'), batch_count = ?, baseline_green = ? WHERE id = ?",
        )
        .run(info.batchCount, info.baselineGreen ? 1 : 0, runId);
      const doomed = this.db
        .query(
          "SELECT i.run_id, i.batch_index FROM installed_bundles i " +
            "JOIN runs o ON o.id = i.run_id JOIN runs me ON me.id = ? " +
            "WHERE o.app_id IS me.app_id AND o.resource_key IS me.resource_key " +
            "AND (o.finished_at IS NOT NULL OR o.id <= me.id) " +
            "AND i.rowid < (SELECT MAX(l.rowid) FROM installed_bundles l " +
            "JOIN runs lr ON lr.id = l.run_id " +
            "WHERE lr.app_id IS me.app_id AND lr.resource_key IS me.resource_key)",
        )
        .all(runId) as Array<{ run_id: number; batch_index: number }>;
      for (const d of doomed) this.pruneBundle(d.run_id, d.batch_index, runId);
    });
    tx();
    this.checkpoint();
  }

  /**
   * R360 I-1: the env-tool session deleted the environment whose quarantine resource key is
   * `resourceKey`, so no bundle installed there can be verified again. Drops every one, of any
   * run, and marks it `PRUNED_BY_ENV_TEARDOWN`. Returns how many were dropped.
   */
  dropBundlesOfResource(resourceKey: string): number {
    const tx = this.db.transaction(() => {
      const doomed = this.db
        .query(
          "SELECT i.run_id, i.batch_index FROM installed_bundles i " +
            "JOIN runs r ON r.id = i.run_id WHERE r.resource_key = ?",
        )
        .all(resourceKey) as Array<{ run_id: number; batch_index: number }>;
      for (const d of doomed) this.pruneBundle(d.run_id, d.batch_index, PRUNED_BY_ENV_TEARDOWN);
      return doomed.length;
    });
    const n = tx();
    this.checkpoint();
    return n;
  }

  /** R360: drops one batch's bundle and records which run pruned it. */
  private pruneBundle(runId: number, batchIndex: number, prunedBy: number): void {
    this.db
      .query("DELETE FROM installed_bundle_files WHERE run_id = ? AND batch_index = ?")
      .run(runId, batchIndex);
    this.db
      .query("DELETE FROM installed_bundles WHERE run_id = ? AND batch_index = ?")
      .run(runId, batchIndex);
    this.db
      .query("UPDATE batch_artifacts SET bundle_pruned_by = ? WHERE run_id = ? AND batch_index = ?")
      .run(prunedBy, runId, batchIndex);
  }

  /** Review r1 #4: a busy checkpoint is reported once per store, not on every write. */
  private walBusyWarned = false;

  /**
   * R360 I5, measured: a bundle write grows the WAL to about the bundle's size and SQLite never
   * truncates it by itself, so the store checkpoints after writing and after pruning.
   * Best-effort: the busy timeout is off for this one statement, so a reader holding the WAL makes
   * it report busy at once rather than stall the run for `STORE_BUSY_TIMEOUT_MS`. A busy result is
   * NOT cleanup (review r1 #4): it warns once, naming the WAL's size, and the next checkpoint retries.
   */
  private checkpoint(): void {
    this.db.exec("PRAGMA busy_timeout = 0;");
    let row: { busy: number } | null;
    try {
      row = this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS};`);
    }
    if (row === null || row.busy === 0 || this.walBusyWarned) return;
    this.walBusyWarned = true;
    let size = "an unknown number of";
    try {
      size = String(statSync(`${this.dbPath}-wal`).size);
    } catch {
      // No readable -wal file: the size stays unknown, the warning still names the file.
    }
    console.warn(
      `[lethal] could not truncate ${this.dbPath}-wal (${size} bytes): another connection is reading the results database, so the space stays in use until a later checkpoint succeeds (R360)`,
    );
  }

  /**
   * Corrects the run row after compilation. `createRun` runs before the version is derived, so
   * it can only write a placeholder; leaving it there made runs.app_version wrong for every run
   * ever recorded. 5C needs this provenance, and retrofitting it after pooled runs exist would
   * make historical diagnostics ambiguous.
   */
  recordArtifact(
    runId: number,
    info: {
      batchIndex: number;
      appVersion: string;
      appId: string;
      artifactId: string;
      sha256: string;
      /** C02-04b: SHA-256 of JSON.stringify(compiled.mutantManifest). Absent writes NULL. */
      manifestSha256?: string;
      /** C02-06: the compiled package and the batch dir it was built from. Absent writes NULL.
       *  Since R360 provenance only: verify reads `bundle`, never these paths. */
      appPath?: string;
      instrumentedDir?: string;
      /** R360 I4: the batch's installed files and their payload digest. REQUIRED: a published
       *  batch without its bundle has nothing left to verify once its temp folder is removed. */
      bundle: InstalledBundleWrite;
    },
  ): void {
    // One transaction: the run-row UPDATE (last batch wins, unchanged) and the batch_artifacts
    // INSERT (one row per batch, PRIMARY KEY-enforced) must both land or neither does. A plain
    // INSERT is deliberate: a second row for the same (run_id, batch_index) is a bug, and SQLite's
    // primary-key violation is the loud failure that catches it.
    const tx = this.db.transaction(() => {
      this.db
        .query(
          "UPDATE runs SET app_version = ?, app_id = ?, artifact_id = ?, artifact_sha256 = ? WHERE id = ?",
        )
        .run(info.appVersion, info.appId, info.artifactId, info.sha256, runId);
      this.db
        .query(
          "INSERT INTO batch_artifacts " +
            "(run_id, batch_index, artifact_id, artifact_sha256, app_version, manifest_sha256, " +
            "app_path, instrumented_dir, payload_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          runId,
          info.batchIndex,
          info.artifactId,
          info.sha256,
          info.appVersion,
          info.manifestSha256 ?? null,
          info.appPath ?? null,
          info.instrumentedDir ?? null,
          info.bundle.payloadSha256,
        );
      const { bundle } = info;
      this.db
        .query(
          "INSERT INTO installed_bundles (run_id, batch_index, app_bytes, app_json_text, manifest_gz) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .run(runId, info.batchIndex, bundle.appBytes, bundle.appJsonText, bundle.manifestGz);
      const insertFile = this.db.query(
        "INSERT INTO installed_bundle_files (run_id, batch_index, path, text_gz) VALUES (?, ?, ?, ?)",
      );
      for (const f of bundle.files) insertFile.run(runId, info.batchIndex, f.path, f.textGz);
      // Ruling Q2: this publish replaced the same run's lower batches on the server, so their
      // bundles go now. Another run's bundle is only ever pruned by `finishRun`.
      const lower = this.db
        .query("SELECT batch_index FROM installed_bundles WHERE run_id = ? AND batch_index < ?")
        .all(runId, info.batchIndex) as Array<{ batch_index: number }>;
      for (const l of lower) this.pruneBundle(runId, l.batch_index, runId);
    });
    tx();
    this.checkpoint();
  }

  /** Review M-1: whether one batch's bundle is stored, by exact `(runId, batchIndex)`, without
   *  loading it. */
  hasInstalledBundle(runId: number, batchIndex: number): boolean {
    return (
      this.db
        .query("SELECT 1 FROM installed_bundles WHERE run_id = ? AND batch_index = ?")
        .get(runId, batchIndex) !== null
    );
  }

  /** R360: one batch's stored bundle, by exact `(runId, batchIndex)`; `null` when none is stored. */
  installedBundle(runId: number, batchIndex: number): InstalledBundleRows | null {
    const head = this.db
      .query(
        "SELECT app_bytes, app_json_text, manifest_gz FROM installed_bundles " +
          "WHERE run_id = ? AND batch_index = ?",
      )
      .get(runId, batchIndex) as {
      app_bytes: Uint8Array;
      app_json_text: string;
      manifest_gz: Uint8Array;
    } | null;
    if (head === null) return null;
    const files = this.db
      .query(
        "SELECT path, text_gz FROM installed_bundle_files WHERE run_id = ? AND batch_index = ?",
      )
      .all(runId, batchIndex) as Array<{ path: string; text_gz: Uint8Array }>;
    return {
      appBytes: head.app_bytes,
      appJsonText: head.app_json_text,
      manifestGz: head.manifest_gz,
      files: files.map((f) => ({ path: f.path, textGz: f.text_gz })),
    };
  }

  /**
   * C02-04b: the record LethAL wrote when it held both the manifest and the .app bytes, for one
   * batch. `null` when no such batch was recorded. `manifestSha256` is `null` on a row written
   * before that column existed; the caller must refuse it, not trust it by default. `appId` is
   * the run's, since every batch of a run publishes one app id, but it can also be `null` (a NULL
   * `runs.app_id`); the caller must refuse that too, not trust it by default. `loadInstalledArtifact`
   * does both refusals, throwing `InstalledArtifactError("no-record", ...)`.
   */
  trustedArtifactRecord(
    runId: number,
    batchIndex: number,
  ): {
    artifactId: string;
    sha256: string;
    manifestSha256: string | null;
    appId: string | null;
    /** R360: NULL on a row written before R360. */
    payloadSha256: string | null;
    /** R360: the run that pruned this batch's bundle, or null. */
    bundlePrunedBy: number | null;
    /** R360: the run's quarantine resource key; null when it recorded no server. */
    resourceKey: string | null;
  } | null {
    const row = this.db
      .query(
        "SELECT b.artifact_id, b.artifact_sha256, b.manifest_sha256, r.app_id, " +
          "b.payload_sha256, b.bundle_pruned_by, r.resource_key " +
          "FROM batch_artifacts b JOIN runs r ON r.id = b.run_id " +
          "WHERE b.run_id = ? AND b.batch_index = ?",
      )
      .get(runId, batchIndex) as {
      artifact_id: string;
      artifact_sha256: string;
      manifest_sha256: string | null;
      app_id: string | null;
      payload_sha256: string | null;
      bundle_pruned_by: number | null;
      resource_key: string | null;
    } | null;
    if (row === null) return null;
    // A NULL app_id is returned, not thrown: the caller (`loadInstalledArtifact`) refuses it as
    // a typed InstalledArtifactError before any server call.
    return {
      artifactId: row.artifact_id,
      sha256: row.artifact_sha256,
      manifestSha256: row.manifest_sha256,
      appId: row.app_id,
      payloadSha256: row.payload_sha256,
      bundlePrunedBy: row.bundle_pruned_by,
      resourceKey: row.resource_key,
    };
  }

  /** C02-02: every published batch's artifact provenance for this run, ordered by batch_index. */
  artifactsForRun(runId: number): BatchArtifact[] {
    const rows = this.db
      .query(
        "SELECT batch_index, artifact_id, artifact_sha256, app_version FROM batch_artifacts " +
          "WHERE run_id = ? ORDER BY batch_index",
      )
      .all(runId) as Array<{
      batch_index: number;
      artifact_id: string;
      artifact_sha256: string;
      app_version: string;
    }>;
    return rows.map((r) => ({
      batchIndex: r.batch_index,
      artifactId: r.artifact_id,
      sha256: r.artifact_sha256,
      appVersion: r.app_version,
    }));
  }

  /** C02-06 decision 8: the target source hash, recorded only when generation and the last batch
   *  read the same source (see `runSession`). */
  recordSourceHash(runId: number, sha256: string): void {
    this.db.query("UPDATE runs SET source_sha256 = ? WHERE id = ?").run(sha256, runId);
  }

  /**
   * C02-06: the batch that recorded this artifact id, with its run. `null` when none. Two rows is
   * a corrupt store (a random 32-hex id cannot repeat), so it throws rather than picking one.
   * `highestBatchIndex` is the run's highest recorded batch, the only one still installed.
   */
  artifactRecordById(artifactId: string): {
    runId: number;
    projectPath: string;
    batchIndex: number;
    highestBatchIndex: number;
    artifactSha256: string;
    sourceSha256: string | null;
    appPath: string | null;
    instrumentedDir: string | null;
    /** R360: NULL on a row written before R360. */
    payloadSha256: string | null;
    /** R360: the run that pruned this batch's bundle, or null. */
    bundlePrunedBy: number | null;
    /** R360: the run's quarantine resource key; null when it recorded no server. */
    resourceKey: string | null;
  } | null {
    const rows = this.db
      .query(
        "SELECT b.run_id, r.project_path, b.batch_index, " +
          "(SELECT MAX(h.batch_index) FROM batch_artifacts h WHERE h.run_id = b.run_id) AS highest, " +
          "b.artifact_sha256, r.source_sha256, b.app_path, b.instrumented_dir, " +
          "b.payload_sha256, b.bundle_pruned_by, r.resource_key " +
          "FROM batch_artifacts b JOIN runs r ON r.id = b.run_id WHERE b.artifact_id = ?",
      )
      .all(artifactId) as Array<{
      run_id: number;
      project_path: string;
      batch_index: number;
      highest: number;
      artifact_sha256: string;
      source_sha256: string | null;
      app_path: string | null;
      instrumented_dir: string | null;
      payload_sha256: string | null;
      bundle_pruned_by: number | null;
      resource_key: string | null;
    }>;
    if (rows.length > 1) {
      throw new DuplicateArtifactRecordError(
        `store.ts: the store records artifact ${artifactId} twice (runs ${rows.map((r) => r.run_id).join(", ")}). A random artifact id cannot repeat, so the store is corrupt.`,
      );
    }
    const [row] = rows;
    if (row === undefined) return null;
    return {
      runId: row.run_id,
      projectPath: row.project_path,
      batchIndex: row.batch_index,
      highestBatchIndex: row.highest,
      artifactSha256: row.artifact_sha256,
      sourceSha256: row.source_sha256,
      appPath: row.app_path,
      instrumentedDir: row.instrumented_dir,
      payloadSha256: row.payload_sha256,
      bundlePrunedBy: row.bundle_pruned_by,
      resourceKey: row.resource_key,
    };
  }

  /** C02-06: one batch's mutant rows, in insert order. `carried` is null on a pre-column row. A
   *  NULL or malformed `covering_tests` throws: every writer since R192 records the list. */
  batchMutantRows(
    runId: number,
    batchIndex: number,
  ): Array<{
    mutantCode: string;
    verdict: MutantVerdict;
    coveringTests: readonly string[];
    carried: boolean | null;
  }> {
    const rows = this.db
      .query(
        "SELECT mutant_code, verdict, covering_tests, carried, ast_hash, codeunit_name, " +
          "operator_name FROM mutants WHERE run_id = ? AND batch_index = ? ORDER BY id",
      )
      .all(runId, batchIndex) as Array<{
      mutant_code: string;
      verdict: string;
      covering_tests: string | null;
      carried: number | null;
      ast_hash: string;
      codeunit_name: string;
      operator_name: string;
    }>;
    return rows.map((r) => {
      if (r.covering_tests === null) {
        throw new Error(
          `store.ts: mutant ${r.mutant_code} of run ${runId} batch ${batchIndex} has no "covering_tests" (a row from before R192)`,
        );
      }
      return {
        mutantCode: r.mutant_code,
        verdict: r.verdict as MutantVerdict,
        coveringTests: this.parseCoveringTests(r.covering_tests, r),
        carried: r.carried === null ? null : r.carried !== 0,
      };
    });
  }

  /** C02-06: every BASELINE row of a run (`mutant_row_id IS NULL`), deduplicated, ordered by
   *  codeunit id then method. `codeunitName` is null on a pre-column row. */
  baselineTests(
    runId: number,
  ): Array<{ codeunitId: number; codeunitName: string | null; method: string }> {
    const rows = this.db
      .query(
        "SELECT DISTINCT codeunit_id, codeunit_name, method FROM test_results " +
          "WHERE run_id = ? AND mutant_row_id IS NULL ORDER BY codeunit_id, method, codeunit_name",
      )
      .all(runId) as Array<{ codeunit_id: number; codeunit_name: string | null; method: string }>;
    return rows.map((r) => ({
      codeunitId: r.codeunit_id,
      codeunitName: r.codeunit_name,
      method: r.method,
    }));
  }

  /** C02-06 decision 11: every session id recorded under a run. */
  sessionIdsOf(runId: number): Set<number> {
    const rows = this.db
      .query(
        "SELECT DISTINCT session_id FROM test_results WHERE run_id = ? AND session_id IS NOT NULL",
      )
      .all(runId) as Array<{ session_id: number }>;
    return new Set(rows.map((r) => r.session_id));
  }

  /**
   * R192 (second half): persist a batch's COMPLETED baseline under the two hashes that identify
   * what it measured. Only a baseline that ran every test to a verdict is worth storing; the caller
   * decides that, this only writes.
   */
  recordBaselineSnapshot(input: {
    readonly runId: number;
    readonly batchIndex: number;
    readonly batchHash: string;
    readonly testAppHash: string;
    readonly baseline: readonly BaselineObservation[];
  }): void {
    this.db
      .query(
        `INSERT INTO baseline_snapshots (run_id, batch_index, batch_hash, test_app_hash, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.batchIndex,
        input.batchHash,
        input.testAppHash,
        JSON.stringify(input.baseline),
      );
  }

  /**
   * R192 (second half): the most recent snapshot for these hashes from any run of the CURRENT
   * identity scheme, or null. R318: a scheme bump can leave the emitted AL byte-identical while
   * changing how coverage is attributed, so an older scheme's snapshot matches both hashes but
   * carries the old attribution. It is never reused.
   * R354: and only from a run of the SAME coverage mode. A snapshot holds the green tests and the
   * coverage the batch's mutants are selected by, measured under its run's mode; another mode's
   * (or a pre-R354 run's, NULL) would select them by another rule. `=` never matches NULL.
   * R492: and only from a run whose own recorded `test_app_hash` equals the key. An env-tool run
   * served P2 while P1 was installed keyed its snapshot under P2 with P1's baseline; reused for a
   * P2 run, a test green under P1 and red under P2 would be sent as covering and score a false
   * kill. Such a run now records NULL (its read-back was not proven installed), so it lends none.
   * R495: and the run must have PROVEN that hash (`test_app_proven = 1`), for every session kind.
   * A run without that proof lends no snapshot: the batch re-runs its baseline.
   * R496: and the run's dependency fingerprint must equal `testAppDeps`, this session's: the same
   * test app against a rebuilt dependency is not the same test app. `=` never matches NULL, so a
   * row recorded before R496 lends none.
   */
  findBaselineSnapshot(
    batchHash: string,
    testAppHash: string,
    testAppDeps: string,
    coverageMode: CoverageMode,
  ): BaselineSnapshot | null {
    const row = this.db
      .query(
        `SELECT run_id, batch_index, batch_hash, test_app_hash, payload FROM baseline_snapshots
         WHERE batch_hash = ? AND test_app_hash = ?
           AND run_id IN (SELECT id FROM runs WHERE COALESCE(identity_scheme, 1) = ? AND coverage_mode = ?
             AND test_app_hash = baseline_snapshots.test_app_hash
             AND test_app_proven = 1
             AND test_app_deps = ?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(batchHash, testAppHash, IDENTITY_SCHEME, coverageMode, testAppDeps) as {
      run_id: number;
      batch_index: number;
      batch_hash: string;
      test_app_hash: string;
      payload: string;
    } | null;
    if (row === null) return null;
    let baseline: unknown;
    try {
      baseline = JSON.parse(row.payload);
    } catch {
      baseline = undefined;
    }
    if (!Array.isArray(baseline)) {
      throw new Error(
        `store.ts: baseline_snapshots row for run ${row.run_id} batch ${row.batch_index} has a corrupt payload — expected a JSON array of observations`,
      );
    }
    return {
      runId: row.run_id,
      batchIndex: row.batch_index,
      batchHash: row.batch_hash,
      testAppHash: row.test_app_hash,
      baseline: baseline as BaselineObservation[],
    };
  }

  /** Returns the `mutants.id` row id SQLite assigned this insert (see I5: `mutant_code` alone
   *  is only unique within a batch, so callers need this to disambiguate test_results rows
   *  across batches). */
  recordMutant(runId: number, row: MutantRow): number {
    const r = this.db
      .query(
        `INSERT INTO mutants (run_id, mutant_code, ast_hash, codeunit_name, procedure_name,
         operator_name, operator_major, file, line, verdict, killing_test, failure_note,
         killing_test_failure, kill_position, duration_ms, batch_index, runner,
         covering_tests, coverage_attribution, unplaceable, identity_ordinal, carried, member_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        runId,
        row.mutantCode,
        row.astHash,
        row.codeunitName,
        row.procedureName,
        row.operatorName,
        row.operatorMajor,
        row.file,
        row.line,
        row.verdict,
        row.killingTest ?? null,
        row.failureNote ?? null,
        row.killingTestFailure ?? null,
        row.killPosition ?? null,
        row.durationMs,
        row.batchIndex,
        row.runner ?? null,
        row.coveringTests !== undefined ? JSON.stringify(row.coveringTests) : null,
        row.coverageAttribution ?? null,
        row.unplaceable === undefined ? null : row.unplaceable ? 1 : 0,
        row.identityOrdinal ?? 0,
        row.carried === undefined ? null : row.carried ? 1 : 0,
        row.memberHash ?? null,
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
          "killing_test_failure = NULL, kill_position = NULL " +
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
    opKind?: "single" | "many",
    sessionId?: number,
  ): void {
    this.db
      .query(
        `INSERT INTO test_results (run_id, mutant_row_id, mutant_code, codeunit_id, codeunit_name, method, outcome, duration_ms, failure_message, op_kind, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        mutantRowId,
        mutantCode,
        ref.codeunitId,
        ref.codeunitName,
        ref.method,
        outcome,
        durationMs,
        failureMessage ?? null,
        opKind ?? null,
        sessionId ?? null,
      );
  }

  /**
   * R206 §6: the store-level liveness check on `session_id`, scoped to the rows that came from an
   * answer (a 408 body carries no id, so `timeout` rows have none; so does an aborted call's):
   * among rows whose outcome is pass or fail, how many carry an id and how many do not, how many
   * distinct ids the grouped rows carry, and how many single-call rows there are against how many
   * distinct ids they carry. A gate asserts `missing === 0`, `manyDistinct === groupedCalls minus
   * the calls that did not answer`, and `singleRows === singleDistinct`.
   */
  sessionIdLiveness(runId: number): {
    answered: number;
    missing: number;
    manyDistinct: number;
    singleRows: number;
    singleDistinct: number;
  } {
    const counts = this.db
      .query(
        "SELECT COUNT(*) AS answered, SUM(CASE WHEN session_id IS NULL THEN 1 ELSE 0 END) AS missing FROM test_results WHERE run_id = ? AND outcome IN ('pass', 'fail')",
      )
      .get(runId) as { answered: number; missing: number | null };
    const many = this.db
      .query(
        "SELECT COUNT(DISTINCT session_id) AS n FROM test_results WHERE run_id = ? AND outcome IN ('pass', 'fail') AND op_kind = 'many' AND session_id IS NOT NULL",
      )
      .get(runId) as { n: number };
    const single = this.db
      .query(
        "SELECT COUNT(*) AS rows, COUNT(DISTINCT session_id) AS distinct_ids FROM test_results WHERE run_id = ? AND outcome IN ('pass', 'fail') AND (op_kind IS NULL OR op_kind = 'single') AND session_id IS NOT NULL",
      )
      .get(runId) as { rows: number; distinct_ids: number };
    return {
      answered: counts.answered,
      missing: counts.missing ?? 0,
      manyDistinct: many.n,
      singleRows: single.rows,
      singleDistinct: single.distinct_ids,
    };
  }

  /** R198: how many `test_results` rows in a run came from group calls, and for how many mutants. */
  groupedRows(runId: number): { rows: number; mutants: number } {
    const r = this.db
      .query(
        "SELECT COUNT(*) AS rows, COUNT(DISTINCT mutant_row_id) AS mutants FROM test_results WHERE run_id = ? AND op_kind = 'many'",
      )
      .get(runId) as { rows: number; mutants: number };
    return r;
  }

  /** A prior "known-survivor" verdict counts exactly like "survived" here (I4) — it means the
   *  identity key was skipped rather than re-tested, so it must remain skippable/filterable in
   *  the run after that, not silently fall out of history after one `--skip-known-survivors` pass.
   *  R391: returns the survivors' keys AND their (file, tuple) sites, plus the run's generation
   *  hash and `twin_tuples`; `filterHistory` decides which of them carries (`carryRecord`). */
  priorSurvivorKeys(
    projectPath: string,
    /** R354: the coverage mode THIS session measures under. A survivor recorded under another
     *  mode, or an unrecorded one, is not a survivor under this one, so none is returned. */
    coverageMode: CoverageMode,
    /** R247: the test app THIS session measures against. A survivor measured against another test
     *  app, or an unknown one (`undefined` here, NULL on the run), is not evidence: a new test is
     *  exactly what might kill it. No key is returned then. R496: the identity is the hash AND the
     *  dependency fingerprint; a run with other or NULL deps yields no keys. */
    testApp: TestAppIdentity | undefined,
    /** R214: this build's effective symbols. A latest run built under another set, or an
     *  unrecorded one, yields no keys. */
    buildSymbols: readonly string[],
    /** R442: THIS run's `carryHidden.files`. A latest run that hid other files whole numbered its
     *  twins differently, so it yields no keys. */
    hiddenFiles: readonly string[],
    on: {
      /** R442: the latest finished run recorded no `carry_hidden` (before R442, or it died before
       *  generation): untrusted, no keys. Checked after the symbols. */
      readonly carryUntrusted?: (info: { runId: number }) => void;
      /** R442: the latest finished run hid other files whole than this run does. */
      readonly hiddenFilesChanged?: (info: {
        runId: number;
        before: readonly string[];
        now: readonly string[];
      }) => void;
      /**
       * R325: the latest finished run was keyed under another identity scheme. Its keys then name
       * nothing reliable in this build (a renumbering can hand one to a different mutant), so NO
       * key is returned and nothing is skipped; the caller says so.
       */
      readonly schemeChanged?: (info: { runId: number; identityScheme: number }) => void;
      /** R214: the latest finished run was built under other symbols (or before they were
       *  recorded). Checked last, after the test app. */
      readonly symbolsChanged?: (info: {
        runId: number;
        buildSymbols: readonly string[] | null;
      }) => void;
      /** R354: the latest finished run was measured under another coverage mode, or an
       *  unrecorded one. Checked after the scheme. */
      readonly coverageModeChanged?: (info: {
        runId: number;
        coverageMode: CoverageMode | null;
      }) => void;
      /** R247: the test app differs, or is unknown; R495: or was not proven installed (`proven`
       *  false); R496: or its dependency fingerprint differs or is NULL (`deps`). Checked after the
       *  coverage mode. */
      readonly testAppChanged?: (info: {
        runId: number;
        testAppHash: string | null;
        proven: boolean;
        deps: string | null;
      }) => void;
    } = {},
  ): PriorSurvivors {
    const none = NO_PRIOR_SURVIVORS;
    const run = this.db
      .query(
        "SELECT id, COALESCE(identity_scheme, 1) AS scheme, build_symbols, coverage_mode, test_app_hash, test_app_proven, test_app_deps, carry_hidden, generation_source_sha256, twin_tuples FROM runs WHERE project_path = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(projectPath) as {
      test_app_proven: number | null;
      test_app_deps: string | null;
      carry_hidden: string | null;
      generation_source_sha256: string | null;
      twin_tuples: string | null;
      id: number;
      scheme: number;
      build_symbols: string | null;
      coverage_mode: string | null;
      test_app_hash: string | null;
    } | null;
    if (!run) return none;
    if (run.scheme !== IDENTITY_SCHEME) {
      on.schemeChanged?.({ runId: run.id, identityScheme: run.scheme });
      return none;
    }
    const recorded = parseCoverageMode(run.coverage_mode, run.id);
    if (recorded !== coverageMode) {
      on.coverageModeChanged?.({ runId: run.id, coverageMode: recorded });
      return none;
    }
    // R495: only a run that PROVED its test app was the one it measured, for every session kind: a
    // run served P2 while P1 was installed recorded P2 and measured P1.
    // R496: and against the same dependency closure; NULL deps never match.
    if (
      run.test_app_hash === null ||
      run.test_app_hash !== testApp?.hash ||
      run.test_app_proven !== 1 ||
      run.test_app_deps === null ||
      run.test_app_deps !== testApp.deps
    ) {
      on.testAppChanged?.({
        runId: run.id,
        testAppHash: run.test_app_hash,
        proven: run.test_app_proven === 1,
        deps: run.test_app_deps,
      });
      return none;
    }
    const recordedSymbols = parseBuildSymbols(run.build_symbols);
    if (recordedSymbols === null || !sameBuildSymbols(recordedSymbols, buildSymbols)) {
      on.symbolsChanged?.({ runId: run.id, buildSymbols: recordedSymbols });
      return none;
    }
    // R442: a key of that run may name another mutant here when it hid a site this run numbers
    // (or the other way round). NULL is untrusted; other hidden FILES refuse every key; a hidden
    // TUPLE drops only the rows sharing it (`coarseIdentityTupleOf`, a superset of every twin).
    const hidden = parseCarryHidden(run.carry_hidden, run.id);
    if (hidden === null) {
      on.carryUntrusted?.({ runId: run.id });
      return none;
    }
    if (!sameHiddenFiles(hidden.files, hiddenFiles)) {
      on.hiddenFilesChanged?.({ runId: run.id, before: hidden.files, now: hiddenFiles });
      return none;
    }
    const hiddenTuples = new Set(hidden.tuples);
    const rows = this.db
      .query(
        "SELECT ast_hash, codeunit_name, procedure_name, operator_name, operator_major, identity_ordinal, file, member_hash FROM mutants " +
          "WHERE run_id = ? AND verdict IN ('survived', 'known-survivor')",
      )
      .all(run.id) as Array<{
      file: string;
      member_hash: string | null;
      ast_hash: string;
      codeunit_name: string;
      procedure_name: string | null;
      operator_name: string;
      operator_major: number;
      identity_ordinal: number | null;
    }>;
    // A row written before R166 added the column has `procedure_name = null`. It is DROPPED rather
    // than keyed with an empty procedure: an empty name is a real value (object-level mutants use
    // it), so treating null as empty would let a pre-R166 row match a genuine object-level mutant
    // and skip it as a known survivor. Dropping costs one re-run; matching wrongly costs a verdict.
    const kept = rows
      .filter((r) => r.procedure_name !== null)
      .filter(
        (r) =>
          !hiddenTuples.has(
            coarseIdentityTupleOf({
              astHash: r.ast_hash,
              operatorName: r.operator_name,
              operatorVersion: `${r.operator_major}`,
            }),
          ),
      )
      .map((r) => {
        const key: IdentityKey = {
          astHash: r.ast_hash,
          codeunitName: r.codeunit_name,
          procedureName: r.procedure_name ?? "",
          operatorName: r.operator_name,
          operatorMajor: r.operator_major,
          ordinal: r.identity_ordinal ?? 0,
        };
        // The tuple is the key without its ordinal (`serializeKey` adds it only above 0).
        return {
          key: serializeKey(key),
          tuple: serializeKey({ ...key, ordinal: 0 }),
          file: r.file,
          memberHash: r.member_hash,
        };
      });
    // R391: rule 2 (`carryRecord`) needs the survivors' (file, tuple) and the run's own twin facts.
    const twins = parseTwinTuples(run.twin_tuples, run.id);
    return {
      keys: new Set(kept.map((k) => k.key)),
      // R474: a rule-2 site also names the member's hash; a NULL one (an older row) names none.
      sites: new Set(
        kept.flatMap((k) =>
          k.memberHash === null ? [] : [memberSiteOf(twinSiteOf(k.file, k.tuple), k.memberHash)],
        ),
      ),
      recorded: {
        hash: run.generation_source_sha256,
        twins: twins === null ? null : new Set(twins),
      },
    };
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
      // R421: either separator on either side. A Windows run before R421 recorded `src\X.al`, and
      // the refusal now names `src/X.al`. Must match `clearPublishCeiling`'s filter exactly, which
      // checks the deleted count against the rows it identified.
      this.db
        .query("DELETE FROM publish_outcomes WHERE tier = ? AND REPLACE(file, '\\', '/') = ?")
        .run(tier, normalizeRelPath(file));
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
