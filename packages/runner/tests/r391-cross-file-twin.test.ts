import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initParser } from "@lethal/engine";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { generateMutationSet, runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";

/**
 * R391: an identity key carries no file. Twins (one identity tuple: here a table and a codeunit
 * both named "Twin", each with `X := X + 1;` in `Bump`, since the tuple reads the object NAME) are
 * told apart by their run-wide ordinal alone, so an edit that removes one twin renumbers the
 * others and a key-only carry hands a verdict to another mutant: history skips it as a known
 * survivor, and `--resume` can carry a `killed` onto a mutant nobody measured.
 *
 * A recorded verdict now carries only when (rule 1) the recorded run's generation-time source hash
 * equals this run's, or (rule 2) the mutant's (file, tuple) is a singleton in its file in BOTH runs,
 * the recorded side read from the run's `twin_tuples` column (never from its rows), and then it is
 * matched on (tuple, file) rather than on the key.
 *
 * The stub backend decides each mutant by the ACTIVE MUTANT'S file and line (read from the
 * deployed manifest), never by deploy count, so batching cannot decide a result.
 */

/** Table lines: statement i is on line 13 + i. */
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
  name: "R391 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 50299 }],
});

const selectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };
const OP = "lethal.remove-assignment";
const TWIN = "X := X + 1;";
const A = "A_Twin.Table.al";
const B = "B_Twin.Codeunit.al";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

type Outcome = "pass" | "fail" | "abort";

/**
 * Decides each mutant from `<file basename>:<line>` of the ACTIVE mutant, looked up in the manifest
 * of the batch last deployed; anything unlisted passes (survives). `abort` answers in-flight-unknown,
 * which quarantines the run and leaves it unfinished, so `--resume` can find it.
 */
class SiteBackend implements ExecutionBackend {
  private active: MutantManifestEntry | null = null;
  private byId = new Map<string, MutantManifestEntry>();
  /** `<file basename>:<line>` of every mutant activated, so a test can tell "ran" from "carried". */
  readonly activated: string[] = [];
  constructor(private readonly outcomes: Readonly<Record<string, Outcome>>) {}
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
  const root = await mkdtemp(join(tmpdir(), "lethal-r391-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, A), TABLE_AL(a));
  await Bun.write(join(projectDir, B), CODEUNIT_AL(b));
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "TwinTests.Codeunit.al"), TEST_AL);
  return {
    dirs: { projectDir, testDir, instrumentedDir },
    dbPath: join(root, "lethal.sqlite"),
    writeA: (s: readonly string[]) => Bun.write(join(projectDir, A), TABLE_AL(s)),
    writeB: (s: readonly string[]) => Bun.write(join(projectDir, B), CODEUNIT_AL(s)),
  };
}

/** `<file> @<line> <verdict>` of every remove-assignment mutant. */
function rows(r: SessionReport): string[] {
  return r.mutants
    .filter((m) => m.operatorName === OP)
    .map((m) => `${m.file} @${m.line} ${m.verdict}`)
    .sort();
}

/** The same, for file B only. */
function rowsB(r: SessionReport): string[] {
  return rows(r).filter((x) => x.startsWith(B));
}

function refusedWarnings(events: readonly RunEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === "warning" && e.code === "carry-refused-renumbered" ? [e.message] : [],
  );
}

