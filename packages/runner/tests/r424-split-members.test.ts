import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import {
  TreeDiscoveryMismatchError,
  armFilteredTestsInAlSource,
  discoverTests,
  testsInAlSource,
  treeTestsWithOffsets,
} from "../src/discovery";
import type { RunEvent } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
} from "../src/preprocessor-symbols";
import { sessionFingerprint, testDiscoveryMarker } from "../src/resume";
import { ResultsStore } from "../src/store";
import { testDigestsOfSources, walkTest } from "../src/test-digest";
import {
  TestAppDiffersError,
  assertTestMembership,
  compiledMembershipOf,
} from "../src/test-membership";
import {
  type Proc,
  Scanner,
  type Unit,
  analyzeTestPageSources,
  buildTestAppModel,
  normalizeSource,
  sha256,
} from "../src/testpage-scan";
import { buildFakeApp } from "./helpers/fake-app";
import { removeScratchDirs } from "./helpers/scratch";

/**
 * R424: a procedure whose HEADER is split by `#if` (one header per arm, one shared body) is one
 * `preproc_split_procedure` node in tree-sitter-al 4.4.1. Measured shapes and compiled method lists:
 * plan `docs/superpowers/plans/2026-10-04-R-424-split-procedure-tests.md` §1.
 */

beforeAll(async () => {
  await initParser();
});

const roots: string[] = [];
afterEach(() => {
  removeScratchDirs(roots.splice(0));
});

// ————————————————————————————————————————————————————————————————————————
// Before and after (plan r2 §5): a test that opens a TestPage ONLY through a split helper.
// ————————————————————————————————————————————————————————————————————————

/** The helper's header is split the common way (a modifier changes under a CLEAN symbol); its
 *  body opens a TestPage. The test reaches the TestPage only through it. */
const HELPER_OPENS = `codeunit 92490 "R424 Helper Opens"
{
    Subtype = Test;

    [Test]
    procedure OpensThroughHelper()
    begin
        OpenIt();
    end;

#if CLEAN25
    local procedure OpenIt()
#else
    procedure OpenIt()
#endif
    var
        P: TestPage "Customer Card";
    begin
        P.OpenView();
    end;
}
`;

const HELPER_TEST: TestMethodRef = {
  codeunitId: 92490,
  codeunitName: "R424 Helper Opens",
  method: "OpensThroughHelper",
  file: "HelperOpens.Codeunit.al",
};

