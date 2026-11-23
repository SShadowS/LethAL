// PR-392 (R1199; docs/superpowers/specs/2026-11-23-pr392-snapshot-payload-format.md): an R192 baseline snapshot written
// before PR-387 (no `payload_format`) is never reused, so a hub row without `bodyNeverRan` cannot hide a not-run test.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { ResultsStore, SNAPSHOT_PAYLOAD_FORMAT } from "../src/store";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function storeWithSnapshot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-pr392-"));
  dirs.push(dir);
  const path = join(dir, "lethal.sqlite");
  const store = new ResultsStore(path);
  const id = store.createRun({
    testScope: [],
    coverageMode: "procedure",
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: [],
    projectPath: "/p",
    backend: "bcdev",
    appVersion: "1",
    testAppHash: "package:t",
    testAppProven: true,
    testAppDeps: "D",
  });
  const ref = { codeunitId: 79100, codeunitName: "Tests", method: "A" };
  store.recordBaselineSnapshot({
    runId: id,
    batchIndex: 0,
    batchHash: "b0",
    testAppHash: "package:t",
    baseline: [{ ref, verdict: { ref, outcome: "pass", durationMs: 1 } }],
  });
  store.close();
  return path;
}

const setFormat = (path: string, value: number | null): void => {
  const db = new Database(path);
  db.query("UPDATE baseline_snapshots SET payload_format = ?").run(value);
  db.close();
};

const found = (path: string): boolean => {
  const store = new ResultsStore(path);
  const hit = store.findBaselineSnapshot("b0", "package:t", "D", "procedure") !== null;
  store.close();
  return hit;
};

describe("PR-392: the snapshot payload format", () => {
  test("a snapshot recorded now carries the current format and is found", async () => {
    const path = await storeWithSnapshot();
    const db = new Database(path);
    const row = db.query("SELECT payload_format AS f FROM baseline_snapshots").get() as {
      f: number | null;
    };
    db.close();
    expect(row.f).toBe(SNAPSHOT_PAYLOAD_FORMAT);
    expect(found(path)).toBe(true);
  });

  test("a snapshot with no format (written before PR-392) is not found; given the format, it is (control)", async () => {
    const path = await storeWithSnapshot();
    setFormat(path, null);
    expect(found(path)).toBe(false);
    setFormat(path, SNAPSHOT_PAYLOAD_FORMAT);
    expect(found(path)).toBe(true);
  });

  test("a store that lacks the column gains it on open, and a second open adds nothing", async () => {
    const path = await storeWithSnapshot();
    const db = new Database(path);
    db.exec("ALTER TABLE baseline_snapshots DROP COLUMN payload_format");
    db.close();
    const cols = (): string[] => {
      const d = new Database(path);
      const names = (
        d.query("PRAGMA table_info(baseline_snapshots)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      d.close();
      return names;
    };
    expect(cols()).not.toContain("payload_format");
    new ResultsStore(path).close();
    expect(cols().filter((c) => c === "payload_format")).toHaveLength(1);
    new ResultsStore(path).close();
    expect(cols().filter((c) => c === "payload_format")).toHaveLength(1);
    // The old row reads NULL after the migration, so it is not reused.
    expect(found(path)).toBe(false);
  });
});
