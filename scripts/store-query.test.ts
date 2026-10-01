import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultsStore } from "../packages/runner/src/store";
import {
  StoreQueryError,
  latestRunId,
  openReadonly,
  resolveRun,
  runsReport,
  testsReport,
  verdictsReport,
} from "./store-query.ts";

const mutant = (code: string, verdict: "killed" | "survived", killingTest?: string) => ({
  mutantCode: code,
  astHash: `h${code}`,
  codeunitName: "Sandbox Logic",
  procedureName: "Clamp",
  operatorName: "lethal.return-value",
  operatorMajor: 1,
  file: "src/Logic.txt",
  line: 10,
  verdict,
  durationMs: 5,
  batchIndex: 0,
  ...(killingTest !== undefined ? { killingTest } : {}),
});

/** Built with the store's own class, so the schema is the real one. Runs 1 and 2 finish; 3 does not. */
function buildStore(): string {
  const path = join(mkdtempSync(join(tmpdir(), "store-query-")), "lethal.sqlite");
  const store = new ResultsStore(path);
  const newRun = () =>
    store.createRun({
      projectPath: "fixtures/sandbox-app",
      backend: "bcdev",
      appVersion: "1.0.0.0",
      identityScheme: 1,
      buildSymbols: [],
      coverageMode: "procedure",
    });
  const ref = { codeunitId: 50100, codeunitName: "Logic Tests", method: "ClampWorks" };
  for (let i = 0; i < 2; i += 1) {
    const run = newRun();
    const row = store.recordMutant(run, mutant("M0001", "killed", "ClampWorks"));
    store.recordMutant(run, mutant("M0002", i === 0 ? "killed" : "survived"));
    store.recordTestResult(run, null, null, ref, "pass", 3);
    store.recordTestResult(run, row, "M0001", ref, "fail", 3, "boom");
    store.finishRun(run, { batchCount: 1, baselineGreen: true });
  }
  store.recordMutant(newRun(), mutant("M0001", "survived"));
  store.close();
  return path;
}

// Every handle is closed after its test: an open SQLite file cannot be removed on Windows (EBUSY),
// and the test preload removes its temp dir at the end.
const handles: Database[] = [];
function open(path: string): Database {
  const db = openReadonly(path);
  handles.push(db);
  return db;
}
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

describe("store-query", () => {
  test("latest run is the highest FINISHED id; a newer unfinished one is reported, not chosen", () => {
    const db = open(buildStore());
    expect(latestRunId(db)).toEqual({ id: 2, newerUnfinished: [3] });
    expect(resolveRun(db, "latest")).toBe(2);
    expect(resolveRun(db, "3")).toBe(3);
    expect(() => resolveRun(db, "9")).toThrow(/no run 9/);
    expect(() => resolveRun(db, "newest")).toThrow(StoreQueryError);
  });

  test("the database is opened read-only", () => {
    const db = open(buildStore());
    expect(() => db.exec("DELETE FROM runs")).toThrow(/readonly/i);
  });

  test("verdicts, tests and runs for a run", () => {
    const db = open(buildStore());
    expect(verdictsReport(db, 2)).toBe(
      [
        "run 2: 2 mutants, killed 1 / survived 1",
        "  0/M0001 killed lethal.return-value Sandbox Logic.Clamp src/Logic.txt:10 killed by ClampWorks",
        "  0/M0002 survived lethal.return-value Sandbox Logic.Clamp src/Logic.txt:10",
      ].join("\n"),
    );
    expect(testsReport(db, 2)).toBe("run 2: 1 tests\n  Logic Tests.ClampWorks: fail 1 / pass 1");
    const runs = runsReport(db).split("\n");
    expect(runs).toHaveLength(3);
    expect(runs[2]).toContain("UNFINISHED");
  });

  test("an empty store or a run with no rows is refused, not printed as zero", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-query-")), "empty.sqlite");
    new ResultsStore(path).close();
    const db = open(path);
    expect(() => latestRunId(db)).toThrow(/no finished run/);
    expect(() => runsReport(db)).toThrow(/no runs/);
    expect(() => testsReport(open(buildStore()), 3)).toThrow(/no test results/);
    expect(() => openReadonly(join(tmpdir(), "does-not-exist.sqlite"))).toThrow(StoreQueryError);
  });
});
