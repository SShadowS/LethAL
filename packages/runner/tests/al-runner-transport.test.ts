import { describe, expect, test } from "bun:test";
import {
  OneShotTransport,
  ServerTransport,
  parseAlRunnerPayload,
  qualifiedTestName,
} from "../src/al-runner-transport";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";

const req = {
  sourceDir: "/instr",
  testDir: "/tests",
  qualifiedTest: "Codeunit79100.PostingUpdatesTotal",
  testTimeoutSeconds: 5,
  deadlineMs: 5000,
};

function recording(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push([...argv]);
    envs.push(opts?.env);
    return { exitCode, stdout: alRunnerStdout(payload), stderr: "" };
  };
  return { calls, envs, spawn };
}

describe("qualifiedTestName", () => {
  test("builds v2's Codeunit<id>.<method> form", () => {
    expect(qualifiedTestName(79100, "PostingUpdatesTotal")).toBe(
      "Codeunit79100.PostingUpdatesTotal",
    );
  });
});

describe("parseAlRunnerPayload", () => {
  // The reason this function exists. Real v2 stdout carries a progress banner before the
  // envelope, and one of those banner lines contains a `{` — so both `JSON.parse(stdout)` and a
  // "cut at the first brace anywhere" rule fail on it, while the correct rule (last line
  // beginning with `{` at column zero) does not.
  test("extracts the envelope from banner-polluted stdout, past a banner line containing a brace", () => {
    const stdout = alRunnerStdout({
      tests: [
        { name: "Codeunit79601.FailsLoudly", status: "fail", durationMs: 7, message: "boom" },
      ],
      passed: 0,
      failed: 1,
      errors: 0,
      total: 1,
      exitCode: 1,
    });
    // Guard on the fixture itself: if the banner ever stops containing a brace, this test
    // silently stops proving the thing it was written for.
    expect(stdout.split("\n").some((l) => !l.startsWith("{") && l.includes("{"))).toBe(true);
    expect(() => JSON.parse(stdout)).toThrow();

    const tests = parseAlRunnerPayload(stdout);
    expect(tests).toHaveLength(1);
    expect(tests[0]?.name).toBe("Codeunit79601.FailsLoudly");
    expect(tests[0]?.status).toBe("fail");
    expect(tests[0]?.message).toBe("boom");
  });

  test("a compact one-line envelope with no banner parses too", () => {
    const tests = parseAlRunnerPayload(
      JSON.stringify({
        tests: [{ name: "Codeunit1.A", status: "pass", durationMs: 3 }],
        passed: 1,
      }),
    );
    expect(tests).toEqual([{ name: "Codeunit1.A", status: "pass", durationMs: 3 }]);
  });

  // These used to return `[]`. An empty test list reads exactly like "the filter matched no
  // tests" — the caller sees no failing test and scores the mutant SURVIVED. That is the
  // silently-empty confirmation this project keeps getting bitten by (R97), so each must throw,
  // and the message must quote what the runner actually said so a human can act on it.
  test("stdout with no JSON envelope THROWS, quoting the output", () => {
    const stdout =
      "[r2r] re-execing with DOTNET_ReadyToRun=0 ...\nal-runner - running 1 bundle(s)\n";
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/no --output-json envelope/);
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/re-execing/);
  });

  test("an envelope with no tests array THROWS — a compile failure must not read as 'no test failed'", () => {
    // The measured exit-3 shape: compilationErrors[] and no tests at all.
    const stdout = alRunnerStdout({
      compilationErrors: ["error AL0111: The name 'Foo' does not exist"],
      exitCode: 3,
    });
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/no "tests" array/);
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/compilationErrors/);
  });

  test("a truncated envelope THROWS instead of yielding an empty list", () => {
    expect(() => parseAlRunnerPayload('{"tests": [{"name":')).toThrow(/not valid JSON/);
  });
});