const TARGET_AL = `codeunit 50013 "R424 Target"
{
    procedure Run(X: Integer)
    begin
        Helper(X);
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;
const PLAIN_AL = `codeunit 92480 "R424 Plain"
{
    Subtype = Test;

    [Test]
    procedure PlainTest()
    begin
    end;
}
`;

class StubBackend implements ExecutionBackend {
  private active: string | null = null;
  readonly baselineMethods: string[] = [];
  constructor(private readonly authoritative: boolean) {}
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      authoritative: this.authoritative,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  measurePredefinedSymbols(): Promise<AlRunnerPredefinedProbe> {
    return Promise.resolve({ symbols: [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort() });
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) this.baselineMethods.push(ref.method);
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(this.active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 50013, procedure: "Run" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

/** A project whose test app holds `PLAIN_AL` plus `files`. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r424-run-"));
  roots.push(root);
  const appJson = (name: string) =>
    JSON.stringify({
      id: "11111111-2222-3333-4444-555555555555",
      name,
      publisher: "x",
      version: "1.0.0.0",
    });
  await Bun.write(join(root, "app", "app.json"), appJson("p"));
  await Bun.write(join(root, "app", "src", "Target.Codeunit.al"), TARGET_AL);
  await Bun.write(join(root, "tests", "app.json"), appJson("t"));
  await Bun.write(join(root, "tests", "Plain.Codeunit.al"), PLAIN_AL);
  for (const [name, text] of Object.entries(files))
    await Bun.write(join(root, "tests", name), text);
  return root;
}

let sessions = 0;
const session = (
  root: string,
  store: ResultsStore,
  backend: StubBackend,
  extra: Partial<SessionConfig> = {},
) =>
  runSession({
    backend,
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, `instr-${++sessions}`),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    ...extra,
  });

// Before R424 (pinned against 61ad4d84 in 9881af1b): the scan gave this test no reason and no
// error, and on bcdev it was sent to the baseline. The helper was silently ignored.
describe("R424 after: a TestPage opened only through a split helper is seen", () => {
  test("the scan refuses the test, and its reason names the helper", () => {
    const got = analyzeTestPageSources(
      [{ path: HELPER_TEST.file ?? "", text: HELPER_OPENS }],
      [HELPER_TEST],
    );
    expect(got.errors).toEqual([]);
    expect([...got.refused]).toEqual([
      [
        "92490::OpensThroughHelper",
        'R424 Helper Opens.OpensThroughHelper -> R424 Helper Opens.OpenIt calls P.OpenView on TestPage "Customer Card"',
      ],
    ]);
  });

  test("on bcdev the test is refused: not sent to the baseline", async () => {
    const root = await project({ "HelperOpens.Codeunit.al": HELPER_OPENS });
    const events: RunEvent[] = [];
    const backend = new StubBackend(true);
    await session(root, new ResultsStore(":memory:"), backend, {
      emit: [(e) => events.push(e)],
    });
    expect(
      events
        .filter((e) => e.type === "tests-testpage-refused")
        .map((e) => ("tests" in e ? e.tests : [])),
    ).toEqual([["R424 Helper Opens.OpensThroughHelper"]]);
    expect([...new Set(backend.baselineMethods)]).toEqual(["PlainTest"]);
  });
});

// ————————————————————————————————————————————————————————————————————————
// The measured shapes (plan §1), verbatim from the scratch probe alc compiled.
// ————————————————————————————————————————————————————————————————————————

const V: Record<string, string> = {
  V1: `codeunit 92461 "V1"
{
    Subtype = Test;

    [Test]
#if X
    procedure T10a()
#else
    procedure T10b()
#endif
    begin
    end;
}
`,
  V2: `codeunit 92462 "V2"
{
    Subtype = Test;

    [Test]
    procedure TCall()
    begin
        H(1);
    end;

#if X
    procedure H(A: Integer)
#else
    procedure H(A: Integer; B: Integer)
#endif
    begin
    end;
}
`,
  V3: `codeunit 92463 "V3"
{
    Subtype = Test;

    [Test]
#if X
    procedure T3a()
#else
    procedure T3b()
#endif
    var
        I: Integer;
    begin
        I := 1;
    end;
}
`,
  V4: `codeunit 92464 "V4"
{
    Subtype = Test;

#if X
    [Test]
    procedure T4a()
#else
    [Test]
    procedure T4b()
#endif
    begin
    end;
}
`,
  V5: `codeunit 92465 "V5"
{
    Subtype = Test;

    [Test]
    procedure TCall()
    begin
        H();
    end;

#if X
    procedure H(): Integer
#else
    procedure H(): Decimal
#endif
    begin
    end;
}
`,
  V6: `codeunit 92466 "V6"
{
    Subtype = Test;

    [Test]
#if X
    procedure T6x()
#elif Y
    procedure T6y()
#else
    procedure T6z()
#endif
    begin
    end;
}
`,
  V7: `codeunit 92467 "V7"
{
    Subtype = Test;

    [Test]
#if X
    internal procedure T7a()
#else
    procedure T7b()
#endif
    begin
    end;
}
`,
  // `preproc_split_procedure_preamble`: a `var` section per arm. Measured by the R-424 build: alc
  // compiles T8b under [] and T8a under [X], so it reads like a split procedure.
  P1: `codeunit 92468 "P1"
{
    Subtype = Test;

    [Test]
#if X
    procedure T8a()
    var
        L: Integer;
#else
    procedure T8b()
    var
        M: Integer;
#endif
    begin
    end;
}
`,
};

const unitOf = (src: string, path = "V.al"): Unit => {
  const [u] = buildTestAppModel([{ path, text: src }]).units;
  if (u === undefined) throw new Error("no unit");
  return u;
};
const declOf = (p: Proc) => ({
  name: p.name,
  params: p.params,
  returnType: p.returnType,
  scope: [...p.scope.keys()].sort(),
});

describe("R424: the model holds one Proc per arm", () => {
  test("V1 to V7 and the preamble: names, params, scope, return types", () => {
    const got = Object.fromEntries(
      Object.entries(V).map(([k, src]) => [k, unitOf(src).procs.map(declOf)]),
    );
    const none = { params: 0, returnType: undefined, scope: [] };
    expect(got).toEqual({
      V1: [
        { name: "t10a", ...none },
        { name: "t10b", ...none },
      ],
      V2: [
        { name: "tcall", ...none },
        { name: "h", params: 1, returnType: undefined, scope: ["a"] },
        { name: "h", params: 2, returnType: undefined, scope: ["a", "b"] },
      ],
      V3: [
        { name: "t3a", params: 0, returnType: undefined, scope: ["i"] },
        { name: "t3b", params: 0, returnType: undefined, scope: ["i"] },
      ],
      V4: [
        { name: "t4a", ...none },
        { name: "t4b", ...none },
      ],
      // Two Procs, never merged: each keeps its own return type.
      V5: [
        { name: "tcall", ...none },
        { name: "h", params: 0, returnType: "Integer", scope: [] },
        { name: "h", params: 0, returnType: "Decimal", scope: [] },
      ],
      V6: [
        { name: "t6x", ...none },
        { name: "t6y", ...none },
        { name: "t6z", ...none },
      ],
      V7: [
        { name: "t7a", ...none },
        { name: "t7b", ...none },
      ],
      // A preamble arm's scope is its own var section only.
      P1: [
        { name: "t8a", params: 0, returnType: undefined, scope: ["l"] },
        { name: "t8b", params: 0, returnType: undefined, scope: ["m"] },
      ],
    });
  });

  test("a named return value in one arm is that arm's variable only", () => {
    const src = V.V5?.replace("procedure H(): Decimal", "procedure H() R: Decimal") ?? "";
    const [, a, b] = unitOf(src).procs;
    expect(a && declOf(a)).toEqual({ name: "h", params: 0, returnType: "Integer", scope: [] });
    expect(b && declOf(b)).toEqual({ name: "h", params: 0, returnType: "Decimal", scope: ["r"] });
  });

  test("the arms share one sites array (the shared body)", () => {
    const [a, b] = unitOf(V.V3 ?? "").procs;
    expect(a?.sites).toBeDefined();
    expect(a?.sites).toBe(b?.sites);
  });

  test("every arm's span is the run before the split node plus the whole node", () => {
    const src = V.V3 ?? "";
    const [a, b] = unitOf(src).procs;
    const from = src.indexOf("    [Test]") + 4;
    const to = src.indexOf("    end;\n}") + "    end;".length;
    expect(a?.spanHash).toBe(sha256(normalizeSource(src.slice(from, to))));
    expect(b?.spanHash).toBe(a?.spanHash);
  });

  test("V4 with handlers: each arm's own attributes plus the run before the node", () => {
    const src = `codeunit 92464 "V4H"
{
    Subtype = Test;

    [HandlerFunctions('Lead')]
#if X
    [Test]
    [HandlerFunctions('HX')]
    procedure T4a()
#else
    [Test]
    procedure T4b()
#endif
    begin
    end;
}
`;
    const [a, b] = unitOf(src).procs;
    expect(a?.handlers).toEqual(["hx", "lead"]);
    expect(b?.handlers).toEqual(["lead"]);
  });

  test("an [EventSubscriber] in one arm makes that arm, and its codeunit, a subscriber", () => {
    const src = `codeunit 92479 "Sub"
{
#if X
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", 'OnBeforePostSalesDoc', '', false, false)]
    local procedure OnBefore()
#else
    local procedure OnBeforeOld()
#endif
    begin
    end;
}
`;
    const u = unitOf(src);
    expect(u.procs.map((p) => [p.name, p.subscriber])).toEqual([
      ["onbefore", true],
      ["onbeforeold", false],
    ]);
    expect(u.subscriber).toBe(true);
  });

  /** A split helper directly after the global `var` section: tree-sitter-al places it INSIDE that
   *  section (measured), where `procsInVarSection` must find it and `addDeclarations` must not read
   *  its locals as globals. */
  const AFTER_VARS = `codeunit 92469 "G1"
{
    Subtype = Test;

    var
        G: Integer;

#if X
    procedure H()
#else
    procedure H2()
#endif
    var
        Lp: TestPage "Customer Card";
    begin
        Lp.OpenView();
    end;

    [Test]
    procedure T()
    begin
        H();
    end;
}
`;

  test("a split member's locals are not read as globals", () => {
    const u = unitOf(AFTER_VARS);
    expect([...u.globals.keys()]).toEqual(["g"]);
    expect(u.procs.map((p) => [p.name, [...p.scope.keys()]])).toEqual([
      ["h", ["lp"]],
      ["h2", ["lp"]],
      ["t", []],
    ]);
  });

  test("a split member inside the global var section is walked by the scan", () => {
    const t = { codeunitId: 92469, codeunitName: "G1", method: "T", file: "G1.al" };
    const got = analyzeTestPageSources([{ path: "G1.al", text: AFTER_VARS }], [t]);
    expect(got.errors).toEqual([]);
    expect([...got.refused.values()]).toEqual([
      'G1.T -> G1.H calls Lp.OpenView on TestPage "Customer Card"',
    ]);
  });

  test("a non-codeunit object's split procedure is in its unit too", () => {
    const src = `table 92481 "R424 Tab"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }

#if X
    procedure Fill()
#else
    procedure FillOld()
#endif
    begin
    end;
}
`;
    const [o] = buildTestAppModel([{ path: "Tab.al", text: src }]).objects;
    expect(o?.procs.map((p) => p.name)).toEqual(["fill", "fillold"]);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Calls: the arms resolve by name and parameter count, and every arm is followed.
// ————————————————————————————————————————————————————————————————————————

const ref = (codeunitId: number, codeunitName: string, method: string): TestMethodRef => ({
  codeunitId,
  codeunitName,
  method,
  file: `${codeunitName}.al`,
});

/** The keys of every procedure one test's digest walk reaches. */
function reached(files: ReadonlyArray<{ path: string; text: string }>, t: TestMethodRef): string[] {
  const model = buildTestAppModel(files);
  return [...walkTest(new Scanner(model), model, t).procs].map((p) => p.key).sort();
}

const LIB = (id: number, name: string, page: string, opens: boolean) => `codeunit ${id} "${name}"
{
    procedure Foo()
    var
        P: TestPage "${page}";
    begin
${opens ? "        P.OpenView();\n" : ""}    end;
}
`;
/** V5's shape with codeunit return types: `H().Foo()` can be either codeunit's `Foo`. */
const CHAIN = `codeunit 92477 "R424 Chain"
{
    Subtype = Test;

    [Test]
    procedure TChain()
    begin
        H().Foo();
    end;

#if X
    procedure H(): Codeunit "R424 Lib A"
#else
    procedure H(): Codeunit "R424 Lib B"
#endif
    begin
    end;
}
`;
const chainFiles = (aOpens: boolean, bOpens: boolean) => [
  { path: "Chain.al", text: CHAIN },
  { path: "A.al", text: LIB(92475, "R424 Lib A", "Customer Card", aOpens) },
  { path: "B.al", text: LIB(92476, "R424 Lib B", "Item Card", bOpens) },
];
const T_CHAIN = ref(92477, "R424 Chain", "TChain");

describe("R424: calls into a split member", () => {
  test("V2: H(1) and H(1, 2) each resolve to their own arm, as a reach edge", () => {
    const src = (V.V2 ?? "").replace(
      "        H(1);\n    end;\n",
      "        H(1);\n    end;\n\n    [Test]\n    procedure TCall2()\n    begin\n        H(1, 2);\n    end;\n",
    );
    const files = [{ path: "V2.al", text: src }];
    expect(reached(files, ref(92462, "V2", "TCall"))).toEqual(["92462:V2.H", "92462:V2.TCall"]);
    expect(reached(files, ref(92462, "V2", "TCall2"))).toEqual(["92462:V2.H#1", "92462:V2.TCall2"]);
  });

  test("H().Foo() with H returning Codeunit A in one arm and B in the other: the scan reaches both", () => {
    const scan = (aOpens: boolean, bOpens: boolean) => [
      ...analyzeTestPageSources(chainFiles(aOpens, bOpens), [T_CHAIN]).refused.values(),
    ];
    expect(scan(true, false)).toEqual([
      'R424 Chain.TChain -> R424 Lib A.Foo calls P.OpenView on TestPage "Customer Card"',
    ]);
    expect(scan(false, true)).toEqual([
      'R424 Chain.TChain -> R424 Lib B.Foo calls P.OpenView on TestPage "Item Card"',
    ]);
    expect(scan(false, false)).toEqual([]);
  });

  test("H().Foo(): the digest reaches both A.Foo and B.Foo", () => {
    expect(reached(chainFiles(false, false), T_CHAIN)).toEqual([
      "92475:R424 Lib A.Foo",
      "92476:R424 Lib B.Foo",
      "92477:R424 Chain.H",
      "92477:R424 Chain.H#1",
      "92477:R424 Chain.TChain",
    ]);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Discovery against the compiler (plan §1's table), per shape and build.
// ————————————————————————————————————————————————————————————————————————

const BUILDS = { none: [] as string[], X: ["X"], Y: ["Y"] } as const;
type Build = keyof typeof BUILDS;
const COMPILED: Record<string, Record<Build, string>> = {
  V1: { none: "T10b", X: "T10a", Y: "T10b" },
  V3: { none: "T3b", X: "T3a", Y: "T3b" },
  V4: { none: "T4b", X: "T4a", Y: "T4b" },
  V6: { none: "T6z", X: "T6x", Y: "T6y" },
  V7: { none: "T7b", X: "T7a", Y: "T7b" },
};
const methods = (refs: readonly TestMethodRef[]) => refs.map((r) => r.method);

async function testDirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r424-"));
  roots.push(dir);
  for (const [name, text] of Object.entries(files)) await Bun.write(join(dir, name), text);
  return dir;
}

describe("R424: discovery, one candidate per arm", () => {
  for (const [shape, byBuild] of Object.entries(COMPILED)) {
    for (const build of ["none", "X", "Y"] as const) {
      test(`${shape} under [${BUILDS[build].join(", ")}]: exactly ${byBuild[build]}, no warning`, async () => {
        const dir = await testDirWith({ [`${shape}.Codeunit.al`]: V[shape] ?? "" });
        const d = await discoverTests(dir, { buildSymbols: BUILDS[build] });
        expect(methods(d.filtered)).toEqual([byBuild[build]]);
        expect(d.warnings).toEqual([]);
      });
    }
  }

  test("the preamble: T8b under [], T8a under [X] (measured), no warning", async () => {
    const dir = await testDirWith({ "P1.Codeunit.al": V.P1 ?? "" });
    const none = await discoverTests(dir, { buildSymbols: [] });
    expect(methods(none.filtered)).toEqual(["T8b"]);
    expect(none.warnings).toEqual([]);
    const x = await discoverTests(dir, { buildSymbols: ["X"] });
    expect(methods(x.filtered)).toEqual(["T8a"]);
  });

  test("unfiltered holds every arm, and splitTests names them; treeOnly too, V4's excepted", async () => {
    const dir = await testDirWith(
      Object.fromEntries(["V1", "V4", "V6"].map((k) => [`${k}.Codeunit.al`, V[k] ?? ""] as const)),
    );
    const d = await discoverTests(dir, { buildSymbols: [] });
    expect(methods(d.unfiltered)).toEqual(["T10a", "T10b", "T4a", "T4b", "T6x", "T6y", "T6z"]);
    // V4's `[Test]` sits right before each arm's `procedure`, so the regex reads it (measured on
    // 61ad4d84, plan §1 did not say so) and the file never reaches the tree.
    expect(methods(d.splitTests)).toEqual(["T10a", "T10b", "T6x", "T6y", "T6z"]);
    expect(methods(d.treeOnlyTests)).toEqual(["T10a", "T10b", "T6x", "T6y", "T6z"]);
  });

  test("V4 in a file the tree reads: the tree holds the regex's T4a and T4b, each [Test] consumed", () => {
    const src = (V.V4 ?? "").replace(
      "    begin\n    end;\n}",
      "    begin\n    end;\n\n    [Test]\n#pragma warning disable AL0432\n    procedure Other()\n    begin\n    end;\n}",
    );
    const tree = treeTestsWithOffsets("V4.al", src);
    expect(tree.tests.map((t) => t.ref.method)).toEqual(["T4a", "T4b", "Other"]);
    expect(tree.warnings).toEqual([]);
    expect(methods(testsInAlSource("V4.al", src))).toEqual(["T4a", "T4b", "Other"]);
  });

  test("a split member in a codeunit that is not a test codeunit: no candidate, tokens consumed", () => {
    const src = (V.V1 ?? "").replace("    Subtype = Test;\n", "");
    expect(testsInAlSource("V1.al", src)).toEqual([]);
  });

  test("an undecided file keeps both arms, recorded as preproc-undecided-kept", async () => {
    // `||` is no alc operator: evaluateArms cannot decide the condition, and the tree has no error.
    const src = (V.V1 ?? "").replace("#if X\n", "#if X || Y\n");
    const dir = await testDirWith({ "V1.Codeunit.al": src });
    for (const symbols of [[], ["X"]]) {
      const d = await discoverTests(dir, { buildSymbols: symbols });
      expect(methods(d.filtered)).toEqual(["T10a", "T10b"]);
      expect(d.excluded.map((e) => [e.test.method, e.reason, e.detail])).toEqual([
        ["T10a", "preproc-undecided-kept", "unparsed-condition at line 6"],
        ["T10b", "preproc-undecided-kept", "unparsed-condition at line 6"],
      ]);
    }
  });

  test("a split test beside R402's s13 loop: the tree loses the loop's test, refused with both causes", () => {
    // An `#if` between `while (...)` and `do` is a construct tree-sitter-al 4.4.1 does not read as
    // a procedure; the split member puts the file on the tree path, which then refuses it. The same
    // file refused on 61ad4d84 too (the split member's token already forced the tree path).
    const src = (V.V1 ?? "").replace(
      "    begin\n    end;\n}",
      `    begin
    end;

    [Test]
    procedure Looping()
    var
        A: Integer;
        B: Integer;
    begin
#if X
        while (B < 5)
#else
        while (A < 10)
#endif
        do begin
            A := A + 1;
            B := B + 1;
        end;
    end;
}`,
    );
    let err: unknown;
    try {
      testsInAlSource("V1.al", src);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TreeDiscoveryMismatchError);
    expect((err as TreeDiscoveryMismatchError).missing).toEqual(["92461.Looping"]);
    expect((err as Error).message).toContain("tree-sitter-al");
  });

  test("TreeDiscoveryMismatchError names both causes", () => {
    const err = new TreeDiscoveryMismatchError("F.al", ["1.A"]);
    expect(err.message).toContain(
      "The file most likely holds a syntax error that makes the parser read those procedures as part of another one, or the file uses a construct the parser (tree-sitter-al) does not read correctly yet; please report the file.",
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// R403's compiled-membership check against the measured packages.
// ————————————————————————————————————————————————————————————————————————

const SYMBOL_REFERENCES = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "r420", "symbol-references.json"), "utf8"),
) as Record<string, unknown>;
function compiledOf(shape: string, build: Build) {
  const symbols = SYMBOL_REFERENCES[`${shape}-${build}`];
  if (symbols === undefined) throw new Error(`no measured symbols for ${shape}-${build}`);
  const membership = compiledMembershipOf(buildFakeApp(symbols));
  if (membership.kind !== "read") throw new Error(`unreadable fake package ${shape}-${build}`);
  return membership.tests;
}

