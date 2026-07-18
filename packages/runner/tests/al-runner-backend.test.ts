import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { MsInMemoryBackend } from "../src/ms-inmemory-backend";

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
});
