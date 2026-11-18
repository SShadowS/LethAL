// R766 step (b), the orchestrator side of `--workers N` on al-runner v3: the refusals, the pull queue
// of procedure scopes, the per-mutant table equal to N = 1 under a forced interleaving, and the stop
// rule. The backend is a scripted fake with lane views; "time" is a count of event-loop turns.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { AlRunnerV3ServeFallbackWarmupError } from "../src/al-runner-v3-backend";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { ParallelStopError } from "../src/parallel-queue";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { removeScratchDirs } from "./helpers/scratch";

// Three procedures, two comparisons each, so each scope holds several mutants. The procedure of a mutant
// is read from its source line: P1 on lines 3-6, P2 on 8-11, P3 on 13-16.
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure P1(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit((Amount > Budget) and (Budget > 0));
    end;

    procedure P2(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit((Amount < Budget) or (Budget < 0));
    end;

    procedure P3(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit((Amount >= Budget) and (Budget >= 1));
    end;
}
`;
const TESTS_AL = `codeunit 79100 "Par Tests"
{
    Subtype = Test;

    [Test]
    procedure T1()
    begin
    end;

    [Test]
    procedure T2()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a93",
  name: "Sandbox R766 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const TEST_APP_JSON = JSON.stringify({
  id: "11111111-2222-3333-4444-555555555557",
  name: "t",
  publisher: "x",
  version: "1.0.0.0",
});
const procOfLine = (line: number): "P1" | "P2" | "P3" =>
  line <= 6 ? "P1" : line <= 11 ? "P2" : "P3";

const GUARD_INFO = {
  usedBytes: 30 * 2 ** 30,
  boundBytes: 28 * 2 ** 30,
  source: "/sys/fs/cgroup/memory.max",
};

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

/** What the fake does under a mutant. */
interface Script {
  /** Mutant code to the procedure it sits in (from a first N = 1 run). */
  procOf?: ReadonlyMap<string, string>;
  /** Event-loop turns a run under this mutant takes. */
  delay?: (code: string, test: string) => number;
  /** Does the test fail under this mutant? Default: T2 kills the first mutant of each procedure; both kill the rest. */
  fails?: (code: string, test: string) => boolean;
  /** A run under this mutant throws this (after its delay). */
  throwAt?: (code: string, test: string) => Error | undefined;
  /** The run under this mutant latches the batch (after its delay). */
  latchOn?: string;
  /** PR-108: this test times out under this mutant (every time it runs). */
  hangs?: (code: string, test: string) => boolean;
}

class ParStub implements ExecutionBackend {
  readonly killsMustReproduce = true;
  readonly inRunStopIsBudget = false;
  deploys = 0;
  lanesCalls: number[] = [];
  parallelRefusalText: string | undefined;
  laneStarts: boolean[] = [];
  /** Every run under a mutant: lane, mutant, test, in the order they started. */
  readonly runs: { lane: number; mutant: string; test: string }[] = [];
  /** Mutant codes in the order each lane first activated them. */
  readonly activations: { lane: number; mutant: string }[] = [];
  prefetchPlans: string[][] = [];
  /** R912: killed or survived rows in the store when each prefetch call arrived. */
  readonly scoredAtPrefetch: number[] = [];
  store: ResultsStore | undefined;
  /** R912: the baseline duration of every test, which sizes the windows. */
  baselineMs = 5;
  private inBaseline = false;
  private latch: { mutantId: string; why: string } | undefined;
  private views: ParView[] = [];
  private readonly root: ParView;
  /** Mutant codes in manifest order, first-of-procedure first: filled from the first activations. */
  private seen: string[] = [];

  constructor(private script: Script = {}) {
    this.root = new ParView(this, 0, false);
  }
  setScript(s: Script): void {
    this.script = s;
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: "al-runner-v3",
      authoritative: false,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "al-runner 3.0.0-test", binarySha256: "c".repeat(64) };
  }
  async deploy(): Promise<null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  baselinePhase(on: boolean): void {
    this.inBaseline = on;
  }
  async prefetchMutants(plans: readonly { mutantId: string }[]): Promise<void> {
    this.prefetchPlans.push(plans.map((p) => p.mutantId));
    const row = this.store?.db
      .query("SELECT COUNT(*) AS n FROM mutants WHERE verdict IN ('killed', 'survived')")
      .get() as { n: number } | null | undefined;
    this.scoredAtPrefetch.push(row?.n ?? -1);
  }
  parallelRefusal(): string | undefined {
    return this.parallelRefusalText;
  }
  laneMayStart(k: number): boolean {
    this.laneStarts.push(k > 0);
    return this.mayStart(k);
  }
  mayStart: (k: number) => boolean = () => true;
  lanes(n: number): ExecutionBackend[] {
    this.lanesCalls.push(n);
    this.views = Array.from({ length: n }, (_, k) => new ParView(this, k, true));
    return this.views;
  }
  latched(): { mutantId: string; why: string } | undefined {
    return this.latch;
  }
  /** R948: the guard refuses every group ask from this one on (and stops the session once). */
  refuseFromAsk: number | undefined;
  private asks = 0;
  private guardStopped = false;
  private handle: Parameters<NonNullable<ExecutionBackend["useStopHandle"]>>[0] | undefined;
  useStopHandle(h: Parameters<NonNullable<ExecutionBackend["useStopHandle"]>>[0]): void {
    this.handle = h;
  }
  async mayStartGroup(): Promise<boolean> {
    this.asks += 1;
    if (this.refuseFromAsk !== undefined && this.asks >= this.refuseFromAsk && !this.guardStopped) {
      this.guardStopped = true;
      this.handle?.stopForMemory(GUARD_INFO);
    }
    return !this.guardStopped;
  }
  // N = 1: the stub is its own (only) lane.
  activate = (id: string | null) => this.root.activate(id);
  run = (ref: TestMethodRef) => this.root.run(ref);

  // --- shared behaviour, called by the views
  /** R1014: called with each activated mutant and how many distinct ones that makes. */
  onActivation: ((id: string, distinct: number) => void) | undefined;
  noteActivation(lane: number, id: string): void {
    this.activations.push({ lane, mutant: id });
    if (!this.seen.includes(id)) this.seen.push(id);
    this.onActivation?.(id, new Set(this.activations.map((a) => a.mutant)).size);
  }
  isFirstOfProc(code: string): boolean {
    const proc = this.script.procOf?.get(code);
    if (proc === undefined) return false;
    const mine = [...(this.script.procOf?.keys() ?? [])]
      .filter((c) => this.script.procOf?.get(c) === proc)
      .sort();
    return mine[0] === code;
  }
  async verdictUnder(lane: number, code: string, ref: TestMethodRef): Promise<TestVerdict> {
    this.runs.push({ lane, mutant: code, test: ref.method });
    await ticks(this.script.delay?.(code, ref.method) ?? 1);
    const err = this.script.throwAt?.(code, ref.method);
    if (err !== undefined) throw err;
    if (this.script.latchOn === code && this.latch === undefined) {
      this.latch = { mutantId: code, why: "batchBlind: scripted" };
    }
    if (this.script.hangs?.(code, ref.method) === true)
      return { ref, outcome: "timeout", durationMs: 5, failureMessage: `stopped ${ref.method}` };
    const fails =
      this.script.fails?.(code, ref.method) ??
      (this.isFirstOfProc(code) ? ref.method === "T2" : true);
    return fails
      ? { ref, outcome: "fail", durationMs: 5, failureMessage: `Assert failed under ${code}` }
      : { ref, outcome: "pass", durationMs: 5 };
  }
  baselineVerdict(ref: TestMethodRef): TestVerdict {
    return {
      ref,
      outcome: "pass",
      durationMs: this.baselineMs,
      // R963: v3 reports the test's own time; without it the estimate splits one call's wall.
      measuredDurationMs: this.baselineMs,
      coverage: {
        granularity: "procedure" as const,
        entries: ["P1", "P2", "P3"].map((procedure) => ({
          objectType: "Codeunit",
          objectId: 79000,
          procedure,
        })),
      },
    };
  }
  get baseline(): boolean {
    return this.inBaseline;
  }
}

