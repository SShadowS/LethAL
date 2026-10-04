import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as engineModule from "@lethal/engine";
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
  armFilteredTestsInAlSource,
  discoverTests,
  regexTestsWithOffsets,
  testsInAlSource,
  treeTestsWithOffsets,
} from "../src/discovery";
import type { RunEvent } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
} from "../src/preprocessor-symbols";
import { sessionFingerprint } from "../src/resume";
import { ResultsStore } from "../src/store";
import {
  TestAppDiffersError,
  assertTestMembership,
  compiledMembershipOf,
} from "../src/test-membership";
import { buildFakeApp, buildFakeAppWithEntries } from "./helpers/fake-app";

/**
 * R420: discovery found tests with one regular expression, so a `[Test]` whose declaration it
 * cannot read was dropped silently: an `#if`, `#pragma` or `#region` line between the attribute
 * and `procedure`, or an `internal` modifier. Each shape below was compiled by alc 18.0.41.45789
 * under `[]` and `[X]` (plan §1); `fixtures/r420/symbol-references.json` holds the compiled
 * packages' test methods, which are the truth these tests compare discovery against.
 */

const SHAPES: Record<string, string> = {
  S1: `codeunit 92451 "S1"
{
    Subtype = Test;

    [Test]
#if X
    [HandlerFunctions('MsgH')]
#endif
    procedure T1()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`,
  S2: `codeunit 92452 "S2"
{
    Subtype = Test;

#if X
    [Test]
#endif
    procedure T2()
    begin
    end;
}
`,
  S3: `codeunit 92453 "S3"
{
    Subtype = Test;

    [Test]
#if X
    [HandlerFunctions('MsgH')]
#else
    [HandlerFunctions('ConfirmYes')]
#endif
    procedure T3()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;

    [ConfirmHandler]
    procedure ConfirmYes(Question: Text[1024]; var Reply: Boolean)
    begin
        Reply := true;
    end;
}
`,
  S4: `codeunit 92454 "S4"
{
    Subtype = Test;

    [Test]
#pragma warning disable AL0432
    procedure T4()
    begin
    end;
#pragma warning restore AL0432
}
`,
  S5: `codeunit 92455 "S5"
{
    Subtype = Test;

    [Test]
#region R
    [HandlerFunctions('MsgH')]
#endregion
    procedure T5()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`,
  S6: `codeunit 92456 "S6"
{
    Subtype = Test;

    [Test]
    internal procedure T6()
    begin
    end;
}
`,
  S8: `codeunit 92458 "S8"
{
    Subtype = Test;

    [Test]
    // a comment line
    procedure T8()
    begin
    end;
}
`,
  S9: `codeunit 92459 "S9"
{
    Subtype = Test;

#if X
    [Test]
#else
    [Test]
    [HandlerFunctions('MsgH')]
#endif
    procedure T9()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`,
  S10: `codeunit 92460 "S10"
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
  S11: `codeunit 92470 "S11"
{
    Subtype = Test;

    [Test]
#if X
    procedure A()
    begin
    end;
#else
    procedure B()
    begin
    end;
#endif

#if X
    [Test]
    procedure OnlyX()
    begin
    end;
#endif
}
`,
};

/** alc rejects it (AL0104): not a test under any build. */
const S7 = `codeunit 92457 "S7"
{
    Subtype = Test;

    [Test, HandlerFunctions('MsgH')]
    procedure T7()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`;

/** The compiled test set per shape and build, from the measured packages (plan §1's table). */
const EXPECTED: Record<
  string,
  { readonly none: readonly string[]; readonly X: readonly string[] }
> = {
  S1: { none: ["T1"], X: ["T1"] },
  S2: { none: [], X: ["T2"] },
  S3: { none: ["T3"], X: ["T3"] },
  S4: { none: ["T4"], X: ["T4"] },
  S5: { none: ["T5"], X: ["T5"] },
  S6: { none: ["T6"], X: ["T6"] },
  S8: { none: ["T8"], X: ["T8"] },
  S9: { none: ["T9"], X: ["T9"] },
  S10: { none: [], X: [] },
  S11: { none: ["B"], X: ["A", "OnlyX"] },
};

const SYMBOL_REFERENCES = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "r420", "symbol-references.json"), "utf8"),
) as Record<string, unknown>;
function compiledOf(shape: string, build: "none" | "X") {
  const symbols = SYMBOL_REFERENCES[`${shape}-${build}`];
  if (symbols === undefined) throw new Error(`no measured symbols for ${shape}-${build}`);
  const membership = compiledMembershipOf(buildFakeApp(symbols));
  if (membership.kind !== "read") throw new Error(`unreadable fake package ${shape}-${build}`);
  return membership.tests;
}

const SETS = { none: [] as string[], X: ["X"] } as const;
const methods = (refs: readonly TestMethodRef[]) => refs.map((r) => r.method);

beforeAll(async () => {
  await initParser();
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function testDirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r420-"));
  roots.push(dir);
  for (const [name, text] of Object.entries(files)) await Bun.write(join(dir, name), text);
  return dir;
}

describe("R420: discovery against the compiler, per shape and build", () => {
  for (const [shape, expected] of Object.entries(EXPECTED)) {
    for (const build of ["none", "X"] as const) {
      test(`${shape} under [${SETS[build].join(", ")}]: exactly ${expected[build].join(", ") || "nothing"}`, async () => {
        const dir = await testDirWith({ [`${shape}.Codeunit.al`]: SHAPES[shape] ?? "" });
        const d = await discoverTests(dir, { buildSymbols: SETS[build] });
        expect(methods(d.filtered).sort()).toEqual([...expected[build]].sort());
      });
    }
  }

  test("unfiltered (every arm) holds each shape's test, S10's excepted", () => {
    for (const shape of Object.keys(EXPECTED)) {
      const all = methods(testsInAlSource(`${shape}.al`, SHAPES[shape] ?? ""));
      const want =
        shape === "S10"
          ? []
          : [...new Set([...(EXPECTED[shape]?.none ?? []), ...(EXPECTED[shape]?.X ?? [])])];
      expect(all.sort()).toEqual(want.sort());
    }
  });

  test("S7 is not a test, by either finder", () => {
    expect(testsInAlSource("S7.al", S7)).toEqual([]);
    expect(treeTestsWithOffsets("S7.al", S7).tests).toEqual([]);
  });

  test("an attribute named Test that carries a parse ERROR is not a test", () => {
    // `[Test, ]` and `[Test;]` parse with the attribute's own name `Test` beside an ERROR node.
    const src = `codeunit 92461 "Err"
{
    Subtype = Test;

    [Test, ]
    procedure A()
    begin
    end;

    [Test;]
    procedure D()
    begin
    end;

    [Test]
#pragma warning disable AL0432
    procedure Real()
    begin
    end;
}
`;
    // The #pragma shape puts the file on the tree path.
    expect(methods(testsInAlSource("Err.al", src))).toEqual(["Real"]);
  });

  test("S10 is not discovered, and the file gets a test-shape-unsupported warning naming both arms", async () => {
    const dir = await testDirWith({ "S10.Codeunit.al": SHAPES.S10 ?? "" });
    const d = await discoverTests(dir, { buildSymbols: [] });
    expect(d.unfiltered).toEqual([]);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]?.code).toBe("test-shape-unsupported");
    expect(d.warnings[0]?.file).toBe("S10.Codeunit.al");
    expect(d.warnings[0]?.message).toContain("T10a, T10b");
    expect(d.warnings[0]?.message).toContain("R424");
  });

  test("treeOnlyTests names what the regex missed, and nothing for a regex-read file", async () => {
    const dir = await testDirWith({
      "S4.Codeunit.al": SHAPES.S4 ?? "",
      "S8.Codeunit.al": SHAPES.S8 ?? "",
    });
    const d = await discoverTests(dir, { buildSymbols: [] });
    expect(methods(d.treeOnlyTests)).toEqual(["T4"]);
  });

  test("the old call shape returns the plain list, tree tests included", async () => {
    const dir = await testDirWith({ "S4.Codeunit.al": SHAPES.S4 ?? "" });
    const refs = await discoverTests(dir);
    expect(refs).toEqual([
      { codeunitId: 92454, codeunitName: "S4", method: "T4", file: "S4.Codeunit.al" },
    ]);
  });
});

describe("R420: R79's guard counts [Test] tokens on both paths", () => {
  test("regex path: a [Test] outside every codeunit refuses", () => {
    expect(() => testsInAlSource("Orphan.al", "[Test]\nprocedure Lost()\nbegin\nend;\n")).toThrow(
      /lost 1 of 1 \[Test\] procedures in "Orphan\.al"/,
    );
  });

  test("tree path: a [Test] outside every codeunit refuses", () => {
    // The #pragma line puts the file on the tree path; a regex-only count would see no test at
    // all here and stay silent.
    const src = `[Test]
#pragma warning disable AL0432
procedure Lost()
begin
end;

${SHAPES.S4}`;
    expect(() => testsInAlSource("Orphan.al", src)).toThrow(
      /lost 1 of 2 \[Test\] procedures in "Orphan\.al"/,
    );
  });

  test("S10's token is consumed by its warning, so it does not refuse", () => {
    expect(() => testsInAlSource("S10.al", SHAPES.S10 ?? "")).not.toThrow();
  });

  test("an array indexed by a variable named Test, inside a body, does not refuse", () => {
    const src = `codeunit 92462 "Idx"
{
    Subtype = Test;

    [Test]
    procedure Indexes()
    var
        Arr: array[3] of Integer;
        Test: Integer;
    begin
        Test := 1;
        Arr[Test] := 2;
    end;
}
`;
    expect(methods(testsInAlSource("Idx.al", src))).toEqual(["Indexes"]);
  });
});

// ————————————————————————————————————————————————————————————————————————
// The tree finder must equal the regex wherever the regex reads everything (plan r2 §6, review 3).
// The trigger never reaches the tree on these files, so this forces it on.
// ————————————————————————————————————————————————————————————————————————

const REPO = join(import.meta.dir, "..", "..", "..");
function alFilesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".alpackages") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) alFilesUnder(p, out);
    else if (name.toLowerCase().endsWith(".al")) out.push(p);
  }
  return out;
}
const CORPUS = ["fixtures", "examples"].flatMap((d) => alFilesUnder(join(REPO, d)));

describe("R420: tree = regex on every committed AL file", () => {
  test("every fixtures/* and examples/* file: id, codeunit name, method, offset, in order", () => {
    let compared = 0;
    let withTests = 0;
    for (const path of CORPUS) {
      const rel = relative(REPO, path);
      const src = readFileSync(path, "utf8");
      const regex = regexTestsWithOffsets(rel, src);
      const tree = treeTestsWithOffsets(rel, src);
      expect({ rel, tests: tree.tests }).toEqual({ rel, tests: regex });
      expect(tree.warnings).toEqual([]);
      compared += regex.length;
      if (regex.length > 0) withTests++;
    }
    // Not vacuous: the corpus holds the gates' suites.
    expect(CORPUS.length).toBeGreaterThan(50);
    expect(withTests).toBeGreaterThan(10);
    expect(compared).toBeGreaterThan(100);
  });

  const MADE_UP: Record<string, { readonly src: string; readonly methods: readonly string[] }> = {
    "quoted procedure and codeunit names": {
      src: `codeunit 92463 "My Suite"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('MsgH')]
    procedure "My Test"()
    begin
    end;

    [Test]
    procedure Plain()
    begin
    end;

    [MessageHandler]
    procedure MsgH(M: Text[1024])
    begin
    end;
}
`,
      methods: ["My Test", "Plain"],
    },
    "Subtype = Test inside #if": {
      src: `codeunit 92464 Conditional
{
#if X
    Subtype = Test;
#endif

    [Test]
    procedure Inside()
    begin
    end;
}
`,
      methods: ["Inside"],
    },
    "a codeunit inside preproc_conditional_object": {
      src: `#if Y
