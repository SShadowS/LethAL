// R644: `--skip-known-survivors` lends a prior survivor only against tests it actually faced. A
// mutant is scored only against the tests GREEN at its run's baseline; its row's `covering_tests`
// says which. A test red there but green now never ran against it, so it must be re-run, not lent.
// Plan: docs/superpowers/plans/2026-10-22-r644-lend-only-against-faced-tests.md (r2).
// Written test-first. Each direction has its own test: re-run when a covering test now is outside
// the stored set; lend when every one is inside; re-run an EMPTY or NULL record (named
// `history-survivor-no-record`); a lent row keeps the source's list, so a chain still lends. And
// review I1: a failed compile still records a row for every candidate; a resumed run's stranded
// candidate is still skipped (R53).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AlcCompileError } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
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
  name: "Sandbox R644 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

interface StubOpts {
  /** `Killer Tests` fails at BASELINE. */
  readonly killerRed: boolean;
  /** `Killer Tests` fails under any mutant. `Weak Tests` never does. */
  readonly killerKills: boolean;
  /** The SECOND mutant run answers in-flight-unknown: the run is quarantined and left unfinished,
   *  with the first mutant's verdict as something `--resume` can carry. */
  readonly abortSecondMutant?: boolean;
  /** `deploy` throws an `AlcCompileError` (step 3c). */
  readonly compileFails?: boolean;
}

/** al-runner shape (R585's Stub). */
class Stub implements ExecutionBackend {
  mutantRuns = 0;
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
    if (this.o.compileFails === true) throw new AlcCompileError("alc compile failed (stub)");
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
    if (this.o.abortSecondMutant === true && this.activated.length > 1) {
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    }
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
  const root = scratch("lethal-r644-");
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
const known = (r: SessionReport) => r.mutants.filter((m) => m.verdict === "known-survivor");
const historyCodes = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === "warning" && e.code.startsWith("history-") ? [e.code] : []));
const lastRunId = (store: ResultsStore) =>
  (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
const coveringOf = (store: ResultsStore, runId: number) =>
  store.db
    .query("SELECT mutant_code, covering_tests FROM mutants WHERE run_id = ? ORDER BY mutant_code")
    .all(runId) as Array<{ mutant_code: string; covering_tests: string | null }>;

/** A `--skip-known-survivors` session on `store`, collecting its events. */
async function skipping(store: ResultsStore, dirs: Dirs, o: StubOpts, extra: object = {}) {
  const events: RunEvent[] = [];
  const backend = new Stub(o);
  const report = await runSession({
    ...base(store, dirs),
    backend,
    skipKnownSurvivors: true,
    emit: [(e) => events.push(e)],
    ...extra,
  });
  return { report, events, backend };
}

/** Source run, then a `--skip-known-survivors` session on the same suite, scope and test app. */
async function history(source: StubOpts, now: StubOpts) {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  const r1 = await runSession({ ...base(store, dirs), backend: new Stub(source) });
  const sourceBaseline = store.db
    .query(
      "SELECT codeunit_name, method, outcome FROM test_results WHERE mutant_row_id IS NULL ORDER BY id",
    )
    .all();
  const s = await skipping(store, dirs, now);
  store.close();
  return { r1, sourceBaseline, ...s };
}

describe("R644: a survivor lends only against tests it faced", () => {
  test("a test red at the SOURCE baseline, green now: re-run, killed, named history-tests-not-faced", async () => {
    const h = await history(
      { killerRed: true, killerKills: true },
      { killerRed: false, killerKills: true },
    );
    // The source recorded the killer as a failing BASELINE row, and scored survivors without it.
    expect(h.sourceBaseline).toContainEqual({
      codeunit_name: "Killer Tests",
      method: "Strong",
      outcome: "fail",
    });
    expect(h.r1.counts.survived).toBeGreaterThan(0);
    expect(h.r1.counts.killed).toBe(0);
    expect(known(h.report)).toEqual([]);
    expect(h.report.counts.killed).toBe(h.r1.counts.survived);
    expect(historyCodes(h.events)).toEqual(["history-tests-not-faced"]);
  });

  test("control: every test green at both baselines: every survivor lends, nothing runs, no warning", async () => {
    const h = await history(
      { killerRed: false, killerKills: false },
      { killerRed: false, killerKills: true },
    );
    expect(h.r1.counts.survived).toBeGreaterThan(0);
    expect(known(h.report)).toHaveLength(h.r1.counts.survived);
    expect(h.backend.mutantRuns).toBe(0);
    expect(historyCodes(h.events)).toEqual([]);
    // The report shape is unchanged: a lent row lists no test this run ran it against.
    for (const m of known(h.report)) expect(m.coveringTests).toEqual([]);
  });

  test("control: red at BOTH baselines: every survivor lends (it faces nothing new)", async () => {
    const h = await history(
      { killerRed: true, killerKills: true },
      { killerRed: true, killerKills: true },
    );
    expect(h.r1.counts.survived).toBeGreaterThan(0);
    expect(known(h.report)).toHaveLength(h.r1.counts.survived);
    expect(h.backend.mutantRuns).toBe(0);
    expect(historyCodes(h.events)).toEqual([]);
  });
});

describe("R644: no record is re-run, per mutant, named history-survivor-no-record", () => {
  async function withRecord(record: "[]" | null) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const r1 = await runSession({
      ...base(store, dirs),
      backend: new Stub({ killerRed: false, killerKills: false }),
    });
    const src = lastRunId(store);
    const rows = coveringOf(store, src);
    const target = rows[0]?.mutant_code;
    if (target === undefined) throw new Error("no source rows");
    // A lent row stored before R644 (`[]`) or a pre-R192 row (NULL): one mutant only.
    store.db
      .query("UPDATE mutants SET covering_tests = ? WHERE run_id = ? AND mutant_code = ?")
      .run(record, src, target);
    const s = await skipping(store, dirs, { killerRed: false, killerKills: true });
    store.close();
    return { r1, target, ...s };
  }
  for (const record of ["[]", null] as const) {
    test(`a ${record === null ? "NULL" : "[]"} record: that survivor is re-run and killed; the rest lend`, async () => {
      const h = await withRecord(record);
      expect(h.r1.counts.survived).toBeGreaterThan(1);
      const row = h.report.mutants.find((m) => m.mutantCode === h.target);
      expect(row?.verdict).toBe("killed");
      expect(known(h.report)).toHaveLength(h.r1.counts.survived - 1);
      expect(h.backend.activated).toEqual([h.target]);
      expect(historyCodes(h.events)).toEqual(["history-survivor-no-record"]);
    });
  }
});

