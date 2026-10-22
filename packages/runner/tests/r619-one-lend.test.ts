// R619 (plan docs/superpowers/plans/2026-10-22-r619-one-lend-decision.md, r2): R586's T14 cases
// through the four REAL lend sites (history, --resume, --resume-run, baseline-snapshot reuse), by
// effect: lend or not, the throw, the warning code and text. Written first and run on master
// unchanged, as the evidence that moving the sites onto `ResultsStore.runMayLend` moves no outcome.
import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
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
const TESTS_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;

    [Test]
    procedure "Space Step"()
    begin
    end;

    [Test]
    procedure Pond()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91",
  name: "Sandbox R619 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

const V3_VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
/** The build a v3 session of `Stub` records (`version sha`). */
const B1 = `${V3_VERSION} ${"b".repeat(64)}`;
const B2 = `alrunner 3.0.0-alpha.3 (c893e3633) ${"c".repeat(64)}`;

type Kind = "al-runner" | "al-runner-v3";
/** Three tests: the first mutant finishes (carryable), the next one hangs. */
const ABORT_AFTER = 3;

/** The al-runner shape (non-authoritative, test app proven from source), as v2 or v3. Every
 *  mutant survives; `abortAfter` makes the run after that many mutant runs `in-flight-unknown`,
 *  which leaves the run unfinished (resumable). */
class Stub implements ExecutionBackend {
  mutantRuns = 0;
  baselineRuns = 0;
  private active: string | null = null;
  readonly measurePredefinedSymbols = measuredV2_12;
  constructor(
    private readonly kind: Kind,
    private readonly abortAfter?: number,
  ) {}
  capabilities(): BackendCapabilities {
    return {
      kind: this.kind,
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
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) {
      this.baselineRuns += 1;
      return { ref, outcome: "pass", durationMs: 5 };
    }
    this.mutantRuns += 1;
    if (this.abortAfter !== undefined && this.mutantRuns > this.abortAfter) {
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
      outcome: "pass",
      durationMs: 5,
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: V3_VERSION, binarySha256: "b".repeat(64) };
  }
}

