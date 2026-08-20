import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MutantVerdict, ResultsStore } from "../src/store";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

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
        appVersion: "1.0.1.1",
        appId: "x",
        artifactId: "y",
        sha256: "z",
      }),
    ).not.toThrow();
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
