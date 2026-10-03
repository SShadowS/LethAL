import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import * as discoveryModule from "../src/discovery";
import { type SessionConfig, runSession } from "../src/orchestrator";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
} from "../src/preprocessor-symbols";
import { sessionFingerprint } from "../src/resume";
import { ResultsStore } from "../src/store";
import {
  TestAppDiffersError,
  chooseTestSuite,
  compareTestMembership,
  compiledMembershipOf,
  noTestArmEvidence,
} from "../src/test-membership";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

/**
 * R403 phase A, through `runSession`: discovery evaluates the TEST app's `#if` arms under the test
 * app's derived symbol set (the config's symbols, the test `app.json`'s, al-runner's predefined
 * ones). On al-runner the filtered suite runs; on bcdev the unfiltered one, until phase B reads the
 * published package. The resume fingerprint carries the test set (plan §3(e)).
 */

const TARGET_AL = `codeunit 50013 "R403 Target"
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

const TEST_AL = `codeunit 50140 "R403 Tests"
{
    Subtype = Test;

#if LETHALX
    [Test]
    procedure OnlyUnderX()
    begin
    end;
#endif

    [Test]
    procedure PlainDoubles()
    begin
    end;
}
`;

class StubBackend implements ExecutionBackend {
  private active: string | null = null;
  /** Every method the baseline (no active mutant) asked for. */
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

beforeAll(async () => {
  await initParser();
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** A target `app/` and a test project `tests/`, each with its own `app.json` symbols. */
async function project(symbols: {
  readonly target?: readonly string[];
  readonly tests?: readonly string[];
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r403-"));
  roots.push(root);
  const appJson = (name: string, s: readonly string[] | undefined) =>
    JSON.stringify({
      id: "11111111-2222-3333-4444-555555555555",
      name,
      publisher: "x",
      version: "1.0.0.0",
      ...(s !== undefined ? { preprocessorSymbols: s } : {}),
    });
  await Bun.write(join(root, "app", "app.json"), appJson("p", symbols.target));
  await Bun.write(join(root, "app", "src", "Target.Codeunit.al"), TARGET_AL);
  await Bun.write(join(root, "tests", "app.json"), appJson("t", symbols.tests));
  await Bun.write(join(root, "tests", "R403.Codeunit.al"), TEST_AL);
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

describe("R403 phase A: runSession discovers the test app's build", () => {
  test("al-runner, no test symbols: OnlyUnderX is not run, and the baseline is green", async () => {
    const root = await project({});
    const backend = new StubBackend(false);
    await session(root, new ResultsStore(":memory:"), backend);
    expect([...new Set(backend.baselineMethods)]).toEqual(["PlainDoubles"]);
  });

  test("al-runner, LETHALX in the TEST app.json only: OnlyUnderX runs; the target's set is unchanged", async () => {
    const root = await project({ tests: ["LETHALX"] });
    const backend = new StubBackend(false);
    const store = new ResultsStore(":memory:");
    await session(root, store, backend);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["OnlyUnderX", "PlainDoubles"]);
    expect(store.getRun(1)?.buildSymbols).not.toContain("LETHALX");
  });

  test("al-runner, LETHALX in the TARGET app.json only: the test app's build does not define it", async () => {
    const root = await project({ target: ["LETHALX"] });
    const backend = new StubBackend(false);
    const store = new ResultsStore(":memory:");
    await session(root, store, backend);
    expect([...new Set(backend.baselineMethods)]).toEqual(["PlainDoubles"]);
    expect(store.getRun(1)?.buildSymbols).toContain("LETHALX");
  });

  test("al-runner, LETHALX in the config: both apps build it", async () => {
    const root = await project({});
    const backend = new StubBackend(false);
    await session(root, new ResultsStore(":memory:"), backend, {
      preprocessorSymbols: ["LETHALX"],
    });
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["OnlyUnderX", "PlainDoubles"]);
  });

  test("bcdev with no package read (no compiled evidence, phase B §3(c)): the UNFILTERED suite runs, exactly as before R403", async () => {
    const root = await project({});
    const backend = new StubBackend(true);
    await session(root, new ResultsStore(":memory:"), backend);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["OnlyUnderX", "PlainDoubles"]);
  });

  for (const authoritative of [false, true]) {
    test(`the parser is initialised BEFORE discovery (${authoritative ? "bcdev" : "al-runner"})`, async () => {
      const root = await project({ tests: ["LETHALX"] });
      const order: string[] = [];
      const realInit = engineModule.initParser;
      const realDiscover = discoveryModule.discoverTests;
      const init = spyOn(engineModule, "initParser").mockImplementation(() => {
        order.push("initParser");
        return realInit();
      });
      const discover = spyOn(discoveryModule, "discoverTests").mockImplementation(((
        d: string,
        o?: { readonly buildSymbols?: readonly string[] },
      ) => {
        order.push(`discoverTests:${JSON.stringify(o?.buildSymbols ?? null)}`);
        return (realDiscover as (d: string, o?: unknown) => Promise<unknown>)(d, o);
      }) as unknown as typeof realDiscover);
      try {
        await session(root, new ResultsStore(":memory:"), new StubBackend(authoritative));
      } finally {
        init.mockRestore();
        discover.mockRestore();
      }
      const at = order.findIndex((e) => e.startsWith("discoverTests:"));
      expect(at).toBeGreaterThan(0);
      expect(order.slice(0, at)).toContain("initParser");
      // The test app.json's LETHALX reaches discovery, on both backends.
      expect(order[at]).toContain('"LETHALX"');
    });
  }
});

describe("R403 phase A: the resume fingerprint carries the test app's set (plan §3(e))", () => {
  // The counterexample: the target's app.json defines X, so the TARGET set is {X} whether the
  // config says [] or [X]. The test app.json is empty, so the TEST set moves {} -> {X}, which
  // changes which tests a build has. Without `testBuildSymbols` the two fingerprints were equal.
  test("config [] -> [X] with X in the target app.json: the fingerprint differs and resume refuses", async () => {
    const root = await project({ target: ["X"] });
    const store = new ResultsStore(":memory:");
    await session(root, store, new StubBackend(true));
    await session(root, store, new StubBackend(true), { preprocessorSymbols: ["X"] });
    const first = store.getRun(1);
    const second = store.getRun(2);
    expect(first?.buildSymbols).toEqual(["X"]);
    expect(second?.buildSymbols).toEqual(["X"]);
    expect(first?.configFingerprint).not.toBe(second?.configFingerprint);

    await expect(
      session(root, store, new StubBackend(true), { preprocessorSymbols: ["X"], resume: 1 }),
    ).rejects.toThrow(/--resume-run 1 was scoped differently/);
  });

  // `testDiscovery: "arms-v1"` is in the digest only when the policy changed the suite this
  // session runs: on al-runner a compiled-out test does; on bcdev (phase A) nothing does.
  test("the arm-policy marker: present when al-runner excluded a test, absent on bcdev", async () => {
    // One project and one store per backend: a guarded run, then the guard removed, so only the
    // marker can separate the two digests.
    const pair = async (authoritative: boolean) => {
      const root = await project({});
      const store = new ResultsStore(":memory:");
      await session(root, store, new StubBackend(authoritative));
      await Bun.write(
        join(root, "tests", "R403.Codeunit.al"),
        TEST_AL.replace("#if LETHALX\n", "").replace("#endif\n", ""),
      );
      await session(root, store, new StubBackend(authoritative));
      const a = store.getRun(1)?.configFingerprint;
      const b = store.getRun(2)?.configFingerprint;
      expect(a).toBeString();
      expect(b).toBeString();
      return a === b;
    };
    expect(await pair(false)).toBe(false);
    expect(await pair(true)).toBe(true);
  });

  // With no directive line in any test file, no symbol set can change the suite, so an al-runner
  // session (whose set always holds CLEANSCHEMA1..25) keeps the digest it had before R403.
  test("al-runner, no directive in any test file: the pre-R403 fingerprint, byte for byte", async () => {
    const root = await project({});
    await Bun.write(
      join(root, "tests", "R403.Codeunit.al"),
      TEST_AL.replace("#if LETHALX\n", "").replace("#endif\n", ""),
    );
    const store = new ResultsStore(":memory:");
    await session(root, store, new StubBackend(false));
    const preR403 = sessionFingerprint({
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      backend: "al-runner",
      skipKnownSurvivors: false,
      identityScheme: IDENTITY_SCHEME,
      coverageMode: "procedure",
      selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
      preprocessorSymbols: [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort(),
    });
    expect(store.getRun(1)?.configFingerprint).toBe(preR403);
  });

  test("control: the same config resumes", async () => {
    const root = await project({ target: ["X"] });
    const store = new ResultsStore(":memory:");
    await session(root, store, new StubBackend(true));
    await session(root, store, new StubBackend(true), { resume: 1 });
  });
});

// ————————————————————————————————————————————————————————————————————————
// R403 phase B: bcdev reads the published package's COMPILED membership (SymbolReference.json),
// which lists only compiled-in methods, and runs the filtered suite only when it equals it.
// ————————————————————————————————————————————————————————————————————————

const TEST_SUBTYPE = [{ Name: "Subtype", Value: "Test" }];
interface CompiledCodeunit {
  readonly id: number;
  readonly name: string;
  readonly tests: readonly string[];
  /** false: a codeunit that is not `Subtype = Test`. */
  readonly testSubtype?: boolean;
  /** Further methods, as alc writes them (a handler, say). */
  readonly extra?: readonly unknown[];
}
const MANIFEST_XML = (version = "1.0.0.0") =>
  `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="11111111-2222-3333-4444-555555555555" Name="t" Publisher="x" Version="${version}" /></Package>`;
/** A test-app package at the test app.json's version, carrying both arms of the source (as alc's
 *  embedded source does, plan §1) and the given compiled membership. */
function compiledPkg(
  codeunits: readonly CompiledCodeunit[],
  symbolReference: "json" | "absent" | "corrupt" = "json",
): Buffer {
  const json = JSON.stringify({
    Codeunits: codeunits.map((cu) => ({
      Id: cu.id,
      Name: cu.name,
      ...(cu.testSubtype === false ? {} : { Properties: TEST_SUBTYPE }),
      Methods: [
        ...cu.tests.map((m, i) => ({ Id: i + 1, Name: m, Attributes: [{ Name: "Test" }] })),
        ...(cu.extra ?? []),
      ],
    })),
  });
  return buildFakeAppWithEntries({
    "NavxManifest.xml": MANIFEST_XML(),
    "src/R403.Codeunit.al": TEST_AL,
    ...(symbolReference === "json" ? { "SymbolReference.json": json } : {}),
    ...(symbolReference === "corrupt" ? { "SymbolReference.json": "{ not json" } : {}),
  });
}
const R403_CU = (tests: readonly string[]): CompiledCodeunit => ({
  id: 50140,
  name: "R403 Tests",
  tests,
});
/** The build alc makes with `[]`, and with `[LETHALX]` (measured, plan §1). */
const BUILT_NONE = [R403_CU(["PlainDoubles"])];
const BUILT_X = [R403_CU(["PlainDoubles", "OnlyUnderX"])];

/** A bcdev-shaped stub whose server holds `pkg` (`null`: the read failed). */
class PkgBackend extends StubBackend {
  /** Every app the session asked the server for (the test app, then R-371's dependency reads). */
  readonly fetched: string[] = [];
  constructor(private readonly pkg: Uint8Array | null) {
    super(true);
  }
  async fetchPublishedAppPackage(app: { readonly name: string }): Promise<Uint8Array | null> {
    this.fetched.push(app.name);
    return this.pkg;
  }
}

const DIFFERS_TAIL =
  "Possible causes: the test app was built with other preprocessor symbols (set preprocessorSymbols in the config or the test app.json), or a test was added, renamed or removed in the source without republishing.";

describe("R403 phase B: bcdev's compiled-membership check (plan §3(b))", () => {
  test("built [] and derived []: equal, so the FILTERED suite runs", async () => {
    const root = await project({});
    const backend = new PkgBackend(compiledPkg(BUILT_NONE));
    await session(root, new ResultsStore(":memory:"), backend);
    // ONE session-level read of the test app serves the membership check and R139's comparison;
    // the other is R192's per-batch baseline-snapshot key, unchanged.
    expect(backend.fetched.filter((n) => n === "t")).toEqual(["t", "t"]);
    expect([...new Set(backend.baselineMethods)]).toEqual(["PlainDoubles"]);
  });

  test("built [LETHALX], derived [], EQUAL versions: refused before the baseline, published-only named", async () => {
    const root = await project({});
    const backend = new PkgBackend(compiledPkg(BUILT_X));
    const err = await session(root, new ResultsStore(":memory:"), backend).catch((e) => e);
    expect(err).toBeInstanceOf(TestAppDiffersError);
    expect((err as TestAppDiffersError).code).toBe("test-app-differs");
    expect((err as Error).message).toBe(
      `the published test app's compiled tests differ from the tests LethAL discovered in the test source under symbols []: published-only R403 Tests.OnlyUnderX; source-only none. ${DIFFERS_TAIL}`,
    );
    expect(backend.baselineMethods).toEqual([]);
  });

  test("built [], derived [LETHALX] (test app.json), EQUAL versions: refused, source-only named", async () => {
    const root = await project({ tests: ["LETHALX"] });
    const backend = new PkgBackend(compiledPkg(BUILT_NONE));
    const err = await session(root, new ResultsStore(":memory:"), backend).catch((e) => e);
    expect(err).toBeInstanceOf(TestAppDiffersError);
    expect((err as Error).message).toBe(
      `the published test app's compiled tests differ from the tests LethAL discovered in the test source under symbols [LETHALX]: published-only none; source-only R403 Tests.OnlyUnderX. ${DIFFERS_TAIL}`,
    );
    expect(backend.baselineMethods).toEqual([]);
  });

  test("built [LETHALX], derived [LETHALX]: equal, both tests run", async () => {
    const root = await project({ tests: ["LETHALX"] });
    const backend = new PkgBackend(compiledPkg(BUILT_X));
    await session(root, new ResultsStore(":memory:"), backend);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["OnlyUnderX", "PlainDoubles"]);
  });

  test("a case-only name difference is the same test", async () => {
    const root = await project({});
    const backend = new PkgBackend(compiledPkg([R403_CU(["PLAINdoubles"])]));
    await session(root, new ResultsStore(":memory:"), backend);
    expect([...new Set(backend.baselineMethods)]).toEqual(["PlainDoubles"]);
  });

  test("a [Test] in a codeunit that is not Subtype = Test is ignored on both sides", async () => {
    const root = await project({});
    await Bun.write(
      join(root, "tests", "Helper.Codeunit.al"),
      `codeunit 50141 "R403 Helper"
{
    [Test]
    procedure LooksLikeTest()
    begin
    end;
}
`,
    );
    const backend = new PkgBackend(
      compiledPkg([
        ...BUILT_NONE,
        { id: 50141, name: "R403 Helper", tests: ["LooksLikeTest"], testSubtype: false },
      ]),
    );
    await session(root, new ResultsStore(":memory:"), backend);
    expect([...new Set(backend.baselineMethods)]).toEqual(["PlainDoubles"]);
  });

  test("a handler is not counted and the test it decorates is", async () => {
    const root = await project({});
    await Bun.write(
      join(root, "tests", "Handled.Codeunit.al"),
      `codeunit 50147 "R403 Handled"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('MsgH')]
    procedure Decorated()
    begin
        Message('x');
    end;

    [MessageHandler]
    procedure MsgH(M: Text[1024])
    begin
    end;
}
`,
    );
    const handled: CompiledCodeunit = {
      id: 50147,
      name: "R403 Handled",
      tests: [],
      extra: [
        {
          Id: 1,
          Name: "Decorated",
          Attributes: [
            { Name: "Test" },
            { Name: "HandlerFunctions", Arguments: [{ Value: "MsgH" }] },
          ],
        },
        { Id: 2, Name: "MsgH", Attributes: [{ Name: "MessageHandler" }] },
      ],
    };
    const backend = new PkgBackend(compiledPkg([...BUILT_NONE, handled]));
    await session(root, new ResultsStore(":memory:"), backend);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual(["Decorated", "PlainDoubles"]);
  });

  // Membership is counted BEFORE execution refusals: R-236c refuses to send a TestPage test, and
  // it is compared all the same.
  describe("a TestPage test is compared", () => {
    const PAGE_TESTS = `codeunit 50146 "R403 Page Tests"
{
    Subtype = Test;

    [Test]
    procedure OpensPage()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
}
`;
    test("compiled in: equal, and the scan still refuses to send it", async () => {
      const root = await project({});
      await Bun.write(join(root, "tests", "Page.Codeunit.al"), PAGE_TESTS);
      const pageCu = { id: 50146, name: "R403 Page Tests", tests: ["OpensPage"] };
      const backend = new PkgBackend(compiledPkg([...BUILT_NONE, pageCu]));
      await session(root, new ResultsStore(":memory:"), backend);
      expect([...new Set(backend.baselineMethods)]).toEqual(["PlainDoubles"]);
    });
    test("missing from the package: refused, source-only names it", async () => {
      const root = await project({});
      await Bun.write(join(root, "tests", "Page.Codeunit.al"), PAGE_TESTS);
      const err = await session(
        root,
        new ResultsStore(":memory:"),
        new PkgBackend(compiledPkg(BUILT_NONE)),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(TestAppDiffersError);
      expect((err as TestAppDiffersError).sourceOnly).toEqual(["R403 Page Tests.OpensPage"]);
    });
  });

  describe("--tests-only: compiled codeunits map to files through the UNFILTERED declarations", () => {
    const OTHER = `codeunit 50150 "Other Tests"
{
    Subtype = Test;

    [Test]
    procedure Elsewhere()
    begin
    end;
}
`;
    const OTHER_CU = { id: 50150, name: "Other Tests", tests: ["Elsewhere"] };
    const GHOST_CU = { id: 50160, name: "Ghost Tests", tests: ["Gone"] };

    test("a codeunit outside the scope is skipped, and so is one no admitted file declares", async () => {
      const root = await project({});
      await Bun.write(join(root, "tests", "Other.Codeunit.al"), OTHER);
      const backend = new PkgBackend(compiledPkg([...BUILT_NONE, OTHER_CU, GHOST_CU]));
      await session(root, new ResultsStore(":memory:"), backend, { testsOnly: ["R403*"] });
      expect([...new Set(backend.baselineMethods)]).toEqual(["PlainDoubles"]);
    });

    test("a compiled-only conditional test in an in-scope file is still compared", async () => {
      const root = await project({});
      await Bun.write(join(root, "tests", "Other.Codeunit.al"), OTHER);
      const err = await session(
        root,
        new ResultsStore(":memory:"),
        new PkgBackend(compiledPkg([...BUILT_X, OTHER_CU])),
        { testsOnly: ["R403*"] },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(TestAppDiffersError);
      expect((err as TestAppDiffersError).publishedOnly).toEqual(["R403 Tests.OnlyUnderX"]);
    });

    test("control: without --tests-only the undeclared compiled codeunit is published-only", async () => {
      const root = await project({});
      await Bun.write(join(root, "tests", "Other.Codeunit.al"), OTHER);
      const err = await session(
        root,
        new ResultsStore(":memory:"),
        new PkgBackend(compiledPkg([...BUILT_NONE, OTHER_CU, GHOST_CU])),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(TestAppDiffersError);
      expect((err as TestAppDiffersError).publishedOnly).toEqual(["Ghost Tests.Gone"]);
    });
  });

  // The resume marker follows the APPLIED policy: with compiled evidence bcdev runs the filtered
  // suite, so a compiled-out test now marks the digest, as it does on al-runner.
  test("the arm-policy marker is in the digest when bcdev applied the filter", async () => {
    const root = await project({});
    const store = new ResultsStore(":memory:");
    await session(root, store, new PkgBackend(compiledPkg(BUILT_NONE)));
    await session(root, store, new PkgBackend(compiledPkg(BUILT_NONE, "absent")));
    const base = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      backend: "bcdev",
      skipKnownSurvivors: false,
      identityScheme: IDENTITY_SCHEME,
      coverageMode: "procedure",
      selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    } as const;
    expect(store.getRun(1)?.configFingerprint).toBe(
      sessionFingerprint({ ...base, testDiscovery: "arms-v1" }),
    );
    expect(store.getRun(2)?.configFingerprint).toBe(sessionFingerprint(base));
  });
});