async function project() {
  const root = scratch("lethal-r619-");
  const dirs = {
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
  };
  await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
  await Bun.write(join(dirs.testDir, "SandboxTests.Codeunit.al"), TESTS_AL);
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
const lastRun = (store: ResultsStore) =>
  (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
const warned = (events: readonly RunEvent[], code: string) =>
  events.flatMap((e) => (e.type === "warning" && e.code === code ? [e.message] : []));
const known = (r: SessionReport) => r.mutants.filter((m) => m.verdict === "known-survivor");
const carried = (r: SessionReport) => r.mutants.filter((m) => m.carried === true);

/** What a run row is rewritten to before the session that might lend from it. */
interface RunShape {
  readonly backend?: string;
  /** `null` writes NULL; absent leaves the recorded value. */
  readonly runnerBuild?: string | null;
  /** `false` clears the R557 mark (a pre-R557 run). */
  readonly marked?: boolean;
  readonly coverageMode?: string;
}
function reshape(store: ResultsStore, runId: number, s: RunShape): void {
  if (s.backend !== undefined)
    store.db.run("UPDATE runs SET backend = ? WHERE id = ?", [s.backend, runId]);
  if (s.runnerBuild !== undefined) {
    store.db.run("UPDATE runs SET runner_build = ? WHERE id = ?", [s.runnerBuild, runId]);
  }
  if (s.marked !== undefined) {
    store.db.run("UPDATE runs SET al_runner_names = ? WHERE id = ?", [s.marked ? 1 : null, runId]);
  }
  if (s.coverageMode !== undefined) {
    // The fingerprint carries the mode too, as a run recorded under another mode has.
    store.db.run(
      "UPDATE runs SET coverage_mode = ?, config_fingerprint = 'other-mode' WHERE id = ?",
      [s.coverageMode, runId],
    );
  }
}
/** Rewrites one BASELINE row of `runId` as a pre-fix al-runner run recorded it. */
const baselineError = (store: ResultsStore, runId: number, method: string) =>
  store.db.run(
    "UPDATE test_results SET outcome = 'error', failure_message = 'selected no test in this run' WHERE run_id = ? AND mutant_row_id IS NULL AND method = ?",
    [runId, method],
  );

interface Case {
  readonly session: Kind;
  readonly run: RunShape;
  /** A renamed (`Space Step`) or plain (`Pond`) baseline error on the prior run. */
  readonly error?: string;
  /** Part (a): spy `runMayLend` and the step before it into `log`, for the session under test. */
  readonly spy?: boolean;
}

/**
 * Part (a): one shared log, in call order: `runMayLend:<site>:<step | lends | threw>` (calls
 * through), `findResumableRun`, `findBaselineSnapshot`, and `warning:<code>` from the session's
 * emit. Order is asserted by sequence in the log, never by time.
 */
function watch(store: ResultsStore, log: string[]): void {
  const lend = store.runMayLend.bind(store);
  spyOn(store, "runMayLend").mockImplementation((run, session, ctx) => {
    try {
      const r = lend(run, session, ctx);
      log.push(`runMayLend:${ctx.site}:${r?.step ?? "lends"}`);
      return r;
    } catch (err) {
      log.push(`runMayLend:${ctx.site}:threw`);
      throw err;
    }
  });
  const find = store.findResumableRun.bind(store);
  spyOn(store, "findResumableRun").mockImplementation((q) => {
    log.push("findResumableRun");
    return find(q);
  });
  const snap = store.findBaselineSnapshot.bind(store);
  spyOn(store, "findBaselineSnapshot").mockImplementation((...a) => {
    log.push("findBaselineSnapshot");
    return snap(...a);
  });
}
/** The session's emit: events, and with a spy their warning codes into the shared log. */
function collect(store: ResultsStore, spy: boolean | undefined) {
  const events: RunEvent[] = [];
  const log: string[] = [];
  if (spy === true) watch(store, log);
  const emit = (e: RunEvent) => {
    events.push(e);
    if (spy === true && e.type === "warning") log.push(`warning:${e.code}`);
  };
  return { events, log, emit };
}
const lends = (log: readonly string[]) => log.filter((l) => l.startsWith("runMayLend:"));

/** History: run 1 finishes, is reshaped, then a `--skip-known-survivors` session. */
async function history(c: Case) {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  const r1 = await runSession({ ...base(store, dirs), backend: new Stub(c.session) });
  const runId = lastRun(store);
  reshape(store, runId, c.run);
  if (c.error !== undefined) baselineError(store, runId, c.error);
  const { events, log, emit } = collect(store, c.spy);
  const report = await runSession({
    ...base(store, dirs),
    backend: new Stub(c.session),
    skipKnownSurvivors: true,
    emit: [emit],
  });
  store.close();
  return { survived: r1.counts.survived, report, events, runId, log };
}

/** --resume / --resume-run: run 1 aborts (unfinished), is reshaped, then resumed. */
async function resumed(c: Case, how: "last" | "run") {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  await runSession({ ...base(store, dirs), backend: new Stub(c.session, ABORT_AFTER) });
  const runId = lastRun(store);
  reshape(store, runId, c.run);
  if (c.error !== undefined) baselineError(store, runId, c.error);
  const { events, log, emit } = collect(store, c.spy);
  try {
    const report = await runSession({
      ...base(store, dirs),
      backend: new Stub(c.session),
      resume: how === "last" ? "last" : runId,
      retryStranded: true,
      emit: [emit],
    });
    return { report, events, runId, log, error: undefined };
  } catch (err) {
    return { report: undefined, events, runId, log, error: err as Error };
  } finally {
    store.close();
  }
}

const NOT_CARRIED =
  "its verdicts are not carried: every mutant is executed, including any it recorded as stranding the tier (R53), since nothing of it is carried (R557).";
const UNMARKED_WHY =
  "ran on al-runner before R557 (its run row carries no R557 test-name mark), so a test whose al-runner name differs from its AL name may never have run in it, or in a run it carried verdicts from";
const RENAMED_TAIL =
  "ran on al-runner before R557 and recorded 1 test(s) as errors that al-runner never ran (Space Step)";
const renamedWhy = (id: number) => `run ${id} ${RENAMED_TAIL}`;
const otherBackend = (id: number, run: string, session: string) =>
  `run ${id} ran on ${run} and this session runs ${session}; a verdict is lent only within al-runner-v3 (R586)`;
const otherBuild = (id: number, build: string) =>
  `run ${id} ran on al-runner-v3 build ${build}, and this session runs ${B1}; a v3 verdict is lent only to the same build (R586)`;

describe("R619 history (priorSurvivorKeys through runSession): T14's cases", () => {
  const refusedBy = async (c: Case, code: string, text: (id: number) => string) => {
    const h = await history(c);
    expect(h.survived).toBeGreaterThan(0);
    expect(known(h.report)).toEqual([]);
    const w = warned(h.events, code);
    expect(w).toEqual([expect.stringContaining(text(h.runId))]);
    return h;
  };
  const backendBuild = (id: number, why: string) =>
    `[lethal] --skip-known-survivors: ${why}, so no survivor from it is skipped: every mutant is executed.`;

  test("v3 run, v2 session: step 1", async () => {
    await refusedBy(
      { session: "al-runner", run: { backend: "al-runner-v3", runnerBuild: B1 } },
      "history-backend-build-changed",
      (id) => backendBuild(id, otherBackend(id, "al-runner-v3", "al-runner")),
    );
  });
  test("v2 run, v3 session: step 1", async () => {
    await refusedBy(
      { session: "al-runner-v3", run: { backend: "al-runner", runnerBuild: null, marked: true } },
      "history-backend-build-changed",
      (id) => backendBuild(id, otherBackend(id, "al-runner", "al-runner-v3")),
    );
  });
  test("v3 run of another build, and of an unrecorded one: step 1", async () => {
    await refusedBy(
      { session: "al-runner-v3", run: { runnerBuild: B2 } },
      "history-backend-build-changed",
      (id) => backendBuild(id, otherBuild(id, B2)),
    );
    await refusedBy(
      { session: "al-runner-v3", run: { runnerBuild: null } },
      "history-backend-build-changed",
      (id) => backendBuild(id, otherBuild(id, "<unrecorded>")),
    );
  });
  test("v3 run, same build: lends", async () => {
    const h = await history({ session: "al-runner-v3", run: {} });
    expect(h.survived).toBeGreaterThan(0);
    expect(known(h.report)).toHaveLength(h.survived);
  });
  test("bcdev run, v2 session: lends (R592's gap, unchanged)", async () => {
    const h = await history({ session: "al-runner", run: { backend: "bcdev" } });
    expect(known(h.report)).toHaveLength(h.survived);
    expect(h.events.filter((e) => e.type === "warning" && e.code.startsWith("history-"))).toEqual(
      [],
    );
  });
  test("unmarked v2 run: step 2", async () => {
    await refusedBy(
      { session: "al-runner", run: { marked: false } },
      "history-al-runner-test-names",
      (id) =>
        `[lethal] --skip-known-survivors: the latest finished run, run ${id}, ${UNMARKED_WHY}; its survivors may be false, so none is skipped: every mutant is executed (R557).`,
    );
  });
  test("marked v2 run with a renamed baseline error: step 3; a plain-name error lends", async () => {
    await refusedBy(
      { session: "al-runner", run: {}, error: "Space Step" },
      "history-al-runner-test-names",
      (id) =>
        `[lethal] --skip-known-survivors: the latest finished run, run ${id}, ${RENAMED_TAIL}; its survivors may be false, so none is skipped: every mutant is executed (R557).`,
    );
    const plain = await history({ session: "al-runner", run: {}, error: "Pond" });
    expect(known(plain.report)).toHaveLength(plain.survived);
  });
  test("order: an unmarked v3 run of another build names step 1", async () => {
    const h = await refusedBy(
      { session: "al-runner-v3", run: { runnerBuild: B2, marked: false } },
      "history-backend-build-changed",
      (id) => backendBuild(id, otherBuild(id, B2)),
    );
    expect(warned(h.events, "history-al-runner-test-names")).toEqual([]);
  });
  test("order: an unmarked v2 run under another coverage mode names the mode (site check before step 2)", async () => {
    const h = await refusedBy(
      { session: "al-runner", run: { marked: false, coverageMode: "al-runner" } },
      "history-coverage-mode-changed",
      (id) => `the latest finished run, run ${id}, was measured under`,
    );
    expect(warned(h.events, "history-al-runner-test-names")).toEqual([]);
  });
});

/** The resume sites' shared effects. */
const expectWarnedNotCarried = (
  r: Awaited<ReturnType<typeof resumed>>,
  why: (id: number) => string,
) => {
  expect(r.error).toBeUndefined();
  if (r.report === undefined) throw new Error("no report");
  expect(carried(r.report)).toEqual([]);
  // The carry refusal; an unmarked run's own snapshot is refused too, by its own warning.
  expect(
    warned(r.events, "resume-al-runner-test-names").filter((m) => !m.includes("snapshot")),
  ).toEqual([`[lethal] --resume: ${why(r.runId)}; ${NOT_CARRIED}`]);
  expect(r.report.resumedFrom?.carryRefused).toBe(`${why(r.runId)} (R557)`);
};
const expectCarries = (r: Awaited<ReturnType<typeof resumed>>) => {
  expect(r.error).toBeUndefined();
  if (r.report === undefined) throw new Error("no report");
  expect(carried(r.report).length).toBeGreaterThan(0);
  expect(warned(r.events, "resume-al-runner-test-names")).toEqual([]);
};

describe("R619 --resume (resolveResume, last): T14's cases", () => {
  // Review M4: step 1 cannot fire here in production (`findResumableRun`'s SQL already selects the
  // backend and, on v3, the build), so a run step 1 would refuse is simply not found.
  const notFound = /--resume found no unfinished run to resume/;
  test("v3 run, v2 session: not found (SQL)", async () => {
    const r = await resumed(
      { session: "al-runner", run: { backend: "al-runner-v3", runnerBuild: B1 } },
      "last",
    );
    expect(r.error?.message).toMatch(notFound);
  });
  test("v2 run, v3 session: not found (SQL)", async () => {
    const r = await resumed(
      { session: "al-runner-v3", run: { backend: "al-runner", runnerBuild: null } },
      "last",
    );
    expect(r.error?.message).toMatch(notFound);
  });
  test("v3 run of another build, and of an unrecorded one: not found (SQL)", async () => {
    for (const runnerBuild of [B2, null]) {
      const r = await resumed({ session: "al-runner-v3", run: { runnerBuild } }, "last");
      expect(r.error?.message).toMatch(notFound);
    }
  });
  test("v3 run, same build: carries", async () => {
    expectCarries(await resumed({ session: "al-runner-v3", run: {} }, "last"));
  });
  test("v2 run, marked, no renamed error: carries", async () => {
    expectCarries(await resumed({ session: "al-runner", run: {} }, "last"));
  });
  test("unmarked v2 run: step 2 warns, nothing carried", async () => {
    expectWarnedNotCarried(
      await resumed({ session: "al-runner", run: { marked: false } }, "last"),
      (id) => `run ${id} ${UNMARKED_WHY}`,
    );
  });
  test("marked v2 run with a renamed baseline error: step 3 warns, nothing carried", async () => {
    expectWarnedNotCarried(
      await resumed({ session: "al-runner", run: {}, error: "Space Step" }, "last"),
      renamedWhy,
    );
  });
  test("order: an unmarked v2 run under another coverage mode throws R354, with no R557 warning", async () => {
    const r = await resumed(
      { session: "al-runner", run: { marked: false, coverageMode: "al-runner" } },
      "last",
    );
    expect(r.error?.message).toMatch(/--resume found an unfinished run .* \(R354\)/);
    expect(warned(r.events, "resume-al-runner-test-names")).toEqual([]);
  });
  // Build review M-a: R354 above is `findResumableRun`'s, before the lend call, so it cannot pin
  // this branch's order. A test-app change is a site check inside the call: it must win over step 2.
  test("order: an unmarked v2 run with another test app throws R247, with no R557 warning (site check before step 2)", async () => {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), backend: new Stub("al-runner", ABORT_AFTER) });
    const runId = lastRun(store);
    reshape(store, runId, { marked: false });
    store.db.run("UPDATE runs SET test_app_hash = 'package:other' WHERE id = ?", [runId]);
    const { events, emit } = collect(store, false);
    let error: Error | undefined;
    try {
      await runSession({
        ...base(store, dirs),
        backend: new Stub("al-runner"),
        resume: "last",
        retryStranded: true,
        emit: [emit],
      });
    } catch (err) {
      error = err as Error;
    } finally {
      store.close();
    }
    expect(error?.message).toMatch(/none of its verdicts is carried \(R247, R495\)/);
    expect(warned(events, "resume-al-runner-test-names")).toEqual([]);
  });
});

