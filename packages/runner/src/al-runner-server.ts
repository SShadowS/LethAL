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
 * - **No symbols in the request.** The request has no such field and the server ignores one
 *   (measured on 2.11.0, R319); the symbols are start-time flags, see the constructor.
 */

import { V3_TIMEOUT_MESSAGE, isV3RefusalText } from "./al-runner-rows";
import type { EntriesAnswer } from "./al-runner-v3-entries";
import { checkRunSeed, mergeChildEnv } from "./al-runner-v3-seed";

/** One `compilationErrors` entry, from the one-shot envelope or the `--server` summary. Moved
 *  here from `al-runner-transport.ts` by R654 S1, because the daemon (which v3 keeps) decodes it. */
export interface AlRunnerCompileEntry {
  readonly file: string;
  readonly errors: readonly string[];
}

/** `compilationErrors` as entries. A malformed entry is kept with no `file`, so it counts. */
export function compileEntriesOf(raw: unknown): readonly AlRunnerCompileEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const o = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
    return {
      file: typeof o.file === "string" ? o.file : "",
      errors: Array.isArray(o.errors) ? o.errors.map(String) : [JSON.stringify(e)],
    };
  });
}

/**
 * R635 (F4): a v3 `serve` request that gave no complete answer: an untyped `{"error"}` line, EOF,
 * the deadline, or a line that is not JSON. The daemon is closed by the caller; never a verdict.
 */
export class AlRunnerServerRequestError extends Error {
  constructor(
    readonly kind: "error" | "eof" | "deadline" | "protocol",
    why: string,
  ) {
    super(`al-runner serve: ${why}`);
    this.name = "AlRunnerServerRequestError";
  }
}

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
  /** R952: the child's pid, for the daemon memory guard's RSS read. Absent in a fake. */
  readonly pid?: number;
  /**
   * Resolves when the child has actually EXITED, awaited by `close()`.
   *
   * Optional so a fake need not implement it, and load-bearing for the real one: killing a Bun
   * subprocess asks it to die, and the runtime keeps the process alive until the child is reaped.
   * MEASURED without this, three sessions in a row scored all 19 mutants correctly, printed their
   * tables, and then sat there until killed at the 200 s mark. A finished run that will not exit
   * looks exactly like a hung one.
   */
  wait?(): Promise<unknown>;
}

/** `cwd` is used by R407's frame probe only; the session's daemon inherits LethAL's cwd. `env`
 *  (added to the inherited one) by R612's `serve-keep-reasons` only, for `ALRUNNER_CACHE`. */
export type ServerSpawnFn = (
  argv: readonly string[],
  opts?: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
) => ServerProcessHandle;

/** One test as the server streams it. */
export interface ServerTestLine {
  readonly name: string;
  readonly status: string;
  readonly durationMs?: number;
  /** PR-43: al-runner's `clock` on a time-limit row (`"cpu"` or `"virtual"`). Absent otherwise. */
  readonly clock?: string;
  readonly message?: string;
  /** R612: v3's `notRun`, carried only when a boolean (v2's wire never sends it). A present
   *  non-boolean throws in `runTests`: the protocol moved. */
  readonly notRun?: boolean;
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
  /** Each row's `name` is `Codeunit<id>.<CLR method>`: BC's C# name for the AL method
   *  (`alRunnerMethodName`, R557), the same name `qualifiedTestName` builds. */
  readonly tests: readonly ServerTestLine[];
  readonly perTestCoverage: readonly ServerPerTestCoverage[];
  /** The summary's own exit code, -1 when it carried none. R557 (I1): a missing row stops the
   *  session only when this is 0 or 1 and every row is a pass or fail run row. */
  readonly exitCode: number;
  readonly total: number;
  /** R583: the summary's `compilationErrors`. On 069cbf32 a bundle that lost objects to AL0666
   *  still streams `pass` rows beside these, with `exitCode` 3. */
  readonly compilationErrors: readonly AlRunnerCompileEntry[];
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

/** R635: the largest delay `setTimeout` honours (2^31-1 ms); a larger one overflows and fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** R635: what LineReader's wait timer resolves to; no stream value can equal it. */
const TIMER_FIRED: unique symbol = Symbol("LineReader timer fired");

/** Reading one NDJSON line at a time from a byte stream, with a deadline. Exported for tests. */
export class LineReader {
  /** Text read but not yet scanned for a line end. */
  private buf = "";
  /**
   * R988: the earlier pieces of a line still being read, none with a line end. Joined once, when the
   * line ends: appending every chunk to one string and searching it again after each chunk copied a
   * 67 MB answer line over and over (each search flattens the whole string).
   */
  private head: string[] = [];
  private readonly it: AsyncIterator<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private done = false;
  /** A read still in flight when a (capped) timer fired; reused by the next wait. */
  private pending: Promise<IteratorResult<Uint8Array>> | undefined;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.it = stream[Symbol.asyncIterator]();
  }

