import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  type MutantManifestEntry,
  looseIdentityTupleOf,
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
import type { RunEvent, RunEventInput } from "../src/events";
import { buildExcludedSites } from "../src/excluded-sites";
import { generateMutationSet, operatorTiers, planArtifacts, runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { buildResumeIndex, carriedVerdictFor, wasStranded } from "../src/resume";
import { identityKeyOf, serializeKey } from "../src/selection";
import type { MutantVerdict, MutantVerdictRow } from "../src/store";
import { ResultsStore } from "../src/store";

/**
 * R307 Task 6: identity when a file is refused (plan section 3).
 *
 * (a) An exact refusal (object-mix) reserves its sites in the run-wide numbering, so the good
 *     file's twins keep the keys an earlier run gave them.
 * (b) A header-rule refusal (no-header) reserves nothing, so every mutant sharing one of its loose
 *     tuples is failed closed for the run: history, resume and marks all treat it as unknown.
 * (c) Against `--exclude` of the same file, only a twin of a reserved entry differs, by its ordinal.
 */

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
beforeAll(async () => {
  await initParser();
});

async function tempRoot(tag: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `lethal-r307-t6-${tag}-`));
  roots.push(root);
  return root;
}

// ---------------------------------------------------------------------------------------------
// (a) and (c): R374's twins (run-wide-ordinals.test.ts, test (a)) with Bad refused.

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

/** The same table with an enum added to its file: refused as `object-mix`, an exact refusal. */
const TABLE_WITH_ENUM_AL = `${TABLE_AL}
enum 50101 "Twin Kind"
{
    value(0; Zero) { }
}
`;

/** Two twin statements (lines 7 and 8) in one procedure: B and C. */
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

const TWIN_APP_JSON = JSON.stringify({
  id: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5a70",
  name: "Twin Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 50299 }],
});

const TABLE_FILE = "A_Twin.Table.al";
const CODEUNIT_FILE = "B_Twin.Codeunit.al";
const OP = "lethal.remove-assignment";
const twinSelectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };

async function twinProject(table: string): Promise<{ root: string; projectDir: string }> {
  const root = await tempRoot("twin");
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, TABLE_FILE), table);
  await Bun.write(join(projectDir, CODEUNIT_FILE), CODEUNIT_TWO_AL);
  await Bun.write(join(projectDir, "app.json"), TWIN_APP_JSON);
  return { root, projectDir };
}