class ParView implements ExecutionBackend {
  readonly killsMustReproduce = true;
  readonly inRunStopIsBudget = false;
  /** PR-99: set by `splitOwner` only; the owner decides by its own shape whether a lane prefetches. */
  prefetchHook: ((plans: readonly { readonly mutantId: string }[]) => Promise<void>) | undefined;
  async prefetchMutants(plans: readonly { readonly mutantId: string }[]): Promise<void> {
    await this.prefetchHook?.(plans);
  }
  private active: string | null = null;
  constructor(
    private readonly b: ParStub,
    readonly laneIndex: number,
    private readonly lane: boolean,
  ) {}
  capabilities(): BackendCapabilities {
    return this.b.capabilities();
  }
  status(): Promise<BackendStatus> {
    return this.b.status();
  }
  deploy(): Promise<null> {
    throw new Error("owner-only: deploy");
  }
  compileCheck(): Promise<void> {
    throw new Error("owner-only: compileCheck");
  }
  latched() {
    return this.b.latched();
  }
  mayStartGroup(): Promise<boolean> {
    return this.b.mayStartGroup();
  }
  async activate(id: string | null): Promise<void> {
    this.active = id;
    if (id !== null) this.b.noteActivation(this.laneIndex, id);
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) return this.b.baselineVerdict(ref);
    return this.b.verdictUnder(this.laneIndex, this.active, ref);
  }
}

beforeAll(async () => {
  await initParser();
});
const roots: string[] = [];
afterEach(() => {
  removeScratchDirs(roots.splice(0));
});

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "lethal-r766-"));
  roots.push(root);
  await Bun.write(join(root, "app", "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(root, "app", "app.json"), APP_JSON);
  await Bun.write(join(root, "tests", "ParTests.Codeunit.al"), TESTS_AL);
  await Bun.write(join(root, "tests", "app.json"), TEST_APP_JSON);
  return root;
}

let n = 0;
const session = (
  root: string,
  backend: ParStub,
  extra: Partial<SessionConfig> = {},
  events: RunEvent[] = [],
): Promise<SessionReport> =>
  runSession({
    backend,
    store: new ResultsStore(":memory:"),
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, `instr-${++n}`),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    emit: [(e) => events.push(e)],
    ...extra,
  });

/** The per-mutant table of a report: everything a verdict is made of. */
const table = (r: SessionReport) =>
  r.mutants.map((m) => ({
    code: m.mutantCode,
    verdict: m.verdict,
    killingTest: m.killingTest ?? null,
    note: m.failureNote ?? null,
  }));