describe("R619 --resume-run (resolveResume, a run id): T14's cases", () => {
  test("v3 run, v2 session; v2 run, v3 session: the backend-equality throw, before step 1", async () => {
    const a = await resumed(
      { session: "al-runner", run: { backend: "al-runner-v3", runnerBuild: B1 } },
      "run",
    );
    expect(a.error?.message).toBe(
      `--resume-run ${a.runId} ran on backend al-runner-v3, but this session uses al-runner — verdicts are not interchangeable across backends (neither local runner, al-runner or al-runner-v3, is authoritative)`,
    );
    const b = await resumed(
      { session: "al-runner-v3", run: { backend: "al-runner", runnerBuild: null } },
      "run",
    );
    expect(b.error?.message).toMatch(
      /ran on backend al-runner, but this session uses al-runner-v3/,
    );
  });
  test("v3 run of another build, and of an unrecorded one: step 1 throws", async () => {
    for (const build of [B2, null]) {
      const r = await resumed({ session: "al-runner-v3", run: { runnerBuild: build } }, "run");
      expect(r.error?.message).toBe(
        `--resume-run ${r.runId}: ${otherBuild(r.runId, build ?? "<unrecorded>")}; none of its verdicts is carried. Drop the resume flag to run from scratch.`,
      );
    }
  });
  test("v3 run, same build: carries", async () => {
    expectCarries(await resumed({ session: "al-runner-v3", run: {} }, "run"));
  });
  test("unmarked v2 run: step 2 warns, nothing carried", async () => {
    expectWarnedNotCarried(
      await resumed({ session: "al-runner", run: { marked: false } }, "run"),
      (id) => `run ${id} ${UNMARKED_WHY}`,
    );
  });
  test("marked v2 run with a renamed baseline error: step 3 warns, nothing carried", async () => {
    expectWarnedNotCarried(
      await resumed({ session: "al-runner", run: {}, error: "Space Step" }, "run"),
      renamedWhy,
    );
  });
  test("order: an unmarked v3 run of another build names step 1", async () => {
    const r = await resumed(
      { session: "al-runner-v3", run: { runnerBuild: B2, marked: false } },
      "run",
    );
    expect(r.error?.message).toContain(otherBuild(r.runId, B2));
  });
  test("order: an unmarked v2 run under another coverage mode throws R354, with no R557 warning", async () => {
    const r = await resumed(
      { session: "al-runner", run: { marked: false, coverageMode: "al-runner" } },
      "run",
    );
    expect(r.error?.message).toMatch(/^--resume-run \d+ was measured under .* \(R354\)/);
    expect(warned(r.events, "resume-al-runner-test-names")).toEqual([]);
  });
});

