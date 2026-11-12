// R955: `--time-budget` bounds the baseline too. A fake backend advances a fake clock by one second
// per call (call counters, never wall-clock): with a small budget the baseline stops part-way and the
// report says where; with no budget the baseline completes.
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
import { registerProcessStopSignal, runSession } from "../src/orchestrator";
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
const testAl = (id: number, name: string, methods: readonly string[]) => `codeunit ${id} "${name}"
{
    Subtype = Test;
${methods.map((m) => `\n    [Test]\n    procedure ${m}()\n    begin\n    end;\n`).join("")}}
`;

beforeAll(async () => {
  await initParser();
});

async function inProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r955-"));
  try {
    const app = { id: "11111111-2222-3333-4444-555555555555", name: "p", publisher: "x" };
    await Bun.write(join(root, "app", "app.json"), JSON.stringify({ ...app, version: "1.0.0.0" }));
    await Bun.write(join(root, "app", "src", "K.Codeunit.al"), SOURCE);
    await Bun.write(
      join(root, "tests", "ATests.Codeunit.al"),
      testAl(50140, "A Tests", ["A1", "A2", "A3", "A4"]),
    );
    await Bun.write(
      join(root, "tests", "app.json"),
      JSON.stringify({ name: "t", publisher: "x", version: "1.0.0.0" }),
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every call is one fake second: `now()` reads the call counter, never the wall clock. */
class SlowBaseline implements ExecutionBackend {
  calls = 0;
  /** Called after each call is counted: a test's way to "send a signal" at a chosen call. */
  onCall?: (n: number) => void;
  readonly now = () => 1_000_000 + this.calls * 1000;
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
  async activate(): Promise<void> {}
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    this.calls += 1;
    this.onCall?.(this.calls);
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

async function session(
  root: string,
  b: SlowBaseline,
  budget: number | undefined,
  registerStopSignal?: (stop: () => void) => () => void,
) {
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
    ...(registerStopSignal !== undefined ? { registerStopSignal } : {}),
    ...(budget !== undefined ? { timeBudgetSeconds: budget } : {}),
  });
  return { report, events };
}

describe("R955: a SIGTERM or SIGINT spends the same budget", () => {
  /** The injected registration: the test holds the handler's trigger and counts the removals. */
  const rig = () => {
    const r = { stop: (() => {}) as () => void, registered: 0, removed: 0 };
    const register = (stop: () => void) => {
      r.stop = stop;
      r.registered += 1;
      return () => {
        r.removed += 1;
      };
    };
    return { r, register };
  };

  test("a signal in the baseline, with no --time-budget: the report is written and says signal", async () => {
    await inProject(async (root) => {
      const b = new SlowBaseline();
      const { r, register } = rig();
      b.onCall = (n) => {
        if (n === 2) r.stop();
      };
      const { report } = await session(root, b, undefined, register);
      expect(b.calls).toBe(2);
      expect(report.timeBudget).toMatchObject({
        budgetSeconds: 0,
        stoppedBySignal: true,
        baselineStopped: { testsRun: 2, testsTotal: 4 },
      });
      expect(report.validity.caveats).toContain("time-budget-reached");
      expect(exitCodeForReport(report)).toBe(TIME_BUDGET_EXIT_CODE);
      expect(renderConsole(report)).toContain("STOPPED BY SIGNAL");
      // The handlers are removed when the session ends.
      expect([r.registered, r.removed]).toEqual([1, 1]);
    });
  });

  test("a session nobody signals is unchanged, and still removes its handlers", async () => {
    await inProject(async (root) => {
      const b = new SlowBaseline();
      const { r, register } = rig();
      const { report } = await session(root, b, undefined, register);
      expect(report.timeBudget).toBeUndefined();
      expect(report.validity.caveats).not.toContain("time-budget-reached");
      expect(exitCodeForReport(report)).toBe(0);
      expect(b.calls).toBeGreaterThan(4);
      expect([r.registered, r.removed]).toEqual([1, 1]);
    });
  });

  test("the default registration listens for SIGTERM and SIGINT and leaves no listener behind", () => {
    const before: [number, number] = [
      process.listenerCount("SIGTERM"),
      process.listenerCount("SIGINT"),
    ];
    let stopped = 0;
    const off = registerProcessStopSignal(() => {
      stopped += 1;
    });
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual([
      before[0] + 1,
      before[1] + 1,
    ]);
    off();
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(before);
    expect(stopped).toBe(0);
  });
});

describe("R955: the time budget bounds the baseline", () => {
  test("a budget that runs out mid-baseline stops it and the report says where", async () => {
    await inProject(async (root) => {
      const b = new SlowBaseline();
      const { report, events } = await session(root, b, 2);
      // Two calls used the two seconds; no third baseline call was made.
      expect(b.calls).toBe(2);
      expect(report.timeBudget).toMatchObject({
        budgetSeconds: 2,
        baselineStopped: { testsRun: 2, testsTotal: 4 },
      });
      expect(report.validity.caveats).toContain("time-budget-reached");
      expect(report.mutants).toEqual([]);
      expect(renderConsole(report)).toContain(
        "TIME BUDGET REACHED IN THE BASELINE: --time-budget 2 s ran out after 2 of 4 baseline test(s)",
      );
      expect(events.some((e) => e.type === "time-budget-reached")).toBe(true);
    });
  });

  test("with no budget the baseline completes and mutants are scored", async () => {
    await inProject(async (root) => {
      const b = new SlowBaseline();
      const { report } = await session(root, b, undefined);
      expect(report.timeBudget).toBeUndefined();
      expect(report.validity.caveats).not.toContain("time-budget-reached");
      expect(b.calls).toBeGreaterThan(4);
      expect(report.mutants.length).toBeGreaterThan(0);
    });
  });
});