describe("R403 phase B: no compiled evidence keeps the UNFILTERED suite (plan §3(c))", () => {
  for (const [what, pkg] of [
    ["a package with no SymbolReference.json", compiledPkg(BUILT_NONE, "absent")],
    ["a package whose SymbolReference.json is not JSON", compiledPkg(BUILT_NONE, "corrupt")],
    ["a failed read", null],
  ] as const) {
    test(`${what}: both tests run, as before R403`, async () => {
      const root = await project({});
      const backend = new PkgBackend(pkg);
      await session(root, new ResultsStore(":memory:"), backend);
      expect([...new Set(backend.baselineMethods)].sort()).toEqual(["OnlyUnderX", "PlainDoubles"]);
    });
  }

  test("the record names the files with an #if around a [Test], and the choice keeps every test", () => {
    const discovery = {
      filtered: [{ codeunitId: 1, codeunitName: "C", method: "Kept" }],
      unfiltered: [
        { codeunitId: 1, codeunitName: "C", method: "Kept" },
        { codeunitId: 1, codeunitName: "C", method: "Dropped" },
      ],
      conditionalTestFiles: ["C.Codeunit.al"],
    };
    const evidence = noTestArmEvidence("the package carries no SymbolReference.json", discovery);
    expect(evidence).toEqual({
      kind: "none",
      why: "the package carries no SymbolReference.json",
      caveat: "test-symbols-unverified",
      files: ["C.Codeunit.al"],
    });
    const choice = chooseTestSuite(discovery, evidence);
    expect(choice.armPolicyApplied).toBe(false);
    expect(choice.tests.map((t) => t.method)).toEqual(["Kept", "Dropped"]);
    const compiled = chooseTestSuite(discovery, { kind: "compiled", from: "published-package" });
    expect(compiled.tests.map((t) => t.method)).toEqual(["Kept"]);
  });
});

