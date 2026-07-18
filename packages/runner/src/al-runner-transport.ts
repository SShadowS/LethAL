import { type SpawnFn, defaultSpawn } from "./publisher";

export interface AlRunnerRequest {
  readonly sourceDir: string;
  readonly testDir: string;
  readonly method: string;
  readonly packagesDir?: string;
  readonly stubsDir?: string;
  readonly testTimeoutSeconds: number;
  readonly deadlineMs: number;
}

export interface AlRunnerRawTest {
  readonly name: string;
  readonly status: string;
  readonly durationMs?: number;
  readonly message?: string;
}

export type AlRunnerResult =
  | { readonly kind: "tests"; readonly tests: readonly AlRunnerRawTest[] }
  | { readonly kind: "deadline" }
  | { readonly kind: "skip"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

export interface AlRunnerTransport {
  send(req: AlRunnerRequest): Promise<AlRunnerResult>;
  close(): Promise<void>;
}

export function parseAlRunnerPayload(stdout: string): readonly AlRunnerRawTest[] {
  const parsed = JSON.parse(stdout) as { tests?: AlRunnerRawTest[] };
  return parsed.tests ?? [];
}

/** One al-runner process per request. Correct, and pays full compilation each time. */
export class OneShotTransport implements AlRunnerTransport {
  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {}

  async send(req: AlRunnerRequest): Promise<AlRunnerResult> {
    const argv = [
      this.alRunnerPath,
      "--run",
      req.method,
      req.sourceDir,
      req.testDir,
      "--output-json",
      // al-runner defaults to `codeunit` isolation (state shared within a
      // codeunit); force `method` to match the advertised full-reset capability.
      "--test-isolation",
      "method",
      "--test-timeout",
      String(req.testTimeoutSeconds),
    ];
    if (req.packagesDir) argv.push("--packages", req.packagesDir);
    if (req.stubsDir) argv.push("--stubs", req.stubsDir);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        this.spawn(argv, { signal: controller.signal }),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("deadline");
          }, req.deadlineMs);
        }),
      ]);
      if (res === "deadline") return { kind: "deadline" };
      if (res.exitCode === 2) return { kind: "skip", detail: res.stdout || res.stderr };
      if (res.exitCode === 3 || res.exitCode < 0)
        return { kind: "error", detail: res.stderr || res.stdout };
      return { kind: "tests", tests: parseAlRunnerPayload(res.stdout) };
    } catch (err) {
      return { kind: "error", detail: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // nothing retained between requests
  }
}

export interface ServerProcess {
  write(line: string): void;
  lines(): AsyncIterableIterator<string>;
  kill(): void;
}
export interface ServerIo {
  start(): ServerProcess;
}

const defaultServerIo = (alRunnerPath: string): ServerIo => ({
  start(): ServerProcess {
    const proc = Bun.spawn([alRunnerPath, "--server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    return {
      write(line) {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      },
      lines(): AsyncIterableIterator<string> {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              const nl = buf.indexOf("\n");
              if (nl >= 0) {
                const l = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (l.length > 0) return { value: l, done: false };
                continue;
              }
              const { value, done } = await reader.read();
              if (done) return { value: undefined as never, done: true };
              buf += dec.decode(value, { stream: true });
            }
          },
        } as AsyncIterableIterator<string>;
      },
      kill() {
        proc.kill();
      },
    };
  },
});

/**
 * Keeps ONE al-runner process warm. It caches compiled assemblies under a
 * SHA256 fingerprint of source CONTENTS (8-entry LRU), so a mutant that
 * rewrites MutationSelector.Codeunit.al still pays a recompile — but every test
 * for that mutant afterwards is near-free.
 *
 * `runTests` has no per-procedure field, so the whole suite runs each time and
 * the requested method is picked out of the results. That is acceptable here:
 * this backend reports coverage:"none", so the orchestrator already runs every
 * test per mutant.
 *
 * NEVER move the selector into `--stubs` to dodge recompiles: stubPaths are
 * excluded from the cache fingerprint, so that yields a cache HIT serving a
 * stale assembly — fast, silent, wrong verdicts.
 */
