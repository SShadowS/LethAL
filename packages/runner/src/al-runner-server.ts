/**
 * A client for `al-runner --server`, the long-running JSON-RPC daemon.
 *
 * ## Why this exists again, when the last one was DELETED
 *
 * `AlRunnerConfig.serverMode` has been refused since [[R97]], and the refusal was right at the
 * time. Two reasons were measured on al-runner 2.1.0.0, and BOTH have to be re-answered before any
 * of this is worth having. Re-measured on **2.11.0**:
 *
 * 1. **"The server has no per-test selection, so it would be quadratic."** The first half is STILL
 *    TRUE: `testFilter`, `filter`, `test`, `tests`, `testName`, `pattern` and `only` were all sent
 *    on 2.11.0 and all seven returned the whole suite (`total: 2`). The server's own wire schema
 *    documents no filter field either.
 *
 *    The CONCLUSION no longer follows, because it assumed the cost was per test EXECUTED. Measured,
 *    the cost is per COMPILE:
 *
 *    | | wall |
 *    | --- | ---: |
 *    | server start to `{"ready":true}` | 2.4 s |
 *    | first `runTests` (cold) | 12.5 s |
 *    | `runTests` after an AL EDIT (the shape `activate()` produces) | **0.4 s** |
 *
 *    So running the whole suite warm costs less than one cold CLI invocation, and the one-shot
 *    transport pays a cold compile for EVERY test of EVERY mutant. The trade is real but it is not
 *    the trade R97 described: it is "T tests warm" against "k compiles cold", and on any project
 *    where compilation dominates, warm wins by a wide margin. Where test EXECUTION dominates
 *    instead, it does not, which is why this is opt-in rather than the default.
 *
 * 2. **"The response shape moved and is no longer the envelope this repo decoded."** True, and this
 *    client decodes the CURRENT one rather than the 2.0.0.0 envelope: `runTests` streams zero or
 *    more `{"type":"test",...}` lines and then exactly one `{"type":"summary",...}`. Reading one
 *    line and looking for a `tests` array — what the deleted transport did — would find an empty
 *    list on the first per-test line, which is this project's signature bug.
 *
 * ## The correctness question that decides whether this is usable at all
 *
 * A warm process that answers a second identical request in 0.1 s is a process that could be
 * serving a CACHED answer, and LethAL changes one AL file per mutant. A stale answer would give
 * every mutant the same verdict, which is the worst failure this repository has a name for.
 *
 * MEASURED, and it is correct: with an app returning 1 and a test asserting 1, then the app edited
 * to return 999 between two requests on the SAME server process,
 *
 * ```text
 *   run 1: passed=1 failed=0 cached=false  (12.5s)
 *   run 2: passed=0 failed=1 cached=false   (0.4s)
 * ```
 *
 * The edit is seen, the verdict flips, and the runner reports `cached:false` itself. The 0.4 s is
 * an incremental recompile, not a cache hit.
 *
 * ## What this client deliberately does NOT do
 *
 * - **No `affectedOnly`.** It narrows to tests whose previous coverage intersects CHANGED AL
 *   objects. Every LethAL mutant rewrites the selector codeunit, so the changed set is never empty
 *   and never meaningful, and a wrong narrowing here silently drops the covering test that would
 *   have killed a mutant. Not sent, at all.
 * - **No `cancel`.** The protocol has it, and stopping at the first failure is what the one-shot
 *   path gets for free. It is worth having and is not here yet; leaving it out costs wall-clock,
 *   whereas getting it wrong mid-stream costs a verdict.
 */

/** The subset of a spawned process this client uses, so tests can supply one without a binary. */
export interface ServerProcessHandle {
  write(line: string): void;
  /**
   * ASYNC ITERABLE rather than `ReadableStream`, for two reasons that both matter. A real
   * `ReadableStream` already satisfies it, so nothing is lost at the call site; and a test can
   * supply an async generator, so the whole protocol decode is exercised without a binary, which
   * is the half of this client that can be wrong in a way a live run would not reveal.
   */
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  kill(): void;
}

export type ServerSpawnFn = (argv: readonly string[]) => ServerProcessHandle;

/** One test as the server streams it. */
export interface ServerTestLine {
  readonly name: string;
  readonly status: string;
  readonly durationMs?: number;
  readonly message?: string;
}

/** One statement's coverage, as `perTestCoverage` reports it. */
export interface ServerCoverageStatement {
  /** The PROCEDURE this statement belongs to, named by the server. */
  readonly scope?: string;
  readonly line?: number;
  readonly hits?: number;
}

export interface ServerCoverageFile {
  readonly file: string;
  readonly statements?: readonly ServerCoverageStatement[];
}

