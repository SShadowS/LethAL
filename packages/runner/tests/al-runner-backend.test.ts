import { describe, expect, jest, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME } from "@lethal/schemata";
import {
  AL_RUNNER_UNCLASSIFIED_ERROR,
  AlRunnerBackend,
  AlRunnerServerStopUnsetError,
  parseReportedStopMs,
  verdictFromRunnerTest,
} from "../src/al-runner-backend";
import type { ServerSpawnFn } from "../src/al-runner-server";
import type { TestVerdict } from "../src/backend";
import { MsInMemoryBackend } from "../src/ms-inmemory-backend";
import { requiresUnsafeLatch } from "../src/operation-outcome";
import { runOnce } from "../src/orchestrator";
import type { SpawnFn } from "../src/publisher";
import { SessionSafety } from "../src/session-safety";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };
/** What al-runner v2 both filters on and reports back for `ref` — see `qualifiedTestName`. */
const QUALIFIED = "Codeunit79100.PostingUpdatesTotal";

function okSpawn(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push([...argv]);
    envs.push(opts?.env);
    return { exitCode, stdout: alRunnerStdout(payload), stderr: "" };
  };
  return { calls, envs, spawn };
}

async function makeBackend(spawn: ReturnType<typeof okSpawn>["spawn"]) {
  const dir = scratch("lethal-alrunner-");
  await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  return {
    dir,
    backend: new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
      },
      spawn,
    ),
  };
}

describe("AlRunnerBackend.deploy", () => {
  // Task 7 (parallel workers) regression coverage: the pre-fix deploy() just
  // did `this.deployedDir = instrumentedDir`, so activate()'s writes landed
  // straight in whatever shared batch dir the orchestrator passed in — the
  // exact bug that produced a wrong verdict (20.0% vs the known-good 18.8%)
  // during live verification. This drives the REAL deploy()/activate(), not
  // a re-implementation, so a regression here fails this test.
  test("copies the given source dir into <instrumentedDir>/active, isolated from the source and from cfg.instrumentedDir itself", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    // A separate directory standing in for the orchestrator's shared
    // per-batch `batchDir` — deploy() must not write into this, or into
    // `dir` itself, only into a private copy.
    const sourceDir = scratch("lethal-alrunner-batch-");
    await writeFile(join(sourceDir, "MutationSelector.Codeunit.al"), "source placeholder", "utf8");
    await writeFile(join(sourceDir, "Other.Codeunit.al"), "some AL source", "utf8");

    await backend.deploy(sourceDir);

    const activeDir = join(dir, "active");
    expect(await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8")).toBe(
      "source placeholder",
    );
    expect(await readFile(join(activeDir, "Other.Codeunit.al"), "utf8")).toBe("some AL source");
    // cfg.instrumentedDir's OWN top-level file (written by makeBackend(), see
    // above) must be untouched — proves the copy landed in the `active`
    // subdirectory, not directly in cfg.instrumentedDir.
    expect(await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8")).toBe("placeholder");

    // activate() must write into the private copy...
    await backend.activate("M0042");
    expect(await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8")).toContain(
      "exit(MutantId = 'M0042');",
    );
    // ...and NEVER into the directory that was passed to deploy() — this is
    // the exact race: two workers both given `sourceDir` (the orchestrator's
    // shared batchDir) must not have their activate() calls collide there.
    expect(await readFile(join(sourceDir, "MutationSelector.Codeunit.al"), "utf8")).toBe(
      "source placeholder",
    );
  });

  test("clears stale files from a previous deploy() before copying the next batch", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    const activeDir = join(dir, "active");

    const batch1 = scratch("lethal-alrunner-batch1-");
    await writeFile(join(batch1, "MutationSelector.Codeunit.al"), "batch1 selector", "utf8");
    await writeFile(join(batch1, "StaleOnly.Codeunit.al"), "only in batch 1", "utf8");
    await backend.deploy(batch1);
    expect(await readFile(join(activeDir, "StaleOnly.Codeunit.al"), "utf8")).toBe(
      "only in batch 1",
    );

    // batch2 deliberately does NOT include StaleOnly.Codeunit.al — if deploy()
    // merged instead of replacing, it would silently survive into batch 2's
    // compile (a wrong verdict, not a visible error — see the comment on
    // deploy() in al-runner-backend.ts).
    const batch2 = scratch("lethal-alrunner-batch2-");
    await writeFile(join(batch2, "MutationSelector.Codeunit.al"), "batch2 selector", "utf8");
    await backend.deploy(batch2);

    expect(await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8")).toBe(
      "batch2 selector",
    );
    await expect(readFile(join(activeDir, "StaleOnly.Codeunit.al"), "utf8")).rejects.toThrow();
  });

  // Task 4's shared emit path writes MutationRegister/MutationUpgrade into every
  // instrumented project — both reference `Codeunit "LC Control State"`, a LethAL
  // Control extension object al-runner has no dependency on (it uses the
  // self-contained emitStaticSelector and never talks to the control extension). Left
  // in place, al-runner's dependency-free `alc` compile would fail on an unresolved
  // `LC Control State`. deploy() must strip both files from the active dir it copies
  // into, while leaving the rest of the batch (the selector, ordinary source) intact.
  test("deploy() strips the control-registration codeunits from the active dir", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    const sourceDir = scratch("lethal-alrunner-control-");
    await writeFile(join(sourceDir, "MutationSelector.Codeunit.al"), "selector", "utf8");
    await writeFile(join(sourceDir, CONTROL_REGISTER_FILENAME), "register", "utf8");
    await writeFile(join(sourceDir, CONTROL_UPGRADE_FILENAME), "upgrade", "utf8");
    await writeFile(join(sourceDir, "Other.Codeunit.al"), "some AL source", "utf8");

    await backend.deploy(sourceDir);

    const activeDir = join(dir, "active");
    const names = await readdir(activeDir);
    expect(names).not.toContain(CONTROL_REGISTER_FILENAME);
    expect(names).not.toContain(CONTROL_UPGRADE_FILENAME);
    expect(names).toContain("MutationSelector.Codeunit.al");
    expect(names).toContain("Other.Codeunit.al");
  });
});

describe("AlRunnerBackend artifact identity", () => {
  // Glue coverage for the Task 3 parity trap: deploy() reads the deployed
  // batch's mutant-manifest.json and stores its artifactId; activate() must
  // bake that stored id into every rewritten MutationSelector.Codeunit.al.
  // This drives the REAL deploy()/activate() path (not a re-implementation
  // of readArtifactId), so a regression in either the manifest filename
  // readArtifactId looks for, or deploy()'s assignment of `this.artifactId`,
  // fails this test.
  test("deploy() reads the batch's artifactId and activate() bakes it into the rewritten selector", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    const sourceDir = scratch("lethal-alrunner-artifact-");
    await writeFile(join(sourceDir, "MutationSelector.Codeunit.al"), "source placeholder", "utf8");
    await writeFile(
      join(sourceDir, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "deadbeefdeadbeefdeadbeefdeadbeef", mutants: [] }),
      "utf8",
    );

    await backend.deploy(sourceDir);
    await backend.activate("M0001");

    const activeDir = join(dir, "active");
    const selector = await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8");
    expect(selector).toContain("deadbeefdeadbeefdeadbeefdeadbeef");
  });

  // Companion to the Important-1 fix in al-runner-backend.ts: a corrupt
  // manifest must fail deploy() loudly, not silently produce an empty
  // artifact id that later compares equal to another empty id.
  test("a corrupt manifest makes deploy() throw instead of silently yielding an empty artifact id", async () => {
    const { backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    const sourceDir = scratch("lethal-alrunner-corrupt-");
    await writeFile(join(sourceDir, "MutationSelector.Codeunit.al"), "source placeholder", "utf8");
    await writeFile(join(sourceDir, "mutant-manifest.json"), "{ not valid json", "utf8");

    await expect(backend.deploy(sourceDir)).rejects.toThrow(/mutant-manifest\.json/);
  });

  // The no-deploy path the class comment on deploy() promises to support: some callers
  // (e.g. al-runner.itest.ts) drive activate()/run() straight against cfg.instrumentedDir,
  // never calling deploy() first. activate() reads the artifact id LAZILY (see its comment)
  // specifically so this path bakes the real id from cfg.instrumentedDir's own
  // mutant-manifest.json, not a stale "" a deploy()-cached field would have left behind.
  test("activate() without a prior deploy() bakes the real artifact id from cfg.instrumentedDir", async () => {
    const dir = scratch("lethal-alrunner-lazyid-");
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    await writeFile(
      join(dir, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "cafebabecafebabecafebabecafebabe", mutants: [] }),
      "utf8",
    );
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
      },
      okSpawn({ tests: [] }).spawn,
    );

    // No backend.deploy(...) call — activate() is driven directly, as deploy()'s own
    // "existing callers may drive activate()/run() directly" comment describes.
    await backend.activate("M0007");

    const selector = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
    expect(selector).toContain("cafebabecafebabecafebabecafebabe");
  });
});