codeunit 92465 "Wrapped"
{
    Subtype = Test;

    [Test]
    procedure WrappedTest()
    begin
    end;
}
#endif
`,
      methods: ["WrappedTest"],
    },
  };
  for (const [what, { src, methods: want }] of Object.entries(MADE_UP)) {
    test(`${what}: tree = regex, and both find the test`, () => {
      const regex = regexTestsWithOffsets("M.al", src);
      expect(regex.map((t) => t.ref.method)).toEqual([...want]);
      expect(treeTestsWithOffsets("M.al", src).tests).toEqual(regex);
    });
  }
});

describe("R420: the fast path adds no parse", () => {
  test("every committed file keeps the regex path (parse counter)", () => {
    const parse = spyOn(engineModule, "parseAL");
    try {
      for (const path of CORPUS) {
        testsInAlSource(relative(REPO, path), readFileSync(path, "utf8"));
      }
      expect(parse).toHaveBeenCalledTimes(0);
      // Control: a shape the regex cannot read does parse.
      testsInAlSource("S4.al", SHAPES.S4 ?? "");
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  test("a tree-path file with an #if is parsed once, not again by the arm filter", async () => {
    const dir = await testDirWith({ "S2.Codeunit.al": SHAPES.S2 ?? "" });
    const parse = spyOn(engineModule, "parseAL");
    try {
      await discoverTests(dir, { buildSymbols: ["X"] });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });
});

describe("R420: R403's compiled-membership check against the measured packages", () => {
  const COMPILED_SHAPES = ["S1", "S2", "S3", "S4", "S5", "S6", "S8", "S9", "S11"];
  for (const shape of COMPILED_SHAPES) {
    for (const build of ["none", "X"] as const) {
      test(`${shape} published [${SETS[build].join(", ")}], derived the same: PASS`, () => {
        const filtered = armFilteredTestsInAlSource(
          `${shape}.al`,
          SHAPES[shape] ?? "",
          SETS[build],
        );
        const compiled = compiledOf(shape, build);
        expect(compiled.map((t) => t.method).sort()).toEqual(methods(filtered).sort());
        expect(() =>
          assertTestMembership(compiled, { filtered, buildSymbols: SETS[build] }),
        ).not.toThrow();
      });
    }
  }

  const mismatch = (shape: string, published: "none" | "X", derived: "none" | "X") => {
    const filtered = armFilteredTestsInAlSource(`${shape}.al`, SHAPES[shape] ?? "", SETS[derived]);
    try {
      assertTestMembership(compiledOf(shape, published), { filtered, buildSymbols: SETS[derived] });
    } catch (e) {
      return e;
    }
    return undefined;
  };

  test("S2 published [X], derived []: refused, T2 is PUBLISHED-only", () => {
    const err = mismatch("S2", "X", "none");
    expect(err).toBeInstanceOf(TestAppDiffersError);
    expect((err as TestAppDiffersError).publishedOnly).toEqual(["S2.T2"]);
    expect((err as TestAppDiffersError).sourceOnly).toEqual([]);
  });

  test("S2 published [], derived [X]: refused, T2 is SOURCE-only", () => {
    const err = mismatch("S2", "none", "X");
    expect(err).toBeInstanceOf(TestAppDiffersError);
    expect((err as TestAppDiffersError).publishedOnly).toEqual([]);
    expect((err as TestAppDiffersError).sourceOnly).toEqual(["S2.T2"]);
  });

  test("S9 crossed both ways: T9 is in both builds, so both pass", () => {
    expect(mismatch("S9", "X", "none")).toBeUndefined();
    expect(mismatch("S9", "none", "X")).toBeUndefined();
  });

  test("S11 crossed: each side names its own arm's procedures", () => {
    const a = mismatch("S11", "X", "none") as TestAppDiffersError;
    expect(a.publishedOnly).toEqual(["S11.A", "S11.OnlyX"]);
    expect(a.sourceOnly).toEqual(["S11.B"]);
    const b = mismatch("S11", "none", "X") as TestAppDiffersError;
    expect(b.publishedOnly).toEqual(["S11.B"]);
    expect(b.sourceOnly).toEqual(["S11.A", "S11.OnlyX"]);
  });

  for (const [build, name] of [
    ["none", "T10b"],
    ["X", "T10a"],
  ] as const) {
    test(`S10 published [${SETS[build].join(", ")}]: published-only ${name}, with R420's added cause`, () => {
      const err = mismatch("S10", build, build);
      expect(err).toBeInstanceOf(TestAppDiffersError);
      expect((err as TestAppDiffersError).publishedOnly).toEqual([`S10.${name}`]);
      expect((err as Error).message).toEndWith(
        ", or LethAL did not recognise a test declaration in the source (please report the shape; see R420).",
      );
    });
  }

  test("a source-only difference does not carry the unrecognised-declaration cause", () => {
    const err = mismatch("S2", "none", "X");
    expect((err as Error).message).not.toContain("did not recognise");
  });
});

