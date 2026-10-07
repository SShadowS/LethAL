import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  type MutantManifestEntry,
  coarseIdentityTupleOf,
  identityTupleOf,
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
import { explain } from "../src/explain";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  planArtifacts,
  runSession,
} from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { type ResumeIndex, buildResumeIndex, carriedVerdictFor, wasStranded } from "../src/resume";
import { identityKeyOf, serializeKey, twinSiteOf } from "../src/selection";
import type { MutantVerdict, MutantVerdictRow } from "../src/store";
import { ResultsStore } from "../src/store";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";

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
      identityOrdinals: identityOrdinalsOf(set),
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
    file: m.file,
    identityOrdinal: k.ordinal,
    verdict,
    durationMs: 1,
    memberHash: m.memberHash ?? null,
  };
}

/** R391: a carry rule under which the recorded run had the same source (rule 1: by key). */
function sameSourceRule(): NonNullable<ResumeIndex["carryRule"]> {
  return {
    recorded: { hash: "same", twins: null },
    current: { hash: "same", twins: new Set(), refused: new Set() },
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
    expect(set2.refusedFiles.map((r) => [r.file, r.shape, r.coarseTuples])).toEqual([
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
    // And a key lookup (rule 1) finds only each one's own run-1 verdict.
    const byKey = { ...index, carryRule: sameSourceRule() };
    expect(run2.map((m) => `${label(m)} ${carriedVerdictFor(byKey, m)?.verdict}`)).toEqual([
      `${CODEUNIT_FILE} @7 killed`,
      `${CODEUNIT_FILE} @8 no-coverage`,
    ]);
    // R391: the source DID change, and the two are twins in their file on both sides, so the real
    // rule carries neither: they run.
    const twins = new Set(run2.map((m) => twinSiteOf(m.file, identityTupleOf(m))));
    const edited = {
      ...index,
      carryRule: {
        recorded: { hash: "run1", twins },
        current: { hash: "run2", twins, refused: new Set<string>() },
      },
    };
    expect(run2.map((m) => carriedVerdictFor(edited, m))).toEqual([undefined, undefined]);
  });
});