/**
 * Snapshot: run 1 (the session's own kind) records batch 0's baseline snapshot and aborts; the
 * snapshot is then moved to ANOTHER run `other` shaped by `snap` (`findBaselineSnapshot` lends from
 * any run), and run 2 resumes run 1, which lends, so only the snapshot's run can decide.
 * `payloadError` marks a test `error` in the snapshot's PAYLOAD; `rowsError` records one as a
 * baseline `test_results` row of `other` (review I1: the two must be told apart).
 */
async function snapshotCase(c: {
  readonly session: Kind;
  readonly snap: {
    backend: string;
    runnerBuild?: string | null;
    marked: boolean;
    coverageMode?: string;
  };
  readonly payloadError?: string;
  readonly rowsError?: string;
  /** Ruling (b): the store answers that the snapshot's run row is missing. */
  readonly missingRow?: boolean;
  readonly spy?: boolean;
}) {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  await runSession({ ...base(store, dirs), backend: new Stub(c.session, ABORT_AFTER) });
  const runId = lastRun(store);
  const row = store.getRun(runId);
  if (row === null || row.testAppHash === null || row.testAppDeps === null) {
    throw new Error("run 1 recorded no proven test app");
  }
  const other = store.createRun({
    coverageMode: row.coverageMode ?? "none",
    identityScheme: row.identityScheme,
    buildSymbols: [],
    projectPath: "/elsewhere",
    backend: c.snap.backend,
    appVersion: "0.0.0.0",
    testAppHash: row.testAppHash,
    testAppProven: true,
    testAppDeps: row.testAppDeps,
    ...(c.snap.marked ? { alRunnerNames: true } : {}),
    ...(typeof c.snap.runnerBuild === "string" ? { runnerBuild: c.snap.runnerBuild } : {}),
  });
  if (c.snap.coverageMode !== undefined)
    reshape(store, other, { coverageMode: c.snap.coverageMode });
  store.db.run("UPDATE baseline_snapshots SET run_id = ? WHERE run_id = ?", [other, runId]);
  if (c.payloadError !== undefined) {
    const snap = store.db
      .query("SELECT id, payload FROM baseline_snapshots WHERE run_id = ?")
      .get(other) as { id: number; payload: string };
    const payload = (
      JSON.parse(snap.payload) as Array<{ ref: TestMethodRef; verdict: TestVerdict }>
    ).map((o) =>
      o.ref.method === c.payloadError ? { ...o, verdict: { ...o.verdict, outcome: "error" } } : o,
    );
    store.db.run("UPDATE baseline_snapshots SET payload = ? WHERE id = ?", [
      JSON.stringify(payload),
      snap.id,
    ]);
  }
  if (c.rowsError !== undefined) {
    store.recordTestResult(
      other,
      null,
      null,
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: c.rowsError },
      "error",
      1,
      "selected no test in this run",
    );
  }
  if (c.missingRow === true) {
    const getRun = store.getRun.bind(store);
    store.getRun = (id: number) => (id === other ? null : getRun(id));
  }
  // I1: what `baselineErrorMethods` would answer for the snapshot's run, so each test can show its
  // seed sits in the payload or in the rows, not in both.
  const otherRowErrors = store.baselineErrorMethods(other);
  const today = new Stub(c.session);
  const { events, log, emit } = collect(store, c.spy);
  let error: Error | undefined;
  try {
    await runSession({
      ...base(store, dirs),
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [emit],
    });
  } catch (err) {
    error = err as Error;
  } finally {
    store.close();
  }
  return { events, other, today, error, log, otherRowErrors };
}
const reusedOf = (events: readonly RunEvent[]) => warned(events, "resume-baseline-reused");

