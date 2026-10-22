// R-646c: `--resume` never replays a fully scored batch whole (plan
// docs/superpowers/plans/2026-10-22-r646c-resume-always-ordinary-path.md, r3 + amendment). Every
// batch takes the ordinary path: deploy, an eligible baseline snapshot or a fresh baseline, then
// step 5b, where R-646b's `facedEveryCoveringTest` decides each carried survivor. And (amendment 3)
// a stranded mutant (R53) is skipped BEFORE coverage, so an uncovered one keeps its skip note.
// Written test-first; tests 1 and 3 to 7 were RED on master d8c2875c (tests-before.md).
// The al-runner Stub and the project are copied from r644-source-baseline-lend.test.ts; the
// coverage backend for test 7 is cut down from r621-no-coverage-carry.test.ts.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  PackageUnread,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { MicrosoftMode } from "../src/digest-inputs";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { STRANDED_SKIP_NOTE } from "../src/resume";
import { ResultsStore } from "../src/store";
import { measuredV2_12 } from "./helpers/al-runner-predefined";
import { servedIsInstalled, testAppJson, testAppPackage } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const EXTRA_AL = `codeunit 79002 "Sandbox Extra"
{
    procedure UnderLimit(Amount: Decimal; Limit: Decimal): Boolean
    begin
        exit(Amount < Limit);
    end;
}
`;
const WEAK_AL = `codeunit 79100 "Weak Tests"
{
    Subtype = Test;

    [Test]
    procedure Weak()
    begin
    end;
}
`;
const KILLER_AL = `codeunit 79101 "Killer Tests"
{
    Subtype = Test;

    [Test]
    procedure Strong()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a92",
  name: "Sandbox R646c Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
/** A stored note `isStrandedNote` reads as stranding the tier (R53). */
const QUARANTINED = "quarantined: RunMutant timed out (seeded by the test)";

interface StubOpts {
  readonly killerRed: boolean;
  readonly killerKills: boolean;
}

/** al-runner shape, coverage "none": every green test covers every mutant. */
class Stub implements ExecutionBackend {
  mutantRuns = 0;
  deploys = 0;
  readonly activated: string[] = [];
  private active: string | null = null;
  readonly measurePredefinedSymbols = measuredV2_12;
  constructor(private readonly o: StubOpts) {}
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner",
      coverage: "none",
      deploy: "none",
      isolation: "session",
      authoritative: false,
    };
  }
  microsoftMode(): MicrosoftMode {
    return servedIsInstalled(() => testAppPackage());
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
    if (id !== null && !this.activated.includes(id)) this.activated.push(id);
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    const killer = ref.codeunitName === "Killer Tests";
    if (this.active === null) {
      return killer && this.o.killerRed
        ? { ref, outcome: "fail", durationMs: 5, failureMessage: "No data in company (baseline)" }
        : { ref, outcome: "pass", durationMs: 5 };
    }
    this.mutantRuns += 1;
    const kills = this.o.killerKills && killer;
    return {
      ref,
      outcome: kills ? "fail" : "pass",
      durationMs: 5,
      ...(kills ? { failureMessage: "Assert.AreEqual failed" } : {}),
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

async function project() {
  const root = scratch("lethal-r646c-");
  const dirs = {
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
  };
  await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
  await Bun.write(join(dirs.testDir, "WeakTests.Codeunit.al"), WEAK_AL);
  await Bun.write(join(dirs.testDir, "KillerTests.Codeunit.al"), KILLER_AL);
  await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
  return dirs;
}
type Dirs = Awaited<ReturnType<typeof project>>;
const base = (store: ResultsStore, dirs: Dirs) => ({
  store,
  ...dirs,
  selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
  stopHungSessions: true,
  mutantTimeoutMs: 2_000,
});
const lastRunId = (store: ResultsStore) =>
  (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
const warned = (events: readonly RunEvent[], code: string) =>
  events.some((e) => e.type === "warning" && e.code === code);
const published = (events: readonly RunEvent[]) =>
  events.filter((e) => e.type === "batch-published").length;
/** The killer's outcome in each stored baseline snapshot, by run. */
const snapshotKiller = (store: ResultsStore) =>
  (
    store.db.query("SELECT run_id, payload FROM baseline_snapshots ORDER BY id").all() as Array<{
      run_id: number;
      payload: string;
    }>
  ).map((r) => ({
    run: r.run_id,
    killer: (
      JSON.parse(r.payload) as Array<{ ref: TestMethodRef; verdict: { outcome: string } }>
    ).find((b) => b.ref.codeunitName === "Killer Tests")?.verdict.outcome,
  }));

interface Scenario {
  /** Run A's backend. A finishes with every mutant scored, then is made unfinished. */
  readonly a: StubOpts;
  /** A later fresh run C (killer green, killing) records its own snapshot of the same batch. */
  readonly laterRun?: boolean;
  /** Delete one of A's rows, so that mutant has to run (the witness's way onto the ordinary path). */
  readonly dropOneRow?: boolean;
  /** Delete every baseline snapshot, so the resume has none to reuse. */
  readonly noSnapshot?: boolean;
  /** Rewrite A's first row as a mutant that stranded the tier (R53). */
  readonly strandFirst?: boolean;
}

/** A fully scored run A, made unfinished, then `--resume-run A` with the killer green and killing. */
async function scenario(s: Scenario) {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  await runSession({ ...base(store, dirs), backend: new Stub(s.a) });
  const runA = lastRunId(store);
  const rowsA = store.db
    .query(
      "SELECT mutant_code, verdict, covering_tests FROM mutants WHERE run_id = ? ORDER BY mutant_code",
    )
    .all(runA) as Array<{ mutant_code: string; verdict: string; covering_tests: string }>;
  const first = rowsA[0]?.mutant_code;
  const last = rowsA[rowsA.length - 1]?.mutant_code;
  if (first === undefined || last === undefined) throw new Error("run A recorded no rows");
  if (s.laterRun === true) {
    await runSession({
      ...base(store, dirs),
      backend: new Stub({ killerRed: false, killerKills: true }),
    });
  }
  store.db.query("UPDATE runs SET finished_at = NULL WHERE id = ?").run(runA);
  if (s.dropOneRow === true) {
    store.db.query("DELETE FROM mutants WHERE run_id = ? AND mutant_code = ?").run(runA, last);
  }
  if (s.strandFirst === true) {
    store.db
      .query(
        "UPDATE mutants SET verdict = 'error', failure_note = ? WHERE run_id = ? AND mutant_code = ?",
      )
      .run(QUARANTINED, runA, first);
  }
  if (s.noSnapshot === true) store.db.query("DELETE FROM baseline_snapshots").run();
  const snapshots = snapshotKiller(store);
  const events: RunEvent[] = [];
  const backend = new Stub({ killerRed: false, killerKills: true });
  const report = await runSession({
    ...base(store, dirs),
    backend,
    resume: runA,
    emit: [(e) => events.push(e)],
  });
  store.close();
  return { runA, rowsA, first, snapshots, events, backend, report };
}
const RED_IN_A: StubOpts = { killerRed: true, killerKills: true };
const verdicts = (r: SessionReport) => r.mutants.map((m) => m.verdict);

describe("R-646c: a fully scored batch takes the ordinary path on --resume", () => {
  test("setup: A's survivors faced only Weak (the killer was red at A's baseline)", async () => {
    const h = await scenario({ a: RED_IN_A });
    expect(h.rowsA.length).toBeGreaterThan(1);
    for (const r of h.rowsA) {
      expect(r.verdict).toBe("survived");
      expect(JSON.parse(r.covering_tests)).toEqual(["Weak Tests.Weak"]);
    }
  });

  // Test 1 (measure.md's reach test, now green): a later run C's snapshot has the killer green.
  test("1: C's snapshot has the killer green: A's batch deploys, reuses C's snapshot, and every survivor is re-run and killed", async () => {
    const h = await scenario({ a: RED_IN_A, laterRun: true });
    expect(h.snapshots.map((s) => s.killer)).toEqual(["fail", "pass"]);
    expect(warned(h.events, "resume-batch-carried")).toBe(false);
    expect(published(h.events)).toBe(1);
    expect(warned(h.events, "resume-baseline-reused")).toBe(true);
    expect(warned(h.events, "resume-tests-not-faced")).toBe(true);
    expect(h.report.mutants.filter((m) => m.verdict === "survived" && m.carried === true)).toEqual(
      [],
    );
    expect(new Set(verdicts(h.report))).toEqual(new Set(["killed"]));
  });

  // Test 2: the measurement's witness, unchanged.
  test("2 (witness): with one of A's rows missing, the batch reuses C's snapshot and re-runs every survivor", async () => {
    const h = await scenario({ a: RED_IN_A, laterRun: true, dropOneRow: true });
    expect(h.snapshots.map((s) => s.killer)).toEqual(["fail", "pass"]);
    expect(warned(h.events, "resume-batch-carried")).toBe(false);
    expect(warned(h.events, "resume-baseline-reused")).toBe(true);
    expect(warned(h.events, "resume-tests-not-faced")).toBe(true);
    expect(h.report.mutants.every((m) => m.verdict === "killed")).toBe(true);
  });

  test("3: a survivor batch is never replayed: A's own snapshot, every survivor faced: one deploy, the snapshot reused, every survivor carried, nothing run", async () => {
    const h = await scenario({ a: { killerRed: false, killerKills: false } });
    expect(h.snapshots.map((s) => s.killer)).toEqual(["pass"]);
    expect(warned(h.events, "resume-batch-carried")).toBe(false);
    expect(published(h.events)).toBe(1);
    expect(h.backend.deploys).toBe(1);
    expect(warned(h.events, "resume-baseline-reused")).toBe(true);
    expect(h.backend.mutantRuns).toBe(0);
    expect(h.report.mutants.length).toBe(h.rowsA.length);
    expect(h.report.mutants.every((m) => m.verdict === "survived" && m.carried === true)).toBe(
      true,
    );
  });

  test("4: no snapshot on record: a fresh baseline runs, the killer is green there, and every survivor is re-run and killed", async () => {
    const h = await scenario({ a: RED_IN_A, noSnapshot: true });
    expect(h.snapshots).toEqual([]);
    expect(warned(h.events, "resume-batch-carried")).toBe(false);
    expect(published(h.events)).toBe(1);
    expect(warned(h.events, "resume-baseline-reused")).toBe(false);
    expect(warned(h.events, "resume-tests-not-faced")).toBe(true);
    expect(new Set(verdicts(h.report))).toEqual(new Set(["killed"]));
  });

  test("5: an all-kill batch also takes the ordinary path: one deploy, every kill carried, nothing run", async () => {
    const h = await scenario({ a: { killerRed: false, killerKills: true } });
    expect(h.rowsA.every((r) => r.verdict === "killed")).toBe(true);
    expect(warned(h.events, "resume-batch-carried")).toBe(false);
    expect(published(h.events)).toBe(1);
    expect(h.backend.mutantRuns).toBe(0);
    expect(h.report.mutants.every((m) => m.verdict === "killed" && m.carried === true)).toBe(true);
  });

  test("6 (R53): kills plus a stranded row: the batch deploys, the stranded mutant is skipped (not run, its skip note), the kills carried", async () => {
    const h = await scenario({ a: { killerRed: false, killerKills: true }, strandFirst: true });
    expect(published(h.events)).toBe(1);
    expect(h.backend.activated).not.toContain(h.first);
    expect(h.backend.mutantRuns).toBe(0);
    const stranded = h.report.mutants.filter((m) => m.mutantCode === h.first);
    expect(stranded.map((m) => [m.verdict, m.failureNote])).toEqual([
      ["error", STRANDED_SKIP_NOTE],
    ]);
    const rest = h.report.mutants.filter((m) => m.mutantCode !== h.first);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((m) => m.verdict === "killed" && m.carried === true)).toBe(true);
  });

  test("control (R53): every mutant stranded: nothing is deployed, every one keeps its skip note", async () => {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({
      ...base(store, dirs),
      backend: new Stub({ killerRed: false, killerKills: true }),
    });
    const runA = lastRunId(store);
    store.db
      .query("UPDATE mutants SET verdict = 'error', failure_note = ? WHERE run_id = ?")
      .run(QUARANTINED, runA);
    store.db.query("UPDATE runs SET finished_at = NULL WHERE id = ?").run(runA);
    const events: RunEvent[] = [];
    const backend = new Stub({ killerRed: false, killerKills: true });
    const report = await runSession({
      ...base(store, dirs),
      backend,
      resume: runA,
      emit: [(e) => events.push(e)],
    });
    store.close();
    expect(published(events)).toBe(0);
    expect(backend.mutantRuns).toBe(0);
    expect(report.mutants.length).toBeGreaterThan(0);
    expect(
      report.mutants.every((m) => m.verdict === "error" && m.failureNote === STRANDED_SKIP_NOTE),
    ).toBe(true);
  });
});

// Test 7 needs a backend that reports coverage, so one mutant can be uncovered in the resume.
const LOGIC = { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" };
const EXTRA = { objectType: "Codeunit", objectId: 79002, procedure: "UnderLimit" };

/** bcdev shape: the baseline reports `covered`; every mutant is killed. */
class CoverBackend implements ExecutionBackend {
  mutantRuns = 0;
  readonly activated: string[] = [];
  private active: string | null = null;
  constructor(private readonly covered: ReadonlyArray<typeof LOGIC>) {}
  served: Uint8Array | PackageUnread = testAppPackage();
  async fetchPublishedAppPackage(): Promise<Uint8Array | PackageUnread> {
    return this.served;
  }
  microsoftMode(): MicrosoftMode {
    return servedIsInstalled(() => this.served);
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: "bcdev",
      authoritative: true,
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
    if (id !== null && !this.activated.includes(id)) this.activated.push(id);
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: { granularity: "procedure" as const, entries: [...this.covered] },
      };
    }
    this.mutantRuns += 1;
    return {
      ref,
      outcome: "fail",
      durationMs: 5,
      failureMessage: "Assert.IsTrue failed",
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

describe("R-646c amendment 3: a stranded mutant is skipped before coverage", () => {
  test("7: a stranded mutant uncovered in the resume's coverage keeps its skip note; it is not recorded no-coverage", async () => {
    const root = scratch("lethal-r646c-cov-");
    const dirs = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
    await Bun.write(join(dirs.projectDir, "SandboxExtra.Codeunit.al"), EXTRA_AL);
    await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
    await Bun.write(join(dirs.testDir, "WeakTests.Codeunit.al"), WEAK_AL);
    await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
    const store = new ResultsStore(":memory:");
    const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };
    // Run 1 covers Logic only: Logic's mutants are killed, Extra's are no-coverage.
    await runSession({ backend: new CoverBackend([LOGIC]), store, ...dirs, selectorIds });
    const run1 = lastRunId(store);
    const logic = store.db
      .query(
        "SELECT mutant_code FROM mutants WHERE run_id = ? AND procedure_name = 'IsOverBudget' ORDER BY mutant_code",
      )
      .all(run1) as Array<{ mutant_code: string }>;
    const strandedCode = logic[0]?.mutant_code;
    if (strandedCode === undefined) throw new Error("run 1 scored no Logic mutant");
    store.db
      .query(
        "UPDATE mutants SET verdict = 'error', failure_note = ? WHERE run_id = ? AND mutant_code = ?",
      )
      .run(QUARANTINED, run1, strandedCode);
    store.db.query("UPDATE runs SET finished_at = NULL WHERE id = ?").run(run1);
    // Run 1's snapshot would bring its coverage back (R192); without it the resume measures afresh.
    store.db.query("DELETE FROM baseline_snapshots").run();
    // The resume covers Extra only, so the stranded Logic mutant is uncovered now.
    const backend = new CoverBackend([EXTRA]);
    const report = await runSession({
      backend,
      store,
      ...dirs,
      selectorIds,
      resume: run1,
    });
    store.close();
    expect(backend.activated).not.toContain(strandedCode);
    const rows = report.mutants.filter((m) => m.mutantCode === strandedCode);
    expect(rows.map((m) => [m.verdict, m.failureNote])).toEqual([["error", STRANDED_SKIP_NOTE]]);
  });
});
