import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
import {
  type RunCliConfig,
  dryRunFromCli,
  parseCliConfig,
  runAndReport,
  runFromCli,
  v3RecheckOf,
} from "../src/cli";
import { discoverTests } from "../src/discovery";
import type { RunEvent, RunEventInput } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { buildReport, renderConsole } from "../src/report";
import type { SessionReport } from "../src/report";
import type { FoldStatics } from "../src/report-fold";
import {
  SessionKindUnsetError,
  backendSessionKind,
  sessionKindSensitiveTests as rawRule,
  validateCiSessionKind,
} from "../src/session-kind";
import { ResultsStore } from "../src/store";
import type { TestAppModel } from "../src/testpage-scan";
import {
  analyzeTestPageModel,
  analyzeTestPageSources,
  buildTestAppModel,
  readTestAppSources,
  scanTestPageSources,
} from "../src/testpage-scan";
import { servesTestApp } from "./helpers/proven-test-app";
import { removeScratchDirs } from "./helpers/scratch";

/**
 * PR-307 (R1168): label session-kind-sensitive tests, and the `ciSessionKind` setting with no default.
 * Every direction below is pinned by a test that goes red when that direction is reverted.
 */

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");

/** The rule, per backend: bcdev is H only; al-runner-v3 adds the TestPage scan (T and U). */
const sessionKindSensitiveTests = (
  model: TestAppModel,
  tests: readonly TestMethodRef[],
  backend: "bcdev" | "al-runner-v3",
) => rawRule(model, tests, backend === "al-runner-v3");

beforeAll(async () => {
  await initParser();
});

// ---------------------------------------------------------------- the fixture census (a STOP condition)

/** A project's symbol sets, as the v3 gate's legs use them (Y-A, Y-B; the wrapped leg's WRAPDEF). */
const SYMBOL_SETS: Record<string, readonly (readonly string[])[]> = {
  "sandbox-symbols-tests": [[], ["LETHALA"], ["LETHALB"]],
  "sandbox-wrapped-tests": [[], ["WRAPDEF"]],
};

describe("PR-307 census over fixtures/*-tests", () => {
  test("exactly one sensitive test on v3 (Data Tests.PageActionComputesNonZero, testpage), none on bcdev, no scan errors", async () => {
    const dirs = readdirSync(FIXTURES)
      .filter((d) => d.endsWith("-tests"))
      .sort();
    expect(dirs.length).toBeGreaterThan(10);
    const v3Hits: string[] = [];
    const bcdevHits: string[] = [];
    const scanErrors: string[] = [];
    for (const d of dirs) {
      const dir = join(FIXTURES, d);
      const model = buildTestAppModel(await readTestAppSources(dir));
      for (const symbols of SYMBOL_SETS[d] ?? [[]]) {
        const tests = (await discoverTests(dir, { buildSymbols: symbols })).filtered;
        scanErrors.push(...analyzeTestPageModel(model, tests).errors.map((e) => `${d}: ${e}`));
        for (const s of sessionKindSensitiveTests(model, tests, "al-runner-v3"))
          v3Hits.push(`${d}|${s.test}|${s.reasons.join(",")}`);
        for (const s of sessionKindSensitiveTests(model, tests, "bcdev"))
          bcdevHits.push(`${d}|${s.test}|${s.reasons.join(",")}`);
      }
    }
    expect(scanErrors).toEqual([]);
    expect([...new Set(v3Hits)]).toEqual([
      "sandbox-data-tests|Data Tests.PageActionComputesNonZero|testpage",
    ]);
    expect(bcdevHits).toEqual([]);
  });
});

// ---------------------------------------------------------------- the rule, on parsed source

const ref = (id: number, method: string, name = "T"): TestMethodRef => ({
  codeunitId: id,
  codeunitName: name,
  method,
  file: "t.al",
});
const kindsOf = (
  text: string,
  tests: TestMethodRef[],
  backend: "bcdev" | "al-runner-v3",
  more: { path: string; text: string }[] = [],
) =>
  sessionKindSensitiveTests(buildTestAppModel([{ path: "t.al", text }, ...more]), tests, backend);

