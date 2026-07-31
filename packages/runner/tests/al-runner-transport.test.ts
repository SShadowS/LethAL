import { describe, expect, test } from "bun:test";
import {
  OneShotTransport,
  ServerTransport,
  parseAlRunnerPayload,
} from "../src/al-runner-transport";

const req = {
  sourceDir: "/instr",
  testDir: "/tests",
  method: "PostingUpdatesTotal",
  testTimeoutSeconds: 5,
  deadlineMs: 5000,
};

function recording(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { exitCode, stdout: JSON.stringify(payload), stderr: "" };
  };
  return { calls, spawn };
}

describe("parseAlRunnerPayload", () => {
  test("reads the envelope's tests array", () => {
    const tests = parseAlRunnerPayload(
      JSON.stringify({ tests: [{ name: "A", status: "pass", durationMs: 3 }], passed: 1 }),
    );
    expect(tests).toEqual([{ name: "A", status: "pass", durationMs: 3 }]);
  });
  test("missing tests array yields empty, not a throw", () => {
    expect(parseAlRunnerPayload(JSON.stringify({ passed: 0 }))).toEqual([]);
  });
});

describe("OneShotTransport", () => {
  test("v2 dialect: positional dirs, --test, --output-json, isolation=test, no --run/--test-timeout", async () => {
    const { calls, spawn } = recording({
      tests: [{ name: "PostingUpdatesTotal", status: "pass" }],
    });
    const t = new OneShotTransport("al-runner", spawn);
    const res = await t.send(req);
    expect(res.kind).toBe("tests");
    const argv = calls[0] ?? [];
    expect(argv).not.toContain("--run");
    expect(argv).not.toContain("--test-timeout");
    expect(argv).toContain(req.sourceDir);
    expect(argv).toContain(req.testDir);
    expect(argv).toContain("--test");
    expect(argv).toContain("PostingUpdatesTotal");
    expect(argv).toContain("--output-json");
    expect(argv).toContain("--test-isolation");
    expect(argv).toContain("test");
    expect(argv).not.toContain("method");
  });

  // v2 has no "skip" exit code — 2 is now a process-level execution error
  // (same severity class as 3, a compile error), not v1's soft "runner
  // limitations only" signal. See al-runner issue #1648.
  test("exit 2 and exit 3 are both kind=error", async () => {
    for (const code of [2, 3] as const) {
      const { spawn } = recording({ tests: [] }, code);
      const res = await new OneShotTransport("al-runner", spawn).send(req);
      expect(res.kind).toBe("error");
    }
  });

  test("a hung process yields kind=deadline", async () => {
    const spawn = (async () => new Promise(() => {})) as never;
    const res = await new OneShotTransport("al-runner", spawn).send({ ...req, deadlineMs: 40 });
    expect(res.kind).toBe("deadline");
  });

  // v2 accepts no --test-timeout (al-runner issue #1648: fixed, unconfigurable
  // 60s internal timeout). The margin this test used to pin from argv no
  // longer applies at the CLI level; `deadlineMs` (this transport's own
  // AbortController, see "a hung process yields kind=deadline" above) is now
  // the only client-side timeout lever. Revisit once #1648 ships a flag.
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
    const res = await t.send({ ...req, method: "A" });
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
    await t.send({ ...req, method: "A" });
    await t.send({ ...req, method: "A" });
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
      t.send({ ...req, method: "A" }),
      t.send({ ...req, method: "B" }),
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
      const res = await t.send({ ...req, method: "A" });
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
