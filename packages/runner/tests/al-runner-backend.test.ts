import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME } from "@lethal/schemata";
import {
  AL_RUNNER_SERVER_MODE_REFUSED,
  AL_RUNNER_UNCLASSIFIED_ERROR,
  AlRunnerBackend,
} from "../src/al-runner-backend";
import { MsInMemoryBackend } from "../src/ms-inmemory-backend";
import { requiresUnsafeLatch } from "../src/operation-outcome";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";

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
  const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-"));
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
    const sourceDir = await mkdtemp(join(tmpdir(), "lethal-alrunner-batch-"));
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

    const batch1 = await mkdtemp(join(tmpdir(), "lethal-alrunner-batch1-"));
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
    const batch2 = await mkdtemp(join(tmpdir(), "lethal-alrunner-batch2-"));
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
    const sourceDir = await mkdtemp(join(tmpdir(), "lethal-alrunner-control-"));
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
    const sourceDir = await mkdtemp(join(tmpdir(), "lethal-alrunner-artifact-"));
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
    const sourceDir = await mkdtemp(join(tmpdir(), "lethal-alrunner-corrupt-"));
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
    const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-lazyid-"));
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

describe("AlRunnerBackend.compileCheck", () => {
  // al-runner has no publish step of its own — deploy() is already just a local file copy, and
  // the actual `alc` invocation happens lazily inside run(), per test. So bisection's
  // compile-only seam has nothing to withhold here: compileCheck() delegating straight to the
  // existing deploy() IS the compile-only behaviour for this backend. Proven by driving the
  // real compileCheck() (not a re-implementation) and observing the exact same file-copy
  // side effect deploy() itself produces.
  test("delegates to deploy(): copies the candidate dir into <instrumentedDir>/active", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    const sourceDir = await mkdtemp(join(tmpdir(), "lethal-alrunner-candidate-"));
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
  // score a mutant off whatever test happened to be in the payload.
  test("finds the requested test by its qualified name", async () => {
    const { spawn } = okSpawn({
      tests: [
        { name: "Codeunit79100.SomeoneElse", status: "fail", message: "not ours" },
        { name: "Codeunit79100.OverBudgetDetected", status: "pass" },
      ],
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
    expect(v.operation).toBe("pre-dispatch-rejected");
  });

  test("our own deadline is outcome=deadline-exceeded, not timeout", async () => {
    const spawn = async () => new Promise<never>(() => {}) as never;
    const { backend } = await makeBackend(spawn as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
  });

  // Regression guard for the timeout-margin bug: the backend's own derivation of the runner's
  // per-test budget (from opts.timeoutMs) must leave al-runner's internal timeout comfortably
  // BELOW our client deadline, never >= it. Otherwise our AbortController always wins the
  // Promise.race and the runner-confirmed `outcome: "timeout"` path exercised above becomes
  // unreachable in real execution — every genuine mutant-induced hang would be misclassified as
  // deadline-exceeded (infrastructure noise). This drives the real backend.run() path (not a
  // re-implementation of the formula) so a regression in the derivation itself fails this test.
  // v2 delivers the budget as AL_RUNNER_TEST_TIMEOUT_SEC rather than a `--test-timeout` flag;
  // the value and its reason are unchanged.
  test("the per-test budget env var leaves real margin below the client deadline", async () => {
    for (const timeoutMs of [5000, 14000, 120000]) {
      const { envs, spawn } = okSpawn({
        tests: [{ name: QUALIFIED, status: "pass" }],
      });
      const { backend } = await makeBackend(spawn);
      await backend.run(ref, { coverage: "none", timeoutMs });
      const raw = envs[0]?.AL_RUNNER_TEST_TIMEOUT_SEC;
      expect(raw).toBeDefined();
      expect(Number(raw) * 1000).toBeLessThan(timeoutMs);
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

describe("AlRunnerBackend serverMode refusal", () => {
  // R97. Constructing the backend must throw, not fall back to the one-shot transport silently:
  // a config that asked for server mode and quietly got something else is the same class of lie
  // as the empty green result the refusal was originally built for.
  //
  // The REASON changed on 2026-08-08 and the test changed with it. It used to assert the string
  // "1658" — the upstream issue for "the server reads only sourcePaths[0]" — and that defect is
  // FIXED in al-runner 2.1.0.0 (measured: `sourcePaths: [sourceDir, testDir]` runs both bundles,
  // total 2 / passed 2). Asserting a stale cause would have kept a fixed upstream bug alive in
  // this suite forever. What is refused now is measured here and now: no per-test selection in
  // the server protocol, against a run() called once per test.
  test("constructing with serverMode:true throws the refusal, naming R97", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-server-"));
    const construct = () =>
      new AlRunnerBackend(
        {
          alRunnerPath: "al-runner",
          instrumentedDir: dir,
          testDir: "/tests",
          selectorObjectId: 50000,
          serverMode: true,
        },
        okSpawn({ tests: [] }).spawn,
      );
    expect(construct).toThrow(/R97/);
    // By identity, not by re-quoting the sentence: two spellings of the refusal would let the
    // shipped one drift while this stayed green.
    expect(construct).toThrow(AL_RUNNER_SERVER_MODE_REFUSED);
  });

  // The refusal has to say what to DO, not only that something is wrong. A message naming the
  // roadmap row but not the config key leaves a reader with a run that will not start and no
  // next step.
  test("the refusal names the config key to remove and the transport it falls back to", () => {
    expect(AL_RUNNER_SERVER_MODE_REFUSED).toContain('"serverMode"');
    expect(AL_RUNNER_SERVER_MODE_REFUSED).toContain("one-shot");
  });

  test("serverMode:false still constructs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-server-off-"));
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
});

describe("AlRunnerBackend capabilities", () => {
  test("in-memory profile", async () => {
    const { backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    expect(backend.capabilities()).toEqual({
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
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