/**
 * Two N = 1 runs: the first to learn the mutants and the procedure of each, the second under the
 * script that knows them, which is the reference table every parallel run must equal.
 */
async function learn(
  root: string,
): Promise<{ procOf: Map<string, string>; report: SessionReport }> {
  const first = await session(root, new ParStub());
  const procOf = new Map<string, string>();
  for (const m of first.mutants) procOf.set(m.mutantCode, procOfLine(m.line));
  return { procOf, report: await session(root, new ParStub({ procOf })) };
}

describe("R766 (b): --workers refusals", () => {
  test("above the cap of 8 is refused by name, before anything is deployed", async () => {
    const root = await project();
    const stub = new ParStub();
    await expect(session(root, stub, { workers: 9 })).rejects.toThrow(/al-runner-v3-workers-cap/);
    expect(stub.deploys).toBe(0);
    expect(stub.lanesCalls).toEqual([]);
  });

  test("a backend's refusal (the §6 Sleep rule not retired, or a transport but serve-entries) is the session's, verbatim, before a deploy", async () => {
    const root = await project();
    const stub = new ParStub();
    stub.parallelRefusalText =
      "al-runner-v3-workers-refused: parallel v3 needs a build whose pin retires the §6 Sleep rule (R766, R768)";
    await expect(session(root, stub, { workers: 2 })).rejects.toThrow(
      "parallel v3 needs a build whose pin retires the §6 Sleep rule",
    );
    expect(stub.deploys).toBe(0);
    expect(stub.lanesCalls).toEqual([]);
  });

  test("N = 1 is unchanged by a refusal: no lanes are built, the session runs", async () => {
    const root = await project();
    const stub = new ParStub();
    stub.parallelRefusalText = "al-runner-v3-workers-refused: anything";
    const r = await session(root, stub, { workers: 1 });
    expect(stub.lanesCalls).toEqual([]);
    expect(stub.deploys).toBeGreaterThan(0);
    expect(r.counts.killed).toBeGreaterThan(0);
  });

  test("a backend that cannot run lanes is refused by name", async () => {
    const root = await project();
    const stub = new ParStub();
    // A backend without the lane methods (not a `ParStub`): the owner shape is missing.
    const bare: ExecutionBackend = {
      capabilities: () => stub.capabilities(),
      status: () => stub.status(),
      deploy: () => stub.deploy(),
      compileCheck: () => stub.compileCheck(),
      activate: (id) => stub.activate(id),
      run: (ref) => stub.run(ref),
    };
    await expect(
      runSession({
        backend: Object.assign(bare, { runnerBuild: () => stub.runnerBuild() }),
        store: new ResultsStore(":memory:"),
        projectDir: join(root, "app"),
        testDir: join(root, "tests"),
        instrumentedDir: join(root, "instr-bare"),
        selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
        workers: 2,
      }),
    ).rejects.toThrow(
      /al-runner-v3-workers-refused: --workers 2 > 1 needs a v3 backend that can run lanes/,
    );
  });
});

describe("R766 (b): the pull queue over procedure scopes", () => {
  test("with a quick lane B and a slow lane A, the per-mutant table equals N = 1 (scope affinity)", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const perProc = (p: string) => [...procOf].filter(([, v]) => v === p).map(([k]) => k);
    // Every procedure holds at least two mutants, or the test below would prove nothing.
    for (const p of ["P1", "P2", "P3"]) expect(perProc(p).length).toBeGreaterThanOrEqual(2);
    const firsts = new Set(["P1", "P2", "P3"].map((p) => perProc(p).sort()[0] ?? ""));
    const stub = new ParStub({
      procOf,
      // The first mutant of each procedure is slow, the others are quick: a lane that took a later
      // mutant of the same procedure would finish it before the first one has taught the ledger.
      delay: (code) => (firsts.has(code) ? 40 : 1),
    });
    const events: RunEvent[] = [];
    const par = await session(root, stub, { workers: 2 }, events);
    expect(table(par)).toEqual(table(one));
    // The ledger made T2 first for every later mutant of a procedure: that is N = 1's killingTest.
    const laterKills = par.mutants.filter((m) => !firsts.has(m.mutantCode));
    expect(laterKills.length).toBeGreaterThan(0);
    expect(laterKills.every((m) => m.killingTest === "T2")).toBe(true);
    // Both lanes worked, each scope stayed on one lane, and the owner prefetched once.
    expect(new Set(stub.activations.map((a) => a.lane))).toEqual(new Set([0, 1]));
    for (const p of ["P1", "P2", "P3"]) {
      const lanes = new Set(
        stub.activations.filter((a) => procOf.get(a.mutant) === p).map((a) => a.lane),
      );
      expect(lanes.size).toBe(1);
    }
    expect(stub.prefetchPlans).toHaveLength(1);
    expect(stub.lanesCalls).toEqual([2]);
    // The events came in manifest order, as at N = 1.
    const scored = events.flatMap((e) => (e.type === "mutant-scored" ? [e.mutant.mutantId] : []));
    expect(scored).toEqual(one.mutants.map((m) => m.mutantCode));
  });

  test("R912: several windows under --workers 2 give the one-window table, and window 1 is in the store before window 2's prefetch", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const store = new ResultsStore(":memory:");
    const stub = new ParStub({ procOf });
    stub.store = store;
    stub.baselineMs = 150_000; // two tests: 300 s a mutant, so two mutants to a 600 s window
    const par = await session(root, stub, { workers: 2, store });
    expect(table(par)).toEqual(table(one));
    const windows = stub.prefetchPlans;
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(windows.every((w) => w.length <= 2)).toBe(true);
    expect(windows.flat()).toEqual(one.mutants.map((m) => m.mutantCode));
    // Counters, not clocks: when window k's prefetch arrives, windows 0..k-1 are all recorded.
    let before = 0;
    windows.forEach((w, k) => {
      expect(stub.scoredAtPrefetch[k]).toBe(before);
      before += w.length;
    });
    // Both lanes still worked.
    expect(new Set(stub.activations.map((a) => a.lane)).size).toBe(2);
  });

  test("each mutant is handed out exactly once: one first activation per mutant, across all lanes", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf });
    await session(root, stub, { workers: 3 });
    const codes = one.mutants.map((m) => m.mutantCode);
    const firstActivations = stub.activations.filter((a) => a.mutant !== undefined);
    // A kill is re-activated for its reproduction on the SAME lane (R577); count per lane per mutant.
    for (const c of codes) {
      const lanes = new Set(firstActivations.filter((a) => a.mutant === c).map((a) => a.lane));
      expect(lanes.size).toBe(1);
    }
    expect([...new Set(firstActivations.map((a) => a.mutant))].sort()).toEqual([...codes].sort());
  });

  test("a lane held back by the memory check is not started; the session still finishes", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf });
    stub.mayStart = () => false;
    const par = await session(root, stub, { workers: 3 });
    expect(table(par)).toEqual(table(one));
    expect(new Set(stub.activations.map((a) => a.lane))).toEqual(new Set([0]));
    expect(stub.laneStarts.length).toBe(2); // lanes 1 and 2 were asked; lane 0 never is
  });
});