// R349. One backend deploys every batch of a session, and each batch instruments a different set
// of files, so the same file's line numbers move between deploys. Found by the code lane at R-318
// review: the coverage index was built once per backend and never dropped, so batch 2's lines were
// read through batch 1's text.
describe("AlRunnerBackend: a deploy() drops everything built from the previous layout (R349)", () => {
  const probeCodeunit = (pad: number) => `codeunit 79150 "Probe One"
{
${"    // pad\n".repeat(pad)}    procedure Reached()
    begin
        exit;
    end;

    procedure Other()
    begin
        exit;
    end;
}
`;

  async function batchDir(pad: number): Promise<string> {
    const d = scratch("lethal-r349-batch-");
    await writeFile(join(d, "One.Codeunit.al"), probeCodeunit(pad), "utf8");
    await writeFile(
      join(d, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
      "utf8",
    );
    await writeFile(join(d, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    return d;
  }

  /** A fake al-runner that passes the test and reports ONE covered line, the one it is told. */
  function coveringSpawn(line: () => number): SpawnFn {
    return async (argv) => {
      const o = argv.indexOf("--coverage-out");
      const out = o >= 0 ? argv[o + 1] : undefined;
      if (out !== undefined) {
        await writeFile(
          out,
          `<coverage><packages><package><classes><class name="x" filename="One.Codeunit.al"><lines><line number="${line()}" hits="1"/></lines></class></classes></package></packages></coverage>`,
          "utf8",
        );
      }
      return {
        exitCode: 0,
        stdout: alRunnerStdout({
          tests: [{ name: QUALIFIED, status: "pass", durationMs: 1 }],
          passed: 1,
          failed: 0,
          errors: 0,
          total: 1,
          exitCode: 0,
        }),
        stderr: "",
      };
    };
  }

  async function coveredProcedures(
    redeploy: (b: AlRunnerBackend, dir: string) => Promise<unknown>,
  ): Promise<{ first: string[]; second: string[] }> {
    let line = 0;
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: scratch("lethal-r349-work-"),
        testDir: "/tests",
        selectorObjectId: 50000,
        coverage: "al-runner",
      },
      coveringSpawn(() => line),
    );
    backend.useBuildSymbols([]); // R-300b: what runSession hands over before the first deploy
    const procs = (v: { coverage?: { entries: readonly { procedure?: string }[] } }) =>
      (v.coverage?.entries ?? []).map((e) => e.procedure ?? "<none>");
    // Batch 1, no shift: line 5 is `exit;` inside Reached.
    await redeploy(backend, await batchDir(0));
    line = 5;
    const first = procs(await backend.run(ref, { coverage: "none", timeoutMs: 5000 }));
    // Batch 2, the same file four lines further down: Reached's `exit;` is now line 9, which in
    // batch 1's text was inside Other.
    await redeploy(backend, await batchDir(4));
    line = 9;
    const second = procs(await backend.run(ref, { coverage: "none", timeoutMs: 5000 }));
    await backend.close(); // R358: removes its Cobertura scratch directory
    return { first, second };
  }

  test("deploy(): batch 2's coverage is read through batch 2's text", async () => {
    const { first, second } = await coveredProcedures((b, d) => b.deploy(d));
    expect(first).toEqual(["Reached"]);
    expect(second).toEqual(["Reached"]);
  });

  test("compileCheck() is a redeploy too, and drops the index the same way", async () => {
    const { first, second } = await coveredProcedures((b, d) => b.compileCheck(d));
    expect(first).toEqual(["Reached"]);
    expect(second).toEqual(["Reached"]);
  });
});

// R-307 section 4 (e). With coverage on, deploy() builds the index EAGERLY and checks the manifest's
// objects against its parsed declarations, so an undeclared one throws before the baseline's first
// al-runner invocation. The spawn counter is the phase-order evidence: a lazy build would only run
// after that invocation, which the counter would show as 1.
describe("AlRunnerBackend.deploy: manifest objects against parsed declarations (R-307)", () => {
  async function deployThenBaseline(codeunitIds: readonly number[] | "no-manifest") {
    const dir = scratch("lethal-r307-alrunner-batch-");
    await writeFile(
      join(dir, "One.Codeunit.al"),
      'codeunit 79150 "Probe One"\n{\n    procedure Reached()\n    begin\n        exit;\n    end;\n}\n',
      "utf8",
    );
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    if (codeunitIds !== "no-manifest") {
      await writeFile(
        join(dir, "mutant-manifest.json"),
        JSON.stringify({
          artifactId: "a".repeat(32),
          mutants: codeunitIds.map((codeunitId) => ({ objectType: "codeunit", codeunitId })),
        }),
        "utf8",
      );
    }
    const workDir = scratch("lethal-r307-alrunner-work-");
    const { calls, spawn } = okSpawn({
      tests: [{ name: QUALIFIED, status: "pass", durationMs: 1 }],
      passed: 1,
      failed: 0,
      errors: 0,
      total: 1,
      exitCode: 0,
    });
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: workDir,
        testDir: "/tests",
        selectorObjectId: 50000,
        coverage: "al-runner",
      },
      spawn,
    );
    backend.useBuildSymbols([]); // R-300b: what runSession hands over before the first deploy
    let err: unknown;
    try {
      // The orchestrator's order: deploy, then the baseline run.
      await backend.deploy(dir);
      await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    } catch (e) {
      err = e;
    }
    await backend.close();
    return { err, invocations: calls.length, activeDir: join(workDir, "active") };
  }

  test("an undeclared manifest object throws at deploy, before any baseline invocation", async () => {
    const { err, invocations } = await deployThenBaseline([79150, 79160]);
    // First, so a lazy build fails on the ORDER: the baseline's invocation already happened.
    expect(invocations).toBe(0);
    expect((err as Error | undefined)?.message).toBe(
      "a mutant is attributed to codeunit:79160, which the compiled app does not declare. It is not named in the run's coverage refusals, so its mutants would read no-coverage with no reason given.",
    );
  });

  test("fix round 1: with coverage on, a MISSING manifest is refused at deploy, naming its path", async () => {
    // An absent manifest checked as an empty key set would pass with nothing checked.
    const { err, invocations, activeDir } = await deployThenBaseline("no-manifest");
    expect(invocations).toBe(0);
    expect((err as Error | undefined)?.message).toBe(
      `line-map: ${join(activeDir, "mutant-manifest.json")} does not exist, so the batch's mutant objects cannot be checked against its declarations`,
    );
  });

  test("control: a declared one deploys and the baseline runs once", async () => {
    const { err, invocations } = await deployThenBaseline([79150]);
    expect(err).toBeUndefined();
    expect(invocations).toBe(1);
  });
});

describe("AlRunnerBackend.compileCheck", () => {
  // al-runner has no publish step of its own — deploy() is already just a local file copy, and
  // the actual `alc` invocation happens lazily inside run(), per test. So bisection's
  // compile-only seam has nothing to withhold here: compileCheck() delegating straight to the
  // existing deploy() IS the compile-only behaviour for this backend. Proven by driving the
  // real compileCheck() (not a re-implementation) and observing the exact same file-copy
  // side effect deploy() itself produces.
  test("delegates to deploy(): copies the candidate dir into <instrumentedDir>/active", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    const sourceDir = scratch("lethal-alrunner-candidate-");
    await writeFile(
      join(sourceDir, "MutationSelector.Codeunit.al"),
      "candidate placeholder",
      "utf8",
    );

    await backend.compileCheck(sourceDir);

    const activeDir = join(dir, "active");
    expect(await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8")).toBe(
      "candidate placeholder",
    );
  });
});

describe("AlRunnerBackend.activate", () => {
  test("rewrites MutationSelector.Codeunit.al with the hardcoded id", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    await backend.activate("M0009");
    const src = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
    expect(src).toContain("exit(MutantId = 'M0009');");
    await backend.activate(null);
    const cleared = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
    expect(cleared).toContain("exit(false);");
  });
});

