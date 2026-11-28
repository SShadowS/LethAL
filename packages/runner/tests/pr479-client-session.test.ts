import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeForComparison } from "../itest/mutant-equality";
import {
  BCDEV_CLIENT,
  type BackendCapabilities,
  type BackendStatus,
  type ExecutionBackend,
  type TestMethodRef,
  type TestVerdict,
} from "../src/backend";
import { ClientConfirmationFailedError } from "../src/client-mode";
import { type ClientCodeunitResult, ClientRunFailure } from "../src/client-run";
import type { ClientAttestationRow } from "../src/client-transport";
import {
  clientCodeunitsOf,
  clientReach,
  confirmationFailures,
  firstScoredFailure,
  killReach,
  redBefore,
} from "../src/client-verdict";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import { QuarantineStore } from "../src/quarantine-store";
import type { MutantOutcome, SessionReport } from "../src/report";
import { quarantineResourceKey } from "../src/resource-key";
import { ResultsStore } from "../src/store";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-479 (479a) round 3b: a bcdev-client run through `runSession`, scored from whole-codeunit client ops. The backend
 * is a stateful stub of `runClientCodeunit` (the op itself, with the fake driver, is pr479-client-run.test.ts). Each
 * rule has a red test in each direction where one exists. Nothing here touches a server or /coord.
 */

const scratch = scratchDirs();
const REPO = join(import.meta.dir, "..", "..", "..");

// ---------------------------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------------------------

function crow(over: Partial<ClientAttestationRow> = {}): ClientAttestationRow {
  return {
    attemptId: "a1",
    opSeq: 1,
    codeunitId: 79100,
    method: "A1",
    loaded: true,
    loadedGeneration: 5,
    loadedMutantId: "M0001",
    observedAny: true,
    observedIdentityMismatch: false,
    observedActive: true,
    success: true,
    testMethodRuns: 1,
    sessionId: 9,
    serverGeneration: "g",
    databaseId: "d",
    ...over,
  };
}
function result(
  methods: Array<[string, "pass" | "fail", Partial<ClientAttestationRow>?]>,
): ClientCodeunitResult {
  return {
    codeunitId: 79100,
    methods: methods.map(([method, outcome, over], i) => ({
      method,
      outcome,
      row: crow({ method, testMethodRuns: i + 1, success: outcome === "pass", ...over }),
    })),
    boundSessionId: 9,
    generation: 5,
    workDates: { before: "d", after: "d" },
  };
}

