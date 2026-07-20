import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { MsInMemoryBackend } from "../src/ms-inmemory-backend";
import { requiresUnsafeLatch } from "../src/operation-outcome";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

function okSpawn(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { exitCode, stdout: JSON.stringify(payload), stderr: "" };
  };
  return { calls, spawn };
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
  test("spawns al-runner with --run and parses a pass", async () => {
    const { calls, spawn } = okSpawn({
      tests: [{ name: "PostingUpdatesTotal", status: "pass", durationMs: 3 }],
      passed: 1,
      failed: 0,
      errors: 0,
      total: 1,
      exitCode: 0,
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("pass");
    expect(calls[0]).toContain("--run");
    expect(calls[0]).toContain("PostingUpdatesTotal");
    expect(calls[0]).toContain("--output-json");
    // D3: al-runner defaults to `codeunit` isolation — LethAL must force
    // `method` isolation so behavior matches the advertised `full-reset`
    // capability.
    const argv = calls[0] ?? [];
    const flagIdx = argv.indexOf("--test-isolation");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(argv[flagIdx + 1]).toBe("method");
  });

  test("exit 1 with fail result maps to fail", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: "PostingUpdatesTotal",
            status: "fail",
            durationMs: 3,
            message: "boom",
            stackTrace: "at PostingUpdatesTotal",
            alSourceLine: 8,
            alSourceColumn: 37,
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

  test("exit 2 maps to skip, exit 3 maps to error", async () => {
    for (const [code, outcome] of [
      [2, "skip"],
      [3, "error"],
    ] as const) {
      const { backend } = await makeBackend(okSpawn({ tests: [] }, code).spawn);
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
      expect(v.outcome).toBe(outcome);
    }
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

  test("a runner-confirmed test timeout is outcome=timeout", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: "PostingUpdatesTotal",
            status: "fail",
            durationMs: 0,
            message:
              "Test exceeded 3s timeout. Use --test-timeout 0 to disable timeout, or increase with --test-timeout <seconds>.",
          },
        ],
      },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("timeout");
  });

  test("an ordinary assertion failure is still outcome=fail", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: "PostingUpdatesTotal",
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

  test("our own deadline is outcome=deadline-exceeded, not timeout", async () => {
    const spawn = async () => new Promise<never>(() => {}) as never;
    const { backend } = await makeBackend(spawn as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
  });

  // Regression guard for the timeout-margin bug: the backend's own derivation
  // of --test-timeout (from opts.timeoutMs) must leave al-runner's internal
  // timeout comfortably BELOW our client deadline, never >= it. Otherwise our
  // AbortController always wins the Promise.race and the runner-confirmed
  // `outcome: "timeout"` path exercised above becomes unreachable in real
  // execution — every genuine mutant-induced hang would be misclassified as
  // deadline-exceeded (infrastructure noise). This drives the real
  // backend.run() path (not a re-implementation of the formula) so a
  // regression in the derivation itself fails this test.
  test("--test-timeout leaves real margin below the client deadline", async () => {
    for (const timeoutMs of [5000, 14000, 120000]) {
      const { calls, spawn } = okSpawn({
        tests: [{ name: "PostingUpdatesTotal", status: "pass" }],
      });
      const { backend } = await makeBackend(spawn);
      await backend.run(ref, { coverage: "none", timeoutMs });
      const argv = calls[0] ?? [];
      const idx = argv.indexOf("--test-timeout");
      expect(idx).toBeGreaterThanOrEqual(0);
      const seconds = Number(argv[idx + 1]);
      expect(seconds * 1000).toBeLessThan(timeoutMs);
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
  // D2: al-runner has no --version flag (it errors out); --help is the
  // verified reachability probe (exits 0).
  test("probes with --help, not --version", async () => {
    const calls: string[][] = [];
    const spawn = async (argv: readonly string[]) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "usage: al-runner ...", stderr: "" };
    };
    const { backend } = await makeBackend(spawn);
    const status = await backend.status();
    expect(status.ok).toBe(true);
    expect(calls[0]).toContain("--help");
    expect(calls[0]).not.toContain("--version");
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
