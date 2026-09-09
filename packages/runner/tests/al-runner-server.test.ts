import { describe, expect, test } from "bun:test";
import {
  AlRunnerServer,
  type ServerProcessHandle,
  type ServerSpawnFn,
} from "../src/al-runner-server";

/**
 * A fake daemon: replies are scripted per request, so the PROTOCOL DECODE is tested without a
 * binary.
 *
 * That is the half worth testing here. A live run proves the happy path and nothing else — it
 * cannot show what happens when the summary never arrives, when a line is unparseable, or when a
 * future al-runner adds a line type this client has never seen. Each of those is a way the deleted
 * 2.0.0.0 transport failed silently, and each is a test below.
 */
class FakeServer implements ServerProcessHandle {
  readonly written: string[] = [];
  killed = false;
  private pushOut: ((chunk: Uint8Array | null) => void) | undefined;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;

  constructor(
    private readonly onRequest: (
      req: Record<string, unknown>,
      emit: (line: string) => void,
      end: () => void,
    ) => void,
    stderrText = "",
  ) {
    const queue: Array<Uint8Array | null> = [];
    let waiter: (() => void) | undefined;
    this.pushOut = (chunk) => {
      queue.push(chunk);
      waiter?.();
      waiter = undefined;
    };
    this.stdout = {
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
    };
    this.stderr = {
      async *[Symbol.asyncIterator]() {
        if (stderrText !== "") yield new TextEncoder().encode(stderrText);
      },
    };
  }

  /** Emit a raw line on stdout, exactly as the daemon would. */
  emit(line: string): void {
    this.pushOut?.(new TextEncoder().encode(`${line}\n`));
  }

  endStdout(): void {
    this.pushOut?.(null);
  }

  write(line: string): void {
    this.written.push(line);
    const req = JSON.parse(line) as Record<string, unknown>;
    this.onRequest(
      req,
      (l) => this.emit(l),
      () => this.endStdout(),
    );
  }

  kill(): void {
    this.killed = true;
    this.endStdout();
  }
}

/**
 * Returns the server plus a LAZY accessor for the fake, never the fake itself: it does not exist
 * until `start()` spawns it, and destructuring it eagerly reads `undefined`.
 */
function serverWith(
  onRequest: (req: Record<string, unknown>, emit: (line: string) => void, end: () => void) => void,
  opts: { ready?: string | null; stderr?: string } = {},
): { server: AlRunnerServer; handle: () => FakeServer } {
  let fake: FakeServer | undefined;
  const spawn: ServerSpawnFn = () => {
    const f = new FakeServer(onRequest, opts.stderr ?? "");
    fake = f;
    // The readiness line arrives on its own, before any request, exactly as documented.
    const ready = opts.ready === undefined ? '{"ready":true}' : opts.ready;
    if (ready !== null) queueMicrotask(() => f.emit(ready));
    return f;
  };
  return {
    server: new AlRunnerServer("al-runner.exe", spawn),
    handle: () => {
      if (fake === undefined) throw new Error("the fake server has not been spawned yet");
      return fake;
    },
  };
}

const summary = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "summary", exitCode: 0, passed: 1, failed: 0, total: 1, ...extra });

describe("AlRunnerServer.start", () => {
  test("accepts the documented readiness line", async () => {
    const { server } = serverWith(() => undefined);
    await server.start(2000);
    await server.close();
  });

  test("REFUSES a first line that is not JSON, rather than waiting for a summary that never comes", async () => {
    // stdout is documented to carry only the protocol. Banners belong on stderr, so a banner here
    // means this is not the protocol we think it is.
    const { server } = serverWith(() => undefined, { ready: "al-runner v2.11.0 starting..." });
    await expect(server.start(2000)).rejects.toThrow(/not JSON/);
  });

  test("REFUSES JSON that is not the readiness signal", async () => {
    const { server } = serverWith(() => undefined, { ready: '{"type":"summary","total":0}' });
    await expect(server.start(2000)).rejects.toThrow(/not the readiness signal/);
  });

  test("times out with the stderr tail, which is where the daemon explains itself", async () => {
    const { server } = serverWith(() => undefined, {
      ready: null,
      stderr: "[bc] artifact download failed",
    });
    await expect(server.start(150)).rejects.toThrow(
      /did not print its readiness line within 150 ms/,
    );
  });
});

