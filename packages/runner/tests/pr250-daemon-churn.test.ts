// PR-250 part 2 (docs/superpowers/specs/2026-11-20-pr250-baseline-refused-cut.md): 10 serve-daemon closes in a
// row on one lane, in the mutant phase, with no mutant scored in between, stop the session through the budget,
// and the report names the churn. A fake backend that reports closes through its close sink; call counters only.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { V3DaemonClose } from "../src/al-runner-v3-backend";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { TIME_BUDGET_EXIT_CODE, exitCodeForReport } from "../src/cli";
import type { RunEvent } from "../src/events";
import { DaemonChurnGuard, V3_DAEMON_CHURN_CLOSES } from "../src/mutant-windows";
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
/** Calls 1-4 are the baseline's four tests; every mutant then runs all four (each covers `Twice`). */
const BASELINE_CALLS = 4;

beforeAll(async () => {
  await initParser();
});

async function inProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-pr250-"));
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
  /** Call number -> the closes the backend reports while that call runs (lane 0). */
  readonly closesOn = new Map<number, number>();
  private sink: ((c: V3DaemonClose) => void) | undefined;
  groupsStarted = 0;
  readonly now = () => 1_000_000 + this.calls * 1000;
  setDaemonCloseSink(sink?: (c: V3DaemonClose) => void): void {
    this.sink = sink;
  }
  handle: Parameters<NonNullable<ExecutionBackend["useStopHandle"]>>[0] | undefined;
  useStopHandle(h: Parameters<NonNullable<ExecutionBackend["useStopHandle"]>>[0]): void {
    this.handle = h;
  }
  /** The session's SIGTERM handler (`registerStopSignal`), and the call number it fires on. */
  sigterm: (() => void) | undefined;
  sigtermOn: number | undefined;
  /** The SIGTERM fires before that call's closes (default: after them). */
  sigtermFirst = false;
  /** `handle.signalled()` as the backend reads it after the call it ran in. */
  signalledAfter = new Map<number, boolean>();
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
  async activate(id?: string | null): Promise<void> {
    if (id !== null && id !== undefined) this.groupsStarted += 1;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    this.calls += 1;
    if (this.sigtermFirst && this.sigtermOn === this.calls) this.sigterm?.();
    const n = this.closesOn.get(this.calls) ?? 0;
    for (let i = 0; i < n; i++)
      this.sink?.({
        lane: 0,
        reason: "refusal",
        family: "x",
        phase: this.calls <= BASELINE_CALLS ? "baseline" : "live",
      });
    if (!this.sigtermFirst && this.sigtermOn === this.calls) this.sigterm?.();
    this.signalledAfter.set(this.calls, this.handle?.signalled() === true);
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
  const report = await runSession({
    backend: b,
    store: new ResultsStore(":memory:"),
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    emit: [(e: RunEvent) => events.push(e)],
    clockMs: b.now,
    registerStopSignal: (stop) => {
      b.sigterm = stop;
      return () => {};
    },
  });
  const churnWarnings = events.filter(
    (e) => e.type === "warning" && e.code === "al-runner-v3-daemon-churn",
  );
  return { report, events, churnWarnings };
}

const firstMutantCall = BASELINE_CALLS + 1;
const secondMutantCall = BASELINE_CALLS + 4 + 1;