describe("R403 phase B: compiledMembershipOf and compareTestMembership", () => {
  test("no evidence, never a throw, for a package it cannot read", () => {
    expect(compiledMembershipOf(compiledPkg(BUILT_NONE, "absent")).kind).toBe("none");
    expect(compiledMembershipOf(compiledPkg(BUILT_NONE, "corrupt")).kind).toBe("none");
    expect(compiledMembershipOf(new TextEncoder().encode("not a zip")).kind).toBe("none");
    expect(compiledMembershipOf(compiledPkg(BUILT_X))).toEqual({
      kind: "read",
      tests: [
        { codeunitId: 50140, codeunitName: "R403 Tests", method: "PlainDoubles" },
        { codeunitId: 50140, codeunitName: "R403 Tests", method: "OnlyUnderX" },
      ],
    });
  });

  test("both directions; the key is codeunit id plus the lower-cased method", () => {
    const compiled = [
      { codeunitId: 1, codeunitName: "A", method: "Same" },
      { codeunitId: 1, codeunitName: "A", method: "OnlyCompiled" },
      // Same method name, other codeunit: a different test.
      { codeunitId: 2, codeunitName: "B", method: "OnlySource" },
    ];
    const source = [
      { codeunitId: 1, codeunitName: "A", method: "SAME" },
      { codeunitId: 1, codeunitName: "A", method: "OnlySource" },
    ];
    expect(compareTestMembership(compiled, source)).toEqual({
      publishedOnly: ["A.OnlyCompiled", "B.OnlySource"],
      sourceOnly: ["A.OnlySource"],
    });
    expect(compareTestMembership(compiled, source, new Set([1]))).toEqual({
      publishedOnly: ["A.OnlyCompiled"],
      sourceOnly: ["A.OnlySource"],
    });
  });
});