describe("R619 baseline-snapshot reuse (scoreBatch through runSession): T14's cases", () => {
  const notReused = (s: Awaited<ReturnType<typeof snapshotCase>>, code: string, text: string) => {
    expect(s.error).toBeUndefined();
    expect(reusedOf(s.events)).toEqual([]);
    expect(s.today.baselineRuns).toBeGreaterThan(0);
    expect(warned(s.events, code)).toEqual([text]);
  };
  const backendBuild = (other: number, why: string) =>
    `[lethal] run ${other}'s batch 0 baseline snapshot is not reused: ${why}. Batch 0's baseline is re-run.`;

  test("v3 snapshot, v2 session; v2 snapshot, v3 session: step 1", async () => {
    const a = await snapshotCase({
      session: "al-runner",
      snap: { backend: "al-runner-v3", runnerBuild: B1, marked: false },
    });
    notReused(
      a,
      "snapshot-backend-build-changed",
      backendBuild(a.other, otherBackend(a.other, "al-runner-v3", "al-runner")),
    );
    const b = await snapshotCase({
      session: "al-runner-v3",
      snap: { backend: "al-runner", marked: true },
    });
    notReused(
      b,
      "snapshot-backend-build-changed",
      backendBuild(b.other, otherBackend(b.other, "al-runner", "al-runner-v3")),
    );
  });
  test("v3 snapshot of another build, and of an unrecorded one: step 1", async () => {
    for (const build of [B2, null]) {
      const s = await snapshotCase({
        session: "al-runner-v3",
        snap: { backend: "al-runner-v3", runnerBuild: build, marked: false },
      });
      notReused(
        s,
        "snapshot-backend-build-changed",
        backendBuild(s.other, otherBuild(s.other, build ?? "<unrecorded>")),
      );
    }
  });
  test("v3 snapshot, same build: reused", async () => {
    const s = await snapshotCase({
      session: "al-runner-v3",
      snap: { backend: "al-runner-v3", runnerBuild: B1, marked: false },
    });
    expect(s.error).toBeUndefined();
    expect(reusedOf(s.events)).toHaveLength(1);
  });
  test("bcdev snapshot, v2 session: reused (R592's gap, unchanged)", async () => {
    const s = await snapshotCase({
      session: "al-runner",
      snap: { backend: "bcdev", marked: false },
    });
    expect(reusedOf(s.events)).toHaveLength(1);
  });
  test("unmarked v2 snapshot: step 2", async () => {
    const s = await snapshotCase({
      session: "al-runner",
      snap: { backend: "al-runner", marked: false },
    });
    notReused(
      s,
      "resume-al-runner-test-names",
      `[lethal] --resume: run ${s.other}'s batch 0 baseline snapshot is not reused: run ${s.other} ${UNMARKED_WHY}. Batch 0's baseline is re-run (R557).`,
    );
  });
  test("I1: a renamed error in the snapshot PAYLOAD only: step 3 refuses", async () => {
    const s = await snapshotCase({
      session: "al-runner",
      snap: { backend: "al-runner", marked: true },
      payloadError: "Space Step",
    });
    expect(s.otherRowErrors).toEqual([]);
    notReused(
      s,
      "resume-al-runner-test-names",
      `[lethal] --resume: run ${s.other}'s batch 0 baseline snapshot ran on al-runner before R557 and recorded 1 test(s) as errors that al-runner never ran (Space Step); it is not reused: batch 0's baseline is re-run (R557).`,
    );
  });
  test("I1: a renamed error in the run's test_results only: NOT refused (step 3 reads the snapshot's own rows)", async () => {
    const s = await snapshotCase({
      session: "al-runner",
      snap: { backend: "al-runner", marked: true },
      rowsError: "Space Step",
    });
    expect(s.otherRowErrors).toEqual(["Space Step"]);
    expect(s.error).toBeUndefined();
    expect(reusedOf(s.events)).toHaveLength(1);
    expect(warned(s.events, "resume-al-runner-test-names")).toEqual([]);
  });
  test("order: an unmarked v3 snapshot of another build names step 1", async () => {
    const s = await snapshotCase({
      session: "al-runner-v3",
      snap: { backend: "al-runner-v3", runnerBuild: B2, marked: false },
    });
    notReused(s, "snapshot-backend-build-changed", backendBuild(s.other, otherBuild(s.other, B2)));
  });
  test("order: an unmarked v2 snapshot under another coverage mode is not found (SQL), silently", async () => {
    const s = await snapshotCase({
      session: "al-runner",
      snap: { backend: "al-runner", marked: false, coverageMode: "al-runner" },
    });
    expect(s.error).toBeUndefined();
    expect(reusedOf(s.events)).toEqual([]);
    expect(warned(s.events, "resume-al-runner-test-names")).toEqual([]);
    expect(warned(s.events, "snapshot-backend-build-changed")).toEqual([]);
  });
});

