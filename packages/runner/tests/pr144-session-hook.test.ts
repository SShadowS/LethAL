import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipMutationText } from "@lethal/schemata";
import { V3_NOT_RUN_SUFFIX } from "../src/al-runner-v3-backend";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { type RecheckRequest, recheckSiteKey } from "../src/withheld-recheck";

/**
 * PR-144, at the runSession level with a stub backend: the nested session's two narrowing knobs
 * (`keepOnlyTests`, `exactSites`) and the hook that runs the recheck before `session-finished`.
 */

const APP_JSON = JSON.stringify({
  id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1028",
  name: "Recheck Hook Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
// IsOver's exit is on line 5 and holds more than one mutant.
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOver(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const FILE = "SandboxLogic.Codeunit.al";
const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure T()
    begin
    end;
}
`;
const WITHHELD = `NotRun: out-of-scope: a test before this one in the codeunit did not pass (T0: failed with X) and left state; this failure is not trusted: Expected 1 got 2 ${V3_NOT_RUN_SUFFIX}`;

async function withProject<T>(body: (projectDir: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-pr144-"));
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, FILE), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(root, "tests", "SandboxTests.Codeunit.al"), TEST_AL);
  try {
    return await body(projectDir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "al-runner-v3",
  authoritative: false,
};

class StubBackend implements ExecutionBackend {
  private activations: Array<string | null> = [];
  constructor(
    readonly log: string[],
    readonly opts: { methodIsolation?: boolean; serveEntries?: boolean; refuse?: boolean } = {},
  ) {}
  get methodIsolation(): boolean {
    return this.opts.methodIsolation === true;
  }
  get serveEntries(): boolean {
    return this.opts.serveEntries === true;
  }
  async closeDaemons(): Promise<void> {
    this.log.push("closeDaemons");
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    if (active !== null && this.opts.refuse === true) {
      return {
        ref,
        outcome: "error",
        durationMs: 1,
        failureMessage: WITHHELD,
        operation: "completed-accepted",
        runnerRow: "runner-refused",
      };
    }
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOver" }],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

function session(projectDir: string, root: string, store: ResultsStore, backend: StubBackend) {
  return {
    backend,
    store,
    projectDir,
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
    selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
  };
}

describe("keepOnlyTests and exactSites (the nested session's knobs)", () => {
  test("keepOnlyTests is refused unless the backend runs method isolation", async () => {
    await withProject(async (projectDir, root) => {
      const store = new ResultsStore(":memory:");
      try {
        await expect(
          runSession({
            ...session(projectDir, root, store, new StubBackend([])),
            keepOnlyTests: ["Sandbox Tests.T"],
          }),
        ).rejects.toThrow(/needs a backend running method isolation/);
      } finally {
        store.close();
      }
    });
  });

  test("keepOnlyTests refuses a name with no test", async () => {
    await withProject(async (projectDir, root) => {
      const store = new ResultsStore(":memory:");
      try {
        await expect(
          runSession({
            ...session(projectDir, root, store, new StubBackend([], { methodIsolation: true })),
            keepOnlyTests: ["Sandbox Tests.T", "Sandbox Tests.Nope"],
          }),
        ).rejects.toThrow(/matched no test for "Sandbox Tests.Nope"/);
      } finally {
        store.close();
      }
    });
  });

  test("keepOnlyTests with a real name runs (control for the two refusals)", async () => {
    await withProject(async (projectDir, root) => {
      const store = new ResultsStore(":memory:");
      try {
        const r = await runSession({
          ...session(projectDir, root, store, new StubBackend([], { methodIsolation: true })),
          keepOnlyTests: ["Sandbox Tests.T"],
        });
        expect(r.mutants.length).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    });
  });

  test("exactSites keeps exactly one of two specs on the same line", async () => {
    await withProject(async (projectDir, root) => {
      const lines = [{ file: FILE, start: 5, end: 5 }];
      const onLine = (await generateMutationSet(projectDir, { lines })).files.flatMap(
        (f) => f.specs,
      );
      expect(onLine.length).toBeGreaterThan(1);
      const pick = onLine[0];
      if (pick === undefined) throw new Error("unreachable");
      const key = recheckSiteKey({
        file: FILE,
        startIndex: pick.before.startIndex,
        endIndex: pick.before.endIndex,
        operatorName: pick.operatorName,
        mutatedText: clipMutationText(pick.after.text),
      });
      const kept = (
        await generateMutationSet(projectDir, { lines, exactSites: new Set([key]) })
      ).files.flatMap((f) => f.specs);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.after.text).toBe(pick.after.text);
      // Through a whole session as well: exactly one mutant is scored.
      const store = new ResultsStore(":memory:");
      try {
        const r = await runSession({
          ...session(projectDir, root, store, new StubBackend([])),
          lines,
          exactSites: new Set([key]),
        });
        expect(r.mutants).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });
});

describe("runSession: the recheck hook", () => {
  async function run(
    recheck: { budgetSeconds: number; runner: (req: RecheckRequest) => Promise<never> } | undefined,
    backend: (log: string[]) => StubBackend,
  ) {
    const log: string[] = [];
    const events: RunEvent[] = [];
    const report = await withProject(async (projectDir, root) => {
      const store = new ResultsStore(":memory:");
      try {
        return await runSession({
          ...session(projectDir, root, store, backend(log)),
          emit: [(e) => events.push(e)],
          ...(recheck !== undefined ? { recheck } : {}),
        });
      } finally {
        store.close();
      }
    });
    return { log, events, report };
  }

  /** A nested run that scores nothing: every target stays error with a named rule. */
  const emptyRunner = (log: string[], calls: RecheckRequest[]) => ({
    budgetSeconds: 30,
    runner: async (req: RecheckRequest) => {
      log.push("runner");
      calls.push(req);
      return {
        rows: [],
        baseline: [{ name: "Sandbox Tests.T", outcome: "pass" as const }],
        baselineElapsedMs: 1,
        identity: {},
      } as never;
    },
  });

  test("the daemons are closed before the nested runner is called; its events land before session-finished", async () => {
    const calls: RecheckRequest[] = [];
    const log: string[] = [];
    const { events, report, log: l2 } = await runWithLog(log, calls);
    expect(l2).toBe(log);
    // Call counters on the shared log: one close, then one runner call, in that order.
    expect(log.filter((x) => x === "closeDaemons")).toHaveLength(1);
    expect(log.filter((x) => x === "runner")).toHaveLength(1);
    expect(log.indexOf("closeDaemons")).toBeLessThan(log.indexOf("runner"));
    expect(calls[0]?.tests).toEqual(["Sandbox Tests.T"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("mutant-rechecked");
    expect(types.indexOf("recheck-baseline-finished")).toBeLessThan(
      types.indexOf("mutant-rechecked"),
    );
    expect(types.lastIndexOf("mutant-rechecked")).toBeLessThan(types.indexOf("session-finished"));
    // Not recovered (no identity), so the rows stay error, still withheld kills, with the rule named.
    expect(report.mutants.every((m) => m.verdict === "error" && m.withheldKill !== undefined)).toBe(
      true,
    );
    expect(report.mutants[0]?.failureNote).toContain("[recheck kept error:");
  });

  async function runWithLog(log: string[], calls: RecheckRequest[]) {
    const r = await run(
      emptyRunner(log, calls) as never,
      () => new StubBackend(log, { serveEntries: true, refuse: true }),
    );
    return { ...r, log };
  }

  test("no recheck configured: nothing is closed early and nothing runs", async () => {
    const log: string[] = [];
    const r = await run(
      undefined,
      () => new StubBackend(log, { serveEntries: true, refuse: true }),
    );
    expect(log).toEqual([]);
    expect(r.events.some((e) => e.type === "mutant-rechecked")).toBe(false);
  });

  test("a main pass with no withheld kill sends nothing and closes nothing", async () => {
    const log: string[] = [];
    const calls: RecheckRequest[] = [];
    await run(emptyRunner(log, calls) as never, () => new StubBackend(log, { serveEntries: true }));
    expect(log).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
