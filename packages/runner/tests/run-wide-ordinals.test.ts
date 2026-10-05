import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  runIdentityOrdinals,
  writeInstrumentedProject,
} from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  planArtifacts,
  runSession,
} from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { sessionFingerprint } from "../src/resume";
import { serializeKey } from "../src/selection";
import { ResultsStore } from "../src/store";

/**
 * R374: identity ordinals are numbered once over the whole RUN, never per batch. Before, twins in
 * two batches both took ordinal 0 and shared one key, so `--skip-known-survivors` could skip one
 * twin on the other's verdict.
 *
 * The twins are a table and a codeunit both named "Twin", each with a procedure `Bump` holding the
 * statement `X := X + 1;`: the identity tuple reads the object NAME (not its kind), so the three
 * statements below are one tuple.
 */

const TABLE_AL = `table 50100 "Twin"
{
    fields
    {
        field(1; Id; Integer) { }
    }

    procedure Bump(): Integer
    var
        X: Integer;
    begin
        X := X + 1;
        exit(X);
    end;
}
`;

/** Two twin statements (lines 6 and 7) in one procedure. */
const CODEUNIT_TWO_AL = `codeunit 50100 "Twin"
{
    procedure Bump(): Integer
    var
        X: Integer;
    begin
        X := X + 1;
        X := X + 1;
        exit(X);
    end;
}
`;