  /**
   * A DISCRIMINATED result rather than `string | undefined`, because "the daemon has gone" and
   * "the daemon is still thinking" need different diagnoses and the caller cannot tell them apart
   * from an absent value. Conflating them was the first thing the tests here caught.
   */
  /** `capMs` is the timer cap; only a test lowers it, to reach "capped timer fired early". */
  async next(deadlineMs: number, capMs: number = MAX_TIMER_MS): Promise<ReadLineOutcome> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        const tail = this.buf.slice(0, nl);
        const line = (this.head.length > 0 ? this.head.join("") + tail : tail).trim();
        this.head = [];
        this.buf = this.buf.slice(nl + 1);
        if (line !== "") return { kind: "line", line };
        continue;
      }
      // No line end in what is left: it is part of a line still being read, scanned once.
      if (this.buf !== "") {
        this.head.push(this.buf);
        this.buf = "";
      }
      if (this.done) return { kind: "eof" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The read stays pending across a capped timer, so no chunk is ever dropped.
      if (this.pending === undefined) this.pending = this.it.next();
      const read = this.pending;
      const chunk = await Promise.race([
        read,
        new Promise<typeof TIMER_FIRED>((resolve) => {
          // R635: a timer above 2^31-1 ms fires at once (it overflows); capped, and a capped
          // timer that fires before the real deadline only waits again (the loop re-checks).
          timer = setTimeout(() => resolve(TIMER_FIRED), Math.min(remaining, capMs));
        }),
      ]).finally(() => clearTimeout(timer));
      // A unique marker, so a stream chunk `{ value: undefined }` is never read as the timer.
      if (chunk === TIMER_FIRED) continue;
      this.pending = undefined;
      if (chunk.done === true) {
        this.done = true;
        continue;
      }
      if (chunk.value !== undefined) this.buf += this.decoder.decode(chunk.value, { stream: true });
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
  /** R952: the running child's pid (undefined before `start` or in a fake without one). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }
  private stdout: LineReader | undefined;
  private stderrText = "";
  private stderrPump: Promise<void> | undefined;
  /**
   * Kept so `close()` can END the stderr drain.
   *
   * Without it the drain is an infinite `for await` over a stream that only closes when the child
   * does, and an outstanding read keeps the event loop alive: MEASURED, a session that had already
   * scored all 19 mutants and printed its table then sat there until killed. The session was
   * complete and the PROCESS would not exit, which reads as a hang and is worse than one, because
   * the work is done and invisible.
   */
  private stderrIt: AsyncIterator<Uint8Array> | undefined;

  /** R807: refuse a summary that reports a seed other than the pinned one. O1's sensitivity daemon
   *  (variable absent) turns this off; nothing else does. */
  enforceRunSeed = true;
  /** R807: the seed and its source the last summary reported; absent when it reported none. */
  lastRunSeed: { readonly seed: unknown; readonly seedSource: unknown } | undefined;

  private readSeed(msg: Record<string, unknown>): void {
    this.lastRunSeed =
      msg.seed === undefined ? undefined : { seed: msg.seed, seedSource: msg.seedSource };
    if (this.enforceRunSeed) checkRunSeed(msg, "serve summary");
  }

  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: ServerSpawnFn,
    /**
     * R319. Fixed for the daemon's life, because that is where al-runner reads them: measured on
     * 2.11.0, `--define` at `--server` start selects the build, and a symbols field in a
     * `runTests` request is silently ignored. One `--define` per symbol, the same form the
     * one-shot argv uses (R101 (c)).
     */
    private readonly preprocessorSymbols: readonly string[] = [],
    /** R612: v2's daemon is `--server`; v3's is `serve` (the update gate's `serve-keep-reasons`). */
    private readonly subcommand: "--server" | "serve" = "--server",
  ) {}

  /**
   * Spawns the daemon and waits for its readiness line.
   *
   * The wait is generous because the schema says so: "on a cold start the runner may re-exec itself
   * once for a clean Cecil load; the child inherits the same stdio, so the readiness line still
   * arrives on the same pipe — just later". Measured at 2.4 s on a warm machine, but a first run
   * that provisions artifacts is minutes.
   *
   * R517: `testTimeoutSeconds` is sent as `--test-timeout N`, the daemon's one in-run stop for its
   * life (a `runTests` request cannot carry one; the flag beats an inherited
   * `AL_RUNNER_TEST_TIMEOUT_SEC`, measured on 43f76177). Absent: al-runner's own 60 s default.
   * `AlRunnerBackend` never starts one without it.
   */
  async start(
    readinessDeadlineMs: number,
    packagePaths: readonly string[] = [],
    testTimeoutSeconds?: number,
    /** R635: v3 `serve`'s `--bc-version <v> --no-download`. */
    extraArgs: readonly string[] = [],
  ): Promise<void> {
    if (this.proc !== undefined) return;
    const argv = [
      this.alRunnerPath,
      this.subcommand,
      ...packagePaths.flatMap((p) => ["--package-cache", p]),
      ...this.preprocessorSymbols.flatMap((sym) => ["--define", sym]),
      ...(testTimeoutSeconds !== undefined ? ["--test-timeout", String(testTimeoutSeconds)] : []),
      ...extraArgs,
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
    const it = stream[Symbol.asyncIterator]();
    this.stderrIt = it;
    try {
      for (;;) {
        const next = await it.next();
        if (next.done === true) return;
        const value = next.value;
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
        if (msg.notRun !== undefined && typeof msg.notRun !== "boolean") {
          throw new Error(
            `al-runner --server: a test line carries a notRun that is not a boolean (${JSON.stringify(msg.notRun)}), so the protocol moved: ${line.slice(0, 200)}`,
          );
        }
        tests.push({
          name: String(msg.name ?? ""),
          status: String(msg.status ?? ""),
          ...(typeof msg.durationMs === "number" ? { durationMs: msg.durationMs } : {}),
          ...(typeof msg.clock === "string" ? { clock: msg.clock } : {}),
          ...(typeof msg.message === "string" ? { message: msg.message } : {}),
          ...(typeof msg.notRun === "boolean" ? { notRun: msg.notRun } : {}),
        });
        continue;
      }
      if (msg.type !== "summary") continue; // forward-compatible with new line types
      this.readSeed(msg);
      const rawPtc = Array.isArray(msg.perTestCoverage) ? msg.perTestCoverage : [];
      return {
        tests,
        perTestCoverage: rawPtc as readonly ServerPerTestCoverage[],
        exitCode: typeof msg.exitCode === "number" ? msg.exitCode : -1,
        total: typeof msg.total === "number" ? msg.total : tests.length,
        compilationErrors: compileEntriesOf(msg.compilationErrors),
      };
    }
  }

  /**
   * R635 (F4): one v3 `runTests` request (entries or plain), its raw lines grouped by type only:
   * the caller decodes them against what it sent. Unlike `runTests`, an untyped `{"error": ...}`
   * line ends the request AT ONCE with `AlRunnerServerRequestError`, as do EOF, the deadline and
   * an unparseable line; it never reads on to the deadline.
   */
  async runEntries(
    body: Readonly<Record<string, unknown>>,
    deadlineMs: number,
    /**
     * R895: stop at the first streamed timeout row (notRun, error, `Test exceeded Ns timeout.`).
     * The daemon is killed (never reused) and the answer is PARTIAL: the test lines seen, no entry
     * summaries and no summary (they come only at the end), and `cut` naming where it was cut.
     * Absent or false, a timeout row is read like any other.
     */
    stopAtTimeout = false,
  ): Promise<EntriesAnswer> {
    const proc = this.proc;
    const stdout = this.stdout;
    if (proc === undefined || stdout === undefined) {
      throw new Error("al-runner serve: runEntries called before start()");
    }
    proc.write(`${JSON.stringify(body)}\n`);
    const tests: Record<string, unknown>[] = [];
    const entrySummaries: Record<string, unknown>[] = [];
    const deadline = Date.now() + deadlineMs;
    const fail = (kind: AlRunnerServerRequestError["kind"], why: string) =>
      new AlRunnerServerRequestError(
        kind,
        `${why} (${tests.length} test line(s) seen). stderr tail: ${this.stderrTail(600)}`,
      );
    for (;;) {
      const remaining = deadline - Date.now();
      const next = remaining <= 0 ? ({ kind: "timeout" } as const) : await stdout.next(remaining);
      if (next.kind === "timeout")
        throw fail("deadline", `no summary line within ${deadlineMs} ms`);
      if (next.kind === "eof") throw fail("eof", "stdout ended before the summary");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(next.line) as Record<string, unknown>;
      } catch {
        throw fail("protocol", `unparseable stdout line: ${next.line.slice(0, 200)}`);
      }
      if (msg.type === undefined && "error" in msg) {
        const said = JSON.stringify(msg.error);
        // R860: a missing-dependency refusal names one app per line; 400 characters lose the second.
        const keep = said.includes("dependency app(s) were not found") ? 4000 : 400;
        throw fail("error", `the request was refused: ${said.slice(0, keep)}`);
      }
      if (msg.type === "test") {
        tests.push(msg);
        if (
          stopAtTimeout &&
          msg.notRun === true &&
          msg.status === "error" &&
          typeof msg.message === "string" &&
          V3_TIMEOUT_MESSAGE.test(msg.message)
        ) {
          await this.terminate();
          return {
            tests,
            entrySummaries: [],
            summary: {},
            cut: { entry: String(msg.entry), test: String(msg.name) },
          };
        }
      } else if (msg.type === "entrySummary") entrySummaries.push(msg);
      else if (msg.type === "summary") {
        this.readSeed(msg);
        return { tests, entrySummaries, summary: msg };
      }
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
    await this.terminate();
  }

  /** Kills the process (and with it al-runner's .NET sidecar) and reaps it; `close()`'s tail, and R895's cut. */
  private async terminate(): Promise<void> {
    const proc = this.proc;
    if (proc === undefined) return;
    this.stdout?.cancel();
    try {
      proc.kill();
    } catch {
      // Already exited.
    }
    // END the stderr drain rather than merely waiting for it. Killing the child usually closes the
    // pipe, but "usually" leaves an outstanding read holding the event loop open, and a completed
    // session that will not exit is indistinguishable from a hung one to whoever is watching.
    await this.stderrIt?.return?.().catch(() => undefined);
    // Then REAP it. `kill()` only signals; the runtime holds the process open until the child is
    // collected, which is the other half of the same symptom.
    await Promise.race([
      proc.wait?.().catch(() => undefined) ?? Promise.resolve(),
      new Promise<void>((r) => setTimeout(r, 5000)),
    ]);
    this.proc = undefined;
    this.stdout = undefined;
    this.stderrIt = undefined;
    await Promise.race([
      this.stderrPump ?? Promise.resolve(),
      new Promise<void>((r) => setTimeout(r, 1000)),
    ]);
    this.stderrPump = undefined;
  }
}

/** The real daemon, adapted to the handle `AlRunnerServer` consumes. Exported for R387's gate leg,
 *  which wraps it to record the argv. Moved here from `al-runner-backend.ts` by R654 S1. */
export const defaultServerSpawn: ServerSpawnFn = (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.env !== undefined ? { env: mergeChildEnv(opts.env) } : {}),
  });
  const handle: ServerProcessHandle = {
    write: (line) => {
      proc.stdin.write(line);
    },
    stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
    stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
    kill: () => proc.kill(),
    pid: proc.pid,
    wait: () => proc.exited,
  };
  return handle;
};

// R612's daemon keep rule, moved here from `al-runner-backend.ts` by R654 S1: both daemons'
// owners apply it (the .NET backend's `--server`, v3's `serve`).

/**
 * R612 (plan r3 §1; build review r1 I-1): words a free-text tail must not contain, matched without
 * regard to case. "panic" covers both v3 panic wordings and Rust's "panicked at"; the rest cover a
 * timeout or wall-time stop, which an upstream #5698 fix would put inside the onrun-failed tail.
 * "time limit": a cascade row caused by a timeout ("did not run (the test used more than the time
 * limit ..."), which must close even with no timeout row in the same answer.
 */