describe("AlRunnerServer.runTests", () => {
  test("collects every streamed test line and stops at the summary", async () => {
    const { server } = serverWith((_req, emit) => {
      emit(
        JSON.stringify({ type: "test", name: "Codeunit79100.A", status: "pass", durationMs: 3 }),
      );
      emit(
        JSON.stringify({ type: "test", name: "Codeunit79100.B", status: "fail", message: "boom" }),
      );
      emit(summary({ total: 2 }));
    });
    await server.start(2000);
    const res = await server.runTests({ sourcePaths: ["app", "tests"] }, 2000);
    expect(res.tests.map((t) => [t.name, t.status])).toEqual([
      ["Codeunit79100.A", "pass"],
      ["Codeunit79100.B", "fail"],
    ]);
    expect(res.tests[1]?.message).toBe("boom");
    expect(res.total).toBe(2);
    await server.close();
  });

  test("carries perTestCoverage through, which is why the server path is worth having", async () => {
    const ptc = [
      {
        test: "Codeunit79100.A",
        coverage: [{ file: "src/X.al", statements: [{ scope: "DoThing", line: 5, hits: 1 }] }],
      },
    ];
    const { server } = serverWith((_req, emit) => {
      emit(JSON.stringify({ type: "test", name: "Codeunit79100.A", status: "pass" }));
      emit(summary({ perTestCoverage: ptc }));
    });
    await server.start(2000);
    const res = await server.runTests({ sourcePaths: ["app"], perTestCoverage: true }, 2000);
    expect(res.perTestCoverage[0]?.test).toBe("Codeunit79100.A");
    expect(res.perTestCoverage[0]?.coverage?.[0]?.statements?.[0]?.scope).toBe("DoThing");
    await server.close();
  });

  test("sends testIsolation explicitly, never relying on the server's weaker default", async () => {
    // The server defaults to "codeunit"; the CLI path this replaces sends `--isolation test`, and
    // `capabilities().isolation` claims full-reset on the strength of it. R96 is the record of that
    // distinction being bought silently once already.
    const { server, handle } = serverWith((_req, emit) => emit(summary()));
    await server.start(2000);
    await server.runTests({ sourcePaths: ["app"], testIsolation: "test" }, 2000);
    const sent = JSON.parse(handle().written[0] ?? "{}") as Record<string, unknown>;
    expect(sent.command).toBe("runTests");
    expect(sent.testIsolation).toBe("test");
    await server.close();
  });

  test("never sends affectedOnly, which would drop a covering test", async () => {
    const { server, handle } = serverWith((_req, emit) => emit(summary()));
    await server.start(2000);
    await server.runTests({ sourcePaths: ["app"] }, 2000);
    const sent = JSON.parse(handle().written[0] ?? "{}") as Record<string, unknown>;
    expect("affectedOnly" in sent).toBe(false);
    await server.close();
  });

  test("IGNORES an unknown line type, so a new protocol line is not a crash", async () => {
    const { server } = serverWith((_req, emit) => {
      emit(JSON.stringify({ type: "progress", percent: 50 }));
      emit(JSON.stringify({ type: "test", name: "Codeunit79100.A", status: "pass" }));
      emit(summary());
    });
    await server.start(2000);
    const res = await server.runTests({ sourcePaths: ["app"] }, 2000);
    expect(res.tests).toHaveLength(1);
    await server.close();
  });

  test("REFUSES an unparseable line rather than skipping it", async () => {
    // Skipping is how a decoder keeps "working" against a protocol it no longer speaks, which is
    // exactly how the 2.0.0.0 transport produced an empty test list and scored every mutant
    // survived.
    const { server } = serverWith((_req, emit) => {
      emit("Exception: something went wrong");
      emit(summary());
    });
    await server.start(2000);
    await expect(server.runTests({ sourcePaths: ["app"] }, 2000)).rejects.toThrow(
      /unparseable stdout line/,
    );
    await server.close();
  });

  test("refuses when the summary never arrives, naming how many tests it saw", async () => {
    const { server } = serverWith((_req, emit) => {
      emit(JSON.stringify({ type: "test", name: "Codeunit79100.A", status: "pass" }));
      // ...and then nothing. A hung run must not hang the session.
    });
    await server.start(2000);
    await expect(server.runTests({ sourcePaths: ["app"] }, 150)).rejects.toThrow(
      /no summary line within 150 ms \(1 test line\(s\) seen\)/,
    );
    await server.close();
  });

  test("refuses when stdout ends early, which is what a crashed daemon looks like", async () => {
    const { server } = serverWith((_req, _emit, end) => end());
    await server.start(2000);
    await expect(server.runTests({ sourcePaths: ["app"] }, 2000)).rejects.toThrow(
      /stdout ended before the summary/,
    );
    await server.close();
  });

  test("refuses runTests before start, rather than writing to nothing", async () => {
    const { server } = serverWith((_req, emit) => emit(summary()));
    await expect(server.runTests({ sourcePaths: ["app"] }, 500)).rejects.toThrow(
      /called before start/,
    );
  });
});

describe("AlRunnerServer.close", () => {
  test("sends shutdown and kills the process", async () => {
    const { server, handle } = serverWith((req, emit) => {
      if (req.command === "shutdown") emit(JSON.stringify({ status: "shutting down" }));
    });
    await server.start(2000);
    await server.close();
    const last = JSON.parse(handle().written[handle().written.length - 1] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(last.command).toBe("shutdown");
    expect(handle().killed).toBe(true);
  });

  test("is idempotent, so a failed start followed by close does not throw", async () => {
    const { server } = serverWith((_req, emit) => emit(summary()));
    await server.close();
    await server.close();
  });
});