export interface ServerPerTestCoverage {
  /** Qualified `Codeunit<id>.<method>`, the same shape `qualifiedTestName` builds. */
  readonly test: string;
  readonly coverage?: readonly ServerCoverageFile[];
}

export interface ServerRunResult {
  readonly tests: readonly ServerTestLine[];
  readonly perTestCoverage: readonly ServerPerTestCoverage[];
  readonly exitCode: number;
  readonly total: number;
}

export interface ServerRunRequest {
  readonly sourcePaths: readonly string[];
  readonly packagePaths?: readonly string[];
  readonly coverage?: boolean;
  readonly perTestCoverage?: boolean;
  /**
   * `"test"` is what the CLI path's `--isolation test` means, and `capabilities().isolation`
   * claims `full-reset` on the strength of it. The server's OWN default is `"codeunit"`, which is
   * the weaker isolation [[R96]] records the v1 argv as having silently bought, so this is always
   * sent explicitly rather than left to the server's default.
   */
  readonly testIsolation?: "test" | "codeunit" | "disabled";
}

type ReadLineOutcome =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "eof" }
  | { readonly kind: "timeout" };

/** Reading one NDJSON line at a time from a byte stream, with a deadline. */
class LineReader {
  private buf = "";
  private readonly it: AsyncIterator<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private done = false;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.it = stream[Symbol.asyncIterator]();
  }

  /**
   * A DISCRIMINATED result rather than `string | undefined`, because "the daemon has gone" and
   * "the daemon is still thinking" need different diagnoses and the caller cannot tell them apart
   * from an absent value. Conflating them was the first thing the tests here caught.
   */
  async next(deadlineMs: number): Promise<ReadLineOutcome> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line !== "") return { kind: "line", line };
        continue;
      }
      if (this.done) return { kind: "eof" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        this.it.next(),
        new Promise<{ value: undefined; done: false }>((resolve) => {
          timer = setTimeout(() => resolve({ value: undefined, done: false }), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done === true) {
        this.done = true;
        continue;
      }
      if (chunk.value === undefined) return { kind: "timeout" };
      this.buf += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  cancel(): void {
    void this.it.return?.().catch(() => undefined);
  }
}

/**
 * Drains a stream into a bounded string, so stderr cannot fill memory on a long session and so the
 * lines [[R129]] and [[R148]] read off it are still there to read.
 *
 * BOUNDED because this is a daemon: the one-shot path got a fresh, short stderr per invocation,
 * while one server process can run for a whole session. The tail is kept rather than the head, on
 * the grounds that a diagnostic explaining a failure is written near the failure.
 */
const STDERR_KEEP_BYTES = 64 * 1024;

/** How long `close()` waits for the shutdown acknowledgement before killing the process. */
const SHUTDOWN_REPLY_WAIT_MS = 500;

export class AlRunnerServer {
  private proc: ServerProcessHandle | undefined;
  private stdout: LineReader | undefined;
  private stderrText = "";
  private stderrPump: Promise<void> | undefined;

  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: ServerSpawnFn,
  ) {}

  /**
   * Spawns the daemon and waits for its readiness line.
   *
   * The wait is generous because the schema says so: "on a cold start the runner may re-exec itself
   * once for a clean Cecil load; the child inherits the same stdio, so the readiness line still
   * arrives on the same pipe — just later". Measured at 2.4 s on a warm machine, but a first run
   * that provisions artifacts is minutes.
   */
  async start(readinessDeadlineMs: number, packagePaths: readonly string[] = []): Promise<void> {
    if (this.proc !== undefined) return;
    const argv = [
      this.alRunnerPath,
      "--server",
      ...packagePaths.flatMap((p) => ["--package-cache", p]),
    ];
    const proc = this.spawn(argv);
    this.proc = proc;
    this.stdout = new LineReader(proc.stdout);
    this.stderrPump = this.pumpStderr(proc.stderr);

    const first = await this.stdout.next(readinessDeadlineMs);
    if (first.kind !== "line") {
      await this.close();
      const why =
        first.kind === "eof"
          ? "its stdout closed before it printed anything, which is what a daemon that failed to start looks like"
          : `it did not print its readiness line within ${readinessDeadlineMs} ms`;
      throw new Error(`al-runner --server: ${why}. stderr tail: ${this.stderrTail(600)}`);
    }
    const line = first.line;
    let parsed: { ready?: boolean };
    try {
      parsed = JSON.parse(line) as { ready?: boolean };
    } catch {
      await this.close();
      throw new Error(
        `al-runner --server's first stdout line is not JSON, so this is not the protocol this client speaks: ${line.slice(0, 200)}`,
      );
    }
    if (parsed.ready !== true) {
      await this.close();
      throw new Error(
        `al-runner --server's first line is JSON but not the readiness signal: ${line.slice(0, 200)}`,
      );
    }
  }

  private async pumpStderr(stream: AsyncIterable<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const value of stream) {
        this.stderrText += decoder.decode(value, { stream: true });
        if (this.stderrText.length > STDERR_KEEP_BYTES) {
          this.stderrText = this.stderrText.slice(-STDERR_KEEP_BYTES);
        }
      }
    } catch {
      // A closed pipe during shutdown is ordinary, not a failure to report.
    }
  }

  /** Everything the daemon has written to stderr, tail-bounded. R129/R148 read their lines here. */
  stderrSoFar(): string {
    return this.stderrText;
  }

  private stderrTail(n: number): string {
    return this.stderrText.slice(-n) || "<empty>";
  }

  /**
   * Runs the WHOLE suite once and returns every test's result.
   *
   * There is no per-test selection to ask for (measured on 2.11.0, see this module's header), so
   * the caller gets all of them and picks. That is not a workaround for a missing feature so much
   * as the shape the protocol has: `runTests` means "run the tests".
   */
  async runTests(req: ServerRunRequest, deadlineMs: number): Promise<ServerRunResult> {
    const proc = this.proc;
    const stdout = this.stdout;
    if (proc === undefined || stdout === undefined) {
      throw new Error("al-runner --server: runTests called before start()");
    }
    proc.write(
      `${JSON.stringify({
        command: "runTests",
        sourcePaths: req.sourcePaths,
        ...(req.packagePaths !== undefined ? { packagePaths: req.packagePaths } : {}),
        ...(req.coverage !== undefined ? { coverage: req.coverage } : {}),
        ...(req.perTestCoverage !== undefined ? { perTestCoverage: req.perTestCoverage } : {}),
        ...(req.testIsolation !== undefined ? { testIsolation: req.testIsolation } : {}),
      })}\n`,
    );

    const tests: ServerTestLine[] = [];
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `al-runner --server: no summary line within ${deadlineMs} ms (${tests.length} test line(s) seen). stderr tail: ${this.stderrTail(600)}`,
        );
      }
      const next = await stdout.next(remaining);
      if (next.kind === "timeout") {
        throw new Error(
          `al-runner --server: no summary line within ${deadlineMs} ms (${tests.length} test line(s) seen). stderr tail: ${this.stderrTail(600)}`,
        );
      }
      if (next.kind === "eof") {
        throw new Error(
          `al-runner --server: stdout ended before the summary (${tests.length} test line(s) seen), so the daemon exited mid-run. stderr tail: ${this.stderrTail(600)}`,
        );
      }
      const line = next.line;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // stdout is documented to carry ONLY the protocol, so an unparseable line means the
        // contract moved. Refused rather than skipped: skipping is how a decoder keeps "working"
        // against a protocol it no longer speaks.
        throw new Error(
          `al-runner --server: unparseable stdout line, which the protocol forbids: ${line.slice(0, 200)}`,
        );
      }
      if (msg.type === "test") {
        tests.push({
          name: String(msg.name ?? ""),
          status: String(msg.status ?? ""),
          ...(typeof msg.durationMs === "number" ? { durationMs: msg.durationMs } : {}),
          ...(typeof msg.message === "string" ? { message: msg.message } : {}),
        });
        continue;
      }
      if (msg.type !== "summary") continue; // forward-compatible with new line types
      const rawPtc = Array.isArray(msg.perTestCoverage) ? msg.perTestCoverage : [];
      return {
        tests,
        perTestCoverage: rawPtc as readonly ServerPerTestCoverage[],
        exitCode: typeof msg.exitCode === "number" ? msg.exitCode : -1,
        total: typeof msg.total === "number" ? msg.total : tests.length,
      };
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (proc === undefined) return;
    try {
      proc.write(`${JSON.stringify({ command: "shutdown" })}\n`);
      // SHORT, and the shortness is the point. The schema says the server writes its response and
      // then exits, so a well-behaved daemon answers immediately; one that does not is killed
      // below rather than waited on. A generous wait here would stall every teardown, including
      // the teardown on an error path where the daemon is by definition not answering, on the way
      // to reporting the real failure.
      await this.stdout?.next(SHUTDOWN_REPLY_WAIT_MS);
    } catch {
      // Already gone. Killing below is still correct.
    }
    this.stdout?.cancel();
    try {
      proc.kill();
    } catch {
      // Already exited.
    }
    this.proc = undefined;
    this.stdout = undefined;
    await Promise.race([
      this.stderrPump ?? Promise.resolve(),
      new Promise<void>((r) => setTimeout(r, 1000)),
    ]);
  }
}