describe("AlRunnerBackend.run", () => {
  test("spawns al-runner with the v2 argv and parses a pass", async () => {
    const { calls, envs, spawn } = okSpawn({
      tests: [{ name: QUALIFIED, status: "pass", durationMs: 3 }],
      passed: 1,
      failed: 0,
      errors: 0,
      total: 1,
      exitCode: 0,
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("pass");
    const argv = calls[0] ?? [];
    expect(argv).toContain("--output-json");

    // al-runner defaults to `codeunit` isolation (state shared within a codeunit); LethAL must
    // force v2's `test` mode so behaviour matches the advertised `full-reset` capability. The
    // v1 argv said `--test-isolation method`, which v2 accepts only as an ALIAS for `codeunit`
    // — i.e. it silently bought the weaker thing (R96), so `method` must not appear at all.
    const isoIdx = argv.indexOf("--isolation");
    expect(isoIdx).toBeGreaterThanOrEqual(0);
    expect(argv[isoIdx + 1]).toBe("test");
    expect(argv).not.toContain("method");
    expect(argv).not.toContain("--test-isolation");

    // The filter is the QUALIFIED name, and it is the same string the lookup below matches on.
    const testIdx = argv.indexOf("--test");
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(argv[testIdx + 1]).toBe(QUALIFIED);

    for (const dead of ["--run", "--packages", "--stubs", "--test-timeout"]) {
      expect(argv).not.toContain(dead);
    }
    // v2 has no --test-timeout; the per-test budget is an env var (see the margin test below).
    expect(envs[0]?.AL_RUNNER_TEST_TIMEOUT_SEC).toBeDefined();
  });

  test("exit 1 with fail result maps to fail", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: QUALIFIED,
            status: "fail",
            durationMs: 3,
            message: "boom",
            stackTrace: '"Sandbox Tests"(CodeUnit 79100).PostingUpdatesTotal line 2',
          },
        ],
        passed: 0,
        failed: 1,
        errors: 0,
        total: 1,
        exitCode: 1,
      },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("fail");
    expect(v.failureMessage).toBe("boom");
  });

  // R95: exit 2 means a bundle could not EXECUTE — the runner never ran the mutant. It used to
  // map to `outcome: "skip"`, so a process-level failure became a silently skipped mutant with
  // no verdict and nothing an operator would look at. Both codes must now produce `error`, and
  // — the part that matters — NEITHER may produce a scored pass/fail verdict, because scoring
  // one means recording a kill or a survivor that nothing measured.
  test("exit 2 (could not execute) and exit 3 (could not compile) are BOTH outcome=error, never a scored verdict", async () => {
    for (const code of [2, 3]) {
      const spawn: SpawnFn = async () => ({
        exitCode: code,
        // Deliberately a well-formed GREEN payload: if the exit code were ignored and the
        // stdout read anyway, this would score a PASS — i.e. a survivor nothing ran.
        stdout: alRunnerStdout({ tests: [{ name: QUALIFIED, status: "pass" }] }),
        stderr: `al-runner: bundle failed (exit ${code})`,
      });
      const { backend } = await makeBackend(spawn);
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
      expect(v.outcome).toBe("error");
      expect(v.outcome).not.toBe("pass");
      expect(v.outcome).not.toBe("fail");
      expect(v.failureMessage).toContain(`exit ${code}`);
      expect(v.operation).toBe("pre-dispatch-rejected");
    }
  });

  // R97's other half at the backend seam: a payload the parser cannot read must not become an
  // empty test list. It surfaces as `error`, never as a mutant nobody killed.
  test("stdout with no JSON envelope is outcome=error, not a survivor", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "al-runner - running 2 bundle(s)\n   0P/0F/0E across 0 tests\n",
      stderr: "",
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("--output-json envelope");
  });

  // I8: a timed-out run must not leak the spawned child — the backend aborts
  // an AbortSignal it hands to spawn() so the caller can kill the process.
  // This is OUR timer firing on a hung child (no runner-confirmed result), so
  // the outcome is "deadline-exceeded", not the runner-confirmed "timeout".
  test("client deadline aborts the spawned child via AbortSignal", async () => {
    let capturedSignal: AbortSignal | undefined;
    const hangingSpawn = (
      _argv: readonly string[],
      opts?: { signal?: AbortSignal },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      capturedSignal = opts?.signal;
      return new Promise(() => {}); // never resolves — simulates a hung child
    };
    const { backend } = await makeBackend(hangingSpawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 20 });
    expect(v.outcome).toBe("deadline-exceeded");
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  // R94, and the pair below is the whole point: v2 reports a runner-side timeout as
  // `status: "error"` (v1 said `status: "fail"`), so a classifier that also demanded "fail"
  // let every v2 hang fall through to `fail` and recorded the mutant KILLED — a false kill.
  // The two cases share a status and differ only in the message, which is what proves the
  // classification reads the MESSAGE and not the status. Splitting them into separate test
  // files, or testing only the timeout half, would let a status-based rule pass again.
  test("a v2 runner-confirmed timeout (status=error) is outcome=timeout", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: QUALIFIED,
            status: "error",
            durationMs: 30_014,
            message: "TIMEOUT after 30s",
            stackTrace: '"Sandbox Tests"(CodeUnit 79100).PostingUpdatesTotal line 2',
          },
        ],
      },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("timeout");
    expect(v.failureMessage).toBe("TIMEOUT after 30s");
  });

  /**
   * al-runner ships several times a day, and we watched the timeout WORDING move inside a single
   * session: `TIMEOUT after <n>s` on 2.0.0.0, back to `Test exceeded <n>s timeout.` on 2.0.1.0,
   * both with `status: "error"`. So this test pins BOTH literals rather than whichever one the
   * binary on this machine happens to say today.
   */
  test("both measured timeout wordings classify as outcome=timeout", async () => {
    for (const message of ["TIMEOUT after 30s", "Test exceeded 12s timeout."]) {
      const { spawn } = okSpawn(
        { tests: [{ name: QUALIFIED, status: "error", durationMs: 3, message }] },
        1,
      );
      const { backend } = await makeBackend(spawn);
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
      expect(v.outcome, `wording: ${message}`).toBe("timeout");
    }
  });

  /**
   * THE FAIL-CLOSED RULE, and this assertion was the opposite one until 2.0.1 shipped.
   *
   * It used to expect `fail` — an unclassified `status: "error"` fell through to the kill branch.
   * That is what made the timeout re-wording dangerous rather than merely annoying: a string change
   * upstream turned every hung mutant into a KILL, silently, and no aggregate count would show it.
   * `error` is al-runner's word for several distinct things — a timeout it enforced, and (its own
   * `RunnerOutOfScopeException`) a test that reached SMTP, outbound HTTP, printing, external file
   * I/O or web-service publishing — and only one of them says anything about the mutant.
   *
   * So: an `error` we cannot positively classify costs the mutant its verdict and says so, rather
   * than crediting the suite with a kill it did not earn. Wrong in the direction this project is
   * willing to be wrong in.
   */
  test("a status=error we cannot classify is outcome=error — NOT a kill", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: QUALIFIED,
            status: "error",
            durationMs: 3,
            message: "RunnerOutOfScopeException: outbound HTTP is not available in this runtime",
          },
        ],
      },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain(AL_RUNNER_UNCLASSIFIED_ERROR);
    // The runner's own words survive into the record — without them nobody can tell which
    // unclassified error this was, which is the whole reason it is not scored.
    expect(v.failureMessage).toContain("RunnerOutOfScopeException");
  });

  test("an ordinary assertion failure is still outcome=fail", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: QUALIFIED,
            status: "fail",
            durationMs: 3,
            message: "expected 2, got 1",
          },
        ],
      },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("fail");
  });

  // The lookup must use the SAME qualified name the `--test` filter sent (one helper builds
  // both). Matching on the bare method would miss every v2 row; matching too loosely would
  // score a mutant off whatever test happened to be in the payload. (Since R488 a payload that ALSO
  // names another test is never credited at all; see the R488 block below.)
  test("finds the requested test by its qualified name", async () => {
    const { spawn } = okSpawn({
      tests: [{ name: "Codeunit79100.OverBudgetDetected", status: "pass" }],
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "OverBudgetDetected" },
      { coverage: "none", timeoutMs: 5000 },
    );
    expect(v.outcome).toBe("pass");
  });

  test("refuses loudly when the runner returns some other test, naming both sides", async () => {
    const { spawn } = okSpawn({
      tests: [{ name: "Codeunit79100.SomethingElse", status: "pass" }],
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    // Not "pass" — a payload for a DIFFERENT test says nothing about this mutant.
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain(QUALIFIED);
    expect(v.failureMessage).toContain("Codeunit79100.SomethingElse");
    // R491: this is R488's refusal, and the test WAS dispatched, so it is not pre-dispatch.
    expect(v.operation).toBe("completed-accepted");
  });

  test("our own deadline is outcome=deadline-exceeded, not timeout", async () => {
    const spawn = async () => new Promise<never>(() => {}) as never;
    const { backend } = await makeBackend(spawn as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
  });

  // R490 (closed as a ruling): a look-alike that discovery did NOT see runs in the same call and
  // hangs it to OUR deadline. That call carries no test list, so nothing is learned, but the
  // outcome must stay deadline-exceeded (an error), never `timeout`, which scoring reads as a kill.
  test("a hang from an undiscovered look-alike is deadline-exceeded, never a kill (R490)", async () => {
    const calls: string[][] = [];
    const spawn = async (argv: string[]) => {
      calls.push(argv);
      return new Promise<never>(() => {});
    };
    const { backend } = await makeBackend(spawn as never);
    backend.useDiscoveredTests([ref]); // discovery saw only the requested test
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.outcome).not.toBe("timeout");
    expect(calls.length).toBe(1);
  });

  // Regression guard for the timeout-margin bug, both directions (R516 T7). The in-run limit
  // (AL_RUNNER_TEST_TIMEOUT_SEC, timed on the test body) must be AT LEAST the budget the
  // orchestrator judges the run by: half of it timed a test out under every mutant on a budget of
  // twice its wall clock (R516). And it must stay BELOW the client deadline actually sent, or our
  // AbortController always wins the race and every genuine hang reads deadline-exceeded instead of
  // the runner-confirmed `timeout`. This drives the real backend.run() path (not a
  // re-implementation of the formula) so a regression in the derivation itself fails this test.
  test("the in-run limit is at least the budget and below the client deadline sent", async () => {
    for (const timeoutMs of [1500, 5000, 14000, 120000]) {
      const { envs, spawn } = okSpawn({
        tests: [{ name: QUALIFIED, status: "pass" }],
      });
      const { backend } = await makeBackend(spawn);
      // Record the deadline the backend hands its transport, delegating unchanged.
      const t = (
        backend as unknown as {
          transport: { send: (r: { deadlineMs: number }) => Promise<unknown> };
        }
      ).transport;
      const send = t.send.bind(t);
      const deadlines: number[] = [];
      t.send = async (r) => {
        deadlines.push(r.deadlineMs);
        return send(r);
      };
      await backend.run(ref, { coverage: "none", timeoutMs });
      const raw = envs[0]?.AL_RUNNER_TEST_TIMEOUT_SEC;
      expect(raw).toBeDefined();
      expect(deadlines).toHaveLength(1);
      expect(Number(raw) * 1000).toBeGreaterThanOrEqual(timeoutMs);
      expect(Number(raw) * 1000).toBeLessThan(deadlines[0] ?? 0);
    }
  });

  // Task 8A (classification parity): al-runner recompiles fresh on every call and
  // strands no shared server, so a transport-level error provably never dispatched
  // anything a retry could collide with — retry-safe. Drives the REAL run() (via the
  // exitCode:3 -> kind:"error" mapping already proven by the "exit 2/3" test above),
  // not a re-implementation, so a regression in the operation assignment fails this.
  test("marks a transport error pre-dispatch-rejected (retry-safe; no shared strand)", async () => {
    const { backend } = await makeBackend(okSpawn({ tests: [] }, 3).spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("pre-dispatch-rejected");
  });

  // Companion to the above: our OWN client deadline must stay non-latching. Unlike
  // bcdev (a shared MCP server that may still be executing after our timer fires),
  // al-runner has no shared tier to quarantine, and the transport already kills the
  // local child on this exact deadline (OneShotTransport's AbortController, proven by
  // "client deadline aborts the spawned child via AbortSignal" above) — so `run()`
  // must NOT add a second kill path or an unsafe-latching operation here.
  test("deadline does NOT set an unsafe-latching operation (child already killed by transport)", async () => {
    const spawn = async () => new Promise<never>(() => {}) as never;
    const { backend } = await makeBackend(spawn as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.operation).toBeUndefined();
    expect(requiresUnsafeLatch(v.operation ?? "completed-accepted")).toBe(false);
  });
});

describe("AlRunnerBackend.status", () => {
  // v2 HAS --version and answers `al-runner v2.0.0.0` with exit 0; v1.0.31 rejected the flag
  // outright, which is why this probe used to be --help. The switch is not cosmetic: --help
  // exits 0 on BOTH versions, so it could never tell them apart, and this adapter sends v2-only
  // argv and reads v2's timeout shape.
  test("probes with --version and accepts a v2 binary", async () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "al-runner v2.0.0.0\n", stderr: "" };
    };
    const { backend } = await makeBackend(spawn);
    const status = await backend.status();
    expect(status.ok).toBe(true);
    expect(status.details).toBe("al-runner v2.0.0.0");
    expect(calls[0]).toContain("--version");
    expect(calls[0]).not.toContain("--help");
  });

  // A v1 binary must fail with something a human can act on. Silently accepting it would mean
  // sending flags v1 rejects (exit 2 on every mutant) and reading v1's timeout message shape
  // through a v2 regex — wrong verdicts rather than an error.
  test("refuses a v1 binary by name instead of producing wrong verdicts", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "al-runner v1.0.31\n",
      stderr: "",
    });
    const { backend } = await makeBackend(spawn);
    const status = await backend.status();
    expect(status.ok).toBe(false);
    expect(status.details).toContain("v1.0.31");
    expect(status.details).toContain("v2");
  });

  test("an unrunnable binary is still ok:false", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 9009, stdout: "", stderr: "not found" });
    const { backend } = await makeBackend(spawn);
    const status = await backend.status();
    expect(status.ok).toBe(false);
    expect(status.details).toContain("not runnable");
  });
});

