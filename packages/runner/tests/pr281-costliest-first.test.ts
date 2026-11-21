// PR-281 (docs/superpowers/specs/2026-11-21-pr281-costliest-first.md): the split queue hands out the costliest
// procedure scope first (LETHAL_V3_UNIT_ORDER=manifest keeps the manifest order), the daemon-churn guard counts
// from a lane's last FINISHED mutant, and the session-first warm-up's mode comes from the batch's manifest-first
// mutant. Call counters on stateful fakes only; never a clock.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { UNIT_ORDER_ENV, type V3DaemonClose, readUnitOrder } from "../src/al-runner-v3-backend";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { orderUnitsCostliestFirst } from "../src/parallel-queue";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { removeScratchDirs } from "./helpers/scratch";
import { A, CU, cleanRigs, lanesRig } from "./helpers/v3-lanes-rig";

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("PR-281: orderUnitsCostliestFirst (pure)", () => {
  type U = { id: string; w: number; c: number; mutants: string[] };
  const u = (id: string, w: number, c: number): U => ({
    id,
    w,
    c,
    mutants: [`${id}-1`, `${id}-2`],
  });
  const order = (units: readonly U[]) =>
    orderUnitsCostliestFirst(
      units,
      (x) => x.w,
      (x) => x.c,
    ).map((x) => x.id);

  test("within a window the costliest unit comes first", () => {
    expect(order([u("a", 0, 1), u("b", 0, 9), u("c", 0, 5)])).toEqual(["b", "c", "a"]);
  });

  test("windows never decrease, whatever the costs", () => {
    const out = orderUnitsCostliestFirst(
      [u("a", 0, 1), u("b", 1, 99), u("c", 0, 2), u("d", 2, 500), u("e", 1, 3)],
      (x) => x.w,
      (x) => x.c,
    );
    expect(out.map((x) => x.id)).toEqual(["c", "a", "b", "e", "d"]);
    const ws = out.map((x) => x.w);
    expect(ws).toEqual([...ws].sort((x, y) => x - y));
  });

  test("equal cost keeps the original order", () => {
    expect(order([u("a", 0, 4), u("b", 0, 4), u("c", 0, 4), u("d", 0, 7)])).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  test("a unit's mutants keep their order, the input is not changed, and the result is a new array", () => {
    const input = [u("a", 0, 1), u("b", 0, 9)];
    const out = orderUnitsCostliestFirst(
      input,
      (x) => x.w,
      (x) => x.c,
    );
    expect(out).not.toBe(input);
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
    expect(out.map((x) => x.mutants)).toEqual([
      ["b-1", "b-2"],
      ["a-1", "a-2"],
    ]);
    expect(out[1]).toBe(input[0]); // the same unit object: its mutants were never rebuilt
  });
});

describe("PR-281: the knob", () => {
  test("unset or empty is costliest; manifest is manifest; anything else is refused by name", () => {
    expect(readUnitOrder(undefined)).toBe("costliest");
    expect(readUnitOrder("")).toBe("costliest");
    expect(readUnitOrder("manifest")).toBe("manifest");
    for (const bad of ["costliest", "Manifest", " manifest", "1", "banana"])
      expect(() => readUnitOrder(bad)).toThrow(/^lethal-v3-unit-order-refused: /);
  });

  test("a bad env value refuses at construction, before any run", async () => {
    const was = process.env[UNIT_ORDER_ENV];
    process.env[UNIT_ORDER_ENV] = "banana";
    try {
      await expect(lanesRig({ lanes: 0 })).rejects.toThrow(/lethal-v3-unit-order-refused/);
    } finally {
      if (was === undefined) delete process.env[UNIT_ORDER_ENV];
      else process.env[UNIT_ORDER_ENV] = was;
      await cleanRigs();
    }
  });
});

// ---- a session on a split owner (a trimmed copy of r766-parallel-v3's stub) --------------------------------------
// P1 has one comparison, P2 two, P3 four: P3 is the costliest scope and the LAST in manifest order.
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure P1(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure P2(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit((Amount < Budget) or (Budget < 0));
    end;

    procedure P3(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit((Amount >= Budget) and (Budget >= 1) and (Amount <= 99) and (Budget <= 77));
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
const procOfLine = (line: number): "P1" | "P2" | "P3" =>
  line <= 6 ? "P1" : line <= 11 ? "P2" : "P3";

interface Script {
  procOf?: ReadonlyMap<string, string>;
  delay?: (code: string) => number;
  /** Daemon closes reported on lane `k`'s first run under each mutant. */
  closesPerMutant?: number;
  /** Split the coverage: T1 covers only P2 and takes 500 ms; T2 covers P1 and P3 and takes 5 ms. */
  slowT1OnP2?: boolean;
}

class ParStub implements ExecutionBackend {
  readonly killsMustReproduce = true;
  readonly inRunStopIsBudget = false;
  readonly activations: { lane: number; mutant: string }[] = [];
  closeSink: ((c: V3DaemonClose) => void) | undefined;
  unitOrderValue: "costliest" | "manifest" | undefined;
  private inBaseline = false;
  private views: ParView[] = [];
  constructor(readonly script: Script = {}) {}
  setDaemonCloseSink(sink?: (c: V3DaemonClose) => void): void {
    this.closeSink = sink;
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
    return null;
  }
  async compileCheck(): Promise<void> {}
  baselinePhase(on: boolean): void {
    this.inBaseline = on;
  }
  parallelRefusal(): string | undefined {
    return undefined;
  }
  laneMayStart(_k: number): boolean {
    return true;
  }
  lanes(n: number): ExecutionBackend[] {
    this.views = Array.from({ length: n }, (_, k) => new ParView(this, k));
    return this.views;
  }
  latched(): undefined {
    return undefined;
  }
  async mayStartGroup(): Promise<boolean> {
    return true;
  }
  private readonly root = new ParView(this, 0);
  activate = (id: string | null) => this.root.activate(id);
  run = (r: TestMethodRef) => this.root.run(r);
  async verdictUnder(code: string, r: TestMethodRef): Promise<TestVerdict> {
    await ticks(this.script.delay?.(code) ?? 1);
    // The first mutant of a procedure survives T1 and dies on T2; the others die on T1.
    const procOf = this.script.procOf;
    const proc = procOf?.get(code);
    const mine = [...(procOf?.keys() ?? [])].filter((c) => procOf?.get(c) === proc).sort();
    const first = mine[0] === code;
    const fails = first ? r.method === "T2" : true;
    return fails
      ? { ref: r, outcome: "fail", durationMs: 5, failureMessage: `Assert failed under ${code}` }
      : { ref: r, outcome: "pass", durationMs: 5 };
  }
  baselineVerdict(r: TestMethodRef): TestVerdict {
    const split = this.script.slowT1OnP2 === true;
    const t1 = r.method === "T1";
    const ms = split && t1 ? 500 : 5;
    const procs = !split ? ["P1", "P2", "P3"] : t1 ? ["P2"] : ["P1", "P3"];
    return {
      ref: r,
      outcome: "pass",
      durationMs: ms,
      measuredDurationMs: ms,
      coverage: {
        granularity: "procedure" as const,
        entries: procs.map((procedure) => ({
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
  /** The unit prefetches this lane was asked for, each as the mutant ids of the unit. */
  prefetchHook: ((ids: string[]) => Promise<void>) | undefined;
  private active: string | null = null;
  private readonly closedFor = new Set<string>();
  constructor(
    private readonly b: ParStub,
    readonly laneIndex: number,
  ) {}
  async prefetchMutants(plans: readonly { readonly mutantId: string }[]): Promise<void> {
    await this.prefetchHook?.(plans.map((p) => p.mutantId));
  }
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
    if (id !== null) this.b.activations.push({ lane: this.laneIndex, mutant: id });
  }
  async run(r: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) return this.b.baselineVerdict(r);
    const n = this.b.script.closesPerMutant ?? 0;
    if (n > 0 && !this.closedFor.has(this.active)) {
      this.closedFor.add(this.active);
      for (let i = 0; i < n; i++)
        this.b.closeSink?.({ lane: this.laneIndex, reason: "refusal", family: "x", phase: "live" });
    }
    return this.b.verdictUnder(this.active, r);
  }
}

/** Makes the stub a SPLIT owner: batch setup, barrier (opens after lane 0's first unit prefetch), lane gate. */
function splitOwner(stub: ParStub) {
  const calls: { lane: number; ids: string[] }[] = [];
  const watchers = new Set<() => void>();
  let passed = false;
  Object.assign(stub, {
    prepareBatch: () => {},
    barrierPassed: () => passed,
    laneGateMeasured: () => true,
    watchLaneGate: (cb: () => void) => {
      watchers.add(cb);
      return () => void watchers.delete(cb);
    },
    launchLane: () => {},
    releaseLane: () => {},
    ...(stub.unitOrderValue !== undefined ? { unitOrder: () => stub.unitOrderValue } : {}),
  });
  const base = stub.lanes.bind(stub);
  stub.lanes = (n: number) => {
    const views = base(n) as ParView[];
    for (const v of views) {
      v.prefetchHook = async (ids) => {
        calls.push({ lane: v.laneIndex, ids });
        if (v.laneIndex === 0 && !passed) {
          await ticks(1);
          passed = true;
          for (const cb of [...watchers]) cb();
        }
      };
    }
    return views;
  };
  return { calls };
}

const roots: string[] = [];
afterEach(() => {
  removeScratchDirs(roots.splice(0));
});
beforeAll(async () => {
  await initParser();
});

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "lethal-pr281-"));
  roots.push(root);
  await Bun.write(join(root, "app", "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(
    join(root, "app", "app.json"),
    JSON.stringify({
      id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a94",
      name: "Sandbox PR281 Fixture",
      publisher: "LethAL",
      version: "1.0.0.0",
      idRanges: [{ from: 79000, to: 79199 }],
    }),
  );
  await Bun.write(join(root, "tests", "ParTests.Codeunit.al"), TESTS_AL);
  await Bun.write(
    join(root, "tests", "app.json"),
    JSON.stringify({
      id: "11111111-2222-3333-4444-555555555558",
      name: "t",
      publisher: "x",
      version: "1.0.0.0",
    }),
  );
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

const scoredOrder = (events: readonly RunEvent[]): string[] =>
  events.flatMap((e) => (e.type === "mutant-scored" ? [e.mutant.mutantId] : []));

/** An N = 1 run: the mutants, the procedure of each, and the manifest order of the records. */
async function learn(root: string) {
  const events: RunEvent[] = [];
  const first = await session(root, new ParStub(), {}, events);
  const procOf = new Map<string, string>();
  for (const m of first.mutants) procOf.set(m.mutantCode, procOfLine(m.line));
  const codes = (p: string) => [...procOf].filter(([, v]) => v === p).map(([k]) => k);
  // the premise of every test below: P3 is the costliest scope and the last one in manifest order
  expect(codes("P3").length).toBeGreaterThan(codes("P2").length);
  expect(codes("P2").length).toBeGreaterThan(codes("P1").length);
  return { procOf, manifest: scoredOrder(events), total: first.mutants.length, first };
}

describe("PR-281: the split queue hands out the costliest scope first, through a session on 2 lanes", () => {
  test("the first runUnit is the costliest scope (last in manifest order); the records still commit in manifest order", async () => {
    const root = await project();
    const { procOf, manifest, total } = await learn(root);
    const stub = new ParStub({ procOf });
    const split = splitOwner(stub);
    const events: RunEvent[] = [];
    const par = await session(root, stub, { workers: 2 }, events);
    const first = split.calls[0];
    expect(first?.lane).toBe(0);
    expect(new Set(first?.ids.map((id) => procOf.get(id)))).toEqual(new Set(["P3"]));
    // red without the order: the first call is P1's (manifest-first)
    expect(par.mutants).toHaveLength(total);
    expect(scoredOrder(events)).toEqual(manifest);
  });

  test("cost is TIME, not mutant count: the middle scope with slow tests goes before the scope with the most mutants and the manifest-first one", async () => {
    const root = await project();
    const { procOf, manifest } = await learn(root);
    const stub = new ParStub({ procOf, slowT1OnP2: true });
    const split = splitOwner(stub);
    const events: RunEvent[] = [];
    await session(root, stub, { workers: 2 }, events);
    // P2: fewer mutants than P3, not manifest-first, but 500 ms tests against 5 ms. Count would pick P3, manifest P1.
    expect(new Set(split.calls[0]?.ids.map((id) => procOf.get(id)))).toEqual(new Set(["P2"]));
    expect(scoredOrder(events)).toEqual(manifest);
  });

  test("LETHAL_V3_UNIT_ORDER=manifest: the first runUnit is the manifest-first scope, the records are the same", async () => {
    const root = await project();
    const { procOf, manifest } = await learn(root);
    const stub = new ParStub({ procOf });
    stub.unitOrderValue = "manifest";
    const split = splitOwner(stub);
    const events: RunEvent[] = [];
    await session(root, stub, { workers: 2 }, events);
    expect(new Set(split.calls[0]?.ids.map((id) => procOf.get(id)))).toEqual(new Set(["P1"]));
    expect(scoredOrder(events)).toEqual(manifest);
  });
});

describe("PR-281: the churn guard counts from a lane's last FINISHED mutant", () => {
  test("records held back behind the unfinished manifest-first scope, a lane finishing mutants between daemon closes: no churn stop", async () => {
    const root = await project();
    const { procOf, total } = await learn(root);
    // P1 (manifest-first) is taken last under the new order and is slow, so P2's and P3's records wait for
    // it while their lanes finish mutant after mutant, 4 closes each (the guard stops at 10 in a row).
    const stub = new ParStub({
      procOf,
      closesPerMutant: 4,
      delay: (code) => (procOf.get(code) === "P1" ? 60 : 2),
    });
    splitOwner(stub);
    const events: RunEvent[] = [];
    const report = await session(root, stub, { workers: 2 }, events);
    const churn = events.filter(
      (e) => e.type === "warning" && e.code === "al-runner-v3-daemon-churn",
    );
    // red without the reset at finish: lane 0 closed 4 x 3 times with nothing COMMITTED, and the session stopped
    expect(churn).toEqual([]);
    expect(report.mutants).toHaveLength(total);
  });

  test("the other direction: closes with no mutant finished anywhere still stop the session", async () => {
    const root = await project();
    const { procOf } = await learn(root);
    // 10 closes on the very first mutant's run, before any lane finishes one
    const stub = new ParStub({ procOf, closesPerMutant: 10 });
    splitOwner(stub);
    const events: RunEvent[] = [];
    await session(root, stub, { workers: 2 }, events);
    expect(
      events.filter((e) => e.type === "warning" && e.code === "al-runner-v3-daemon-churn"),
    ).toHaveLength(1);
  });
});

describe("PR-281: the session-first warm-up's mode is the manifest-first mutant's", () => {
  afterEach(cleanRigs);
  const refIn = (cu: number): TestMethodRef => ({ ...A, codeunitId: cu });
  const MODE_B_CU = CU + 1;

  /** Runs `warmSessionFirst` for lane 0's first unit and returns the mode (tag) of the daemon it asked for. */
  async function warmModeFor(
    batch: readonly { mutantId: string; cu: number }[],
    laneZeroUnit: readonly { mutantId: string; cu: number }[],
  ): Promise<string[]> {
    const r = await lanesRig({ lanes: 2 });
    const asPlans = (xs: readonly { mutantId: string; cu: number }[]) =>
      xs.map((x) => ({ mutantId: x.mutantId, refs: [refIn(x.cu)] }));
    const asked: string[] = [];
    const priv = r.b as unknown as {
      lane: unknown;
      modeOfCall: (id: number) => unknown;
      ensureDaemon: (lane: unknown, mode: { tag: string }) => Promise<void>;
      warmSessionFirst: (lane: unknown, plans: unknown) => Promise<void>;
    };
    priv.modeOfCall = (id: number) => ({ tag: id === MODE_B_CU ? "B" : "A" });
    priv.ensureDaemon = async (_lane, mode) => void asked.push(mode.tag);
    r.b.prepareBatch(asPlans(batch));
    await priv.warmSessionFirst(priv.lane, asPlans(laneZeroUnit));
    return asked;
  }

  const first = { mutantId: "M0001", cu: CU };
  const costly = { mutantId: "M0002", cu: MODE_B_CU };

  test("the costliest unit, in mode B, is taken first: the warm-up still runs in the manifest-first mutant's mode A", async () => {
    expect(await warmModeFor([first, costly], [costly])).toEqual(["A"]);
  });

  test("the other direction: a manifest-first mutant in mode B gives a mode B warm-up, whatever lane 0 took", async () => {
    expect(
      await warmModeFor(
        [
          { mutantId: "M0001", cu: MODE_B_CU },
          { mutantId: "M0002", cu: CU },
        ],
        [{ mutantId: "M0002", cu: CU }],
      ),
    ).toEqual(["B"]);
  });
});