const V3_TAIL_UNSAFE_WORDS = [
  "panic",
  "timeout",
  "timed out",
  "exceeded",
  "wall",
  "deadline",
  "time limit",
];
/** Case-insensitive for these words only, so each entry's fixed prefix stays exact. */
const anyCase = (w: string): string =>
  [...w].map((ch) => (/[a-z]/.test(ch) ? `[${ch}${ch.toUpperCase()}]` : ch)).join("");
/** R612: the one tail check both tailed entries share, so they cannot drift apart. */
const SAFE_TAIL = `(?!.*(?:${V3_TAIL_UNSAFE_WORDS.map(anyCase).join("|")}))`;

/**
 * R612: the v3 refusal reasons MEASURED to leave a `serve` daemon correct and warm for the next
 * request (`/coord/handoff/R-612/measure.md` rows 2, 3, 4, 6, 9). Each is anchored at both ends;
 * any other text (a reworded reason, an exact entry plus a tail, a panic) closes the daemon. The
 * list widens only by probe. Pinned by the update gate's `serve-keep-reasons` fact.
 * R635: `commit` also takes the EDGE build's wording (al-runner 3.0.0-alpha.4+edge.20261022,
 * 57f1e4f98), measured clean by R-612's probe re-run (`/coord/handoff/R-635/edge-reasons.md`); each
 * wording is anchored at both ends. On edge, http is a plain fail and cascade / no-callee rows are
 * not produced, so nothing else is widened.
 * R705: `no-callee` was removed. A #5602-fixed build refuses a request that does not compile (no
 * rows), so the row cannot exist there and no gate pinned it. On alpha.2 such a row now closes the
 * daemon. In serve-entries, a warm-up whose every entry refuses with one identical no-callee text
 * now throws `al-runner-v3-entries-batch-refused`: the safe direction, opt-in and rare.
 * R808: `http` also takes today's wording (alpha.7 and alpha.12: "... that a test handler does not
 * answer ..."), one exact text with no variable part, measured by R-808's probe (`/coord/handoff/R-808/probe.md`):
 * about 60 requests per daemon on both builds, every Reader answer equal to a cold daemon's, the pid
 * unchanged. alpha.2's wording stays.
 * R945: seven .NET-helper and stream refusal families, measured clean by R-937's probe on edge-42af5d384
 * (`/coord/handoff/R-937/probe/README.md`; invented AL): per family 20 refused requests on one daemon,
 * each next reader equal to the one after a passing test with the same writes and to a fresh daemon's,
 * the pid unchanged, no panic text; nothing crossed requests under any isolation, and inside one run a
 * refused test never left more state than a pass. Only the measured shapes: a `.NET` exception of a
 * measured type (`DOTNET_CLEAN_EXCEPTIONS`), a call on a variable that holds no object, an assembly that
 * is not there at all, a member or overload not found, a stream never created, and the one policy member
 * `System.TimeZoneInfo.Local`. Never measured, so still closing: an
 * unassigned Variant used as a stream, an unassigned XmlElement, and every other wording. The two
 * free-text tails take `SAFE_TAIL`, and no entry spans a line break. Not in the update gate's
 * `serve-keep-reasons` fact (it runs without the .NET helper): a reworded text stops matching and the
 * daemon closes again, the safe direction, counted in `v3DaemonCloses`.
 */
const DOTNET = String.raw`^NotRun: out-of-scope: DotNet `;
/** R945: a .NET type or member as v3 names it (`System.Collections.Generic.Dictionary`2.Count`). */
const DOTNET_NAME = "[A-Za-z_][A-Za-z0-9_.`+]*";
/**
 * R945 (build review): the exception TYPES the probe measured clean, each by name. Any other type
 * closes the daemon: a timeout, a cancellation, a disposed object, out of memory or a type
 * initializer that failed may mean the .NET helper itself is not clean, and none was measured.
 */
const DOTNET_CLEAN_EXCEPTIONS = [
  "System.FormatException",
  "System.ArgumentOutOfRangeException",
  // R-937 probe round 3, each on its own refuser: the types Cryptography Management raises.
  "System.ArgumentNullException",
  "System.ArgumentException",
  "System.NullReferenceException",
  "System.Security.Cryptography.CryptographicException",
  "Interop+Crypto+OpenSslCryptographicException",
  "System.Xml.XPath.XPathException",
  // PR-56: measured clean in PR-54's keep census (class "DotNet * raised the .NET exception *"): System.UriBuilder
  // (new, a bad port) and System.Data.DataRowCollection/DataColumnCollection.Item (no such row or column).
  "System.UriFormatException",
  "System.IndexOutOfRangeException",
]
  .map((t) => t.replace(/[.+]/g, "\\$&"))
  .join("|");
/**
 * PR-56: the placeholders of a `PR56_KEPT` text. Each is one line, bounded (the longest measured variant plus
 * about 50%), and holds no `:` unless a measured variant has one.
 */
const PR56_SLOTS: Readonly<Record<string, string>> = {
  IDENT: "[A-Za-z][A-Za-z0-9]{0,29}",
  NUM: String.raw`\d{1,2}`,
  OBJID: String.raw`\d{1,10}`,
  NAME: String.raw`[^:'\r\n]{1,40}`,
  QUOTED: String.raw`[^'\r\n]{1,60}`,
  STORE: "(?:store error )?",
  FILTER: "[^`\\r\\n]{1,40}",
  // The measured methods only, each by name (review M3): a table read the census measured, and the
  // FieldRef and RecordRef methods it refused on a never-assigned or unopened handle.
  READ: "(?:IsEmpty|FindFirst)",
  COMPANYM: "(?:IsEmpty|FindFirst|FindSet)",
  // PR-74 added SetFilter (FieldRef) and Duplicate, ClearMarks (RecordRef): measured CLEAN in its census.
  // PR-93 added Value, EnumValueCount (FieldRef) and KeyIndex, GetFilters, FindFirst (RecordRef): measured CLEAN.
  FIELDREFM: "(?:Active|Caption|Class|SetFilter|Value|EnumValueCount)",
  RECORDREFM: "(?:FilterGroup|Duplicate|ClearMarks|KeyIndex|GetFilters|FindFirst)",
  // PR-93: the KeyRef methods measured on a never-assigned KeyRef.
  KEYREFM: "(?:FieldCount|FieldIndex)",
  KIND: "(?:a Decimal|an Integer)",
  // PR-74: the measured variants only, each by name. PR-93 added `<>` (its text quotes it).
  SETOP: "(?:\\.\\.|@|`<>`)",
  CMP: "(?:>100|>1000|<1000|<300)",
  // PR-93: the Date filter texts and the BigInteger codes t10/t11 closed on, each measured, by name.
  DATETEXT: "(?:-1M|-2026-09-01)",
  // PR-105 added C10000 (t12/t13), and the Evaluate whitespace widths (runs of NUL characters, 4 to 6) and the two
  // Integer texts (`=18`, `1=18`) the same way: measured, by name.
  // PR-133 added C\* (the regex-escaped text `C*`), measured by family `x2-refusals`, census CLEAN at
  // /coord/handoff/PR-133/census2/ with two refusers: a plain SetFilter, and one that unwinds through a TryFunction,
  // an OnValidate, a ModalPageHandler and an open TestPage (the state DO reaches it in).
  BIGCODE: String.raw`(?:GL00000000|GU00000001|C10000|C\*)`,
  // PR-139 added every NUL width M28736's DO requests hold (3, 7, 9-14, 16, 21, 25, 27, 30, 37, 40), each by name: x3 closed on
  // 7 of them, and the rest share those requests, which a daemon keeps only if every refusal in it is kept. Family
  // `x3-refusals` measured every width CLEAN (/coord/handoff/PR-139/census2/; the width-10 class with an array, a TryFunction,
  // a nested modal-page and an OnInsert refuser). Direct checks on DO: a daemon kept through 207 refusals gave the same 443
  // rows as fresh daemons, and its next request with no mutant matched fresh ones too.
  // Spec (with amendment 1): docs/superpowers/specs/2026-11-18-pr139-x3-restarts-precommitment.md.
  NULS: String.raw`(?:\x00{3}|\x00{4,6}|\x00{7}|\x00{9}|\x00{10}|\x00{11}|\x00{12}|\x00{13}|\x00{14}|\x00{16}|\x00{21}|\x00{25}|\x00{27}|\x00{30}|\x00{37}|\x00{40})`,
  INTTEXT: "(?:=18|1=18)",
  // PR-93: the two writer states t10/t11 met for WritePropertyName, both measured.
  ARRAYSTATE: "(?:ArrayStart|Array)",
  // PR-74 review H1: SaveAs only. RunRequestPage was measured after a Commit(), never inside an open write
  // transaction, which is where t9's mutants reach it.
  REPORTM: "SaveAs",
  // PR-74 review M2: the measured path `a`, plus t9's three paths by name (the path is the writer's own
  // nesting, not engine state; a widening by name, not a measurement).
  // PR-105 added the path t12/t13 met, measured by its own cell.
  // PR-159 added message.body.toRecipients[0].emailAddress, measured by family `y1-refusals`, census CLEAN at
  // /coord/handoff/PR-159/census/. Not measured: DO's `CDO Microsoft Graph Rest Api`, reached from
  // `CDO Send Mail Management.SendMSGraphMail`, can reach the same text in a deeper state (spec L4; no DO test reaches it
  // today, and the kept ccRecipients[0] path has the same exposure).
  JSONPATH: String.raw`(?:a|message|message\.ccRecipients\[0\]|message\.toRecipients\[0\]|message\.body\.ccRecipients\[0\]\.emailAddress|message\.body\.toRecipients\[0\]\.emailAddress)`,
  // PR-159: the Integer values the GetTable keep covers, each by name: 123 (PR-133) and 12345 (family `y1-refusals`, census
  // CLEAN at /coord/handoff/PR-159/census/, a plain call and one behind an `IsRecord` guard). No integer pattern.
  GETTABLEINT: "(?:123|12345)",
};
/** PR-56: an anchored entry from a text (after "NotRun: out-of-scope: ") with `%SLOT%` placeholders. */
const pr56Entry = (template: string): RegExp =>
  new RegExp(
    `^NotRun: out-of-scope: ${template
      .split(/%([A-Z]+)%/)
      .map((part, i) => {
        if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const slot = PR56_SLOTS[part];
        if (slot === undefined) throw new Error(`PR-56 keep entry: unknown slot %${part}%`);
        return slot;
      })
      .join("")}$`,
  );