const HANDLER_CU = `codeunit 50100 "T"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('ConfirmHandler')]
    procedure Handled()
    begin
    end;

    [Test]
    procedure Plain()
    begin
    end;

    procedure Helper()
    begin
    end;

    [HandlerFunctions('ConfirmHandler')]
    procedure HelperWithHandlers()
    begin
    end;

    [ConfirmHandler]
    procedure ConfirmHandler(Question: Text[1024]; var Reply: Boolean)
    begin
        Reply := true;
    end;
}
`;

describe("PR-307 H: a discovered [Test] that binds HandlerFunctions", () => {
  test("a handler-bound test is sensitive on both backends, and a plain test is not", () => {
    for (const backend of ["bcdev", "al-runner-v3"] as const) {
      expect(kindsOf(HANDLER_CU, [ref(50100, "Handled"), ref(50100, "Plain")], backend)).toEqual([
        { test: "T.Handled", reasons: ["handlers"] },
      ]);
    }
  });

  test("a helper with handlers is not a discovered test, so it never counts", () => {
    expect(kindsOf(HANDLER_CU, [ref(50100, "Plain")], "bcdev")).toEqual([]);
    // the same helper, if it WERE handed in as a test, would count: the rule reads the list it is given
    expect(kindsOf(HANDLER_CU, [ref(50100, "HelperWithHandlers")], "bcdev")).toHaveLength(1);
  });

  test("a compiled-out #if arm's handlers still count (the union labels more, never fewer)", async () => {
    const text = `codeunit 50100 "T"
{
    Subtype = Test;

    [Test]
#if PR307ARM
    [HandlerFunctions('ConfirmHandler')]
#endif
    procedure Armed()
    begin
    end;

    [ConfirmHandler]
    procedure ConfirmHandler(Question: Text[1024]; var Reply: Boolean)
    begin
    end;
}
`;
    const root = mkdtempSync(join(tmpdir(), "lethal-pr307-arm-"));
    roots.push(root);
    await writeFile(join(root, "T.Codeunit.al"), text);
    // PR307ARM is NOT defined: the arm is compiled out, the test is still discovered
    const tests = (await discoverTests(root, { buildSymbols: [] })).filtered;
    expect(tests.map((t) => t.method)).toEqual(["Armed"]);
    expect(kindsOf(text, tests, "bcdev")).toEqual([{ test: "T.Armed", reasons: ["handlers"] }]);
  });
});

const TESTPAGE_FILES = (() => {
  const t = `codeunit 50100 "T"
{
    Subtype = Test;

    [Test]
    procedure OpensCard()
    var
        Card: TestPage "Data Value Card";
    begin
        Card.OpenView();
    end;

    [Test]
    procedure Plain()
    begin
    end;

    [Test]
    procedure Broken()
    var
        H: Codeunit Helper;
    begin
        H.Run1();
    end;
}
`;
  const helper = `codeunit 50200 "Helper"
{
    procedure Run1()
    begin
        if then;
    end;
}
`;
  return [
    { path: "t.al", text: t },
    { path: "helper.al", text: helper },
  ];
})();
const TP_TESTS = [ref(50100, "OpensCard"), ref(50100, "Plain"), ref(50100, "Broken")];

describe("PR-307 T and U: the TestPage scan, al-runner-v3 only", () => {
  let model = {} as ReturnType<typeof buildTestAppModel>;
  beforeAll(() => {
    model = buildTestAppModel(TESTPAGE_FILES);
  });

  test("on v3 a TestPage test is `testpage`, and a scan-error test is `unreadable` with the scan's text", () => {
    expect(sessionKindSensitiveTests(model, TP_TESTS, "al-runner-v3")).toEqual([
      { test: "T.OpensCard", reasons: ["testpage"] },
      {
        test: "T.Broken",
        reasons: ["unreadable"],
        scanError: "T.Broken reaches Helper (helper.al), which does not parse cleanly",
      },
    ]);
  });

  test("on bcdev the same tests are not sensitive: bcdev refuses and labels them already", () => {
    expect(sessionKindSensitiveTests(model, TP_TESTS, "bcdev")).toEqual([]);
  });

  test("a test that binds handlers AND opens a page carries both reasons", () => {
    const text = `codeunit 50100 "T"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('ConfirmHandler')]
    procedure Both()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
}
`;
    expect(kindsOf(text, [ref(50100, "Both")], "al-runner-v3")).toEqual([
      { test: "T.Both", reasons: ["handlers", "testpage"] },
    ]);
  });

  test("byte-identical pin: `refused`, `errors` and scanTestPageSources' throw are as before errorsByTest", () => {
    const got = analyzeTestPageSources(TESTPAGE_FILES, TP_TESTS);
    expect(JSON.stringify({ refused: [...got.refused], errors: got.errors })).toBe(
      '{"refused":[["50100::OpensCard","T.OpensCard calls Card.OpenView on TestPage \\"Data Value Card\\""]],"errors":["T.Broken reaches Helper (helper.al), which does not parse cleanly"]}',
    );
    let thrown: Error | undefined;
    try {
      scanTestPageSources(TESTPAGE_FILES, TP_TESTS);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.name).toBe("TestPageScanError");
    expect(thrown?.message).toBe(
      "TestPage scan could not classify the test app, so nothing was sent (R-236c): T.Broken reaches Helper (helper.al), which does not parse cleanly",
    );
    // the new map is a pure addition: one entry, the one test that errored
    expect([...got.errorsByTest]).toEqual([
      ["50100::Broken", ["T.Broken reaches Helper (helper.al), which does not parse cleanly"]],
    ]);
  });
});

