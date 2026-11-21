import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REACH_PRUNE_ENV } from "../src/al-runner-v3-backend";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import {
  ReachPruneError,
  pruneCodeunitsForReach,
  readReachPrune,
  runSession,
} from "../src/orchestrator";
import type { BaselineReach } from "../src/orchestrator";
import { objectKeyOf, testKeyOf } from "../src/selection";
import { ResultsStore } from "../src/store";
import { foldTiming, reachPruneMessage } from "../src/timing-summary";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-303: R1148 survivor pruning. The pure function first, then a session with two test
 * codeunits (A: two tests, B: one) on a stub shaped like al-runner-v3, with call logs.
 */

const scratch = scratchDirs();

// ---------------------------------------------------------------- the pure function

const SITE_LINE = 13;
const m = {
  reachGrain: "statement" as const,
  reachLine: SITE_LINE,
  objectType: "Codeunit",
  codeunitId: 79000,
};
const ref = (codeunitId: number, method: string): TestMethodRef => ({
  codeunitId,
  codeunitName: `CU${codeunitId}`,
  method,
});
const siteKey = `${objectKeyOf("Codeunit", 79000, "reach site")}:${SITE_LINE}`;
const otherKey = `${objectKeyOf("Codeunit", 79000, "reach site")}:4`;
const evidence = (
  rows: Array<[TestMethodRef, boolean | undefined]>,
  mode: "test" | "method" = "test",
): BaselineReach => ({
  hits: new Map(
    rows.flatMap(([r, hit]) =>
      hit === undefined ? [] : [[testKeyOf(r), new Set([hit ? siteKey : otherKey])] as const],
    ),
  ),
  modes: new Map(rows.map(([r]) => [r.codeunitId, mode] as const)),
});
const A1 = ref(79100, "A1");
const A2 = ref(79100, "A2");
const B1 = ref(79101, "B1");
const noMove = () => "test" as const;

describe("PR-303: pruneCodeunitsForReach", () => {
  test("a codeunit whose covering tests are all explicit false is dropped", () => {
    const ev = evidence([
      [A1, false],
      [A2, false],
      [B1, false],
    ]);
    expect(pruneCodeunitsForReach(m, [A1, A2, B1], ev, noMove)).toEqual([]);
    const kept = evidence([
      [A1, false],
      [A2, false],
      [B1, true],
    ]);
    expect(pruneCodeunitsForReach(m, [A1, A2, B1], kept, noMove)).toEqual([B1]);
  });

  test("the B1 shape: one reaching test keeps its whole codeunit, its false tests too; the other codeunit goes", () => {
    const ev = evidence([
      [A1, true],
      [A2, false],
      [B1, false],
    ]);
    expect(pruneCodeunitsForReach(m, [A1, A2, B1], ev, noMove)).toEqual([A1, A2]);
  });

  test("the order is kept", () => {
    const ev = evidence([
      [A1, false],
      [A2, true],
      [B1, true],
    ]);
    expect(pruneCodeunitsForReach(m, [B1, A2, A1], ev, noMove)).toEqual([B1, A2, A1]);
    const half = evidence([
      [A1, true],
      [A2, false],
      [B1, false],
    ]);
    expect(pruneCodeunitsForReach(m, [A2, B1, A1], half, noMove)).toEqual([A2, A1]);
  });

  test("null (no line evidence for a test) keeps its codeunit", () => {
    const ev = evidence([
      [A1, false],
      [A2, undefined],
      [B1, false],
    ]);
    expect(pruneCodeunitsForReach(m, [A1, A2, B1], ev, noMove)).toEqual([A1, A2]);
  });

  test("no evidence at all keeps everything", () => {
    expect(pruneCodeunitsForReach(m, [A1, B1], undefined, noMove)).toEqual([A1, B1]);
  });

  test("enclosing grain, and a statement with no reach line, keep everything", () => {
    const ev = evidence([
      [A1, false],
      [B1, false],
    ]);
    expect(
      pruneCodeunitsForReach({ ...m, reachGrain: "enclosing" as never }, [A1, B1], ev, noMove),
    ).toEqual([A1, B1]);
    expect(
      pruneCodeunitsForReach({ ...m, reachLine: undefined as never }, [A1, B1], ev, noMove),
    ).toEqual([A1, B1]);
  });

  test("a refused or failed baseline row (no line row for the test) keeps its codeunit", () => {
    // `baselineReachOf` leaves a failed, refused or naming-gap row out of `hits`: the test reads as undecided.
    const ev = evidence([
      [A1, undefined],
      [B1, false],
    ]);
    expect(pruneCodeunitsForReach(m, [A1, B1], ev, noMove)).toEqual([A1]);
  });

  test("a codeunit whose mode moved since the baseline keeps its tests", () => {
    const ev = evidence(
      [
        [A1, false],
        [B1, false],
      ],
      "test",
    );
    expect(pruneCodeunitsForReach(m, [A1, B1], ev, () => "method")).toEqual([A1, B1]);
  });
});