describe("R307 T6 (b), unit: a disabled carry keeps the stranded skip", () => {
  test("wasStranded stays true for a mutant whose coarse tuple is disabled (R53: never re-run a hang)", async () => {
    const { root, projectDir } = await twinProject(TABLE_AL);
    const set = await generateMutationSet(projectDir, { emit: () => {} });
    const m = (await manifestRows(root, set)).find((x) => x.operatorName === OP);
    if (m === undefined) throw new Error("expected a remove-assignment mutant");
    const index = {
      carryable: new Map(),
      carryableBySite: new Map(),
      carryRule: sameSourceRule(),
      ambiguousKeys: 0,
      nonCarryableRows: 0,
      strandedKeys: new Set([keyOfEntry(m)]),
    };
    expect(wasStranded(index, m)).toBe(true);
    expect(wasStranded({ ...index, carryDisabled: new Set([coarseIdentityTupleOf(m)]) }, m)).toBe(
      true,
    );
    // ...while the same disabled set does stop the verdict carrying.
    const carrying = {
      ...index,
      carryable: new Map([[keyOfEntry(m), { verdict: "survived" as const, durationMs: 1 }]]),
    };
    expect(carriedVerdictFor(carrying, m)?.verdict).toBe("survived");
    expect(
      carriedVerdictFor({ ...carrying, carryDisabled: new Set([coarseIdentityTupleOf(m)]) }, m),
    ).toBeUndefined();
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
    const reserved = [...identityOrdinalsOf(refused).keys()].filter((k) => k.includes(TABLE_FILE));
    expect(reserved.length).toBe(refused.refusedFiles[0]?.sites ?? -1);
    expect([...identityOrdinalsOf(excluded).keys()].some((k) => k.includes(TABLE_FILE))).toBe(
      false,
    );

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

// Report paths are always "/"-separated (targetAlFiles normalises them), so never `join` these (R448).
const GOOD_FILE = "src/Good.Codeunit.al";
const BAD_FILE = "src/Bad.al";

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
  await Bun.write(join(testDir, "app.json"), testAppJson());
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
    expect(warned[0]).toContain("A mutant an earlier run stranded on is still skipped (R53)");
    expect(warned[0]).toContain("Keep any equivalence mark that reads stale this run");
    const excluded = buildExcludedSites({
      skipped: set.skipped,
      declarative: set.declarativeSites,
      preproc: set.preprocExcluded,
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
    // R442 (an intended change): the refused run recorded Bad's site shapes, so the first run
    // without the refusal re-measures the three once more (a key that run wrote may name another
    // mutant), and only the run after that skips them again.
    await rm(join(dirs.projectDir, BAD_FILE));
    expect(goodRows((await run()).report)).toEqual(SURVIVED);
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
    // R443: the mark `lethal explain` prints for it, proof included. Good holds one such twin, so
    // it is a proven singleton in its file and still names it after Bad renumbers (rule 2).
    const printed = explain(first).survivors.find(
      (s) => s.batchIndex === twin.batchIndex && s.mutantCode === twin.mutantCode,
    )?.mark;
    if (printed === undefined) throw new Error("explain printed no mark for the twin");
    expect(printed.fileSingleton).toBe(true);
    const marked = async () =>
      (
        await runSession({
          backend: new SurviveBackend(),
          store: new ResultsStore(":memory:"),
          ...dirs,
          selectorIds: skipSelectorIds,
          equivalenceMarks: [{ ...printed, reason: "a twin", identityScheme: IDENTITY_SCHEME }],
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

// ---------------------------------------------------------------------------------------------
// R442: what a run numbered no ordinal for is stored on its run row (`runs.carry_hidden`), so a
// later run distrusts every key that may have moved. The oracle for "not carried" is always
// `carried !== true` AND the mutant's id in the backend's activate log ("executed"), never the
// verdict alone: an all-surviving backend says `survived` either way.

type Covered = { objectType: "Codeunit" | "Table"; objectId: number; procedure: string };

/** Every test passes and covers `covered`, so every mutant survives. Logs each activation. */
class LogBackend implements ExecutionBackend {
  readonly activated: string[] = [];
  deploys = 0;
  private active: string | null = null;
  constructor(private readonly covered: readonly Covered[]) {}
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
  async deploy(): Promise<CompiledArtifact | null> {
    this.deploys++;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
    if (id !== null) this.activated.push(id);
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: { granularity: "procedure", entries: [...this.covered] },
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

const proc = (name: string, stmt: string): string =>
  `    procedure ${name}()\n    var\n        Counter: Integer;\n    begin\n        ${stmt}\n    end;\n`;
const obj = (header: string, ...procs: string[]): string => `${header}\n{\n${procs.join("\n")}}\n`;
/** Three bodies with three different subtree hashes: X twins X, never Y or Z. */
const X = (name = "Compute"): string => proc(name, "Counter := 1;");
const Y = (name = "Other"): string => proc(name, "Counter := Counter + 7;");
const Z = (name = "Third"): string => proc(name, "Counter := Counter * 3;");
/** T4's no-header shape (refused, no object name) and the same header repaired by a newline. */
const REFUSED_TABLE = 'namespace X; table 50100 "Twin"';
const REPAIRED_TABLE = 'namespace X;\ntable 50100 "Twin"';
const GOOD_CU = 'codeunit 79301 "Twin"';
const COVERED: readonly Covered[] = [
  { objectType: "Table", objectId: 50100, procedure: "Compute" },
  { objectType: "Codeunit", objectId: 79301, procedure: "Compute" },
  { objectType: "Codeunit", objectId: 79301, procedure: "Other" },
  { objectType: "Codeunit", objectId: 79301, procedure: "Third" },
  { objectType: "Codeunit", objectId: 79302, procedure: "C" },
  { objectType: "Codeunit", objectId: 79301, procedure: "B|C" },
];

type R442Over = Partial<
  Pick<Parameters<typeof runSession>[0], "skipKnownSurvivors" | "resume" | "only" | "lines">
>;

async function r442World(files: Readonly<Record<string, string>>) {
  const root = await tempRoot("r442");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "app.json"), SKIP_APP_JSON);
  for (const [p, text] of Object.entries(files)) await Bun.write(join(projectDir, p), text);
  await Bun.write(join(testDir, "GoodTests.Codeunit.al"), TEST_AL);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  const store = new ResultsStore(":memory:");
  const run = async (over: R442Over = {}) => {
    const backend = new LogBackend(COVERED);
    const events: RunEvent[] = [];
    const report = await runSession({
      backend,
      store,
      projectDir,
      testDir,
      instrumentedDir,
      selectorIds: skipSelectorIds,
      emit: [(e) => events.push(e)],
      ...over,
    });
    /** `<operator> <verdict>[ carried][ executed]` per mutant of `file` (and `procedure`). */
    const rows = (file: string, procedure?: string): string[] =>
      report.mutants
        .filter(
          (m) => m.file === file && (procedure === undefined || m.procedureName === procedure),
        )
        .map(
          (m) =>
            `${m.operatorName} ${m.verdict}${m.carried === true ? " carried" : ""}${backend.activated.includes(m.mutantCode) ? " executed" : ""}`,
        )
        .sort();
    const warnings = (code: string): string[] =>
      events.flatMap((e) => (e.type === "warning" && e.code === code ? [e.message] : []));
    const runId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    return { report, rows, warnings, backend, runId };
  };
  const write = (p: string, text: string) => Bun.write(join(projectDir, p), text);
  return { store, run, write, projectDir };
}

/** `rows` of a run where every mutant was executed, re-read with another verdict suffix. */
const as = (executed: readonly string[], suffix: string): string[] =>
  executed.map((r) => r.replace(/ survived executed$/, ` ${suffix}`)).sort();

describe("R442: a site hidden from numbering in one run poisons no key in the next", () => {
  test("history: a repaired header refusal's twins are executed; a non-twin in the same file still skips", async () => {
    const w = await r442World({
      "src/Bad.al": obj(REFUSED_TABLE, X()),
      "src/Good.al": obj(GOOD_CU, X(), Y()),
    });
    const first = await w.run();
    const compute = first.rows("src/Good.al", "Compute");
    const other = first.rows("src/Good.al", "Other");
    expect(compute).toHaveLength(3);
    expect(other.length).toBeGreaterThan(0);
    for (const r of [...compute, ...other]) expect(r).toEndWith(" survived executed");
    // The stored list: Bad's three sites, by coarse tuple; nothing hidden whole.
    expect(w.store.getRun(first.runId)?.carryHidden).toEqual({
      tuples: expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}\|lethal\.[a-z-]+\|1$/)]),
      files: [],
    });
    expect(w.store.getRun(first.runId)?.carryHidden?.tuples).toHaveLength(3);

    await w.write("src/Bad.al", obj(REPAIRED_TABLE, X()));
    const second = await w.run({ skipKnownSurvivors: true });
    // Bad now takes ordinal 0, the key Good's twins held in run 1: executed, not skipped.
    expect(second.rows("src/Bad.al")).toEqual(compute);
    expect(second.rows("src/Good.al", "Compute")).toEqual(compute);
    // The control in the same files: Other's keys never moved, so history still skips them.
    expect(second.rows("src/Good.al", "Other")).toEqual(as(other, "known-survivor"));
  });

  test('history: object "A|B" with C against object A with "B|C" (one key string): executed', async () => {
    const w = await r442World({
      "src/Bad.al": obj('namespace X; codeunit 79302 "A|B"', X("C")),
      "src/Good.al": obj('codeunit 79301 "A"', X('"B|C"'), Y()),
    });
    const first = await w.run();
    const twins = first.rows("src/Good.al", "B|C");
    const other = first.rows("src/Good.al", "Other");
    expect(twins).toHaveLength(3);
    await w.write("src/Bad.al", obj('namespace X;\ncodeunit 79302 "A|B"', X("C")));
    const second = await w.run({ skipKnownSurvivors: true });
    // The collision is real: Bad's run-2 keys are exactly Good's run-1 keys.
    const keysOf = (r: SessionReport, file: string) =>
      r.mutants
        .filter((m) => m.file === file)
        .map(keyOf)
        .sort();
    expect(keysOf(second.report, "src/Bad.al")).toEqual(
      first.report.mutants
        .filter((m) => m.procedureName === "B|C")
        .map(keyOf)
        .sort(),
    );
    expect(second.rows("src/Bad.al")).toEqual(twins);
    expect(second.rows("src/Good.al", "Other")).toEqual(as(other, "known-survivor"));
  });

  test("history: a commented #if (preproc-undecided) removed: no key carries and the warning names the file; kept: Good carries", async () => {
    const COMMENTED = `table 50100 "Twin"\n{\n    /*\n    #if true\n    */\n${X()}}\n`;
    const files = { "src/A.al": COMMENTED, "src/Good.al": obj(GOOD_CU, X(), Y()) };
    const w = await r442World(files);
    const first = await w.run();
    const compute = first.rows("src/Good.al", "Compute");
    expect(compute).toHaveLength(3);
    expect(w.store.getRun(first.runId)?.carryHidden).toEqual({ tuples: [], files: ["src/A.al"] });
    await w.write("src/A.al", obj('table 50100 "Twin"', X()));
    const second = await w.run({ skipKnownSurvivors: true });
    // A now takes ordinal 0, Good's run-1 key: executed, never skipped.
    expect(second.rows("src/A.al")).toEqual(compute);
    const warned = second.warnings("history-hidden-files-changed");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("hid src/A.al whole");
    expect(warned[0]).toContain("this run hides no file");

    // Control: the comment kept, so A is hidden in both runs and moves no ordinal.
    const c = await r442World(files);
    const cFirst = await c.run();
    const cSecond = await c.run({ skipKnownSurvivors: true });
    expect(cSecond.rows("src/Good.al")).toEqual(as(cFirst.rows("src/Good.al"), "known-survivor"));
    expect(cSecond.warnings("history-hidden-files-changed")).toEqual([]);
  });

  test("history: --only Good, then a full run: A is executed; the same --only again carries (no edit at all)", async () => {
    const files = { "src/A.al": obj('table 50100 "Twin"', X()), "src/Good.al": obj(GOOD_CU, X()) };
    const w = await r442World(files);
    const first = await w.run({ only: ["src/Good.al"] });
    expect(w.store.getRun(first.runId)?.carryHidden).toEqual({ tuples: [], files: ["src/A.al"] });
    const second = await w.run({ skipKnownSurvivors: true });
    expect(second.rows("src/A.al")).toEqual(first.rows("src/Good.al"));
    expect(second.warnings("history-hidden-files-changed")).toHaveLength(1);

    const c = await r442World(files);
    const cFirst = await c.run({ only: ["src/Good.al"] });
    const cSecond = await c.run({ only: ["src/Good.al"], skipKnownSurvivors: true });
    expect(cSecond.rows("src/Good.al")).toEqual(as(cFirst.rows("src/Good.al"), "known-survivor"));
  });

  test("history, the other direction: a full run, then --only Good: Good (now ordinal 0, A's key) is executed", async () => {
    const w = await r442World({
      "src/A.al": obj('table 50100 "Twin"', X()),
      "src/Good.al": obj(GOOD_CU, X()),
    });
    const first = await w.run();
    const second = await w.run({ only: ["src/Good.al"], skipKnownSurvivors: true });
    expect(second.rows("src/Good.al")).toEqual(first.rows("src/Good.al"));
    expect(second.warnings("history-hidden-files-changed")).toHaveLength(1);
  });

  test("history: a full run, then --lines on Good only: Good's twins of A are executed, Good's other procedure skips", async () => {
    const w = await r442World({
      "src/A.al": obj('table 50100 "Twin"', X()),
      "src/Good.al": obj(GOOD_CU, X(), Y()),
    });
    const first = await w.run();
    const compute = first.rows("src/Good.al", "Compute");
    const other = first.rows("src/Good.al", "Other");
    const second = await w.run({
      skipKnownSurvivors: true,
      lines: [{ file: "src/Good.al", start: 1, end: 100 }],
    });
    expect(second.rows("src/A.al")).toEqual([]);
    // Good's Compute twins now hold ordinal 0, A's run-1 key: executed.
    expect(second.rows("src/Good.al", "Compute")).toEqual(compute);
    expect(second.rows("src/Good.al", "Other")).toEqual(as(other, "known-survivor"));
    expect(w.store.getRun(second.runId)?.carryHidden?.tuples).toHaveLength(3);
  });

  test("resume: Bad-X repaired and a new Bad-Y refused: both twin sets are executed, the batch deploys, Third carries", async () => {
    const w = await r442World({
      "src/BadX.al": obj(REFUSED_TABLE, X()),
      "src/Good.al": obj(GOOD_CU, X(), Y(), Z()),
    });
    const p = await w.run();
    const compute = p.rows("src/Good.al", "Compute");
    const other = p.rows("src/Good.al", "Other");
    const third = p.rows("src/Good.al", "Third");
    await w.write("src/BadX.al", obj(REPAIRED_TABLE, X()));
    await w.write("src/BadY.al", obj('namespace X; table 50101 "Other Twin"', Y()));
    const resumed = await w.run({ resume: p.runId });
    expect(resumed.report.resumedFrom?.runId).toBe(p.runId);
    expect(resumed.rows("src/BadX.al")).toEqual(compute);
    expect(resumed.rows("src/Good.al", "Other")).toEqual(other);
    expect(resumed.rows("src/Good.al", "Third")).toEqual(as(third, "survived carried"));
    expect(resumed.backend.deploys).toBe(1);
  });

  test("resume: a preproc-undecided file since fixed is refused by name", async () => {
    const COMMENTED = `table 50100 "Twin"\n{\n    /*\n    #if true\n    */\n${X()}}\n`;
    const w = await r442World({ "src/A.al": COMMENTED, "src/Good.al": obj(GOOD_CU, X()) });
    const p = await w.run();
    await w.write("src/A.al", obj('table 50100 "Twin"', X()));
    await expect(w.run({ resume: p.runId })).rejects.toThrow(
      `--resume: run ${p.runId} hid src/A.al whole from identity numbering, and this run hides no file`,
    );
  });

  test("legacy NULL: history skips nothing and warns; --resume and --resume-run refuse by name; a fresh run records empty lists", async () => {
    const w = await r442World({ "src/Good.al": obj(GOOD_CU, X(), Y()) });
    const first = await w.run();
    const all = first.rows("src/Good.al");
    // A fresh store's first run records empty lists, not NULL.
    expect(w.store.getRun(first.runId)?.carryHidden).toEqual({ tuples: [], files: [] });
    // Control: every other trust gate matches, so history skips everything.
    const control = await w.run({ skipKnownSurvivors: true });
    expect(control.rows("src/Good.al")).toEqual(as(all, "known-survivor"));
    // The latest finished run made legacy: same scheme, symbols, coverage mode and test app.
    w.store.db.run("UPDATE runs SET carry_hidden = NULL WHERE id = ?", [control.runId]);
    const legacy = w.store.getRun(control.runId);
    expect([legacy?.identityScheme, legacy?.coverageMode, legacy?.buildSymbols]).toEqual([
      IDENTITY_SCHEME,
      "procedure",
      [],
    ]);
    expect(legacy?.testAppHash).toBe(w.store.getRun(first.runId)?.testAppHash ?? "missing");
    const after = await w.run({ skipKnownSurvivors: true });
    expect(after.rows("src/Good.al")).toEqual(all);
    const warned = after.warnings("history-carry-untrusted");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`run ${control.runId}, recorded no list`);

    // Both resume flags refuse a NULL run by name (run 1, made unfinished and NULL).
    w.store.db.run("UPDATE runs SET carry_hidden = NULL, finished_at = NULL WHERE id = ?", [
      first.runId,
    ]);
    await expect(w.run({ resume: first.runId })).rejects.toThrow(
      `--resume-run ${first.runId} recorded no list`,
    );
    await expect(w.run({ resume: "last" })).rejects.toThrow(
      `--resume found run ${first.runId}, but it recorded no list`,
    );
    // Control: the same run with its list back resumes and carries.
    w.store.db.run(`UPDATE runs SET carry_hidden = '{"tuples":[],"files":[]}' WHERE id = ?`, [
      first.runId,
    ]);
    const resumed = await w.run({ resume: "last" });
    expect(resumed.rows("src/Good.al")).toEqual(as(all, "survived carried"));
  });

  test("crash window: a seeded NULL run holding verdict rows carries nothing", async () => {
    const w = await r442World({ "src/Good.al": obj(GOOD_CU, X()) });
    const first = await w.run();
    const all = first.rows("src/Good.al");
    // A run row written before generation, then verdict rows, and no list: what a run that died
    // between `createRun` and the setter would look like if a row had slipped in.
    w.store.db.run(
      // R495: with its proven flag, which `createRun` writes with the hash.
      "INSERT INTO runs (project_path, backend, app_version, config_fingerprint, identity_scheme, build_symbols, coverage_mode, test_app_hash, test_app_proven) SELECT project_path, backend, app_version, config_fingerprint, identity_scheme, build_symbols, coverage_mode, test_app_hash, test_app_proven FROM runs WHERE id = ?",
      [first.runId],
    );
    const seeded = (w.store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    w.store.db.run(
      "INSERT INTO mutants (run_id, mutant_code, ast_hash, codeunit_name, procedure_name, operator_name, operator_major, file, line, verdict, duration_ms, batch_index, identity_ordinal) SELECT ?, mutant_code, ast_hash, codeunit_name, procedure_name, operator_name, operator_major, file, line, verdict, duration_ms, batch_index, identity_ordinal FROM mutants WHERE run_id = ?",
      [seeded, first.runId],
    );
    expect(w.store.getRun(seeded)?.carryHidden).toBeNull();
    await expect(w.run({ resume: "last" })).rejects.toThrow(
      `--resume found run ${seeded}, but it recorded no list`,
    );
    w.store.db.run("UPDATE runs SET finished_at = datetime('now') WHERE id = ?", [seeded]);
    const after = await w.run({ skipKnownSurvivors: true });
    expect(after.rows("src/Good.al")).toEqual(all);
    expect(after.warnings("history-carry-untrusted")).toHaveLength(1);
  });

  test("premise of the coarse tuple: no registered operator name holds | or is all digits", () => {
    const names = [...operatorTiers.keys()];
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => n.includes("|") || /^\d+$/.test(n))).toEqual([]);
  });
});