const DENIAL = "a permission denial (";
const DENIAL_TAIL = ") whose error is not pinned yet (";
const NO_CLIENT =
  " in a session without a client (--no-client): what BC does there is not pinned (probe wanted, docs/probes-needed.md `no-client-session`)";
const POLICY_TAIL = "' is neither registered nor classified pure";
const GETURL = "GetUrl(";
const PBI =
  ": BC holds rows here that an install trigger or Company-Initialize creates, and the install baseline could not create them (ADR-013 decision 5)";
/**
 * PR-56 (coord PR-56, the ruling of 2026-11-16): every CLEAN class of PR-54's keep census
 * (`/coord/handoff/PR-54/census.md`, strict re-run: 74 of 74 measured classes CLEAN; R-967's kit on
 * edge-5a58a0f16; the control is weak: CLEAN means nothing crossed requests) that no earlier entry kept in
 * full. One row per class: the entry name, then the text. A text without a `%SLOT%` is exact, anchored at
 * both ends and kept whole; a `%SLOT%` stands for the `*` of the class key (see `PR56_SLOTS`). A reworded
 * text closes the daemon as before. Not kept: `R975 Login Subscriber` and the classes the census could not
 * measure. The classes whose key holds an object name ('U8013 Find Row', "Cell Report") are exact to the
 * measured name. Each row's comment is its class key where the text does not start with it. The drift guard in
 * `al-runner-v3-backend.ts` backs every entry. Pinned by `al-runner-serve-rule.test.ts` against
 * `tests/pr56-measured-refusals.json`; not in leg C (most need the .NET helper or a platform table).
 */