// ————————————————————————————————————————————————————————————————————————
// Through runSession: the warning, and the resume fingerprint's `testDiscovery` marker.
// ————————————————————————————————————————————————————————————————————————

const TARGET_AL = `codeunit 50013 "R420 Target"
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
/** A test the regex reads, so a session whose shape compiles out still has a suite. */
const PLAIN_AL = `codeunit 92480 "R420 Plain"
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

/** A bcdev-shaped stub whose server holds `pkg`. */
class PkgBackend extends StubBackend {
  constructor(private readonly pkg: Uint8Array) {
    super(true);
  }
  async fetchPublishedAppPackage(): Promise<Uint8Array> {
    return this.pkg;
  }
}

async function project(shape: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r420-run-"));
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
  await Bun.write(join(root, "tests", `${shape}.Codeunit.al`), SHAPES[shape] ?? "");
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

const PREDEFINED = [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort();
const base = (root: string, backend: "al-runner" | "bcdev") =>
  ({
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    backend,
    skipKnownSurvivors: false,
    identityScheme: IDENTITY_SCHEME,
    coverageMode: "procedure",
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    ...(backend === "al-runner" ? { preprocessorSymbols: PREDEFINED } : {}),
  }) as const;

describe("R420: runSession", () => {
  test("S4 on al-runner: T4 runs, and the fingerprint carries tree-v1", async () => {
    const root = await project("S4");
    const store = new ResultsStore(":memory:");
    const backend = new StubBackend(false);
    await session(root, store, backend);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["PlainTest", "T4"]);
    expect(store.getRun(1)?.configFingerprint).toBe(
      sessionFingerprint({ ...base(root, "al-runner"), testDiscovery: "tree-v1" }),
    );
  });

  test("S4 on bcdev with no compiled evidence: T4 runs, and the fingerprint carries tree-v1", async () => {
    const root = await project("S4");
    const store = new ResultsStore(":memory:");
    const backend = new StubBackend(true);
    await session(root, store, backend);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["PlainTest", "T4"]);
    expect(store.getRun(1)?.configFingerprint).toBe(
      sessionFingerprint({ ...base(root, "bcdev"), testDiscovery: "tree-v1" }),
    );
  });

  test("S2 on al-runner: compiled out AND tree-found, so arms-v1+tree-v1", async () => {
    const root = await project("S2");
    const store = new ResultsStore(":memory:");
    const backend = new StubBackend(false);
    await session(root, store, backend);
    expect([...new Set(backend.baselineMethods)]).toEqual(["PlainTest"]);
    expect(store.getRun(1)?.configFingerprint).toBe(
      sessionFingerprint({
        ...base(root, "al-runner"),
        testBuildSymbols: PREDEFINED,
        testDiscovery: "arms-v1+tree-v1",
      }),
    );
  });

  test("a project the regex reads in full keeps its fingerprint byte for byte", async () => {
    for (const [authoritative, name] of [
      [false, "al-runner"],
      [true, "bcdev"],
    ] as const) {
      const root = await project("S8");
      const store = new ResultsStore(":memory:");
      await session(root, store, new StubBackend(authoritative));
      expect(store.getRun(1)?.configFingerprint).toBe(sessionFingerprint(base(root, name)));
    }
  });

  test("S10 on al-runner: the test-shape-unsupported warning reaches the event stream", async () => {
    const root = await project("S10");
    const events: RunEvent[] = [];
    await session(root, new ResultsStore(":memory:"), new StubBackend(false), {
      emit: [(e) => events.push(e)],
    });
    const warned = events.filter(
      (e) => e.type === "warning" && e.code === "test-shape-unsupported",
    );
    expect(warned).toHaveLength(1);
    expect(warned[0] && "message" in warned[0] ? warned[0].message : "").toContain("T10a, T10b");
  });

  test("S10 on bcdev, published []: warned first, then refused with T10b published-only", async () => {
    const root = await project("S10");
    const s10 = SYMBOL_REFERENCES["S10-none"] as { readonly Codeunits: readonly unknown[] };
    const plain = {
      Id: 92480,
      Name: "R420 Plain",
      Properties: [{ Name: "Subtype", Value: "Test" }],
      Methods: [{ Id: 1, Name: "PlainTest", Attributes: [{ Name: "Test" }] }],
    };
    const pkg = buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="11111111-2222-3333-4444-555555555555" Name="t" Publisher="x" Version="1.0.0.0" /></Package>`,
      "src/Plain.Codeunit.al": PLAIN_AL,
      "src/S10.Codeunit.al": SHAPES.S10 ?? "",
      "SymbolReference.json": JSON.stringify({ Codeunits: [...s10.Codeunits, plain] }),
    });
    const events: RunEvent[] = [];
    const backend = new PkgBackend(pkg);
    const err = await session(root, new ResultsStore(":memory:"), backend, {
      emit: [(e) => events.push(e)],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TestAppDiffersError);
    expect((err as TestAppDiffersError).publishedOnly).toEqual(["S10.T10b"]);
    expect(events.some((e) => e.type === "warning" && e.code === "test-shape-unsupported")).toBe(
      true,
    );
    expect(backend.baselineMethods).toEqual([]);
  });
});