// ---------------------------------------------------------------- the flag

describe("PR-303: the flag", () => {
  const fake = (kind: string, knobOff: boolean) => ({
    capabilities: () => ({ kind }),
    ...(knobOff ? { baselineBatchingKnobOff: true } : {}),
  });
  test("unset and empty are off, whatever the backend", () => {
    expect(readReachPrune({}, fake("bcdev", false))).toBe(false);
    expect(readReachPrune({ [REACH_PRUNE_ENV]: "" }, fake("al-runner-v3", false))).toBe(false);
  });
  test("on is on", () => {
    expect(readReachPrune({ [REACH_PRUNE_ENV]: "on" }, fake("al-runner-v3", true))).toBe(true);
  });
  test("a bad value is refused by name", () => {
    expect(() => readReachPrune({ [REACH_PRUNE_ENV]: "yes" }, fake("al-runner-v3", true))).toThrow(
      /reach-prune-value-refused/,
    );
    expect(() => readReachPrune({ [REACH_PRUNE_ENV]: "ON" }, fake("al-runner-v3", true))).toThrow(
      ReachPruneError,
    );
  });
  test("another backend is refused by name", () => {
    expect(() => readReachPrune({ [REACH_PRUNE_ENV]: "on" }, fake("bcdev", true))).toThrow(
      /reach-prune-backend-refused/,
    );
  });
  test("a baseline that is not unbatched is refused by name", () => {
    expect(() => readReachPrune({ [REACH_PRUNE_ENV]: "on" }, fake("al-runner-v3", false))).toThrow(
      /reach-prune-baseline-refused/,
    );
  });
});

