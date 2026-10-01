import type { ServerSpawnFn } from "../../src/al-runner-server";

/**
 * A fake `al-runner --server` daemon: prints the readiness line, then answers each `runTests` with
 * the given test lines and a summary, or, with `silent`, never answers it at all (a hung suite).
 */
export function fakeAlRunnerServer(
  tests: ReadonlyArray<{ name: string; status: string; message?: string }>,
  opts: { silent?: boolean; onRunTests?: () => void } = {},
): { spawn: ServerSpawnFn; runs: () => number } {
  let runs = 0;
  const spawn: ServerSpawnFn = () => {
    const queue: Array<Uint8Array | null> = [];
    let waiter: (() => void) | undefined;
    const push = (chunk: Uint8Array | null): void => {
      queue.push(chunk);
      waiter?.();
      waiter = undefined;
    };
    const emit = (line: string): void => push(new TextEncoder().encode(`${line}\n`));
    queueMicrotask(() => emit('{"ready":true}'));
    return {
      write: (line: string) => {
        const req = JSON.parse(line) as { command?: string };
        if (req.command === "runTests") {
          runs += 1;
          opts.onRunTests?.();
          if (opts.silent === true) return;
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