/** Every manifest row of every batch, written the way `runSession` writes them. */
async function manifestRows(
  root: string,
  set: Awaited<ReturnType<typeof generateMutationSet>>,
  maxGuardsPerBatch?: number,
): Promise<MutantManifestEntry[]> {
  const batches = planArtifacts(set.files, {
    ...(maxGuardsPerBatch !== undefined ? { maxGuardsPerBatch } : {}),
    emit: () => {},
  });
  const rows: MutantManifestEntry[] = [];
  for (const [i, batch] of batches.entries()) {
    const dir = join(root, `batch-${i}-${Math.random().toString(16).slice(2)}`);
    await writeInstrumentedProject({
      targetDir: dir,
      files: batch,
      identityOrdinals: set.identityOrdinals,
      selectorIds: twinSelectorIds,
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5a70",
      operatorTiers,
    });
    const m = JSON.parse(
      await readFile(join(dir, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
    rows.push(...m.mutants);
  }
  return rows;
}

const keyOfEntry = (m: MutantManifestEntry): string => serializeKey(identityKeyOf(m));
const label = (m: MutantManifestEntry): string => `${m.file} @${m.startLine}`;

/** A store row for `m` with `verdict`, as `buildResumeIndex` reads it. */
function verdictRow(m: MutantManifestEntry, verdict: MutantVerdict): MutantVerdictRow {
  const k = identityKeyOf(m);
  return {
    astHash: k.astHash,
    codeunitName: k.codeunitName,
    procedureName: k.procedureName,
    operatorName: k.operatorName,
    operatorMajor: k.operatorMajor,
    identityOrdinal: k.ordinal,
    verdict,
    durationMs: 1,
  };
}

describe("R307 T6 (a): an exact refusal reserves its sites, so the twins keep their keys", () => {
  test("Bad refused as object-mix: B and C keep ordinals 1 and 2 and carry only their own verdicts", async () => {
    // Run 1, R374's case: Bad alone in batch 0, B and C in batch 1. Keys Bad 0, B 1, C 2.
    const { root, projectDir } = await twinProject(TABLE_AL);
    const set1 = await generateMutationSet(projectDir, { emit: () => {} });
    const codeunitSpecs = set1.files.find((f) => f.path === CODEUNIT_FILE)?.specs.length;
    if (codeunitSpecs === undefined) throw new Error("the codeunit file produced no specs");
    const run1 = (await manifestRows(root, set1, codeunitSpecs)).filter(
      (m) => m.operatorName === OP,
    );
    expect(run1.map((m) => `${label(m)} ordinal ${m.identityOrdinal}`)).toEqual([
      `${TABLE_FILE} @12 ordinal 0`,
      `${CODEUNIT_FILE} @7 ordinal 1`,
      `${CODEUNIT_FILE} @8 ordinal 2`,
    ]);
    // Three different verdicts, so a key that moved onto a neighbour carries the wrong one.
    const verdicts: MutantVerdict[] = ["survived", "killed", "no-coverage"];
    const index = buildResumeIndex(run1.map((m, i) => verdictRow(m, verdicts[i] ?? "error")));

    // Run 2: an enum added to Bad's file. It is refused whole; its sites are reserved.
    await Bun.write(join(projectDir, TABLE_FILE), TABLE_WITH_ENUM_AL);
    const set2 = await generateMutationSet(projectDir, { emit: () => {} });
    expect(set2.refusedFiles.map((r) => [r.file, r.shape, r.looseTuples])).toEqual([
      [TABLE_FILE, "object-mix", undefined],
    ]);
    expect(set2.files.map((f) => f.path)).toEqual([CODEUNIT_FILE]);
    const run2 = (await manifestRows(root, set2)).filter((m) => m.operatorName === OP);
    const run1ByKey = new Map(run1.map((m) => [keyOfEntry(m), label(m)]));
    // Each run-2 key equals its OWN run-1 key, never a neighbour's.
    expect(
      run2.map(
        (m) =>
          `${label(m)} ordinal ${m.identityOrdinal} has run-1 key of ${run1ByKey.get(keyOfEntry(m))}`,
      ),
    ).toEqual([
      `${CODEUNIT_FILE} @7 ordinal 1 has run-1 key of ${CODEUNIT_FILE} @7`,
      `${CODEUNIT_FILE} @8 ordinal 2 has run-1 key of ${CODEUNIT_FILE} @8`,
    ]);
    // And the resume index carries only each one's own run-1 verdict.
    expect(run2.map((m) => `${label(m)} ${carriedVerdictFor(index, m)?.verdict}`)).toEqual([
      `${CODEUNIT_FILE} @7 killed`,
      `${CODEUNIT_FILE} @8 no-coverage`,
    ]);
  });
});

describe("R307 T6 (b), unit: a disabled carry also lifts a stranded skip", () => {
  test("wasStranded is false for a mutant whose loose tuple is disabled; the control is true", async () => {
    const { root, projectDir } = await twinProject(TABLE_AL);
    const set = await generateMutationSet(projectDir, { emit: () => {} });
    const m = (await manifestRows(root, set)).find((x) => x.operatorName === OP);
    if (m === undefined) throw new Error("expected a remove-assignment mutant");
    const index = {
      carryable: new Map(),
      ambiguousKeys: 0,
      nonCarryableRows: 0,
      strandedKeys: new Set([keyOfEntry(m)]),
    };
    expect(wasStranded(index, m)).toBe(true);
    expect(wasStranded({ ...index, carryDisabled: new Set([looseIdentityTupleOf(m)]) }, m)).toBe(
      false,
    );
  });
});

describe("R307 T6 (c): against --exclude Bad, only a twin of a reserved entry differs", () => {
  test("non-twin rows deep-equal; twin ordinals higher by exactly the reserved count", async () => {
    const { root, projectDir } = await twinProject(TABLE_WITH_ENUM_AL);
    const refused = await generateMutationSet(projectDir, { emit: () => {} });
    const excluded = await generateMutationSet(projectDir, {
      exclude: [TABLE_FILE],
      emit: () => {},
    });
    expect(refused.refusedFiles.map((r) => r.file)).toEqual([TABLE_FILE]);
    expect(excluded.refusedFiles).toEqual([]);
    // Every reserved entry is a site of the refused file; the excluded run reserves none.
    const reserved = [...refused.identityOrdinals.keys()].filter((k) => k.includes(TABLE_FILE));
    expect(reserved.length).toBe(refused.refusedFiles[0]?.sites ?? -1);
    expect([...excluded.identityOrdinals.keys()].some((k) => k.includes(TABLE_FILE))).toBe(false);

    const a = await manifestRows(root, refused);
    const b = await manifestRows(root, excluded);
    expect(a.length).toBe(b.length);
    const twinRows: string[] = [];
    let identical = 0;
    for (const [i, row] of a.entries()) {
      const other = b[i];
      if (other === undefined) throw new Error(`row ${i} missing from the --exclude run`);
      const { identityOrdinal: ordA, ...restA } = row;
      const { identityOrdinal: ordB, ...restB } = other;
      // Everything but the ordinal is identical on EVERY row, M-ids included.
      expect(restA).toEqual(restB);
      if (ordA === ordB) {
        expect(row).toEqual(other);
        identical++;
      } else {
        twinRows.push(`${label(row)} ${row.operatorName} ${ordB ?? 0} -> ${ordA ?? 0}`);
      }
    }
    // Bad holds ONE copy of each twinned statement, so the reserved count before each twin is 1.
    expect(twinRows).toEqual([
      `${CODEUNIT_FILE} @7 lethal.remove-assignment 0 -> 1`,
      `${CODEUNIT_FILE} @7 lethal.swap-additive 0 -> 1`,
      `${CODEUNIT_FILE} @8 lethal.remove-assignment 1 -> 2`,
      `${CODEUNIT_FILE} @8 lethal.swap-additive 1 -> 2`,
      `${CODEUNIT_FILE} @9 lethal.return-value 0 -> 1`,
    ]);
    expect(identical).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// (b): T4's real no-header shape, with twins by loose tuple in a good file.

const BODY = `{
    procedure Compute()
    var
        Counter: Integer;
    begin
        Counter := 1;
    end;
}
`;
const GOOD_AL = `codeunit 79301 "Good"\n${BODY}`;
/** T4's no-header shape: the namespace and the header on one line. Refused, no object name. */
const NO_HEADER_AL = `namespace Demo; codeunit 50100 "Alone"\n${BODY}`;

const GOOD_FILE = join("src", "Good.Codeunit.al");
const BAD_FILE = join("src", "Bad.al");

const TEST_AL = `codeunit 79400 "Good Tests"
{
    Subtype = Test;

    [Test]
    procedure ComputeWorks()
    begin
    end;
}
`;

const SKIP_APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});
const skipSelectorIds = { selectorId: 60000, controlId: 60001, tableId: 60002 };

/** Every test passes and covers `Good.Compute`, so every mutant survives. */
class SurviveBackend implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
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
          entries: [{ objectType: "Codeunit", objectId: 79301, procedure: "Compute" }],
        },
      };
    }
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
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

const goodRows = (r: SessionReport): string[] =>
  r.mutants
    .filter((m) => m.file === GOOD_FILE)
    .map((m) => `${m.operatorName} ${m.verdict}${m.carried === true ? " carried" : ""}`)
    .sort();

/** Run 1 holds only the good file; every mutant survives. */
async function survivedRun() {
  const root = await tempRoot("skip");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "app.json"), SKIP_APP_JSON);
  await Bun.write(join(projectDir, GOOD_FILE), GOOD_AL);
  await Bun.write(join(testDir, "GoodTests.Codeunit.al"), TEST_AL);
  const dirs = { projectDir, testDir, instrumentedDir };
  const store = new ResultsStore(":memory:");
  const first = await runSession({
    backend: new SurviveBackend(),
    store,
    ...dirs,
    selectorIds: skipSelectorIds,
  });
  const run = store.db.query("SELECT id FROM runs").get() as { id: number };
  return { dirs, store, first, runId: run.id };
}

