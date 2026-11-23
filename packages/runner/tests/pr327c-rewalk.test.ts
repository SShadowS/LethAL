import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { runSession } from "../src/orchestrator";
import { SessionSafety } from "../src/session-safety";
import { ResultsStore } from "../src/store";
import { ledgerCrossedCodeunits } from "../src/test-order";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-327 (c), R1174: a survivor whose kill-ledger order put one test codeunit ahead of another is
 * walked once more in the no-ledger order, on bcdev only. The stub carries state across codeunits
 * the way a BC session does: `A1` fails under a mutant only when `Z1` has NOT run since that
 * mutant's activation. `Z1` always kills M0001, which puts it first in the ledger for the scope.
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
const TESTS_AL = `codeunit 79100 "Alpha Tests"
{
    Subtype = Test;

    [Test]
    procedure A1() begin end;
}

codeunit 79101 "Zulu Tests"
{
    Subtype = Test;

    [Test]
    procedure Z1() begin end;
}
`;
const APP_JSON = JSON.stringify({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Sandbox Orchestrator Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const BCDEV: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
};
const V3: BackendCapabilities = { ...BCDEV, kind: "al-runner-v3", authoritative: false };
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

// One test codeunit with two tests: a ledger can reorder A1 and A2 but never cross codeunits.
const ONE_CU_TESTS_AL = `codeunit 79100 "Alpha Tests"
{
    Subtype = Test;

    [Test]
    procedure A1() begin end;
    [Test]
    procedure A2() begin end;
}
`;

async function makeProject(testsAl: string = TESTS_AL) {
  const root = scratch("lethal-pr327c-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), testsAl);
  await Bun.write(
    join(testDir, "app.json"),
    '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
  );
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

/** What a test does under a mutant: `zRanSince` is true when Z1 already ran in this activation. */
type Script = (mutant: string, method: string, zRanSince: boolean) => "pass" | "fail";

class StateStub implements ExecutionBackend {
  readonly runnerBuild = async () => ({
    version: "alrunner 3.0.0-alpha.2 (91253f2d6)",
    binarySha256: "b".repeat(64),
  });
  private active: string | null = null;
  private zRan = false;
  /** Every mutated run, in order: the call counter the tests read. */
  readonly runs: Array<{ mutant: string; method: string }> = [];
  constructor(
    private readonly caps: BackendCapabilities,
    private readonly script: Script,
    private readonly onMutatedRun: (mutant: string, method: string) => void = () => {},
  ) {}
  capabilities() {
    return this.caps;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy() {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null) {
    this.active = id;
    this.zRan = false; // a fresh activation is a fresh session
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.active;
    let outcome: "pass" | "fail" = "pass";
    if (active !== null) {
      this.runs.push({ mutant: active, method: ref.method });
      outcome = this.script(active, ref.method, this.zRan);
      this.onMutatedRun(active, ref.method);
    }
    if (ref.method === "Z1") this.zRan = true;
    const baseline = active === null && this.caps.coverage !== "none";
    const attests = this.caps.authoritative && opts.coverage === "none";
    return {
      ref,
      outcome,
      durationMs: 5,
      ...(baseline
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
            },
          }
        : {}),
      ...(attests ? { attestation: { observedAny: true, identityMismatch: false } } : {}),
      ...(attests ? { reachedActive: active !== null } : {}),
    };
  }
  runsOf(mutant: string): string[] {
    return this.runs.filter((r) => r.mutant === mutant).map((r) => r.method);
  }
}

async function session(
  backend: StateStub,
  extra: Partial<Parameters<typeof runSession>[0]> = {},
  testsAl?: string,
) {
  const store = new ResultsStore(":memory:");
  const report = await runSession({
    backend,
    store,
    ...(await makeProject(testsAl)),
    selectorIds,
    ...extra,
  });
  const row = (code: string) => report.mutants.find((m) => m.mutantCode === code);
  return { report, row, store };
}

const NOTE = "[ledger-order-survived]";
// M0001: Z1 kills (fills the ledger). Every other mutant: A1 kills only if Z1 has not run yet.
const CARRY: Script = (mutant, method, zRan) =>
  mutant === "M0001"
    ? method === "Z1"
      ? "fail"
      : "pass"
    : method === "A1" && !zRan
      ? "fail"
      : "pass";

describe("PR-327 (c): the ledger-order re-walk", () => {
  test("(a) bcdev, ledger crossed, first walk survives, re-walk kills: killed, noted, killer from the re-walk", async () => {
    const backend = new StateStub(BCDEV, CARRY);
    const { row, store } = await session(backend);
    expect(row("M0001")?.verdict).toBe("killed");
    const m2 = row("M0002");
    expect(m2?.verdict).toBe("killed");
    expect(m2?.killingTest).toBe("A1");
    expect(m2?.failureNote).toContain(NOTE);
    expect(m2?.failureNote).toContain("(R1174)");
    // Ledger order Z1, A1 (survived), then the re-walk A1 (killed).
    expect(backend.runsOf("M0002")).toEqual(["Z1", "A1", "A1"]);
    // The re-walk kill never feeds the ledger: M0003 walks and scores exactly as it would with the
    // re-walk off (its ledger holds only M0001's Z1 kill), so it is re-walked the same way.
    const m3 = row("M0003");
    expect(backend.runsOf("M0003")).toEqual(["Z1", "A1", "A1"]);
    expect(m3?.verdict).toBe("killed");
    expect(m3?.killingTest).toBe("A1");
    expect(m3?.failureNote).toContain(NOTE);
    store.close();
  });

  test("a ledger that reorders only inside one codeunit is not crossed: no re-walk", async () => {
    // A2 kills M0001, so the ledger runs A2 before A1 for M0002; both tests are one codeunit.
    const backend = new StateStub(BCDEV, (m, method) =>
      m === "M0001" && method === "A2" ? "fail" : "pass",
    );
    const { row, store } = await session(backend, {}, ONE_CU_TESTS_AL);
    expect(row("M0002")?.verdict).toBe("survived");
    expect(backend.runsOf("M0002")).toEqual(["A2", "A1"]);
    store.close();
  });

  test("a session latched unsafe after the survivor records it and stops: no re-walk", async () => {
    const real = Object.getOwnPropertyDescriptor(SessionSafety.prototype, "isUnsafe");
    let latched = false;
    Object.defineProperty(SessionSafety.prototype, "isUnsafe", {
      configurable: true,
      get() {
        return latched || (real?.get?.call(this) as boolean);
      },
    });
    try {
      const backend = new StateStub(BCDEV, CARRY, (m, method) => {
        if (m === "M0002" && method === "A1") latched = true; // the survivor's last test
      });
      const { row, store } = await session(backend);
      expect(row("M0002")?.verdict).toBe("survived");
      expect(backend.runsOf("M0002")).toEqual(["Z1", "A1"]);
      store.close();
    } finally {
      if (real !== undefined) Object.defineProperty(SessionSafety.prototype, "isUnsafe", real);
    }
  });

  test("a spent time budget records the survivor and does not re-walk it", async () => {
    // The walk's own clock check (before the walker answers "done") must still pass, so the clock
    // runs out on the SECOND read after the survivor's last test: the re-walk guard's read.
    let armed = 0;
    let spent = false;
    const backend = new StateStub(BCDEV, CARRY, (m, method) => {
      if (m === "M0002" && method === "A1") armed = 1;
    });
    const clockMs = () => {
      if (armed > 0 && ++armed > 2) spent = true;
      return spent ? 1_000_000 : 0;
    };
    const { row, store } = await session(backend, { timeBudgetSeconds: 100, clockMs });
    expect(row("M0002")?.verdict).toBe("survived");
    expect(backend.runsOf("M0002")).toEqual(["Z1", "A1"]);
    store.close();
  });

  test("(b) not crossed: no re-walk, by call count", async () => {
    // Nothing ever kills, so the ledger stays empty and both orders are the same.
    const backend = new StateStub(BCDEV, () => "pass");
    const { row, store } = await session(backend);
    expect(row("M0002")?.verdict).toBe("survived");
    expect(row("M0002")?.failureNote ?? "").not.toContain(NOTE);
    expect(backend.runsOf("M0002")).toEqual(["A1", "Z1"]);
    store.close();
  });

  test("(c) a kill is never re-walked", async () => {
    // Z1 kills every mutant, in the ledger's order, at its first test.
    const backend = new StateStub(BCDEV, (_m, method) => (method === "Z1" ? "fail" : "pass"));
    const { row, report, store } = await session(backend);
    expect(report.counts.killed).toBeGreaterThan(1);
    expect(report.counts.survived).toBe(0);
    expect(row("M0002")?.verdict).toBe("killed");
    expect(row("M0002")?.failureNote ?? "").not.toContain(NOTE);
    // M0001 runs A1 then Z1 (cold ledger), later mutants Z1 alone: never a third run.
    expect(backend.runsOf("M0002")).toEqual(["Z1"]);
    store.close();
  });

  test("(d) al-runner-v3 never re-walks", async () => {
    const backend = new StateStub(V3, CARRY);
    const { row, store } = await session(backend);
    expect(row("M0002")?.verdict).toBe("survived");
    expect(row("M0002")?.failureNote ?? "").not.toContain(NOTE);
    expect(backend.runsOf("M0002")).toEqual(["Z1", "A1"]);
    store.close();
  });

  test("(e) the re-walk also survives: survived, no note, one extra walk", async () => {
    const backend = new StateStub(BCDEV, (mutant, method) =>
      mutant === "M0001" && method === "Z1" ? "fail" : "pass",
    );
    const { row, store } = await session(backend);
    expect(row("M0002")?.verdict).toBe("survived");
    expect(row("M0002")?.failureNote ?? "").not.toContain(NOTE);
    expect(backend.runsOf("M0002")).toEqual(["Z1", "A1", "A1", "Z1"]);
    store.close();
  });
});

describe("PR-327 (c): ledgerCrossedCodeunits", () => {
  const ref = (codeunitId: number, method: string): TestMethodRef => ({
    codeunitId,
    codeunitName: `CU${codeunitId}`,
    method,
    file: "t.al",
    line: 1,
  });
  const [a1, a2, b1, c1] = [ref(1, "a1"), ref(1, "a2"), ref(2, "b1"), ref(3, "c1")];

  test("the same order is not crossed", () => {
    expect(ledgerCrossedCodeunits([a1, a2, b1], [a1, a2, b1])).toBe(false);
  });
  test("two codeunits swapped is crossed", () => {
    expect(ledgerCrossedCodeunits([b1, a1], [a1, b1])).toBe(true);
  });
  test("reordering inside one codeunit is not crossed", () => {
    expect(ledgerCrossedCodeunits([a2, a1, b1], [a1, a2, b1])).toBe(false);
  });
  test("pairwise: a later test of a codeunit moved ahead of another codeunit's test is crossed", () => {
    // no-ledger a1, b1, a2; ledger a2, a1, b1: a2 now runs before b1. First appearances agree (A, B).
    expect(ledgerCrossedCodeunits([a2, a1, b1], [a1, b1, a2])).toBe(true);
    expect(ledgerCrossedCodeunits([b1, a1, a2], [a1, b1, a2])).toBe(true);
    expect(ledgerCrossedCodeunits([a1, b1, a2], [a1, a2, b1])).toBe(true);
  });
  test("a third codeunit moved ahead of one it followed is crossed", () => {
    expect(ledgerCrossedCodeunits([c1, a1, b1], [a1, b1, c1])).toBe(true);
  });
  test("empty lists are not crossed; different codeunit sets throw", () => {
    expect(ledgerCrossedCodeunits([], [])).toBe(false);
    expect(() => ledgerCrossedCodeunits([a1], [b1])).toThrow();
  });
  test("a ledger that reorders only inside one codeunit is not crossed", () => {
    expect(ledgerCrossedCodeunits([a2, a1], [a1, a2])).toBe(false);
    expect(ledgerCrossedCodeunits([b1, a2, a1], [b1, a1, a2])).toBe(false);
  });
});