describe("AlRunnerBackend serverMode (R220)", () => {
  // R97 refused this until 2026-09-09, and the test that stood here asserted the refusal. Both of
  // its grounds were re-measured on al-runner 2.11.0 before it was lifted: there is still no
  // per-test filter, but the "quadratic" conclusion assumed the cost was per test EXECUTED and it
  // is per COMPILE (12.5 s cold against 0.4 s warm after an AL edit). What replaces the refusal
  // test is not "it constructs" but the two behaviours that make the mode safe.

  /** A fake daemon good enough to answer one `runTests`, so no binary is needed. */
  function fakeServerSpawn(tests: Array<{ name: string; status: string; message?: string }>): {
    spawn: ServerSpawnFn;
    runs: () => number;
  } {
    let runs = 0;
    const spawn: ServerSpawnFn = () => {
      const queue: Array<Uint8Array | null> = [];
      let waiter: (() => void) | undefined;
      const push = (chunk: Uint8Array | null): void => {
        queue.push(chunk);
        waiter?.();
        waiter = undefined;
      };
      const emit = (line: string): void =>
        push(
          new TextEncoder().encode(`${line}
`),
        );
      queueMicrotask(() => emit('{"ready":true}'));
      return {
        write: (line: string) => {
          const req = JSON.parse(line) as { command?: string };
          if (req.command === "runTests") {
            runs += 1;
            for (const t of tests) emit(JSON.stringify({ type: "test", ...t }));
            emit(JSON.stringify({ type: "summary", exitCode: 0, total: tests.length }));
          }
          if (req.command === "shutdown") emit('{"status":"shutting down"}');
        },
        stdout: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (queue.length === 0) {
                await new Promise<void>((r) => {
                  waiter = r;
                });
                continue;
              }
              const next = queue.shift();
              if (next === null || next === undefined) return;
              yield next;
            }
          },
        },
        stderr: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(
              "[bc] selected BC 28.1.49838.54368 (C:/artifacts/28.1.49838.54368)\n",
            );
          },
        },
        kill: () => push(null),
      };
    };
    return { spawn, runs: () => runs };
  }

  async function serverBackend(
    tests: Array<{ name: string; status: string; message?: string }>,
  ): Promise<{ backend: AlRunnerBackend; runs: () => number; dir: string }> {
    const dir = scratch("lethal-alrunner-server-");
    const fake = fakeServerSpawn(tests);
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        serverMode: true,
      },
      okSpawn({ tests: [] }).spawn,
      fake.spawn,
    );
    // R517: the session gives every backend its floor before the first run.
    backend.useMutantBudgetFloor(180_000, 120_000);
    return { backend, runs: fake.runs, dir };
  }

  test("R516 I1: inRunStopIsBudget is false under --server (the daemon's own stop), true one-shot", async () => {
    const { backend } = await serverBackend([]);
    const oneShot = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: "/x",
        testDir: "/tests",
        selectorObjectId: 50000,
      },
      okSpawn({ tests: [] }).spawn,
    );
    expect([backend.inRunStopIsBudget, oneShot.inRunStopIsBudget]).toEqual([false, true]);
  });

  test("runs the suite ONCE per activation and serves every test from it", async () => {
    // This is the whole economics of the mode. The server has no per-test filter, so `runTests`
    // runs everything; caching per activation is what turns T calls into one suite run. Without
    // it this would be the quadratic shape R97 refused.
    const { backend, runs } = await serverBackend([
      { name: "Codeunit79100.A", status: "pass" },
      { name: "Codeunit79100.B", status: "fail", message: "assert" },
    ]);
    const a = await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" },
      { coverage: "none", timeoutMs: 1000 },
    );
    const b = await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "B" },
      { coverage: "none", timeoutMs: 1000 },
    );
    expect(a.outcome).toBe("pass");
    expect(b.outcome).toBe("fail");
    expect(runs()).toBe(1);
    await backend.close();
  });

  test("activate() DROPS the cache, so a mutant is never scored on the previous one's results", async () => {
    // The single worst thing this cache could do, and the reason `activate()` clears it before it
    // rewrites the selector rather than after.
    const { backend, runs } = await serverBackend([{ name: "Codeunit79100.A", status: "pass" }]);
    await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" },
      { coverage: "none", timeoutMs: 1000 },
    );
    expect(runs()).toBe(1);
    await backend.activate("M0001");
    await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" },
      { coverage: "none", timeoutMs: 1000 },
    );
    expect(runs()).toBe(2);
    await backend.close();
  });

  test("deploy() DROPS the suite cache too, so batch 2 is never answered from batch 1's run (R349)", async () => {
    const { backend, runs, dir } = await serverBackend([
      { name: "Codeunit79100.A", status: "pass" },
    ]);
    const a = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" };
    const batch = async (): Promise<string> => {
      const d = await mkdtemp(join(dir, "batch-"));
      await writeFile(join(d, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
      await writeFile(
        join(d, "mutant-manifest.json"),
        JSON.stringify({ artifactId: "b".repeat(32), mutants: [] }),
        "utf8",
      );
      return d;
    };
    await backend.deploy(await batch());
    await backend.run(a, { coverage: "none", timeoutMs: 1000 });
    expect(runs()).toBe(1);
    // No activate() in between, deliberately: the cache must not depend on the caller making one.
    await backend.deploy(await batch());
    await backend.run(a, { coverage: "none", timeoutMs: 1000 });
    expect(runs()).toBe(2);
    await backend.close();
  });

  test("a test the suite never reported is an error naming both sides, not a silent pass", async () => {
    const { backend } = await serverBackend([{ name: "Codeunit79100.A", status: "pass" }]);
    const v = await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "Missing" },
      { coverage: "none", timeoutMs: 1000 },
    );
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("Codeunit79100.Missing");
    expect(v.failureMessage).toContain("Codeunit79100.A");
    await backend.close();
  });

  test("R129: the BC build is read off the DAEMON's stderr, where the announcement now lives", async () => {
    const { backend } = await serverBackend([{ name: "Codeunit79100.A", status: "pass" }]);
    await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" },
      { coverage: "none", timeoutMs: 1000 },
    );
    expect(backend.observedBcBuild()?.build).toBe("28.1.49838.54368");
    await backend.close();
  });

  test("serverMode:false still constructs and uses the one-shot transport", async () => {
    const dir = scratch("lethal-alrunner-server-off-");
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        serverMode: false,
      },
      okSpawn({ tests: [] }).spawn,
    );
    expect(backend.capabilities().coverage).toBe("none");
  });

  /** The values that follow each `--define` in one argv, in order. */
  function definesOf(argv: readonly string[]): string[] {
    const out: string[] = [];
    argv.forEach((a, i) => {
      const next = argv[i + 1];
      if (a === "--define" && next !== undefined) out.push(next);
    });
    return out;
  }

  for (const selectorMode of ["static", "resource"] as const) {
    test(`R319: the daemon is started with the SAME --define list the one-shot path sends (${selectorMode} selector)`, async () => {
      // al-runner 2.11.0's server takes preprocessor symbols ONLY as start-time flags. Its
      // `runTests` request has no symbols field and silently ignores one, measured. So a daemon
      // started without them compiles the no-symbol build for the whole session.
      const symbols = ["CLEAN27", "A"];
      const dir = scratch("lethal-alrunner-server-syms-");
      const fake = fakeServerSpawn([{ name: "Codeunit79100.A", status: "pass" }]);
      const serverArgv: string[][] = [];
      const spy: ServerSpawnFn = (argv) => {
        serverArgv.push([...argv]);
        return fake.spawn(argv);
      };
      const server = new AlRunnerBackend(
        {
          alRunnerPath: "al-runner",
          instrumentedDir: dir,
          testDir: "/tests",
          selectorObjectId: 50000,
          serverMode: true,
          selectorMode,
          preprocessorSymbols: symbols,
        },
        okSpawn({ tests: [] }).spawn,
        spy,
      );
      server.useMutantBudgetFloor(180_000, 120_000);
      const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" };
      await server.run(ref, { coverage: "none", timeoutMs: 1000 });
      await server.close();

      const oneShotSpawn = okSpawn({ tests: [] });
      const oneShot = new AlRunnerBackend(
        {
          alRunnerPath: "al-runner",
          instrumentedDir: dir,
          testDir: "/tests",
          selectorObjectId: 50000,
          preprocessorSymbols: symbols,
        },
        oneShotSpawn.spawn,
      );
      await oneShot.run(ref, { coverage: "none", timeoutMs: 1000 });

      expect(serverArgv.length).toBe(1);
      const [started] = serverArgv;
      const [sent] = oneShotSpawn.calls;
      if (started === undefined || sent === undefined) throw new Error("no argv captured");
      expect(definesOf(started)).toEqual(["CLEAN27", "A"]);
      expect(definesOf(started)).toEqual(definesOf(sent));
    });
  }

  test("R319: with no symbols the daemon's argv carries no --define at all", async () => {
    const dir = scratch("lethal-alrunner-server-nosyms-");
    const fake = fakeServerSpawn([{ name: "Codeunit79100.A", status: "pass" }]);
    const serverArgv: string[][] = [];
    const spy: ServerSpawnFn = (argv) => {
      serverArgv.push([...argv]);
      return fake.spawn(argv);
    };
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        serverMode: true,
      },
      okSpawn({ tests: [] }).spawn,
      spy,
    );
    backend.useMutantBudgetFloor(180_000, 120_000);
    await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" },
      { coverage: "none", timeoutMs: 1000 },
    );
    await backend.close();
    expect(serverArgv).toEqual([["al-runner", "--server", "--test-timeout", "180"]]);
  });

  /** A server-mode backend whose daemon argv is recorded; `floor` is handed over when given. */
  function argvRecording(floor?: readonly [number, number]) {
    const fake = fakeServerSpawn([{ name: "Codeunit79100.A", status: "pass" }]);
    const argvs: string[][] = [];
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: scratch("lethal-alrunner-r517-argv-"),
        testDir: "/tests",
        selectorObjectId: 50000,
        serverMode: true,
      },
      okSpawn({ tests: [] }).spawn,
      (argv) => {
        argvs.push([...argv]);
        return fake.spawn(argv);
      },
    );
    if (floor !== undefined) backend.useMutantBudgetFloor(floor[0], floor[1]);
    return { backend, argvs };
  }
  const A = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" };
  /** Every value that follows `--test-timeout` in one argv. */
  const stopsOf = (argv: readonly string[] | undefined): string[] =>
    (argv ?? []).flatMap((a, i) => (a === "--test-timeout" ? [argv?.[i + 1] ?? "<none>"] : []));

  for (const [floor, baseline, sent] of [
    [180_000, 120_000, "180"],
    [180_500, 120_000, "181"],
    // M2: a floor below the baseline timeout must not stop the baseline's tests early.
    [30_000, 120_000, "120"],
  ] as const) {
    test(`R517 D1: useMutantBudgetFloor(${floor}, ${baseline}) starts the daemon with --test-timeout ${sent}, exactly once`, async () => {
      const { backend, argvs } = argvRecording([floor, baseline]);
      await backend.run(A, { coverage: "none", timeoutMs: 1000 });
      await backend.close();
      expect(argvs.length).toBe(1);
      expect(stopsOf(argvs[0])).toEqual([sent]);
    });
  }

  test("R517 D1: with no floor, run() throws AlRunnerServerStopUnsetError (never an error verdict) and spawns nothing", async () => {
    const { backend, argvs } = argvRecording();
    await expect(backend.run(A, { coverage: "none", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AlRunnerServerStopUnsetError,
    );
    expect(argvs).toEqual([]);
    await backend.close();
  });

  test("R517 D1: a second useMutantBudgetFloor with other values throws, the same values do not", async () => {
    const { backend } = argvRecording([180_000, 120_000]);
    await backend.run(A, { coverage: "none", timeoutMs: 1000 });
    expect(() => backend.useMutantBudgetFloor(180_000, 120_000)).not.toThrow();
    expect(() => backend.useMutantBudgetFloor(200_000, 120_000)).toThrow(/one stop for its life/);
    expect(() => backend.useMutantBudgetFloor(180_000, 130_000)).toThrow(/one stop for its life/);
    await backend.close();
  });

  test("R517 D1: inRunStopMs is the daemon's stop under serverMode once set, and undefined one-shot or before", async () => {
    const { backend } = argvRecording();
    expect(backend.inRunStopMs).toBeUndefined();
    backend.useMutantBudgetFloor(180_000, 120_000);
    expect(backend.inRunStopMs).toBe(180_000);
    const oneShot = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: "/x",
        testDir: "/tests",
        selectorObjectId: 50000,
      },
      okSpawn({ tests: [] }).spawn,
    );
    oneShot.useMutantBudgetFloor(180_000, 120_000);
    expect(oneShot.inRunStopMs).toBeUndefined();
  });

  test("R517 D1: one-shot argv and env are unchanged by the floor (oneShotLimits per call)", async () => {
    const s = okSpawn({ tests: [{ name: "Codeunit79100.A", status: "pass" }] });
    const { backend } = await makeBackend(s.spawn);
    await backend.run(A, { coverage: "none", timeoutMs: 4000 });
    backend.useMutantBudgetFloor(180_000, 120_000);
    await backend.run(A, { coverage: "none", timeoutMs: 4000 });
    const [bare, floored] = s.calls;
    expect(floored).toEqual(bare ?? []);
    expect(floored).not.toContain("--test-timeout");
    expect(s.envs[1]).toEqual(s.envs[0]);
    expect(s.envs[1]?.AL_RUNNER_TEST_TIMEOUT_SEC).toBe("4");
  });
});

