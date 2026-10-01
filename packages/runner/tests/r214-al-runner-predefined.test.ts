import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { printDryRun } from "../src/cli";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import { AL_RUNNER_PREDEFINED_SYMBOLS, predefinedSymbolsHint } from "../src/preprocessor-symbols";
import { ResultsStore } from "../src/store";

/**
 * R214 revise finding 3 (R377): al-runner 2.12.0 predefines CLEANSCHEMA1..CLEANSCHEMA25 when it
 * compiles a project; alc predefines nothing. An al-runner run must enumerate and record under
 * that set, and a bcdev run must not.
 */

// The `Helper` call sites: line 6 is in the `#if not CLEANSCHEMA25` arm (al-runner compiles it
// out), line 8 in its `#else` (al-runner builds it), line 11 in the `#if CLEANSCHEMA26` control
// (neither builds it). Only `void-method-call` mutants are compared: one per call site.
const SOURCE = `codeunit 50013 "CS Probe"
{
    procedure Run(X: Integer)
    begin
#if not CLEANSCHEMA25
        Helper(X);
#else
        Helper(X + 1);
#endif
#if CLEANSCHEMA26
        Helper(X - 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;

const TEST_AL = `codeunit 50140 "CS Tests"
{
    Subtype = Test;

    [Test]
    procedure RunTest()
    begin
    end;
}
`;

const VOID_CALL = "lethal.void-method-call";
const CLEANSCHEMA_1_TO_25 = Array.from({ length: 25 }, (_, i) => `CLEANSCHEMA${i + 1}`).sort();

class StubBackend implements ExecutionBackend {
  private active: string | null = null;
  constructor(private readonly authoritative: boolean) {}
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      authoritative: this.authoritative,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(this.active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 50013, procedure: "Run" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

beforeAll(async () => {
  await initParser();
});

async function withProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r377-"));
  try {
    await Bun.write(
      join(root, "app", "app.json"),
      JSON.stringify({
        id: "11111111-2222-3333-4444-555555555555",
        name: "p",
        publisher: "x",
        version: "1.0.0.0",
      }),
    );
    await Bun.write(join(root, "app", "src", "Probe.Codeunit.al"), SOURCE);
    await Bun.write(join(root, "tests", "CsTests.Codeunit.al"), TEST_AL);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const session = (root: string, store: ResultsStore, authoritative: boolean) =>
  runSession({
    backend: new StubBackend(authoritative),
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, authoritative ? "instr-bc" : "instr-ar"),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
  });

const linesOf = (report: Awaited<ReturnType<typeof session>>) =>
  report.mutants
    .filter((m) => m.operatorName === VOID_CALL)
    .map((m) => m.line)
    .sort((a, b) => a - b);

describe("R377: al-runner's predefined CLEANSCHEMA1..25", () => {
  test("the constant is exactly CLEANSCHEMA1..CLEANSCHEMA25", () => {
    expect([...AL_RUNNER_PREDEFINED_SYMBOLS].sort()).toEqual(CLEANSCHEMA_1_TO_25);
  });

  test("predefinedSymbolsHint fires only when the sets differ by exactly the predefines", () => {
    const hint = " (al-runner predefines CLEANSCHEMA1..CLEANSCHEMA25, R377)";
    const p = AL_RUNNER_PREDEFINED_SYMBOLS;
    expect(predefinedSymbolsHint([], p)).toBe(hint);
    expect(predefinedSymbolsHint([...p, "X"], ["X"])).toBe(hint);
    expect(predefinedSymbolsHint(["X"], p)).toBe("");
    expect(predefinedSymbolsHint(["X"], ["Y"])).toBe("");
    expect(predefinedSymbolsHint(null, p)).toBe("");
  });

  test("an al-runner run builds only al-runner's arms and records its set; bcdev keeps alc's", async () => {
    await withProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const ar = await session(root, store, false);
      expect(linesOf(ar)).toEqual([8]);
      const arRow = store.getRun(1);
      expect(arRow?.backend).toBe("al-runner");
      expect(arRow?.buildSymbols).toEqual(CLEANSCHEMA_1_TO_25);
      expect(arRow?.buildSymbols).not.toContain("CLEANSCHEMA26");
      const out = (ar.excludedSites?.files ?? []).find((f) => f.reason === "compiled-out");
      expect(out?.detail).toBe(`symbols: ${CLEANSCHEMA_1_TO_25.join(", ")}`);

      const bc = await session(root, store, true);
      expect(linesOf(bc)).toEqual([6]);
      const bcRow = store.getRun(2);
      expect(bcRow?.backend).toBe("bcdev");
      expect(bcRow?.buildSymbols).toEqual([]);

      // History: the latest finished (bcdev) run is not history for an al-runner build. The stub
      // reads no test app, so both rows get one hash here, leaving the symbols as the only
      // difference `priorSurvivorKeys` can refuse on; the bcdev set is the control.
      const db = (
        store as unknown as {
          db: { run(sql: string): void; query(sql: string): { get(): unknown } };
        }
      ).db;
      const natural = db.query("SELECT test_app_hash AS h FROM runs WHERE id = 2").get() as {
        h: string | null;
      };
      db.run("UPDATE runs SET test_app_hash = 'same-test-app'");
      const refusedOnSymbols = (symbols: readonly string[]) => {
        let changed = false;
        store.priorSurvivorKeys(join(root, "app"), "procedure", "same-test-app", symbols, {
          symbolsChanged: () => {
            changed = true;
          },
        });
        return changed;
      };
      expect([refusedOnSymbols(CLEANSCHEMA_1_TO_25), refusedOnSymbols([])]).toEqual([true, false]);

      // The history warning names the al-runner predefines when they are the whole difference.
      // Put run 2's own test-app hash back, so the symbols are the only thing the session can refuse on.
      db.run(`UPDATE runs SET test_app_hash = ${natural.h === null ? "NULL" : `'${natural.h}'`}`);
      const events: RunEvent[] = [];
      await runSession({
        backend: new StubBackend(false),
        store,
        projectDir: join(root, "app"),
        testDir: join(root, "tests"),
        instrumentedDir: join(root, "instr-ar"),
        selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
        skipKnownSurvivors: true,
        emit: [(e) => events.push(e)],
      });
      const warned = events.find(
        (e) => e.type === "warning" && e.code === "history-build-symbols-changed",
      );
      expect(warned && "message" in warned ? warned.message : "").toMatch(
        /was built with preprocessor symbols \(none\), and this build uses CLEANSCHEMA1,.*\(al-runner predefines CLEANSCHEMA1\.\.CLEANSCHEMA25, R377\)\. /,
      );
      store.close();
    });
  }, 60_000);

  test("--dry-run --backend al-runner lists al-runner's arms; without it, alc's", async () => {
    await withProject(async (root) => {
      const listing = async (backendKind?: "al-runner" | "bcdev") => {
        const outPath = join(root, `dry-${backendKind ?? "none"}.json`);
        await printDryRun(join(root, "app"), undefined, {
          dbPath: join(root, "none.sqlite"),
          configPath: join(root, "none.json"),
          outPath,
          ...(backendKind !== undefined ? { backendKind } : {}),
        });
        const j = JSON.parse(await readFile(outPath, "utf8")) as {
          batches: { sites: { line: number; operator: string }[] }[];
        };
        return j.batches
          .flatMap((b) => b.sites)
          .filter((s) => s.operator === VOID_CALL)
          .map((s) => s.line)
          .sort((a, b) => a - b);
      };
      expect(await listing("al-runner")).toEqual([8]);
      expect(await listing(undefined)).toEqual([6]);
      expect(await listing("bcdev")).toEqual([6]);
    });
  }, 60_000);

  // printDryRun is called directly above, so it cannot see main() drop `--backend` on the way.
  test("`lethal run --dry-run --backend al-runner` through main() lists al-runner's arm", async () => {
    await withProject(async (root) => {
      const outPath = join(root, "dry-main.json");
      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const proc = Bun.spawn(
        [
          "bun",
          cli,
          "run",
          "--project",
          join(root, "app"),
          "--dry-run",
          "--backend",
          "al-runner",
          "--db",
          join(root, "lethal.sqlite"),
          "--out",
          outPath,
        ],
        { stdout: "pipe", stderr: "pipe", env: process.env },
      );
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
      const j = JSON.parse(await readFile(outPath, "utf8")) as {
        batches: { sites: { line: number; operator: string }[] }[];
      };
      const lines = j.batches
        .flatMap((b) => b.sites)
        .filter((s) => s.operator === VOID_CALL)
        .map((s) => s.line);
      expect(lines).toEqual([8]);
    });
  }, 60_000);
});