describe("R644: a lent row keeps the source's list, so a chain still lends", () => {
  test("run 1 scores, run 2 lends, run 3 lends again; run 2's rows hold run 1's lists", async () => {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const green = { killerRed: false, killerKills: false } as const;
    const r1 = await runSession({ ...base(store, dirs), backend: new Stub(green) });
    const run1 = lastRunId(store);
    const r2 = await skipping(store, dirs, green);
    const run2 = lastRunId(store);
    const r3 = await skipping(store, dirs, green);
    const sourceLists = coveringOf(store, run1).filter((r) => r.covering_tests !== "[]");
    const lentLists = coveringOf(store, run2);
    store.close();
    expect(r1.counts.survived).toBeGreaterThan(0);
    expect(known(r2.report)).toHaveLength(r1.counts.survived);
    expect(known(r3.report)).toHaveLength(r1.counts.survived);
    expect(r2.backend.mutantRuns + r3.backend.mutantRuns).toBe(0);
    expect(historyCodes([...r2.events, ...r3.events])).toEqual([]);
    expect(sourceLists.length).toBe(r1.counts.survived);
    expect(lentLists).toEqual(sourceLists);
  });
});

describe("R644 review I1: a candidate stays inside `execute` until after coverage", () => {
  test("a failed compile still records a row for every candidate", async () => {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const r1 = await runSession({
      ...base(store, dirs),
      backend: new Stub({ killerRed: true, killerKills: false }),
    });
    const s = await skipping(store, dirs, {
      killerRed: false,
      killerKills: true,
      compileFails: true,
    });
    store.close();
    expect(r1.counts.survived).toBeGreaterThan(0);
    const codes = s.report.mutants.map((m) => m.mutantCode).sort();
    expect(codes).toEqual(r1.mutants.map((m) => m.mutantCode).sort());
    expect(s.backend.mutantRuns).toBe(0);
  });

  test("a resumed run's stranded candidate is still skipped (R53), never re-run", async () => {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    // Run 1, unfinished: no history yet, so it runs; its second mutant strands the tier. The flag is
    // set because it is part of the fingerprint `--resume` matches.
    const aborted = await skipping(store, dirs, {
      killerRed: false,
      killerKills: true,
      abortSecondMutant: true,
    });
    const stranded = aborted.backend.activated[1];
    if (stranded === undefined) throw new Error("run 1 ran fewer than two mutants");
    // Run 2, finished: the history source. The killer is red there, so nothing it scored is lent
    // to a session where the killer is green.
    const r1 = (await skipping(store, dirs, { killerRed: true, killerKills: false })).report;
    // Run 3: --resume (run 1) and --skip-known-survivors (run 2).
    const s = await skipping(
      store,
      dirs,
      { killerRed: false, killerKills: true },
      { resume: "last" },
    );
    store.close();
    expect(r1.counts.survived).toBeGreaterThan(1);
    expect(s.report.resumedFrom?.runId).toBeDefined();
    expect(s.backend.activated).not.toContain(stranded);
    const rows = s.report.mutants.filter((m) => m.mutantCode === stranded);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe("error");
    expect(rows[0]?.failureNote).toBe(STRANDED_SKIP_NOTE);
  });
});
