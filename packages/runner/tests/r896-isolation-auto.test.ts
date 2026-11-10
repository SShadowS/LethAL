// R896: al-runner v3's `isolation: "auto"`: the candidate and choice rules, the orchestrator's
// once-per-session re-baseline under `method` (inside the baseline bracket, chosen rows replacing the
// superseded ones), the report, the run's stored choice and the resume refusal, and the lend rules.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestOutcome,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import {
  IsolationChoiceChangedError,
  chooseCodeunitIsolation,
  isolationCandidates,
} from "../src/isolation-auto";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { splitBackend } from "../src/parallel-queue";
import { renderConsole } from "../src/report";
import { sessionFingerprint } from "../src/resume";
import { ISOLATION_AUTO_BUILD_TAG, ResultsStore } from "../src/store";

const SOURCE = `codeunit 50013 "K Probe"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
const testAl = (id: number, name: string, methods: readonly string[]) => `codeunit ${id} "${name}"
{
    Subtype = Test;
${methods.map((m) => `\n    [Test]\n    procedure ${m}()\n    begin\n    end;\n`).join("")}}
`;
const A = 50140; // "A Tests": A1, A2
const B = 50141; // "B Tests": B1
const C = 50142; // "C Tests": C1

const BUILD = { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };

beforeAll(async () => {
  await initParser();
});

async function inProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r896-"));
  try {
    const app = { id: "11111111-2222-3333-4444-555555555555", name: "p", publisher: "x" };
    await Bun.write(join(root, "app", "app.json"), JSON.stringify({ ...app, version: "1.0.0.0" }));
    await Bun.write(join(root, "app", "src", "K.Codeunit.al"), SOURCE);
    await Bun.write(join(root, "tests", "ATests.Codeunit.al"), testAl(A, "A Tests", ["A1", "A2"]));
    await Bun.write(join(root, "tests", "BTests.Codeunit.al"), testAl(B, "B Tests", ["B1"]));
    await Bun.write(join(root, "tests", "CTests.Codeunit.al"), testAl(C, "C Tests", ["C1"]));
    await Bun.write(
      join(root, "tests", "app.json"),
      JSON.stringify({ name: "t", publisher: "x", version: "1.0.0.0" }),
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Script = (ref: TestMethodRef, mode: "test" | "method", mutant: string | null) => TestOutcome;

/**
 * A v3-kind backend whose answer depends on the codeunit's mode. Only a pass INSIDE the baseline
 * bracket carries coverage (as v3's), and only A2's covers `Twice`: so a mutant of `Twice` is covered
 * exactly when A2's `method` pass is a baseline row.
 */
class AutoStub implements ExecutionBackend {
  readonly runnerBuild = async () => BUILD;
  readonly mode = new Map<number, "test" | "method">();
  readonly chooseCalls: [number, string][] = [];
  readonly runs: { test: string; mode: string; inBaseline: boolean; mutant: string | null }[] = [];
  readonly noted: string[][] = [];
  private inBaseline = false;
  private active: string | null = null;
  constructor(
    private readonly script: Script,
    readonly isolationAuto: boolean = true,
  ) {}
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
      coverage: "al-runner",
      deploy: "none",
      isolation: "session",
      authoritative: false,
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
  }
  baselinePhase(on: boolean): void {
    this.inBaseline = on;
  }
  noteReusedBaseline(rows: readonly { ref: TestMethodRef; verdict: TestVerdict }[]): void {
    this.noted.push(rows.map((r) => `${r.ref.method}=${r.verdict.outcome}`));
  }
  /** `chooseIsolation` on an auto stub (`autoStub`); a forced stub has none. */
  pick(cu: number, mode: "test" | "method"): void {
    this.chooseCalls.push([cu, mode]);
    this.mode.set(cu, mode);
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    const mode = this.mode.get(ref.codeunitId) ?? "test";
    this.runs.push({
      test: ref.method,
      mode,
      inBaseline: this.inBaseline,
      mutant: this.active,
    });
    const outcome = this.script(ref, mode, this.active);
    const covers =
      ref.method === "A2" ? [{ objectType: "Codeunit", objectId: 50013, procedure: "Twice" }] : [];
    return {
      ref,
      outcome,
      durationMs: 1,
      ...(outcome === "pass" ? { measuredDurationMs: 1 } : {}),
      ...(outcome === "fail" ? { failureMessage: `${ref.method} failed under ${mode}` } : {}),
      // An `error` here is a run the server may still be executing: the baseline stops.
      ...(outcome === "error"
        ? { operation: "in-flight-unknown" as const, failureMessage: "stranded" }
        : {}),
      ...(outcome === "pass" && this.inBaseline && this.active === null
        ? { coverage: { granularity: "procedure" as const, entries: covers } }
        : {}),
    };
  }
}

const autoStub = (s: Script) => {
  const b = new AutoStub(s, true);
  return Object.assign(b, {
    chooseIsolation: (cu: number, mode: "test" | "method") => b.pick(cu, mode),
  });
};

/** A2 needs a fresh codeunit (passes under `method` only); every mutant is killed by A2. */
const switchesA: Script = (ref, mode, mutant) => {
  if (ref.method === "A2" && mode === "test") return "fail";
  if (mutant !== null && ref.method === "A2") return "fail";
  return "pass";
};

async function session(
  root: string,
  store: ResultsStore,
  backend: ExecutionBackend,
  extra: Partial<SessionConfig> = {},
) {
  const events: RunEvent[] = [];
  const report = await runSession({
    backend,
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    emit: [(e: RunEvent) => events.push(e)],
    ...extra,
  });
  return { report, events };
}

const rowOf = (method: string, outcome: TestOutcome, extra: Partial<TestVerdict> = {}) => {
  const ref = { codeunitId: method.startsWith("A") ? A : B, codeunitName: "T", method };
  return { ref, verdict: { ref, outcome, durationMs: 1, ...extra } as TestVerdict };
};

describe("R896: candidates (review 5)", () => {
  test("fail, a v3 error row and a v3 refusal (the cascade too) make a candidate", () => {
    expect(isolationCandidates([rowOf("A1", "pass"), rowOf("A2", "fail")])).toEqual([A]);
    expect(isolationCandidates([rowOf("A1", "error", { runnerRow: "runner-test-error" })])).toEqual(
      [A],
    );
    const cascade = rowOf("A1", "error", {
      runnerRow: "runner-refused",
      failureMessage:
        "NotRun: an earlier test of this codeunit changed an isolated storage key [al-runner v3: notRun]",
    });
    expect(isolationCandidates([cascade])).toEqual([A]);
  });

  test("a TestPage skip, a permission refusal, a budget stop, transport noise and all-green are not", () => {
    const none = [
      rowOf("A1", "skip", { failureMessage: "not run: may open a TestPage" }),
      rowOf("A2", "fail", {
        failureMessage:
          "Sorry, the current permissions prevented the action. (TableData 18 Customer Read: Base Application)",
      }),
      rowOf("B1", "timeout", { reportedStopMs: 1000 }),
      rowOf("B1", "error", { operation: "pre-dispatch-rejected", failureMessage: "transport" }),
      rowOf("B1", "deadline-exceeded"),
      rowOf("B1", "pass"),
    ];
    expect(isolationCandidates(none)).toEqual([]);
  });
});

describe("R896: the choice (strictly more passes)", () => {
  const rows = (outcomes: TestOutcome[]) =>
    outcomes.map((o, i) => {
      const ref = { codeunitId: A, codeunitName: "A Tests", method: `T${i}` };
      return {
        ref,
        verdict: {
          ref,
          outcome: o,
          durationMs: 1,
          ...(o === "fail" ? { failureMessage: `T${i} boom` } : {}),
        } as TestVerdict,
      };
    });
  test("more -> method; a tie -> test; fewer -> test", () => {
    expect(chooseCodeunitIsolation(rows(["fail", "pass"]), rows(["pass", "pass"])).chosen).toBe(
      "method",
    );
    const tie = chooseCodeunitIsolation(rows(["fail", "pass"]), rows(["pass", "fail"]));
    expect(tie.chosen).toBe("test");
    expect(tie.reason).toContain("not strictly more");
    expect(chooseCodeunitIsolation(rows(["pass", "pass"]), rows(["pass", "fail"])).chosen).toBe(
      "test",
    );
  });
  test("mixed (gains 2, loses 1) -> method, the lost test named with what method observed", () => {
    const row = chooseCodeunitIsolation(
      rows(["pass", "fail", "fail"]),
      rows(["fail", "pass", "pass"]),
    );
    expect(row).toMatchObject({ chosen: "method", testPassed: 1, methodPassed: 2, tests: 3 });
    expect(row.lostUnderMethod).toEqual([
      { test: "A Tests.T0", outcome: "fail", message: "T0 boom" },
    ]);
  });
});

describe("R896: the session", () => {
  test("auto: a candidate switches inside the bracket, its method rows replace the test rows (coverage, green set), reported and stored", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const b = autoStub(switchesA);
      const { report, events } = await session(root, store, b);
      // Only A was a candidate (B, C all green); it went to method and stayed there.
      expect(b.chooseCalls).toEqual([
        [A, "method"],
        [A, "method"],
      ]);
      // Every method-pass run happened inside the baseline bracket, unmutated.
      const methodRuns = b.runs.filter((r) => r.mode === "method" && r.mutant === null);
      expect(methodRuns.length).toBeGreaterThanOrEqual(2);
      const rebaseline = b.runs.filter((r) => r.mode === "method" && r.inBaseline);
      expect(rebaseline.map((r) => r.test).sort()).toEqual(["A1", "A2"]);
      // The superseded test row is gone from the batch's baseline: A2 is green there.
      const finished = events.find((e) => e.type === "baseline-batch-finished");
      expect(finished?.type === "baseline-batch-finished" ? finished.verdicts : []).toContainEqual(
        expect.objectContaining({ name: "A Tests.A2", outcome: "pass" }),
      );
      // The method pass's coverage reached selection: no mutant of Twice is no-coverage.
      expect(report.mutants.length).toBeGreaterThan(0);
      expect(report.mutants.filter((m) => m.verdict === "no-coverage")).toEqual([]);
      expect(report.isolation).toEqual({
        mode: "auto",
        codeunits: [
          expect.objectContaining({
            codeunitId: A,
            name: "A Tests",
            chosen: "method",
            testPassed: 1,
            methodPassed: 2,
            lostUnderMethod: [],
          }),
        ],
      });
      expect(renderConsole(report)).toContain(
        "isolation: 1 codeunit(s) switched to method, 0 stayed on test (see report)",
      );
      // Review 4: refusals are re-noted from the CHOSEN rows (the method ones).
      expect(b.noted).toEqual([["A1=pass", "A2=pass"]]);
      expect(store.runIsolationChoice(1)).toEqual({ [A]: "method" });
      expect(store.getRun(1)?.runnerBuild).toBe(
        `${BUILD.version} ${BUILD.binarySha256}${ISOLATION_AUTO_BUILD_TAG}`,
      );
      // Review 1: no baseline snapshot under auto.
      const snaps = store.db.query("SELECT COUNT(*) AS n FROM baseline_snapshots").get() as {
        n: number;
      };
      expect(snaps.n).toBe(0);
    });
  });

  test("auto: a tie stays on test, with a row; a codeunit with no red test has none", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      // C1 fails in both modes: a candidate that gains nothing.
      const b = autoStub((ref, _mode, mutant) =>
        ref.method === "C1" || (mutant !== null && ref.method === "A2") ? "fail" : "pass",
      );
      const { report } = await session(root, store, b);
      expect(b.chooseCalls).toEqual([
        [C, "method"],
        [C, "test"],
      ]);
      expect(report.isolation?.codeunits).toEqual([
        expect.objectContaining({ codeunitId: C, chosen: "test", testPassed: 0, methodPassed: 0 }),
      ]);
      expect(b.noted).toEqual([["C1=fail"]]);
      expect(store.runIsolationChoice(1)).toEqual({ [C]: "test" });
      expect(renderConsole(report)).toContain("0 codeunit(s) switched to method, 1 stayed on test");
    });
  });

  test("forced (no auto): no choice, no re-baseline, no report field, no tag", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const b = new AutoStub(switchesA, false);
      const { report } = await session(root, store, b);
      expect(b.chooseCalls).toEqual([]);
      expect(b.runs.filter((r) => r.inBaseline)).toHaveLength(4);
      expect(report.isolation).toBeUndefined();
      expect(store.runIsolationChoice(1)).toBeNull();
      expect(store.getRun(1)?.runnerBuild).toBe(`${BUILD.version} ${BUILD.binarySha256}`);
      // The same session records its baseline snapshot, so the auto test's 0 is the guard's.
      const snaps = store.db.query("SELECT COUNT(*) AS n FROM baseline_snapshots").get() as {
        n: number;
      };
      expect(snaps.n).toBe(1);
    });
  });

  test("build review 3: a stop mid-re-baseline puts every candidate back on test and stores nothing", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      // A and C are candidates; A1's method run strands, so the re-baseline stops there.
      const b = autoStub((ref, mode) =>
        ref.method === "A1" && mode === "method"
          ? "error"
          : (ref.method === "A2" || ref.method === "C1") && mode === "test"
            ? "fail"
            : "pass",
      );
      const out = await session(root, store, b).catch((e: unknown) => e);
      expect(b.chooseCalls).toEqual([
        [A, "method"],
        [C, "method"],
        [A, "test"],
        [C, "test"],
      ]);
      expect([b.mode.get(A), b.mode.get(C)]).toEqual(["test", "test"]);
      expect(store.runIsolationChoice(1)).toBeNull();
      expect(
        out instanceof Error
          ? undefined
          : (out as { report: { isolation?: unknown } }).report.isolation,
      ).toBeUndefined();
    });
  });

  test("review 1: an auto resume never looks a baseline snapshot up, even one its own run holds", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      await session(root, store, new AutoStub(switchesA, false)); // run 1 records a snapshot
      await session(root, store, autoStub(switchesA)); // run 2
      store.db.run("UPDATE baseline_snapshots SET run_id = 2");
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 2");
      store.db.run("DELETE FROM mutants WHERE id = (SELECT MAX(id) FROM mutants WHERE run_id = 2)");
      const b = autoStub(switchesA);
      const { events } = await session(root, store, b, { resume: 2 });
      const codes = events.flatMap((e) => (e.type === "warning" ? [e.code] : []));
      expect(codes).not.toContain("snapshot-backend-build-changed");
      expect(codes).not.toContain("resume-baseline-reused");
      expect(events.some((e) => e.type === "baseline-isolation-chosen")).toBe(true);
    });
  });

  test("resume: the same choice resumes; another choice is refused by name", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      await session(root, store, autoStub(switchesA));
      const reopen = () => {
        store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
        // Leave one mutant un-carried, so the resumed session runs a live baseline.
        store.db.run(
          "DELETE FROM mutants WHERE id = (SELECT MAX(id) FROM mutants WHERE run_id = 1)",
        );
      };
      reopen();
      const same = await session(root, store, autoStub(switchesA), { resume: 1 });
      expect(same.report.resumedFrom?.runId).toBe(1);
      reopen();
      // Now A2 needs a fresh codeunit no more: the resumed baseline keeps A on test.
      const other = autoStub((ref, _m, mutant) =>
        mutant !== null && ref.method === "A2" ? "fail" : ref.method === "A2" ? "fail" : "pass",
      );
      const refused = await session(root, store, other, { resume: 1 }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(IsolationChoiceChangedError);
      expect(String(refused)).toContain(`[${A}] on "method", and this session's baseline puts []`);
    });
  });
});