describe("parseReportedStopMs (R517)", () => {
  test("reads N from al-runner's whole timeout message, and nothing else", () => {
    expect(parseReportedStopMs("Test exceeded 180s timeout.")).toBe(180_000);
    expect(parseReportedStopMs("Test exceeded 1s timeout.")).toBe(1_000);
    expect(parseReportedStopMs("Test exceeded 0s timeout.")).toBeUndefined();
    expect(parseReportedStopMs("TIMEOUT after 5s")).toBeUndefined();
    expect(parseReportedStopMs("Test exceeded 180s timeout. (and more)")).toBeUndefined();
    expect(parseReportedStopMs("Error: Test exceeded 180s timeout.")).toBeUndefined();
    expect(parseReportedStopMs("Assert failed")).toBeUndefined();
    expect(parseReportedStopMs(undefined)).toBeUndefined();
  });

  test("a timeout verdict carries it; a timeout in another wording, a fail and an error do not", () => {
    const r = { codeunitId: 1, codeunitName: "T", method: "M" };
    const v = (status: string, message: string) =>
      verdictFromRunnerTest(r, "Codeunit1.M", { status, message }, 10, undefined);
    expect([
      v("error", "Test exceeded 60s timeout.").outcome,
      v("error", "Test exceeded 60s timeout.").reportedStopMs,
    ]).toEqual(["timeout", 60_000]);
    expect([
      v("error", "TIMEOUT after 5s").outcome,
      v("error", "TIMEOUT after 5s").reportedStopMs,
    ]).toEqual(["timeout", undefined]);
    expect(v("fail", "Test exceeded 60s timeout.").reportedStopMs).toBeUndefined();
    expect(v("error", "SMTP is out of scope").reportedStopMs).toBeUndefined();
  });
});

describe("AlRunnerBackend capabilities", () => {
  test("in-memory profile", async () => {
    const { backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    expect(backend.capabilities()).toEqual({
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
      // R553: the backend declares its own identity; the report's screen keys on it.
      kind: "al-runner",
    });
  });
});

describe("MsInMemoryBackend", () => {
  test("throws with a pointer to the spec", () => {
    const b = new MsInMemoryBackend();
    expect(() => b.capabilities()).toThrow(/2026-07-17-layer-4/);
  });

  test("compileCheck also throws with a pointer to the spec", () => {
    const b = new MsInMemoryBackend();
    expect(() => b.compileCheck()).toThrow(/2026-07-17-layer-4/);
  });
});

/**
 * R222 — `selectorMode: "resource"`.
 *
 * The point is that `activate()` stops rewriting AL. If it ever rewrites AL again, al-runner's
 * output cache MISSES and every mutant costs a compile again, which is the whole cost this mode
 * exists to remove, and nothing about the verdicts would look wrong.
 */
describe("AlRunnerBackend selectorMode: resource", () => {
  async function deployed(mode: "static" | "resource") {
    const dir = scratch(`lethal-alrunner-${mode}-`);
    const batch = scratch("lethal-alrunner-batch-");
    await writeFile(join(batch, "MutationSelector.Codeunit.al"), "generated selector", "utf8");
    await writeFile(
      join(batch, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
      "utf8",
    );
    await writeFile(join(batch, "app.json"), JSON.stringify({ id: "x", name: "T" }), "utf8");
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        selectorMode: mode,
      },
      okSpawn({ tests: [] }).spawn,
    );
    await backend.deploy(batch);
    return { backend, activeDir: join(dir, "active") };
  }

  test("deploy declares the resource folder and seeds the file", async () => {
    const { activeDir } = await deployed("resource");
    const manifest = JSON.parse(await readFile(join(activeDir, "app.json"), "utf8")) as {
      resourceFolders?: string[];
    };
    expect(manifest.resourceFolders).toEqual(["LethALResources"]);
    // Seeded, because the FIRST compile reads the resource and a missing file would fail that read
    // rather than starting at "no mutant active".
    expect(await readFile(join(activeDir, "LethALResources", "active-mutant.txt"), "utf8")).toBe(
      "NONE",
    );
  });

  test("deploy writes the resource-reading selector, with no baked id", async () => {
    const { activeDir } = await deployed("resource");
    const al = await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8");
    expect(al).toContain("NavApp.GetResourceAsText('active-mutant.txt'");
    expect(al).toContain("SingleInstance = true;");
  });

  test("activate writes the FILE and leaves the AL byte-identical, which is the cache hit", async () => {
    const { backend, activeDir } = await deployed("resource");
    const before = await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8");
    await backend.activate("M0007");
    expect(await readFile(join(activeDir, "LethALResources", "active-mutant.txt"), "utf8")).toBe(
      "M0007",
    );
    // The load-bearing assertion. al-runner's output-cache key hashes `*.al`, so an unchanged
    // selector is what makes the next run a cache hit instead of a recompile.
    expect(await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8")).toBe(before);
  });

  test("the baseline writes a reserved value that matches no mutant", async () => {
    const { backend, activeDir } = await deployed("resource");
    await backend.activate("M0007");
    await backend.activate(null);
    expect(await readFile(join(activeDir, "LethALResources", "active-mutant.txt"), "utf8")).toBe(
      "NONE",
    );
  });

  test("STATIC remains the default, so nothing changes for a caller that did not ask", async () => {
    const { backend, activeDir } = await deployed("static");
    await backend.activate("M0007");
    const al = await readFile(join(activeDir, "MutationSelector.Codeunit.al"), "utf8");
    expect(al).toContain("exit(MutantId = 'M0007');");
    const manifest = JSON.parse(await readFile(join(activeDir, "app.json"), "utf8")) as {
      resourceFolders?: string[];
    };
    expect(manifest.resourceFolders).toBeUndefined();
  });
});

// R356. The `--coverage-out` scratch directory was created on the first coverage run and never
// removed. The path is read from the argv the fake spawn sees, so the test names the exact
// directory this backend made instead of scanning the shared temp folder.
describe("AlRunnerBackend.close() removes its coverage scratch directory (R356)", () => {
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );

  async function coverageBackend(fail: boolean) {
    const dirs: string[] = [];
    const spawn: SpawnFn = async (argv) => {
      const o = argv.indexOf("--coverage-out");
      const out = o >= 0 ? argv[o + 1] : undefined;
      if (out !== undefined) {
        dirs.push(dirname(out));
        if (!fail) {
          await writeFile(out, "<coverage><packages/></coverage>", "utf8");
        }
      }
      if (fail) throw new Error("spawn failed");
      return {
        exitCode: 0,
        stdout: alRunnerStdout({
          tests: [{ name: QUALIFIED, status: "pass", durationMs: 1 }],
          passed: 1,
          failed: 0,
          errors: 0,
          total: 1,
          exitCode: 0,
        }),
        stderr: "",
      };
    };
    const work = scratch("lethal-r356-work-");
    await writeFile(join(work, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: work,
        testDir: "/tests",
        selectorObjectId: 50000,
        coverage: "al-runner",
      },
      spawn,
    );
    return { backend, dirs };
  }

  test("a backend that read coverage leaves no scratch directory after close()", async () => {
    const { backend, dirs } = await coverageBackend(false);
    await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    const dir = dirs[0] as string;
    expect(dir).toContain("lethal-alrunner-cov-");
    expect(await exists(dir)).toBe(true);
    await backend.close();
    expect(await exists(dir)).toBe(false);
    await backend.close(); // idempotent
  });

  test("a run that fails after the directory was made does not leak it past close()", async () => {
    const { backend, dirs } = await coverageBackend(true);
    await backend.run(ref, { coverage: "none", timeoutMs: 5000 }).catch(() => undefined);
    const dir = dirs[0] as string;
    expect(await exists(dir)).toBe(true);
    await backend.close();
    expect(await exists(dir)).toBe(false);
  });
});

