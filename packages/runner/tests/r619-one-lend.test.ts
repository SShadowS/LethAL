// R619 (plan docs/superpowers/plans/2026-10-22-r619-one-lend-decision.md, r2): R586's T14 cases
// through the four REAL lend sites (history, --resume, --resume-run, baseline-snapshot reuse), by
// effect: lend or not, the throw, the warning code and text. Written first and run on master
// unchanged, as the evidence that moving the sites onto `ResultsStore.runMayLend` moves no outcome.
//
// R654 S3 retired the .NET al-runner. Every session here is al-runner-v3 (plan r1 I2: v3 with build
// B1); the other backend a row can name is bcdev, or the retired "al-runner", which every site
// refuses by name (`al-runner-v2-retired`). R557's mark and renamed-test cases went with v2.
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
import { AlRunnerV2RetiredError } from "../src/v2-retired";
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

/** Three tests: the first mutant finishes (carryable), the next one hangs. */
const ABORT_AFTER = 3;

/** An al-runner-v3 shape (non-authoritative, test app proven from source), build B1. Every
 *  mutant survives; `abortAfter` makes the run after that many mutant runs `in-flight-unknown`,
 *  which leaves the run unfinished (resumable). */
class Stub implements ExecutionBackend {
  mutantRuns = 0;
  baselineRuns = 0;
  private active: string | null = null;
  constructor(private readonly abortAfter?: number) {}
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
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
  readonly coverageMode?: string;
}
function reshape(store: ResultsStore, runId: number, s: RunShape): void {
  if (s.backend !== undefined)
    store.db.run("UPDATE runs SET backend = ? WHERE id = ?", [s.backend, runId]);
  if (s.runnerBuild !== undefined) {
    store.db.run("UPDATE runs SET runner_build = ? WHERE id = ?", [s.runnerBuild, runId]);
  }
  if (s.coverageMode !== undefined) {
    // The fingerprint carries the mode too, as a run recorded under another mode has.
    store.db.run(
      "UPDATE runs SET coverage_mode = ?, config_fingerprint = 'other-mode' WHERE id = ?",
      [s.coverageMode, runId],
    );
  }
}

