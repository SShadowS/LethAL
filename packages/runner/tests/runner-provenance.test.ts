import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutantManifestEntry } from "@lethal/schemata";
import { REPORT_SCHEMA_VERSION, renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { buildResumeIndex } from "../src/resume";
import { ResultsStore } from "../src/store";
import type { MutantVerdictRow } from "../src/store";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R69 Phase 2 Task 5 — provenance through store, resume and report.
 *
 * Today `buildReport` asserts, unconditionally, for EVERY authoritative run, that every verdict
 * describes a `GuiAllowed=No, ClientType=ODataV4` session. The client-services path (Task 6) is
 * `GuiAllowed=Yes, ClientType=Web`, measured separately (R69) — the moment ONE verdict comes from
 * it, the old blanket claim is false. This file pins: (1) each mutant row now carries which runner
 * produced it; (2) the report's execution-context field becomes an array of contexts ACTUALLY used;
 * (3) a verdict CARRIED across `--resume` keeps its runner and contributes its own context, tagged
 * as carried rather than silently reading as this run's own fenced measurement — the "resume hole"
 * this task closes (see resume.ts `CarriedVerdict.runner`).
 */

const CAPS_AUTHORITATIVE = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
} as const;

function entry(over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId: "M0001",
    file: "src/A.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: "hash",
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "Original();",
    mutatedText: "",
    ...over,
  };
}

function build(outcomes: SessionOutcome[], over: Record<string, unknown> = {}) {
  return legacyBuildReport({
    caps: CAPS_AUTHORITATIVE,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
    ...over,
  });
}

describe("REPORT_SCHEMA_VERSION (R69 Phase 2 Task 5)", () => {
  test("is bumped to 2 — executionContext -> executionContexts is not backward compatible", () => {
    expect(REPORT_SCHEMA_VERSION).toBe(2);
  });
});

describe("per-mutant runner provenance", () => {
  test("a routed (client-services) verdict carries its runner on the mutant row", () => {
    const outcomes: SessionOutcome[] = [
      { mutant: entry(), verdict: "killed", batchIndex: 0, runner: "client-services" },
    ];
    const r = build(outcomes);
    expect(r.mutants[0]?.runner).toBe("client-services");
  });

  test("an outcome with no runner set defaults to fenced — every path that predates R69 Phase 2", () => {
    const outcomes: SessionOutcome[] = [{ mutant: entry(), verdict: "killed", batchIndex: 0 }];
    const r = build(outcomes);
    expect(r.mutants[0]?.runner).toBe("fenced");
  });
});