// R488. al-runner's `--test` is a substring match: asking for `...PostingUpdatesTotal` also runs
// `...PostingUpdatesTotalTwin`, in one process, under one deadline, into one Cobertura file. A
// fake al-runner that behaves that way, honouring `--exclude-test` by whole name as the real one
// does (measured on c39ad5de, see the R-488 selector probe).
describe("AlRunnerBackend one-shot: a result naming any other test is never credited (R488)", () => {
  const TWIN = `${QUALIFIED}Twin`;
  const opts = { coverage: "none", timeoutMs: 5000 } as const;

  /** Each test's one covered line in `One.Codeunit.al` (see `COVERED_AL`): 5 is in `Reached`, 10 in
   *  `Other`. */
  const LINE: Record<string, number> = { [QUALIFIED]: 5, [TWIN]: 10 };
  const COVERED_AL = `codeunit 79150 "Probe One"
{
    procedure Reached()
    begin
        exit;
    end;

    procedure Other()
    begin
        exit;
    end;
}
`;

  /** Selects as the real al-runner does (measured on c39ad5de, R-491 brief / R-488 selector probe):
   *  `--test` keeps every name CONTAINING it, ignoring case; each `--exclude-test` drops one WHOLE
   *  name, ignoring case, the requested test included, and excluding that leaves NO tests (exit 0,
   *  probe row x). `honoursExclude: false` models a runner that ignores the excludes. The wanted
   *  test FAILS when the twin ran with it and passes alone, so a credited merged result reads as a
   *  kill, unless `mergedPasses`. With `--coverage-out`, the file holds every test that ran. */
  function substringRunner(honoursExclude: boolean, mergedPasses = false) {
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push([...argv]);
      const pattern = (argv[argv.indexOf("--test") + 1] ?? "").toLowerCase();
      const excluded = honoursExclude
        ? argv.filter((_, i) => argv[i - 1] === "--exclude-test").map((n) => n.toLowerCase())
        : [];
      const ran = [QUALIFIED, TWIN].filter(
        (n) => n.toLowerCase().includes(pattern) && !excluded.includes(n.toLowerCase()),
      );
      const merged = ran.includes(TWIN);
      const tests = ran.map((name) =>
        name === QUALIFIED && merged && !mergedPasses
          ? { name, status: "fail", durationMs: 1, message: "twin's state" }
          : { name, status: "pass", durationMs: 1 },
      );
      const o = argv.indexOf("--coverage-out");
      const out = o >= 0 ? argv[o + 1] : undefined;
      if (out !== undefined) {
        const lines = ran.map((n) => `<line number="${LINE[n]}" hits="1"/>`).join("");
        await writeFile(
          out,
          `<coverage><packages><package><classes><class name="x" filename="One.Codeunit.al"><lines>${lines}</lines></class></classes></package></packages></coverage>`,
          "utf8",
        );
      }
      return { exitCode: 0, stdout: alRunnerStdout({ tests }), stderr: "" };
    };
    return { calls, spawn };
  }

  test("the fake is as strict as al-runner: excluding the requested test itself drops it", async () => {
    const r = substringRunner(true);
    const names = async (...excl: string[]) => {
      const argv = [
        "al-runner",
        "--test",
        QUALIFIED,
        ...excl.flatMap((n) => ["--exclude-test", n]),
      ];
      const out = await r.spawn(argv, {});
      const env = JSON.parse(out.stdout.slice(out.stdout.indexOf("\n{\n") + 1));
      return (env.tests as { name: string }[]).map((t) => t.name);
    };
    expect(await names(QUALIFIED.toLowerCase())).toEqual([TWIN]);
    expect(await names(QUALIFIED, TWIN)).toEqual([]); // probe row x: exit 0, no tests
  });

  test("an excluded REQUESTED test is never learned: the run is not emptied by its own exclude", async () => {
    // A learn step that also excluded `wanted` would get al-runner's empty answer (probe row x).
    const r = substringRunner(true);
    const { backend } = await makeBackend(r.spawn);
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    for (const argv of r.calls) {
      const excludes = argv.filter((_, i) => argv[i - 1] === "--exclude-test");
      expect(excludes.map((n) => n.toLowerCase())).not.toContain(QUALIFIED.toLowerCase());
    }
  });

  test("coverage on: the credited coverage is the re-run's Cobertura, never the merged call's", async () => {
    const r = substringRunner(true, true);
    const dir = scratch("lethal-r491-cov-");
    await writeFile(join(dir, "One.Codeunit.al"), COVERED_AL, "utf8");
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        coverage: "al-runner",
      },
      r.spawn,
    );
    backend.useBuildSymbols([]); // R-300b: what runSession hands over before the first deploy
    const v = await backend.run(ref, opts);
    await backend.close();
    expect(v.outcome).toBe("pass");
    expect(r.calls.length).toBe(2);
    // The merged first call covered BOTH procedures; only the re-run's `Reached` may be credited.
    expect((v.coverage?.entries ?? []).map((e) => e.procedure)).toEqual(["Reached"]);
  });

  test("a result listing the requested test TWICE is refused by name, never credited (R491)", async () => {
    const { calls, spawn } = okSpawn({
      tests: [
        { name: QUALIFIED, status: "pass", durationMs: 1 },
        { name: QUALIFIED, status: "fail", durationMs: 1 },
      ],
    });
    const { backend } = await makeBackend(spawn);
    // Through `runOnce`, which re-sends a retry-safe failure once: the test WAS dispatched, so the
    // refusal must be `completed-accepted` and must not be re-sent.
    const v = await runOnce(backend, new SessionSafety(), ref, opts);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("completed-accepted");
    expect(v.failureMessage).toContain(`"${QUALIFIED}"`);
    expect(v.failureMessage).toContain("2 rows");
    expect(calls.length).toBe(1);
  });

  test("two rows equal to the requested test IGNORING CASE are refused the same way (R491)", async () => {
    const { spawn } = okSpawn({
      tests: [
        { name: QUALIFIED, status: "pass", durationMs: 1 },
        { name: QUALIFIED.toLowerCase(), status: "fail", durationMs: 1 },
      ],
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, opts);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("2 rows");
  });

  test("a merged result is discarded and the test re-runs alone with --exclude-test per sibling", async () => {
    const r = substringRunner(true);
    const { backend } = await makeBackend(r.spawn);
    const v = await backend.run(ref, opts);
    expect(v.outcome).toBe("pass");
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).not.toContain("--exclude-test");
    const second = r.calls[1] ?? [];
    expect(second[second.indexOf("--exclude-test") + 1]).toBe(TWIN);
    // Learned once: the next call excludes up front and runs once.
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    expect(r.calls.length).toBe(3);
    expect(r.calls[2]).toContain(TWIN);
  });

  test("with the discovered list, even the FIRST call excludes the look-alike and runs once", async () => {
    const r = substringRunner(true);
    const { backend } = await makeBackend(r.spawn);
    backend.useDiscoveredTests([
      ref,
      { ...ref, method: `${ref.method}Twin` },
      { ...ref, method: "Unrelated" },
    ]);
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    expect(r.calls.length).toBe(1);
    const first = r.calls[0] ?? [];
    expect(first.filter((a) => a === "--exclude-test").length).toBe(1);
    expect(first[first.indexOf("--exclude-test") + 1]).toBe(TWIN);
  });

  test("a discovered name equal to the requested one IGNORING CASE is never excluded", async () => {
    // Excluding it would empty the run: al-runner then exits 0 with no tests (measured).
    const { calls, spawn } = okSpawn({
      tests: [{ name: QUALIFIED, status: "pass", durationMs: 1 }],
    });
    const { backend } = await makeBackend(spawn);
    backend.useDiscoveredTests([ref, { ...ref, method: ref.method.toLowerCase() }]);
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    expect(calls[0]).not.toContain("--exclude-test");
  });

  test("a result that still names another test after its excludes is refused by name", async () => {
    const r = substringRunner(false);
    const { backend } = await makeBackend(r.spawn);
    const v = await backend.run(ref, opts);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain(TWIN);
    expect(r.calls.length).toBe(2);
    // R491: the test WAS dispatched and ran, so the refusal is not retry-safe pre-dispatch.
    expect(v.operation).toBe("completed-accepted");
  });

  test("an exact single-test result is credited from one call with today's argv", async () => {
    const { calls, spawn } = okSpawn({
      tests: [{ name: QUALIFIED, status: "fail", durationMs: 1 }],
    });
    const { backend } = await makeBackend(spawn);
    expect((await backend.run(ref, opts)).outcome).toBe("fail");
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain("--exclude-test");
  });
});

