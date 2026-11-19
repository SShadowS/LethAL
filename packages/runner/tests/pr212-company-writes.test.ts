// PR-212 (R1113): test methods that write the Company table are left out of a BC run by default, named, and a
// mutant only they could cover is not measured (error / left-out-test-reach). Each direction is red-checked.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type { MutantManifestEntry } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { parseCliConfig } from "../src/cli";
import { companyWriteLines, companyWriteMethods } from "../src/company-writes";
import type { RunEvent } from "../src/events";
import { type SessionConfig, record, runSession, setLeftOutReach } from "../src/orchestrator";
import { type SessionOutcome, type SessionReport, renderConsole } from "../src/report";
import { ResultsStore } from "../src/store";
import { buildTestAppModel } from "../src/testpage-scan";
import { leftOutBySource } from "../src/verify";
import { servesTestApp } from "./helpers/proven-test-app";
import { removeScratchDirs } from "./helpers/scratch";

const TESTS_AL = `codeunit 79100 "Co Tests"
{
    Subtype = Test;

    [Test]
    procedure Plain()
    begin
    end;

    [Test]
    procedure Direct()
    var
        C: Record Company;
        Reach: Codeunit "Setup Mgt";
    begin
        C.Insert();
        Commit();
    end;

    [Test]
    procedure ViaHelper()
    begin
        MakeCompany();
    end;

    [Test]
    procedure ViaLib()
    var
        L: Codeunit "Co Lib";
    begin
        L.Create();
    end;

    [Test]
    procedure ReadOnly()
    var
        C: Record Company;
    begin
        C.Get('x');
        if C.FindSet() then;
    end;

    [Test]
    procedure TwoHops()
    begin
        MakeViaHelper();
    end;

    local procedure MakeCompany()
    var
        Co: Record 2000000006;
    begin
        Co.Delete();
    end;

    local procedure MakeViaHelper()
    begin
        MakeCompany();
    end;
}
`;
const LIB_AL = `codeunit 79101 "Co Lib"
{
    procedure Create()
    var
        C: Record Company;
    begin
        C.Rename('b');
        Commit();
    end;
}
`;
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const REACHED_AL = `codeunit 79001 "Setup Mgt"
{
    procedure Limit(Amount: Decimal): Boolean
    begin
        exit(Amount > 10);
    end;
}
`;
const UNRELATED_AL = `codeunit 79002 "Unrelated"
{
    procedure Cap(Amount: Decimal): Boolean
    begin
        exit(Amount > 20);
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a93",
  name: "Sandbox PR212 Fixture",
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

const ref = (method: string, id = 79100, name = "Co Tests"): TestMethodRef => ({
  codeunitId: id,
  codeunitName: name,
  method,
});
const ALL = ["Plain", "Direct", "ViaHelper", "ViaLib", "ReadOnly", "TwoHops"].map((m) => ref(m));

// More write shapes (code review): DeleteAll, a RecordRef opened on Company, a namespace-qualified type; and what is NOT
// a write: a temporary Company record, a RecordRef opened on another table.
const SHAPES_AL = `codeunit 79102 "Co Shapes"
{
    Subtype = Test;

    [Test]
    procedure DelAll()
    var
        C: Record Company;
    begin
        C.DeleteAll();
    end;

    [Test]
    procedure RefByName()
    var
        R: RecordRef;
    begin
        R.Open(Database::Company);
        R.Delete();
    end;

    [Test]
    procedure RefQuoted()
    var
        R: RecordRef;
    begin
        R.Open(Database::"Company");
        R.Insert();
    end;

    [Test]
    procedure RefById()
    var
        R: RecordRef;
    begin
        R.Open(2000000006);
        R.DeleteAll();
    end;

    [Test]
    procedure Qualified()
    var
        C: Record System.Environment.Company;
    begin
        C.Rename('b');
    end;

    [Test]
    procedure Temp()
    var
        C: Record Company temporary;
    begin
        C.Insert();
    end;

    [Test]
    procedure RefOther()
    var
        R: RecordRef;
    begin
        R.Open(Database::Customer);
        R.Delete();
    end;
}
`;
const SHAPES = ["DelAll", "RefByName", "RefQuoted", "RefById", "Qualified", "Temp", "RefOther"].map(
  (m) => ref(m, 79102, "Co Shapes"),
);
const shapesFound = () =>
  companyWriteMethods(buildTestAppModel([{ path: "S.al", text: SHAPES_AL }]), SHAPES).map(
    (m) => m.test.method,
  );

beforeAll(async () => {
  await initParser();
});

describe("detection, on the parse", () => {
  const found = () =>
    companyWriteMethods(
      buildTestAppModel([
        { path: "T.al", text: TESTS_AL },
        { path: "L.al", text: LIB_AL },
      ]),
      ALL,
    );
  test("direct, one hop via a helper, via a test-app codeunit; read-only and two hops are not listed", () => {
    expect(found().map((m) => [m.test.method, m.path])).toEqual([
      ["Direct", "direct"],
      ["ViaHelper", "via Co Tests.MakeCompany"],
      ["ViaLib", "via Co Lib.Create"],
    ]);
  });
  test("Commit is shown where the method or its helper calls it", () => {
    expect(found().map((m) => m.commits)).toEqual([true, false, true]);
  });
  test("the objects a method names are collected (variable types and its helper's)", () => {
    const direct = found()[0];
    expect(direct?.reach.has("setup mgt")).toBe(true);
    expect(direct?.reach.has("company")).toBe(true);
  });
  test("DeleteAll is a write", () => {
    expect(shapesFound()).toContain("DelAll");
  });
  test("a RecordRef opened on Database::Company (named, quoted, or by id) is a write; one opened on another table is not", () => {
    const f = shapesFound();
    expect(f).toContain("RefByName");
    expect(f).toContain("RefQuoted");
    expect(f).toContain("RefById");
    expect(f).not.toContain("RefOther");
  });
  test("a namespace-qualified Company type is a write", () => {
    expect(shapesFound()).toContain("Qualified");
  });
  test("a temporary Company record is not a write", () => {
    expect(shapesFound()).not.toContain("Temp");
  });
  test("the lines name path and commits; kept says they run; none prints nothing", () => {
    const left = companyWriteLines(found(), false, 6);
    expect(left[0]).toContain("3 of 6");
    expect(left[0]).toContain("LEFT OUT");
    expect(left).toContain("  Co Tests.Direct (direct, commits)");
    expect(left).toContain("  Co Tests.ViaHelper (via Co Tests.MakeCompany)");
    expect(companyWriteLines(found(), true, 6)[0]).toContain("RUN (--keep-company-tests)");
    expect(companyWriteLines([], false, 6)).toEqual([]);
  });
});

/** A bcdev or v3 stub: tests cover only Sandbox Logic's procedure, so the two other objects read no-coverage. */
class Stub implements ExecutionBackend {
  readonly ran: string[] = [];
  constructor(
    private readonly kind: "bcdev" | "al-runner-v3",
    private readonly coverage: "procedure" | "none" = "procedure",
    /** A remaining test (Plain) also covers Setup Mgt.Limit, so its mutants are covered, not no-coverage. */
    private readonly coversSetup = false,
  ) {
    if (kind === "bcdev") Object.assign(this, servesTestApp());
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: this.coverage,
      deploy: "publish",
      isolation: "session",
      kind: this.kind,
      authoritative: this.kind === "bcdev",
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "al-runner 3.0.0-test", binarySha256: "b".repeat(64) };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  private active: string | null = null;
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(r: TestMethodRef): Promise<TestVerdict> {
    this.ran.push(r.method);
    if (this.active !== null)
      return {
        ref: r,
        outcome: "pass",
        durationMs: 5,
        attestation: { observedAny: true, identityMismatch: false },
      };
    return {
      ref: r,
      outcome: "pass",
      durationMs: 5,
      coverage: {
        granularity: "procedure" as const,
        entries: [
          { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" },
          ...(this.coversSetup
            ? [{ objectType: "Codeunit", objectId: 79001, procedure: "Limit" }]
            : []),
        ],
      },
    };
  }
}

const roots: string[] = [];
afterEach(() => removeScratchDirs(roots.splice(0)));
let n = 0;
async function run(
  kind: "bcdev" | "al-runner-v3",
  extra: Partial<SessionConfig> = {},
  coverage: "procedure" | "none" = "procedure",
  coversSetup = false,
): Promise<{ r: SessionReport; stub: Stub; events: RunEvent[] }> {
  const root = mkdtempSync(join(tmpdir(), "lethal-pr212-"));
  roots.push(root);
  for (const [f, t] of [
    ["SandboxLogic.al", TARGET_AL],
    ["SetupMgt.al", REACHED_AL],
    ["Unrelated.al", UNRELATED_AL],
  ] as const)
    await Bun.write(join(root, "app", f), t);
  await Bun.write(join(root, "app", "app.json"), APP_JSON);
  await Bun.write(join(root, "tests", "CoTests.Codeunit.al"), TESTS_AL);
  await Bun.write(join(root, "tests", "CoLib.Codeunit.al"), LIB_AL);
  await Bun.write(join(root, "tests", "app.json"), TEST_APP_JSON);
  const stub = new Stub(kind, coverage, coversSetup);
  const events: RunEvent[] = [];
  const r = await runSession({
    backend: stub,
    store: new ResultsStore(":memory:"),
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, `instr-${++n}`),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    emit: [(e) => events.push(e)],
    ...extra,
  });
  return { r, stub, events };
}
const LEFT_OUT = ["Co Tests.Direct", "Co Tests.ViaHelper", "Co Tests.ViaLib"];

describe("a BC run leaves company-writing tests out by default", () => {
  test("never runs them, names them with reason company-write, warns, banner and caveat say so", async () => {
    const { r, stub, events } = await run("bcdev");
    expect(stub.ran.filter((m) => ["Direct", "ViaHelper", "ViaLib"].includes(m))).toEqual([]);
    expect(stub.ran).toContain("Plain");
    expect(r.excludedTests?.map((t) => [t.test, t.reason])).toEqual(
      LEFT_OUT.map((t) => [t, "company-write"]),
    );
    expect(r.validity.caveats).toContain("tests-narrowed");
    expect(renderConsole(r)).toContain("COMPANY-WRITING TESTS LEFT OUT: 3 test(s)");
    const w = events.find((e) => e.type === "warning" && e.code === "company-write-tests-left-out");
    expect(JSON.stringify(w)).toContain("Co Tests.ViaHelper (via Co Tests.MakeCompany)");
    expect(JSON.stringify(w)).toContain("--keep-company-tests");
  });
  test("--keep-company-tests keeps them (they run), says so, marks nothing", async () => {
    const { r, stub, events } = await run("bcdev", { keepCompanyTests: true });
    expect(stub.ran).toContain("Direct");
    expect(r.excludedTests ?? []).toEqual([]);
    expect(r.validity.caveats).not.toContain("tests-narrowed");
    expect(r.mutants.filter((m) => m.cause === "left-out-test-reach")).toEqual([]);
    // A distinct code: the run kept them, so "left out" would be false.
    expect(
      events.some((e) => e.type === "warning" && e.code === "company-write-tests-left-out"),
    ).toBe(false);
    const w = events.find((e) => e.type === "warning" && e.code === "company-write-tests-kept");
    expect(JSON.stringify(w)).toContain("RUN (--keep-company-tests)");
  });
  test("al-runner v3 leaves nothing out and warns of nothing", async () => {
    const { r, stub, events } = await run("al-runner-v3");
    expect(stub.ran).toContain("Direct");
    expect(r.excludedTests ?? []).toEqual([]);
    expect(r.mutants.length).toBeGreaterThan(0);
    expect(r.mutants.some((m) => m.cause === "left-out-test-reach")).toBe(false);
    expect(
      events.some((e) => e.type === "warning" && e.code.startsWith("company-write-tests")),
    ).toBe(false);
  });
});

describe("§2c (i): a no-coverage mutant in an object a left-out test names is not measured", () => {
  test("reached object: error / left-out-test-reach; unreached object stays no-coverage", async () => {
    const { r } = await run("bcdev");
    const inFile = (f: string) => r.mutants.filter((m) => m.file.endsWith(f));
    const reached = inFile("SetupMgt.al");
    const unreached = inFile("Unrelated.al");
    expect(reached.length).toBeGreaterThan(0);
    expect(unreached.length).toBeGreaterThan(0);
    expect(reached.every((m) => m.verdict === "error" && m.cause === "left-out-test-reach")).toBe(
      true,
    );
    expect(unreached.every((m) => m.verdict === "no-coverage")).toBe(true);
    expect(r.mutants.some((m) => m.verdict === "survived" && m.file.endsWith("SetupMgt.al"))).toBe(
      false,
    );
  });
  test("with --keep-company-tests the reached object stays no-coverage", async () => {
    const { r } = await run("bcdev", { keepCompanyTests: true });
    const reached = r.mutants.filter((m) => m.file.endsWith("SetupMgt.al"));
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((m) => m.verdict === "no-coverage")).toBe(true);
  });
  test("coverage none: a reached SURVIVED mutant is not measured, an unreached one stays survived", async () => {
    const { r } = await run("bcdev", {}, "none");
    const inFile = (f: string) => r.mutants.filter((m) => m.file.endsWith(f));
    const reached = inFile("SetupMgt.al");
    const unreached = inFile("Unrelated.al");
    expect(reached.length).toBeGreaterThan(0);
    expect(unreached.length).toBeGreaterThan(0);
    expect(reached.every((m) => m.verdict === "error" && m.cause === "left-out-test-reach")).toBe(
      true,
    );
    expect(unreached.every((m) => m.verdict === "survived")).toBe(true);
  });
  test("procedure coverage: a reached-object mutant a REMAINING test covers stays survived (the survived rewrite is only for coverage none)", async () => {
    const { r } = await run("bcdev", {}, "procedure", true);
    const reached = r.mutants.filter((m) => m.file.endsWith("SetupMgt.al"));
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((m) => m.verdict === "survived" && m.cause === undefined)).toBe(true);
  });
  test("coverage none with --keep-company-tests: nothing is marked", async () => {
    const { r } = await run("bcdev", { keepCompanyTests: true }, "none");
    expect(inFileCount(r, "SetupMgt.al")).toBeGreaterThan(0);
    expect(r.mutants.some((m) => m.cause === "left-out-test-reach")).toBe(false);
  });
  test("one store reused by a later session does not carry the earlier session's set", async () => {
    const store = new ResultsStore(":memory:");
    const first = await run("bcdev", { store });
    expect(first.r.mutants.some((m) => m.cause === "left-out-test-reach")).toBe(true);
    const second = await run("bcdev", { store, keepCompanyTests: true });
    expect(inFileCount(second.r, "SetupMgt.al")).toBeGreaterThan(0);
    expect(second.r.mutants.some((m) => m.cause === "left-out-test-reach")).toBe(false);
  });
});

describe("verify reads the recorded left-out tests as company-write", () => {
  test("the run records their keys apart from --exclude-test's", async () => {
    const store = new ResultsStore(":memory:");
    await run("bcdev", { store });
    expect(store.getRun(1)?.testNarrowing).toEqual({
      testsOnly: [],
      excludeTests: [],
      companyWrites: ["79100::Direct", "79100::ViaHelper", "79100::ViaLib"],
    });
  });
  test("leftOutBySource labels them company-write, not exclude-test", async () => {
    const root = mkdtempSync(join(tmpdir(), "lethal-pr212v-"));
    roots.push(root);
    await Bun.write(join(root, "CoTests.Codeunit.al"), TESTS_AL);
    await Bun.write(join(root, "CoLib.Codeunit.al"), LIB_AL);
    const out = await leftOutBySource(
      root,
      { testsOnly: [], excludeTests: [], companyWrites: ["79100::Direct"] },
      1,
      [],
    );
    expect(out.get("79100::Direct")?.reason).toBe("company-write");
    expect(out.size).toBe(1);
  });
});

const inFileCount = (r: SessionReport, f: string) =>
  r.mutants.filter((m) => m.file.endsWith(f)).length;

describe("record(): the rewrite keeps an existing note and spares a carried verdict", () => {
  const mutant = (id: string): MutantManifestEntry => ({
    mutantId: id,
    file: "SetupMgt.al",
    startIndex: 1,
    endIndex: 2,
    startLine: 3,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 79001,
    codeunitName: "Setup Mgt",
    procedureName: "Limit",
    procedureScope: "public",
    originalText: "x",
    mutatedText: "",
  });
  const drive = (carried: boolean) => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
    setLeftOutReach(store, new Set(["setup mgt"]), false);
    const outcomes: SessionOutcome[] = [];
    record(
      store,
      runId,
      mutant("M0001"),
      "no-coverage",
      outcomes,
      0,
      () => {},
      undefined,
      "R298: refused object note",
      undefined,
      0,
      [],
      undefined,
      undefined,
      carried,
      undefined,
      undefined,
      undefined,
      undefined,
      carried ? 1 : undefined,
    );
    return outcomes[0];
  };
  test("an existing failure note stays, the new one is appended", () => {
    const o = drive(false);
    expect(o?.verdict).toBe("error");
    expect(o?.cause).toBe("left-out-test-reach");
    expect(o?.failureNote).toContain("R298: refused object note");
    expect(o?.failureNote).toContain("not measured");
  });
  test("a carried no-coverage verdict keeps what its own run recorded", () => {
    expect(drive(true)?.verdict).toBe("no-coverage");
  });
});

describe("the flag", () => {
  const ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "bcdev"];
  test("--keep-company-tests is carried", () => {
    const cfg = parseCliConfig([...ARGS, "--keep-company-tests"]);
    expect(cfg.mode === "run" ? cfg.keepCompanyTests : undefined).toBe(true);
    const off = parseCliConfig(ARGS);
    expect(off.mode === "run" ? off.keepCompanyTests : "x").toBeUndefined();
  });
});