/** One twin statement (line 7). */
const CODEUNIT_ONE_AL = `codeunit 50100 "Twin"
{
    procedure Bump(): Integer
    var
        X: Integer;
    begin
        X := X + 1;
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
  id: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5a70",
  name: "Twin Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 50299 }],
});

const selectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };
const OP = "lethal.remove-assignment";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function makeProject(codeunit: string) {
  const root = await mkdtemp(join(tmpdir(), "lethal-r374-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  // `A_` sorts first, so the table is the lowest-numbered twin in source order.
  await Bun.write(join(projectDir, "A_Twin.Table.al"), TABLE_AL);
  await Bun.write(join(projectDir, "B_Twin.Codeunit.al"), codeunit);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "TwinTests.Codeunit.al"), TEST_AL);
  return { root, projectDir, testDir, instrumentedDir };
}

/** The guard budget that puts the table alone in batch 0 and the codeunit in batch 1. */
function tableAloneBudget(files: readonly { path: string; specs: readonly unknown[] }[]): number {
  const codeunit = files.find((f) => f.path.endsWith("B_Twin.Codeunit.al"));
  if (codeunit === undefined) throw new Error("the codeunit file produced no specs");
  return codeunit.specs.length;
}

describe("R374: identity ordinals are numbered over the whole run", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("(a) the table alone in batch 0, the two codeunit twins in batch 1: ordinals 0, 1, 2", async () => {
    const { root, projectDir } = await makeProject(CODEUNIT_TWO_AL);
    const set = await generateMutationSet(projectDir, { emit: () => {} });
    const batches = planArtifacts(set.files, {
      maxGuardsPerBatch: tableAloneBudget(set.files),
      emit: () => {},
    });
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([
      ["A_Twin.Table.al"],
      ["B_Twin.Codeunit.al"],
    ]);
    const rows: string[] = [];
    for (const [i, batch] of batches.entries()) {
      const dir = join(root, `batch-${i}`);
      await writeInstrumentedProject({
        targetDir: dir,
        files: batch,
        identityOrdinals: identityOrdinalsOf(set),
        selectorIds,
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5a70",
        operatorTiers,
      });
      const m = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;
      for (const e of m.mutants.filter((x) => x.operatorName === OP)) {
        rows.push(`${i} ${e.file} @${e.startLine} ordinal ${e.identityOrdinal}`);
      }
    }
    expect(rows).toEqual([
      "0 A_Twin.Table.al @12 ordinal 0",
      "1 B_Twin.Codeunit.al @7 ordinal 1",
      "1 B_Twin.Codeunit.al @8 ordinal 2",
    ]);
  });
});

/**
 * Passes every baseline test with coverage of both `Bump`s. With a mutant active, the test FAILS
 * only in the batch whose number is in `killBatches` (deploys are counted from 0), so the table's
 * twin survives and the codeunit's twin is killed. `abortInBatch` returns an in-flight-unknown
 * error there instead, which quarantines the run and leaves it unfinished (resumable).
 */
class TwinBackend implements ExecutionBackend {
  private active: string | null = null;
  private deploys = -1;
  constructor(
    private readonly killBatches: ReadonlySet<number>,
    private readonly abortInBatch?: number,
  ) {}
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
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
    if (this.deploys === this.abortInBatch) {
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
      outcome: this.killBatches.has(this.deploys) ? "fail" : "pass",
      durationMs: 5,
      ...(this.killBatches.has(this.deploys) ? { failureMessage: "killed" } : {}),
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

type Mutant = SessionReport["mutants"][number];

function keyOf(m: Mutant): string {
  return serializeKey({
    astHash: m.astHash,
    codeunitName: m.codeunitName,
    procedureName: m.procedureName ?? "",
    operatorName: m.operatorName,
    operatorMajor: m.operatorMajor,
    ordinal: m.identityOrdinal ?? 0,
  });
}

/** `<file>:<line> <verdict>` of the two twins' remove-assignment mutants. */
function twins(r: SessionReport): string[] {
  return r.mutants
    .filter((m) => m.operatorName === OP)
    .map((m) => `${m.file} @${m.line} ${m.verdict}`)
    .sort();
}

async function twinBudget(projectDir: string): Promise<number> {
  const set = await generateMutationSet(projectDir, { emit: () => {} });
  return tableAloneBudget(set.files);
}

describe("R374: --skip-known-survivors never skips a twin on the other twin's verdict", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("(b) twins in two batches get distinct keys, and the killed twin runs again", async () => {
    const dirs = await makeProject(CODEUNIT_ONE_AL);
    const maxGuardsPerBatch = await twinBudget(dirs.projectDir);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new TwinBackend(new Set([1])),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch,
    });
    expect(twins(first)).toEqual(["A_Twin.Table.al @12 survived", "B_Twin.Codeunit.al @7 killed"]);
    const [table, codeunit] = [...first.mutants.filter((m) => m.operatorName === OP)].sort((a, b) =>
      a.file.localeCompare(b.file),
    );
    if (table === undefined || codeunit === undefined) throw new Error("expected both twins");
    expect(keyOf(codeunit)).not.toBe(keyOf(table));
    expect([table.identityOrdinal ?? 0, codeunit.identityOrdinal ?? 0]).toEqual([0, 1]);

    const second = await runSession({
      backend: new TwinBackend(new Set([1])),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch,
      skipKnownSurvivors: true,
    });
    expect(twins(second)).toEqual([
      "A_Twin.Table.al @12 known-survivor",
      "B_Twin.Codeunit.al @7 killed",
    ]);
  });
});

// R374 bumps IDENTITY_SCHEME (R325's rule): a key recorded per batch can name the other twin under
// run-wide numbering. Each path refuses a previous-scheme record by name and has a control at the
// CURRENT scheme that carries. Pinned to IDENTITY_SCHEME and IDENTITY_SCHEME - 1, never literals.
describe("R374: the scheme bump retires per-batch keys", () => {
  beforeAll(async () => {
    await initParser();
  });

  /** Run 1 of test (b), relabelled to `scheme` with the fingerprint that scheme computes. */
  async function storedRun(scheme: number, finished: boolean) {
    const dirs = await makeProject(CODEUNIT_ONE_AL);
    const maxGuardsPerBatch = await twinBudget(dirs.projectDir);
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new TwinBackend(new Set([1]), finished ? undefined : 1),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch,
    });
    const run = store.db.query("SELECT id, backend FROM runs").get() as {
      id: number;
      backend: string;
    };
    const fingerprint = sessionFingerprint({
      projectDir: dirs.projectDir,
      testDir: dirs.testDir,
      backend: run.backend,
      skipKnownSurvivors: false,
      selectorIds,
      identityScheme: scheme,
      coverageMode: "procedure",
    });
    store.db.run("UPDATE runs SET identity_scheme = ?, config_fingerprint = ? WHERE id = ?", [
      scheme,
      fingerprint,
      run.id,
    ]);
    return { dirs, store, first, runId: run.id, maxGuardsPerBatch };
  }

  async function historyRun(scheme: number) {
    const { dirs, store, maxGuardsPerBatch } = await storedRun(scheme, true);
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new TwinBackend(new Set([1])),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch,
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    const warned = events.filter(
      (e) => e.type === "warning" && e.code === "history-identity-scheme-changed",
    );
    return { report, warned };
  }

  test("history: a previous-scheme survivor is executed, not skipped", async () => {
    const { report, warned } = await historyRun(IDENTITY_SCHEME - 1);
    expect(twins(report)).toEqual(["A_Twin.Table.al @12 survived", "B_Twin.Codeunit.al @7 killed"]);
    expect(warned).toHaveLength(1);
  });

  test("history control: at the current scheme the survivor IS skipped", async () => {
    const { report, warned } = await historyRun(IDENTITY_SCHEME);
    expect(twins(report)).toEqual([
      "A_Twin.Table.al @12 known-survivor",
      "B_Twin.Codeunit.al @7 killed",
    ]);
    expect(warned).toHaveLength(0);
  });

  test("--resume-run: a previous-scheme run is refused by name", async () => {
    const { dirs, store, runId, maxGuardsPerBatch } = await storedRun(IDENTITY_SCHEME - 1, false);
    await expect(
      runSession({
        backend: new TwinBackend(new Set([1])),
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch,
        resume: runId,
      }),
    ).rejects.toThrow(
      new RegExp(
        `--resume-run ${runId} was keyed under identity scheme ${IDENTITY_SCHEME - 1}.*scheme ${IDENTITY_SCHEME}.*R325`,
      ),
    );
  });

  test("--resume-run control: at the current scheme the same run resumes", async () => {
    const { dirs, store, runId, maxGuardsPerBatch } = await storedRun(IDENTITY_SCHEME, false);
    const report = await runSession({
      backend: new TwinBackend(new Set([1])),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch,
      resume: runId,
    });
    expect(report.resumedFrom?.runId).toBe(runId);
  });

  test("--resume last: a previous-scheme run is named and refused", async () => {
    const { dirs, store, runId, maxGuardsPerBatch } = await storedRun(IDENTITY_SCHEME - 1, false);
    await expect(
      runSession({
        backend: new TwinBackend(new Set([1])),
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch,
        resume: "last",
      }),
    ).rejects.toThrow(new RegExp(`run ${runId}, .*identity scheme ${IDENTITY_SCHEME - 1}.*R325`));
  });

  test("--resume last control: at the current scheme the same run resumes", async () => {
    const { dirs, store, runId, maxGuardsPerBatch } = await storedRun(IDENTITY_SCHEME, false);
    const report = await runSession({
      backend: new TwinBackend(new Set([1])),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch,
      resume: "last",
    });
    expect(report.resumedFrom?.runId).toBe(runId);
  });

  test("marks: a previous-scheme mark on the codeunit twin's key is stale; the control matches", async () => {
    const run = async (identityScheme: number) => {
      const { dirs, first, maxGuardsPerBatch } = await storedRun(IDENTITY_SCHEME, true);
      const codeunit = first.mutants.find(
        (m) => m.operatorName === OP && m.file === "B_Twin.Codeunit.al",
      );
      if (codeunit === undefined) throw new Error("expected the codeunit twin");
      const key = keyOf(codeunit);
      const report = await runSession({
        backend: new TwinBackend(new Set()),
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds,
        maxGuardsPerBatch,
        // R443: the numbering digest of the run the key was read from, so it matches by key.
        equivalenceMarks: [
          {
            key,
            reason: "a twin",
            identityScheme,
            ...(first.numberingDigest !== undefined
              ? { numberingDigest: first.numberingDigest }
              : {}),
          },
        ],
      });
      return { key, marked: report.readerMarkedEquivalent };
    };
    const old = await run(IDENTITY_SCHEME - 1);
    expect(old.marked?.stale).toEqual([old.key]);
    expect(old.marked?.matched ?? []).toEqual([]);
    const current = await run(IDENTITY_SCHEME);
    expect(current.marked?.stale).toEqual([]);
    expect(current.marked?.matched.map((m) => m.key)).toEqual([current.key]);
  });
});

// R374's offline proof that no frozen gate or committed campaign baseline moves: on every gate
// fixture, at the batching its gate uses, the run-wide ordinal of every mutant equals the per-batch
// one it was recorded under. Only the layout leg batches (7 guards); every other gate and both
// examples run one batch, where the two numberings are one numbering. The DO and r85 campaign
// baselines have no source here and record no ordinal (they predate R193), so nothing in them can move.
describe("R374: no gate fixture's identity ordinal moves", () => {
  beforeAll(async () => {
    await initParser();
  });
  const REPO = join(import.meta.dir, "../../..");
  const cases: { dir: string; maxGuardsPerBatch?: number; only?: string[] }[] = [
    { dir: "fixtures/sandbox-app" },
    { dir: "fixtures/sandbox-data" },
    { dir: "fixtures/sandbox-data", only: ["src/DataMain.Table.al"] },
    { dir: "fixtures/sandbox-hang" },
    { dir: "fixtures/sandbox-harden" },
    { dir: "fixtures/sandbox-symbols" },
    { dir: "fixtures/sandbox-layout", maxGuardsPerBatch: 7 },
    { dir: "examples/credit-limit" },
    { dir: "examples/gift-card" },
  ];
  for (const c of cases) {
    const name = `${c.dir}${c.only !== undefined ? ` --only ${c.only.join(",")}` : ""}${c.maxGuardsPerBatch !== undefined ? ` at ${c.maxGuardsPerBatch} guards` : ""}`;
    test(name, async () => {
      const set = await generateMutationSet(join(REPO, c.dir), {
        ...(c.only !== undefined ? { only: c.only } : {}),
        emit: () => {},
      });
      const runWideOrdinals = identityOrdinalsOf(set);
      const batches = planArtifacts(set.files, {
        ...(c.maxGuardsPerBatch !== undefined ? { maxGuardsPerBatch: c.maxGuardsPerBatch } : {}),
        emit: () => {},
      });
      const moved: string[] = [];
      let seen = 0;
      for (const batch of batches) {
        for (const [key, perBatch] of runIdentityOrdinals(batch, operatorTiers)) {
          seen++;
          const runWide = runWideOrdinals.get(key);
          if (runWide !== perBatch) moved.push(`${JSON.stringify(key)}: ${perBatch} -> ${runWide}`);
        }
      }
      expect(moved).toEqual([]);
      expect(seen).toBe(runWideOrdinals.size);
      expect(seen).toBeGreaterThan(0);
    }, 60_000);
  }
});