export class ServerTransport implements AlRunnerTransport {
  private proc: ServerProcess | undefined;
  private iter: AsyncIterableIterator<string> | undefined;
  private readonly io: ServerIo;

  /**
   * The wire protocol carries NO request/response correlation id — al-runner
   * just emits one JSON line per `runTests`/`shutdown` write, in that order.
   * Two overlapping `send()` calls on one instance would otherwise race: both
   * could see `this.proc === undefined` and double-spawn, or call B's write
   * could land between call A's write and A's response read, silently
   * attributing one mutant's result to another. Every `send()` — including
   * the `ensureStarted()` spawn/handshake it may trigger — is threaded
   * through this promise chain so overlapping callers queue instead of
   * interleaving. Inert while the orchestrator stays sequential, but Task 6's
   * parallel workers are exactly the consumer that would otherwise trip it.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(alRunnerPath: string, io?: ServerIo) {
    this.io = io ?? defaultServerIo(alRunnerPath);
  }

  private async ensureStarted(
    deadlineMs: number,
  ): Promise<{ proc: ServerProcess; iter: AsyncIterableIterator<string> } | "deadline"> {
    const existing = this.proc;
    const existingIter = this.iter;
    if (existing !== undefined && existingIter !== undefined)
      return { proc: existing, iter: existingIter };
    const proc = this.io.start();
    const iter = proc.lines();
    // Race the handshake read against the SAME client deadline used for the
    // response below: a process that starts but never emits `{"ready":true}`
    // (wrong binary, stalled startup, crash before first output) must not
    // hang send() — and therefore the whole mutation run — forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), deadlineMs);
      });
      const hello = await Promise.race([iter.next(), deadline]);
      if (hello === "deadline") {
        // Nothing was ever assigned to this.proc/this.iter, so there is no
        // shared state to unwind — just stop the stalled process directly.
        proc.kill();
        return "deadline";
      }
      if (hello.done) throw new Error("al-runner server closed before the ready handshake");
      this.proc = proc;
      this.iter = iter;
      return { proc, iter };
    } finally {
      // Otherwise a timer stays armed for up to `deadlineMs` (120s on
      // baseline runs) after every fast handshake, keeping an embedder's
      // event loop alive for no reason — OneShotTransport already clears its
      // equivalent timer this way.
      clearTimeout(timer);
    }
  }

  send(req: AlRunnerRequest): Promise<AlRunnerResult> {
    const result = this.queue.then(() => this.sendLocked(req));
    // Keep the chain alive even if this call fails, so a later queued call
    // isn't blocked forever by an already-reported failure.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async sendLocked(req: AlRunnerRequest): Promise<AlRunnerResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = await this.ensureStarted(req.deadlineMs);
      if (started === "deadline") return { kind: "deadline" };
      const { proc, iter } = started;
      const payload: Record<string, unknown> = {
        command: "runTests",
        sourcePaths: [req.sourceDir, req.testDir],
      };
      if (req.packagesDir) payload.packagePaths = [req.packagesDir];
      if (req.stubsDir) payload.stubPaths = [req.stubsDir];
      proc.write(JSON.stringify(payload));

      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), req.deadlineMs);
      });
      const line = await Promise.race([iter.next(), deadline]);
      if (line === "deadline") {
        // The process is now out of step with our request stream; drop it.
        await this.close();
        return { kind: "deadline" };
      }
      if (line.done) return { kind: "error", detail: "al-runner server closed unexpectedly" };
      const parsed = JSON.parse(line.value) as { error?: string; tests?: AlRunnerRawTest[] };
      if (parsed.error !== undefined) return { kind: "error", detail: parsed.error };
      return { kind: "tests", tests: parsed.tests ?? [] };
    } catch (err) {
      return { kind: "error", detail: String(err) };
    } finally {
      // Otherwise a timer stays armed for up to `deadlineMs` (120s on
      // baseline runs) after every fast response, keeping an embedder's event
      // loop alive — OneShotTransport already clears its equivalent timer.
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (proc === undefined) return;
    this.proc = undefined;
    this.iter = undefined;
    try {
      proc.write(JSON.stringify({ command: "shutdown" }));
    } catch {
      // process may already be gone
    }
    proc.kill();
  }
}