describe("R391: a recorded verdict carries only under rule 1 or rule 2", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("history, two files: removing the table's twin does not let the codeunit's mutant inherit `survived`", async () => {
    const p = await project([TWIN], [TWIN]);
    const store = new ResultsStore(":memory:");
    const outcomes = { [`${B}:8`]: "fail" } as const;
    const first = await runSession({
      backend: new SiteBackend(outcomes),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rows(first)).toEqual([`${A} @13 survived`, `${B} @8 killed`]);

    await p.writeA(["X := 2;"]);
    const second = await runSession({
      backend: new SiteBackend(outcomes),
      store,
      ...p.dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(rows(second)).toEqual([`${A} @13 survived`, `${B} @8 killed`]);
  });

  test("history, three twins (A one, B two): an edit in A moves no verdict onto B's twins", async () => {
    const p = await project([TWIN], [TWIN, TWIN]);
    const store = new ResultsStore(":memory:");
    const outcomes = { [`${B}:9`]: "fail" } as const;
    const first = await runSession({
      backend: new SiteBackend(outcomes),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rows(first)).toEqual([`${A} @13 survived`, `${B} @8 survived`, `${B} @9 killed`]);

    await p.writeA(["X := 2;"]);
    const second = await runSession({
      backend: new SiteBackend(outcomes),
      store,
      ...p.dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    // Key-only, B@9 takes B@8's old key and is skipped as a survivor although it is killed.
    expect(rows(second)).toEqual([`${A} @13 survived`, `${B} @8 survived`, `${B} @9 killed`]);
  });

  test("resume, three twins: after an edit in A no `killed` is carried onto B's other twin", async () => {
    const p = await project([TWIN], [TWIN, TWIN]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail", [`${B}:9`]: "abort" }),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rows(first)).toEqual([`${A} @13 survived`, `${B} @8 killed`, `${B} @9 error`]);

    await p.writeA(["X := 2;"]);
    const events: RunEvent[] = [];
    const second = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail" }),
      store,
      ...p.dirs,
      selectorIds,
      resume: "last",
      emit: [(e) => events.push(e)],
    });
    expect(second.resumedFrom?.runId).toBeDefined();
    // Key-only, B@8 carries A's `survived` and B@9 carries B@8's `killed`: a false kill.
    expect(rows(second)).toEqual([`${A} @13 survived`, `${B} @8 killed`, `${B} @9 survived`]);
    // Refused carries are counted in ONE warning for the session.
    const warned = refusedWarnings(events);
    expect(warned.length).toBe(1);
    expect(warned[0]).toMatch(/R391/);
  });

  test("resume, same file: deleting twin 0 (recorded killed) does not hand `killed` to twin 1", async () => {
    const p = await project(["X := 2;"], [TWIN, TWIN]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail", [`${B}:9`]: "abort" }),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rowsB(first)).toEqual([`${B} @8 killed`, `${B} @9 error`]);

    await p.writeB([TWIN]);
    const second = await runSession({
      backend: new SiteBackend({}),
      store,
      ...p.dirs,
      selectorIds,
      resume: "last",
    });
    expect(rowsB(second)).toEqual([`${B} @8 survived`]);
  });

  test("resume, partial rows: twin 1 never got a row; deleting twin 0 still makes twin 1 run", async () => {
    // The run dies on `Y := 5;`, between the twins, so only twin 0 is recorded. Counted from the
    // run's ROWS the tuple looks like a singleton in B; the run's `twin_tuples` says it is not.
    const p = await project(["X := 2;"], [TWIN, "Y := 5;", TWIN]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail", [`${B}:9`]: "abort" }),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rowsB(first)).toEqual([`${B} @8 killed`, `${B} @9 error`]);

    await p.writeB(["Y := 5;", TWIN]);
    const second = await runSession({
      backend: new SiteBackend({}),
      store,
      ...p.dirs,
      selectorIds,
      resume: "last",
    });
    // `Y := 5;` stranded the tier and stays skipped (key-matched); the twin runs and survives.
    expect(rowsB(second)).toEqual([`${B} @8 error`, `${B} @9 survived`]);
  });

  test("resume, insertion: a killed singleton gains a same-file twin; neither twin inherits `killed`", async () => {
    // Sol's post-merge review of R-391: the recorded run says A's tuple is a singleton in A, so only
    // THIS run's twin facts (`!current.twins.has(site)` in `carryRecord`) can refuse the carry.
    const p = await project([TWIN], ["Y := 5;"]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SiteBackend({ [`${A}:13`]: "fail", [`${B}:8`]: "abort" }),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rows(first)).toEqual([`${A} @13 killed`, `${B} @8 error`]);

    await p.writeA([TWIN, TWIN]);
    // Everything would SURVIVE if executed, so a `killed` on either twin can only be carried.
    const second = await runSession({
      backend: new SiteBackend({}),
      store,
      ...p.dirs,
      selectorIds,
      resume: "last",
    });
    expect(second.resumedFrom?.runId).toBeDefined();
    expect(rows(second).filter((x) => x.startsWith(A))).toEqual([
      `${A} @13 survived`,
      `${A} @14 survived`,
    ]);
  });

  test("history, undercount: a killed twin beside a survived twin is still a twin", async () => {
    // Counted from the SURVIVOR rows (all history reads) B's tuple has one row: a singleton.
    const p = await project(["X := 2;"], [TWIN, TWIN]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SiteBackend({ [`${B}:9`]: "fail" }),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rowsB(first)).toEqual([`${B} @8 survived`, `${B} @9 killed`]);

    await p.writeB([TWIN]);
    const second = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail" }),
      store,
      ...p.dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(rowsB(second)).toEqual([`${B} @8 killed`]);
  });

  test("history, a statement moved to another file does not take the old file's verdict", async () => {
    const p = await project([TWIN], ["Y := 7;"]);
    const store = new ResultsStore(":memory:");
    const outcomes = { [`${B}:8`]: "fail", [`${B}:9`]: "fail" } as const;
    const first = await runSession({
      backend: new SiteBackend(outcomes),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rows(first)).toEqual([`${A} @13 survived`, `${B} @8 killed`]);

    // The twin moves from A to B: one site of the tuple run-wide on both sides, in another file.
    await p.writeA(["X := 2;"]);
    await p.writeB(["Y := 7;", TWIN]);
    const second = await runSession({
      backend: new SiteBackend(outcomes),
      store,
      ...p.dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(rows(second)).toEqual([`${A} @13 survived`, `${B} @8 killed`, `${B} @9 killed`]);
  });

  test("control: a singleton carries across an unrelated edit (rule 2), and `[]` is recorded, not NULL", async () => {
    const p = await project([TWIN], ["Y := 7;"]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail" }),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rows(first)).toEqual([`${A} @13 survived`, `${B} @8 killed`]);
    const run1 = store.db.query("SELECT id FROM runs ORDER BY id LIMIT 1").get() as { id: number };
    expect(store.getRun(run1.id)?.twinTuples).toEqual([]);

    await p.writeB(["Y := 8;"]);
    const second = await runSession({
      backend: new SiteBackend({ [`${A}:13`]: "fail", [`${B}:8`]: "fail" }),
      store,
      ...p.dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(rows(second)).toEqual([`${A} @13 known-survivor`, `${B} @8 killed`]);
  });

  test("control: with no edit, same-file twins carry under rule 1 (history)", async () => {
    const p = await project(["X := 2;"], [TWIN, TWIN]);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SiteBackend({}),
      store,
      ...p.dirs,
      selectorIds,
    });
    expect(rowsB(first)).toEqual([`${B} @8 survived`, `${B} @9 survived`]);

    const second = await runSession({
      backend: new SiteBackend({ [`${B}:8`]: "fail", [`${B}:9`]: "fail" }),
      store,
      ...p.dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(rowsB(second)).toEqual([`${B} @8 known-survivor`, `${B} @9 known-survivor`]);
  });

  test("control: an interrupted run (no source_sha256) resumed with no edit carries its same-file twins under rule 1", async () => {
    // A (batch 0) holds the twins and dies on `Y := 5;`; B is batch 1 and is never prepared, so
    // the run records no `source_sha256`. Only `generation_source_sha256` can say "same source".
    const p = await project([TWIN, TWIN, "Y := 5;"], ["Y := 7;"]);
    const store = new ResultsStore(":memory:");
    const set = await generateMutationSet(p.dirs.projectDir, { emit: () => {} });
    const maxGuardsPerBatch = set.files.find((f) => f.path.endsWith(A))?.specs.length;
    if (maxGuardsPerBatch === undefined) throw new Error("A produced no specs");
    const first = await runSession({
      backend: new SiteBackend({ [`${A}:13`]: "fail", [`${A}:15`]: "abort" }),
      store,
      ...p.dirs,
      selectorIds,
      maxGuardsPerBatch,
    });
    expect(rows(first)).toEqual([`${A} @13 killed`, `${A} @14 survived`, `${A} @15 error`]);
    const run1 = store.db
      .query("SELECT id, source_sha256, generation_source_sha256 FROM runs ORDER BY id LIMIT 1")
      .get() as { id: number; source_sha256: string | null; generation_source_sha256: string };
    expect(run1.source_sha256).toBeNull();
    expect(run1.generation_source_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Everything would SURVIVE if executed, so a `killed` on A@13 can only be the carried verdict.
    const second = await runSession({
      backend: new SiteBackend({}),
      store,
      ...p.dirs,
      selectorIds,
      maxGuardsPerBatch,
      resume: "last",
    });
    expect(second.resumedFrom?.runId).toBe(run1.id);
    expect(rows(second)).toEqual([
      `${A} @13 killed`,
      `${A} @14 survived`,
      `${A} @15 error`,
      `${B} @8 survived`,
    ]);
  });

  test("NULL columns: a run with no generation hash and no twin_tuples carries nothing", async () => {
    const p = await project(["X := 2;"], [TWIN]);
    // A file-backed store must be closed before afterAll deletes its folder: on Windows an open
    // SQLite file cannot be removed (EBUSY), which leaks the temp folder (R358).
    const store = new ResultsStore(p.dbPath);
    try {
      const first = await runSession({
        backend: new SiteBackend({}),
        store,
        ...p.dirs,
        selectorIds,
      });
      expect(rows(first)).toEqual([`${A} @13 survived`, `${B} @8 survived`]);
      const db = new Database(p.dbPath);
      db.run("UPDATE runs SET generation_source_sha256 = NULL, twin_tuples = NULL");
      db.close();

      const second = await runSession({
        backend: new SiteBackend({ [`${A}:13`]: "fail", [`${B}:8`]: "fail" }),
        store,
        ...p.dirs,
        selectorIds,
        skipKnownSurvivors: true,
      });
      expect(rows(second)).toEqual([`${A} @13 killed`, `${B} @8 killed`]);
    } finally {
      store.close();
    }
  });

  test("NULL vs []: a NULL hash with `[]` twin_tuples still carries a singleton under rule 2", async () => {
    const p = await project(["X := 2;"], [TWIN]);
    const store = new ResultsStore(p.dbPath);
    try {
      await runSession({ backend: new SiteBackend({}), store, ...p.dirs, selectorIds });
      const db = new Database(p.dbPath);
      db.run("UPDATE runs SET generation_source_sha256 = NULL");
      db.close();

      const second = await runSession({
        backend: new SiteBackend({ [`${A}:13`]: "fail", [`${B}:8`]: "fail" }),
        store,
        ...p.dirs,
        selectorIds,
        skipKnownSurvivors: true,
      });
      expect(rows(second)).toEqual([`${A} @13 known-survivor`, `${B} @8 known-survivor`]);
    } finally {
      store.close();
    }
  });

  test("R475: resuming unchanged source under another host collation carries no `killed` onto an unmeasured twin", async () => {
    // Twins in `Aa_…` and `Z_…`: "en" and code unit put `Aa` first, Danish puts it after `Z`
    // (`aa` is `å`). Discovery and batching are code-unit ordered, so Aa EXECUTES first. Run 1
    // kills Aa's twin and aborts on an unrelated sentinel (`Y := 5;`, its own tuple) in the same
    // file, so Z's twin (batch 1) is never prepared: it is not stranded, just unmeasured.
    const AA = "Aa_Twin.Table.al";
    const Z = "Z_Twin.Codeunit.al";
    const root = await mkdtemp(join(tmpdir(), "lethal-r475-"));
    roots.push(root);
    const dirs = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
    await Bun.write(join(dirs.projectDir, AA), TABLE_AL([TWIN, "Y := 5;"]));
    await Bun.write(join(dirs.projectDir, Z), CODEUNIT_AL([TWIN]));
    await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
    await Bun.write(join(dirs.testDir, "TwinTests.Codeunit.al"), TEST_AL);
    const set = await generateMutationSet(dirs.projectDir, { emit: () => {} });
    const maxGuardsPerBatch = set.files.find((f) => f.path.endsWith(AA))?.specs.length;
    if (maxGuardsPerBatch === undefined) throw new Error("Aa produced no specs");
    const store = new ResultsStore(":memory:");
    const twinRows = (r: SessionReport) =>
      rows(r).filter((x) => x.startsWith(`${AA} @13`) || x.startsWith(Z));

    // Pin the host collation per run: every `localeCompare` without a locale collates as `host`.
    // Run 1 is an "en" host and run 2 a Danish one, whatever this machine's default is.
    const original = String.prototype.localeCompare;
    const onHost = async <T>(host: string, run: () => Promise<T>): Promise<T> => {
      String.prototype.localeCompare = function (
        this: string,
        that: string,
        locales?: string | string[],
        options?: Intl.CollatorOptions,
      ): number {
        return original.call(this, that, locales ?? host, options);
      };
      try {
        return await run();
      } finally {
        String.prototype.localeCompare = original;
      }
    };

    const first = await onHost("en", async () => {
      expect(["Aa", "Z"].sort((a, b) => a.localeCompare(b))).toEqual(["Aa", "Z"]);
      return runSession({
        backend: new SiteBackend({ [`${AA}:13`]: "fail", [`${AA}:14`]: "abort" }),
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch,
      });
    });
    expect(twinRows(first)).toEqual([`${AA} @13 killed`]);

    const backend = new SiteBackend({});
    const second = await onHost("da", async () => {
      expect(["Aa", "Z"].sort((a, b) => a.localeCompare(b))).toEqual(["Z", "Aa"]);
      return runSession({
        backend,
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch,
        resume: "last",
      });
    });
    const hashes = store.db
      .query("SELECT generation_source_sha256 AS h FROM runs ORDER BY id")
      .all() as { h: string }[];
    expect(hashes).toHaveLength(2);
    expect(hashes[0]?.h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]?.h).toBe(hashes[0]?.h ?? "");
    // Aa's kill carries (rule 1: same source); Z's twin is MEASURED, and survives.
    expect(twinRows(second)).toEqual([`${AA} @13 killed`, `${Z} @8 survived`]);
    expect(backend.activated).toContain(`${Z}:8`);
    expect(backend.activated).not.toContain(`${AA}:13`);
  });

  test("store: createRun leaves twin_tuples NULL; setTwinTuples([]) records `[]`, distinct from NULL", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({
      projectPath: "/p",
      backend: "stub",
      appVersion: "1.0.0.0",
      identityScheme: 1,
      buildSymbols: [],
      coverageMode: "procedure",
      generationSourceSha256: "a".repeat(64),
    });
    expect(store.getRun(runId)?.twinTuples).toBeNull();
    expect(store.getRun(runId)?.generationSourceSha256).toBe("a".repeat(64));
    store.setTwinTuples(runId, []);
    expect(store.getRun(runId)?.twinTuples).toEqual([]);
    store.setTwinTuples(runId, ["f.al\0t"]);
    expect(store.getRun(runId)?.twinTuples).toEqual(["f.al\0t"]);
    const bare = store.createRun({
      projectPath: "/p",
      backend: "stub",
      appVersion: "1.0.0.0",
      identityScheme: 1,
      buildSymbols: [],
      coverageMode: "procedure",
    });
    expect(store.getRun(bare)?.generationSourceSha256).toBeNull();
  });
});