interface Case {
  readonly run: RunShape;
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
  const r1 = await runSession({ ...base(store, dirs), backend: new Stub() });
  const runId = lastRun(store);
  reshape(store, runId, c.run);
  const { events, log, emit } = collect(store, c.spy);
  const report = await runSession({
    ...base(store, dirs),
    backend: new Stub(),
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
  await runSession({ ...base(store, dirs), backend: new Stub(ABORT_AFTER) });
  const runId = lastRun(store);
  reshape(store, runId, c.run);
  const { events, log, emit } = collect(store, c.spy);
  try {
    const report = await runSession({
      ...base(store, dirs),
      backend: new Stub(),
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

const otherBackend = (id: number, run: string, session: string) =>
  `run ${id} ran on ${run} and this session runs ${session}; a verdict is lent only within al-runner-v3 (R586)`;
const otherBuild = (id: number, build: string) =>
  `run ${id} ran on al-runner-v3 build ${build}, and this session runs ${B1}; a v3 verdict is lent only to the same build (R586)`;
/** R654 F3: what every site says of a stored run of the retired .NET al-runner. */
const retired = (id: number) =>
  `al-runner-v2-retired: run ${id} ran on the retired .NET al-runner (R654); nothing of it is lent`;

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

  test("bcdev run, v3 session: step 1", async () => {
    await refusedBy(
      { run: { backend: "bcdev", runnerBuild: null } },
      "history-backend-build-changed",
      (id) => backendBuild(id, otherBackend(id, "bcdev", "al-runner-v3")),
    );
  });
  test("R654 F3: a retired al-runner run, v3 session: step 1, by name", async () => {
    await refusedBy(
      { run: { backend: "al-runner", runnerBuild: null } },
      "history-backend-build-changed",
      (id) => backendBuild(id, retired(id)),
    );
  });
  test("v3 run of another build, and of an unrecorded one: step 1", async () => {
    await refusedBy({ run: { runnerBuild: B2 } }, "history-backend-build-changed", (id) =>
      backendBuild(id, otherBuild(id, B2)),
    );
    await refusedBy({ run: { runnerBuild: null } }, "history-backend-build-changed", (id) =>
      backendBuild(id, otherBuild(id, "<unrecorded>")),
    );
  });
  test("v3 run, same build: lends", async () => {
    const h = await history({ run: {} });
    expect(h.survived).toBeGreaterThan(0);
    expect(known(h.report)).toHaveLength(h.survived);
    expect(h.events.filter((e) => e.type === "warning" && e.code.startsWith("history-"))).toEqual(
      [],
    );
  });
  test("order: a same-build run under another coverage mode names the mode (site check after step 1)", async () => {
    await refusedBy(
      { run: { coverageMode: "al-runner" } },
      "history-coverage-mode-changed",
      (id) => `the latest finished run, run ${id}, was measured under`,
    );
  });
  test("order (R654): a retired al-runner run under another coverage mode names step 1", async () => {
    const h = await refusedBy(
      { run: { backend: "al-runner", runnerBuild: null, coverageMode: "al-runner" } },
      "history-backend-build-changed",
      (id) => backendBuild(id, retired(id)),
    );
    expect(warned(h.events, "history-coverage-mode-changed")).toEqual([]);
  });
});

const expectCarries = (r: Awaited<ReturnType<typeof resumed>>) => {
  expect(r.error).toBeUndefined();
  if (r.report === undefined) throw new Error("no report");
  expect(carried(r.report).length).toBeGreaterThan(0);
};

describe("R619 --resume (resolveResume, last): T14's cases", () => {
  // Review M4: step 1 cannot fire here in production (`findResumableRun`'s SQL already selects the
  // backend and, on v3, the build), so a run step 1 would refuse is simply not found.
  const notFound = /--resume found no unfinished run to resume/;
  test("bcdev run, v3 session: not found (SQL)", async () => {
    const r = await resumed({ run: { backend: "bcdev", runnerBuild: null } }, "last");
    expect(r.error?.message).toMatch(notFound);
  });
  test("retired al-runner run, v3 session: not found (SQL)", async () => {
    const r = await resumed({ run: { backend: "al-runner", runnerBuild: null } }, "last");
    expect(r.error?.message).toMatch(notFound);
  });
  test("v3 run of another build, and of an unrecorded one: not found (SQL)", async () => {
    for (const runnerBuild of [B2, null]) {
      const r = await resumed({ run: { runnerBuild } }, "last");
      expect(r.error?.message).toMatch(notFound);
    }
  });
  test("v3 run, same build: carries", async () => {
    expectCarries(await resumed({ run: {} }, "last"));
  });
  test("order: a run under another coverage mode throws R354", async () => {
    const r = await resumed({ run: { coverageMode: "al-runner" } }, "last");
    expect(r.error?.message).toMatch(/--resume found an unfinished run .* \(R354\)/);
  });
  // Build review M-a: R354 above is `findResumableRun`'s, before the lend call. A test-app change
  // is a site check inside the call.
  test("a run with another test app throws R247 (a site check, inside the call)", async () => {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), backend: new Stub(ABORT_AFTER) });
    const runId = lastRun(store);
    store.db.run("UPDATE runs SET test_app_hash = 'package:other' WHERE id = ?", [runId]);
    const { emit } = collect(store, false);
    let error: Error | undefined;
    try {
      await runSession({
        ...base(store, dirs),
        backend: new Stub(),
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
  });
});

describe("R619 --resume-run (resolveResume, a run id): T14's cases", () => {
  test("bcdev run, v3 session: the backend-equality throw, before step 1", async () => {
    const r = await resumed({ run: { backend: "bcdev", runnerBuild: null } }, "run");
    expect(r.error?.message).toBe(
      `--resume-run ${r.runId} ran on backend bcdev, but this session uses al-runner-v3 — verdicts are not interchangeable across backends (al-runner-v3 is not authoritative)`,
    );
  });
  test("R654 F3: a retired al-runner run: refused by name, before the backend-equality throw", async () => {
    const r = await resumed({ run: { backend: "al-runner", runnerBuild: null } }, "run");
    expect(r.error).toBeInstanceOf(AlRunnerV2RetiredError);
    expect(r.error?.message).toBe(retired(r.runId));
  });
  test("v3 run of another build, and of an unrecorded one: step 1 throws", async () => {
    for (const build of [B2, null]) {
      const r = await resumed({ run: { runnerBuild: build } }, "run");
      expect(r.error?.message).toBe(
        `--resume-run ${r.runId}: ${otherBuild(r.runId, build ?? "<unrecorded>")}; none of its verdicts is carried. Drop the resume flag to run from scratch.`,
      );
    }
  });
  test("v3 run, same build: carries", async () => {
    expectCarries(await resumed({ run: {} }, "run"));
  });
  test("order: a same-build run under another coverage mode throws R354", async () => {
    const r = await resumed({ run: { coverageMode: "al-runner" } }, "run");
    expect(r.error?.message).toMatch(/^--resume-run \d+ was measured under .* \(R354\)/);
  });
});

/**
 * Snapshot: run 1 (v3, build B1) records batch 0's baseline snapshot and aborts; the snapshot is
 * then moved to ANOTHER run `other` shaped by `snap` (`findBaselineSnapshot` lends from any run),
 * and run 2 resumes run 1, which lends, so only the snapshot's run can decide.
 */
async function snapshotCase(c: {
  readonly snap: {
    backend: string;
    runnerBuild?: string | null;
    coverageMode?: string;
  };
  /** Ruling (b): the store answers that the snapshot's run row is missing. */
  readonly missingRow?: boolean;
  readonly spy?: boolean;
}) {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  await runSession({ ...base(store, dirs), backend: new Stub(ABORT_AFTER) });
  const runId = lastRun(store);
  const row = store.getRun(runId);
  if (row === null || row.testAppHash === null || row.testAppDeps === null) {
    throw new Error("run 1 recorded no proven test app");
  }
  const other = store.createRun({
    testScope: [],
    coverageMode: row.coverageMode ?? "none",
    identityScheme: row.identityScheme,
    buildSymbols: [],
    projectPath: "/elsewhere",
    backend: c.snap.backend,
    appVersion: "0.0.0.0",
    testAppHash: row.testAppHash,
    testAppProven: true,
    testAppDeps: row.testAppDeps,
    ...(typeof c.snap.runnerBuild === "string" ? { runnerBuild: c.snap.runnerBuild } : {}),
  });
  if (c.snap.coverageMode !== undefined)
    reshape(store, other, { coverageMode: c.snap.coverageMode });
  store.db.run("UPDATE baseline_snapshots SET run_id = ? WHERE run_id = ?", [other, runId]);
  if (c.missingRow === true) {
    const getRun = store.getRun.bind(store);
    store.getRun = (id: number) => (id === other ? null : getRun(id));
  }
  const today = new Stub();
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
  return { events, other, today, error, log };
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

  test("bcdev snapshot, v3 session: step 1", async () => {
    const s = await snapshotCase({ snap: { backend: "bcdev" } });
    notReused(
      s,
      "snapshot-backend-build-changed",
      backendBuild(s.other, otherBackend(s.other, "bcdev", "al-runner-v3")),
    );
  });
  test("R654 F3: a retired al-runner snapshot, v3 session: step 1, by name", async () => {
    const s = await snapshotCase({ snap: { backend: "al-runner" } });
    notReused(s, "snapshot-backend-build-changed", backendBuild(s.other, retired(s.other)));
  });
  test("v3 snapshot of another build, and of an unrecorded one: step 1", async () => {
    for (const build of [B2, null]) {
      const s = await snapshotCase({ snap: { backend: "al-runner-v3", runnerBuild: build } });
      notReused(
        s,
        "snapshot-backend-build-changed",
        backendBuild(s.other, otherBuild(s.other, build ?? "<unrecorded>")),
      );
    }
  });
  test("v3 snapshot, same build: reused", async () => {
    const s = await snapshotCase({ snap: { backend: "al-runner-v3", runnerBuild: B1 } });
    expect(s.error).toBeUndefined();
    expect(reusedOf(s.events)).toHaveLength(1);
  });
  test("order: a same-build snapshot under another coverage mode is not found (SQL), silently", async () => {
    const s = await snapshotCase({
      snap: { backend: "al-runner-v3", runnerBuild: B1, coverageMode: "al-runner" },
    });
    expect(s.error).toBeUndefined();
    expect(reusedOf(s.events)).toEqual([]);
    expect(warned(s.events, "snapshot-backend-build-changed")).toEqual([]);
  });
});

describe("R619 ruling (b): a snapshot whose run row is missing throws", () => {
  test("the store finds the snapshot but not its run: the session throws, nothing is reused", async () => {
    const s = await snapshotCase({
      snap: { backend: "al-runner-v3", runnerBuild: B1 },
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
    const h = await history({ run: {}, spy: true });
    expect(lends(h.log)).toEqual(["runMayLend:history:lends"]);
    expect(known(h.report)).toHaveLength(h.survived);
  });
  test("each refusal is the step runMayLend returned", async () => {
    const cases: Array<[Case, string]> = [
      [{ run: { runnerBuild: B2 } }, "backend-build"],
      [{ run: { backend: "al-runner", runnerBuild: null } }, "backend-build"],
      // The site's own checks run inside the call, after step 1.
      [{ run: { coverageMode: "al-runner" } }, "site"],
    ];
    for (const [c, step] of cases) {
      const h = await history({ ...c, spy: true });
      expect(lends(h.log), step).toEqual([`runMayLend:history:${step}`]);
    }
  });
});

describe("R619 spy: --resume calls runMayLend once, after findResumableRun", () => {
  test("A2: a lending run", async () => {
    const r = await resumed({ run: {}, spy: true }, "last");
    expect(r.error).toBeUndefined();
    expect(r.log.slice(0, 2)).toEqual(["findResumableRun", "runMayLend:resume:lends"]);
    expect(r.log.filter((l) => l.startsWith("runMayLend:resume:"))).toHaveLength(1);
  });
  test("a run the SQL does not find is never lent from: no call", async () => {
    const r = await resumed({ run: { runnerBuild: B2 }, spy: true }, "last");
    expect(r.error).toBeDefined();
    expect(lends(r.log)).toEqual([]);
  });
});

describe("R619 spy: --resume-run calls runMayLend once", () => {
  test("A3: a lending run", async () => {
    const r = await resumed({ run: {}, spy: true }, "run");
    expect(r.error).toBeUndefined();
    expect(r.log[0]).toBe("runMayLend:resume-run:lends");
    expect(r.log.filter((l) => l.startsWith("runMayLend:resume-run:"))).toHaveLength(1);
  });
  test("step 1 (reachable here, unlike --resume: review M4) and the site checks", async () => {
    for (const [c, step] of [
      [{ run: { runnerBuild: B2 } }, "backend-build"],
      // A site check throws inside the call: the throw is the refusal.
      [{ run: { coverageMode: "al-runner" } }, "threw"],
    ] as Array<[Case, string]>) {
      const r = await resumed({ ...c, spy: true }, "run");
      expect(r.log[0], step).toBe(`runMayLend:resume-run:${step}`);
      expect(r.log.filter((l) => l.startsWith("runMayLend:resume-run:"))).toHaveLength(1);
    }
  });
  test("the backend-equality throw and the retired-run throw come before the call: no call", async () => {
    for (const backend of ["bcdev", "al-runner"]) {
      const r = await resumed({ run: { backend, runnerBuild: null }, spy: true }, "run");
      expect(r.error, backend).toBeDefined();
      expect(lends(r.log), backend).toEqual([]);
    }
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
    const s = await snapshotCase({ snap: { backend: "al-runner-v3", runnerBuild: B1 }, spy: true });
    expect(snapshotLog(s.log)).toEqual([
      "findBaselineSnapshot",
      "runMayLend:snapshot:lends",
      "warning:resume-baseline-reused",
    ]);
  });
  test("each refusal is the step runMayLend returned", async () => {
    for (const snap of [
      { backend: "al-runner-v3", runnerBuild: B2 },
      { backend: "al-runner" },
      { backend: "bcdev" },
    ]) {
      const s = await snapshotCase({ snap, spy: true });
      expect(
        s.log.filter((l) => l === "findBaselineSnapshot" || l.startsWith("runMayLend:snapshot:")),
        snap.backend,
      ).toEqual(["findBaselineSnapshot", "runMayLend:snapshot:backend-build"]);
    }
  });
});
