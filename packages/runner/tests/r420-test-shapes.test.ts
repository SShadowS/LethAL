import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
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
  TreeDiscoveryMismatchError,
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
import { removeScratchDirs } from "./helpers/scratch";

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
  // R420 review: an #if with no #else has an implicit empty arm, and through it the [Test] goes
  // to the next procedure (measured: Helper is the test under [], A under [X]).
  S12: `codeunit 92471 "S12"
{
    Subtype = Test;

    [Test]
#if X
    procedure A()
    begin
    end;
#endif
    procedure Helper()
    begin
    end;
}
`,
  // The same through #if/#elif with no #else (measured: Helper under [], A under [X], B under [Y]).
  S12b: `codeunit 92472 "S12b"
{
    Subtype = Test;

    [Test]
#if X
    procedure A()
    begin
    end;
#elif Y
    procedure B()
    begin
    end;
#endif
    procedure Helper()
    begin
    end;
}
`,
  // An explicit but EMPTY #else arm behaves as the implicit one (measured the same way: Helper
  // under [], A under [X]).
  S12c: `codeunit 92474 "S12c"
{
    Subtype = Test;

    [Test]
#if X
    procedure A()
    begin
    end;
#else
#endif
    procedure Helper()
    begin
    end;
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
  // R424: discovered since the split-header model landed.
  S10: { none: ["T10b"], X: ["T10a"] },
  S11: { none: ["B"], X: ["A", "OnlyX"] },
  S12: { none: ["Helper"], X: ["A"] },
  S12b: { none: ["Helper"], X: ["A"] },
  S12c: { none: ["Helper"], X: ["A"] },
};

const SYMBOL_REFERENCES = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "r420", "symbol-references.json"), "utf8"),
) as Record<string, unknown>;
function compiledOf(shape: string, build: "none" | "X" | "Y") {
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
afterEach(() => {
  removeScratchDirs(roots.splice(0));
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

  test("unfiltered (every arm) holds each shape's test", () => {
    for (const shape of Object.keys(EXPECTED)) {
      const all = methods(testsInAlSource(`${shape}.al`, SHAPES[shape] ?? ""));
      // S12b's `#elif Y` arm compiles B under [Y] only (measured), a build EXPECTED does not list.
      const otherBuilds = shape === "S12b" ? ["B"] : [];
      const want = [
        ...new Set([
          ...(EXPECTED[shape]?.none ?? []),
          ...(EXPECTED[shape]?.X ?? []),
          ...otherBuilds,
        ]),
      ];
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

  test("R424: S10 is discovered, one candidate per arm, with no test-shape-unsupported warning", async () => {
    const dir = await testDirWith({ "S10.Codeunit.al": SHAPES.S10 ?? "" });
    const d = await discoverTests(dir, { buildSymbols: [] });
    expect(methods(d.unfiltered)).toEqual(["T10a", "T10b"]);
    expect(d.warnings).toEqual([]);
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
      { codeunitId: 92454, codeunitName: "S4", method: "T4", file: "S4.Codeunit.al", line: 7 },
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

  test("S10's token is consumed by its split member, so it does not refuse", () => {
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

describe("R420 review fix 1: the tree path cannot silently lose a test", () => {
  // `Arr[Test]` puts the file on the tree path; the unclosed `begin` makes the parser read B and
  // C as part of A's body, where R79's body exemption used to excuse their tokens.
  const BROKEN = `codeunit 50100 "T"
{
    Subtype = Test;

    [Test]
    procedure A()
    var
        Arr: array[3] of Integer;
        Test: Integer;
    begin
        Arr[Test] := 1;
        if Test = 1 then begin
    end;

    [Test]
    procedure B()
    begin
    end;

    [Test]
    procedure C()
    begin
    end;
}
`;

  test("a test the regex found and the tree did not: refused, naming them", () => {
    let err: unknown;
    try {
      testsInAlSource("Broken.al", BROKEN);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TreeDiscoveryMismatchError);
    expect((err as TreeDiscoveryMismatchError).file).toBe("Broken.al");
    expect((err as TreeDiscoveryMismatchError).missing).toEqual(["50100.B", "50100.C"]);
  });

  test("a body token in an object with a parse error is not exempt", () => {
    // B is `internal`, so the regex never sees it and the regex-vs-tree check cannot name it:
    // only R79's token count can, and only when the body exemption does not excuse its token.
    // `Arr[Test]`'s token counts too: in an object that did not parse cleanly nothing is exempt.
    const src = BROKEN.replace("procedure B()", "internal procedure B()").replace(
      "    [Test]\n    procedure C()\n    begin\n    end;\n",
      "",
    );
    expect(() => testsInAlSource("Broken.al", src)).toThrow(
      /lost 2 of 3 \[Test\] procedures in "Broken\.al"/,
    );
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
  const COMPILED_SHAPES = [
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S8",
    "S9",
    "S10",
    "S11",
    "S12",
    "S12b",
  ];

  test("S12b published [Y], derived the same: PASS, and B is the test, not Helper", () => {
    const filtered = armFilteredTestsInAlSource("S12b.al", SHAPES.S12b ?? "", ["Y"]);
    expect(methods(filtered)).toEqual(["B"]);
    const compiled = compiledOf("S12b", "Y");
    expect(compiled.map((t) => t.method)).toEqual(["B"]);
    expect(() => assertTestMembership(compiled, { filtered, buildSymbols: ["Y"] })).not.toThrow();
  });

  test("S12 crossed: Helper is the test only in the build without X", () => {
    const filtered = armFilteredTestsInAlSource("S12.al", SHAPES.S12 ?? "", []);
    const err = (() => {
      try {
        assertTestMembership(compiledOf("S12", "X"), { filtered, buildSymbols: [] });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(TestAppDiffersError);
    expect((err as TestAppDiffersError).publishedOnly).toEqual(["S12.A"]);
    expect((err as TestAppDiffersError).sourceOnly).toEqual(["S12.Helper"]);
  });
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

  test("a published-only difference carries R420's added cause", () => {
    // Was pinned on S10 until R424 made it discoverable; S2 crossed is the same message path.
    const err = mismatch("S2", "X", "none");
    expect((err as Error).message).toEndWith(
      ", or LethAL did not recognise a test declaration in the source (please report the shape; see R420).",
    );
  });

  test("R424: S10 crossed, each side names its own arm's name", () => {
    const a = mismatch("S10", "X", "none") as TestAppDiffersError;
    expect(a.publishedOnly).toEqual(["S10.T10a"]);
    expect(a.sourceOnly).toEqual(["S10.T10b"]);
    const b = mismatch("S10", "none", "X") as TestAppDiffersError;
    expect(b.publishedOnly).toEqual(["S10.T10b"]);
    expect(b.sourceOnly).toEqual(["S10.T10a"]);
  });

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

  test("R424: S10 on bcdev, published [], derived []: T10b runs, no warning", async () => {
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
    await session(root, new ResultsStore(":memory:"), backend, {
      emit: [(e) => events.push(e)],
    });
    expect(events.some((e) => e.type === "warning" && e.code === "test-shape-unsupported")).toBe(
      false,
    );
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["PlainTest", "T10b"]);
  });
});
