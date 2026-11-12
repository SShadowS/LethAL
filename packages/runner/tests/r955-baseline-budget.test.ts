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

async function session(root: string, b: SlowBaseline, budget: number | undefined) {
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
    ...(budget !== undefined ? { timeBudgetSeconds: budget } : {}),
  });
  return { report, events };
}

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
