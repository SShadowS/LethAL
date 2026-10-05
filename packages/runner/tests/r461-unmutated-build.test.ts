import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AlcCompileError, ArtifactCompiler, UnmutatedBuildFailedError } from "../src/artifact";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { refusalLine } from "../src/cli";
import { firstCallOnly, runSession } from "../src/orchestrator";
import { StaleTestAppError, TestAppChangedError } from "../src/stale-test-app";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/**
 * R461: a target whose UNMUTATED build alc rejects. Before, the batch's instrumented compile failed,
 * bisection found every subset failing, and every mutant was recorded `error` under a note that
 * named "environmental" or "MORE THAN ONE mutant". Now the first compile failure of a session asks
 * once whether LethAL's staged copy of the unmutated target compiles, and refuses if it does not.
 *
 * Every compile here goes through a REAL `ArtifactCompiler` with only the alc spawn faked, so the
 * messages the notes and the refusal carry are the production formatter's, not hand-built ones.
 */

const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91",
  name: "Sandbox R461 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;

const SECOND_AL = `codeunit 79002 "Sandbox Extra"
{
    procedure UnderLimit(Amount: Decimal; Limit: Decimal): Boolean
    begin
        exit(Amount < Limit);
    end;
}
`;

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject(opts: { secondFile?: boolean } = {}) {
  const root = scratch("lethal-r461-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  if (opts.secondFile === true) {
    await Bun.write(join(projectDir, "SandboxExtra.Codeunit.al"), SECOND_AL);
  }
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  return { root, projectDir, testDir, instrumentedDir };
}

type AlcAnswer = { exitCode: number; stdout: string; stderr: string };
const OK: AlcAnswer = { exitCode: 0, stdout: "", stderr: "" };

interface Manifest {
  mutants: Array<{ operatorName: string; codeunitName: string }>;
}

/**
 * Counters kept APART: `deploys` and `checks` are instrumented compiles (the batch's own, and
 * bisection's candidates), `plainCompiles` is the R461 check alone. Each alc answer is decided by
 * the dir alc is pointed at: an instrumented dir carries `mutant-manifest.json`, a plain one does not.
 */
class R461Backend implements ExecutionBackend {
  deploys = 0;
  checks = 0;
  plainCompiles = 0;
  /** What each plain compile saw: the dir's file names and the `.al` text, for layout checks. */
  plainSeen: Array<{ files: string[]; al: string }> = [];
  private activations: Array<string | null> = [];
  private readonly compiler: ArtifactCompiler;