const PR56_KEPT: ReadonlyArray<readonly [string, string]> = [
  [
    "company-table-read",
    "%COMPANYM% on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)",
  ], // PR-54 class "* on the Company table"
  [
    "license-permission",
    "License Permission: only a count that names one object by type and number, or one object type with a license loaded, is served",
  ],
  [
    "api-webhook-entity",
    "%STORE%API Webhook Entity: the entities of the API pages are listed by the platform and no corpus test pins them",
  ],
  [
    "page-action-promoted-area",
    "Page Action: page 'AL Test Tool': the rows of its Promoted area other than its actionrefs are not pinned (their ids, types and which exist)",
  ],
  ["power-bi-blob", `%READ% on Power BI Blob${PBI}`], // PR-54 class "* on Power BI Blob"
  ["power-bi-default-selection", `%READ% on Power BI Default Selection${PBI}`], // PR-54 class "* on Power BI Default Selection"
  [
    "media-read",
    "%STORE%Media: only a read of one ID is pinned (the null ID finds nothing, an app's logo its row); the rows of other media are not",
  ],
  [
    "application-object-metadata",
    "%STORE%Application Object Metadata: the Application Object Metadata row of table 'Object' (only a query's Metadata is pinned)",
  ],
  [
    "permission-set-whole-object-type",
    "%STORE%%NAME%: permission set '%QUOTED%': `table * = X` grants a whole object type (not listed row by row)",
  ], // PR-54 class "*: permission set *: grants a whole object type ..."
  [
    "denial-read-system-table",
    `${DENIAL}read permission on object type %NUM% id %OBJID%${DENIAL_TAIL}on a system table; probe P13 pins Tenant Media only); the test is not run`,
  ], // PR-54 class "a permission denial (read ...) (on a system table; probe P13 pins Tenant Media only)"
  [
    "denial-read-system-table-writes",
    `${DENIAL}read permission on object type %NUM% id %OBJID%${DENIAL_TAIL}on a system table; probe P13 pins Tenant Media writes only); the test is not run`,
  ], // PR-54 class "... Tenant Media writes only"
  [
    "denial-read-flowfield-system-table",
    `${DENIAL}read permission on object type %NUM% id %OBJID%${DENIAL_TAIL}a FlowField over a system table); the test is not run`,
  ], // PR-54 class "... a FlowField over a system table"
  [
    "denial-modify-missing-row",
    `${DENIAL}modify permission on object type %NUM% id %OBJID%${DENIAL_TAIL}on a row that does not exist (which error comes first is not pinned)); the test is not run`,
  ], // PR-54 class "a permission denial (modify ...)"
  [
    "fieldref-method-never-assigned",
    "FieldRef.%FIELDREFM% on a FieldRef that was never assigned: what BC does (an error, or a no-op) is not pinned (docs/probes-needed.md)",
  ], // PR-54 class "FieldRef.* on a FieldRef that was never assigned"
  [
    "recordref-method-not-open",
    "RecordRef.%RECORDREFM% on a RecordRef that is not open: BC's error text, and whether Get(RecordId) opens the table of the RecordId, are not pinned (docs/probes-needed.md)",
  ], // PR-54 class "RecordRef.* on a RecordRef that is not open"
  [
    "geturl-unpinned-object-type",
    `${GETURL}ClientType::Default or Windows) of object type %IDENT% with %NUM% arguments (only a page or a report, and a page with a record and UseFilters false, or true for Default, are pinned)`,
  ], // PR-54 class "GetUrl(*): (only a page or a report, ...)"
  [
    "geturl-phone-tablet-desktop",
    `${GETURL}Option member '%IDENT%'; the call had %NUM% arguments): for Phone, Tablet and Desktop only a company, a page or report with a positive id, and a page with a record and UseFilters false are pinned`,
  ], // PR-54 class "GetUrl(*): for Phone, Tablet and Desktop ..."
  [
    "geturl-company-characters",
    `${GETURL}ClientType::%IDENT%; the call had %NUM% arguments): a company of other characters than letters, digits and space`,
  ], // PR-54 class "GetUrl(*): a company of other characters ..."
  [
    "geturl-object-type-or-arguments",
    `${GETURL}ClientType::%IDENT%; the call had %NUM% arguments): this object type or argument list`,
  ], // PR-54 class "GetUrl(*): this object type or argument list"
  ["no-client-current-client-type", `CurrentClientType${NO_CLIENT}`],
  ["no-client-page-run", `Page.Run with a record or a page name${NO_CLIENT}`],
  ["no-client-page-runmodal", `Page.RunModal with a record or a page name${NO_CLIENT}`],
  [
    "no-client-report-request-page-handler",
    `the request page of report "Cell Report" with a RequestPageHandler or ReportHandler bound${NO_CLIENT}`,
  ],
  ["no-client-run-request-page", `Report.RunRequestPage${NO_CLIENT}`],
  [
    "dotnet-timezone-display-name",
    "DotNet System.TimeZoneInfo.DisplayName: refused by policy: member 'System.TimeZoneInfo.DisplayName' (the Windows zone data BC reads differs from the IANA data of a non-Windows .NET host)",
  ],
  [
    "dotnet-timezone-get-utc-offset",
    "DotNet System.TimeZoneInfo.GetUtcOffset: refused by policy: member 'System.TimeZoneInfo.GetUtcOffset' (the Windows zone data BC reads differs from the IANA data of a non-Windows .NET host); off Windows it runs only for one DateTime of the session clock's year, or on the zone of the id UTC made in process",
  ],
  [
    "dotnet-mock-graph-query",
    `DotNet new Microsoft.Dynamics.Nav.AzureADGraphClient.MockGraphQuery: refused by policy: server class 'Microsoft.Dynamics.Nav.AzureADGraphClient.MockGraphQuery${POLICY_TAIL}`,
  ],
  [
    "dotnet-page-summary-get-summary-fields",
    `DotNet Microsoft.Dynamics.Nav.Runtime.PageSummary.NavPageSummaryALFunctions.GetSummaryFields: refused by policy: server class 'Microsoft.Dynamics.Nav.Runtime.PageSummary.NavPageSummaryALFunctions${POLICY_TAIL}`,
  ],
  [
    "dotnet-page-summary-get-available-table-fields",
    `DotNet Microsoft.Dynamics.Nav.Runtime.PageSummary.NavPageSummaryALFunctions.GetAvailableTableFields: refused by policy: server class 'Microsoft.Dynamics.Nav.Runtime.PageSummary.NavPageSummaryALFunctions${POLICY_TAIL}`,
  ],
  [
    "dotnet-learn-has-in-geo-support",
    `DotNet Microsoft.Dynamics.Nav.Service.CopilotApi.AL.ALMicrosoftLearnFunctions.HasInGeoSupport: refused by policy: server class 'Microsoft.Dynamics.Nav.Service.CopilotApi.AL.ALMicrosoftLearnFunctions${POLICY_TAIL}`,
  ],
  [
    "dotnet-copilot-gpt-token-count",
    "DotNet Microsoft.Dynamics.Nav.Service.CopilotApi.AL.ALCopilotFunctions.GptTokenCount: a member the runtime does not implement for a registry type (never forwarded to .NET, ADR-014 section 1)",
  ],
  [
    "dotnet-copilot-platform-authorization",
    "DotNet ALCopilotFunctions.IsPlatformAuthorizationConfigured for a Microsoft caller or other arguments",
  ],
  [
    "register-table-connection-other-string",
    "RegisterTableConnection with a connection string other than @@test@@ (no Dataverse in the runtime)",
  ],
  [
    "crm-insert-through-table-connection",
    "Insert on a TableType = CRM table through a table connection: whether the table's triggers run is not pinned",
  ],
  ["yaml-list-indent", "ReadFromYaml of a mapping item in a list at another indent than 4"],
  [
    "yaml-null-or-number",
    "ReadFromYaml of a null form or a number other than `null` and a whole number",
  ],
  [
    "yaml-blank-line-nested",
    "ReadFromYaml of a carriage return or a blank line in a nested, list or flow form",
  ],
  ["yaml-flow-quoted-key", "ReadFromYaml of a flow mapping entry with this quoted key"],
  [
    "company-open-subscriber-writes",
    `Company Triggers OnCompanyOpen(Completed) subscriber codeunit "U8013 Open Subscriber".OnOpen writes the database in the test session before the first test, and this test can read table U8013 Open Row: what the test runner does with the writes is not pinned (ADR-046 amendment 1, A4 item 10)`,
  ],
  [
    "find-empty-set-u8013",
    "Find on an empty set of table 'U8013 Find Row' without using the result and without a filter: BC's error text is not pinned (docs/probes-needed.md)",
  ],
  [
    "find-empty-set-time-zone",
    "Find on an empty set of table 'Time Zone' without using the result and without a filter: BC's error text is not pinned (docs/probes-needed.md)",
  ],
  ["file-name-got-guid", "a file name, got Guid"],
  [
    "sql-counter-stored",
    "storing in a record field of a SQL counter value (SessionInformation.SqlStatementsExecuted or SqlRowsRead): the corpus pins only that a counter is not negative and the sign of its change around pinned operations, never a count",
  ],
  [
    "xmlport-unbound-text-element",
    "XmlPort export of the unbound text element ColumnX (BC's export of it does not end; not pinned)",
  ],
  [
    "feature-key-rollback",
    "a rollback of an uncommitted Feature Key change (whether it is undone is a Linux suspect, not settled)",
  ],
  ["setfilter-not-a-number", "SetFilter: `%FILTER%` is not %KIND%"], // PR-54 class "SetFilter"
  ["blob-to-integer", "conversion of Blob to Integer"],
  [
    "user-windows-sid",
    "a User with a Windows Security ID: the platform's uniqueness rule for it is not pinned",
  ],
  [
    "deleteall-filter-group-1",
    "DeleteAll on a record of a table with a filter in filter group 1 (the global group) that another record set: BC applies it to every record of the table for the session, the runtime does not",
  ],
  [
    "consistent-filter-group-1",
    "Consistent on a record of a table with a filter in filter group 1 (the global group) that another record set: BC applies it to every record of the table for the session, the runtime does not",
  ],
  [
    "autoformat-expression-procedure",
    "a control over table field Amount whose AutoFormatExpression calls a procedure (BC runs it when the row is fetched; not modelled)",
  ],
  ["database-sid-no-user", "Database.SID without a user name (whose SID it answers is not pinned)"],
  [
    "gotokey-statement-no-row",
    "GoToKey, GoToRecord or the move back of a Find...Field call, as a statement for a key no row has, on a page that is neither a list nor a part",
  ],
  ["clear-xmlwriteoptions", "Clear of a XmlWriteOptions value"],
  [
    "removecookie-last",
    "RemoveCookie of the last cookie of a request (what its Cookie header is then is not pinned)",
  ],
  ["error-errorinfo-not-created", "Error with an ErrorInfo nobody created"],
  [
    "query-metadata-al-namespace",
    "the value of field 'AL Namespace' of platform table 'Query Metadata' is not known for any row: no corpus test pins it (docs/probes-needed.md)",
  ],
  [
    "part-visible-other-shape",
    "an action that makes a part visible, other than the pinned shape (a Document page opened with OpenEdit, on a stored row without an unsaved edit, whose action body only sets the variable, shows a linked part without a repeater that was hidden since the page opened): the host page or its source table has other code, an extension, a subscriber or other properties than the measured one",
  ],
  [
    "xmlport-import-header",
    "XmlPort import: the row of table element Header stored before its child rows is gone after them",
  ],
  ["xml-name-empty", "XML name `` (only plain names without a prefix are pinned)"],
  ["evaluate-now-date", "Evaluate of `11..NOW` into Date (form not pinned by the corpus)"],
  ["evaluate-now-time", "Evaluate of `11:11:11..NOW` into Time (form not pinned by the corpus)"],
  ["evaluate-format-2", "Evaluate with format number 2 (not pinned by the corpus)"],
  ["asdecimal-text-control", "AsDecimal of a Text control whose text has digits but is no number"],
  [
    "page-no-record-onopenpage",
    "a page opened without a record whose OnOpenPage left Rec where its view has no row",
  ],
  [
    "httpclient-relative-path",
    "HttpClient with the relative request path `relative/path` and no base address: which error it raises is not measured (docs/probes-needed.md)",
  ],
  // PR-74 (coord PR-74, spec 2026-11-16-pr74-t9-refusal-families.md): the families DO window t9 met, each
  // driven by an invented cell of family `t9-refusals` to t9's exact text and measured CLEAN by PR-54's strict
  // census (`/coord/handoff/PR-74/census/`). Pinned by `al-runner-serve-pr74.test.ts`.
  ["setfilter-value-expected", "SetFilter: value expected after %SETOP%"], // PR-54 class "SetFilter"
  [
    "evaluate-decimal-comparison",
    "Evaluate of `%CMP%` into Decimal (form not pinned by the corpus)",
  ],
  [
    "report-parameters-no-xml-declaration",
    "a parameters string without the XML declaration in this form, given to Report.%REPORTM% (which character BC's filter error names is not pinned)",
  ],
  [
    "dotnet-zip-central-directory-corrupt",
    "DotNet new System.IO.Compression.ZipArchive raised the .NET exception System.IO.InvalidDataException: Central Directory corrupt. <- System.IO.IOException: An attempt was made to move the position before the beginning of the stream.; the text AL would see is not pinned (ADR-014 section 7)",
  ], // PR-54 class "DotNet * raised the .NET exception *"
  [
    "dotnet-json-writer-no-token-to-close",
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteEndObject raised the .NET exception Newtonsoft.Json.JsonWriterException: No token to close. Path ''.; the text AL would see is not pinned (ADR-014 section 7)",
  ], // PR-54 class "DotNet * raised the .NET exception *"
  [
    "dotnet-json-writer-start-object-in-object",
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raised the .NET exception Newtonsoft.Json.JsonWriterException: Token StartObject in state Object would result in an invalid JSON object. Path '%JSONPATH%'.; the text AL would see is not pinned (ADR-014 section 7)",
  ], // PR-54 class "DotNet * raised the .NET exception *"; PR-74 did not drive WritePropertyName or WriteEndArray (PR-93 does, below)
  ["boolean-false-to-biginteger", "conversion of Boolean false to BigInteger"],
  // PR-93 (coord PR-93, spec 2026-11-16-pr93-t10-t11-refusal-families.md): the texts DO windows t10/t11 still
  // closed on, each driven by an invented cell of family `t10-refusals` to the exact text and measured CLEAN by
  // PR-54's strict census with every distinct text a refuser (`--refusers 7`, `/coord/handoff/PR-93/census2/`).
  // Not kept: Report.RunRequestPage (measured after a Commit() only; inside a write transaction v3 does not refuse,
  // so that form cannot be measured: PR-74 review H1 stands), the SaveAs-with-layout errors and the placeholder Pdf
  // read (no invented cell can produce them). Pinned by `al-runner-serve-pr93.test.ts`.
  ["keyref-method-never-assigned", "KeyRef.%KEYREFM% on a KeyRef that was never assigned"], // PR-54 class "KeyRef.* on a KeyRef that was never assigned"
  ["setfilter-unexpected-gt-date-range", "SetFilter: unexpected `>` in filter `<-1M>..<CM>`"], // PR-54 class "SetFilter"
  [
    "setfilter-date-text-no-form",
    "SetFilter: text filter value `%DATETEXT%` for Date: no form pinned for this language (formulas and other region formats are not pinned, docs/probes-needed.md)",
  ], // PR-54 class "SetFilter"
  ["setfilter-not-a-biginteger", "SetFilter: `%BIGCODE%` is not a BigInteger"], // PR-54 class "SetFilter"
  ["setfilter-empty-term", "SetFilter: empty filter term"], // PR-54 class "SetFilter"
  ["page-run-recordref", "Page.Run with RecordRef as the record"],
  ["page-run-unassigned-variant", "Page.Run with an unassigned Variant as the record"],
  ["recordref-gettable-text-not-a-record", "RecordRef.GetTable of Text 'Not a record'"],
  [
    "report-saveas-id-zero",
    "Report.SaveAs#2 of id 0, which no report declares (error text not pinned)",
  ],
  [
    "xmldocument-readfrom-not-instream",
    "XmlDocument.ReadFrom of something that is not an InStream",
  ],
  ["outstream-untouched-handle", "an OutStream was expected, got an untouched handle"],
  ["code-gl-to-biginteger", "conversion of Code 'GL00000000' to BigInteger"],
  ["calcdate-outside-range", "CalcDate result outside 0001-9999 (error text not pinned)"],
  [
    "dotnet-json-writer-end-array-no-token",
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteEndArray raised the .NET exception Newtonsoft.Json.JsonWriterException: No token to close. Path ''.; the text AL would see is not pinned (ADR-014 section 7)",
  ], // PR-54 class "DotNet * raised the .NET exception *"
  [
    "dotnet-json-writer-property-in-array",
    "DotNet Newtonsoft.Json.JsonTextWriter.WritePropertyName raised the .NET exception Newtonsoft.Json.JsonWriterException: Token PropertyName in state %ARRAYSTATE% would result in an invalid JSON object. Path 'message.toRecipients'.; the text AL would see is not pinned (ADR-014 section 7)",
  ], // PR-54 class "DotNet * raised the .NET exception *"
  // PR-105 (coord PR-105, spec 2026-11-17-pr105-t12-t13-refusal-families.md): the texts DO windows t12/t13 still
  // closed on, each driven by an invented cell of family `t12-refusals` to the exact text and measured CLEAN by
  // PR-54's strict census with every distinct text a refuser (`--refusers 7`, `/coord/handoff/PR-105/census/`).
  // Not kept: RunRequestPage (PR-74 review H1 stands), the SaveAs-with-layout errors, the placeholder Pdf read (no
  // invented cell produces them), and the list-without-the-new-row-line text (no cell produced it). The
  // setfilter and JSON writer texts are widened in their own entries above (BIGCODE, JSONPATH); the Evaluate NUL
  // runs get their own entry below.
  // Pinned by `al-runner-serve-pr105.test.ts`.
  [
    "fieldref-calcfield-not-flowfield",
    "FieldRef.CalcField of a field that is not a FlowField (not pinned)",
  ],
  ["evaluate-decimal-nul-run", "Evaluate of `%NULS%` into Decimal (form not pinned by the corpus)"],
  ["conversion-text-to-blob", `conversion of Text '<?xml version="1.0" encoding="...' to Blob`],
  [
    "action-left-another-row",
    "an action left another row (another primary key) in Rec with changes to save (not pinned)",
  ],
  ["conversion-text-to-integer", "conversion of Text '%INTTEXT%' to Integer"],
  ["copystream-untouched-to-dotnet", "CopyStream from an untouched handle into a DotNet stream"],
  [
    "report-saveas2-untouched-handle",
    "Report.SaveAs#2 to an untouched handle, which is not an OutStream",
  ],
  // PR-133 (coord PR-133, spec 2026-11-17-pr133-x2-restarts-precommitment.md): two of the texts DO's x2 window
  // still closed its daemon on, each driven by an invented cell of family `x2-refusals` to the exact text and
  // measured CLEAN by PR-54's strict census (`--refusers 7`, `/coord/handoff/PR-133/census2/`): `C*` joins BIGCODE
  // above, and the GetTable entry below is new.
  // Not kept: Report.RunRequestPage (DO reaches it with no request-page handler, on a BaseApp report, inside an
  // open write transaction, and nothing measured what report code runs before the refusal: spec r2 H1/H2), the
  // SaveAs-with-layout errors and the placeholder Pdf read (they need BaseApp's own reports). Pinned by `al-runner-serve-pr133.test.ts`.
  // PR-159 (spec 2026-11-18-pr159-y1-sibling-keeps-precommitment.md): 12345 joins 123 by name (slot %GETTABLEINT%).
  ["recordref-gettable-integer-123", "RecordRef.GetTable of Integer %GETTABLEINT%"],
];
export const V3_SERVE_SAFE_REFUSALS: Readonly<Record<string, RegExp>> = {
  ...Object.fromEntries(PR56_KEPT.map(([name, text]) => [name, pr56Entry(text)])),
  http: /^NotRun: out-of-scope: (?:an outbound HTTP request with no \[HttpClientHandler\] bound to the test: the runtime never opens a connection \(ADR-027\)|an outbound HTTP request that a test handler does not answer: the runtime never opens a connection \(ADR-027\)\. To run the test, bind an \[HttpClientHandler\] that answers the request, or set TestHttpRequestPolicy = BlockOutboundRequests on the test codeunit to get BC's error for it)$/,
  commit:
    /^NotRun: out-of-scope: Commit inside a test under TestIsolation = Function(?:: what the runner keeps is not pinned| is not supported yet: no corpus test pins whether BC keeps the committed rows for the next test \(corpus issue 645\)\. Run this codeunit with TestIsolation = Codeunit \(al-runner: --isolation codeunit, the default\))$/,
  cascade: new RegExp(
    String.raw`^NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran \(${SAFE_TAIL}.*$`,
  ),
  "onrun-failed": new RegExp(
    String.raw`^NotRun: out-of-scope: OnRun failed \(runner behaviour not pinned\): ${SAFE_TAIL}.*$`,
  ),
  "dotnet-exception": new RegExp(
    String.raw`${DOTNET}(?:new )?${DOTNET_NAME} raised the \.NET exception (?:${DOTNET_CLEAN_EXCEPTIONS}): ${SAFE_TAIL}[^\n]*$`,
  ),
  "dotnet-no-object": new RegExp(
    String.raw`${DOTNET}${DOTNET_NAME}: '${DOTNET_NAME}' is an instance member and the variable holds no object$`,
  ),
  "dotnet-assembly": new RegExp(
    // Build review: only the assembly itself missing, never "or one of its dependencies" (a load that began).
    String.raw`${DOTNET}(?:new )?${DOTNET_NAME}: assembly '[^'\n]+' could not be loaded: FileNotFoundException: Could not load file or assembly '[^'\n]+'\. The system cannot find the file specified\. ${SAFE_TAIL}[^\n]*$`,
  ),
  "dotnet-member": new RegExp(
    String.raw`${DOTNET}${DOTNET_NAME}: (?:member|property, field or method|settable property or field) '[^'\n]+' not found on '[^'\n]+'$`,
  ),
  "dotnet-overload": new RegExp(
    String.raw`${DOTNET}(?:new )?${DOTNET_NAME}: (?:new )?${DOTNET_NAME} has no overload taking \d+ argument\(s\) of the given types \([^)\n]*\)$`,
  ),
  "stream-never-created":
    /^NotRun: out-of-scope: use of an (?:In|Out)Stream that was never created$/,
  "dotnet-policy-timezone": new RegExp(
    String.raw`${DOTNET}System\.TimeZoneInfo\.Local: refused by policy: member 'System\.TimeZoneInfo\.Local' \(time zone that bypasses the host\)$`,
  ),
  /**
   * R981 (coord R-967): a read of a platform table al-runner's store has no provider for. Measured
   * clean as R945's families were (`/coord/handoff/R-967/probe/`, edge-c8fe56e05): refusers on
   * `Api Web Service` (2000000193) and `Tenant Media Set` (2000000183), each after R-937's standard
   * writes; 27 readers on one kept daemon all equal the control, 20 fresh daemons one answer equal to
   * it, the pid unchanged, no panic text. The refusal is the store's, before any row is read, so the
   * table is a parameter. APIV1 restarted its daemon 100 times in its baseline on this family (R964).
   */
  // Build review: a WRITE gives the same text without `store error ` (an Insert on `Api Web Service`,
  // measured clean with the same kit), so the prefix is optional; both forms are measured.
  "platform-no-provider":
    /^NotRun: out-of-scope: (?:store error )?platform table '[^'\n]+' \(\d+\) has no provider$/,
  /**
   * R968 (coord R-955): the two families that restarted Continia DO's daemon baseline 7 times in 16 min
   * on edge-736fc7677. Measured clean as R945's were (`/coord/handoff/R-955/restart/result.md`): per
   * family 47 refused requests, 27 readers on one kept daemon all equal to the control, 20 fresh
   * daemons equal, the pid unchanged, no panic text. The reader never saw the key or the sequence
   * (Module scope, isolation "test", coverage off); the basis is R-937's finding that nothing crosses
   * requests under any isolation. The cascade's test name, a name with no comma, is its only variable part.
   */
  "company-findset":
    /^NotRun: out-of-scope: FindSet on the Company table: the database may hold companies this runtime does not know \(ADR-046 decision 4a\)$/,
  /**
   * R1000 (coord R-989): edge-847b1fa5a split the text by kind and names the object: "changed number
   * sequence '<name>' ... (only a new NumberSequence.Insert is)" and "changed isolated storage key
   * '<key>' ... (only a new key's IsolatedStorage.Set is)", each with its own tail; the combined form
   * is kept for the builds before it. Measured with invented AL on both builds
   * (`/coord/handoff/R-989/probe/`): the same shapes give the old text on 736fc7677 and the new one on
   * 847b1fa5a (there only when a later test uses the changed object). The object name is the new
   * variable part, quoted, no quote or line break inside (DO: 'TableSeq32' and GUID-named sequences).
   * Both new texts re-measured clean on 847b1fa5a with R-955's kit (`/coord/handoff/R-989/restart/`):
   * per kind 20 refusals on one kept daemon, 27 readers equal to the control, 20 fresh daemons one
   * answer equal to it, the pid unchanged, no panic text.
   */
  "cascade-existing-state":
    /^NotRun: out-of-scope: an earlier test of this codeunit, [^,\n]+, changed (?:an isolated storage key or a number sequence that existed before it: what the rollback of TestIsolation = Function leaves of it is not measured \(only a new key's IsolatedStorage\.Set and a new NumberSequence\.Insert are\)|number sequence '[^'\n]+' that existed before it: what the rollback of TestIsolation = Function leaves of it is not measured \(only a new NumberSequence\.Insert is\)|isolated storage key '[^'\n]+' that existed before it: what the rollback of TestIsolation = Function leaves of it is not measured \(only a new key's IsolatedStorage\.Set is\))$/,
  /**
   * R998 (coord R-998): the families behind 19 of DO's 35 daemon closes in R-984's window t1. Each
   * text measured clean with R-967's kit on edge-a184cfc79 (`/coord/handoff/R-998/probe/`): one
   * invented refuser per text after R-937's standard writes, one-shot text equal to DO's; on one kept
   * daemon 27 readers equal to the control, 20 fresh daemons one answer equal to it, the pid unchanged,
   * no panic text. Only the measured RecordRef methods, and only FieldRef.Class.
   */
  "recordref-not-open":
    /^NotRun: out-of-scope: RecordRef\.(?:FieldCount|FindSet|SetRecFilter|SetLoadFields) on a RecordRef that is not open: BC's error text, and whether Get\(RecordId\) opens the table of the RecordId, are not pinned \(docs\/probes-needed\.md\)$/,
  "fieldref-never-assigned":
    /^NotRun: out-of-scope: FieldRef\.Class on a FieldRef that was never assigned: what BC does \(an error, or a no-op\) is not pinned \(docs\/probes-needed\.md\)$/,
  "gettable-unassigned-variant":
    /^NotRun: out-of-scope: RecordRef\.GetTable of an unassigned Variant$/,
  /**
   * R1009 (coord PR-29): DO's 7 of 10 remaining mutant-phase closes in R-998's window. Measured clean
   * with R-967's kit on edge-5a58a0f16 (`/coord/handoff/R1009-keep/probe/`): refuser 51006 after
   * R-937's standard writes, one-shot text equal to DO's; on one kept daemon 27 readers equal to the
   * control, 20 fresh daemons one answer equal to it, the pid unchanged, no panic text. Shape reduced
   * on #8139 (the measured table has an OnBeforeDeleteEvent subscriber, as leg C's case does). The
   * table name is the only variable part, at most 30 characters (an AL object name) and on one line;
   * the rest is literal.
   */
  "stale-buffer-after-lock":
    /^NotRun: out-of-scope: a stale [^\n]{1,30} buffer from its own write, after a lock other than LockTable or a ReadIsolation read in the open transaction \(not pinned\)$/,
  /**
   * PR-47: DO t6's 64 closes. Measured clean with R-967's kit on edge-5a58a0f16 (`/coord/handoff/PR-47/`):
   * one-shot text equal to DO's; on one kept daemon 27 readers equal to the control, 20 fresh daemons one
   * answer equal to it, the pid unchanged, no panic text. The shape: a modal list sorted descending by a
   * key other than the primary key, with OnAfterGetRecord and OnAfterGetCurrRecord, opened on a blank
   * record (so on the last row of its view) over more rows than a window, then one GoToKey. The text is
   * kept whole, no variable part. NOT kept: the sibling texts (for example "GoToKey on a list in a key
   * other than the primary key, after a move or a GoToKey"), the ascending wording, any other tail.
   */
  "gotokey-desc-last-row-above-window":
    /^NotRun: out-of-scope: GoToKey on a list that opened on the last row of its descending view, with more rows above the rows it holds than a window \(not pinned\)$/,
  /**
   * PR-53: DO t7's 35 closes. Measured CLEAN (`/coord/handoff/PR-53/README.md`, R-967's kit on
   * edge-5a58a0f16): 47 of 47 answers carry the text, 27 of 27 readers on a kept daemon equal the
   * control, 20 fresh daemons give one answer, no panic. The shape: `GlobalLanguage(1030);
   * Rec.SetFilter(BooleanField, 'Ja')`. The language number is the only variable part (digits).
   * GlobalLanguage is NOT carried to the next test (a reader reads 1033 after every refusal).
   */
  "setfilter-boolean-language-words":
    /^NotRun: out-of-scope: SetFilter: a Boolean filter value under GlobalLanguage \d{1,5} \(the words of that language are not pinned\)$/,
  /**
   * PR-54: DO closes of `File.DownloadFromStream`: 11 in all over t5-t7 (about 3-5 per run, all this
   * text). Measured CLEAN in the keep census (`/coord/handoff/PR-54/census.md`, R-967's kit on
   * edge-5a58a0f16): 1 refuser, 4 kept + 3 fresh readers equal the control, no panic. The control is
   * weak: the reader cannot see even a passing setter's writes, so CLEAN means nothing crossed
   * requests. No variable part: DO's 11 events carry one text.
   */
  "download-from-stream-needs-client":
    /^NotRun: out-of-scope: File\.DownloadFromStream needs a client \(a browser round trip\), which a headless run has not$/,
  /**
   * PR-54: DO closes of `DotNet new System.IO.Compression.ZipArchive` on a stream that holds no zip
   * (6 in all over t4-t8, about 1-2 per run, all this text, message included). Measured CLEAN in the
   * keep census (`/coord/handoff/PR-54/census.md`, repro u8036-refusals' shape: 1 refuser, 4 kept + 3
   * fresh readers equal the control, no panic; same weak control). It has no leg C case: the zip
   * family needs the .NET helper, which the update gate lacks; the serve-rule tests pin it. The .NET message is pinned whole: another
   * exception type or message was not measured and closes. (`System.IO.InvalidDataException` is not
   * in DOTNET_CLEAN_EXCEPTIONS, so the general dotnet-exception entry does not keep it.)
   */
  "zip-archive-invalid-data":
    /^NotRun: out-of-scope: DotNet new System\.IO\.Compression\.ZipArchive raised the \.NET exception System\.IO\.InvalidDataException: End of Central Directory record could not be found\.; the text AL would see is not pinned \(ADR-014 section 7\)$/,
  /**
   * R1019 (coord PR-14): the cascade after a test that failed while it held a manual event subscription
   * (a BindSubscription whose UnbindSubscription it never reached): the next test's bind is refused.
   * Filter Tokens closed its daemon 424 times on it (466 daemons for 343 mutants, edge-5a58a0f16).
   * Measured clean with R-967's kit on edge-5a58a0f16 (`/coord/handoff/PR-14/probe/`, invented AL):
   * the refuser binds a codeunit-global manual subscriber, raises, fails; readers bind the same
   * subscriber (must succeed, one call) or only raise (no call). On one kept daemon 72 reader answers
   * after refusals all equal the control, 20 fresh daemons equal it, the pid unchanged, no panic text,
   * under isolation "test" and "codeunit"; a PASSING test that never unbinds measured the same. The
   * failing test's name and message are the variable part (a SAFE_TAIL); the rest is fixed. Review: the
   * greedy `.*` would also take a text nobody measured (two cascades joined, a status other than
   * "failed"); that stays contained because the earlier test ran in the SAME request, so its own row
   * is in the same answer and judged by this rule: an unsafe refusal there closes the daemon anyway.
   * Measured with a separate subscriber codeunit; Filter Tokens' test codeunit binds itself (checked by
   * the R1019 pre-commitment's Filter Tokens re-run, per mutant).
   */
  "cascade-manual-binding": new RegExp(
    String.raw`^NotRun: out-of-scope: a test before this one in the codeunit did not pass \(${SAFE_TAIL}.*\) and left a manual event subscription bound that it would have unbound later: the bindings this test starts with are not BC's; this failure is not trusted: The binding of codeunit \d+ was unsuccessful\. The codeunit has already been bound\.$`,
  ),
  /**
   * PR-18 lever 1: DO's two biggest restart causes in R-984's window t3 (24 and 9 of 46 restarts, each a
   * ~29 s compile plus a whole-suite warm-up). Measured clean with R-967's kit on edge-847b1fa5a and
   * edge-5a58a0f16 (`/coord/handoff/PR-18/probe/README.md`, invented AL), isolation "test" and "codeunit":
   * on one kept daemon 72 reader answers after refusals equal to the control, 20 fresh daemons equal it,
   * the pid unchanged, no panic text. Readers saw WorkDate, a SingleInstance text, the session's language
   * and default and standard-4 formats, and a fresh zip; under isolation "test" rows and Blobs roll back per
   * test, so a leaked row is not observable (as for every entry here). Review: NOT measured is the .NET
   * helper's own state across requests (it lives for the daemon; a refused Dispose may leave a half-
   * disposed archive behind in it); the DO window that brings this in is compared with earlier windows per
   * mutant, which is where such a leak would show. Only the measured texts:
   * the ZipArchive Update-over-held-bytes Dispose (not in leg C: its serve fact runs without the .NET
   * helper, like R945's), and standard format 4 under FormatRegion 'en-GB' (DO's; leg C case 50686-50687).
   */
  "zip-dispose-over-held-bytes":
    /^NotRun: out-of-scope: DotNet System\.IO\.Compression\.ZipArchive\.Dispose: a \.NET write over the bytes an AL OutStream held before the call \(what the Blob then holds is not pinned\)$/,
  "format-region-std4":
    /^NotRun: out-of-scope: Format of a value \(standard format 4\) while CurrReport\.FormatRegion is 'en-GB' is not pinned \(docs\/probes-needed\.md\)$/,
  /**
   * PR-18 follow-up (R1043): DO's dominant restart cause in R-984's window t4 (63 of 87 daemons, ~88 s each). The caption of a
   * TestPage on a page with DataCaptionExpression and no source table; al-runner refuses BEFORE the expression runs. Measured
   * clean with R-967's kit on edge-847b1fa5a and edge-5a58a0f16, isolation "test" and "codeunit"
   * (`/coord/handoff/PR-18/probe-caption/README.md`, invented AL): 72 kept-daemon reader answers and 40 fresh ones equal to the
   * control, the pid unchanged, no panic text. Review follow-up: the refused test leaves its TestPage open, so readers that
   * open, edit and close a TestPage and that Trap a page, and refusers with a pending Trap or an unused [HandlerFunctions],
   * were added: 124 kept and 80 fresh reader answers per run equal to the control (12 runs). Not measured: a page extension's
   * DataCaptionExpression (another text), a page with a source table, request pages, a modal handler pending at the refusal.
   * Leg C case 50688-50689.
   */
  "caption-no-source-table":
    /^NotRun: out-of-scope: the caption of a page with DataCaptionExpression and no source table \(not pinned\)$/,
};

