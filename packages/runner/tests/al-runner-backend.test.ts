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
      tests: [
        { codeunit: "Sandbox Tests", method: "PostingUpdatesTotal", result: "pass", durationMs: 3 },
      ],
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("pass");
    expect(calls[0]).toContain("--run");
    expect(calls[0]).toContain("PostingUpdatesTotal");
    expect(calls[0]).toContain("--output-json");
  });

  test("exit 1 with fail result maps to fail", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            codeunit: "Sandbox Tests",
            method: "PostingUpdatesTotal",
            result: "fail",
            durationMs: 3,
            message: "boom",
          },
        ],
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
  test("timeout aborts the spawned child via AbortSignal", async () => {
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
    expect(v.outcome).toBe("timeout");
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
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
