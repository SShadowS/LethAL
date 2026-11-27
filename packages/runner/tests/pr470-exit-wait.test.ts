import { describe, expect, test } from "bun:test";
import {
  AlRunnerServer,
  SHUTDOWN_EXIT_WAIT_MS,
  type ServerProcessHandle,
  isShutdownAnswer,
} from "../src/al-runner-server";

/**
 * R1233 (PR-470, al-runner #9232; pre-commitment 2026-11-27-pr470-exit-wait-after-shutdown.md): after its
 * shutdown reply a serve daemon writes its workspace cache, then exits. `close()` lets it exit by itself,
 * bounded, and signals only one still running past the bound. Event order is recorded, never timed.
 */
type Shape = {
  readonly replies: boolean;
  readonly exitsAfterReply: boolean;
  /** The line read after `shutdown`; default al-runner's acknowledgement. */
  readonly answer?: string;
};

function fakeDaemon(shape: Shape) {
  const events: string[] = [];
  const queue: (string | null)[] = ['{"ready":true}'];
  let wake: (() => void) | undefined;
  const push = (l: string | null) => {
    queue.push(l);
    wake?.();
    wake = undefined;
  };
  let exited = false;
  let exit: () => void = () => undefined;
  const exitP = new Promise<void>((r) => {
    exit = () => {
      if (exited) return;
      exited = true;
      events.push("exited");
      push(null);
      r();
    };
  });
  const proc: ServerProcessHandle = {
    write: (line) => {
      if (!line.includes('"shutdown"')) return;
      events.push("shutdown");
      if (!shape.replies) return;
      push(shape.answer ?? '{"status":"shutting down"}');
      events.push("replied");
      // the cache write, then the exit, a moment after the reply (never, for a daemon that hangs)
      if (shape.exitsAfterReply) setTimeout(exit, 5);
    },
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const l = queue.shift();
          if (l === null) return;
          if (l !== undefined) {
            yield new TextEncoder().encode(`${l}\n`);
            continue;
          }
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      },
    },
    stderr: {
      async *[Symbol.asyncIterator]() {},
    },
    kill: () => {
      events.push("kill");
      exit();
    },
    wait: () => {
      events.push("wait");
      return exitP;
    },
  };
  return { proc, events, kills: () => events.filter((e) => e === "kill").length };
}

async function closeOf(shape: Shape, boundMs: number) {
  const d = fakeDaemon(shape);
  const server = new AlRunnerServer("al-runner", () => d.proc, [], "serve");
  server.shutdownExitWaitMs = boundMs;
  await server.start(2000);
  await server.close();
  return d;
}

describe("R1233: close() lets a daemon that answered exit by itself", () => {
  test("the bound is the pre-committed 5 s", () => {
    expect(SHUTDOWN_EXIT_WAIT_MS).toBe(5000);
  });

  test("a daemon that replies and exits within the bound is never signalled", async () => {
    // A huge bound: close() returns as soon as the process exits, not at the bound.
    const d = await closeOf({ replies: true, exitsAfterReply: true }, 60_000);
    expect(d.kills()).toBe(0);
    // it exited on its own, after the reply, and close() awaited that exit
    expect(d.events.indexOf("exited")).toBeGreaterThan(d.events.indexOf("replied"));
    expect(d.events).not.toContain("kill");
  });

  test("a daemon that replies but never exits is signalled once, after the bound", async () => {
    const d = await closeOf({ replies: true, exitsAfterReply: false }, 30);
    expect(d.kills()).toBe(1);
    // the exit was awaited first (the bound ran out), then the signal, then the exit it caused
    const waitAt = d.events.indexOf("wait");
    const killAt = d.events.indexOf("kill");
    expect(waitAt).toBeGreaterThan(d.events.indexOf("replied"));
    expect(killAt).toBeGreaterThan(waitAt);
    expect(d.events.indexOf("exited")).toBeGreaterThan(killAt);
  });

  test("a late row of a request still running is not the answer: signalled without the exit wait", async () => {
    // Build review: a busy daemon reads `shutdown` only after its request, so it would not exit in the bound.
    const d = await closeOf(
      {
        replies: true,
        exitsAfterReply: false,
        answer: '{"type":"test","name":"Codeunit1.A","status":"pass"}',
      },
      60_000,
    );
    expect(d.kills()).toBe(1);
    expect(d.events.indexOf("kill")).toBeLessThan(d.events.indexOf("wait"));
  });

  test("isShutdownAnswer: EOF and a non-row JSON line are the answer; a request row, non-JSON or a timeout are not", () => {
    expect(isShutdownAnswer({ kind: "eof" })).toBe(true);
    expect(isShutdownAnswer({ kind: "line", line: '{"status":"shutting down"}' })).toBe(true);
    for (const type of ["test", "entrySummary", "summary"]) {
      expect(isShutdownAnswer({ kind: "line", line: JSON.stringify({ type }) })).toBe(false);
    }
    expect(isShutdownAnswer({ kind: "line", line: "not json" })).toBe(false);
    expect(isShutdownAnswer({ kind: "line", line: "[1]" })).toBe(false);
    expect(isShutdownAnswer({ kind: "timeout" })).toBe(false);
  });

  test("a daemon that never replies is signalled without the exit wait", async () => {
    // A huge bound: waiting for the exit here would hang past the test's own timeout.
    const d = await closeOf({ replies: false, exitsAfterReply: false }, 60_000);
    expect(d.kills()).toBe(1);
    // the signal comes before any wait for the exit (the reap after it is the only wait)
    expect(d.events.indexOf("kill")).toBeLessThan(d.events.indexOf("wait"));
  });
});