describe("PR-307: the setting and the backend's session kind", () => {
  test("validateCiSessionKind: absent stays absent, the two values pass, anything else is refused by name", () => {
    expect(validateCiSessionKind(undefined)).toBeUndefined();
    expect(validateCiSessionKind("client")).toBe("client");
    expect(validateCiSessionKind("headless")).toBe("headless");
    for (const bad of ["both", "", "Client", 1, null, true]) {
      expect(() => validateCiSessionKind(bad, "c.json")).toThrow(
        /invalid-ci-session-kind.*c\.json/,
      );
    }
  });

  test("bcdev is headless; v3 is a client unless noClient", () => {
    expect(backendSessionKind({ bcdev: true })).toBe("headless");
    expect(backendSessionKind({ bcdev: true, noClient: false })).toBe("headless");
    expect(backendSessionKind({ bcdev: false })).toBe("client");
    expect(backendSessionKind({ bcdev: false, noClient: false })).toBe("client");
    expect(backendSessionKind({ bcdev: false, noClient: true })).toBe("headless");
  });

  test("the refusal's message names the count, at most 5 examples with reasons, and the one-line fix", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      test: `T.Test${i}`,
      reasons: ["handlers" as const],
    }));
    const msg = new SessionKindUnsetError(many, "/x/lethal.config.json").message;
    expect(msg).toContain('"ciSessionKind"');
    expect(msg).toContain("7 test(s)");
    expect(msg).toContain("T.Test4 (handlers)");
    expect(msg).not.toContain("T.Test5");
    expect(msg).toContain('add "ciSessionKind": "client" (or "headless") to /x/lethal.config.json');
    expect(Object.getPrototypeOf(SessionKindUnsetError.prototype)).toBe(Error.prototype);
  });
});