describe("validity.executionContexts (R69 Phase 2)", () => {
  test("a fenced-only run reports exactly one fenced context, measured", () => {
    const outcomes: SessionOutcome[] = [
      { mutant: entry(), verdict: "killed", batchIndex: 0 },
      { mutant: entry({ mutantId: "M0002" }), verdict: "survived", batchIndex: 0 },
    ];
    const r = build(outcomes);
    expect(r.validity.executionContexts).toHaveLength(1);
    const [ctx] = r.validity.executionContexts;
    expect(ctx?.runner).toBe("fenced");
    expect(ctx?.guiAllowed).toBe(false);
    expect(ctx?.clientType).toBe("ODataV4");
    expect(ctx?.basis).toContain("measured");
    expect(ctx?.verdictCount).toBe(2);
  });

  test("a client-services verdict measured THIS run gets its own GuiAllowed=Yes context", () => {
    const outcomes: SessionOutcome[] = [
      { mutant: entry(), verdict: "killed", batchIndex: 0, runner: "client-services" },
    ];
    const r = build(outcomes);
    const ctx = r.validity.executionContexts.find((c) => c.runner === "client-services");
    expect(ctx).toBeDefined();
    expect(ctx?.guiAllowed).toBe(true);
    expect(ctx?.clientType).toBe("Web");
    expect(ctx?.verdictCount).toBe(1);
  });

  // The load-bearing case. Without this, a carried interactive verdict would silently vanish into
  // the fenced-only context this run itself measured — exactly the drift the hardcoded
  // `guiAllowed: false` literal used to prevent today by accident.
  test("a carried interactive verdict contributes its own context to the report", () => {
    const outcomes: SessionOutcome[] = [
      { mutant: entry(), verdict: "killed", batchIndex: 0 }, // this run measured this one, fenced
      {
        mutant: entry({ mutantId: "M0002" }),
        verdict: "killed",
        batchIndex: 0,
        runner: "client-services",
        carried: true,
      },
    ];
    const r = build(outcomes, {
      resumedFrom: { runId: 7, carriedMutants: 1, skippedStranded: 0 },
    });
    const contexts = r.validity.executionContexts;
    expect(contexts.map((c) => c.runner)).toContain("client-services");
    const carriedCtx = contexts.find((c) => c.runner === "client-services");
    expect(carriedCtx?.basis).toContain("carried");
    expect(carriedCtx?.basis).toContain("7");
    expect(carriedCtx?.verdictCount).toBe(1);
    // And the context this run DID measure itself is still separately present, un-conflated.
    const fencedCtx = contexts.find((c) => c.runner === "fenced");
    expect(fencedCtx).toBeDefined();
    expect(fencedCtx?.basis).not.toContain("carried");
    expect(fencedCtx?.verdictCount).toBe(1);
  });

  test("present even on a run with zero outcomes — a property of the backend, not a per-run measurement", () => {
    const r = build([]);
    expect(r.validity.executionContexts.length).toBeGreaterThan(0);
    expect(r.validity.executionContexts[0]?.runner).toBe("fenced");
  });
});

// Review fix, round 1: `buildExecutionContexts` legitimately emits TWO "fenced" entries on an
// ordinary `--resume` run that both carries some prior fenced verdicts AND freshly measures other
// mutants on that same fenced path — no client-services involvement required. `renderConsole` used
// to read only the FIRST match (`.find`), so the printed "NON-GUI EXECUTION: N verdict(s)" silently
// undercounted whichever group came second. This pins the fix: the printed total must be the SUM
// across every context sharing a runner, not just one of them.
describe("renderConsole aggregates ALL contexts sharing a runner (resume undercount fix)", () => {
  test("a fresh-fenced + carried-fenced report prints the SUMMED verdict count, not just one group's", () => {
    const outcomes: SessionOutcome[] = [
      { mutant: entry(), verdict: "killed", batchIndex: 0 }, // fresh, fenced, not carried
      { mutant: entry({ mutantId: "M0002" }), verdict: "survived", batchIndex: 0 }, // fresh, fenced
      {
        mutant: entry({ mutantId: "M0003" }),
        verdict: "killed",
        batchIndex: 0,
        carried: true, // carried, fenced too (no runner override — carried verdicts default fenced)
      },
    ];
    const r = build(outcomes, {
      resumedFrom: { runId: 3, carriedMutants: 1, skippedStranded: 0 },
    });
    // The underlying array is correct: two DISTINCT fenced entries, 2 + 1.
    const fencedEntries = r.validity.executionContexts.filter((c) => c.runner === "fenced");
    expect(fencedEntries).toHaveLength(2);
    expect(fencedEntries.reduce((n, c) => n + c.verdictCount, 0)).toBe(3);

    const text = renderConsole(r);
    const line = text.split("\n").find((l) => l.startsWith("NON-GUI EXECUTION"));
    expect(line).toBeDefined();
    // The printed count must be the SUM (3), not one group's count (2 or 1) — this is the bug the
    // review caught: a `.find()` silently reported only the first-seen group.
    expect(line).toContain("NON-GUI EXECUTION: 3 verdict(s)");
    // And the basis must name BOTH groups (or otherwise state that some were carried) — a single
    // basis string describing only one group would reintroduce the same problem one level down.
    expect(line).toContain("carried");
  });
});

