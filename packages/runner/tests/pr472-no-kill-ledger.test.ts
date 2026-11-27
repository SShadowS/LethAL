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
import { parseCliConfig, runFromCliWithAccept } from "../src/cli";
import { KillLedgerFlagBackendError, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";
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
  await Bun.write(join(testDir, "app.json"), testAppJson());
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

type Script = (mutant: string, method: string, zRanSince: boolean) => "pass" | "fail";

class StateStub implements ExecutionBackend {
  readonly runnerBuild = async () => ({
    version: "alrunner 3.0.0-alpha.2 (91253f2d6)",
    binarySha256: "b".repeat(64),
  });
  // R495: a served, installed test app, so the run's identity is proven (as a real bcdev's is) and a resume can reach its fingerprint check.
  private readonly testApp = servesTestApp();
  fetchPublishedAppPackage = this.testApp.fetchPublishedAppPackage;
  microsoftMode = this.testApp.microsoftMode;
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

async function session(
  backend: StateStub,
  extra: Partial<Parameters<typeof runSession>[0]> = {},
  o: { store?: ResultsStore; project?: Awaited<ReturnType<typeof makeProject>>; tag?: string } = {},
) {
  const store = o.store ?? new ResultsStore(":memory:");
  const project = o.project ?? (await makeProject());
  const report = await runSession({
    backend,
    store,
    ...project,
    instrumentedDir: `${project.instrumentedDir}${o.tag ?? ""}`,
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
// M0001: Z1 kills (fills the ledger). Every other mutant: A1 fails ONLY if Z1 ran earlier in its session.
const NEEDS_Z1: Script = (mutant, method, zRan) =>
  mutant === "M0001"
    ? method === "Z1"
      ? "fail"
      : "pass"
    : method === "A1" && zRan
      ? "fail"
      : "pass";

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

  // Amendment 1: the one verdict move. Red: make the flag a no-op (killLedger ignored) and M0002 turns killed.
  test("(b2) a kill that rests on state an earlier test codeunit left: killed by default, survived with the flag", async () => {
    const off = new StateStub(BCDEV, NEEDS_Z1);
    const d = await session(off);
    expect(d.row("M0002")?.verdict).toBe("killed");
    expect(d.row("M0002")?.killingTest).toBe("A1");
    expect(off.runsOf("M0002")).toEqual(["Z1", "A1"]); // ledger order, killed at once: no re-walk
    expect(d.row("M0002")?.failureNote ?? "").not.toContain(NOTE);
    d.store.close();
    const on = new StateStub(BCDEV, NEEDS_Z1);
    const f = await session(on, { killLedger: false });
    expect(f.row("M0002")?.verdict).toBe("survived");
    expect(on.runsOf("M0002")).toEqual(["A1", "Z1"]); // A1 first, before Z1 ran: passes
    f.store.close();
  });

  // Red: drop `killLedgerOff` from sessionFingerprint (resume.ts), or the ledgerFlag checks in resolveResume.
  test("(f) a --resume across the flag is refused by name, both ways, by id and as last; the same mode resumes", async () => {
    for (const [first, second] of [
      [undefined, false],
      [false, undefined],
    ] as const) {
      const store = new ResultsStore(":memory:");
      const project = await makeProject();
      const extraOf = (k: false | undefined, resume?: number | "last") => ({
        ...(k === false ? { killLedger: false as const } : {}),
        ...(resume !== undefined ? { resume } : {}),
      });
      await session(new StateStub(BCDEV, Z1_ONLY), extraOf(first), { store, project, tag: "-1" });
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      const byId = new StateStub(BCDEV, Z1_ONLY);
      await expect(
        session(byId, extraOf(second, 1), { store, project, tag: "-2" }),
      ).rejects.toThrow(/kill-ledger-resume-refused/);
      expect(byId.runs.length).toBe(0);
      await expect(
        session(new StateStub(BCDEV, Z1_ONLY), extraOf(second, "last"), {
          store,
          project,
          tag: "-3",
        }),
      ).rejects.toThrow(/kill-ledger-resume-refused/);
      const resumed = await session(new StateStub(BCDEV, Z1_ONLY), extraOf(first, 1), {
        store,
        project,
        tag: "-4",
      });
      expect(resumed.report.resumedFrom?.runId).toBe(1);
      store.close();
    }
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

  // Red: delete `...(parsed.killLedger === false ? { killLedger: false as const } : {})` in runFromCliWithAccept (cli.ts).
  test("(g) runFromCliWithAccept hands killLedger: false to the session only when the flag is on", async () => {
    const root = scratch("lethal-pr472-cli-");
    const projectDir = join(root, "app");
    const testDir = join(root, "tests");
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    await Bun.write(join(testDir, "app.json"), "{}");
    await Bun.write(join(root, "lethal.config.json"), "{}");
    const seen = async (killLedger: false | undefined) => {
      let got: Parameters<typeof runSession>[0] | undefined;
      // A canned report, not a throw: a failed run keeps its scratch folder (R358).
      const canned = { validity: { caveats: [] }, buildSymbols: [], mutants: [] } as never;
      await runFromCliWithAccept(
        {
          mode: "run",
          projectDir,
          testDir,
          // runSession is stubbed, so its bcdev-only refusal is not reached; this backend needs no config section.
          backendKind: "al-runner-v3",
          dbPath: ":memory:",
          configPath: join(root, "lethal.config.json"),
          skipKnownSurvivors: false,
          workers: 1,
          keepEnv: false,
          allowExpiringEnv: false,
          ...(killLedger === false ? { killLedger } : {}),
        },
        {
          validateSelectorIdsForProject: async () => {},
          buildBackend: async () => ({}) as never,
          runSession: async (cfg) => {
            got = cfg;
            return canned;
          },
        },
      );
      return got;
    };
    const on = await seen(false);
    expect(on?.killLedger).toBe(false);
    const off = await seen(undefined);
    expect(off !== undefined && "killLedger" in off).toBe(false);
  });
});