describe("AlRunnerBackend --server: a daemon that overran or timed out is never reused (R517)", () => {
  type Row = Record<string, unknown>;
  /**
   * One fake daemon per spawn. `answer(daemon, request, emit)` writes the lines for runTests
   * `request` on daemon `daemon` (both 1-based), or returns a function that writes them later
   * (`releaseHeld`), which is how a test holds an answer past the client's deadline.
   */
  function daemons(
    answer: (daemon: number, request: number, emit: (row: Row) => void) => (() => void) | undefined,
  ) {
    const argvs: string[][] = [];
    const held: Array<() => void> = [];
    const spawn: ServerSpawnFn = (argv) => {
      argvs.push([...argv]);
      const daemon = argvs.length;
      let requests = 0;
      const queue: Array<Uint8Array | null> = [];
      let waiter: (() => void) | undefined;
      const push = (chunk: Uint8Array | null): void => {
        queue.push(chunk);
        waiter?.();
        waiter = undefined;
      };
      const emitLine = (line: string): void => push(new TextEncoder().encode(`${line}\n`));
      queueMicrotask(() => emitLine('{"ready":true}'));
      return {
        write: (line: string) => {
          const req = JSON.parse(line) as { command?: string };
          if (req.command === "runTests") {
            requests += 1;
            const later = answer(daemon, requests, (row) => emitLine(JSON.stringify(row)));
            if (later !== undefined) held.push(later);
          }
          if (req.command === "shutdown") emitLine('{"status":"shutting down"}');
        },
        stdout: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (queue.length === 0) {
                await new Promise<void>((r) => {
                  waiter = r;
                });
                continue;
              }
              const next = queue.shift();
              if (next === null || next === undefined) return;
              yield next;
            }
          },
        },
        stderr: {
          async *[Symbol.asyncIterator]() {},
        },
        kill: () => push(null),
      };
    };
    return {
      spawn,
      argvs,
      releaseHeld: () => {
        for (const r of held.splice(0)) r();
      },
    };
  }

  function serverOn(spawn: ServerSpawnFn): AlRunnerBackend {
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: scratch("lethal-alrunner-r517-"),
        testDir: "/tests",
        selectorObjectId: 50000,
        serverMode: true,
      },
      okSpawn({ tests: [] }).spawn,
      spawn,
    );
    // R517 D1: the session hands every backend its floor before the first run.
    backend.useMutantBudgetFloor(180_000, 120_000);
    return backend;
  }

  const t = (method: string) => ({ codeunitId: 79100, codeunitName: "Sandbox Tests", method });
  const run = { coverage: "none" as const, timeoutMs: 1000 };
  const summary = (total: number): Row => ({ type: "summary", exitCode: 1, total });

  test("C1: a runTests that throws (here: no summary before the deadline) ends the daemon, so its late answer is never read as the retry's", async () => {
    // Every row is a `fail` whose message names the daemon and request it came from.
    const fake = daemons((daemon, request, emit) => {
      const rows = (): void => {
        emit({
          type: "test",
          name: "Codeunit79100.A",
          status: "fail",
          message: `daemon ${daemon} request ${request}`,
        });
        emit(summary(1));
      };
      if (daemon === 1 && request === 1) return rows; // answered only after the deadline
      rows();
      return undefined;
    });
    const backend = serverOn(fake.spawn);
    let first: TestVerdict | undefined;
    jest.useFakeTimers();
    try {
      void backend.run(t("A"), run).then((v) => {
        first = v;
      });
      for (let i = 0; i < 200 && first === undefined; i++) {
        jest.advanceTimersByTime(60_000);
        for (let k = 0; k < 50; k++) await Promise.resolve();
      }
    } finally {
      jest.useRealTimers();
    }
    expect(first?.outcome).toBe("error");
    expect(first?.failureMessage).toContain("no summary line within");
    // Daemon 1's late answer arrives now; runOnce's retry runs the same activation again.
    fake.releaseHeld();
    const retry = await backend.run(t("A"), run);
    expect([retry.outcome, retry.failureMessage]).toEqual(["fail", "daemon 2 request 1"]);
    expect(fake.argvs.length).toBe(2);
    // And the next activation is answered by daemon 2's next request, never daemon 1's.
    await backend.activate("M0002");
    const next = await backend.run(t("A"), run);
    expect([next.outcome, next.failureMessage]).toEqual(["fail", "daemon 2 request 2"]);
    expect(fake.argvs.length).toBe(2);
    await backend.close();
  });

  /** Daemon 1's first suite: A passes, BSlow times out, Later (after it) has no row. Every other
   *  suite: all three pass. `message` is the timeout row's text (default al-runner's per-test one). */
  function hungOnce(timeoutRow: boolean, message = "Test exceeded 180s timeout.") {
    return daemons((daemon, request, emit) => {
      const first = daemon === 1 && request === 1;
      emit({ type: "test", name: "Codeunit79100.A", status: "pass", durationMs: 5 });
      if (first && timeoutRow) {
        emit({
          type: "test",
          name: "Codeunit79100.BSlow",
          status: "error",
          errorKind: "timeout",
          message,
          durationMs: 180_004,
        });
        emit(summary(2));
        return undefined;
      }
      emit({ type: "test", name: "Codeunit79100.BSlow", status: "pass", durationMs: 7 });
      emit({ type: "test", name: "Codeunit79100.Later", status: "pass", durationMs: 3 });
      emit(summary(3));
      return undefined;
    });
  }

  test("I2: a suite with a timeout row ends the daemon, and the unmutated confirm runs on a fresh one with the same stop", async () => {
    const fake = hungOnce(true);
    const backend = serverOn(fake.spawn);
    await backend.activate("M0001");
    expect((await backend.run(t("BSlow"), run)).outcome).toBe("timeout");
    await backend.activate(null);
    const confirm = await backend.run(t("BSlow"), run);
    expect(fake.argvs.length).toBe(2);
    expect(confirm.outcome).toBe("pass");
    const [one, two] = fake.argvs;
    expect(two).toEqual(one);
    expect(one).toContain("--test-timeout");
    await backend.close();
  });

  test("I-1: an OnRun-trigger timeout row (status error, wording the timeout regex does not match) still ends the daemon", async () => {
    // R534: the measured OnRun wording is now a classified timeout (T2 below). This keeps what I-1
    // guards, the STRUCTURAL close, with a wording no timeout regex matches.
    const fake = hungOnce(true, "OnRun trigger did not complete");
    const backend = serverOn(fake.spawn);
    await backend.activate("M0001");
    // The verdict still reads the wording: not a classified timeout, so never a kill.
    expect((await backend.run(t("BSlow"), run)).outcome).toBe("error");
    await backend.activate(null);
    expect((await backend.run(t("BSlow"), run)).outcome).toBe("pass");
    expect(fake.argvs.length).toBe(2);
    await backend.close();
  });

  test("I2 control: a suite with no timeout row keeps its daemon across activations", async () => {
    const fake = hungOnce(false);
    const backend = serverOn(fake.spawn);
    await backend.activate("M0001");
    expect((await backend.run(t("BSlow"), run)).outcome).toBe("pass");
    await backend.activate(null);
    expect((await backend.run(t("BSlow"), run)).outcome).toBe("pass");
    expect(fake.argvs.length).toBe(1);
    await backend.close();
  });

  test("M3: a covering test with no row in a suite that has a timeout row is an error naming the hung test", async () => {
    const fake = hungOnce(true);
    const backend = serverOn(fake.spawn);
    await backend.activate("M0001");
    await backend.run(t("BSlow"), run);
    const later = await backend.run(t("Later"), run);
    expect(later.outcome).toBe("error");
    expect(later.failureMessage).toContain(
      'al-runner --server stopped the run at "Codeunit79100.BSlow" (timeout); tests after it have no row',
    );
    await backend.close();
  });

  describe("an answered row never aborts (R534)", () => {
    /** `backend.run`, counted, so a test can say how many times runOnce sent it. */
    function counted(backend: AlRunnerBackend): { runs: () => number } {
      let n = 0;
      const inner = backend.run.bind(backend);
      backend.run = async (r, o) => {
        n += 1;
        return inner(r, o);
      };
      return { runs: () => n };
    }

    test("T2: the --server OnRun-trigger timeout row (measure.md B verbatim) is a timeout in the OnRun, and the daemon is not reused", async () => {
      const fake = hungOnce(
        true,
        "The test codeunit's OnRun trigger exceeded the 10s timeout, so none of its test methods ran.",
      );
      const backend = serverOn(fake.spawn);
      await backend.activate("M0001");
      const v = await backend.run(t("BSlow"), run);
      expect([v.outcome, v.reportedStopMs, v.timeoutIn]).toEqual(["timeout", 10_000, "onrun"]);
      await backend.activate(null);
      expect((await backend.run(t("BSlow"), run)).outcome).toBe("pass");
      expect(fake.argvs.length).toBe(2);
      await backend.close();
    });

    test("T6: a covering test with no row after a hung one is runner-test-error, presumed, sent once; with no hung row it stays pre-dispatch-rejected and is retried", async () => {
      const fake = hungOnce(true);
      const backend = serverOn(fake.spawn);
      await backend.activate("M0001");
      await backend.run(t("BSlow"), run);
      const c = counted(backend);
      const later = await runOnce(backend, new SessionSafety(), t("Later"), run);
      expect([later.outcome, later.operation, later.runnerRow]).toEqual([
        "error",
        "completed-accepted",
        "runner-test-error",
      ]);
      expect(later.failureMessage).toContain("presumably");
      expect(c.runs()).toBe(1);
      await backend.close();

      // Control: the same missing row with no hung test in the suite.
      const plain = daemons((_d, _r, emit) => {
        emit({ type: "test", name: "Codeunit79100.A", status: "pass", durationMs: 5 });
        emit(summary(1));
        return undefined;
      });
      const other = serverOn(plain.spawn);
      await other.activate("M0001");
      const o = counted(other);
      const missing = await runOnce(other, new SessionSafety(), t("Later"), run);
      expect([missing.outcome, missing.operation, missing.runnerRow]).toEqual([
        "error",
        "pre-dispatch-rejected",
        undefined,
      ]);
      expect(o.runs()).toBe(2);
      await other.close();
    });

    test("T6 OnRun (final review M-a): after an OnRun-wording hang the hung test is named, so a missing row is runner-test-error, sent once", async () => {
      const fake = hungOnce(
        true,
        "The test codeunit's OnRun trigger exceeded the 180s timeout, so none of its test methods ran.",
      );
      const backend = serverOn(fake.spawn);
      await backend.activate("M0001");
      expect((await backend.run(t("BSlow"), run)).outcome).toBe("timeout");
      const c = counted(backend);
      const later = await runOnce(backend, new SessionSafety(), t("Later"), run);
      expect([later.outcome, later.operation, later.runnerRow]).toEqual([
        "error",
        "completed-accepted",
        "runner-test-error",
      ]);
      expect(later.failureMessage).toContain(
        'al-runner --server stopped the run at "Codeunit79100.BSlow" (timeout)',
      );
      expect(c.runs()).toBe(1);
      await backend.close();
    });
  });
});

describe("AlRunnerBackend one-shot: a test timeout exits 3 (R518)", () => {
  const opts = { coverage: "none", timeoutMs: 40_000 } as const;

  // The envelope al-runner 2.12.0-main.43f76177 printed for a one-shot run whose test hit its
  // in-run stop (/coord/handoff/R-518/measure.md run 1), names changed to this file's `ref`.
  const timeoutExit3 = {
    tests: [
      {
        name: QUALIFIED,
        status: "error",
        durationMs: 40_072,
        message: "Test exceeded 40s timeout.",
        stackTrace: '"Sandbox Logic"(CodeUnit 79000).SpinFor line 8',
      },
    ],
    passed: 0,
    failed: 0,
    errors: 1,
    skipped: 0,
    total: 1,
    exitCode: 3,
    seed: 598161538,
    suiteErrors: [
      {
        file: "/tests",
        errors: [
          "tests: TEST-TIMEOUT-ABORT: Sandbox Tests (Codeunit79100).PostingUpdatesTotal: watchdog timeout aborted the run — 0 further [Test] method(s) in this codeunit did not run (0 total)",
        ],
      },
    ],
    wallSeconds: 41.8,
  };

  test("REPRO: a timeout-only exit 3 is a `timeout` with its reported stop, sent once, never an error retried as pre-dispatch-rejected", async () => {
    const { calls, spawn } = okSpawn(timeoutExit3, 3);
    const { backend } = await makeBackend(spawn);
    const v = await runOnce(backend, new SessionSafety(), ref, opts);
    expect(v.outcome).toBe("timeout");
    expect(v.reportedStopMs).toBe(40_000);
    expect(calls.length).toBe(1);
  });

  // Plan D2's last point: a TEST-TIMEOUT abort whose row is not a known timeout wording (here an
  // invented one; R534 made al-runner's measured OnRun-trigger wording a classified timeout, T1).
  // The transport accepts the envelope (the row is explained by the abort); the backend scores it
  // the fail-closed `error`, never `timeout`, and (R534 D1b) flags the unknown wording.
  test("an OnRun-trigger exit 3 is accepted as rows but scored a fail-closed error, never timeout", async () => {
    const onRun = {
      ...timeoutExit3,
      tests: [
        {
          name: QUALIFIED,
          status: "error",
          durationMs: 40_072,
          message: "OnRun trigger did not complete",
        },
      ],
    };
    const { calls, spawn } = okSpawn(onRun, 3);
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, opts);
    expect(v.outcome).toBe("error");
    // The row's own message, so the transport read the envelope (its refusal would carry stderr).
    expect(v.failureMessage).toContain(AL_RUNNER_UNCLASSIFIED_ERROR);
    expect(v.failureMessage).toContain("OnRun trigger did not complete");
    expect(v.reportedStopMs).toBeUndefined();
    expect(v.timeoutWordingUnknown).toBe(true);
    expect(calls.length).toBe(1);
  });

  // `--test` is a substring match (R488). If the look-alike sibling hangs first, its row and the
  // abort name IT, and the wanted test has no row: the backend learns the sibling and re-sends the
  // wanted test alone.
  test("a sibling that hangs first is learned from the exit 3 and the wanted test re-runs alone", async () => {
    const TWIN = `${QUALIFIED}Twin`;
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push([...argv]);
      if (argv.includes("--exclude-test")) {
        const tests = [{ name: QUALIFIED, status: "pass", durationMs: 3 }];
        return { exitCode: 0, stdout: alRunnerStdout({ tests }), stderr: "" };
      }
      const hung = {
        ...timeoutExit3,
        tests: [
          {
            name: TWIN,
            status: "error",
            durationMs: 40_072,
            message: "Test exceeded 40s timeout.",
          },
        ],
        suiteErrors: [
          {
            file: "/tests",
            errors: [
              "tests: TEST-TIMEOUT-ABORT: Sandbox Tests (Codeunit79100).PostingUpdatesTotalTwin: watchdog timeout aborted the run — 0 further [Test] method(s) in this codeunit did not run (0 total)",
            ],
          },
        ],
      };
      return { exitCode: 3, stdout: alRunnerStdout(hung), stderr: "stderr text" };
    };
    const { backend } = await makeBackend(spawn);
    const v = await runOnce(backend, new SessionSafety(), ref, opts);
    expect(v.outcome).toBe("pass");
    expect(calls.length).toBe(2);
    const second = calls[1] ?? [];
    expect(second[second.indexOf("--exclude-test") + 1]).toBe(TWIN);
  });
});