describe("PR-250: the daemon-churn guard", () => {
  test("N is 10", () => {
    expect(V3_DAEMON_CHURN_CLOSES).toBe(10);
  });

  test("9 closes with nothing scored do not trip: every mutant is scored, no stop", async () => {
    await inProject(async (root) => {
      const full = await session(root, new Backend());
      const b = new Backend();
      b.closesOn.set(firstMutantCall, 9);
      const { report, churnWarnings } = await session(root, b);
      expect(churnWarnings).toEqual([]);
      expect(report.timeBudget).toBeUndefined();
      expect(report.mutants).toHaveLength(full.report.mutants.length);
    });
  });

  test("the 10th close trips: a named warning, the session stops, and the report names the churn", async () => {
    await inProject(async (root) => {
      const full = await session(root, new Backend());
      expect(full.report.mutants.length).toBeGreaterThan(1);
      const b = new Backend();
      b.closesOn.set(firstMutantCall, 9);
      b.closesOn.set(firstMutantCall + 1, 1); // same mutant, nothing scored between: the 10th in a row
      const { report, churnWarnings } = await session(root, b);
      expect(churnWarnings).toHaveLength(1);
      expect(report.timeBudget?.stoppedByDaemonChurn).toEqual({ lane: 0, closes: 10 });
      expect(report.timeBudget?.stoppedBySignal).toBeUndefined();
      expect(report.timeBudget?.stoppedByMemory).toBeUndefined();
      // the group in flight keeps its verdict (the guard kills nothing); no later group starts
      expect(b.groupsStarted).toBe(1);
      expect(report.mutants).toHaveLength(1);
      expect(exitCodeForReport(report)).toBe(TIME_BUDGET_EXIT_CODE);
      const text = renderConsole(report);
      expect(text).toContain("STOPPED BY THE DAEMON-CHURN GUARD");
      expect(text).not.toContain("STOPPED BY SIGNAL");
      expect(text).not.toContain("STOP SIGNAL");
      expect(text).not.toContain("TIME BUDGET REACHED");
      // the backend reads no signal: the churn stop kills nothing
      expect(b.signalledAfter.get(firstMutantCall + 1)).toBe(false);
    });
  });

  test("a SIGTERM AFTER a churn trip is still a signal: the backend reads it, the mutant it ended is dropped, and the report keeps both", async () => {
    await inProject(async (root) => {
      const b = new Backend();
      b.closesOn.set(firstMutantCall, 10); // the trip
      b.sigtermOn = firstMutantCall + 1;
      const { report } = await session(root, b);
      expect(b.signalledAfter.get(firstMutantCall)).toBe(false);
      expect(b.signalledAfter.get(firstMutantCall + 1)).toBe(true);
      expect(report.timeBudget?.stoppedByDaemonChurn).toEqual({ lane: 0, closes: 10 });
      expect(report.timeBudget?.stoppedBySignal).toBe(true);
      expect(report.mutants).toEqual([]); // R1014: a mutant a signal ended is never recorded
      expect(renderConsole(report)).toContain("A STOP SIGNAL (SIGTERM or SIGINT) also arrived");
    });
  });

  test("a churn trip AFTER a SIGTERM does not erase the signal", async () => {
    await inProject(async (root) => {
      const b = new Backend();
      b.sigtermOn = firstMutantCall;
      b.sigtermFirst = true;
      b.closesOn.set(firstMutantCall, 10);
      const { report } = await session(root, b);
      expect(b.signalledAfter.get(firstMutantCall)).toBe(true);
      expect(report.timeBudget?.stoppedBySignal).toBe(true);
      expect(report.mutants).toEqual([]);
    });
  });

  test("the warning does not claim the run stops: it says no mutant or batch starts after the ones in flight", async () => {
    await inProject(async (root) => {
      const b = new Backend();
      b.closesOn.set(firstMutantCall, 10);
      const { churnWarnings } = await session(root, b);
      const w = churnWarnings[0];
      if (w?.type !== "warning") throw new Error("no warning");
      expect(w.message).toContain("no mutant or batch starts after the ones in flight");
      expect(w.message).not.toContain("the run stops");
    });
  });

  test("one scored mutant resets the count: 9 closes, a score, 9 closes do not trip", async () => {
    await inProject(async (root) => {
      const full = await session(root, new Backend());
      const b = new Backend();
      b.closesOn.set(firstMutantCall, 9);
      b.closesOn.set(secondMutantCall, 9);
      const { report, churnWarnings } = await session(root, b);
      expect(churnWarnings).toEqual([]);
      expect(report.timeBudget).toBeUndefined();
      expect(report.mutants).toHaveLength(full.report.mutants.length);
    });
  });

  test("baseline closes do not count", async () => {
    await inProject(async (root) => {
      const b = new Backend();
      b.closesOn.set(2, 10);
      b.closesOn.set(firstMutantCall, 9);
      const { report, churnWarnings } = await session(root, b);
      expect(churnWarnings).toEqual([]);
      expect(report.timeBudget).toBeUndefined();
    });
  });

  test("the count is per lane", () => {
    const g = new DaemonChurnGuard();
    g.see({ type: "phase-entered", phase: "mutants", seq: 1 } as RunEvent);
    const close = (lane: number) =>
      g.see({ type: "serve-daemon-closed", lane, reason: "refusal", seq: 2 } as RunEvent);
    for (let i = 0; i < 9; i++) {
      expect(close(0)).toBeUndefined();
      expect(close(1)).toBeUndefined();
    }
    expect(close(1)).toEqual({ lane: 1, closes: 10 });
    expect(close(0)).toBeUndefined(); // once per session
  });
});