describe("R424: compiled membership against the measured packages", () => {
  for (const shape of Object.keys(COMPILED)) {
    for (const published of ["none", "X", "Y"] as const) {
      for (const derived of ["none", "X", "Y"] as const) {
        const want = COMPILED[shape] ?? { none: "", X: "", Y: "" };
        const same = want[published] === want[derived];
        test(`${shape} published [${BUILDS[published].join(", ")}], derived [${BUILDS[derived].join(", ")}]: ${same ? "PASS" : "refused, naming each side"}`, () => {
          const filtered = armFilteredTestsInAlSource(
            `${shape}.al`,
            V[shape] ?? "",
            BUILDS[derived],
          );
          const compiled = compiledOf(shape, published);
          expect(compiled.map((t) => t.method)).toEqual([want[published]]);
          let err: unknown;
          try {
            assertTestMembership(compiled, { filtered, buildSymbols: BUILDS[derived] });
          } catch (e) {
            err = e;
          }
          if (same) {
            expect(err).toBeUndefined();
            return;
          }
          expect(err).toBeInstanceOf(TestAppDiffersError);
          expect((err as TestAppDiffersError).publishedOnly).toEqual([
            `${shape}.${want[published]}`,
          ]);
          expect((err as TestAppDiffersError).sourceOnly).toEqual([`${shape}.${want[derived]}`]);
        });
      }
    }
  }
});