describe("R896: fingerprint and lending", () => {
  const base = {
    projectDir: "/p",
    testDir: "/t",
    backend: "al-runner-v3",
    skipKnownSurvivors: false,
    identityScheme: 1,
    selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
  };
  test("the fingerprint holds the auto setting", () => {
    expect(sessionFingerprint({ ...base, isolationAuto: true })).not.toBe(sessionFingerprint(base));
  });

  test("an auto session borrows no history or snapshot; a resume still lends; a forced run never meets an auto one", () => {
    const store = new ResultsStore(":memory:");
    const auto = `X${ISOLATION_AUTO_BUILD_TAG}`;
    const session = { backend: "al-runner-v3", runnerBuild: auto };
    const run = { id: 7, backend: "al-runner-v3", runnerBuild: auto };
    for (const site of ["history", "snapshot"] as const) {
      expect(store.runMayLend(run, session, { site })).toMatchObject({
        step: "backend-build",
        why: expect.stringContaining("R896"),
      });
    }
    expect(store.runMayLend(run, session, { site: "resume" })).toBeUndefined();
    const forced = { backend: "al-runner-v3", runnerBuild: "X" };
    expect(store.runMayLend(run, forced, { site: "history" })?.step).toBe("backend-build");
    expect(store.runMayLend({ ...run, runnerBuild: "X" }, forced, { site: "history" })).toBe(
      undefined,
    );
  });

  test("the stored choice round-trips; a corrupt one is refused", () => {
    const store = new ResultsStore(":memory:");
    store.db.run(
      "INSERT INTO runs (project_path, backend, app_version, config_fingerprint) VALUES ('p', 'al-runner-v3', '1', 'f')",
    );
    expect(store.runIsolationChoice(1)).toBeNull();
    store.setRunIsolationChoice(1, { [A]: "method", [C]: "test" });
    expect(store.runIsolationChoice(1)).toEqual({ [A]: "method", [C]: "test" });
    store.db.run(`UPDATE runs SET isolation_choice = '{"1":"codeunit"}' WHERE id = 1`);
    expect(() => store.runIsolationChoice(1)).toThrow(/corrupt "isolation_choice"/);
    expect(() => store.setRunIsolationChoice(9, {})).toThrow(/no run 9/);
  });

  test("splitBackend hands chooseIsolation to the owner, and has none when the owner has none", () => {
    const owner = autoStub(switchesA);
    const lane = new AutoStub(switchesA, false);
    splitBackend(owner, lane).chooseIsolation?.(A, "method");
    expect(owner.chooseCalls).toEqual([[A, "method"]]);
    expect(splitBackend(lane, lane).chooseIsolation).toBeUndefined();
  });
});
