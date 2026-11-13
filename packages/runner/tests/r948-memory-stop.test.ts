// R948: the memory guard's stop goes through R955's path: the backend calls `stopForMemory` on the
// handle the orchestrator gave it, the call it was in is dropped like a signalled one, and the report
// names memory (not a signal). A fake backend; call counters, never the wall clock.
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
  TestVerdict,
} from "../src/backend";
import { TIME_BUDGET_EXIT_CODE, exitCodeForReport } from "../src/cli";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import { renderConsole } from "../src/report";
import { ResultsStore } from "../src/store";

const SOURCE = `codeunit 50013 "K Probe"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
const TESTS = `codeunit 50140 "A Tests"
{
    Subtype = Test;

    [Test]
    procedure A1()
    begin
    end;

    [Test]
    procedure A2()
    begin
    end;

    [Test]
    procedure A3()
    begin
    end;

    [Test]
    procedure A4()
    begin
    end;
}
`;
const INFO = {
  usedBytes: 30 * 2 ** 30,
  boundBytes: 28 * 2 ** 30,
  source: "/sys/fs/cgroup/memory.max",
};

beforeAll(async () => {
  await initParser();
});

async function inProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r948-"));
  try {
    const app = { id: "11111111-2222-3333-4444-555555555555", name: "p", publisher: "x" };
    await Bun.write(join(root, "app", "app.json"), JSON.stringify({ ...app, version: "1.0.0.0" }));
    await Bun.write(join(root, "app", "src", "K.Codeunit.al"), SOURCE);
    await Bun.write(join(root, "tests", "ATests.Codeunit.al"), TESTS);
    await Bun.write(
      join(root, "tests", "app.json"),
      JSON.stringify({ name: "t", publisher: "x", version: "1.0.0.0" }),
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class Backend implements ExecutionBackend {
  calls = 0;
  handle: Parameters<NonNullable<ExecutionBackend["useStopHandle"]>>[0] | undefined;
  /** This call number is the one the guard stops in. */
  stopOnCall: number | undefined;
  /** And whether that call is dropped (a baseline call the guard blocked) or ran (a mutant group's). */
  dropIt = false;
  readonly now = () => 1_000_000 + this.calls * 1000;
  useStopHandle(h: Parameters<NonNullable<ExecutionBackend["useStopHandle"]>>[0]): void {
    this.handle = h;
  }
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
      coverage: "al-runner",
      deploy: "none",
      isolation: "session",
      authoritative: false,
    };
  }
  readonly runnerBuild = async () => ({ version: "alrunner 3.0.0", binarySha256: "b".repeat(64) });
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  /** Mutant groups activated (not the null activations). */
  groupsStarted = 0;
  asks = 0;
  stopped = false;
  /** The guard refuses at this group ask (it stops the session there). */
  refuseOnAsk: number | undefined;
  async mayStartGroup(): Promise<boolean> {
    this.asks += 1;
    if (this.refuseOnAsk === this.asks) {
      this.handle?.stopForMemory(INFO);
      this.stopped = true;
    }
    return !this.stopped;
  }
  async activate(id?: string | null): Promise<void> {
    if (id !== null && id !== undefined) this.groupsStarted += 1;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    this.calls += 1;
    if (this.stopOnCall === this.calls) {
      this.handle?.stopForMemory(INFO);
      this.stopped = true;
      if (this.dropIt) {
        return {
          ref,
          outcome: "error",
          durationMs: 0,
          failureMessage: "al-runner-v3-memory-bound: not started",
          operation: "completed-accepted",
          runnerRow: "runner-test-error",
        };
      }
    }
    return {
      ref,
      outcome: "pass",
      durationMs: 1,
      measuredDurationMs: 1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 50013, procedure: "Twice" }],
      },
    };
  }
}

async function session(root: string, b: Backend) {
  const events: RunEvent[] = [];
  const store = new ResultsStore(":memory:");
  const report = await runSession({
    backend: b,
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    emit: [(e: RunEvent) => events.push(e)],
    clockMs: b.now,
    registerStopSignal: () => () => {},
  });
  return { report, events, store };
}

describe("R948: the memory guard stops a session through R955's path", () => {
  test("in the baseline: the blocked call is dropped, no snapshot, no mutant, and the report names memory, not a signal", async () => {
    await inProject(async (root) => {
      const b = new Backend();
      b.stopOnCall = 2;
      b.dropIt = true;
      const { report, store, events } = await session(root, b);
      expect(b.calls).toBe(2); // no third baseline call
      expect(report.timeBudget).toMatchObject({
        stoppedByMemory: INFO,
        // The dropped call does not count, as for a signal.
        baselineStopped: { testsRun: 1, testsTotal: 4 },
      });
      expect(report.timeBudget?.stoppedBySignal).toBeUndefined();
      expect(report.validity.caveats).toContain("time-budget-reached");
      expect(report.mutants).toEqual([]);
      expect(
        (store.db.query("SELECT COUNT(*) AS n FROM baseline_snapshots").get() as { n: number }).n,
      ).toBe(0);
      expect(exitCodeForReport(report)).toBe(TIME_BUDGET_EXIT_CODE);
      expect(renderConsole(report)).toContain("STOPPED BY THE MEMORY GUARD");
      expect(renderConsole(report)).not.toContain("STOPPED BY SIGNAL");
      expect(events.some((e) => e.type === "time-budget-reached")).toBe(true);
    });
  });

  test("in the mutant phase: the group in flight keeps its verdicts, EXACTLY one is scored, no later group is activated, and the report names memory", async () => {
    await inProject(async (root) => {
      const full = await session(root, new Backend());
      expect(full.report.mutants.length).toBeGreaterThan(1);
      const b = new Backend();
      b.stopOnCall = 6; // after the four baseline calls: inside the first group
      const { report } = await session(root, b);
      expect(report.timeBudget?.stoppedByMemory).toEqual(INFO);
      expect(report.timeBudget?.baselineStopped).toBeUndefined();
      expect(b.groupsStarted).toBe(1);
      expect(report.mutants).toHaveLength(1);
      expect(report.mutants.every((m) => m.verdict !== "error")).toBe(true);
    });
  });

  test("a group the guard refuses at its start is NOT started and not scored; the console says memory, never a spent --time-budget of 0 s", async () => {
    await inProject(async (root) => {
      const b = new Backend();
      b.refuseOnAsk = 2;
      const { report } = await session(root, b);
      expect(b.groupsStarted).toBe(1);
      expect(report.mutants).toHaveLength(1);
      expect(report.timeBudget?.stoppedByMemory).toEqual(INFO);
      const text = renderConsole(report);
      expect(text).toContain("STOPPED BY THE MEMORY GUARD");
      expect(text).not.toContain("--time-budget 0 s");
      expect(text).not.toContain("TIME BUDGET REACHED");
    });
  });

  test("a session nobody stops carries no memory field", async () => {
    await inProject(async (root) => {
      const { report } = await session(root, new Backend());
      expect(report.timeBudget).toBeUndefined();
    });
  });
});