describe("PR-479 round 3b: the pure client rules", () => {
  test("the codeunits keep their first-appearance order and declared method order", () => {
    const r = (codeunitId: number, method: string) =>
      ({ codeunitId, codeunitName: `C${codeunitId}`, method }) as TestMethodRef;
    expect(
      clientCodeunitsOf([r(2, "b"), r(1, "x"), r(2, "a")]).map((c) => [
        c.codeunitId,
        c.refs.map((x) => x.method),
      ]),
    ).toEqual([
      [2, ["b", "a"]],
      [1, ["x"]],
    ]);
  });

  // Red: drop the sort in firstScoredFailure: the array's first failure (A2) is taken.
  test("the killer is the first failing scored method by testMethodRuns, not by array order", () => {
    const r = result([
      ["A1", "fail"],
      ["A2", "fail"],
    ]);
    const reversed = { ...r, methods: [...r.methods].reverse() };
    expect(firstScoredFailure(reversed, new Set(["A1", "A2"]))?.method).toBe("A1");
    // a baseline-red (unscored) method is never the killer
    expect(firstScoredFailure(r, new Set(["A2"]))?.method).toBe("A2");
    expect(firstScoredFailure(r, new Set())).toBeUndefined();
  });

  // Red: make killReach use observedAny for statement grain, or observedActive for enclosing.
  test("reach: statement grain needs observedActive; enclosing and unplaced need observedAny (by-any)", () => {
    const anyOnly = result([["A1", "fail", { observedActive: false, observedAny: true }]]);
    const killer = anyOnly.methods[0];
    if (killer === undefined) throw new Error("no killer");
    expect(killReach(anyOnly, killer, "M0001", "statement")).toBeUndefined();
    expect(killReach(anyOnly, killer, "M0001", undefined)).toBeUndefined();
    expect(killReach(anyOnly, killer, "M0001", "enclosing")).toBe("by-any");
    expect(killReach(anyOnly, killer, "M0001", "unplaced")).toBe("by-any");
    const active = result([["A1", "fail"]]);
    const k2 = active.methods[0];
    if (k2 === undefined) throw new Error("no killer");
    expect(killReach(active, k2, "M0001", "statement")).toBe("active");
    const none = result([["A1", "fail", { observedActive: false, observedAny: false }]]);
    const k3 = none.methods[0];
    if (k3 === undefined) throw new Error("no killer");
    expect(killReach(none, k3, "M0001", "enclosing")).toBeUndefined();
  });

  // Red: drop the `testMethodRuns <=` term in killReach.
  test("reach counts only rows at or before the killer, of this mutant and this op's generation", () => {
    const after = result([
      ["A1", "fail", { observedActive: false, observedAny: false }],
      ["A2", "pass"],
    ]);
    const k = after.methods[0];
    if (k === undefined) throw new Error("no killer");
    expect(killReach(after, k, "M0001", "statement")).toBeUndefined();
    const other = result([["A1", "fail", { loadedMutantId: "M0002" }]]);
    const ko = other.methods[0];
    if (ko === undefined) throw new Error("no killer");
    expect(killReach(other, ko, "M0001", "statement")).toBeUndefined();
    const older = result([["A1", "fail", { loadedGeneration: 4 }]]);
    const kg = older.methods[0];
    if (kg === undefined) throw new Error("no killer");
    expect(killReach(older, kg, "M0001", "statement")).toBeUndefined();
  });

  test("the confirmation fails on any scored method that did not pass, and ignores unscored ones", () => {
    const r = result([
      ["A1", "pass"],
      ["A2", "fail"],
      ["A3", "fail"],
    ]);
    expect(confirmationFailures(r, new Set(["A1", "A2"]))).toEqual(["A2"]);
    expect(confirmationFailures(r, new Set(["A1"]))).toEqual([]);
  });

  test("redBefore names the baseline-red methods declared before the killer", () => {
    const base = {
      declared: ["A1", "A2", "A3"],
      scored: new Set(["A2", "A3"]),
      red: new Set(["A1"]),
    };
    expect(redBefore(base, "A3")).toEqual(["A1"]);
    expect(redBefore({ ...base, red: new Set(["A3"]) }, "A2")).toEqual([]);
  });

  // Red: return a reach for every grain in clientReach.
  test("a survivor's reach is present for statement grain only, from observedActive", () => {
    const cu = { codeunitId: 79100, codeunitName: "Alpha", refs: [] };
    const hit = [{ cu, result: result([["A1", "pass"]]) }];
    expect(clientReach(hit, "M0001", "statement")).toEqual({
      guardReached: true,
      reachedBy: ["Alpha.A1"],
    });
    const miss = [{ cu, result: result([["A1", "pass", { observedActive: false }]]) }];
    expect(clientReach(miss, "M0001", "statement")).toEqual({ guardReached: false, reachedBy: [] });
    expect(clientReach(hit, "M0001", "enclosing")).toBeUndefined();
    expect(clientReach(hit, "M0001", "unplaced")).toBeUndefined();
    expect(clientReach(hit, "M0001", undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The session: a stateful runClientCodeunit stub
// ---------------------------------------------------------------------------------------------

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure Notify(Amount: Decimal)
    begin
        if Amount > 0 then
            DoNotify();
    end;

    procedure DoNotify()
    begin
        Message('x');
    end;
}
`;
const TESTS_AL = `codeunit 79100 "Alpha Tests"
{
    Subtype = Test;

    [Test]
    procedure A1() begin end;

    [Test]
    procedure A2() begin end;
}

codeunit 79101 "Zulu Tests"
{
    Subtype = Test;

    [Test]
    procedure Z1() begin end;
}
`;
const PAGE_AL = `codeunit 79102 "Page Tests"
{
    Subtype = Test;

    [Test]
    procedure OpensCard()
    var
        Card: TestPage "Some Card";
    begin
        Card.OpenView();
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
const CLIENT: BackendCapabilities = {
  coverage: "none",
  deploy: "publish",
  isolation: "session",
  kind: BCDEV_CLIENT,
  authoritative: true,
};
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

/** What one method of one op answers. */
interface MethodAnswer {
  readonly outcome?: "pass" | "fail";
  readonly loaded?: boolean;
  readonly observedAny?: boolean;
  readonly observedActive?: boolean;
  readonly message?: string;
}
/** One op, as the stub sees it. `phase`: the baseline, a mutant run, (a) the confirmation, (b) the reproduction. */
interface OpContext {
  readonly codeunitId: number;
  readonly mutantId: string;
  readonly procedure: string | undefined;
  readonly phase: "baseline" | "mutant" | "confirm" | "reproduce";
}

/** The mutant ids each procedure of the instrumented target guards, read at deploy. */
function proceduresOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    if (!f.endsWith(".al")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const parts = text.split(/\bprocedure\s+(\w+)/);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const name = parts[i] ?? "";
      for (const m of (parts[i + 1] ?? "").matchAll(/Active\('(M\d+)'\)/g))
        if (m[1] !== undefined) out.set(m[1], name);
    }
  }
  return out;
}

class ClientStub implements ExecutionBackend {
  private readonly testApp = servesTestApp();
  fetchPublishedAppPackage = this.testApp.fetchPublishedAppPackage;
  microsoftMode = this.testApp.microsoftMode;
  readonly ops: Array<OpContext & { readonly methods: readonly string[] }> = [];
  private procedures = new Map<string, string>();
  private generation = 0;
  private lastMutant = "";
  private readonly mutantOps = new Map<string, number>();
  constructor(
    private readonly answer: (ctx: OpContext, method: string) => MethodAnswer = () => ({}),
    private readonly fail?: (ctx: OpContext) => Error | undefined,
  ) {}
  capabilities() {
    return CLIENT;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async clientPreflight(): Promise<void> {}
  async deploy(dir: string) {
    this.procedures = proceduresOf(dir);
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(): Promise<void> {}
  async run(): Promise<TestVerdict> {
    throw new Error("a client run never sends one method");
  }
  async runClientCodeunit(req: {
    readonly codeunitId: number;
    readonly declaredMethods: readonly string[];
    readonly mutantId: string;
  }): Promise<ClientCodeunitResult> {
    let phase: OpContext["phase"];
    const key = `${req.mutantId}|${req.codeunitId}`;
    if (req.mutantId === "") {
      phase = this.lastMutant === "" ? "baseline" : "confirm";
    } else {
      this.lastMutant = req.mutantId;
      const n = (this.mutantOps.get(key) ?? 0) + 1;
      this.mutantOps.set(key, n);
      phase = n === 1 ? "mutant" : "reproduce";
    }
    const ctx: OpContext = {
      codeunitId: req.codeunitId,
      mutantId: req.mutantId,
      procedure: this.procedures.get(req.mutantId),
      phase,
    };
    this.ops.push({ ...ctx, methods: req.declaredMethods });
    const err = this.fail?.(ctx);
    if (err !== undefined) throw err;
    this.generation += 1;
    const generation = this.generation;
    const mutant = req.mutantId !== "";
    return {
      codeunitId: req.codeunitId,
      methods: req.declaredMethods.map((method, i) => {
        const a = this.answer(ctx, method);
        const outcome = a.outcome ?? "pass";
        const loaded = a.loaded ?? true;
        return {
          method,
          outcome,
          ...(a.message !== undefined ? { failureMessage: a.message } : {}),
          row: {
            attemptId: `a${generation}`,
            opSeq: generation,
            codeunitId: req.codeunitId,
            method,
            loaded,
            loadedGeneration: loaded ? generation : 0,
            loadedMutantId: loaded ? req.mutantId : "",
            observedAny: a.observedAny ?? loaded,
            observedIdentityMismatch: false,
            observedActive: a.observedActive ?? (loaded && mutant),
            success: outcome === "pass",
            testMethodRuns: i + 1,
            sessionId: 100 + generation,
            serverGeneration: "g",
            databaseId: "d",
          },
        };
      }),
      boundSessionId: 100 + generation,
      generation,
      workDates: { before: "2026-10-01", after: "2026-10-01" },
    };
  }
}

async function project(extra: Record<string, string> = {}) {
  const root = scratch("lethal-pr479-3b-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TESTS_AL);
  for (const [name, text] of Object.entries(extra)) await Bun.write(join(testDir, name), text);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  return { projectDir, testDir, instrumentedDir: join(root, "instr"), root };
}

async function session(
  backend: ClientStub,
  o: { extra?: Record<string, string>; cfg?: Partial<Parameters<typeof runSession>[0]> } = {},
): Promise<{ report: SessionReport; events: RunEvent[]; root: string }> {
  const p = await project(o.extra);
  const events: RunEvent[] = [];
  const store = new ResultsStore(":memory:");
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: p.projectDir,
      testDir: p.testDir,
      instrumentedDir: p.instrumentedDir,
      selectorIds,
      experimentalClientMode: true,
      emit: [(e) => events.push(e)],
      ...o.cfg,
    });
    return { report, events, root: p.root };
  } finally {
    store.close();
  }
}

const byProc = (report: SessionReport, proc: string): MutantOutcome[] =>
  report.mutants.filter((m) => m.procedureName === proc);
const warningCodes = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === "warning" ? [e.code] : []));

/** A1 fails under every IsOverBudget mutant; every row reached. */
const killsWithA1 = (ctx: OpContext, method: string): MethodAnswer =>
  ctx.procedure === "IsOverBudget" && ctx.mutantId !== "" && method === "A1"
    ? { outcome: "fail", message: "boom" }
    : {};

describe("PR-479 round 3b: a client session", () => {
  test("the baseline runs each codeunit once with no mutant, in order, with its declared methods", async () => {
    const stub = new ClientStub();
    await session(stub);
    expect(
      stub.ops.filter((o) => o.phase === "baseline").map((o) => [o.codeunitId, o.methods]),
    ).toEqual([
      [79100, ["A1", "A2"]],
      [79101, ["Z1"]],
    ]);
  });

  // Red (each direction): remove the (a) op, the (b) op, or the reach check in scoreClientBatch.
  test("killed needs reach, (a) passing with no mutant and (b) failing again under the mutant", async () => {
    const stub = new ClientStub(killsWithA1);
    const { report } = await session(stub);
    const killed = byProc(report, "IsOverBudget");
    expect(killed.length).toBeGreaterThan(0);
    for (const m of killed) {
      expect(m.verdict).toBe("killed");
      expect(m.killingTest).toBe("A1");
      expect(m.killReproduced).toBe(true);
      expect(m.killPosition).toBe(1);
      expect(m.killingTestFailure).toBe("boom");
      // mutated run, then (a) with no mutant, then (b): in that order, all on the killing codeunit
      const at = stub.ops.findIndex((o) => o.mutantId === m.mutantCode);
      expect(stub.ops.slice(at, at + 3).map((o) => [o.phase, o.mutantId, o.codeunitId])).toEqual([
        ["mutant", m.mutantCode, 79100],
        ["confirm", "", 79100],
        ["reproduce", m.mutantCode, 79100],
      ]);
      expect(
        stub.ops.filter((o) => o.mutantId === m.mutantCode).map((o) => [o.phase, o.codeunitId]),
      ).toEqual([
        ["mutant", 79100],
        ["reproduce", 79100],
      ]);
    }
    // the others ran every codeunit and survived
    for (const m of report.mutants.filter((x) => x.procedureName !== "IsOverBudget")) {
      expect(m.verdict).toBe("survived");
      expect(stub.ops.filter((o) => o.mutantId === m.mutantCode).map((o) => o.codeunitId)).toEqual([
        79100, 79101,
      ]);
    }
  });

  // Red: drop the `throw new ClientConfirmationFailedError` (the kill would stand, or not reproduce).
  test("a failing (a) stops the run by name: confirmation-failed, never a kill", async () => {
    const stub = new ClientStub((ctx, method) =>
      ctx.phase === "confirm" && method === "A2" ? { outcome: "fail" } : killsWithA1(ctx, method),
    );
    const err = await session(stub).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientConfirmationFailedError);
    expect((err as ClientConfirmationFailedError).reason).toBe("confirmation-failed");
    expect((err as Error).message).toContain("A2");
    expect(stub.ops.some((o) => o.phase === "reproduce")).toBe(false);
  });

  // Red: accept a kill whose (b) passed (skip the `again.outcome !== "fail"` check).
  test("a (b) that passes is kill-not-reproduced, never a kill", async () => {
    const stub = new ClientStub((ctx, method) =>
      ctx.phase === "reproduce" ? {} : killsWithA1(ctx, method),
    );
    const { report } = await session(stub);
    for (const m of byProc(report, "IsOverBudget")) {
      expect(m.verdict).toBe("error");
      expect(m.cause).toBe("kill-not-reproduced");
    }
  });

  // Red: drop the reach check on the mutated run, or on the reproduction.
  test("no reach is client-kill-unreached, in the mutated run and in the reproduction", async () => {
    const unreached = new ClientStub((ctx, method) =>
      ctx.phase === "mutant" && ctx.procedure === "IsOverBudget" && method === "A1"
        ? { outcome: "fail", observedActive: false }
        : killsWithA1(ctx, method),
    );
    const a = await session(unreached);
    for (const m of byProc(a.report, "IsOverBudget")) {
      expect([m.verdict, m.cause]).toEqual(["error", "client-kill-unreached"]);
      expect(m.failureNote).toContain("the mutated run");
    }
    expect(unreached.ops.some((o) => o.phase === "confirm")).toBe(false);
    const unreachedAgain = new ClientStub((ctx, method) =>
      ctx.phase === "reproduce" && method === "A1"
        ? { outcome: "fail", observedActive: false }
        : killsWithA1(ctx, method),
    );
    const b = await session(unreachedAgain);
    for (const m of byProc(b.report, "IsOverBudget")) {
      expect([m.verdict, m.cause]).toEqual(["error", "client-kill-unreached"]);
      expect(m.failureNote).toContain("the reproduction");
    }
  });

  // Red: pass `undefined` instead of `m.reachGrain` to killReach in scoreClientBatch (the enclosing kill goes unreached).
  test("an enclosing-grain kill is accepted on observedAny and labelled reach-by-any; a statement one is not", async () => {
    const anyOnly = (ctx: OpContext, method: string): MethodAnswer =>
      ctx.mutantId !== "" && method === "A1" && ctx.procedure === "Notify"
        ? { outcome: "fail", observedActive: false, observedAny: true }
        : ctx.mutantId !== "" && method === "A1" && ctx.procedure === "IsOverBudget"
          ? { outcome: "fail", observedActive: false, observedAny: true }
          : {};
    const { report } = await session(new ClientStub(anyOnly));
    const enclosing = byProc(report, "Notify").filter((m) => m.reachGrain === "enclosing");
    expect(enclosing.length).toBeGreaterThan(0);
    for (const m of enclosing) {
      expect(m.verdict).toBe("killed");
      expect(m.failureNote).toContain("reach-by-any");
    }
    const statement = byProc(report, "IsOverBudget");
    expect(statement.every((m) => m.reachGrain === "statement")).toBe(true);
    for (const m of statement) expect(m.cause).toBe("client-kill-unreached");
  });

  // Red: put baseline-red methods into `scored` (drop the `m.outcome === "pass"` term).
  test("a baseline-red method never kills, still runs under every mutant, and a kill after it is named", async () => {
    // A1 is red at baseline and fails under every mutant; only A2 can kill (it fails under IsOverBudget mutants).
    const stub = new ClientStub((ctx, method) => {
      if (method === "A1") return { outcome: "fail" }; // red everywhere, the confirmation included
      if (method === "A2" && ctx.procedure === "IsOverBudget" && ctx.mutantId !== "")
        return { outcome: "fail" };
      return {};
    });
    const { report, events } = await session(stub);
    for (const m of report.mutants) expect(m.killingTest).not.toBe("A1");
    for (const m of byProc(report, "IsOverBudget")) {
      expect(m.verdict).toBe("killed");
      expect(m.killingTest).toBe("A2");
    }
    for (const m of report.mutants.filter((x) => x.procedureName !== "IsOverBudget"))
      expect(m.verdict).toBe("survived");
    // A1 still ran under every mutant
    for (const o of stub.ops.filter((x) => x.codeunitId === 79100))
      expect(o.methods).toContain("A1");
    const warn = events.find((e) => e.type === "warning" && e.code === "kill-after-red-method");
    expect(JSON.stringify(warn)).toContain("A2 after A1");
  });

  test("no kill-after-red-method on a run whose killer has no red method before it", async () => {
    const { events } = await session(new ClientStub(killsWithA1));
    expect(warningCodes(events)).not.toContain("kill-after-red-method");
  });

  // Red: make the client path score TestPage methods (drop `isUnscored` from the scored/red split).
  test("a TestPage method runs, is never a killer and is never counted", async () => {
    const stub = new ClientStub((ctx, method) =>
      method === "OpensCard" && ctx.mutantId !== "" ? { outcome: "fail" } : {},
    );
    const { report, events } = await session(stub, {
      extra: { "Page.Codeunit.al": PAGE_AL },
      cfg: { ciSessionKind: "client" },
    });
    for (const m of report.mutants) expect(m.verdict).toBe("survived");
    for (const m of report.mutants) expect(m.coveringTests).not.toContain("Page Tests.OpensCard");
    expect(stub.ops.some((o) => o.codeunitId === 79102 && o.phase === "mutant")).toBe(true);
    const base = events.find((e) => e.type === "baseline-batch-finished");
    const row =
      base?.type === "baseline-batch-finished"
        ? base.verdicts.find((v) => v.name === "Page Tests.OpensCard")
        : undefined;
    expect(row?.outcome).toBe("skip");
    expect(row?.failureMessage).toContain("client-ran-testpage-unscored");
  });

  // Red: give a non-statement grain a reach (return the reach for every grain), or read observedAny for it.
  test("a survivor's guardReached is present for statement grain, absent for enclosing", async () => {
    const quietIsOver = (ctx: OpContext): MethodAnswer =>
      ctx.procedure === "IsOverBudget" ? { observedActive: false } : {};
    const { report } = await session(new ClientStub(quietIsOver));
    const statementHit = report.mutants.filter(
      (m) => m.reachGrain === "statement" && m.procedureName !== "IsOverBudget",
    );
    expect(statementHit.length).toBeGreaterThan(0);
    for (const m of statementHit) {
      expect(m.guardReached).toBe(true);
      expect(m.reachedBy).toEqual(["Alpha Tests.A1", "Alpha Tests.A2", "Zulu Tests.Z1"]);
    }
    for (const m of byProc(report, "IsOverBudget")) expect(m.guardReached).toBe(false);
    const enclosing = report.mutants.filter((m) => m.reachGrain === "enclosing");
    expect(enclosing.length).toBeGreaterThan(0);
    for (const m of enclosing) {
      expect(m.verdict).toBe("survived");
      expect("guardReached" in m).toBe(false);
    }
  });

  // Red: feed the ledger nothing (the clean batch is discarded), or drop scoreClientBatch's gate call (the unclean one
  // is kept).
  test("attestation: a clean client batch is kept; one whose rows never loaded the binary is discarded", async () => {
    const clean = await session(new ClientStub());
    expect(clean.events.some((e) => e.type === "batch-invalidated")).toBe(false);
    expect(clean.report.mutants.every((m) => m.verdict === "survived")).toBe(true);
    const unclean = await session(
      new ClientStub((ctx) => (ctx.mutantId !== "" ? { loaded: false, observedAny: false } : {})),
    );
    const inv = unclean.events.find((e) => e.type === "batch-invalidated");
    expect(JSON.stringify(inv)).toContain("unattested artifact");
  });

  // Red: drop `quarantineIfInFlight` from `failed` in scoreClientBatch, or record the overrun as client-run-failed.
  test("an overrun is in-flight-unknown: the mutant is stranded, the lane quarantined, the run stopped", async () => {
    const p = await project();
    const quarantineDir = join(p.root, "q");
    const stub = new ClientStub(killsWithA1, (ctx) =>
      ctx.phase === "mutant" && ctx.mutantId === "M0002"
        ? new ClientRunFailure(
            "client-in-flight-unknown",
            "client-driver-deadline (client): no ran within 310000 ms",
            true,
          )
        : undefined,
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({
      backend: stub,
      store,
      projectDir: p.projectDir,
      testDir: p.testDir,
      instrumentedDir: p.instrumentedDir,
      selectorIds,
      experimentalClientMode: true,
      resourceServer: "http://bcwin",
      resourceServerInstance: "BC",
      quarantineDir,
    });
    store.close();
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    expect(m2?.verdict).toBe("error");
    expect(m2?.cause).toBe("stranded");
    expect(m2?.failureNote).toContain("client-in-flight-unknown");
    const q = await new QuarantineStore(quarantineDir).read(
      quarantineResourceKey({ server: "http://bcwin", serverInstance: "BC" }),
    );
    expect(q?.detail).toContain("client op in-flight-unknown");
    // no later mutant ran
    expect(stub.ops.some((o) => o.mutantId === "M0003")).toBe(false);
  });

  test("a lost Activate is client-activation-unknown, and quarantines; a named check is client-run-failed and the run goes on", async () => {
    const p = await project();
    const quarantineDir = join(p.root, "q");
    const stub = new ClientStub(undefined, (ctx) =>
      ctx.mutantId === "M0001"
        ? new ClientRunFailure("client-row-session", "row session 7 is not the bound session 8")
        : ctx.mutantId === "M0002"
          ? new ClientRunFailure("client-activation-unknown", "socket hang up", true)
          : undefined,
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({
      backend: stub,
      store,
      projectDir: p.projectDir,
      testDir: p.testDir,
      instrumentedDir: p.instrumentedDir,
      selectorIds,
      experimentalClientMode: true,
      resourceServer: "http://bcwin",
      resourceServerInstance: "BC",
      quarantineDir,
    });
    store.close();
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    expect([m1?.verdict, m1?.cause]).toEqual(["error", "client-run-failed"]);
    expect(m1?.failureNote).toContain("client-row-session");
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    expect([m2?.verdict, m2?.cause]).toEqual(["error", "client-activation-unknown"]);
    expect(
      await new QuarantineStore(quarantineDir).read(
        quarantineResourceKey({ server: "http://bcwin", serverInstance: "BC" }),
      ),
    ).not.toBeNull();
    expect(stub.ops.some((o) => o.mutantId === "M0003")).toBe(false);
  });

  test("a ClientRunFailure at baseline stops the run by name", async () => {
    const stub = new ClientStub(undefined, (ctx) =>
      ctx.phase === "baseline" && ctx.codeunitId === 79101
        ? new ClientRunFailure("client-incomplete", "a missing row")
        : undefined,
    );
    const err = await session(stub).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientRunFailure);
    expect((err as ClientRunFailure).reason).toBe("client-incomplete");
    expect(stub.ops.some((o) => o.phase === "mutant")).toBe(false);
  });

  test("the batch baseline WorkDate is the first op's, sent on every later op", async () => {
    const seen: Array<string | undefined> = [];
    const stub = new ClientStub();
    const inner = stub.runClientCodeunit.bind(stub);
    stub.runClientCodeunit = (req: Parameters<typeof inner>[0] & { baselineWorkDate?: string }) => {
      seen.push(req.baselineWorkDate);
      return inner(req);
    };
    const { events } = await session(stub);
    expect(seen[0]).toBeUndefined();
    expect(seen.slice(1).every((d) => d === "2026-10-01")).toBe(true);
    expect(seen.length).toBeGreaterThan(2);
    const base = events.find((e) => e.type === "baseline-batch-finished");
    expect(base?.type === "baseline-batch-finished" ? base.workDate : undefined).toBe("2026-10-01");
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: the bcwin fixture expectation (spec section 3)
// ---------------------------------------------------------------------------------------------

describe("PR-479 round 3b: the fixture end to end", () => {
  // Red: score through headless verdict text (e.g. drop the client arm in scoreBatch): the run throws
  // BcdevClientMethodRunError-like "a client run never sends one method".
  test("sandbox-app under a client stub: 3 kills by OverBudgetDetected, 17 + 6 survived, as itest:bcdev's table", async () => {
    // OverBudgetDetected fails under every IsOverBudget mutant (the headless killer of all three); every guard the
    // mutated procedure holds is reached by the test that calls it.
    const calls: Record<string, string> = {
      IsOverBudget: "OverBudgetDetected",
      ClampPercent: "ClampPercentRuns",
      ApplyAudit: "ClampPercentRuns",
      LogAudit: "ClampPercentRuns",
    };
    const stub = new ClientStub((ctx, method) => {
      if (ctx.mutantId === "") return {};
      const reached = ctx.procedure !== undefined && calls[ctx.procedure] === method;
      return {
        observedAny: reached,
        observedActive: reached,
        ...(reached && ctx.procedure === "IsOverBudget"
          ? { outcome: "fail" as const, message: "101 vs 100 must be over budget" }
          : {}),
      };
    });
    const root = scratch("lethal-pr479-e2e-");
    const store = new ResultsStore(":memory:");
    const report = await runSession({
      backend: stub,
      store,
      projectDir: join(REPO, "fixtures/sandbox-app"),
      testDir: join(REPO, "fixtures/sandbox-tests"),
      instrumentedDir: join(root, "instr"),
      selectorIds,
      experimentalClientMode: true,
    });
    store.close();
    expect(report.mutants.length).toBe(26);
    const killed = report.mutants.filter((m) => m.verdict === "killed");
    expect(killed.length).toBe(3);
    for (const m of killed) {
      expect(m.killingTest).toBe("OverBudgetDetected");
      expect(m.procedureName).toBe("IsOverBudget");
    }
    expect(report.mutants.filter((m) => m.verdict === "survived").length).toBe(23);
    // Per mutant, against the frozen headless table, joined on the gate's own full key plus the mutated text's hash:
    // killed and survived equal (killing test included); the six no-coverage read survived.
    const frozen = JSON.parse(
      readFileSync(join(REPO, "packages/runner/itest/bcdev.baseline.json"), "utf8"),
    ) as {
      entries: Array<{
        key: string;
        verdict: string;
        killingTest: string | null;
        mutatedTextSha256: string;
      }>;
    };
    expect(frozen.entries.length).toBe(26);
    expect(frozen.entries.filter((e) => e.verdict === "no-coverage").length).toBe(6);
    const rows = (xs: Array<[string, string, string, string | null]>) =>
      xs.map((x) => JSON.stringify(x)).sort();
    expect(
      rows(
        normalizeForComparison(report).map((m) => [
          m.key,
          m.mutatedTextSha256 ?? "",
          m.verdict,
          m.killingTest,
        ]),
      ),
    ).toEqual(
      rows(
        frozen.entries.map((e) => [
          e.key,
          e.mutatedTextSha256,
          e.verdict === "no-coverage" ? "survived" : e.verdict,
          e.killingTest,
        ]),
      ),
    );
    expect(report.validity.caveats).toContain("client-no-coverage");
  });
});