describe("R785: the orchestrator feeds the start rule", () => {
  /** An owner that can say its warm-up and which mutants need a live call, and records the notice. */
  function paced(stub: ParStub, o: { warm: number; live: boolean }) {
    const asked: string[] = [];
    const notices: string[] = [];
    Object.assign(stub, {
      laneWarmupMs: () => o.warm,
      laneDaemonStarts: () => 1,
      needsLiveCall: (id: string) => {
        asked.push(id);
        return o.live;
      },
      noteLanes: (m: string) => notices.push(m),
    });
    return { asked, notices };
  }

  test("prefetched mutants are not live work: no cost is learned, one lane runs, the notice says why", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf });
    const { asked, notices } = paced(stub, { warm: 1000, live: false });
    const par = await session(root, stub, { workers: 3 });
    expect(table(par)).toEqual(table(one));
    expect(asked.length).toBeGreaterThan(0); // the weight filter asked the owner
    expect(new Set(stub.activations.map((a) => a.lane))).toEqual(new Set([0]));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^1 of 3 lanes started: no lane 0 live unit finished/);
  });

  test("live units give a cost: a warm-up far longer than the queued work keeps one lane, reason cost", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf });
    const { notices } = paced(stub, { warm: 1e12, live: true });
    const par = await session(root, stub, { workers: 3 });
    expect(table(par)).toEqual(table(one));
    expect(new Set(stub.activations.map((a) => a.lane))).toEqual(new Set([0]));
    expect(notices).toEqual([
      "1 of 3 lanes started: the queued live work was not longer than one warm-up (lane 0's warm-up 1000000000.0 s)",
    ]);
  });
});

describe("R766 (b): the stop rule, through a session", () => {
  const scoredCodes = (events: readonly RunEvent[]): string[] =>
    events.flatMap((e) => (e.type === "mutant-scored" ? [e.mutant.mutantId] : []));

  test("a latch: the session ends with an error naming the cause and the discarded mutants; only the kept ones are scored", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const codes = one.mutants.map((m) => m.mutantCode);
    // The latcher: the second mutant of P2, late in the manifest but not last.
    const p2 = codes.filter((c) => procOf.get(c) === "P2");
    const x = p2[1] ?? "";
    expect(x).not.toBe("");
    const xi = codes.indexOf(x);
    expect(xi).toBeLessThan(codes.length - 1);
    const stub = new ParStub({
      procOf,
      latchOn: x,
      // X is slow, so every earlier mutant is done before it latches; the P3 mutants (after X) are quick.
      delay: (c) => (c === x ? 60 : 1),
    });
    const events: RunEvent[] = [];
    const err = await session(root, stub, { workers: 3 }, events).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParallelStopError);
    const stop = err as ParallelStopError;
    // Kept: the mutants before X in manifest order, and X. Nothing after X was recorded or emitted.
    expect(scoredCodes(events)).toEqual(codes.slice(0, xi + 1));
    expect(stop.message).toContain(x);
    expect(stop.message).toContain("batchBlind: scripted");
    // At least one mutant after X had FINISHED (P3 is quick): it is named as discarded, not scored.
    expect(stop.discarded.length).toBeGreaterThan(0);
    for (const d of stop.discarded) {
      expect(codes.indexOf(d)).toBeGreaterThan(xi);
      expect(scoredCodes(events)).not.toContain(d);
    }
  });

  test("a session-stopping throw: the thrower is not recorded either, and what finished after it is discarded", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const codes = one.mutants.map((m) => m.mutantCode);
    const x = codes.filter((c) => procOf.get(c) === "P2")[1] ?? "";
    const xi = codes.indexOf(x);
    const stub = new ParStub({
      procOf,
      delay: (c) => (c === x ? 60 : 1),
      throwAt: (c) => (c === x ? new Error("al-runner-v3: scripted session stop") : undefined),
    });
    const events: RunEvent[] = [];
    const err = await session(root, stub, { workers: 3 }, events).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParallelStopError);
    expect((err as ParallelStopError).message).toContain("scripted session stop");
    expect(scoredCodes(events)).toEqual(codes.slice(0, xi));
    expect((err as ParallelStopError).discarded).toContain(x);
  });

  test("without a stop the same script records every mutant", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf, delay: () => 1 });
    const events: RunEvent[] = [];
    await session(root, stub, { workers: 3 }, events);
    expect(scoredCodes(events)).toEqual(one.mutants.map((m) => m.mutantCode));
  });
});

