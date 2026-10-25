// R766 step (b), the orchestrator side of `--workers N` on al-runner v3: the refusals, the pull queue
// of procedure scopes, the per-mutant table equal to N = 1 under a forced interleaving, and the stop
// rule. The backend is a scripted fake with lane views; "time" is a count of event-loop turns.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
  // N = 1: the stub is its own (only) lane.
  activate = (id: string | null) => this.root.activate(id);
  run = (ref: TestMethodRef) => this.root.run(ref);

  // --- shared behaviour, called by the views
  noteActivation(lane: number, id: string): void {
    this.activations.push({ lane, mutant: id });
    if (!this.seen.includes(id)) this.seen.push(id);
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
      durationMs: 5,
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