describe("OneShotTransport", () => {
  test("sends the v2 argv: --output-json, --isolation test, --test <qualified>, positional bundle dirs", async () => {
    const { calls, spawn } = recording({
      tests: [{ name: "Codeunit79100.PostingUpdatesTotal", status: "pass" }],
    });
    const t = new OneShotTransport("al-runner", spawn);
    const res = await t.send({ ...req, packagesDir: "/packages" });
    expect(res.kind).toBe("tests");
    const argv = calls[0] ?? [];
    expect(argv).toContain("--output-json");

    // `test` (fresh state per [Test]), never `method` — v2 accepts `method` only as a v1 alias
    // for `codeunit`, i.e. the WEAKER isolation this backend does not claim (R96).
    const isoIdx = argv.indexOf("--isolation");
    expect(isoIdx).toBeGreaterThanOrEqual(0);
    expect(argv[isoIdx + 1]).toBe("test");
    expect(argv).not.toContain("method");

    const testIdx = argv.indexOf("--test");
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(argv[testIdx + 1]).toBe("Codeunit79100.PostingUpdatesTotal");

    // Bundle dirs are positional and repeatable in v2, source before tests.
    expect(argv).toContain("/instr");
    expect(argv).toContain("/tests");
    expect(argv.indexOf("/instr")).toBeLessThan(argv.indexOf("/tests"));

    const cacheIdx = argv.indexOf("--package-cache");
    expect(cacheIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cacheIdx + 1]).toBe("/packages");

    // Every v1 spelling is gone. v2 answers an unknown flag with exit 2, so leaving any of
    // these in would turn every mutant into a process-level failure.
    for (const dead of ["--run", "--packages", "--stubs", "--test-timeout", "--test-isolation"]) {
      expect(argv).not.toContain(dead);
    }
  });

  test("the per-test budget travels as the AL_RUNNER_TEST_TIMEOUT_SEC env var, not a flag", async () => {
    const { envs, spawn } = recording({ tests: [] });
    await new OneShotTransport("al-runner", spawn).send({ ...req, testTimeoutSeconds: 42 });
    expect(envs[0]).toEqual({ AL_RUNNER_TEST_TIMEOUT_SEC: "42" });
  });

  // R95. Exit 2 means a bundle could not EXECUTE — the runner never ran the mutant, so there is
  // no verdict. It used to map to `kind: "skip"`, which turned that process-level failure into a
  // silently skipped mutant carrying no error anyone would look at.
  test("exit 2 (could not execute) and exit 3 (could not compile) are BOTH kind=error", async () => {
    for (const code of [2, 3, -1]) {
      const spawn: SpawnFn = async () => ({
        exitCode: code,
        stdout: "",
        stderr: `bundle blew up (exit ${code})`,
      });
      const res = await new OneShotTransport("al-runner", spawn).send(req);
      expect(res.kind).toBe("error");
      if (res.kind === "error") expect(res.detail).toContain(`exit ${code}`);
    }
  });

  test("exit 1 still carries verdicts — a failing test is a result, not an error", async () => {
    const { spawn } = recording(
      { tests: [{ name: req.qualifiedTest, status: "fail", message: "boom" }] },
      1,
    );
    const res = await new OneShotTransport("al-runner", spawn).send(req);
    expect(res.kind).toBe("tests");
    if (res.kind === "tests") expect(res.tests[0]?.status).toBe("fail");
  });

  test("a hung process yields kind=deadline", async () => {
    const spawn = (async () => new Promise(() => {})) as never;
    const res = await new OneShotTransport("al-runner", spawn).send({ ...req, deadlineMs: 40 });
    expect(res.kind).toBe("deadline");
  });

  // The two timers measure different things and must never be equal: the runner's own per-test
  // budget (v2: the AL_RUNNER_TEST_TIMEOUT_SEC env var) bounds only the test body inside
  // al-runner, while `deadlineMs` bounds the WHOLE invocation (al-runner recompiles the project
  // from scratch every call, which alone can take several seconds). If al-runner's own timeout
  // were >= our client deadline, our AbortController would always win the race and the
  // runner-confirmed `outcome: "timeout"` path would be unreachable in real execution — every
  // genuine hang would be misclassified as infrastructure noise instead of a real timeout.
  // Pinned directly from the spawned env (no real-timer race) against several representative
  // budgets — the same margin formula AlRunnerBackend uses (`Math.max(1,
  // Math.floor(deadlineMs / 2000))`).
  test("the runner's own per-test budget always leaves real margin below the client deadline", async () => {
    for (const deadlineMs of [2000, 5000, 14000, 120000]) {
      const testTimeoutSeconds = Math.max(1, Math.floor(deadlineMs / 2000));
      const { envs, spawn } = recording({ tests: [] });
      await new OneShotTransport("al-runner", spawn).send({
        ...req,
        testTimeoutSeconds,
        deadlineMs,
      });
      const seconds = Number(envs[0]?.AL_RUNNER_TEST_TIMEOUT_SEC);
      // Sub-second edge case: budgets under ~2000ms clamp to the 1s floor, at which
      // point the client may still win the race. Acceptable and honest — not
      // something to engineer around — so this isn't asserted for every budget below
      // the threshold, only for the representative set above where real margin exists.
      expect(seconds * 1000).toBeLessThan(deadlineMs);
    }
  });
});

/** Scripted stand-in for the al-runner server process. */
function fakeIo(responses: unknown[]) {
  const written: string[] = [];
  let resolveNext: ((v: IteratorResult<string>) => void) | null = null;
  const queue: string[] = ['{"ready":true}'];
  let killed = false;
  let starts = 0;
  const push = (l: string) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: l, done: false });
    } else queue.push(l);
  };
  const io = {
    start() {
      starts++;
      return {
        write(line: string) {
          written.push(line);
          const req = JSON.parse(line) as { command: string };
          if (req.command === "shutdown") return push('{"status":"shutting down"}');
          const next = responses.shift() ?? { tests: [] };
          push(JSON.stringify(next));
        },
        lines(): AsyncIterableIterator<string> {
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            next(): Promise<IteratorResult<string>> {
              const q = queue.shift();
              if (q !== undefined) return Promise.resolve({ value: q, done: false });
              return new Promise((res) => {
                resolveNext = res;
              });
            },
          } as AsyncIterableIterator<string>;
        },
        kill() {
          killed = true;
        },
      };
    },
  };
  return { io, written, wasKilled: () => killed, startCount: () => starts };
}

