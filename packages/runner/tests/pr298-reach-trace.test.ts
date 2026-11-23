import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { type RunCliConfig, v3RecheckOf } from "../src/cli";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { ReachTrace, ReachTraceError } from "../src/reach-trace";
import type { ReachTraceRow } from "../src/reach-trace";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-298 §1: the raw-reach trace (`LETHAL_REACH_TRACE`). The stub is a trimmed copy of
 * `orchestrator.test.ts`'s StubBackend (that file's scope is not exported): al-runner-v3 shaped,
 * attesting nothing, with line-granularity baseline coverage of `Sandbox Logic`.
 */

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
    procedure ATest()
    begin
    end;

    [Test]
    procedure BTest()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Sandbox Orchestrator Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "al-runner-v3",
  authoritative: false,
};
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };
/** The reach line of every `TARGET_AL` mutant in the instrumented text (see orchestrator.test.ts). */
const REACH_LINE = 13;

/** A table whose trigger no green test touches: its mutants take coverage's FALLBACK 2 ("all-green"). */
const TRIGGER_TABLE_AL = `table 79001 "Sandbox Table"
{
    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                if "No." = '' then
                    Error('blank');
            end;
        }
    }
}
`;

async function makeProject(withTable = false) {
  const root = scratch("lethal-pr298-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  if (withTable) await Bun.write(join(projectDir, "SandboxTable.Table.al"), TRIGGER_TABLE_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TESTS_AL);
  await Bun.write(
    join(testDir, "app.json"),
    '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
  );
  return { projectDir, testDir, instrumentedDir: join(root, "instr"), root };
}

class StubBackend implements ExecutionBackend {
  activations: Array<string | null> = [];
  isolationOf?: (codeunitId: number) => "test" | "method";
  constructor(
    private readonly script: (mutant: string | null, ref: TestMethodRef) => TestVerdict["outcome"],
    private readonly lines: (ref: TestMethodRef) => number[],
  ) {}
  async runnerBuild() {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
  capabilities() {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy() {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null) {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    return {
      ref,
      outcome: this.script(active, ref),
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "line" as const,
              entries: this.lines(ref).map((line) => ({
                objectType: "Codeunit",
                objectId: 79000,
                procedure: "IsOverBudget",
                line,
              })),
            },
          }
        : {}),
    };
  }
}

const killedByA = (mutant: string | null, ref: TestMethodRef): TestVerdict["outcome"] =>
  mutant !== null && ref.method === "ATest" ? "fail" : "pass";

async function run(
  backend: ExecutionBackend,
  extra: { reachTrace?: ReachTrace | null; resume?: "last"; withTable?: boolean } = {},
) {
  const { withTable, ...cfgExtra } = extra;
  const dirs = await makeProject(withTable === true);
  const report = await runSession({
    backend,
    store: new ResultsStore(":memory:"),
    projectDir: dirs.projectDir,
    testDir: dirs.testDir,
    instrumentedDir: dirs.instrumentedDir,
    selectorIds,
    ...cfgExtra,
  });
  return { report, root: dirs.root };
}

const readRows = (path: string): ReachTraceRow[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as ReachTraceRow);

/** The rows that reached the loop with a decided grain: the ones carrying a reach line. */
const decided = (rows: ReachTraceRow[]) => {
  const d = rows.filter((r) => r.reachLine !== null);
  expect(d.length).toBeGreaterThan(0);
  return d;
};

