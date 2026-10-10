import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  type MutantManifestEntry,
  identityTupleOf,
} from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { carryRecord, memberSiteOf, twinSiteOf } from "../src/selection";
import { ResultsStore } from "../src/store";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R474 (sol, review of R-391's plan): rule 2 matched a mutant on (file, tuple) alone, so `exit(1);`
 * inserted before an unchanged `X := X + 1;` left its key and site unchanged and the old `killed`
 * carried onto a mutant that is now unreachable. Rule 2 now also requires the enclosing member's
 * raw-text hash (`memberHash`) to be equal. Same fixture shape and stub backend as
 * r391-cross-file-twin.test.ts: a mutant's result is decided by its file and line.
 */

const TABLE_AL = (stmts: readonly string[]) => `table 50100 "Twin"
{
    fields
    {
        field(1; Id; Integer) { }
    }

    procedure Bump(): Integer
    var
        X: Integer;
        Y: Integer;
    begin
${stmts.map((s) => `        ${s}`).join("\n")}
        exit(X);
    end;
}
`;

/** Codeunit lines: statement i is on line 8 + i. */
const CODEUNIT_AL = (stmts: readonly string[]) => `codeunit 50100 "Twin"
{
    procedure Bump(): Integer
    var
        X: Integer;
        Y: Integer;
    begin
${stmts.map((s) => `        ${s}`).join("\n")}
        exit(X);
    end;
}
`;

const TEST_AL = `codeunit 50200 "Twin Tests"
{
    Subtype = Test;

    [Test]
    procedure BumpWorks()
    begin
    end;
}
`;

const APP_JSON = JSON.stringify({
  id: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5a91",
  name: "R474 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 50299 }],
});

const selectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };
const OP = "lethal.remove-assignment";
const S = "X := X + 1;";
const A = "A_Twin.Table.al";
const B = "B_Twin.Codeunit.al";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) removeScratchDir(r);
});

type Outcome = "pass" | "fail" | "abort";