// ---------------------------------------------------------------- the refusal and the label, through runSession

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const PLAIN_TESTS_AL = `codeunit 79100 "Kind Tests"
{
    Subtype = Test;

    [Test]
    procedure Plain()
    begin
    end;
}
`;
const HANDLED_TESTS_AL = `codeunit 79100 "Kind Tests"
{
    Subtype = Test;

    [Test]
    procedure Plain()
    begin
    end;

    [Test]
    [HandlerFunctions('ConfirmHandler')]
    procedure Handled()
    begin
    end;

    [ConfirmHandler]
    procedure ConfirmHandler(Question: Text[1024]; var Reply: Boolean)
    begin
        Reply := true;
    end;
}
`;
const TESTPAGE_TESTS_AL = `codeunit 79101 "Page Tests"
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
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a93",
  name: "Sandbox PR307 Fixture",
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

/** One stub for both kinds. Every call that is more than a probe is counted. */
class Stub implements ExecutionBackend {
  runs = 0;
  deploys = 0;
  activations = 0;
  statusCalls = 0;
  readonly noClient: boolean;
  constructor(
    private readonly kind: "bcdev" | "al-runner-v3",
    noClient = false,
  ) {
    this.noClient = noClient;
    if (kind === "bcdev") Object.assign(this, servesTestApp());
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: this.kind,
      authoritative: this.kind === "bcdev",
    };
  }
  async status(): Promise<BackendStatus> {
    this.statusCalls += 1;
    return { ok: true, details: "stub" };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "al-runner 3.0.0-test", binarySha256: "b".repeat(64) };
  }
  async deploy(): Promise<null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(): Promise<void> {
    this.activations += 1;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    this.runs += 1;
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
      },
    };
  }
}

const roots: string[] = [];
afterEach(() => {
  removeScratchDirs(roots.splice(0));
});

async function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "lethal-pr307-"));
  roots.push(root);
  await Bun.write(join(root, "app", "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(root, "app", "app.json"), APP_JSON);
  for (const [name, text] of Object.entries(files))
    await Bun.write(join(root, "tests", name), text);
  await Bun.write(join(root, "tests", "app.json"), TEST_APP_JSON);
  return root;
}

let n = 0;
const session = (
  root: string,
  backend: Stub,
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

/** Nothing ran, nothing was deployed, nothing was activated: only the readiness probe may have been asked. */
const untouched = (b: Stub) => {
  expect({ runs: b.runs, deploys: b.deploys, activations: b.activations }).toEqual({
    runs: 0,
    deploys: 0,
    activations: 0,
  });
};

describe("PR-307: the refusal, on the run's FINAL test list", () => {
  test("v3, a TestPage test, ciSessionKind unset: refused by name, nothing ran, the message holds the fix", async () => {
    const root = await project({
      "Page.Codeunit.al": TESTPAGE_TESTS_AL,
      "Plain.al": PLAIN_TESTS_AL,
    });
    const backend = new Stub("al-runner-v3");
    const err = await session(root, backend, {
      configPath: "/work/lethal.config.json",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionKindUnsetError);
    expect((err as Error).message).toContain("Page Tests.OpensCard (testpage)");
    expect((err as Error).message).toContain(
      'add "ciSessionKind": "client" (or "headless") to /work/lethal.config.json',
    );
    untouched(backend);
  });

  test("bcdev, a handler-bound test, unset: refused with 0 backend runs; set to either value, it runs", async () => {
    const root = await project({ "Kind.Codeunit.al": HANDLED_TESTS_AL });
    const refused = new Stub("bcdev");
    await expect(session(root, refused)).rejects.toThrow(SessionKindUnsetError);
    untouched(refused);
    for (const kind of ["client", "headless"] as const) {
      const ok = new Stub("bcdev");
      const r = await session(root, ok, { ciSessionKind: kind });
      expect(ok.runs).toBeGreaterThan(0);
      expect(r.sessionKindSensitiveTests).toEqual([
        { test: "Kind Tests.Handled", reasons: ["handlers"] },
      ]);
    }
  });

  test("--exclude-test leaves out the only sensitive test: no refusal, no field, no caveat", async () => {
    const root = await project({ "Kind.Codeunit.al": HANDLED_TESTS_AL });
    const backend = new Stub("bcdev");
    const r = await session(root, backend, { excludeTests: ["Kind Tests.Handled"] });
    expect(backend.runs).toBeGreaterThan(0);
    expect(r.sessionKindSensitiveTests).toBeUndefined();
    expect(r.validity.caveats).not.toContain("session-kind-mismatch");
  });

  test("--tests-only that leaves out the only sensitive test: no refusal", async () => {
    const root = await project({
      "Plain.Codeunit.al": PLAIN_TESTS_AL,
      "Page.Codeunit.al": TESTPAGE_TESTS_AL,
    });
    const control = new Stub("al-runner-v3");
    await expect(session(root, control)).rejects.toThrow(SessionKindUnsetError);
    const backend = new Stub("al-runner-v3");
    const r = await session(root, backend, { testsOnly: ["Plain.Codeunit.al"] });
    expect(backend.runs).toBeGreaterThan(0);
    expect(r.sessionKindSensitiveTests).toBeUndefined();
  });

  test("bcdev, a TestPage test (refused as before), unset: no refusal, no testpage label, no caveat", async () => {
    const root = await project({
      "Page.Codeunit.al": TESTPAGE_TESTS_AL,
      "Plain.al": PLAIN_TESTS_AL,
    });
    const backend = new Stub("bcdev");
    const r = await session(root, backend);
    expect(backend.runs).toBeGreaterThan(0);
    expect(r.testPageRefused?.tests).toEqual(["Page Tests.OpensCard"]);
    expect(r.sessionKindSensitiveTests).toBeUndefined();
    expect(r.validity.caveats).not.toContain("session-kind-mismatch");
  });

  test("none sensitive and unset: it runs, with no field and no caveat", async () => {
    const root = await project({ "Plain.Codeunit.al": PLAIN_TESTS_AL });
    for (const kind of ["bcdev", "al-runner-v3"] as const) {
      const events: RunEvent[] = [];
      const r = await session(root, new Stub(kind), {}, events);
      expect(r.sessionKindSensitiveTests).toBeUndefined();
      expect(r.validity.caveats).not.toContain("session-kind-mismatch");
      expect(events.some((e) => e.type === "tests-session-kind-sensitive")).toBe(false);
    }
  });
});

describe("PR-307: sensitive and set, the label and the caveat", () => {
  // [backend, noClient, ciSessionKind, caveat expected]; the sensitive test is a TestPage one on v3, a handler one on bcdev
  const MATRIX: ReadonlyArray<
    readonly ["bcdev" | "al-runner-v3", boolean, "client" | "headless", boolean]
  > = [
    ["bcdev", false, "client", true],
    ["bcdev", false, "headless", false],
    ["al-runner-v3", false, "headless", true],
    ["al-runner-v3", false, "client", false],
    ["al-runner-v3", true, "client", true],
    ["al-runner-v3", true, "headless", false],
  ];
  for (const [kind, noClient, ci, caveat] of MATRIX) {
    test(`${kind}${noClient ? " noClient" : ""} with ciSessionKind ${ci}: ${caveat ? "caveat" : "no caveat"}`, async () => {
      const root = await project(
        kind === "bcdev"
          ? { "Kind.Codeunit.al": HANDLED_TESTS_AL }
          : { "Page.Codeunit.al": TESTPAGE_TESTS_AL },
      );
      const events: RunEvent[] = [];
      const r = await session(root, new Stub(kind, noClient), { ciSessionKind: ci }, events);
      expect(r.sessionKindSensitiveTests?.length).toBe(1);
      expect(r.sessionKindSensitiveTests?.[0]?.reasons).toEqual([
        kind === "bcdev" ? "handlers" : "testpage",
      ]);
      expect(r.validity.caveats.includes("session-kind-mismatch")).toBe(caveat);
      expect(renderConsole(r).includes("SESSION KIND:")).toBe(caveat);
      const e = events.filter((x) => x.type === "tests-session-kind-sensitive");
      expect(e).toHaveLength(1);
    });
  }

  test("the label moves no verdict and no count", async () => {
    const root = await project({ "Kind.Codeunit.al": HANDLED_TESTS_AL });
    const withKind = await session(root, new Stub("bcdev"), { ciSessionKind: "client" });
    const without = await session(
      await project({ "Kind.Codeunit.al": PLAIN_TESTS_AL }),
      new Stub("bcdev"),
    );
    expect(withKind.counts).toEqual(without.counts);
    expect(withKind.mutants.map((m) => m.verdict)).toEqual(without.mutants.map((m) => m.verdict));
  });
});

// ---------------------------------------------------------------- the report fold, one event

describe("PR-307: ONE non-warning event reaches the report", () => {
  const STATICS: FoldStatics = {
    caps: {
      kind: "bcdev",
      authoritative: true,
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
    },
    buildSymbols: [],
  };
  const seq = (events: readonly RunEventInput[]): RunEvent[] =>
    events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
  const sensitive = (
    backendSessionKind: "client" | "headless",
    ciSessionKind: "client" | "headless",
  ): RunEventInput => ({
    type: "tests-session-kind-sensitive",
    tests: [{ test: "T.Handled", reasons: ["handlers"] }],
    backendSessionKind,
    ciSessionKind,
  });
  const prefix = (): RunEventInput[] => [
    {
      type: "mutation-set-generated",
      siteCount: 1,
      deployedCount: 1,
      hangCapableCount: 0,
      totalFiles: 1,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      preprocExcludedFiles: [],
      excludedByOnly: 0,
      excludedByExclude: 0,
      excludedByOperator: 0,
    },
  ];
  const finished: RunEventInput = { type: "session-finished", elapsedMs: 1 };

  test("bcdev with client: field and caveat; bcdev with headless: field only", () => {
    const mismatch = buildReport(
      STATICS,
      seq([...prefix(), sensitive("headless", "client"), finished]),
    );
    expect(mismatch.sessionKindSensitiveTests).toEqual([
      { test: "T.Handled", reasons: ["handlers"] },
    ]);
    expect(mismatch.validity.caveats).toContain("session-kind-mismatch");
    const match = buildReport(
      STATICS,
      seq([...prefix(), sensitive("headless", "headless"), finished]),
    );
    expect(match.sessionKindSensitiveTests).toHaveLength(1);
    expect(match.validity.caveats).not.toContain("session-kind-mismatch");
  });

  test("no event, no field and no caveat", () => {
    const none = buildReport(STATICS, seq([...prefix(), finished]));
    expect("sessionKindSensitiveTests" in none).toBe(false);
    expect(none.validity.caveats).not.toContain("session-kind-mismatch");
  });
});

// ---------------------------------------------------------------- every path to runSession

describe("PR-307: every path reads the setting from the one config load", () => {
  class PassingV3 extends Stub {
    constructor() {
      super("al-runner-v3");
    }
  }
  // A refused run keeps its scratch folder (the CLI's rule for a failed run): remove what each test left.
  let before = new Set<string>();
  beforeEach(() => {
    before = new Set(readdirSync(tmpdir()));
  });
  afterEach(() => {
    removeScratchDirs(
      readdirSync(tmpdir())
        .filter((d) => d.startsWith("lethal-") && !before.has(d))
        .map((d) => join(tmpdir(), d)),
    );
  });

  async function cliProject(configJson: Record<string, unknown>) {
    const root = await project({ "Page.Codeunit.al": TESTPAGE_TESTS_AL });
    const configPath = join(root, "lethal.config.json");
    await writeFile(configPath, JSON.stringify(configJson));
    const parsed: RunCliConfig = {
      mode: "run",
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      backendKind: "al-runner-v3",
      dbPath: join(root, "lethal.sqlite"),
      configPath,
      skipKnownSurvivors: false,
      workers: 1,
      keepEnv: false,
      allowExpiringEnv: false,
    };
    return { root, configPath, parsed };
  }
  const deps = (backend: Stub) => ({
    validateSelectorIdsForProject: async () => {},
    buildBackend: async () => backend,
  });

  test("run: unset is refused, set runs", async () => {
    const unset = await cliProject({});
    const refused = new PassingV3();
    await expect(runFromCli(unset.parsed, deps(refused))).rejects.toThrow(SessionKindUnsetError);
    untouched(refused);
    const set = await cliProject({ ciSessionKind: "headless" });
    const ok = new PassingV3();
    const report = await runFromCli(set.parsed, deps(ok));
    expect(ok.runs).toBeGreaterThan(0);
    expect(report.sessionKindSensitiveTests?.[0]?.test).toBe("Page Tests.OpensCard");
    expect(report.validity.caveats).toContain("session-kind-mismatch");
  });

  test("PR-307b: --ci-session-kind alone (config without the field) runs, and the flag beats the config both ways", async () => {
    // the flag alone: a config the caller cannot edit holds no field
    const flagOnly = await cliProject({});
    const ran = new PassingV3();
    const r1 = await runFromCli({ ...flagOnly.parsed, ciSessionKind: "client" }, deps(ran));
    expect(ran.runs).toBeGreaterThan(0);
    expect(r1.validity.caveats).not.toContain("session-kind-mismatch"); // v3 is client: matches the flag
    // the flag overrides the config: config headless (mismatch on v3), flag client (match)
    const cfgHeadless = await cliProject({ ciSessionKind: "headless" });
    const r2 = await runFromCli(
      { ...cfgHeadless.parsed, ciSessionKind: "client" },
      deps(new PassingV3()),
    );
    expect(r2.validity.caveats).not.toContain("session-kind-mismatch");
    // and the other way: config client (match), flag headless (mismatch)
    const cfgClient = await cliProject({ ciSessionKind: "client" });
    const r3 = await runFromCli(
      { ...cfgClient.parsed, ciSessionKind: "headless" },
      deps(new PassingV3()),
    );
    expect(r3.validity.caveats).toContain("session-kind-mismatch");
  });

  test("PR-307b: the refusal names the flag too", async () => {
    const unset = await cliProject({});
    await expect(runFromCli(unset.parsed, deps(new PassingV3()))).rejects.toThrow(
      /--ci-session-kind client \(or headless\), which overrides the config/,
    );
  });

  test("PR-307b: parseCliConfig reads --ci-session-kind and refuses a bad value by name", () => {
    const base = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner-v3"];
    const ok = parseCliConfig([...base, "--ci-session-kind", "headless"]);
    expect(ok.mode === "run" ? ok.ciSessionKind : "not run").toBe("headless");
    const none = parseCliConfig(base);
    expect(none.mode === "run" ? none.ciSessionKind : "not run").toBeUndefined();
    expect(() => parseCliConfig([...base, "--ci-session-kind", "gui"])).toThrow(
      /invalid-ci-session-kind: --ci-session-kind/,
    );
  });

  test("--resume: the resumed session reads the same setting, and refuses without it", async () => {
    const first = await cliProject({ ciSessionKind: "client" });
    await runFromCli(first.parsed, deps(new PassingV3()));
    // the same store, the config now without the field
    await writeFile(first.configPath, JSON.stringify({}));
    const refused = new PassingV3();
    await expect(runFromCli({ ...first.parsed, resume: "last" }, deps(refused))).rejects.toThrow(
      SessionKindUnsetError,
    );
    untouched(refused);
  });

  test("a lend (--skip-known-survivors on a store with history) refuses without it", async () => {
    const first = await cliProject({ ciSessionKind: "client" });
    await runFromCli(first.parsed, deps(new PassingV3()));
    await writeFile(first.configPath, JSON.stringify({}));
    const refused = new PassingV3();
    await expect(
      runFromCli({ ...first.parsed, skipKnownSurvivors: true }, deps(refused)),
    ).rejects.toThrow(SessionKindUnsetError);
    untouched(refused);
  });

  test("the entry `lethal run` and a campaign stage both call (runAndReport) refuses without it", async () => {
    const unset = await cliProject({});
    const refused = new PassingV3();
    await expect(runAndReport(unset.parsed, deps(refused))).rejects.toThrow(SessionKindUnsetError);
    untouched(refused);
  });

  test("an invalid value in the config file is refused by name, before the backend is built", async () => {
    const bad = await cliProject({ ciSessionKind: "both" });
    let built = 0;
    await expect(
      runFromCli(bad.parsed, {
        validateSelectorIdsForProject: async () => {},
        buildBackend: async () => {
          built += 1;
          return new PassingV3();
        },
      }),
    ).rejects.toThrow(/invalid-ci-session-kind/);
    expect(built).toBe(0);
  });

  test("the nested recheck's session carries the main config's setting (built from `base`), and drops it if the main has none", async () => {
    for (const ci of ["client", "headless", undefined] as const) {
      const nested: SessionConfig[] = [];
      const recheck = v3RecheckOf({
        parsed: { backendKind: "al-runner-v3" } as RunCliConfig,
        effectiveConfig: {
          alRunnerV3: { packagesDir: "/p", bcVersion: "28.0.1.1", path: "/x" },
        } as never,
        mainConfig: (ci === undefined ? {} : { ciSessionKind: ci }) as unknown as SessionConfig,
        build: async () => ({}) as never,
        newStore: () => new ResultsStore(":memory:"),
        scratchRoot: "/scratch",
        runSession: async (cfg) => {
          nested.push(cfg);
          throw new Error("stop here");
        },
      });
      await recheck?.runner({ targets: [], tests: [], budgetSeconds: 1 } as never).catch(() => {});
      expect(nested).toHaveLength(1);
      expect(nested[0]?.ciSessionKind).toBe(ci);
    }
  });

  test("--dry-run never refuses, with sensitive tests and no setting", async () => {
    const unset = await cliProject({});
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      const code = await dryRunFromCli({
        mode: "dry-run",
        projectDir: unset.parsed.projectDir,
        testDir: unset.parsed.testDir,
        dbPath: unset.parsed.dbPath,
        configPath: unset.configPath,
      });
      expect(code).toBe(0);
    } finally {
      console.log = log;
    }
  });

  test("verify and doctor have no way to refuse: neither reads the setting nor runs a session", () => {
    for (const f of ["verify.ts", "doctor.ts"]) {
      const text = readFileSync(join(import.meta.dir, "..", "src", f), "utf8");
      expect(text).not.toContain("session-kind");
      expect(text).not.toContain("SessionKindUnsetError");
      expect(text).not.toMatch(/\brunSession\(/);
    }
  });
});

// keeps `mkdir` and `PassingV3` honest if a case above is removed
void mkdir;