describe("R948: the memory guard refusing a group", () => {
  test("sequential: the refused group is not activated, and unscheduledCount is everything not run", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const total = one.mutants.length;
    const stub = new ParStub({ procOf });
    stub.refuseFromAsk = 3; // groups 1 and 2 start, the 3rd is refused
    const r = await session(root, stub, { workers: 1 });
    // (a kill is activated again to confirm it, so count distinct mutants)
    expect(new Set(stub.activations.map((a) => a.mutant)).size).toBe(2);
    expect(r.mutants).toHaveLength(2);
    expect(r.timeBudget?.stoppedByMemory).toEqual(GUARD_INFO);
    expect(r.timeBudget?.unscheduledCount).toBe(total - 2);
  });

  test("--workers 2: a refusal in a lane ends the session as the memory stop, never R766's never-finished throw; what was not recorded is counted", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const total = one.mutants.length;
    const stub = new ParStub({ procOf, delay: () => 3 });
    stub.refuseFromAsk = 3;
    const r = await session(root, stub, { workers: 2 });
    expect(r.timeBudget?.stoppedByMemory).toEqual(GUARD_INFO);
    expect(r.mutants.length).toBeLessThan(total);
    expect(r.timeBudget?.unscheduledCount).toBeGreaterThan(0);
    // Every covered mutant is either in the report or counted as left out: nothing vanishes.
    expect(r.mutants.length + (r.timeBudget?.unscheduledCount ?? 0)).toBe(total);
  });

  test("with no refusal the same parallel run has no memory field (the other direction)", async () => {
    const root = await project();
    const { procOf } = await learn(root);
    const r = await session(root, new ParStub({ procOf }), { workers: 2 });
    expect(r.timeBudget).toBeUndefined();
  });
});