class SiteBackend implements ExecutionBackend {
  private active: MutantManifestEntry | null = null;
  private byId = new Map<string, MutantManifestEntry>();
  readonly activated: string[] = [];
  constructor(private readonly outcomes: Readonly<Record<string, Outcome>>) {}
  // R495: a served test app, installed, so the run's identity is proven (as a real bcdev's is).
  private readonly testApp = servesTestApp();
  fetchPublishedAppPackage = this.testApp.fetchPublishedAppPackage;
  microsoftMode = this.testApp.microsoftMode;
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(instrumentedDir: string): Promise<CompiledArtifact | null> {
    const manifest = JSON.parse(
      await readFile(join(instrumentedDir, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
    this.byId = new Map(manifest.mutants.map((m) => [m.mutantId, m]));
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    if (id === null) {
      this.active = null;
      return;
    }
    const m = this.byId.get(id);
    if (m === undefined) throw new Error(`SiteBackend: ${id} is not in the deployed manifest`);
    this.active = m;
    this.activated.push(`${basename(m.file)}:${m.startLine}`);
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure",
          entries: [
            { objectType: "Table", objectId: 50100, procedure: "Bump" },
            { objectType: "Table", objectId: 50100, procedure: "OnInsert" },
            { objectType: "Codeunit", objectId: 50100, procedure: "Bump" },
          ],
        },
      };
    }
    const outcome =
      this.outcomes[`${basename(this.active.file)}:${this.active.startLine}`] ?? "pass";
    if (outcome === "abort") {
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    }
    return {
      ref,
      outcome,
      durationMs: 5,
      ...(outcome === "fail" ? { failureMessage: "killed" } : {}),
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

async function project(a: readonly string[], b: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "lethal-r474-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, A), TABLE_AL(a));
  await Bun.write(join(projectDir, B), CODEUNIT_AL(b));
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "TwinTests.Codeunit.al"), TEST_AL);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  return {
    dirs: { projectDir, testDir, instrumentedDir },
    dbPath: join(root, "lethal.sqlite"),
    writeA: (s: readonly string[]) => Bun.write(join(projectDir, A), TABLE_AL(s)),
    writeB: (s: readonly string[]) => Bun.write(join(projectDir, B), CODEUNIT_AL(s)),
  };
}

const rowsB = (r: SessionReport): string[] =>
  r.mutants
    .filter((m) => m.operatorName === OP && m.file.endsWith(B))
    .map((m) => `${m.file} @${m.line} ${m.verdict}`)
    .sort();

/** Run 1 on `[S, "Y := 5;"]` in B: S killed, the run dies on `Y := 5;`, so it can be resumed. */
async function interrupted(store: ResultsStore, p: Awaited<ReturnType<typeof project>>) {
  const first = await runSession({
    backend: new SiteBackend({ [`${B}:8`]: "fail", [`${B}:9`]: "abort" }),
    store,
    ...p.dirs,
    selectorIds,
  });
  expect(rowsB(first)).toEqual([`${B} @8 killed`, `${B} @9 error`]);
}

const nullMemberHashes = (dbPath: string): void => {
  const db = new Database(dbPath);
  db.run("UPDATE mutants SET member_hash = NULL");
  db.close();
};

describe("R474: rule 2 carries only into an unchanged enclosing member", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("sol's sequence: `exit(1);` inserted before an unchanged S makes S run, not carry `killed`", async () => {
    const p = await project(["X := 2;"], [S, "Y := 5;"]);
    const store = new ResultsStore(":memory:");
    await interrupted(store, p);
    await p.writeB(["exit(1);", S, "Y := 5;"]);
    const backend = new SiteBackend({});
    const second = await runSession({ backend, store, ...p.dirs, selectorIds, resume: "last" });
    expect(second.resumedFrom?.runId).toBeDefined();
    // S is now on line 9. Key-only and (file, tuple) both carry run 1's `killed` here. `Y := 5;`
    // stranded run 1, so it is skipped as `error` by key (R53), which is not a verdict.
    expect(rowsB(second)).toEqual([`${B} @10 error`, `${B} @9 survived`]);
    expect(backend.activated).toContain(`${B}:9`);
  });

  test("history: removing the `exit(1);` that hid S does not skip S as a known survivor", async () => {
    const p = await project(["X := 2;"], ["exit(1);", S]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({ backend: new SiteBackend({}), store, ...p.dirs, selectorIds });
    expect(rowsB(first)).toEqual([`${B} @9 survived`]);
    await p.writeB([S]);
    const second = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail" }),
      store,
      ...p.dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(rowsB(second)).toEqual([`${B} @8 killed`]);
  });

  test("control: an edit in ANOTHER member leaves B's unchanged procedure carrying `killed` (rule 2)", async () => {
    const p = await project(["X := 2;"], [S, "Y := 5;"]);
    const store = new ResultsStore(":memory:");
    await interrupted(store, p);
    await p.writeA(["X := 3;"]);
    const backend = new SiteBackend({});
    const second = await runSession({ backend, store, ...p.dirs, selectorIds, resume: "last" });
    expect(rowsB(second)).toEqual([`${B} @8 killed`, `${B} @9 error`]);
    expect(backend.activated).not.toContain(`${B}:8`);
  });

  test("rule 1 untouched: no edit, rows with no member hash (pre-R474) still carry by key", async () => {
    const p = await project(["X := 2;"], [S, "Y := 5;"]);
    const store = new ResultsStore(p.dbPath);
    try {
      await interrupted(store, p);
      nullMemberHashes(p.dbPath);
      const second = await runSession({
        backend: new SiteBackend({}),
        store,
        ...p.dirs,
        selectorIds,
        resume: "last",
      });
      expect(rowsB(second)).toEqual([`${B} @8 killed`, `${B} @9 error`]);
    } finally {
      store.close();
    }
  });

  // One file, one member, before and after an edit that leaves S's own text alone. Run 1 kills S
  // and dies on `Y := 5;` in the same member; the resume must RUN S (every mutant survives then).
  const CTX = "C_Ctx.Codeunit.al";
  const lineOf = (text: string, stmt: string): number =>
    text.split("\n").findIndex((l) => l.includes(stmt)) + 1;
  async function contextCase(file: string, before: string, after: string) {
    const root = await mkdtemp(join(tmpdir(), "lethal-r474-"));
    roots.push(root);
    const dirs = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
    await Bun.write(join(dirs.projectDir, file), before);
    await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
    await Bun.write(join(dirs.testDir, "TwinTests.Codeunit.al"), TEST_AL);
    await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
    const store = new ResultsStore(":memory:");
    const sRow = (r: SessionReport, line: number) =>
      r.mutants
        .filter((m) => m.operatorName === OP && m.file.endsWith(file) && m.line === line)
        .map((m) => m.verdict);
    const first = await runSession({
      backend: new SiteBackend({
        [`${file}:${lineOf(before, S)}`]: "fail",
        [`${file}:${lineOf(before, "Y := 5;")}`]: "abort",
      }),
      store,
      ...dirs,
      selectorIds,
    });
    expect(sRow(first, lineOf(before, S))).toEqual(["killed"]);
    await Bun.write(join(dirs.projectDir, file), after);
    const backend = new SiteBackend({});
    const second = await runSession({ backend, store, ...dirs, selectorIds, resume: "last" });
    expect(second.resumedFrom?.runId).toBeDefined();
    expect(sRow(second, lineOf(after, S))).toEqual(["survived"]);
    expect(backend.activated).toContain(`${file}:${lineOf(after, S)}`);
  }

  const GLOBALS = (g: string) => `codeunit 50100 "Twin"
{
    var
        GA: Boolean;
        GB: Boolean;

    procedure Bump(): Integer
    var
        X: Integer;
        Y: Integer;
    begin
        if ${g} then
            exit(1);
        ${S}
        Y := 5;
        exit(X);
    end;
}
`;
  test("a global swapped in the guard (GA -> GB) changes the member hash: S runs", async () => {
    await contextCase(CTX, GLOBALS("GA"), GLOBALS("GB"));
  });

  const RECEIVER = (r: string) => `codeunit 50100 "Twin"
{
    var
        ServiceA: Codeunit "Twin Service";
        ServiceB: Codeunit "Twin Service";

    procedure Bump(): Integer
    var
        X: Integer;
        Y: Integer;
    begin
        if ${r}.Done() then
            exit(1);
        ${S}
        Y := 5;
        exit(X);
    end;
}
`;
  test("a receiver swapped (ServiceA.Done -> ServiceB.Done) changes the member hash: S runs", async () => {
    await contextCase(CTX, RECEIVER("ServiceA"), RECEIVER("ServiceB"));
  });

  const SUBSCRIBER = (event: string, wrapped: boolean) => `codeunit 50100 "Twin"
{
${wrapped ? "#if not CLEAN24\n" : ""}    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", '${event}', '', false, false)]
${wrapped ? "#endif\n" : ""}    procedure Bump(): Integer
    var
        X: Integer;
        Y: Integer;
    begin
        ${S}
        Y := 5;
        exit(X);
    end;
}
`;
  test("an [EventSubscriber] retargeted to another event changes the member hash: S runs", async () => {
    await contextCase(CTX, SUBSCRIBER("OnAfterA", false), SUBSCRIBER("OnAfterB", false));
  });

  test("the same retarget inside an attribute-only `#if` wrapper: S runs", async () => {
    await contextCase(CTX, SUBSCRIBER("OnAfterA", true), SUBSCRIBER("OnAfterB", true));
  });

  const TRIGGER = (guard: string) => `table 50100 "Twin"
{
    fields
    {
        field(1; Id; Integer) { }
    }

    trigger OnInsert()
    var
        X: Integer;
        Y: Integer;
    begin
${guard}        ${S}
        Y := 5;
    end;
}
`;
  test("a trigger member: `exit;` inserted before S in OnInsert: S runs", async () => {
    await contextCase("T_Twin.Table.al", TRIGGER(""), TRIGGER("        exit;\n"));
  });

  test("history: NULL member_hash still skips a survivor with no edit (rule 1), not after an edit elsewhere (rule 2)", async () => {
    const p = await project(["X := 2;"], [S]);
    const store = new ResultsStore(p.dbPath);
    try {
      await runSession({ backend: new SiteBackend({}), store, ...p.dirs, selectorIds });
      nullMemberHashes(p.dbPath);
      const opts = { store, ...p.dirs, selectorIds, skipKnownSurvivors: true };
      const same = await runSession({ backend: new SiteBackend({ [`${B}:8`]: "fail" }), ...opts });
      expect(rowsB(same)).toEqual([`${B} @8 known-survivor`]);
      // The second run recorded member hashes; null them again so only NULL rows can carry.
      nullMemberHashes(p.dbPath);
      await p.writeA(["X := 3;"]);
      const edited = await runSession({
        backend: new SiteBackend({ [`${B}:8`]: "fail" }),
        ...opts,
      });
      expect(rowsB(edited)).toEqual([`${B} @8 killed`]);
    } finally {
      store.close();
    }
  });

  test("migration: a database from before the column gains it as NULL; rule 1 carries, rule 2 does not", async () => {
    const p = await project(["X := 2;"], [S, "Y := 5;"]);
    const first = new ResultsStore(p.dbPath);
    await interrupted(first, p);
    first.close();
    // A real pre-R474 file: the column is gone, not merely NULL.
    const legacy = new Database(p.dbPath);
    legacy.exec("ALTER TABLE mutants DROP COLUMN member_hash");
    legacy.close();
    const store = new ResultsStore(p.dbPath);
    try {
      const cols = store.db.query("PRAGMA table_info(mutants)").all() as { name: string }[];
      expect(cols.some((c) => c.name === "member_hash")).toBe(true);
      const counts = store.db
        .query("SELECT COUNT(*) AS n, COUNT(member_hash) AS hashed FROM mutants")
        .get() as { n: number; hashed: number };
      expect(counts.n).toBeGreaterThan(0);
      expect(counts.hashed).toBe(0);
      // Rule 1: no edit, the NULL rows still carry by key.
      const same = await runSession({
        backend: new SiteBackend({}),
        store,
        ...p.dirs,
        selectorIds,
        resume: "last",
      });
      expect(rowsB(same)).toEqual([`${B} @8 killed`, `${B} @9 error`]);
    } finally {
      store.close();
    }
  });

  test("migration, rule 2: after an edit elsewhere a migrated NULL row carries nothing (fails closed)", async () => {
    const p = await project(["X := 2;"], [S, "Y := 5;"]);
    const first = new ResultsStore(p.dbPath);
    await interrupted(first, p);
    first.close();
    const legacy = new Database(p.dbPath);
    legacy.exec("ALTER TABLE mutants DROP COLUMN member_hash");
    legacy.close();
    const store = new ResultsStore(p.dbPath);
    try {
      await p.writeA(["X := 3;"]);
      const second = await runSession({
        backend: new SiteBackend({}),
        store,
        ...p.dirs,
        selectorIds,
        resume: "last",
      });
      expect(rowsB(second)).toEqual([`${B} @8 survived`, `${B} @9 error`]);
    } finally {
      store.close();
    }
  });

  test("a manifest entry without memberHash carries nothing under rule 2, and records NULL", () => {
    const m: MutantManifestEntry = {
      mutantId: "M0001",
      file: B,
      startIndex: 0,
      endIndex: 1,
      startLine: 8,
      operatorName: OP,
      operatorVersion: "1.0.0",
      astHash: "h",
      objectType: "Codeunit",
      codeunitId: 50100,
      codeunitName: "Twin",
      procedureName: "Bump",
      originalText: S,
      mutatedText: "",
    };
    const site = twinSiteOf(m.file, identityTupleOf(m));
    // Every lookup a hash could be guessed into answers, so only the absence can refuse.
    const lookedUp: string[] = [];
    const answer = (s: string) => {
      lookedUp.push(s);
      return "carried";
    };
    const refused = new Set<string>();
    expect(
      carryRecord(
        m,
        { hash: "old", twins: new Set() },
        { hash: "new", twins: new Set(), refused },
        answer,
        answer,
      ),
    ).toBeUndefined();
    expect(lookedUp.some((s) => s.startsWith(site))).toBe(false);
    expect(refused.size).toBe(1);
    // Control: the same entry WITH a hash carries through the member site.
    expect(
      carryRecord(
        { ...m, memberHash: "x" },
        { hash: "old", twins: new Set() },
        { hash: "new", twins: new Set(), refused: new Set() },
        () => undefined,
        (s) => (s === memberSiteOf(site, "x") ? "carried" : undefined),
      ),
    ).toBe("carried");
    const store = new ResultsStore(":memory:");
    const run = store.createRun({
      projectPath: "p",
      backend: "b",
      appVersion: "1",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      coverageMode: "procedure",
    });
    store.recordMutant(run, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "Twin",
      procedureName: "Bump",
      operatorName: OP,
      operatorMajor: 1,
      file: B,
      line: 8,
      verdict: "killed",
      durationMs: 1,
      batchIndex: 0,
    });
    expect(store.mutantVerdicts(run).map((r) => r.memberHash)).toEqual([null]);
    store.close();
  });

  test('a fresh run records each mutant\'s member hash, one per member, and "" never for a member', async () => {
    const p = await project(["X := 2;"], [S, "Y := 5;"]);
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new SiteBackend({}), store, ...p.dirs, selectorIds });
    const rows = store.db
      .query("SELECT file, member_hash FROM mutants WHERE procedure_name = 'Bump'")
      .all() as Array<{ file: string; member_hash: string | null }>;
    expect(rows.length).toBeGreaterThan(2);
    for (const r of rows) expect(r.member_hash).toMatch(/^[0-9a-f]{64}$/);
    // One member per file here: every mutant of a file shares its hash, the two files differ.
    const byFile = new Map<string, Set<string | null>>();
    for (const r of rows) byFile.set(r.file, (byFile.get(r.file) ?? new Set()).add(r.member_hash));
    expect([...byFile.values()].map((s) => s.size)).toEqual([1, 1]);
    store.close();
  });
});