// ————————————————————————————————————————————————————————————————————————
// Digests: they move only for tests that reach a split member.
// ————————————————————————————————————————————————————————————————————————

const DIGEST = `codeunit 92491 "R424 Digest"
{
    Subtype = Test;

    [Test]
#if X
    procedure T10a()
#else
    procedure T10b()
#endif
    begin
        Counter := 1;
    end;

    [Test]
    procedure Sibling()
    begin
        Counter := 2;
    end;

    [Test]
    procedure Caller()
    begin
        Help(1);
    end;

#if CLEAN25
    local procedure Help(A: Integer)
#else
    procedure Help(A: Integer)
#endif
    begin
        Counter := A;
    end;

    var
        Counter: Integer;
}
`;
const D_REF = (method: string) => ref(92491, "R424 Digest", method);
const INPUTS = { dependencies: "d", buildInputs: "b" };
const digestOf = (src: string, method: string): string | undefined =>
  testDigestsOfSources([{ path: "R424 Digest.al", text: src }], [D_REF(method)], INPUTS)[
    `92491::${method.toLowerCase()}`
  ];

describe("R424: digests", () => {
  test("the split test's digest moves on either arm's header and on the shared body", () => {
    for (const method of ["T10a", "T10b"]) {
      const before = digestOf(DIGEST, method);
      expect(before).toStartWith("v3:");
      const edits = [
        DIGEST.replace("    procedure T10a()", "    internal procedure T10a()"),
        DIGEST.replace("    procedure T10b()", "    internal procedure T10b()"),
        DIGEST.replace("Counter := 1;", "Counter := 3;"),
      ];
      for (const edited of edits) expect(digestOf(edited, method)).not.toBe(before);
    }
  });

  test("a sibling that does not reach the split members keeps its digest from 61ad4d84", () => {
    // Computed on 61ad4d84 (before R424) with the same inputs. R-385 moved the scheme tag from v2
    // to v3; the hash after the tag is unchanged.
    expect(digestOf(DIGEST, "Sibling")).toBe(
      "v3:f6f51d3e6cbe002b62c4c0c877312b717051ba3d8f864e5328e994a43d181453",
    );
  });

  test("the codeunit's parts hash is unchanged from 61ad4d84: split members stay in it", () => {
    expect(unitOf(DIGEST).partsHash).toBe(
      "17e9853cecc1f63a24412ca8ce4947b7fa74cc0454e2dfc8464c847bc9e949c2",
    );
  });

  test("a call to a split helper is a reach edge into every arm it can be", () => {
    expect(reached([{ path: "R424 Digest.al", text: DIGEST }], D_REF("Caller"))).toEqual([
      "92491:R424 Digest.Caller",
      "92491:R424 Digest.Help",
      "92491:R424 Digest.Help#1",
    ]);
  });

  test("a plain overload after a split member keeps its key and its test's digest from 61ad4d84", () => {
    const OVER = `codeunit 92492 "R424 Over"
{
    Subtype = Test;

    [Test]
    procedure UsesPlain()
    begin
        H();
    end;

#if CLEAN25
    local procedure H(A: Integer)
#else
    local procedure H(A: Integer; B: Integer)
#endif
    begin
        Counter := 1;
    end;

    local procedure H()
    begin
        Counter := 2;
    end;

    var
        Counter: Integer;
}
`;
    const t = ref(92492, "R424 Over", "UsesPlain");
    const files = [{ path: "R424 Over.al", text: OVER }];
    // Keys and digest computed on 61ad4d84, where the split header was not a member.
    expect(reached(files, t)).toEqual(["92492:R424 Over.H", "92492:R424 Over.UsesPlain"]);
    expect(testDigestsOfSources(files, [t], INPUTS)["92492::usesplain"]).toBe(
      // R-385: scheme tag v2 -> v3, the hash unchanged.
      "v3:fe7a88b4b2a85402b3a1e035d386e03fa3ca94f1a2ac3cf979efdb06140b32cc",
    );
    const keys = buildTestAppModel(files)
      .units.flatMap((u) => u.procs)
      .filter((p) => p.name === "h")
      .map((p) => `${p.params}=${p.key}`);
    expect(keys).toEqual(["1=92492:R424 Over.H#1", "2=92492:R424 Over.H#2", "0=92492:R424 Over.H"]);
  });

  test("the caller's digest moves with the helper's body through its own edge, not only the parts", () => {
    const edited = DIGEST.replace("Counter := A;", "Counter := A + 1;");
    const model = (src: string) => buildTestAppModel([{ path: "R424 Digest.al", text: src }]);
    const helpSpans = (src: string) =>
      model(src)
        .units.flatMap((u) => u.procs)
        .filter((p) => p.name === "help")
        .map((p) => p.spanHash);
    const [before] = helpSpans(DIGEST);
    // Without these, a model that reads no `Help` arm at all (61ad4d84: `[]`) passes the line below.
    expect(helpSpans(DIGEST).length).toBeGreaterThan(0);
    expect(helpSpans(edited).length).toBe(helpSpans(DIGEST).length);
    expect(helpSpans(edited)).not.toContain(before);
    expect(digestOf(edited, "Caller")).not.toBe(digestOf(DIGEST, "Caller"));
    // As before R424, the split member's text is in its codeunit's parts hash (plan r2 §3(a)), so
    // every test reaching that codeunit sees the edit too, coarsely.
    expect(digestOf(edited, "Sibling")).not.toBe(digestOf(DIGEST, "Sibling"));
  });
});

