import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARRYABLE_VERDICTS } from "../src/resume";
import { type MutantVerdict, ResultsStore } from "../src/store";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };
const APP = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";

function mutantRow(verdict: MutantVerdict, over: Record<string, unknown> = {}) {
  return {
    mutantCode: "M0001",
    astHash: "abc123",
    codeunitName: "Sample",
    procedureName: "Post",
    operatorName: "conditional-boundary",
    operatorMajor: 1,
    file: "Sample.Codeunit.al",
    line: 12,
    verdict,
    durationMs: 40,
    // R47: every mutant row records the batch that produced it, so `invalidateBatch` can name one
    // artifact's verdicts (`mutant_code` restarts numbering per batch and cannot).
    batchIndex: 0,
    ...over,
  };
}

describe("ResultsStore", () => {
  test("round-trips a run with mutants and test results", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.1.1" });
    store.recordTestResult(runId, null, null, ref, "pass", 30);
    store.recordMutant(runId, mutantRow("killed", { killingTest: "PostingUpdatesTotal" }));
    store.recordMutant(runId, mutantRow("survived", { mutantCode: "M0002", astHash: "def456" }));
    store.finishRun(runId, { batchCount: 1, baselineGreen: true });
    expect(store.priorSurvivorKeys("/p")).toEqual(
      new Set(["def456|Sample|Post|conditional-boundary|1"]),
    );
    store.close();
  });

  test("priorSurvivorKeys reads only the latest finished run for the project", () => {
    const store = new ResultsStore(":memory:");
    const r1 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
    store.recordMutant(r1, mutantRow("survived"));
    store.finishRun(r1, { batchCount: 1, baselineGreen: true });
    const r2 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "2" });
    store.recordMutant(r2, mutantRow("killed"));
    store.finishRun(r2, { batchCount: 1, baselineGreen: true });
    expect(store.priorSurvivorKeys("/p").size).toBe(0);
    store.close();
  });

  // I4: --skip-known-survivors demotes a survivor to "known-survivor" on the
  // run that skips re-testing it (see filterHistory in selection.ts). That
  // demoted verdict must keep counting as a prior survivor in every run
  // after that, not just the one where it was still "survived".
  test("known-survivor verdicts count as prior survivors just like survived (I4)", () => {
    const store = new ResultsStore(":memory:");
    const key = "abc123|Sample|Post|conditional-boundary|1";

    const r1 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
    store.recordMutant(r1, mutantRow("survived"));
    store.finishRun(r1, { batchCount: 1, baselineGreen: true });
    expect(store.priorSurvivorKeys("/p")).toEqual(new Set([key]));

    // Run 2 skips re-testing it (skip-known-survivors) and records it as
    // "known-survivor" instead of re-deriving "survived".
    const r2 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "2" });
    store.recordMutant(r2, mutantRow("known-survivor"));
    store.finishRun(r2, { batchCount: 1, baselineGreen: true });

    // Run 3 starts (mid-flight, not yet finished) and must still see the key
    // via run 2's now-latest-finished results.
    store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "3" });
    expect(store.priorSurvivorKeys("/p")).toEqual(new Set([key]));
    store.close();
  });

  // I5: mutant_code alone is ambiguous across batches (assignMutantIds
  // restarts numbering per batch), so recordMutant must hand back the
  // mutants.id row id, and recordTestResult must be able to carry it.
  describe("mutant_row_id threading (I5)", () => {
    test("recordMutant returns the inserted row id", () => {
      const store = new ResultsStore(":memory:");
      const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
      const id1 = store.recordMutant(runId, mutantRow("killed"));
      const id2 = store.recordMutant(runId, mutantRow("survived", { mutantCode: "M0002" }));
      expect(typeof id1).toBe("number");
      expect(id2).toBeGreaterThan(id1);
      store.close();
    });

    test("recordTestResult accepts a mutant_row_id distinct from mutant_code", () => {
      const store = new ResultsStore(":memory:");
      const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
      const mutantRowId = store.recordMutant(runId, mutantRow("killed"));
      // Baseline result: no mutant involved — mutant_row_id and mutant_code both NULL.
      store.recordTestResult(runId, null, null, ref, "pass", 10);
      // Per-mutant result: mutant_row_id ties it to the specific mutant row,
      // independent of mutant_code (which repeats across batches).
      store.recordTestResult(runId, mutantRowId, "M0001", ref, "fail", 12);
      store.finishRun(runId, { batchCount: 1, baselineGreen: true });
      // No public read API beyond priorSurvivorKeys — this test's job is
      // simply to prove the new signature compiles and executes without
      // throwing (schema round-trip); orchestrator.test.ts exercises the
      // end-to-end wiring.
      store.close();
    });
  });

  test("records real deployment provenance over the createRun placeholder", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runId, {
      batchIndex: 0,
      appVersion: "1.0.20653.1800",
      appId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      artifactId: "0123456789abcdef0123456789abcdef",
      sha256: "a".repeat(64),
    });
    const row = store.db
      .query("SELECT app_version, app_id, artifact_id, artifact_sha256 FROM runs WHERE id = ?")
      .get(runId) as Record<string, string>;
    expect(row.app_version).toBe("1.0.20653.1800");
    expect(row.app_id).toBe("df1aa9ff-6539-4c86-a9d0-ad702b61ac9a");
    expect(row.artifact_id).toBe("0123456789abcdef0123456789abcdef");
    expect(row.artifact_sha256).toBe("a".repeat(64));
    store.close();
  });

  // C02-02 Task 1: one row per PUBLISHED batch, not just the run row's last-writer-wins columns.
  test("recordArtifact keeps one row per batch, and runs.artifact_id is the last batch's", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    const a = "0123456789abcdef0123456789abcdef";
    const b = "fedcba9876543210fedcba9876543210";
    store.recordArtifact(runId, {
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP,
      artifactId: a,
      sha256: "a".repeat(64),
    });
    store.recordArtifact(runId, {
      batchIndex: 1,
      appVersion: "1.0.1.2",
      appId: APP,
      artifactId: b,
      sha256: "b".repeat(64),
    });
    expect(store.artifactsForRun(runId)).toEqual([
      { batchIndex: 0, artifactId: a, sha256: "a".repeat(64), appVersion: "1.0.1.1" },
      { batchIndex: 1, artifactId: b, sha256: "b".repeat(64), appVersion: "1.0.1.2" },
    ]);
    const row = store.db.query("SELECT artifact_id FROM runs WHERE id = ?").get(runId) as {
      artifact_id: string;
    };
    expect(row.artifact_id).toBe(b);
    store.close();
  });

  test("recordArtifact refuses a second row for the same batch, and changes nothing when it does", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    const a = "0123456789abcdef0123456789abcdef";
    store.recordArtifact(runId, {
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP,
      artifactId: a,
      sha256: "a".repeat(64),
    });
    expect(() =>
      store.recordArtifact(runId, {
        batchIndex: 0,
        appVersion: "1.0.1.9",
        appId: APP,
        artifactId: "fedcba9876543210fedcba9876543210",
        sha256: "b".repeat(64),
      }),
    ).toThrow();
    // All four legacy runs columns still hold batch 0's values, and artifactsForRun still
    // returns only batch 0: proving the UPDATE and the INSERT share one transaction.
    const row = store.db
      .query("SELECT app_version, app_id, artifact_id, artifact_sha256 FROM runs WHERE id = ?")
      .get(runId) as Record<string, string>;
    expect(row.app_version).toBe("1.0.1.1");
    expect(row.app_id).toBe(APP);
    expect(row.artifact_id).toBe(a);
    expect(row.artifact_sha256).toBe("a".repeat(64));
    expect(store.artifactsForRun(runId)).toEqual([
      { batchIndex: 0, artifactId: a, sha256: "a".repeat(64), appVersion: "1.0.1.1" },
    ]);
    store.close();
  });

  // C02-04b Task 6: the manifest hash is written in the same insert as the .app hash, and read
  // back only through trustedArtifactRecord, never through artifactsForRun (BatchArtifact does not
  // gain it).
  test("recordArtifact stores the manifest hash and trustedArtifactRecord returns it", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    const a = "0123456789abcdef0123456789abcdef";
    store.recordArtifact(runId, {
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP,
      artifactId: a,
      sha256: "a".repeat(64),
      manifestSha256: "c".repeat(64),
    });
    expect(store.trustedArtifactRecord(runId, 0)).toEqual({
      artifactId: a,
      sha256: "a".repeat(64),
      manifestSha256: "c".repeat(64),
      appId: APP,
    });
    expect(store.trustedArtifactRecord(runId, 1)).toBeNull();
    expect(store.artifactsForRun(runId)).toEqual([
      { batchIndex: 0, artifactId: a, sha256: "a".repeat(64), appVersion: "1.0.1.1" },
    ]);
    store.close();
  });

  test("a batch_artifacts row written before the column exists reads back manifestSha256 null", () => {
    const path = join(tmpdir(), `lethal-store-manifest-sha-${Date.now()}.sqlite`);
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE runs (
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
  CREATE TABLE batch_artifacts (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    batch_index INTEGER NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    app_version TEXT NOT NULL,
    PRIMARY KEY (run_id, batch_index)
  );`);
    legacy.exec(
      `INSERT INTO runs (project_path, backend, app_version, app_id) VALUES ('P','bcdev','1.0.1.1','${APP}')`,
    );
    legacy.exec(
      `INSERT INTO batch_artifacts (run_id, batch_index, artifact_id, artifact_sha256, app_version) VALUES (1, 0, '${"d".repeat(32)}', '${"e".repeat(64)}', '1.0.1.1')`,
    );
    legacy.close();

    const store = new ResultsStore(path);
    expect(store.trustedArtifactRecord(1, 0)).toEqual({
      artifactId: "d".repeat(32),
      sha256: "e".repeat(64),
      manifestSha256: null,
      appId: APP,
    });
    store.close();
    rmSync(path, { force: true });
  });

  test("artifactsForRun is empty for a run that published nothing", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    expect(store.artifactsForRun(runId)).toEqual([]);
    store.close();
  });

  test("migrates a pre-5A runs table that lacks the provenance columns", () => {
    const path = join(tmpdir(), `lethal-store-5a-${Date.now()}.sqlite`);
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    project_path TEXT NOT NULL,
    backend TEXT NOT NULL,
    app_version TEXT NOT NULL,
    batch_count INTEGER,
    baseline_green INTEGER
  );`);
    legacy.exec(
      "INSERT INTO runs (project_path, backend, app_version) VALUES ('P','bcdev','0.0.0.0')",
    );
    legacy.close();

    const store = new ResultsStore(path);
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    expect(() =>
      store.recordArtifact(runId, {
        batchIndex: 0,
        appVersion: "1.0.1.1",
        appId: "x",
        artifactId: "y",
        sha256: "z",
      }),
    ).not.toThrow();
    store.close();
    rmSync(path, { force: true });
  });

  // C02-02 Task 1: batch_artifacts is a whole new TABLE, so (like publish_outcomes and
  // baseline_snapshots before it) SCHEMA's CREATE TABLE IF NOT EXISTS must be enough on its own,
  // with no migrate() step, even on a database that predates this table entirely.
  test("a database created before batch_artifacts is migrated on open and accepts recordArtifact", () => {
    const path = join(tmpdir(), `lethal-store-batch-artifacts-${Date.now()}.sqlite`);
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE runs (
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
  );`);
    legacy.exec(
      "INSERT INTO runs (project_path, backend, app_version) VALUES ('P','bcdev','0.0.0.0')",
    );
    legacy.close();

    const store = new ResultsStore(path);
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runId, {
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: "x",
      artifactId: "y".repeat(8),
      sha256: "z".repeat(8),
    });
    expect(store.artifactsForRun(runId)).toEqual([
      { batchIndex: 0, artifactId: "y".repeat(8), sha256: "z".repeat(8), appVersion: "1.0.1.1" },
    ]);
    store.close();
    rmSync(path, { force: true });
  });

  // I2: SCHEMA is `CREATE TABLE IF NOT EXISTS` only, which never reconciles
  // an existing table's columns. Persistent DBs are a supported workflow
  // (priorSurvivorKeys history, runId monotonicity for BC app versioning),
  // so opening a pre-4.3 lethal.sqlite must not leave recordMutant throwing
  // "table mutants has no column named failure_note" mid-run.
  describe("failure_note migration (I2)", () => {
    /** The mutants/runs schema exactly as it stood before Layer 4.3 added failure_note. */
    const PRE_43_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  project_path TEXT NOT NULL,
  backend TEXT NOT NULL,
  app_version TEXT NOT NULL,
  batch_count INTEGER,
  baseline_green INTEGER
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
  duration_ms INTEGER NOT NULL
);
`;

    /**
     * R166 — opening an EXISTING lethal.sqlite must not throw.
     *
     * `procedure_name` joined the semantic identity, and the identity INDEX names it. The first
     * draft put that index in `SCHEMA`, which `new ResultsStore` runs BEFORE `migrate()` adds the
     * column — so every database created before R166 threw `no such column: procedure_name` from
     * inside the constructor, and because the constructor threw, its `Database` handle was never
     * closed and the file stayed locked. It surfaced as an EBUSY in an unrelated test's cleanup,
     * which is exactly how a constructor-thrown error hides.
     *
     * This asserts the open SUCCEEDS and the index ends up covering the column, so a future schema
     * change cannot quietly reintroduce the ordering bug.
     */
    test("a pre-R166 database opens, gains procedure_name, and gets an identity index covering it", () => {
      const dir = mkdtempSync(join(tmpdir(), "lethal-store-"));
      const dbPath = join(dir, "lethal.sqlite");
      try {
        const old = new Database(dbPath, { create: true });
        old.exec(PRE_43_SCHEMA);
        // The identity index as it stood before R166 — present, and WITHOUT the new column.
        old.exec(
          "CREATE INDEX idx_mutants_identity ON mutants(ast_hash, codeunit_name, operator_name, operator_major)",
        );
        old.close();

        const store = new ResultsStore(dbPath);
        const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
        store.recordMutant(runId, mutantRow("survived"));
        store.finishRun(runId, { batchCount: 1, baselineGreen: true });
        // The identity must round-trip through the new column, not silently key on the old tuple.
        expect(store.priorSurvivorKeys("/p")).toEqual(
          new Set(["abc123|Sample|Post|conditional-boundary|1"]),
        );
        store.close();

        const check = new Database(dbPath);
        const idx = check
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_mutants_identity'",
          )
          .get() as { sql: string | null };
        check.close();
        expect(idx.sql ?? "").toContain("procedure_name");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a pre-4.3 database is migrated on open and then accepts a failure_note write", () => {
      const dir = mkdtempSync(join(tmpdir(), "lethal-store-"));
      const dbPath = join(dir, "lethal.sqlite");
      try {
        // Create the database as a pre-4.3 LethAL would have left it.
        const old = new Database(dbPath, { create: true });
        old.exec(PRE_43_SCHEMA);
        old.close();

        // Opening with the current ResultsStore must add the column…
        const store = new ResultsStore(dbPath);
        const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
        // …so a write carrying failureNote no longer throws.
        const rowId = store.recordMutant(
          runId,
          mutantRow("error", { failureNote: "compile failed; bisected to mutant M0001" }),
        );
        store.close();

        const check = new Database(dbPath);
        const row = check.query("SELECT failure_note FROM mutants WHERE id = ?").get(rowId) as {
          failure_note: string | null;
        };
        check.close();
        expect(row.failure_note).toBe("compile failed; bisected to mutant M0001");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("recordMutant persists failure_note at the column level, NULL when absent", () => {
      // Direct column-level coverage (Task 6 Minor): read the value back out
      // of the column itself, not just through the absence of a throw.
      const dir = mkdtempSync(join(tmpdir(), "lethal-store-"));
      const dbPath = join(dir, "lethal.sqlite");
      try {
        const store = new ResultsStore(dbPath);
        const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
        const withNote = store.recordMutant(
          runId,
          mutantRow("error", { failureNote: "unstable test X: fails at baseline confirmation" }),
        );
        const withoutNote = store.recordMutant(
          runId,
          mutantRow("survived", { mutantCode: "M0002" }),
        );
        store.close();

        const check = new Database(dbPath);
        const rows = check
          .query("SELECT id, failure_note FROM mutants ORDER BY id")
          .all() as Array<{ id: number; failure_note: string | null }>;
        check.close();
        expect(rows).toEqual([
          { id: withNote, failure_note: "unstable test X: fails at baseline confirmation" },
          { id: withoutNote, failure_note: null },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("opening an already-migrated database is a no-op (idempotent)", () => {
      const dir = mkdtempSync(join(tmpdir(), "lethal-store-"));
      const dbPath = join(dir, "lethal.sqlite");
      try {
        new ResultsStore(dbPath).close();
        const store = new ResultsStore(dbPath); // second open must not throw on ALTER
        const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
        store.recordMutant(runId, mutantRow("killed"));
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Final whole-branch review Item 3: `mutantVerdicts` used to cast the `runner` column straight
  // to `RunnerKind` with no validation — a corrupt DB string would silently flow into
  // `executionContexts` grouping and `MutantOutcome.runner` instead of failing loudly.
  describe("runner column validation", () => {
    test("a NULL runner column maps to the documented default: absent, not thrown", () => {
      const store = new ResultsStore(":memory:");
      const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
      // No `runner` on the row — the pre-Task-5 shape every call site used before R69 Phase 2.
      store.recordMutant(runId, mutantRow("survived"));
      const verdicts = store.mutantVerdicts(runId);
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]?.runner).toBeUndefined();
      store.close();
    });

    test("a corrupt runner column value throws, naming the value and the mutant row", () => {
      const store = new ResultsStore(":memory:");
      const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
      store.recordMutant(runId, mutantRow("survived"));
      // No code path ever writes anything but "fenced" / "client-services" / NULL — simulate a
      // corrupt row directly, the way a hand-edited or foreign-tool-written DB could produce one.
      store.db.query("UPDATE mutants SET runner = ? WHERE run_id = ?").run("hub", runId);
      expect(() => store.mutantVerdicts(runId)).toThrow(
        /astHash=abc123.*codeunitName=Sample.*corrupt "runner" column value "hub"/,
      );
      store.close();
    });
  });
});
// C02-06: the five columns `lethal verify` reads, and the queries that read them.
describe("ResultsStore: what lethal verify reads (C02-06)", () => {
  const A0 = `${"0".repeat(31)}a`;
  const A1 = `${"0".repeat(31)}b`;

  function artifact(batchIndex: number, artifactId: string, over: Record<string, unknown> = {}) {
    return {
      batchIndex,
      appVersion: `1.0.1.${batchIndex}`,
      appId: APP,
      artifactId,
      sha256: String(batchIndex).repeat(64),
      manifestSha256: "c".repeat(64),
      ...over,
    };
  }

  test("recordArtifact stores the app path and batch dir, and artifactRecordById returns the batch, its run's highest batch and the source hash", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(
      runId,
      artifact(0, A0, { appPath: "C:/s/b0/x.app", instrumentedDir: "C:/s/b0" }),
    );
    store.recordArtifact(
      runId,
      artifact(1, A1, { appPath: "C:/s/b1/x.app", instrumentedDir: "C:/s/b1" }),
    );
    store.recordSourceHash(runId, "5".repeat(64));
    expect(store.artifactRecordById(A0)).toEqual({
      runId,
      projectPath: "P",
      batchIndex: 0,
      highestBatchIndex: 1,
      artifactSha256: "0".repeat(64),
      sourceSha256: "5".repeat(64),
      appPath: "C:/s/b0/x.app",
      instrumentedDir: "C:/s/b0",
    });
    expect(store.artifactRecordById(A1)?.batchIndex).toBe(1);
    expect(store.artifactRecordById(A1)?.highestBatchIndex).toBe(1);

    // Absent paths and no recorded source hash read back null, never a plausible default.
    const other = store.createRun({ projectPath: "Q", backend: "bcdev", appVersion: "0.0.0.0" });
    const a2 = `${"0".repeat(31)}c`;
    store.recordArtifact(other, artifact(0, a2));
    expect(store.artifactRecordById(a2)).toMatchObject({
      runId: other,
      highestBatchIndex: 0,
      sourceSha256: null,
      appPath: null,
      instrumentedDir: null,
    });
    store.close();
  });

  test("artifactRecordById is null for an unknown id", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runId, artifact(0, A0));
    expect(store.artifactRecordById(A1)).toBeNull();
    store.close();
  });

  test("artifactRecordById throws when the store records one id twice", () => {
    const store = new ResultsStore(":memory:");
    const r1 = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    const r2 = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(r1, artifact(0, A0));
    store.recordArtifact(r2, artifact(0, A0));
    expect(() => store.artifactRecordById(A0)).toThrow(/twice/);
    store.close();
  });

  test("a database from before C02-06 gains the five columns, and old rows read back null", () => {
    const path = join(tmpdir(), `lethal-store-c0206-${Date.now()}.sqlite`);
    const before = new ResultsStore(path);
    const runId = before.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    before.recordArtifact(runId, artifact(0, A0, { appPath: "x.app", instrumentedDir: "d" }));
    before.recordSourceHash(runId, "5".repeat(64));
    before.recordMutant(runId, mutantRow("survived", { carried: false, coveringTests: [] }));
    before.recordTestResult(runId, null, null, ref, "pass", 30, undefined, undefined, 7);
    before.close();
    // Take the database back to its pre-C02-06 shape: the five columns did not exist.
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE batch_artifacts DROP COLUMN app_path");
    legacy.exec("ALTER TABLE batch_artifacts DROP COLUMN instrumented_dir");
    legacy.exec("ALTER TABLE mutants DROP COLUMN carried");
    legacy.exec("ALTER TABLE runs DROP COLUMN source_sha256");
    legacy.exec("ALTER TABLE test_results DROP COLUMN codeunit_name");
    legacy.close();

    const store = new ResultsStore(path);
    expect(store.artifactRecordById(A0)).toMatchObject({
      runId,
      sourceSha256: null,
      appPath: null,
      instrumentedDir: null,
    });
    expect(store.batchMutantRows(runId, 0)).toEqual([
      { mutantCode: "M0001", verdict: "survived", coveringTests: [], carried: null },
    ]);
    expect(store.baselineTests(runId)).toEqual([
      { codeunitId: ref.codeunitId, codeunitName: null, method: ref.method },
    ]);
    // And the widened tables accept the new writes.
    store.recordMutant(
      runId,
      mutantRow("killed", { mutantCode: "M0002", carried: true, coveringTests: [] }),
    );
    store.recordTestResult(runId, null, null, { ...ref, method: "Other" }, "pass", 1);
    expect(store.batchMutantRows(runId, 0).map((r) => r.carried)).toEqual([null, true]);
    expect(store.baselineTests(runId).map((t) => t.codeunitName)).toEqual(["Sandbox Tests", null]);
    store.close();
    rmSync(path, { force: true });
  });

  test("batchMutantRows reads carried as true, false, or null", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordMutant(
      runId,
      mutantRow("survived", { carried: true, coveringTests: ["Sandbox Tests.A"] }),
    );
    store.recordMutant(
      runId,
      mutantRow("killed", { mutantCode: "M0002", carried: false, coveringTests: [] }),
    );
    store.recordMutant(runId, mutantRow("no-coverage", { mutantCode: "M0003", coveringTests: [] }));
    // Another batch's row is not this batch's.
    store.recordMutant(
      runId,
      mutantRow("survived", { batchIndex: 1, carried: false, coveringTests: [] }),
    );
    expect(store.batchMutantRows(runId, 0)).toEqual([
      {
        mutantCode: "M0001",
        verdict: "survived",
        coveringTests: ["Sandbox Tests.A"],
        carried: true,
      },
      { mutantCode: "M0002", verdict: "killed", coveringTests: [], carried: false },
      { mutantCode: "M0003", verdict: "no-coverage", coveringTests: [], carried: null },
    ]);
    store.close();
  });

  test("baselineTests reads only baseline rows, with their codeunit names", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    const other = { codeunitId: 79101, codeunitName: "Other Tests", method: "B" };
    store.recordTestResult(runId, null, null, ref, "pass", 1);
    store.recordTestResult(runId, null, null, ref, "pass", 1); // one method baselined twice
    store.recordTestResult(runId, null, null, other, "fail", 1);
    // A mutant's run of a method the baseline never ran is not a baseline row.
    const m = store.recordMutant(runId, mutantRow("killed"));
    store.recordTestResult(runId, m, "M0001", { ...ref, method: "OnlyUnderMutant" }, "fail", 1);
    const later = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordTestResult(later, null, null, { ...ref, method: "LaterRun" }, "pass", 1);
    expect(store.baselineTests(runId)).toEqual([
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" },
      { codeunitId: 79101, codeunitName: "Other Tests", method: "B" },
    ]);
    store.close();
  });

  test("sessionIdsOf returns every session id of a run and none of another's", () => {
    const store = new ResultsStore(":memory:");
    const a = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    const b = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordTestResult(a, null, null, ref, "pass", 1, undefined, undefined, 11);
    const m = store.recordMutant(a, mutantRow("killed"));
    store.recordTestResult(a, m, "M0001", ref, "fail", 1, "x", "many", 12);
    store.recordTestResult(a, null, null, ref, "timeout", 1); // no answer, no session id
    store.recordTestResult(b, null, null, ref, "pass", 1, undefined, undefined, 13);
    expect(store.sessionIdsOf(a)).toEqual(new Set([11, 12]));
    expect(store.sessionIdsOf(b)).toEqual(new Set([13]));
    store.close();
  });

  test("a verify run row is never found by findResumableRun, priorSurvivorKeys or artifactRecordById", () => {
    const store = new ResultsStore(":memory:");
    // Run A, shaped the way runSession writes one.
    const a = store.createRun({
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
      configFingerprint: "fp",
    });
    store.recordArtifact(a, artifact(0, A0, { appPath: "x.app", instrumentedDir: "d" }));
    store.recordMutant(a, mutantRow("survived", { carried: false, coveringTests: [] }));
    store.finishRun(a, { batchCount: 1, baselineGreen: true });
    const aKeys = store.priorSurvivorKeys("P");
    expect(aKeys.size).toBe(1);
    // Run B, the verify row, created exactly as decision 4 says.
    const b = store.createRun({
      projectPath: "P",
      backend: "lethal-verify",
      appVersion: "0.0.0.0",
    });
    store.recordMutant(b, mutantRow("survived", { astHash: "verify1", carried: false }));
    store.recordMutant(b, mutantRow("killed", { mutantCode: "M0002", astHash: "verify2" }));

    const query = {
      projectPath: "P",
      backend: "bcdev",
      configFingerprint: "fp",
      carryableVerdicts: [...CARRYABLE_VERDICTS],
    };
    expect(store.findResumableRun(query)).toBeNull();
    expect(store.priorSurvivorKeys("P")).toEqual(aKeys);
    expect(store.artifactRecordById(A0)?.runId).toBe(a);

    // Negative control: a row with A's backend and fingerprint and a survivor IS found, so the
    // null above is the verify row's exclusion, not a query that can find nothing.
    const c = store.createRun({
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
      configFingerprint: "fp",
    });
    store.recordMutant(c, mutantRow("survived", { astHash: "c1" }));
    expect(store.findResumableRun(query)).toBe(c);
    store.close();
  });
});
