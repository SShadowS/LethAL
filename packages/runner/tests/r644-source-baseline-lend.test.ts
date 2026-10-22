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
    // Run 2, finished: the history source. Its survivors are given NO record (`[]`, as a row lent
    // before R644 holds), so none is lent and each takes the ordinary path. (A red killer would not
    // do: `--resume` may reuse run 2's own baseline snapshot, where the killer is red again.)
    const r1 = (await skipping(store, dirs, { killerRed: false, killerKills: false })).report;
    store.db
      .query("UPDATE mutants SET covering_tests = '[]' WHERE run_id = ?")
      .run(lastRunId(store));
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

/** A finished all-green source run whose killer kills nothing: every mutant survives. */
async function greenSource() {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  const r1 = await runSession({
    ...base(store, dirs),
    backend: new Stub({ killerRed: false, killerKills: false }),
  });
  const src = lastRunId(store);
  const rows = coveringOf(store, src);
  return { dirs, store, r1, src, rows };
}
const isKiller = (name: string) => name.startsWith("Killer Tests");

describe("R644 (build review I1): the plan tests the first build lacked", () => {
  test("(4) per mutant: in one batch, the survivor that did not face the killer is re-run, the others lend", async () => {
    const g = await greenSource();
    const target = g.rows[0];
    if (target === undefined || target.covering_tests === null) throw new Error("no source rows");
    const faced = (JSON.parse(target.covering_tests) as string[]).filter((t) => !isKiller(t));
    expect(faced.length).toBeGreaterThan(0);
    // That one survivor was scored while the killer was red: its list lacks the killer.
    g.store.db
      .query("UPDATE mutants SET covering_tests = ? WHERE run_id = ? AND mutant_code = ?")
      .run(JSON.stringify(faced), g.src, target.mutant_code);
    const s = await skipping(g.store, g.dirs, { killerRed: false, killerKills: true });
    g.store.close();
    expect(g.r1.counts.survived).toBeGreaterThan(1);
    expect(s.backend.activated).toEqual([target.mutant_code]);
    expect(s.report.mutants.find((m) => m.mutantCode === target.mutant_code)?.verdict).toBe(
      "killed",
    );
    expect(known(s.report)).toHaveLength(g.r1.counts.survived - 1);
    expect(historyCodes(s.events)).toEqual(["history-tests-not-faced"]);
  });

  test("(6) a malformed covering_tests record throws by name; it is never read as empty", async () => {
    const g = await greenSource();
    const target = g.rows[0]?.mutant_code;
    g.store.db
      .query("UPDATE mutants SET covering_tests = ? WHERE run_id = ? AND mutant_code = ?")
      .run("{not json", g.src, target ?? "");
    const backend = new Stub({ killerRed: false, killerKills: true });
    await expect(
      runSession({ ...base(g.store, g.dirs), backend, skipKnownSurvivors: true }),
    ).rejects.toThrow(/corrupt "covering_tests"/);
    g.store.close();
    expect(backend.mutantRuns).toBe(0);
  });

  test("(8) a source refused at run level gets only its own refusal, no R644 warning", async () => {
    const g = await greenSource();
    // Refused by R585's scope check (NULL scope), with rows that WOULD warn no-record if R644 saw them.
    g.store.db.query("UPDATE runs SET test_scope = NULL WHERE id = ?").run(g.src);
    g.store.db.query("UPDATE mutants SET covering_tests = '[]' WHERE run_id = ?").run(g.src);
    const s = await skipping(g.store, g.dirs, { killerRed: false, killerKills: true });
    g.store.close();
    expect(known(s.report)).toEqual([]);
    expect(historyCodes(s.events)).toEqual(["history-test-scope-changed"]);
  });

  test("minor 4: an AMBIGUOUS site match (two rows, different lists) is re-run, not lent", async () => {
    const g = await greenSource();
    const target = g.rows[0]?.mutant_code;
    if (target === undefined) throw new Error("no source rows");
    // Rule 1 off (another generation hash), so every match goes through rule 2, the site.
    g.store.db
      .query("UPDATE runs SET generation_source_sha256 = 'other-generation' WHERE id = ?")
      .run(g.src);
    // A second survivor row on the target's site whose list differs. The FIRST row (the original)
    // holds the full list, so a rule that kept the first list would lend it.
    const cols = (g.store.db.query("PRAGMA table_info(mutants)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n !== "id" && n !== "covering_tests");
    g.store.db
      .query(
        `INSERT INTO mutants (${cols.join(", ")}, covering_tests) SELECT ${cols.join(", ")}, '["Weak Tests.Weak"]' FROM mutants WHERE run_id = ? AND mutant_code = ?`,
      )
      .run(g.src, target);
    const s = await skipping(g.store, g.dirs, { killerRed: false, killerKills: true });
    g.store.close();
    // The other survivors still lend through their sites; the ambiguous one is re-run.
    expect(known(s.report)).toHaveLength(g.r1.counts.survived - 1);
    expect(s.backend.activated).toEqual([target]);
    expect(historyCodes(s.events)).toEqual(["history-survivor-no-record"]);
  });
});

describe("R644 (build review I2, plan test 7): a source survivor carried by --resume", () => {
  /** Run A (unfinished) scores its first mutant M and strands the second; run B resumes A and
   *  finishes, carrying M; run C is a history session from B. A's snapshot is deleted so B's
   *  baseline really runs (a reused snapshot would bring A's red killer back). */
  async function carriedSource(killerRedInA: boolean) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const a = await skipping(store, dirs, {
      killerRed: killerRedInA,
      killerKills: false,
      abortSecondMutant: true,
    });
    const m = a.backend.activated[0];
    if (m === undefined) throw new Error("run A ran no mutant");
    store.db.query("DELETE FROM baseline_snapshots").run();
    const b = await skipping(
      store,
      dirs,
      { killerRed: false, killerKills: false },
      { resume: "last" },
    );
    const runB = lastRunId(store);
    const carriedRow = store.db
      .query(
        "SELECT verdict, carried, covering_tests FROM mutants WHERE run_id = ? AND mutant_code = ?",
      )
      .get(runB, m) as { verdict: string; carried: number; covering_tests: string | null };
    const c = await skipping(store, dirs, { killerRed: false, killerKills: true });
    store.close();
    return { m, b, carriedRow, c };
  }

  test("M faced only the weak test in A; B's baseline turns the killer green: since R646 B re-runs M, so its row lists the killer", async () => {
    const h = await carriedSource(true);
    // Before R646, B carried M and the I2 fix kept A's list. Now B does not carry M at all: it runs
    // M against the killer (which does not kill in B), so C lends a survivor that faced it.
    expect(h.carriedRow.verdict).toBe("survived");
    expect(h.carriedRow.carried).toBe(0);
    expect((JSON.parse(h.carriedRow.covering_tests ?? "[]") as string[]).some(isKiller)).toBe(true);
    expect(h.c.backend.activated).not.toContain(h.m);
    expect(h.c.report.mutants.find((x) => x.mutantCode === h.m)?.verdict).toBe("known-survivor");
  });

  test("control: M faced every test in A; C lends it from B's carried row", async () => {
    const h = await carriedSource(false);
    expect(h.carriedRow.carried).toBe(1);
    expect(h.c.backend.activated).not.toContain(h.m);
    expect(h.c.report.mutants.find((x) => x.mutantCode === h.m)?.verdict).toBe("known-survivor");
  });
});

// R646: `--resume` carries a survivor only when every test covering it NOW is one it faced in the
// run that scored it (R644's rule, in step 5b). A kill carries whatever covers it now.
const FACE_CODES = new Set(["resume-tests-not-faced", "resume-survivor-no-record"]);
const faceCodes = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === "warning" && FACE_CODES.has(e.code) ? [e.code] : []));
const batchCarried = (events: readonly RunEvent[]) =>
  events.some((e) => e.type === "warning" && e.code === "resume-batch-carried");