// R1014 (coord PR-07): R-998's DO window ran 40 min past its budget and a SIGTERM: a lane checked the
// budget only between windows, and the mutant in flight was recorded from a killed al-runner.
describe("R1014: a stop signal is honoured inside a window, and the mutant it cut is not recorded", () => {
  const signalAt = (stub: ParStub, at: number): Partial<SessionConfig> => {
    let stop: (() => void) | undefined;
    let cut: string | undefined;
    stub.onActivation = (id, distinct) => {
      if (distinct === at && cut === undefined) {
        cut = id;
        stop?.();
      }
    };
    return {
      registerStopSignal: (s) => {
        stop = s;
        return () => {};
      },
      // the code the signal cut, for the assertions
      ...({ cutCode: () => cut } as object),
    };
  };
  const cutOf = (extra: Partial<SessionConfig>) =>
    (extra as unknown as { cutCode: () => string | undefined }).cutCode();

  for (const workers of [1, 2]) {
    test(`--workers ${workers}: no mutant starts after the signal, the one it cut is not in the report, and every covered mutant is scored or counted`, async () => {
      const root = await project();
      const { procOf, report: one } = await learn(root);
      const total = one.mutants.length;
      const stub = new ParStub({ procOf, delay: () => 3 });
      const extra = signalAt(stub, 3);
      const r = await session(root, stub, { workers, ...extra });
      const cut = cutOf(extra);
      expect(cut).toBeDefined();
      expect(r.timeBudget?.stoppedBySignal).toBeDefined();
      // red without R1014: the window (here every mutant) ran on, and the cut mutant was recorded
      expect(r.mutants.length).toBeLessThan(total);
      expect(r.mutants.map((m) => m.mutantCode)).not.toContain(cut);
      expect(new Set(stub.activations.map((a) => a.mutant)).size).toBeLessThanOrEqual(2 + workers);
      expect(r.mutants.length + (r.timeBudget?.unscheduledCount ?? 0)).toBe(total);
    });
  }

  // PR-108 M1: `held-walk-capped` goes out with the row (inside the commit), so a lane commit that
  // `finish` drops leaves neither a row nor a warning.
  const FOUR_TESTS_AL = `codeunit 79100 "Par Tests"
{
    Subtype = Test;

    [Test]
    procedure T1() begin end;
    [Test]
    procedure T2() begin end;
    [Test]
    procedure T3() begin end;
    [Test]
    procedure T4() begin end;
}
`;
  const cappedWarnings = (events: readonly RunEvent[]): string[] =>
    events.flatMap((e) =>
      e.type === "warning" && e.code === "held-walk-capped" ? [e.message] : [],
    );
  const fourTestProject = async (): Promise<string> => {
    const root = await project();
    await Bun.write(join(root, "tests", "ParTests.Codeunit.al"), FOUR_TESTS_AL);
    return root;
  };
  const hangFirstThree = (code: string, test: string) =>
    code === "M0001" && ["T1", "T2", "T3"].includes(test);

  test("PR-108 M1 --workers 2: a capped mutant that is recorded emits exactly one held-walk-capped warning", async () => {
    const root = await fourTestProject();
    const { procOf } = await learn(root);
    const stub = new ParStub({ procOf, delay: () => 2, hangs: hangFirstThree });
    const events: RunEvent[] = [];
    const r = await session(root, stub, { workers: 2 }, events);
    expect(r.mutants.find((m) => m.mutantCode === "M0001")?.failureNote).toContain("PR-108");
    const w = cappedWarnings(events);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("M0001");
  });

  test("PR-108 M1 --workers 2: a capped mutant whose finish is dropped after another lane's stop emits no warning and has no row", async () => {
    const root = await fourTestProject();
    const { procOf } = await learn(root);
    const stub = new ParStub({
      procOf,
      // M0008 (the capped one; lane 1's first mutant) is slow, so M0001 latches the batch first;
      // M0008 is later in the manifest and finishes after the stop, so its commit is discarded.
      delay: (c) => (c === "M0008" ? 15 : 3),
      latchOn: "M0001",
      hangs: (c, t) => c === "M0008" && ["T1", "T2", "T3"].includes(t),
    });
    const events: RunEvent[] = [];
    const err = await session(root, stub, { workers: 2 }, events).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParallelStopError);
    // the capped walk did run (3 hangs, then the replay), so the warning's absence is the commit's
    expect(stub.runs.filter((x) => x.mutant === "M0008" && x.test === "T3").length).toBeGreaterThan(
      0,
    );
    // red when the warning is emitted before `finish`: a warning for a mutant with no row
    expect(cappedWarnings(events)).toEqual([]);
  });

  test("PR-108 --workers 2: a signal that cuts the LAST mutant before its first step leaves it out through the sink's stop, never a 'never finished' error", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const total = one.mutants.length;
    const stub = new ParStub({ procOf, delay: () => 3 });
    const extra = signalAt(stub, total);
    // red when the lane exits by `budgetSpent(at)` instead of `sink.memoryStop`: the commit throws
    // "mutant(s) were never finished or recorded" (R766)
    const r = await session(root, stub, { workers: 2, ...extra });
    const cut = cutOf(extra);
    expect(cut).toBeDefined();
    expect(stub.runs.filter((x) => x.mutant === cut)).toEqual([]);
    expect(r.mutants.map((m) => m.mutantCode)).not.toContain(cut);
    expect(r.mutants.length + (r.timeBudget?.unscheduledCount ?? 0)).toBe(total);
  });

  // PR-108: the budget is also checked BEFORE each covering step, and a lane leaves through the sink's stop.
  for (const workers of [1, 2]) {
    test(`PR-108 --workers ${workers}: a signal that arrives as a mutant starts runs none of its covering steps and records nothing`, async () => {
      const root = await project();
      const { procOf, report: one } = await learn(root);
      const total = one.mutants.length;
      const stub = new ParStub({ procOf, delay: () => 3 });
      const extra = signalAt(stub, 3);
      const r = await session(root, stub, { workers, ...extra });
      const cut = cutOf(extra);
      expect(cut).toBeDefined();
      // red without the in-walk check: the cut mutant's steps ran before its record was dropped
      expect(stub.runs.filter((x) => x.mutant === cut)).toEqual([]);
      expect(r.mutants.map((m) => m.mutantCode)).not.toContain(cut);
      expect(r.mutants.length + (r.timeBudget?.unscheduledCount ?? 0)).toBe(total);
    });
  }

  test("--workers 2: a --time-budget that runs out inside a window (no signal) starts no further mutant; the ones in flight keep their verdicts", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const total = one.mutants.length;
    const stub = new ParStub({ procOf, delay: () => 3 });
    // 10 s of clock per distinct mutant activated: a 25 s budget runs out at the third
    const clockMs = () => new Set(stub.activations.map((a) => a.mutant)).size * 10_000;
    const r = await session(root, stub, { workers: 2, timeBudgetSeconds: 25, clockMs });
    expect(r.timeBudget?.stoppedBySignal).toBeUndefined();
    // red without the lane's own check: the budget was read between windows only, and the one
    // window held every mutant
    expect(r.mutants.length).toBeLessThan(total);
    expect(new Set(stub.activations.map((a) => a.mutant)).size).toBeLessThanOrEqual(4);
    expect(r.mutants.length + (r.timeBudget?.unscheduledCount ?? 0)).toBe(total);
    expect(r.mutants.every((m) => m.verdict !== "error")).toBe(true);
  });

  test("the other direction: with no signal, the same parallel run scores every mutant", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf, delay: () => 3 });
    stub.onActivation = () => {};
    const r = await session(root, stub, { workers: 2 });
    expect(r.mutants).toHaveLength(one.mutants.length);
    expect(r.timeBudget).toBeUndefined();
  });
});

/**
 * PR-99: makes the stub a SPLIT owner (the batch setup, the barrier, the lane gate) whose lane views prefetch
 * their own unit. `barrierAfter`: ticks lane 0's first unit prefetch takes before the barrier passes (absent:
 * it never passes). `throwOn`: a lane's unit prefetch that throws.
 */