  constructor(
    outputDir: string,
    private readonly instrumented: (manifest: Manifest) => AlcAnswer,
    private readonly plain: () => AlcAnswer,
    private readonly hooks: {
      readonly onInstrumentedFailure?: () => Promise<void>;
      readonly check?: (dir: string) => Promise<void>;
      /** Runs after a deploy's compile succeeded, with the 1-based deploy number; throw = publish failed. */
      readonly publish?: (deploy: number) => void;
    } = {},
  ) {
    this.compiler = new ArtifactCompiler(
      { alcPath: "C:/fake/alc.exe", packageCachePath: "C:/fake/.alpackages", outputDir },
      {
        spawn: async (argv) => {
          const projectDir = argv.find((a) => a.startsWith("/project:"))?.slice(9) ?? "";
          const files = await readdir(projectDir);
          return files.includes("mutant-manifest.json")
            ? this.instrumented(
                JSON.parse(await readFile(join(projectDir, "mutant-manifest.json"), "utf8")),
              )
            : this.plain();
        },
        readArtifact: async () => new Uint8Array([1, 2, 3]),
        writeArtifact: async () => {},
      },
    );
  }

  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "r461" };
  }
  private async compile(dir: string): Promise<void> {
    await this.compiler.compileProject({ projectDir: dir, packageCachePath: "C:/p", name: "x" });
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    this.deploys++;
    try {
      await this.compile(dir);
    } catch (err) {
      await this.hooks.onInstrumentedFailure?.();
      throw err;
    }
    this.hooks.publish?.(this.deploys);
    return null;
  }
  async compileCheck(dir: string): Promise<void> {
    this.checks++;
    if (this.hooks.check !== undefined) return this.hooks.check(dir);
    await this.compile(dir);
  }
  async compilePlainCheck(dir: string): Promise<void> {
    this.plainCompiles++;
    const files = (await readdir(dir)).sort();
    const al = await readFile(join(dir, "SandboxLogic.Codeunit.al"), "utf8").catch(() => "");
    this.plainSeen.push({ files, al });
    await this.compile(dir);
  }
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [
                { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" },
                { objectType: "Codeunit", objectId: 79002, procedure: "UnderLimit" },
              ],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

const FAIL_STDOUT: AlcAnswer = {
  exitCode: 1,
  stdout: "SandboxLogic.Codeunit.al(5,9): error AL0118: The name 'Amont' does not exist",
  stderr: "warning AL0432: Method 'X' is marked for removal",
};

const hasBoundary = (m: Manifest) =>
  m.mutants.some((x) => x.operatorName === "lethal.conditional-boundary");

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("R461: the unmutated build is compiled once, at the first compile failure", () => {
  test("1: the plain build fails too -> UnmutatedBuildFailedError with both streams, no rows, no bisection", async () => {
    const dirs = await makeProject();
    const backend = new R461Backend(
      dirs.root,
      () => ({ exitCode: 1, stdout: "error AL0001: x", stderr: "" }),
      () => FAIL_STDOUT,
    );
    const store = new ResultsStore(":memory:");
    const err = await settle(runSession({ backend, store, ...dirs, selectorIds }));
    expect(err).toBeInstanceOf(UnmutatedBuildFailedError);
    const message = (err as Error).message;
    expect(message).toContain("alc rejected LethAL's staged copy of the unmutated target");
    expect(message).toContain(`stdout:\n${FAIL_STDOUT.stdout}`);
    expect(message).toContain(`stderr:\n${FAIL_STDOUT.stderr}`);
    expect(store.mutantVerdicts(1).filter((r) => r.verdict === "error")).toEqual([]);
    expect(backend.deploys + backend.checks).toBe(1);
    expect(backend.plainCompiles).toBe(1);
    expect(store.getRun(1)?.finished).toBe(false);
    store.close();
  });

  test("a plain compiler crash or missing package is an observed unmutated-build failure, with no source-broken remedy", async () => {
    for (const plain of [
      {
        exitCode: -532462766,
        stdout: "",
        stderr: "Unhandled exception. System.NullReferenceException",
      },
      {
        exitCode: 1,
        stdout:
          "app.json(1,1): error AL1022: A package with publisher 'Microsoft', name 'Base Application' could not be found",
        stderr: "",
      },
    ]) {
      const dirs = await makeProject();
      const backend = new R461Backend(
        dirs.root,
        () => FAIL_STDOUT,
        () => plain,
      );
      const store = new ResultsStore(":memory:");
      const err = await settle(runSession({ backend, store, ...dirs, selectorIds }));
      expect(err).toBeInstanceOf(UnmutatedBuildFailedError);
      const message = (err as Error).message;
      expect(message).toContain(plain.stdout);
      expect(message).toContain(plain.stderr);
      expect(message).not.toMatch(/fix your source|source is broken|environmental/i);
      store.close();
    }
  });

  test("2: the plain build compiles -> bisection as before; the plain dir is the unmutated source alone", async () => {
    const dirs = await makeProject();
    const backend = new R461Backend(
      dirs.root,
      (m) => (hasBoundary(m) ? FAIL_STDOUT : OK),
      () => OK,
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    expect(backend.plainCompiles).toBe(1);
    // No selector, no install/upgrade codeunit, no manifest, and the .al byte-identical to the source.
    expect(backend.plainSeen[0]?.files).toEqual(["SandboxLogic.Codeunit.al", "app.json"]);
    expect(backend.plainSeen[0]?.al).toBe(TARGET_AL);
    store.close();
  });

  test("a real formatter's both streams reach the bisection note", async () => {
    const dirs = await makeProject();
    const backend = new R461Backend(
      dirs.root,
      () => FAIL_STDOUT,
      () => OK,
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted?.failureNote).toContain("not attributable to any SINGLE mutant");
    expect(noted?.failureNote).toContain(`stdout:\n${FAIL_STDOUT.stdout}`);
    expect(noted?.failureNote).toContain(`stderr:\n${FAIL_STDOUT.stderr}`);
    store.close();
  });

  test("alc's stdout cannot trigger a version-conflict retry", async () => {
    const dirs = await makeProject();
    const backend = new R461Backend(
      dirs.root,
      () => ({
        exitCode: 1,
        stdout: "error: a newer version 9.9.9.9 was already installed",
        stderr: "warning AL0432: x",
      }),
      () => OK,
    );
    const store = new ResultsStore(":memory:");
    await settle(runSession({ backend, store, ...dirs, selectorIds }));
    expect(backend.deploys).toBe(1);
    store.close();
  });

  const CONFLICT = "Publishing failed: a newer version 9.9.9.9 was already installed.";

  test("a real publish conflict still retries once and then fails loudly", async () => {
    const dirs = await makeProject();
    const backend = new R461Backend(
      dirs.root,
      () => OK,
      () => OK,
      {
        publish: () => {
          throw new Error(CONFLICT);
        },
      },
    );
    const store = new ResultsStore(":memory:");
    const err = await settle(runSession({ backend, store, ...dirs, selectorIds }));
    expect(backend.deploys).toBe(2);
    expect((err as Error).message).toContain("version conflict persisted after retry");
    store.close();
  });

  test("a real conflict, then an alc rejection quoting the conflict phrase, reaches the plain check", async () => {
    const dirs = await makeProject();
    // Deploy 1 compiles and its publish conflicts; deploy 2 (the retry) is rejected by alc.
    const backend: R461Backend = new R461Backend(
      dirs.root,
      () => (backend.deploys < 2 ? OK : { exitCode: 1, stdout: CONFLICT, stderr: "" }),
      () => OK,
      {
        publish: (n) => {
          if (n === 1) throw new Error(CONFLICT);
        },
      },
    );
    const store = new ResultsStore(":memory:");
    const err = await settle(runSession({ backend, store, ...dirs, selectorIds }));
    expect((err as Error | undefined)?.message ?? "").not.toContain("version conflict persisted");
    expect(backend.deploys).toBe(2);
    expect(backend.plainCompiles).toBe(1);
    store.close();
  });

  test("4: a plain preparation failure propagates as itself: not wrapped, no rows", async () => {
    const dirs = await makeProject();
    // Removing the project dir after the batch was built makes `prepareBatchProject`'s read of it
    // fail. Portable, unlike a read-only scratch dir (Windows ignores a directory's mode).
    const backend = new R461Backend(
      dirs.root,
      () => FAIL_STDOUT,
      () => OK,
      {
        onInstrumentedFailure: () => rm(dirs.projectDir, { recursive: true, force: true }),
      },
    );
    const store = new ResultsStore(":memory:");
    const err = await settle(runSession({ backend, store, ...dirs, selectorIds }));
    expect((err as { code?: string }).code).toBe("ENOENT");
    expect((err as Error).name).toBe("Error");
    expect(backend.plainCompiles).toBe(0);
    expect(backend.checks).toBe(0);
    expect(store.mutantVerdicts(1)).toEqual([]);
    store.close();
  });

  test("5: a leftover file in a reused plain scratch dir is not in the plain build", async () => {
    const dirs = await makeProject();
    const stale = join(dirs.instrumentedDir, "run-1-plain");
    await mkdir(stale, { recursive: true });
    await Bun.write(join(stale, "MutationSelector.Codeunit.al"), "codeunit 50000 Leftover {}");
    const backend = new R461Backend(
      dirs.root,
      () => FAIL_STDOUT,
      () => OK,
    );
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.plainSeen[0]?.files).toEqual(["SandboxLogic.Codeunit.al", "app.json"]);
    store.close();
  });

  test("6: two failing batches whose plain build compiles -> one plain compile", async () => {
    const dirs = await makeProject({ secondFile: true });
    const backend = new R461Backend(
      dirs.root,
      (m) => (hasBoundary(m) ? FAIL_STDOUT : OK),
      () => OK,
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds, maxGuardsPerBatch: 1 });
    expect(report.batches).toBe(2);
    expect(backend.deploys).toBe(2);
    expect(backend.plainCompiles).toBe(1);
    store.close();
  });

  test("7: after a failure, a concurrent and a later call get the same error, one start", async () => {
    let starts = 0;
    const failure = new UnmutatedBuildFailedError(new AlcCompileError("alc compile failed"));
    const once = firstCallOnly(async () => {
      starts++;
      throw failure;
    });
    const [a, b] = await Promise.all([settle(once(undefined)), settle(once(undefined))]);
    const c = await settle(once(undefined));
    expect(starts).toBe(1);
    expect(a).toBe(failure);
    expect(b).toBe(failure);
    expect(c).toBe(failure);
  });

  test("8: a healthy run never compiles the plain build", async () => {
    const dirs = await makeProject();
    const backend = new R461Backend(
      dirs.root,
      () => OK,
      () => OK,
    );
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.plainCompiles).toBe(0);
    store.close();
  });

  // Batches are ordered by file name, so SandboxExtra is batch 0 and SandboxLogic batch 1.
  const batch1Fails = (m: Manifest) =>
    m.mutants.some((x) => x.codeunitName === "Sandbox Logic") ? FAIL_STDOUT : OK;

  test("9: --resume carries batch 0, retries batch 1, refuses again; no batch-1 rows either run", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const first = new R461Backend(dirs.root, batch1Fails, () => FAIL_STDOUT);
    const err1 = await settle(
      runSession({ backend: first, store, ...dirs, selectorIds, maxGuardsPerBatch: 1 }),
    );
    expect(err1).toBeInstanceOf(UnmutatedBuildFailedError);
    const run1 = store.mutantVerdicts(1);
    expect(run1.length).toBeGreaterThan(0);
    expect(run1.every((r) => r.codeunitName === "Sandbox Extra")).toBe(true);
    expect(run1.some((r) => r.verdict === "error")).toBe(false);

    const second = new R461Backend(dirs.root, batch1Fails, () => FAIL_STDOUT);
    const err2 = await settle(
      runSession({
        backend: second,
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch: 1,
        resume: "last",
      }),
    );
    expect(err2).toBeInstanceOf(UnmutatedBuildFailedError);
    // Batch 0 carried without a deploy; batch 1 retried and refused again.
    expect(second.deploys).toBe(1);
    expect(second.plainCompiles).toBe(1);
    const run2 = store.mutantVerdicts(2);
    expect(run2.map((r) => r.verdict).sort()).toEqual(run1.map((r) => r.verdict).sort());
    expect(run2.every((r) => r.codeunitName === "Sandbox Extra")).toBe(true);
    store.close();
  });

  test("10: a refused run is not history: a later run skips none of its survivors", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const refused = new R461Backend(dirs.root, batch1Fails, () => FAIL_STDOUT);
    await settle(
      runSession({ backend: refused, store, ...dirs, selectorIds, maxGuardsPerBatch: 1 }),
    );
    expect(store.mutantVerdicts(1).some((r) => r.verdict === "survived")).toBe(true);

    const healthy = new R461Backend(
      dirs.root,
      () => OK,
      () => OK,
    );
    const report = await runSession({
      backend: healthy,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      skipKnownSurvivors: true,
    });
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    store.close();
  });

  test("bisection ABORTS on UnmutatedBuildFailedError; it is never read as 'subset does not compile'", async () => {
    const dirs = await makeProject();
    const thrown = new UnmutatedBuildFailedError(new AlcCompileError("alc compile failed"));
    const backend = new R461Backend(
      dirs.root,
      () => FAIL_STDOUT,
      () => OK,
      {
        check: async () => {
          throw thrown;
        },
      },
    );
    const store = new ResultsStore(":memory:");
    const err = await settle(runSession({ backend, store, ...dirs, selectorIds }));
    expect(err).toBe(thrown);
    expect(backend.checks).toBe(1);
    expect(store.mutantVerdicts(1)).toEqual([]);
    store.close();
  });
});

describe("14: the new refusal classes", () => {
  const cases: Array<[Error, string]> = [
    [new UnmutatedBuildFailedError(new AlcCompileError("x")), "UnmutatedBuildFailedError"],
    [
      new TestAppChangedError([{ name: "T.A", description: "d" }], "package:a", "package:b"),
      "TestAppChangedError",
    ],
  ];
  for (const [err, name] of cases) {
    test(`${name}: extends Error directly, named, and the CLI prints the name`, () => {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AlcCompileError);
      expect(err).not.toBeInstanceOf(StaleTestAppError);
      expect(err.name).toBe(name);
      expect(refusalLine(err)).toStartWith(`${name}: `);
    });
  }
});