describe("ServerTransport", () => {
  test("consumes the handshake and sends a runTests command with both source dirs", async () => {
    const { io, written } = fakeIo([{ tests: [{ name: "A", status: "pass", durationMs: 2 }] }]);
    const t = new ServerTransport("al-runner", io);
    const res = await t.send({ ...req, qualifiedTest: "Codeunit1.A" });
    expect(res.kind).toBe("tests");
    const sent = JSON.parse(written[0] ?? "{}") as { command: string; sourcePaths: string[] };
    expect(sent.command).toBe("runTests");
    expect(sent.sourcePaths).toEqual(["/instr", "/tests"]);
    await t.close();
  });

  test("reuses one process across requests (handshake read once)", async () => {
    const { io, written } = fakeIo([
      { tests: [{ name: "A", status: "pass" }] },
      { tests: [{ name: "A", status: "pass" }] },
    ]);
    const t = new ServerTransport("al-runner", io);
    await t.send({ ...req, qualifiedTest: "Codeunit1.A" });
    await t.send({ ...req, qualifiedTest: "Codeunit1.A" });
    expect(written).toHaveLength(2);
    await t.close();
  });

  test("an {error} response becomes kind=error", async () => {
    const { io } = fakeIo([{ error: "sourcePaths is required" }]);
    const t = new ServerTransport("al-runner", io);
    const res = await t.send(req);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.detail).toContain("sourcePaths is required");
    await t.close();
  });

  test("close shuts the process down", async () => {
    const { io, wasKilled } = fakeIo([]);
    const t = new ServerTransport("al-runner", io);
    await t.send(req);
    await t.close();
    expect(wasKilled()).toBe(true);
  });

  test("a stalled handshake resolves via the deadline instead of hanging forever", async () => {
    let killed = false;
    const io = {
      start() {
        return {
          write() {
            // Never reached: the deadline fires before a runTests command would be sent.
          },
          lines(): AsyncIterableIterator<string> {
            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              next(): Promise<IteratorResult<string>> {
                // Simulates a wrong binary / stalled startup: no `{"ready":true}` ever arrives.
                return new Promise(() => {});
              },
            } as AsyncIterableIterator<string>;
          },
          kill() {
            killed = true;
          },
        };
      },
    };
    const t = new ServerTransport("al-runner", io);
    const res = await t.send({ ...req, deadlineMs: 30 });
    expect(res.kind).toBe("deadline");
    expect(killed).toBe(true);
    await t.close();
  });

  test("two concurrent sends are serialized: each gets its own response, one process starts", async () => {
    const { io, written, startCount } = fakeIo([
      { tests: [{ name: "A", status: "pass" }] },
      { tests: [{ name: "B", status: "pass" }] },
    ]);
    const t = new ServerTransport("al-runner", io);
    const [a, b] = await Promise.all([
      t.send({ ...req, qualifiedTest: "Codeunit1.A" }),
      t.send({ ...req, qualifiedTest: "Codeunit1.B" }),
    ]);
    expect(a.kind).toBe("tests");
    expect(b.kind).toBe("tests");
    if (a.kind === "tests") expect(a.tests[0]?.name).toBe("A");
    if (b.kind === "tests") expect(b.tests[0]?.name).toBe("B");
    expect(written).toHaveLength(2);
    expect(startCount()).toBe(1);
    await t.close();
  });

  // M2: both the handshake deadline (ensureStarted) and the per-response
  // deadline (sendLocked) must be cleared once the real response wins the
  // race — otherwise a timer stays armed for up to `deadlineMs` (120s on
  // baseline runs) after every fast response, keeping an embedder's event
  // loop alive for no reason. OneShotTransport already gets this right (its
  // own `finally { clearTimeout(timer) }`); this proves ServerTransport now
  // matches it, by spying on the real global timer functions rather than
  // re-deriving the count from the transport's own state.
  test("clears its handshake and response deadline timers after a fast round trip", async () => {
    const { io } = fakeIo([{ tests: [{ name: "A", status: "pass" }] }]);
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const armed = new Set<unknown>();
    global.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle = originalSetTimeout(fn as never, ms, ...args);
      armed.add(handle);
      return handle;
    }) as typeof setTimeout;
    global.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      armed.delete(handle);
      return originalClearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      const t = new ServerTransport("al-runner", io);
      const res = await t.send({ ...req, qualifiedTest: "Codeunit1.A" });
      expect(res.kind).toBe("tests");
      // Both the handshake timer and the response timer must be gone — a
      // regression that only fixes one of the two sites would leave this at 1.
      expect(armed.size).toBe(0);
      await t.close();
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });
});