describe("R646: --resume carries a survivor only against tests it faced", () => {
  /** Run 1 (unfinished) scores its first mutant M and strands the second. `edit` may rewrite M's
   *  row before run 2 resumes it. Run 1's snapshot is deleted so run 2's baseline really runs. */
  async function resumed(
    run1: { killerRed: boolean; killerKills: boolean },
    run2: { killerRed: boolean; killerKills: boolean },
    edit?: (store: ResultsStore, run1Id: number, m: string) => void,
  ) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const backend1 = new Stub({ ...run1, abortSecondMutant: true });
    await runSession({ ...base(store, dirs), backend: backend1 });
    const m = backend1.activated[0];
    if (m === undefined) throw new Error("run 1 ran no mutant");
    edit?.(store, lastRunId(store), m);
    store.db.query("DELETE FROM baseline_snapshots").run();
    const events: RunEvent[] = [];
    const backend = new Stub(run2);
    const report = await runSession({
      ...base(store, dirs),
      backend,
      resume: "last",
      emit: [(e) => events.push(e)],
    });
    store.close();
    const row = report.mutants.find((x) => x.mutantCode === m);
    return { m, report, events, backend, row };
  }

  test("reproduction: M scored while the killer was red; the resume's baseline has it green: M re-runs, killed (resume-tests-not-faced)", async () => {
    const h = await resumed(
      { killerRed: true, killerKills: true },
      { killerRed: false, killerKills: true },
    );
    expect(h.report.resumedFrom?.runId).toBeDefined();
    expect(h.backend.activated).toContain(h.m);
    expect(h.row?.verdict).toBe("killed");
    expect(h.row?.carried).not.toBe(true);
    expect(faceCodes(h.events)).toEqual(["resume-tests-not-faced"]);
  });

  test("control: M faced every test covering it now: carried as survived, not run, no warning", async () => {
    const h = await resumed(
      { killerRed: false, killerKills: false },
      { killerRed: false, killerKills: true },
    );
    expect(h.backend.activated).not.toContain(h.m);
    expect(h.row?.verdict).toBe("survived");
    expect(h.row?.carried).toBe(true);
    expect(faceCodes(h.events)).toEqual([]);
  });

  for (const record of ["[]", null] as const) {
    test(`a ${record === null ? "NULL" : "[]"} record: M re-runs, killed (resume-survivor-no-record)`, async () => {
      const h = await resumed(
        { killerRed: false, killerKills: false },
        { killerRed: false, killerKills: true },
        (store, id, m) =>
          store.db
            .query("UPDATE mutants SET covering_tests = ? WHERE run_id = ? AND mutant_code = ?")
            .run(record, id, m),
      );
      expect(h.backend.activated).toContain(h.m);
      expect(h.row?.verdict).toBe("killed");
      expect(faceCodes(h.events)).toEqual(["resume-survivor-no-record"]);
    });
  }

  test("a carried KILL is carried even with no record: a kill stands whatever covers it now", async () => {
    const h = await resumed(
      { killerRed: false, killerKills: true },
      { killerRed: false, killerKills: true },
      (store, id, m) =>
        store.db
          .query("UPDATE mutants SET covering_tests = '[]' WHERE run_id = ? AND mutant_code = ?")
          .run(id, m),
    );
    expect(h.backend.activated).not.toContain(h.m);
    expect(h.row?.verdict).toBe("killed");
    expect(h.row?.carried).toBe(true);
    expect(faceCodes(h.events)).toEqual([]);
  });

  /** A finished all-green run made unfinished, so `--resume` replays its one batch whole (R192). */
  async function replayable(emptyRecord: boolean) {
    const g = await greenSource();
    const target = g.rows[0]?.mutant_code;
    if (target === undefined) throw new Error("no source rows");
    g.store.db.query("UPDATE runs SET finished_at = NULL WHERE id = ?").run(g.src);
    if (emptyRecord) {
      g.store.db
        .query("UPDATE mutants SET covering_tests = '[]' WHERE run_id = ? AND mutant_code = ?")
        .run(g.src, target);
    }
    const events: RunEvent[] = [];
    const backend = new Stub({ killerRed: false, killerKills: true });
    const report = await runSession({
      ...base(g.store, g.dirs),
      backend,
      resume: "last",
      emit: [(e) => events.push(e)],
    });
    g.store.close();
    return { target, report, events, backend };
  }

  test("whole-batch replay: a survivor with an empty record forces the ordinary path; it re-runs", async () => {
    const h = await replayable(true);
    expect(batchCarried(h.events)).toBe(false);
    expect(h.backend.activated).toEqual([h.target]);
    expect(h.report.mutants.find((x) => x.mutantCode === h.target)?.verdict).toBe("killed");
    expect(faceCodes(h.events)).toEqual(["resume-survivor-no-record"]);
  });

  test("control: whole-batch replay with every survivor recorded: replayed, nothing runs", async () => {
    const h = await replayable(false);
    expect(batchCarried(h.events)).toBe(true);
    expect(h.backend.mutantRuns).toBe(0);
    expect(faceCodes(h.events)).toEqual([]);
  });
});