describe("R619 ruling (b): a snapshot whose run row is missing throws", () => {
  test("the store finds the snapshot but not its run: the session throws, nothing is reused", async () => {
    const s = await snapshotCase({
      session: "al-runner",
      snap: { backend: "al-runner", marked: true },
      missingRow: true,
    });
    // Reuse first: before the ruling the snapshot was silently reused here.
    expect(reusedOf(s.events)).toEqual([]);
    expect(s.error?.message).toBe(
      `run ${s.other}'s batch 0 baseline snapshot names run ${s.other}, which this database does not hold (R619)`,
    );
  });
});

// --- Part (a): each site makes exactly ONE `runMayLend` call, and it is the one that decides ----

describe("R619 spy: history calls runMayLend once per batch, and its step is the refusal", () => {
  test("A1: a lending run: one `history:lends`, and its survivors are the known survivors", async () => {
    const h = await history({ session: "al-runner", run: {}, spy: true });
    expect(lends(h.log)).toEqual(["runMayLend:history:lends"]);
    expect(known(h.report)).toHaveLength(h.survived);
  });
  test("each refusal is the step runMayLend returned", async () => {
    const cases: Array<[Case, string]> = [
      [{ session: "al-runner-v3", run: { runnerBuild: B2 } }, "backend-build"],
      [{ session: "al-runner", run: { marked: false } }, "al-runner-unmarked"],
      [{ session: "al-runner", run: {}, error: "Space Step" }, "al-runner-renamed"],
      // The site's own checks run inside the call, before step 2.
      [{ session: "al-runner", run: { marked: false, coverageMode: "al-runner" } }, "site"],
    ];
    for (const [c, step] of cases) {
      const h = await history({ ...c, spy: true });
      expect(lends(h.log), step).toEqual([`runMayLend:history:${step}`]);
    }
  });
});