/** R612: which close rule a `--server`/`serve` daemon follows. Chosen by the backend that owns
 *  the daemon, never from the rows. */
export type ServeDaemonRule = "v2" | "v3";

/**
 * R612: true when the daemon may serve another request after this answer's rows.
 * - v2 (R517 I2 + I-1, unchanged): every row is `pass` or `fail`.
 * - v3: every row is `pass`/`fail` without `notRun` and without v3's refusal marker
 *   (`isV3RefusalText`: R672, anywhere since R675), or a `notRun` `error` row whose message is
 *   one of `V3_SERVE_SAFE_REFUSALS`. Anything else (a timeout, a panic, an unknown kind) closes.
 *   A test name seen twice THROWS `AlRunnerServeDuplicateRowError` (build review r1 M-3: in the
 *   rule, so every serve path that applies it gets the check). The caller closes the daemon on a
 *   throw, as for any `runTests` throw (R517 C1).
 */
export function serveDaemonReusable(
  rows: readonly ServerTestLine[],
  rule: ServeDaemonRule,
): boolean {
  if (rule === "v2") return rows.every((t) => t.status === "pass" || t.status === "fail");
  const seen = new Set<string>();
  for (const t of rows) {
    if (seen.has(t.name)) throw new AlRunnerServeDuplicateRowError(t.name);
    seen.add(t.name);
  }
  return rows.every((t) => {
    // R672, R675: a plain pass/fail that holds v3's refusal marker says the runtime's state is not
    // trusted.
    if (t.status === "pass" || t.status === "fail")
      return t.notRun !== true && !isV3RefusalText(t.message);
    const m = t.message;
    return (
      t.notRun === true &&
      t.status === "error" &&
      m !== undefined &&
      Object.values(V3_SERVE_SAFE_REFUSALS).some((re) => re.test(m))
    );
  });
}

/** R612 (v3 rule): one answer named a test twice. Never legitimate (measure.md), so a stale
 *  writer: the daemon is closed and the run is an error, never a silent overwrite. */
export class AlRunnerServeDuplicateRowError extends Error {
  constructor(name: string) {
    super(
      `al-runner serve: the answer names test "${name}" more than once, which no measured answer does; the daemon is closed and this run is an error (R612)`,
    );
    this.name = "AlRunnerServeDuplicateRowError";
  }
}
