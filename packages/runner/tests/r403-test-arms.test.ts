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

  test("bcdev (phase A): the UNFILTERED suite runs, exactly as before R403", async () => {
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