describe("R619 spy: --resume calls runMayLend once, after findResumableRun", () => {
  test("A2: a lending run", async () => {
    const r = await resumed({ session: "al-runner", run: {}, spy: true }, "last");
    expect(r.error).toBeUndefined();
    expect(r.log.slice(0, 2)).toEqual(["findResumableRun", "runMayLend:resume:lends"]);
    expect(r.log.filter((l) => l.startsWith("runMayLend:resume:"))).toHaveLength(1);
  });
  test("steps 2 and 3 are the steps runMayLend returned; the warning follows the call", async () => {
    for (const [c, step] of [
      [{ session: "al-runner", run: { marked: false } }, "al-runner-unmarked"],
      [{ session: "al-runner", run: {}, error: "Space Step" }, "al-runner-renamed"],
    ] as Array<[Case, string]>) {
      const r = await resumed({ ...c, spy: true }, "last");
      expect(r.log.slice(0, 3), step).toEqual([
        "findResumableRun",
        `runMayLend:resume:${step}`,
        "warning:resume-al-runner-test-names",
      ]);
    }
  });
  test("a run the SQL does not find is never lent from: no call", async () => {
    const r = await resumed(
      { session: "al-runner-v3", run: { runnerBuild: B2 }, spy: true },
      "last",
    );
    expect(r.error).toBeDefined();
    expect(lends(r.log)).toEqual([]);
  });
});

