import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipMutationText } from "@lethal/schemata";
import { type V3DaemonClose, V3_NOT_RUN_SUFFIX } from "../src/al-runner-v3-backend";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { TIME_BUDGET_EXIT_CODE, exitCodeForReport } from "../src/cli";
import type { RunEvent } from "../src/events";
import { V3_DAEMON_CHURN_CLOSES } from "../src/mutant-windows";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { CAVEAT_INTERPRETATIONS, renderConsole } from "../src/report";
import { ResultsStore } from "../src/store";
import { type RecheckRequest, recheckSiteKey, shouldRunRecheck } from "../src/withheld-recheck";

describe("shouldRunRecheck: the decision runSessionBody takes", () => {
  const recheck = { budgetSeconds: 1, runner: async () => ({}) };
  test("configured and safe: runs", () => {
    expect(shouldRunRecheck({ recheck, unsafe: false })).toBe(true);
  });
  test("a quarantined (unsafe) session: never runs", () => {
    expect(shouldRunRecheck({ recheck, unsafe: true })).toBe(false);
  });
  test("not configured: never runs", () => {
    expect(shouldRunRecheck({ recheck: undefined, unsafe: false })).toBe(false);
  });
});

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
    readonly opts: {
      methodIsolation?: boolean;
      serveEntries?: boolean;
      /** A number: only the first N mutant runs are refused (PR-277: the rest survive, so not every row errors). */
      refuse?: boolean | number;
      /** PR-277: called on each mutant run (1-based), before it answers. */
      onMutantRun?: (n: number, b: StubBackend) => void;
    } = {},
  ) {}
  private mutantRuns = 0;
  /** PR-277: the session's daemon-close sink (the PR-250 churn guard reads it). */
  sink: ((c: V3DaemonClose) => void) | undefined;
  setDaemonCloseSink(sink?: (c: V3DaemonClose) => void): void {
    this.sink = sink;
  }
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
    if (active !== null) {
      this.mutantRuns += 1;
      this.opts.onMutantRun?.(this.mutantRuns, this);
    }
    const refuse = this.opts.refuse;
    if (
      active !== null &&
      (refuse === true || (typeof refuse === "number" && this.mutantRuns <= refuse))
    ) {
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

/**
 * PR-277 (R1158), at the runSession level: a stopped session never starts the recheck and writes its report with
 * the skip warning; a signal during a recheck that would block abandons it, so the session still ends.
 */
describe("PR-277: a stopped session skips the recheck; a signal abandons one in progress", () => {
  type Hooks = {
    stop?: () => void;
    again?: () => void;
  };
  async function stoppedRun(o: {
    onMutantRun?: (n: number, b: StubBackend, h: Hooks) => void;
    runner?: (req: RecheckRequest) => Promise<never>;
    timeBudgetSeconds?: number;
    clockMs?: () => number;
    refuse?: number;
  }) {
    const log: string[] = [];
    const calls: RecheckRequest[] = [];
    const events: RunEvent[] = [];
    const h: Hooks = {};
    const runner =
      o.runner ??
      (async (req: RecheckRequest) => {
        log.push("runner");
        calls.push(req);
        return {
          rows: [],
          baseline: [{ name: "Sandbox Tests.T", outcome: "pass" as const }],
          baselineElapsedMs: 1,
          identity: {},
        } as never;
      });
    const report = await withProject(async (projectDir, root) => {
      const store = new ResultsStore(":memory:");
      try {
        const onMutantRun = o.onMutantRun;
        return await runSession({
          ...session(
            projectDir,
            root,
            store,
            new StubBackend(log, {
              serveEntries: true,
              refuse: o.refuse ?? true,
              ...(onMutantRun !== undefined
                ? { onMutantRun: (n: number, b: StubBackend) => onMutantRun(n, b, h) }
                : {}),
            }),
          ),
          emit: [(e) => events.push(e)],
          recheck: { budgetSeconds: 30, runner },
          registerStopSignal: (stop, again) => {
            h.stop = stop;
            h.again = again;
            return () => {};
          },
          ...(o.timeBudgetSeconds !== undefined ? { timeBudgetSeconds: o.timeBudgetSeconds } : {}),
          ...(o.clockMs !== undefined ? { clockMs: o.clockMs } : {}),
        });
      } finally {
        store.close();
      }
    });
    const skip = events.filter(
      (e) => e.type === "warning" && e.code === "al-runner-v3-recheck-skipped-stopped",
    );
    return { log, calls, events, report, skip, h };
  }

  function expectSkipped(r: Awaited<ReturnType<typeof stoppedRun>>, stopName: string) {
    expect(r.report.timeBudget).toBeDefined();
    // No recheck: the runner never ran and the main daemons were never closed for it.
    expect(r.calls).toHaveLength(0);
    expect(r.log).toEqual([]);
    expect(r.events.some((e) => e.type === "recheck-baseline-finished")).toBe(false);
    expect(r.skip).toHaveLength(1);
    const msg = r.skip[0]?.type === "warning" ? r.skip[0].message : "";
    expect(msg).toContain(stopName);
    expect(msg).toMatch(/[1-9]\d* withheld kill\(s\) stay error/);
    // The report is written, its withheld kills still withheld (as with the recheck off).
    expect(
      r.report.mutants.some((m) => m.verdict === "error" && m.withheldKill !== undefined),
    ).toBe(true);
    expect(r.events.at(-1)?.type).toBe("session-finished");
  }

  test("stopped by a signal: no recheck, the report is written with the skip warning", async () => {
    const r = await stoppedRun({ onMutantRun: (n, _b, h) => (n === 2 ? h.stop?.() : undefined) });
    expect(r.report.timeBudget?.stoppedBySignal).toBe(true);
    expectSkipped(r, "a SIGTERM or SIGINT");
  });

  test("stopped by the time budget: no recheck, the report is written with the skip warning", async () => {
    let now = 0;
    const r = await stoppedRun({
      timeBudgetSeconds: 1,
      clockMs: () => now,
      // The second mutant's call spends the budget (the first is scored, a withheld kill).
      onMutantRun: (n) => {
        if (n === 2) now += 5_000;
      },
    });
    expect(r.report.timeBudget?.stoppedBySignal).toBeUndefined();
    expectSkipped(r, "the --time-budget");
  });

  test("stopped by the churn guard: no recheck, the report is written with the skip warning", async () => {
    const r = await stoppedRun({
      onMutantRun: (n, b) => {
        if (n !== 1) return;
        for (let i = 0; i < V3_DAEMON_CHURN_CLOSES; i++)
          b.sink?.({ lane: 0, reason: "refusal", phase: "live" });
      },
    });
    expect(r.report.timeBudget?.stoppedByDaemonChurn).toBeDefined();
    expectSkipped(r, "the daemon-churn guard");
  });

  test("unstopped with targets: the recheck runs as before (control)", async () => {
    const r = await stoppedRun({});
    expect(r.report.timeBudget).toBeUndefined();
    expect(r.skip).toHaveLength(0);
    expect(r.log).toEqual(["closeDaemons", "runner"]);
    expect(r.events.some((e) => e.type === "recheck-baseline-finished")).toBe(true);
  });

  test("a second signal during a recheck that would block: the session ends, the daemons are closed, rows stay error", async () => {
    const log: string[] = [];
    let hooks: Hooks | undefined;
    const r = await stoppedRun({
      refuse: 1,
      onMutantRun: (_n, _b, h) => {
        hooks = h;
      },
      runner: async (req) => {
        log.push("runner");
        // The first signal reached the session after its main pass (so it was not stopped); the second follows.
        hooks?.stop?.();
        hooks?.again?.();
        expect(req.signal?.aborted).toBe(true);
        return new Promise<never>(() => {}); // never settles: only the abort can end the recheck
      },
    });
    expect(log).toEqual(["runner"]);
    // Closed before the runner, and again by the second signal.
    expect(r.log).toEqual(["closeDaemons", "closeDaemons"]);
    expect(r.events.some((e) => e.type === "recheck-baseline-finished")).toBe(false);
    const failed = r.events.find(
      (e) => e.type === "warning" && e.code === "withheld-recheck-failed",
    );
    expect(failed?.type === "warning" ? failed.message : "").toContain("SIGTERM or SIGINT");
    expectWithheldStayError(r.report);
    expect(r.events.at(-1)?.type).toBe("session-finished");
    // The report is a signal stop, so the CLI exits 7.
    expect(r.report.timeBudget?.stoppedBySignal).toBe(true);
    expect(exitCodeForReport(r.report)).toBe(TIME_BUDGET_EXIT_CODE);
  });

  test("ONE signal during a recheck: the nested run stops gracefully (not aborted), rows stay error, the report is a signal stop (exit 7)", async () => {
    const seen: { stop: boolean | undefined; abort: boolean | undefined }[] = [];
    let hooks: Hooks | undefined;
    const r = await stoppedRun({
      refuse: 1,
      onMutantRun: (_n, _b, h) => {
        hooks = h;
      },
      runner: async (req) => {
        hooks?.stop?.();
        // `stop` alone must not abort: only `again` does.
        seen.push({ stop: req.stop?.aborted, abort: req.signal?.aborted });
        return {
          rows: [],
          baseline: [{ name: "Sandbox Tests.T", outcome: "pass" as const }],
          baselineElapsedMs: 1,
          identity: {},
        } as never;
      },
    });
    expect(seen).toEqual([{ stop: true, abort: false }]);
    // Closed once, before the runner: the second signal's close never ran.
    expect(r.log).toEqual(["closeDaemons"]);
    expect(r.events.some((e) => e.type === "mutant-rechecked")).toBe(false);
    const failed = r.events.find(
      (e) => e.type === "warning" && e.code === "withheld-recheck-failed",
    );
    expect(failed?.type === "warning" ? failed.message : "").toContain("stopped it");
    expectWithheldStayError(r.report);
    expect(r.report.timeBudget).toMatchObject({
      stoppedBySignal: true,
      unscheduledCount: 0,
      afterMainPass: true,
    });
    expect(exitCodeForReport(r.report)).toBe(TIME_BUDGET_EXIT_CODE);
    // The banner says nothing is left to resume; it never tells the user to --resume.
    const text = renderConsole(r.report);
    expect(text).toContain("STOPPED BY SIGNAL (SIGTERM or SIGINT) AFTER THE MAIN PASS");
    expect(text).toContain("there is nothing to resume");
    expect(text).not.toContain("--resume");
  });

  test("a normal signal stop (in the mutants phase) still says --resume, not 'after the main pass' (control)", async () => {
    const r = await stoppedRun({ onMutantRun: (n, _b, h) => (n === 2 ? h.stop?.() : undefined) });
    expect(r.report.timeBudget?.afterMainPass).toBeUndefined();
    const text = renderConsole(r.report);
    expect(text).toContain("Run with --resume to continue.");
    expect(text).not.toContain("AFTER THE MAIN PASS");
  });

  test("the caveat's interpretation names the after-main-pass case", () => {
    expect(CAVEAT_INTERPRETATIONS["time-budget-reached"].meaning).toContain(
      "`timeBudget.afterMainPass`",
    );
    expect(CAVEAT_INTERPRETATIONS["time-budget-reached"].meaning).toContain(
      "there is nothing to resume",
    );
  });

  test("the churn guard tripping on the LAST mutant: a late time-budget-reached that carries the churn", async () => {
    const total = (await stoppedRun({ refuse: 1 })).report.mutants.length;
    expect(total).toBeGreaterThan(1);
    const r = await stoppedRun({
      refuse: 1,
      onMutantRun: (n, b) => {
        if (n !== total) return;
        for (let i = 0; i < V3_DAEMON_CHURN_CLOSES; i++)
          b.sink?.({ lane: 0, reason: "refusal", phase: "live" });
      },
    });
    expect(r.report.timeBudget).toMatchObject({
      stoppedByDaemonChurn: { lane: 0, closes: V3_DAEMON_CHURN_CLOSES },
      afterMainPass: true,
      unscheduledCount: 0,
    });
    expect(r.report.timeBudget?.stoppedBySignal).toBeUndefined();
    expect(r.skip).toHaveLength(1); // the recheck did not start
    expect(renderConsole(r.report)).toContain(
      "STOPPED BY THE DAEMON-CHURN GUARD AFTER THE MAIN PASS",
    );
  });

  test("no signal: no late time-budget-reached, exit 0 (control)", async () => {
    const r = await stoppedRun({ refuse: 1 });
    expect(r.events.some((e) => e.type === "time-budget-reached")).toBe(false);
    expect(exitCodeForReport(r.report)).toBe(0);
  });

  function expectWithheldStayError(report: Awaited<ReturnType<typeof stoppedRun>>["report"]) {
    const withheld = report.mutants.filter((m) => m.withheldKill !== undefined);
    expect(withheld.length).toBeGreaterThan(0);
    expect(withheld.every((m) => m.verdict === "error")).toBe(true);
    // Not every row errors, so the exit code reads the stop, not "nothing scored".
    expect(report.mutants.some((m) => m.verdict !== "error")).toBe(true);
  }
});