// ————————————————————————————————————————————————————————————————————————
// runSession and the resume fingerprint's `split-v1`.
// ————————————————————————————————————————————————————————————————————————

const PREDEFINED = [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort();
const base = (root: string) =>
  ({
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    backend: "al-runner",
    skipKnownSurvivors: false,
    identityScheme: IDENTITY_SCHEME,
    coverageMode: "procedure",
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    preprocessorSymbols: PREDEFINED,
  }) as const;

describe("R424: runSession", () => {
  test("S10 on al-runner: the active arm's test runs, split-v1 is set, no warning", async () => {
    const root = await project({ "V1.Codeunit.al": V.V1 ?? "" });
    const store = new ResultsStore(":memory:");
    const events: RunEvent[] = [];
    const backend = new StubBackend(false);
    await session(root, store, backend, { emit: [(e) => events.push(e)] });
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["PlainTest", "T10b"]);
    expect(
      events.filter((e) => e.type === "warning" && e.code === "test-shape-unsupported"),
    ).toEqual([]);
    expect(store.getRun(1)?.configFingerprint).toBe(
      sessionFingerprint({
        ...base(root),
        testBuildSymbols: PREDEFINED,
        testDiscovery: "arms-v1+tree-v1+split-v1",
      }),
    );
  });

  test("a project holding only a split HELPER does not set split-v1", async () => {
    const root = await project({ "HelperOpens.Codeunit.al": HELPER_OPENS });
    const store = new ResultsStore(":memory:");
    const backend = new StubBackend(false);
    await session(root, store, backend);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual([
      "OpensThroughHelper",
      "PlainTest",
    ]);
    expect(store.getRun(1)?.configFingerprint).toBe(
      sessionFingerprint({ ...base(root), testBuildSymbols: PREDEFINED }),
    );
  });

  test("testDiscoveryMarker returns each of the seven combinations, and nothing for none", () => {
    const got = [false, true].flatMap((arms) =>
      [false, true].flatMap((tree) =>
        [false, true].map((split) => testDiscoveryMarker(arms, tree, split).testDiscovery),
      ),
    );
    expect(got).toEqual([
      undefined,
      "split-v1",
      "tree-v1",
      "tree-v1+split-v1",
      "arms-v1",
      "arms-v1+split-v1",
      "arms-v1+tree-v1",
      "arms-v1+tree-v1+split-v1",
    ]);
    expect(testDiscoveryMarker(false, false, false)).toEqual({});
  });
});