// ---------------------------------------------------------------- the session

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const TESTS_A_AL = `codeunit 79100 "Sandbox Tests A"
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
}
`;
const TESTS_B_AL = `codeunit 79101 "Sandbox Tests B"
{
    Subtype = Test;

    [Test]
    procedure B1()
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
const caps = (kind: BackendCapabilities["kind"]): BackendCapabilities => ({
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind,
  authoritative: false,
});
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };
/** The reach line of every `TARGET_AL` mutant in the instrumented text. */
const REACH_LINE = 13;

async function makeProject() {
  const root = scratch("lethal-pr303-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTestsA.Codeunit.al"), TESTS_A_AL);
  await Bun.write(join(testDir, "SandboxTestsB.Codeunit.al"), TESTS_B_AL);
  await Bun.write(
    join(testDir, "app.json"),
    '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
  );
  return { projectDir, testDir, root };
}

/** al-runner-v3 shaped, attesting nothing; every mutation-phase call is logged. */
class StubBackend implements ExecutionBackend {
  activations: Array<string | null> = [];
  /** Test names run while a mutant was active. */
  mutatedRuns: string[] = [];
  /** Every plan `prefetchMutants` was handed, as `mutantId -> qualified test names`. */
  prefetched: Array<Map<string, string[]>> = [];
  budgetCalls: Array<{ mutantId: string; tests: string[] }> = [];
  isolationOf?: (codeunitId: number) => "test" | "method";
  readonly baselineBatchingKnobOff: boolean;
  constructor(
    private readonly script: (mutant: string | null, ref: TestMethodRef) => TestVerdict["outcome"],
    private readonly lines: (ref: TestMethodRef) => number[],
    opts: { knobOff?: boolean; kind?: BackendCapabilities["kind"]; procedureOnly?: string } = {},
  ) {
    this.baselineBatchingKnobOff = opts.knobOff ?? true;
    this.kind = opts.kind ?? "al-runner-v3";
    this.procedureOnly = opts.procedureOnly;
  }
  private readonly kind: BackendCapabilities["kind"];
  private readonly procedureOnly: string | undefined;
  async runnerBuild() {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
  capabilities() {
    return caps(this.kind);
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
  async prefetchMutants(
    plans: readonly { readonly mutantId: string; readonly refs: readonly TestMethodRef[] }[],
  ) {
    this.prefetched.push(
      new Map(plans.map((p) => [p.mutantId, p.refs.map((r) => `${r.codeunitName}.${r.method}`)])),
    );
  }
  survivorNote?: (covering: readonly TestMethodRef[]) => string | undefined;
  useCoveringBudgets(mutantId: string, budgets: readonly { readonly ref: TestMethodRef }[]): void {
    this.budgetCalls.push({
      mutantId,
      tests: budgets.map((b) => `${b.ref.codeunitName}.${b.ref.method}`),
    });
  }
  async run(r: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    if (active !== null) this.mutatedRuns.push(`${r.codeunitName}.${r.method}`);
    const lineEntries = this.lines(r).map((line) => ({
      objectType: "Codeunit",
      objectId: 79000,
      procedure: "IsOverBudget",
      line,
    }));
    return {
      ref: r,
      outcome: this.script(active, r),
      durationMs: 5,
      ...(active === null
        ? {
            coverage:
              this.procedureOnly === r.method
                ? {
                    granularity: "procedure" as const,
                    entries: lineEntries.map(({ line: _l, ...rest }) => rest),
                  }
                : { granularity: "line" as const, entries: lineEntries },
          }
        : {}),
    };
  }
}

const allPass = (): TestVerdict["outcome"] => "pass";
const killedByA1 = (mutant: string | null, r: TestMethodRef): TestVerdict["outcome"] =>
  mutant !== null && r.method === "A1" ? "fail" : "pass";
/** A1 reaches the site; A2 and B1 do not. */
const onlyA1 = (r: TestMethodRef) => (r.method === "A1" ? [REACH_LINE] : [4]);
const nobody = () => [4];

async function withEnv<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const before = process.env[REACH_PRUNE_ENV];
  if (value === undefined) Reflect.deleteProperty(process.env, REACH_PRUNE_ENV);
  else process.env[REACH_PRUNE_ENV] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, REACH_PRUNE_ENV);
    else process.env[REACH_PRUNE_ENV] = before;
  }
}

async function run(
  backend: ExecutionBackend,
  flag: string | undefined,
  extra: {
    store?: ResultsStore;
    resume?: "last" | number;
    tag?: string;
    skipKnownSurvivors?: boolean;
    reachPrune?: false;
    project?: Awaited<ReturnType<typeof makeProject>>;
  } = {},
) {
  const { store, tag, project, ...rest } = extra;
  const dirs = project ?? (await makeProject());
  return withEnv(flag, () =>
    runSession({
      backend,
      store: store ?? new ResultsStore(":memory:"),
      projectDir: dirs.projectDir,
      testDir: dirs.testDir,
      instrumentedDir: join(dirs.root, `instr${tag ?? ""}`),
      selectorIds,
      ...rest,
    }),
  );
}

const FULL = ["Sandbox Tests A.A1", "Sandbox Tests A.A2", "Sandbox Tests B.B1"];

describe("PR-303: the session, flag on", () => {
  test("the B1 shape: B is not run, planned or registered; A runs whole; the report names the full set", async () => {
    const backend = new StubBackend(allPass, onlyA1);
    const report = await run(backend, "on");
    expect(report.mutants.length).toBeGreaterThan(0);
    // The call log: nothing of B reached the daemon under a mutant, and A ran (A2 with it).
    expect(backend.mutatedRuns.some((t) => t.startsWith("Sandbox Tests B."))).toBe(false);
    expect(backend.mutatedRuns).toContain("Sandbox Tests A.A1");
    expect(backend.mutatedRuns).toContain("Sandbox Tests A.A2");
    // Prefetch plans and the L4 budget registration read the pruned plan.
    const plans = backend.prefetched.flatMap((p) => [...p.values()]);
    expect(plans.length).toBeGreaterThan(0);
    for (const tests of plans)
      expect(tests.some((t) => t.startsWith("Sandbox Tests B."))).toBe(false);
    expect(backend.budgetCalls.length).toBeGreaterThan(0);
    for (const c of backend.budgetCalls) {
      expect(c.tests.some((t) => t.startsWith("Sandbox Tests B."))).toBe(false);
    }
    for (const mut of report.mutants) {
      // The report is of the FULL set, and a survivor is decided. (No `group-coverage-incomplete` check:
      // this stub has no group path, so that error cannot arise here and the check could not fail.)
      expect([...(mut.coveringTests ?? [])].sort()).toEqual(FULL);
      expect(mut.verdict).toBe("survived");
      expect(mut.guardReached).toBe(true);
    }
  });

  test("an undecided test (procedure-only baseline) keeps its codeunit: B is run", async () => {
    const backend = new StubBackend(allPass, onlyA1, { procedureOnly: "B1" });
    await run(backend, "on");
    expect(backend.mutatedRuns).toContain("Sandbox Tests B.B1");
  });

  test("a fully pruned mutant is survived (not no-coverage), guardReached false, with the joined note, and never runs", async () => {
    const backend = new StubBackend(allPass, nobody);
    backend.survivorNote = (covering) => `SURVIVOR-NOTE(${covering.length})`;
    const report = await run(backend, "on");
    const pruned = report.mutants.filter((x) => x.failureNote?.startsWith("pruned:") === true);
    expect(pruned.length).toBeGreaterThan(0);
    for (const mut of pruned) {
      expect(mut.verdict).toBe("survived");
      expect(mut.guardReached).toBe(false);
      expect(mut.failureNote).toBe("pruned: no covering test reaches its site; SURVIVOR-NOTE(3)");
      expect([...(mut.coveringTests ?? [])].sort()).toEqual(FULL);
    }
    expect(report.mutants.some((x) => x.verdict === "no-coverage")).toBe(false);
    // Every mutant of this fixture is statement grain and unreached, so all are pruned: none was
    // activated and no test ran under a mutant (the call logs, by name).
    expect(pruned.length).toBe(report.mutants.length);
    expect(backend.activations.filter((a) => a !== null)).toEqual([]);
    expect(backend.mutatedRuns).toEqual([]);
  });

  test("a killed mutant's killingTest equals the flag-off run's", async () => {
    const off = await run(new StubBackend(killedByA1, onlyA1), undefined);
    const on = await run(new StubBackend(killedByA1, onlyA1), "on");
    expect(on.mutants.length).toBe(off.mutants.length);
    const kills = off.mutants.filter((x) => x.verdict === "killed");
    expect(kills.length).toBeGreaterThan(0);
    for (const [i, k] of off.mutants.entries()) {
      expect(on.mutants[i]?.verdict).toBe(k.verdict);
      expect(on.mutants[i]?.killingTest).toBe(k.killingTest);
      expect(on.mutants[i]?.guardReached).toBe(k.guardReached);
    }
  });
});

describe("PR-303: flag off is zero change", () => {
  test("every plan holds the full set, and B runs", async () => {
    const backend = new StubBackend(allPass, onlyA1);
    const report = await run(backend, undefined);
    for (const tests of backend.prefetched.flatMap((p) => [...p.values()])) {
      expect([...tests].sort()).toEqual(FULL);
    }
    for (const c of backend.budgetCalls) expect([...c.tests].sort()).toEqual(FULL);
    expect(backend.mutatedRuns.some((t) => t.startsWith("Sandbox Tests B."))).toBe(true);
    for (const mut of report.mutants) {
      expect(mut.failureNote ?? "").not.toContain("pruned:");
      expect(mut.guardReached).toBe(true);
    }
  });
});

describe("PR-303: other sessions never inherit pruning", () => {
  test("a session given reachPrune: false prunes nothing, with the env on", async () => {
    const backend = new StubBackend(allPass, onlyA1);
    const report = await run(backend, "on", { reachPrune: false });
    expect(backend.mutatedRuns.some((t) => t.startsWith("Sandbox Tests B."))).toBe(true);
    for (const tests of backend.prefetched.flatMap((p) => [...p.values()])) {
      expect([...tests].sort()).toEqual(FULL);
    }
    for (const mut of report.mutants) expect(mut.failureNote ?? "").not.toContain("pruned:");
  });

  test("--skip-known-survivors never lends a pruned survivor into a flag-off run", async () => {
    const store = new ResultsStore(":memory:");
    const project = await makeProject();
    const first = new StubBackend(allPass, nobody);
    const r1 = await run(first, "on", { store, project, tag: "-1" });
    expect(r1.mutants.every((x) => x.failureNote?.startsWith("pruned:") === true)).toBe(true);
    expect(first.mutatedRuns).toEqual([]);
    const second = new StubBackend(allPass, nobody);
    const r2 = await run(second, undefined, {
      store,
      project,
      tag: "-2",
      skipKnownSurvivors: true,
    });
    // Measured, not lent: the fake daemon saw the tests run under mutants.
    expect(second.mutatedRuns.length).toBeGreaterThan(0);
    expect(r2.mutants.some((x) => x.verdict === "known-survivor")).toBe(false);
  });
});

describe("PR-303: the session refusals", () => {
  test("a bad value is refused before any run", async () => {
    const backend = new StubBackend(allPass, onlyA1);
    await expect(run(backend, "yes")).rejects.toThrow(/reach-prune-value-refused/);
    expect(backend.activations).toEqual([]);
  });
  test("another backend is refused before any run", async () => {
    const backend = new StubBackend(allPass, onlyA1, { kind: "bcdev" });
    await expect(run(backend, "on")).rejects.toThrow(/reach-prune-backend-refused/);
    expect(backend.activations).toEqual([]);
  });
  test("a baseline that is not unbatched is refused before any run", async () => {
    const backend = new StubBackend(allPass, onlyA1, { knobOff: false });
    await expect(run(backend, "on")).rejects.toThrow(/reach-prune-baseline-refused/);
    expect(backend.activations).toEqual([]);
  });

  test("--resume across a flag change is refused by name, both ways, by id and as last", async () => {
    for (const [first, second] of [
      ["on", undefined],
      [undefined, "on"],
    ] as const) {
      const store = new ResultsStore(":memory:");
      const project = await makeProject();
      await run(new StubBackend(allPass, onlyA1), first, { store, project, tag: "-1" });
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      const byId = new StubBackend(allPass, onlyA1);
      await expect(run(byId, second, { store, project, resume: 1, tag: "-2" })).rejects.toThrow(
        /reach-prune-resume-refused/,
      );
      expect(byId.activations).toEqual([]);
      await expect(
        run(new StubBackend(allPass, onlyA1), second, {
          store,
          project,
          resume: "last",
          tag: "-3",
        }),
      ).rejects.toThrow(/reach-prune-resume-refused/);
      // The same flag state resumes.
      const resumed = await run(new StubBackend(allPass, onlyA1), first, {
        store,
        project,
        resume: 1,
        tag: "-4",
      });
      expect(resumed.resumedFrom?.runId).toBe(1);
    }
  }, 120_000);
});

describe("PR-303: the TIMING line", () => {
  test("gives the entries left out and the pruned-survived count, summed over batches", () => {
    const text = foldTiming([
      { type: "warning", code: "reach-prune", message: reachPruneMessage(0, 5, 2) },
      { type: "warning", code: "reach-prune", message: reachPruneMessage(1, 7, 1) },
    ] as never);
    expect(text).toContain("12 mutant entries left out, 3 mutant(s) recorded pruned-survived");
  });

  test("per covered mutant does not count pruned survivors", () => {
    const scored = (id: string, failureNote?: string) => ({
      type: "mutant-scored",
      batchIndex: 0,
      verdict: "survived",
      mutant: { mutantId: id },
      ...(failureNote !== undefined ? { failureNote } : {}),
    });
    const text = foldTiming([
      { type: "phase-entered", phase: "mutants", atMs: 0 },
      scored("a"),
      scored("b", "pruned: no covering test reaches its site"),
      { type: "phase-left", phase: "mutants", elapsedMs: 10_000, atMs: 10_000 },
      { type: "session-finished" },
    ] as never);
    expect(text).toContain("(1 scored with coverage");
  });
});