describe("R619 spy: --resume-run calls runMayLend once", () => {
  test("A3: a lending run", async () => {
    const r = await resumed({ session: "al-runner-v3", run: {}, spy: true }, "run");
    expect(r.error).toBeUndefined();
    expect(r.log[0]).toBe("runMayLend:resume-run:lends");
    expect(r.log.filter((l) => l.startsWith("runMayLend:resume-run:"))).toHaveLength(1);
  });
  test("step 1 (reachable here, unlike --resume: review M4), the site checks, and step 2", async () => {
    for (const [c, step] of [
      [{ session: "al-runner-v3", run: { runnerBuild: B2 } }, "backend-build"],
      // A site check throws inside the call: the throw is the refusal.
      [{ session: "al-runner", run: { marked: false, coverageMode: "al-runner" } }, "threw"],
      [{ session: "al-runner", run: { marked: false } }, "al-runner-unmarked"],
      [{ session: "al-runner", run: {}, error: "Space Step" }, "al-runner-renamed"],
    ] as Array<[Case, string]>) {
      const r = await resumed({ ...c, spy: true }, "run");
      expect(r.log[0], step).toBe(`runMayLend:resume-run:${step}`);
      expect(r.log.filter((l) => l.startsWith("runMayLend:resume-run:"))).toHaveLength(1);
    }
  });
  test("the backend-equality throw comes before the call: no call", async () => {
    const r = await resumed(
      { session: "al-runner", run: { backend: "al-runner-v3", runnerBuild: B1 }, spy: true },
      "run",
    );
    expect(r.error).toBeDefined();
    expect(lends(r.log)).toEqual([]);
  });
});

describe("R619 spy: snapshot reuse calls runMayLend once, after findBaselineSnapshot", () => {
  const snapshotLog = (log: readonly string[]) =>
    log.filter(
      (l) =>
        l === "findBaselineSnapshot" ||
        l.startsWith("runMayLend:snapshot:") ||
        l === "warning:resume-baseline-reused",
    );
  test("A4: a reused snapshot", async () => {
    const s = await snapshotCase({
      session: "al-runner",
      snap: { backend: "al-runner", marked: true },
      spy: true,
    });
    expect(snapshotLog(s.log)).toEqual([
      "findBaselineSnapshot",
      "runMayLend:snapshot:lends",
      "warning:resume-baseline-reused",
    ]);
  });
  test("each refusal is the step runMayLend returned", async () => {
    for (const [c, step] of [
      [{ snap: { backend: "al-runner-v3", runnerBuild: B2, marked: false } }, "backend-build"],
      [{ snap: { backend: "al-runner", marked: false } }, "al-runner-unmarked"],
      [
        { snap: { backend: "al-runner", marked: true }, payloadError: "Space Step" },
        "al-runner-renamed",
      ],
      // I1: the run's own rows do not decide.
      [{ snap: { backend: "al-runner", marked: true }, rowsError: "Space Step" }, "lends"],
    ] as const) {
      const s = await snapshotCase({
        session: c.snap.backend === "al-runner-v3" ? "al-runner-v3" : "al-runner",
        ...c,
        spy: true,
      });
      expect(
        s.log.filter((l) => l === "findBaselineSnapshot" || l.startsWith("runMayLend:snapshot:")),
        step,
      ).toEqual(["findBaselineSnapshot", `runMayLend:snapshot:${step}`]);
    }
  });
});
