// R759: `lethal verify` reads the source run's recorded --tests-only / --exclude-test from the
// store (`runs.test_narrowing`). The planVerify and runVerify tests are in verify.test.ts (they use
// its fixtures); runSession's write is in r745-exclude-test.test.ts; the schema pin is in
// schemas.test.ts. This file holds the store column and the CLI text.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { FLAG_OWNERS, parseCliConfig } from "../src/cli";
import { ResultsStore } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const base = {
  testScope: [],
  projectPath: "P",
  backend: "bcdev",
  appVersion: "1.0.0.0",
  identityScheme: IDENTITY_SCHEME,
  buildSymbols: [],
  coverageMode: "procedure",
} as const;

describe("R759 T4: the test_narrowing column", () => {
  test("a database from before R759 migrates; its run reads null, never an empty narrowing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-r759-"));
    dirs.push(dir);
    const path = join(dir, "old.sqlite");
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      project_path TEXT NOT NULL,
      backend TEXT NOT NULL,
      app_version TEXT NOT NULL
    );`);
    legacy.exec(
      "INSERT INTO runs (project_path, backend, app_version) VALUES ('P','bcdev','0.0.0.0')",
    );
    legacy.close();
    const store = new ResultsStore(path);
    expect(store.getRun(1)?.testNarrowing).toBeNull();
    store.close();
  });

  test("T8: a run created without narrowing reads null; one with it round-trips; a corrupt value throws", () => {
    const store = new ResultsStore(":memory:");
    const none = store.createRun(base);
    expect(store.getRun(none)?.testNarrowing).toBeNull();
    const narrowing = { testsOnly: ["Src/**"], excludeTests: ["7::A", "7::B"] };
    const id = store.createRun({ ...base, testNarrowing: narrowing });
    expect(store.getRun(id)?.testNarrowing).toEqual(narrowing);
    store.db.run("UPDATE runs SET test_narrowing = ? WHERE id = ?", [
      '{"testsOnly":"x","excludeTests":[]}',
      id,
    ]);
    expect(() => store.getRun(id)).toThrow(/corrupt "test_narrowing"/);
    store.db.run("UPDATE runs SET test_narrowing = '[]' WHERE id = ?", [id]);
    expect(() => store.getRun(id)).toThrow(/corrupt "test_narrowing"/);
    store.close();
  });
});

describe("R759 T6: lethal verify refuses the run flags and says where the narrowing comes from", () => {
  const VERIFY = ["verify", "--db", "d", "--artifact", "a".repeat(32), "--tests", "t"];
  for (const flag of ["--tests-only", "--exclude-test"]) {
    test(`${flag} is refused with the recorded-narrowing text`, () => {
      expect(() => parseCliConfig([...VERIFY, "--survivors", "0/M0001", flag, "x"])).toThrow(
        /applies the source run's own recorded/,
      );
    });
  }
  test("both stay owned by run alone", () => {
    for (const flag of ["tests-only", "exclude-test"]) {
      expect(FLAG_OWNERS.find((r) => r.flag === flag)?.owners).toEqual(["run"]);
    }
  });
});