describe("PR-298 §1: the raw-reach trace", () => {
  test("a kill whose baseline missed its line traces false, while the report stays undecided", async () => {
    const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
    const { report } = await run(new StubBackend(killedByA, () => [4]), {
      reachTrace: new ReachTrace(path),
    });
    for (const r of decided(readRows(path))) {
      expect(r.verdict).toBe("killed");
      expect(r.reachOverCovering).toBe(false);
      expect(r.reachOverRan).toBe(false);
      expect(r.killerBaselineHit).toBe(false);
      expect(r.nullCause).toBeNull();
      expect(r.reachFinal).toBeNull();
    }
    for (const m of report.mutants.filter((x) => x.verdict === "killed")) {
      expect(m.guardReached).toBeUndefined();
    }
  });

  test("a survivor's reachOverCovering equals its report guardReached", async () => {
    for (const hit of [true, false]) {
      const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
      const { report } = await run(
        new StubBackend(
          () => "pass",
          (ref) => (hit && ref.method === "BTest" ? [REACH_LINE] : [4]),
        ),
        { reachTrace: new ReachTrace(path) },
      );
      for (const r of decided(readRows(path))) {
        expect(r.verdict).toBe("survived");
        expect(r.reachOverCovering).toBe(hit);
        expect(r.reachFinal).toBe(hit);
        const row = report.mutants.find(
          (m) => m.file === r.file && m.line === r.startLine && m.operatorName === r.operatorName,
        );
        expect(row?.guardReached).toBe(hit);
      }
    }
  });

  test("reachOverCovering and reachOverRan differ when the kill stopped before a later test that reached", async () => {
    const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
    await run(new StubBackend(killedByA, (ref) => (ref.method === "BTest" ? [REACH_LINE] : [4])), {
      reachTrace: new ReachTrace(path),
    });
    for (const r of decided(readRows(path))) {
      expect(r.verdict).toBe("killed");
      expect(r.killingTest).toBe("Sandbox Tests.ATest");
      expect(r.reachOverCovering).toBe(true);
      expect(r.reachOverRan).toBe(false);
      expect(r.killerBaselineHit).toBe(false);
      expect(r.reachFinal).toBeNull();
    }
  });

  test("a reach with no line evidence names its cause", async () => {
    const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
    // BTest's baseline has procedure coverage only: the covering set has a test with no line evidence.
    class ProcedureOnlyB extends StubBackend {
      override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
        const v = await super.run(ref, opts);
        if (ref.method !== "BTest" || v.coverage === undefined) return v;
        const procedure = [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }];
        return { ...v, coverage: { granularity: "procedure" as const, entries: procedure } };
      }
    }
    await run(
      new ProcedureOnlyB(
        () => "pass",
        () => [4],
      ),
      { reachTrace: new ReachTrace(path) },
    );
    for (const r of decided(readRows(path))) {
      expect(r.reachOverCovering).toBeNull();
      expect(r.nullCause).toBe("no-line-evidence");
    }
  });

  test("an all-green mutant's covering reach is undecided, never a decided false", async () => {
    const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
    await run(
      new StubBackend(
        () => "pass",
        () => [4],
      ),
      { reachTrace: new ReachTrace(path), withTable: true },
    );
    const rows = readRows(path);
    const table = rows.filter((r) => r.file.includes("SandboxTable"));
    expect(table.length).toBeGreaterThan(0);
    for (const r of table) {
      expect(r.reachOverCovering).toBeNull();
      expect(r.nullCause).toBe("all-green");
      expect(r.reachFinal).toBeNull();
    }
    // The control: the codeunit's survivors in the same session are decided.
    for (const r of decided(rows.filter((x) => x.file.includes("SandboxLogic")))) {
      expect(r.reachOverCovering).toBe(false);
    }
  });

  test("killerBaselineHit is null when the killer's mode moved since its baseline", async () => {
    for (const moved of [true, false]) {
      const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
      const backend = new StubBackend(killedByA, () => [4]);
      backend.isolationOf = () =>
        moved && backend.activations.some((a) => a !== null) ? "method" : "test";
      await run(backend, { reachTrace: new ReachTrace(path) });
      for (const r of decided(readRows(path))) {
        expect(r.verdict).toBe("killed");
        expect(r.killerBaselineHit).toBe(moved ? null : false);
      }
    }
  });

  test("the recheck's nested session never traces: the main trace survives", async () => {
    const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
    const main = new ReachTrace(path);
    const nestedCfgs: SessionConfig[] = [];
    const recheck = v3RecheckOf({
      parsed: { backendKind: "al-runner-v3" } as RunCliConfig,
      effectiveConfig: {
        alRunnerV3: { packagesDir: "/p", bcVersion: "28.0.1.1", path: "/x" },
      } as never,
      mainConfig: { reachTrace: main } as unknown as SessionConfig,
      build: async () => ({}) as never,
      newStore: () => new ResultsStore(":memory:"),
      scratchRoot: "/scratch",
      // The nested session is a real one, in this process, with the env naming the main file.
      runSession: async (cfg) => {
        nestedCfgs.push(cfg);
        process.env.LETHAL_REACH_TRACE = path;
        try {
          const { report } = await run(
            new StubBackend(
              () => "pass",
              () => [4],
            ),
            { reachTrace: cfg.reachTrace as ReachTrace | null },
          );
          return report;
        } finally {
          Reflect.deleteProperty(process.env, "LETHAL_REACH_TRACE");
        }
      },
    });
    const { report } = await run(
      new StubBackend(
        () => "pass",
        () => [4],
      ),
      { reachTrace: main },
    );
    const before = readRows(path).length;
    expect(before).toBe(report.mutants.length);
    await recheck?.runner({ targets: [], tests: [], budgetSeconds: 1 } as never).catch(() => {});
    expect(nestedCfgs).toHaveLength(1);
    expect(nestedCfgs[0]?.reachTrace).toBeNull();
    // PR-303: the recheck's nested session never prunes (its method-isolation baseline is not what PR-298 measured).
    expect(nestedCfgs[0]?.reachPrune).toBe(false);
    expect(readRows(path)).toHaveLength(before);
  });

  test("--resume with the knob is refused by name, before any run", async () => {
    const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
    const backend = new StubBackend(
      () => "pass",
      () => [4],
    );
    await expect(
      run(backend, { reachTrace: new ReachTrace(path), resume: "last" }),
    ).rejects.toThrow(ReachTraceError);
    expect(backend.activations).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("a trace short of a row fails the session by name", async () => {
    const path = join(scratch("lethal-pr298-trace-"), "trace.ndjson");
    class Dropping extends ReachTrace {
      private dropped = false;
      override append(row: ReachTraceRow): void {
        if (!this.dropped) {
          this.dropped = true;
          return;
        }
        super.append(row);
      }
    }
    await expect(
      run(
        new StubBackend(
          () => "pass",
          () => [4],
        ),
        { reachTrace: new Dropping(path) },
      ),
    ).rejects.toThrow(/reach-trace-count-mismatch/);
  });

  test("unset: no trace is built and nothing is written", async () => {
    expect(ReachTrace.fromEnv({})).toBeUndefined();
    expect(ReachTrace.fromEnv({ LETHAL_REACH_TRACE: "" })).toBeUndefined();
    expect(ReachTrace.fromEnv({ LETHAL_REACH_TRACE: "x.ndjson" })?.path).toBe("x.ndjson");
    const before = process.env.LETHAL_REACH_TRACE;
    Reflect.deleteProperty(process.env, "LETHAL_REACH_TRACE");
    try {
      const { report, root } = await run(
        new StubBackend(
          () => "pass",
          () => [4],
        ),
      );
      expect(report.mutants.length).toBeGreaterThan(0);
      expect(existsSync(join(root, "trace.ndjson"))).toBe(false);
    } finally {
      if (before !== undefined) process.env.LETHAL_REACH_TRACE = before;
    }
  });
});