/**
 * R534. An al-runner row is an ANSWER: al-runner ran the test, reported and exited. So it is never
 * re-sent and never a spec §11 abort. It is a `timeout` when it provably is one (now also the
 * test codeunit's OnRun trigger), a `runner-refused` error when al-runner refused a surface
 * (`<Type>: out-of-scope: ...`), and otherwise a `runner-test-error` error. Rows below are the ones
 * measured on al-runner 2.12.0-main.43f76177 (/coord/handoff/R-534/measure.md), names kept.
 */
describe("AlRunnerBackend: an answered row never aborts (R534)", () => {
  const ONRUN_MESSAGE_20 =
    "The test codeunit's OnRun trigger exceeded the 20s timeout, so none of its test methods ran.";
  const hangRef = { codeunitId: 79660, codeunitName: "R534 OnRun Hang", method: "AfterHang" };
  const hangOpts = { coverage: "none", timeoutMs: 20_000 } as const;
  // measure.md A1, the one-shot envelope verbatim, with N = the budget (20 s) as LethAL sends it.
  const onRunExit3 = {
    tests: [
      {
        name: "Codeunit79660.AfterHang",
        status: "error",
        durationMs: 20001,
        message: ONRUN_MESSAGE_20,
        stackTrace:
          '"R534 Probe Logic"(CodeUnit 79640).SpinFor line 8 - R534 Probe by LethAL version 1.0.0.0\n"R534 OnRun Hang"(CodeUnit 79660).OnRun(Trigger) line 4 - R534 Probe Tests by LethAL version 1.0.0.0',
      },
    ],
    passed: 0,
    failed: 0,
    errors: 1,
    skipped: 0,
    total: 1,
    exitCode: 3,
    seed: 1953595511,
    suiteErrors: [
      {
        file: "/coord/handoff/R-534/probe/tests",
        errors: [
          "tests: TEST-TIMEOUT-ABORT: R534 OnRun Hang (Codeunit79660).AfterHang: watchdog timeout aborted the run — 0 further [Test] method(s) in this codeunit did not run (0 total)",
        ],
      },
    ],
    wallSeconds: 16.276267,
  };

  test("T1 REPRO: an OnRun-trigger hang (exit 3) is a timeout in the OnRun, with its reported stop, sent ONCE", async () => {
    const { calls, spawn } = okSpawn(onRunExit3, 3);
    const { backend } = await makeBackend(spawn);
    const v = await runOnce(backend, new SessionSafety(), hangRef, hangOpts);
    expect([v.outcome, v.reportedStopMs, v.timeoutIn]).toEqual(["timeout", 20_000, "onrun"]);
    expect(calls.length).toBe(1);
  });

  test("T1b: a body timeout row, in either measured wording, records timeoutIn body", () => {
    for (const message of ["Test exceeded 40s timeout.", "TIMEOUT after 30s"]) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, { status: "error", message }, 10, undefined);
      expect([v.outcome, v.timeoutIn], message).toEqual(["timeout", "body"]);
    }
  });

  // measure.md A, rows HandlerUnused (verbatim), plus the two other shapes al-runner's source
  // writes as `error` without a test verdict: an unsupported signature and a `skipped` row.
  const HANDLER_UNUSED = "The following UI handlers were not executed: ConfirmYes";
  const answeredRows: ReadonlyArray<{ status: string; message?: string }> = [
    { status: "error", message: HANDLER_UNUSED },
    { status: "error", message: "unsupported test signature (1 params)" },
    { status: "skipped" },
  ];

  test("T3 REPRO: an unexecuted UI handler, an unsupported signature and a skipped row are runner-test-error, completed-accepted, sent ONCE", async () => {
    for (const row of answeredRows) {
      const { calls, spawn } = okSpawn(
        { tests: [{ name: QUALIFIED, durationMs: 71, ...row }], exitCode: 1 },
        1,
      );
      const { backend } = await makeBackend(spawn);
      const v = await runOnce(backend, new SessionSafety(), ref, {
        coverage: "none",
        timeoutMs: 5000,
      });
      const label = row.message ?? row.status;
      expect([v.outcome, v.operation, v.runnerRow], label).toEqual([
        "error",
        "completed-accepted",
        "runner-test-error",
      ]);
      expect(v.failureMessage, label).toContain(AL_RUNNER_UNCLASSIFIED_ERROR);
      expect(v.failureMessage, label).toContain(row.message ?? '"skipped"');
      expect(v.failureMessage, label).toContain("not re-sent and does not stop the session (R534)");
      expect(calls.length, label).toBe(1);
    }
  });

  test("T4: near-miss timeout wordings stay runner-test-error, never a timeout", () => {
    for (const message of [
      "The test codeunit's OnRun trigger exceeded the timeout, so none of its test methods ran.",
      `${ONRUN_MESSAGE_20} Later`,
      `TIMEOUT ${ONRUN_MESSAGE_20}`,
      "An OnAfterTestMethodRun subscriber (codeunit 50100) failed: boom (test result before it: Test exceeded 5s timeout.)",
      "Test exceeded 5s timeout. extra",
      // Final review I-A: a user OnBeforeTestMethodRun subscriber raising the timeout wording.
      // Only `^` refuses these (`$` matches them), so a lost `^` alone would be a false kill.
      "An OnBeforeTestMethodRun subscriber (codeunit 50100) failed, so the test did not run: NavNCLDialogException: Test exceeded 5s timeout.",
      `An OnBeforeTestMethodRun subscriber (codeunit 50100) failed, so the test did not run: NavNCLDialogException: ${ONRUN_MESSAGE_20}`,
    ]) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, { status: "error", message }, 10, undefined);
      expect([v.outcome, v.runnerRow, v.reportedStopMs, v.timeoutIn], message).toEqual([
        "error",
        "runner-test-error",
        undefined,
        undefined,
      ]);
    }
  });

  // measure.md A rows OosInBody and AfterOosOnRun verbatim; the InvalidOperationException row is
  // the source's Cecil-injected throw (NclCecilRewrite.Reports.cs), same `out-of-scope: ` prefix.
  const OOS_TASK =
    "RunnerOutOfScopeException: out-of-scope: TaskScheduler.TaskExists — task-scheduler — the runner has no scheduler and no scheduled-task store, so it cannot say whether a task exists; BC's real body queries the scheduled-task table over a SQL connection that does not exist here. Nothing is ever scheduled: CanCreateTask() is false and CreateTask() is refused by BC's own guard, so no task can have been created either — see docs/scope.md#jobs";
  const refusals: ReadonlyArray<{ status: string; message: string }> = [
    { status: "fail", message: OOS_TASK },
    {
      status: "fail",
      message:
        "InvalidOperationException: out-of-scope: NavReport.Run — reports — see docs/scope.md",
    },
    {
      status: "error",
      message: `The test codeunit's OnRun trigger failed, so none of its test methods ran (as in BC): ${OOS_TASK}`,
    },
  ];

  test("T5: an out-of-scope refusal (any exception type, body or OnRun) is runner-refused, never a kill", async () => {
    for (const row of refusals) {
      const { calls, spawn } = okSpawn(
        { tests: [{ name: QUALIFIED, durationMs: 71, ...row }], exitCode: 1 },
        1,
      );
      const { backend } = await makeBackend(spawn);
      const v = await runOnce(backend, new SessionSafety(), ref, {
        coverage: "none",
        timeoutMs: 5000,
      });
      expect([v.outcome, v.operation, v.runnerRow], row.message).toEqual([
        "error",
        "completed-accepted",
        "runner-refused",
      ]);
      // The row's own words lead the note (the pre-commitment's B3 reads its start).
      expect(v.failureMessage?.startsWith(row.message), row.message).toBe(true);
      expect(calls.length, row.message).toBe(1);
    }
  });

  test("T5 near-miss: a user message that merely CONTAINS the phrase stays a fail (a kill)", () => {
    // The second is final review M-b: a type-shaped word later in the message. Only `^` refuses it.
    for (const message of [
      "NavNCLDialogException: expected 3, got out-of-scope: x",
      "NavNCLDialogException: wrapped Foo: out-of-scope: x",
    ]) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, { status: "fail", message }, 10, undefined);
      expect([v.outcome, v.runnerRow], message).toEqual(["fail", undefined]);
    }
  });

  test("T7: a row an exit-3 abort line names, in no known timeout wording, is runner-test-error flagged timeoutWordingUnknown; on exit 1 it is not flagged", async () => {
    const watchdog = {
      ...onRunExit3,
      tests: [{ name: "Codeunit79660.AfterHang", status: "error", message: "Watchdog stop." }],
    };
    const proven = await makeBackend(okSpawn(watchdog, 3).spawn);
    const v = await proven.backend.run(hangRef, hangOpts);
    expect([v.outcome, v.runnerRow, v.timeoutWordingUnknown]).toEqual([
      "error",
      "runner-test-error",
      true,
    ]);
    const { suiteErrors: _, ...noAbort } = watchdog;
    const plain = await makeBackend(okSpawn({ ...noAbort, exitCode: 1 }, 1).spawn);
    const w = await plain.backend.run(hangRef, hangOpts);
    expect([w.outcome, w.runnerRow, w.timeoutWordingUnknown]).toEqual([
      "error",
      "runner-test-error",
      undefined,
    ]);
  });
});
