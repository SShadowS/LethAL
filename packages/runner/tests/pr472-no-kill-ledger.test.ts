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
import { parseCliConfig } from "../src/cli";
import { KillLedgerFlagBackendError, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-472 (R197, R1174): `--no-kill-ledger`. On the rig of pr327c-rewalk.test.ts: `Z1` kills M0001, so
 * with the ledger on, later mutants try Z1 first (crossing codeunits) and a survivor is re-walked.
 * With the flag on, the order is the no-ledger one (A1, Z1) and nothing is re-walked.
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

async function makeProject() {
  const root = scratch("lethal-pr472-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TESTS_AL);
  await Bun.write(
    join(testDir, "app.json"),
    '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
  );
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

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
    this.zRan = false;
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.active;
    let outcome: "pass" | "fail" = "pass";
    if (active !== null) {
      this.runs.push({ mutant: active, method: ref.method });
      outcome = this.script(active, ref.method, this.zRan);
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

async function session(backend: StateStub, extra: Partial<Parameters<typeof runSession>[0]> = {}) {
  const store = new ResultsStore(":memory:");
  const report = await runSession({
    backend,
    store,
    ...(await makeProject()),
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
// Only M0001's Z1 kills: every later mutant survives, so the ledger order (Z1 first) crosses codeunits.
const Z1_ONLY: Script = (mutant, method) =>
  mutant === "M0001" && method === "Z1" ? "fail" : "pass";

describe("PR-472: --no-kill-ledger", () => {
  test("(a) flag on: the no-ledger order, and no re-walk where the ledger would cross codeunits", async () => {
    const backend = new StateStub(BCDEV, Z1_ONLY);
    const { row, store } = await session(backend, { killLedger: false });
    expect(row("M0002")?.verdict).toBe("survived");
    // No-ledger order only (A1, Z1): never Z1 first, and no second walk.
    expect(backend.runsOf("M0002")).toEqual(["A1", "Z1"]);
    expect(backend.runsOf("M0003")).toEqual(["A1", "Z1"]);
    expect(row("M0002")?.failureNote ?? "").not.toContain(NOTE);
    store.close();
  });

  test("(a2) flag on with a stateful carry: the first test in the fixed order kills", async () => {
    const backend = new StateStub(BCDEV, CARRY);
    const { row, store } = await session(backend, { killLedger: false });
    expect(row("M0002")?.verdict).toBe("killed");
    expect(row("M0002")?.killingTest).toBe("A1");
    expect(backend.runsOf("M0002")).toEqual(["A1"]);
    store.close();
  });

  test("(b) flag off: today's ledger order and today's re-walk", async () => {
    const backend = new StateStub(BCDEV, Z1_ONLY);
    const { row, store } = await session(backend);
    expect(row("M0002")?.verdict).toBe("survived");
    expect(backend.runsOf("M0002")).toEqual(["Z1", "A1", "A1", "Z1"]);
    store.close();
    const carry = new StateStub(BCDEV, CARRY);
    const s2 = await session(carry);
    expect(s2.row("M0002")?.failureNote).toContain(NOTE);
    expect(carry.runsOf("M0002")).toEqual(["Z1", "A1", "A1"]);
    s2.store.close();
  });

  test("(c) flag on with a non-bcdev backend is refused by name, before any run", async () => {
    const backend = new StateStub(V3, Z1_ONLY);
    const store = new ResultsStore(":memory:");
    let err: unknown;
    try {
      await runSession({
        backend,
        store,
        ...(await makeProject()),
        selectorIds,
        killLedger: false,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KillLedgerFlagBackendError);
    expect((err as Error).message).toContain("--no-kill-ledger");
    expect((err as Error).message).toContain("al-runner-v3");
    expect(backend.runs.length).toBe(0);
    store.close();
  });

  test("(d) the kill-ledger-off caveat is in the report iff the flag is on", async () => {
    const on = await session(new StateStub(BCDEV, Z1_ONLY), { killLedger: false });
    expect(on.report.validity.caveats).toContain("kill-ledger-off");
    on.store.close();
    const off = await session(new StateStub(BCDEV, Z1_ONLY));
    expect(off.report.validity.caveats).not.toContain("kill-ledger-off");
    off.store.close();
  });

  test("(e) the CLI flag sets killLedger: false; absent leaves it out", () => {
    const base = ["run", "--project", "P", "--tests", "T", "--backend", "bcdev"];
    const on = parseCliConfig([...base, "--no-kill-ledger"]);
    expect(on.mode === "run" ? on.killLedger : "wrong mode").toBe(false);
    const off = parseCliConfig(base);
    expect(off.mode === "run" ? "killLedger" in off : "wrong mode").toBe(false);
  });
});