function splitOwner(
  stub: ParStub,
  o: { barrierAfter?: number; throwOn?: (lane: number, ids: string[]) => Error | undefined },
) {
  const calls: { lane: number; ids: string[]; activationsBefore: number }[] = [];
  const prepared: string[][] = [];
  const launched: number[] = [];
  const ended: number[] = [];
  const watchers = new Set<() => void>();
  let passed = false;
  /** `watches`: one per window's queue (each `runScopeQueue` watches the gate once). */
  const state = { activationsAtBarrier: -1, watches: 0, windows: [] as readonly number[] };
  Object.assign(stub, {
    noteWindows: (sizes: readonly number[]) => {
      state.windows = sizes;
    },
    prepareBatch: (p: readonly { mutantId: string }[]) =>
      void prepared.push(p.map((x) => x.mutantId)),
    barrierPassed: () => passed,
    laneGateMeasured: () => true,
    watchLaneGate: (cb: () => void) => {
      state.watches += 1;
      watchers.add(cb);
      return () => void watchers.delete(cb);
    },
    launchLane: (k: number) => void launched.push(k),
    releaseLane: (k: number) => void ended.push(k),
  });
  const base = stub.lanes.bind(stub);
  stub.lanes = (n: number) => {
    const views = base(n) as ParView[];
    for (const v of views) {
      v.prefetchHook = async (plans) => {
        const ids = plans.map((p) => p.mutantId);
        calls.push({ lane: v.laneIndex, ids, activationsBefore: stub.activations.length });
        const err = o.throwOn?.(v.laneIndex, ids);
        if (err !== undefined) throw err;
        if (v.laneIndex === 0 && !passed && o.barrierAfter !== undefined) {
          await ticks(o.barrierAfter);
          passed = true;
          state.activationsAtBarrier = stub.activations.length;
          for (const cb of [...watchers]) cb();
        }
      };
    }
    return views;
  };
  return { calls, prepared, launched, ended, state };
}