describe("ResultsStore runner provenance (R69 Phase 2 Task 5)", () => {
  function mutantRow(over: Record<string, unknown> = {}) {
    return {
      mutantCode: "M0001",
      astHash: "abc123",
      codeunitName: "Sample",
      procedureName: "P",
      operatorName: "conditional-boundary",
      operatorMajor: 1,
      file: "Sample.Codeunit.al",
      line: 12,
      verdict: "killed" as const,
      durationMs: 40,
      batchIndex: 0,
      ...over,
    };
  }

  test("recordMutant persists runner at the column level, NULL when absent", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
    const withRunner = store.recordMutant(runId, mutantRow({ runner: "client-services" }));
    const withoutRunner = store.recordMutant(
      runId,
      mutantRow({ mutantCode: "M0002", astHash: "def" }),
    );
    const rows = store.db.query("SELECT id, runner FROM mutants ORDER BY id").all() as Array<{
      id: number;
      runner: string | null;
    }>;
    expect(rows).toEqual([
      { id: withRunner, runner: "client-services" },
      { id: withoutRunner, runner: null },
    ]);
    store.close();
  });

  test("mutantVerdicts reads the runner back, and omits it when NULL", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
    store.recordMutant(runId, mutantRow({ runner: "client-services" }));
    store.recordMutant(runId, mutantRow({ mutantCode: "M0002", astHash: "def" }));
    const verdicts = store.mutantVerdicts(runId);
    expect(verdicts.find((v) => v.astHash === "abc123")?.runner).toBe("client-services");
    expect(verdicts.find((v) => v.astHash === "def")?.runner).toBeUndefined();
    store.close();
  });

  test("migrates a pre-runner-column database and then accepts a runner write", () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-store-runner-"));
    const dbPath = join(dir, "lethal.sqlite");
    try {
      /** The mutants/runs schema exactly as it stood before R69 Phase 2 Task 5 added `runner`. */
      const PRE_RUNNER_SCHEMA = `
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
`;
      const old = new Database(dbPath, { create: true });
      old.exec(PRE_RUNNER_SCHEMA);
      old.close();

      const store = new ResultsStore(dbPath);
      const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
      const rowId = store.recordMutant(runId, mutantRow({ runner: "client-services" }));
      store.close();

      const check = new Database(dbPath);
      const row = check.query("SELECT runner FROM mutants WHERE id = ?").get(rowId) as {
        runner: string | null;
      };
      check.close();
      expect(row.runner).toBe("client-services");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("opening an already-migrated (runner-having) database is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-store-runner-"));
    const dbPath = join(dir, "lethal.sqlite");
    try {
      new ResultsStore(dbPath).close();
      const store = new ResultsStore(dbPath); // second open must not throw on ALTER
      const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
      store.recordMutant(runId, mutantRow());
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildResumeIndex carries runner (R69 Phase 2 — the resume hole)", () => {
  function row(over: Partial<MutantVerdictRow> = {}): MutantVerdictRow {
    return {
      astHash: "hash-a",
      codeunitName: "Sandbox Logic",
      procedureName: "P",
      operatorName: "lethal.negate-conditional",
      identityOrdinal: 0,
      operatorMajor: 1,
      verdict: "killed",
      durationMs: 42,
      ...over,
    };
  }

  test("a client-services verdict's runner tag survives into the carried verdict", () => {
    const index = buildResumeIndex([row({ runner: "client-services" })]);
    const [carried] = [...index.carryable.values()];
    expect(carried?.runner).toBe("client-services");
  });

  test("a row with no runner tag carries as undefined — the reader defaults it to fenced, never to a false claim", () => {
    const index = buildResumeIndex([row()]);
    const [carried] = [...index.carryable.values()];
    expect(carried?.runner).toBeUndefined();
  });
});