const SURVIVED = [
  "lethal.empty-block survived",
  "lethal.remove-assignment survived",
  "lethal.shift-integer survived",
];

describe("R307 T6 (b): a header-rule refusal fails its loose twins closed", () => {
  test("the refused row names the count; the warning names the file and the count", async () => {
    const root = await tempRoot("row");
    const projectDir = join(root, "app");
    await Bun.write(join(projectDir, "app.json"), SKIP_APP_JSON);
    await Bun.write(join(projectDir, GOOD_FILE), GOOD_AL);
    await Bun.write(join(projectDir, BAD_FILE), NO_HEADER_AL);
    const events: RunEventInput[] = [];
    const set = await generateMutationSet(projectDir, { emit: (e) => events.push(e) });
    expect(set.refusedFiles.map((r) => [r.file, r.shape, r.carryDisabled])).toEqual([
      [BAD_FILE, "no-header", 3],
    ]);
    const warned = events.flatMap((e) =>
      e.type === "warning" && e.code === "identity-carry-disabled" ? [e.message] : [],
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`${BAD_FILE} was refused (no-header)`);
    expect(warned[0]).toContain("so 3 mutant(s) elsewhere");
    const excluded = buildExcludedSites({
      skipped: set.skipped,
      declarative: set.declarativeSites,
      refused: set.refusedFiles,
      totalFiles: set.totalFiles,
    });
    expect(excluded.files.map((f) => f.detail)).toEqual([
      `no-header in ${BAD_FILE}: the object header rule found no object header; identity carry disabled for 3 mutant(s)`,
    ]);
  });

  test("history: the survived twins are executed, not skipped; control without Bad skips them", async () => {
    const { dirs, store, first } = await survivedRun();
    expect(goodRows(first)).toEqual(SURVIVED);
    const run = async () => {
      const events: RunEvent[] = [];
      const report = await runSession({
        backend: new SurviveBackend(),
        store,
        ...dirs,
        selectorIds: skipSelectorIds,
        skipKnownSurvivors: true,
        emit: [(e) => events.push(e)],
      });
      return { report, events };
    };
    // Control first: without the refusal, history skips all three.
    expect(goodRows((await run()).report)).toEqual([
      "lethal.empty-block known-survivor",
      "lethal.remove-assignment known-survivor",
      "lethal.shift-integer known-survivor",
    ]);
    await Bun.write(join(dirs.projectDir, BAD_FILE), NO_HEADER_AL);
    const { report, events } = await run();
    expect(goodRows(report)).toEqual(SURVIVED);
    expect(
      events.filter((e) => e.type === "warning" && e.code === "identity-carry-disabled"),
    ).toHaveLength(1);
    // Its key is still written: the next run without the refusal skips all three again.
    await rm(join(dirs.projectDir, BAD_FILE));
    expect(goodRows((await run()).report)).toEqual([
      "lethal.empty-block known-survivor",
      "lethal.remove-assignment known-survivor",
      "lethal.shift-integer known-survivor",
    ]);
  });

  test("resume: no twin is carried; control without Bad carries all three", async () => {
    const { dirs, store, runId } = await survivedRun();
    const resume = () =>
      runSession({
        backend: new SurviveBackend(),
        store,
        ...dirs,
        selectorIds: skipSelectorIds,
        resume: runId,
      });
    expect(goodRows(await resume())).toEqual(SURVIVED.map((r) => `${r} carried`));
    await Bun.write(join(dirs.projectDir, BAD_FILE), NO_HEADER_AL);
    const report = await resume();
    expect(report.resumedFrom?.runId).toBe(runId);
    expect(goodRows(report)).toEqual(SURVIVED);
  });

  test("marks: a mark on a twin's key takes no effect (stale); control without Bad matches", async () => {
    const { dirs, first } = await survivedRun();
    const twin = first.mutants.find((m) => m.operatorName === "lethal.remove-assignment");
    if (twin === undefined) throw new Error("expected the remove-assignment twin");
    const key = keyOf(twin);
    const marked = async () =>
      (
        await runSession({
          backend: new SurviveBackend(),
          store: new ResultsStore(":memory:"),
          ...dirs,
          selectorIds: skipSelectorIds,
          equivalenceMarks: [{ key, reason: "a twin", identityScheme: IDENTITY_SCHEME }],
        })
      ).readerMarkedEquivalent;
    const control = await marked();
    expect(control?.matched.map((m) => m.key)).toEqual([key]);
    await Bun.write(join(dirs.projectDir, BAD_FILE), NO_HEADER_AL);
    const off = await marked();
    expect(off?.matched).toEqual([]);
    expect(off?.contradicted).toEqual([]);
    expect(off?.stale).toEqual([key]);
  });
});