describe("PR-99: the split prefetch, through a session", () => {
  const sorted = (xs: readonly string[]) => [...xs].sort();
  const codesOf = (procOf: ReadonlyMap<string, string>, p: string) =>
    sorted([...procOf].filter(([, v]) => v === p).map(([k]) => k));

  test("N = 3: one batch setup, no owner window prefetch; each lane prefetches exactly the unit it takes, before scoring it; the table equals N = 1", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const firsts = new Set(["P1", "P2", "P3"].map((p) => codesOf(procOf, p)[0] ?? ""));
    const stub = new ParStub({ procOf, delay: (code) => (firsts.has(code) ? 30 : 1) });
    const split = splitOwner(stub, { barrierAfter: 2 });
    const par = await session(root, stub, { workers: 3 });
    const all = sorted(one.mutants.map((m) => m.mutantCode));
    expect(table(par)).toEqual(table(one));
    expect(stub.prefetchPlans).toEqual([]); // no owner-wide window prefetch
    expect(split.prepared).toHaveLength(1); // the batch setup: once, whole batch
    expect(sorted(split.prepared[0] ?? [])).toEqual(all);
    // each call is one procedure scope; together they are every covered mutant, once
    for (const c of split.calls) expect(new Set(c.ids.map((id) => procOf.get(id))).size).toBe(1);
    expect(sorted(split.calls.flatMap((c) => c.ids))).toEqual(all);
    // prefetch before scoring: no mutant of a unit was activated before its unit's prefetch call
    for (const c of split.calls) {
      const first = stub.activations.findIndex((a) => c.ids.includes(a.mutant));
      expect(first).toBeGreaterThanOrEqual(c.activationsBefore);
    }
    // a unit is scored on the lane that prefetched it
    for (const c of split.calls) {
      const lanes = stub.activations.filter((a) => c.ids.includes(a.mutant)).map((a) => a.lane);
      expect(new Set(lanes)).toEqual(new Set([c.lane]));
    }
  });

  test("the barrier: no lane above 0 activates a mutant before lane 0's warm-up passed; the lanes then start while lane 0 is still in its first unit", async () => {
    const root = await project();
    const { procOf } = await learn(root);
    const slowFirst = sorted([...procOf.keys()])[0];
    const stub = new ParStub({ procOf, delay: (code) => (code === slowFirst ? 60 : 1) });
    const split = splitOwner(stub, { barrierAfter: 3 });
    await session(root, stub, { workers: 3 });
    expect(split.state.activationsAtBarrier).toBeGreaterThanOrEqual(0);
    const before = stub.activations.slice(0, split.state.activationsAtBarrier);
    expect(before.every((a) => a.lane === 0)).toBe(true);
    expect(stub.activations.some((a) => a.lane === 1)).toBe(true); // started by the callback
    const lane1 = stub.activations.findIndex((a) => a.lane === 1);
    expect(lane1).toBeGreaterThanOrEqual(split.state.activationsAtBarrier);
    expect(new Set(split.launched).size).toBe(split.launched.length); // no lane index twice
    expect(sorted(split.ended.map(String))).toEqual(sorted(split.launched.map(String))); // each released
  });

  test("a barrier that never passes keeps the run on lane 0 (a failed warm-up launches nothing)", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf });
    const split = splitOwner(stub, {});
    const par = await session(root, stub, { workers: 3 });
    expect(table(par)).toEqual(table(one));
    expect(new Set(stub.activations.map((a) => a.lane))).toEqual(new Set([0]));
    expect(split.launched).toEqual([]);
  });

  test("a throw in a lane's unit prefetch, before the unit's first begin, is blamed on unit[0] (selfKept false), not on the lane's previous unit", async () => {
    const root = await project();
    const { procOf } = await learn(root);
    // P1 is slow on lane 0, so P2 finishes first on lane 1 and waits for it; P3's prefetch then throws. Two
    // lanes, so P3 is lane 1's SECOND unit (r6: with three, lane 2 would take P3 at once).
    const stub = new ParStub({ procOf, delay: (code) => (procOf.get(code) === "P1" ? 80 : 1) });
    splitOwner(stub, {
      barrierAfter: 1,
      throwOn: (_lane, ids) =>
        procOf.get(ids[0] ?? "") === "P3" ? new Error("prefetch refused: boom") : undefined,
    });
    const events: RunEvent[] = [];
    const err = await session(root, stub, { workers: 2 }, events).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParallelStopError);
    expect(String(err)).toContain("prefetch refused: boom");
    const scored = events.flatMap((e) => (e.type === "mutant-scored" ? [e.mutant.mutantId] : []));
    // Every P2 mutant finished before the stop and precedes P3's first mutant: all kept. Blamed on the
    // previous unit's last mutant instead, the last P2 mutant would be the stopping one, with selfKept false.
    expect(sorted(scored)).toEqual(codesOf(procOf, "P2"));
  });

  test("r6 (§13): under the split a window holds N lanes' work (N x 600 s); the table equals N = 1", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const stub = new ParStub({ procOf });
    stub.baselineMs = 150_000; // two tests: 300 s a mutant, so 2 to a 600 s window and 6 to a 3 x 600 s one
    const split = splitOwner(stub, { barrierAfter: 1 });
    const par = await session(root, stub, { workers: 3 });
    expect(table(par)).toEqual(table(one));
    const n = one.mutants.length;
    expect(n).toBeGreaterThan(6); // so the two caps give different counts
    // The window cut still uses the split caps: ceil(n / 6) windows (ceil(n / 2) with the 600 s cap).
    expect(split.state.windows).toHaveLength(Math.ceil(n / 6));
    // PR-151: one queue per batch under the split (no window barrier), so one watch whatever the cap
    expect(split.state.watches).toBe(1);
  });

  test("PR-151 F1: one lane, the time budget spent between two units: no throw, the first unit is recorded, the rest is counted", async () => {
    const root = await project();
    const { procOf, report: one } = await learn(root);
    const first = codesOf(procOf, "P1").length;
    const lastP1 = codesOf(procOf, "P1").at(-1);
    // This session test stays green without take()'s budget clause (R1014's per-mutant check also ends the
    // run); the guard for the clause is the queue-level test 7 in pr151-lookahead.test.ts.
    // the clock jumps past the budget once P1's last mutant has run (it is killed by its first test)
    let late = false;
    const stub = new ParStub({
      procOf,
      delay: () => 1,
      fails: (code) => {
        if (code === lastP1) late = true;
        return true;
      },
    });
    splitOwner(stub, {}); // the barrier never passes: lane 0 only
    const clockMs = () => (late ? 100_000 : 0);
    const r = await session(root, stub, { workers: 3, timeBudgetSeconds: 50, clockMs });
    expect(r.mutants).toHaveLength(first);
    expect(r.timeBudget?.unscheduledCount).toBe(one.mutants.length - first);
  });

  test("lane 0's session-first warm-up fallback (R960/R786) reaches the caller raw, and the run is marked abandoned", async () => {
    const root = await project();
    const { procOf } = await learn(root);
    const stub = new ParStub({ procOf });
    splitOwner(stub, {
      throwOn: (lane) =>
        lane === 0 ? new AlRunnerV3ServeFallbackWarmupError("Codeunit1.T", "Company") : undefined,
    });
    const store = new ResultsStore(":memory:");
    const err = await session(root, stub, { workers: 3, store }).catch((e: unknown) => e);
    // red without the unwrap: a ParallelStopError, so the CLI's named --workers refusal and R786's mark miss
    expect(err).toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    const id = (err as AlRunnerV3ServeFallbackWarmupError).abandonedRunId;
    expect(typeof id).toBe("number");
    expect(store.getRun(id ?? -1)?.configFingerprint?.endsWith("|abandoned")).toBe(true);
    store.close();
  });

  test("N = 1: the loop records per-unit scoring times and per-window prefetch walls (the scheduling bound's input)", async () => {
    const root = await project();
    const stub = new ParStub();
    type Got = {
      units: { scope: string; mutants: number; entries: number; scoringMs: number }[];
      windows: { entries: number; prefetchMs: number }[];
    };
    const got: Got[] = [];
    Object.assign(stub, { noteUnitTimings: (t: Got) => void got.push(t) });
    const r = await session(root, stub, {});
    expect(got).toHaveLength(1);
    const t = got[0];
    expect(t?.units.map((u) => u.mutants).reduce((a, b) => a + b, 0)).toBe(r.mutants.length);
    expect(new Set(t?.units.map((u) => u.scope)).size).toBe(3); // P1, P2, P3
    expect(t?.units.every((u) => u.scoringMs >= 0 && u.entries > 0)).toBe(true);
    expect(t?.windows.length).toBeGreaterThanOrEqual(1);
    expect(t?.windows.every((w) => w.prefetchMs >= 0 && w.entries > 0)).toBe(true);
  });
});
