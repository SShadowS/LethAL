import { type SpawnFn, defaultSpawn } from "./publisher";

export interface AlRunnerRequest {
  readonly sourceDir: string;
  readonly testDir: string;
  /**
   * The name al-runner v2 both FILTERS on (`--test`) and REPORTS back, which is the
   * qualified `Codeunit<id>.<method>` form — build it with `qualifiedTestName` and never
   * by hand, so the filter we send and the row a caller matches cannot drift apart.
   */
  readonly qualifiedTest: string;
  readonly packagesDir?: string;
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
  | { readonly kind: "error"; readonly detail: string };

export interface AlRunnerTransport {
  send(req: AlRunnerRequest): Promise<AlRunnerResult>;
  close(): Promise<void>;
}

/**
 * al-runner v2 reports and selects tests by their QUALIFIED name — measured against the
 * installed al-runner v2.0.0.0 (2026-08-07): `--test Codeunit79601.PassesQuietly` selected
 * exactly that one test, and the JSON rows carry the same qualified `name`. This is the ONE
 * place that name is built, so the `--test` filter and the result lookup can never disagree;
 * two independent spellings would mean the runner ran one thing and the caller scored another.
 */
export function qualifiedTestName(codeunitId: number, method: string): string {
  return `Codeunit${codeunitId}.${method}`;
}

/** Enough stdout to recognise what the runner actually said, without dumping a whole suite. */
function stdoutPrefix(stdout: string): string {
  const head = stdout.slice(0, 400);
  return JSON.stringify(stdout.length > 400 ? `${head}...` : head);
}

/**
 * al-runner v2 writes a human progress banner to stdout BEFORE the `--output-json` envelope
 * (measured against v2.0.0.0: `[r2r] re-execing ...`, `[bc] no --bc-version given ...`,
 * `al-runner - running 2 bundle(s)`, a per-bundle line each), so `JSON.parse(stdout)` throws on
 * every real run.
 *
 * The envelope is found as the LAST line that BEGINS with `{` at column zero, and runs from
 * there to the end of output. Three things about that rule are deliberate:
 * - column zero, because banner lines may CONTAIN a brace and "the first `{` anywhere" would
 *   slice mid-banner;
 * - `begins with` rather than `is exactly`, because the measured pretty-printed envelope opens
 *   with a bare `{` line while a compact one-line envelope would open the same way — accepting
 *   both costs nothing and rejects nothing a bare-`{` rule would have accepted;
 * - LAST rather than first, because the envelope always comes after the banner.
 *
 * THROWS rather than returning `[]` on anything it cannot read. An empty test list is
 * indistinguishable from "the filter matched no tests", and a caller that sees no failing test
 * scores the mutant SURVIVED — a silently-empty confirmation, this project's signature bug and
 * the reason R97 exists.
 */
export function parseAlRunnerPayload(stdout: string): readonly AlRunnerRawTest[] {
  const lines = stdout.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").startsWith("{")) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    throw new Error(
      `al-runner produced no --output-json envelope (no line beginning with "{"): ${stdoutPrefix(stdout)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(start).join("\n"));
  } catch (err) {
    throw new Error(
      `al-runner's --output-json envelope is not valid JSON (${err instanceof Error ? err.message : String(err)}): ${stdoutPrefix(stdout)}`,
    );
  }
  const tests =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { tests?: unknown }).tests
      : undefined;
  if (!Array.isArray(tests)) {
    throw new Error(
      `al-runner's --output-json envelope has no "tests" array — a project that failed to COMPILE answers with compilationErrors[] and no tests, and must not be read as "no test failed": ${stdoutPrefix(stdout)}`,
    );
  }
  return tests as readonly AlRunnerRawTest[];
}

/**
 * The exact argv this adapter sends al-runner, in one place.
 *
 * Exported because `al-runner-contract.ts` (R123) measures the wire contract by spawning al-runner
 * ITSELF rather than through `OneShotTransport` — a probe routed through the transport cannot see
 * an exit code the transport already swallowed. That only tells the truth if the probe's command
 * line is the transport's command line; two independent spellings would mean the probe blessed a
 * command nobody runs. So both call this.
 *
 * v2 argv, measured against the installed al-runner v2.0.0.0 (2026-08-07). The v1 shape it replaced
 * (`--run <method> ... --test-isolation method --packages --stubs --test-timeout`) is not merely
 * deprecated: v2 answers an unknown flag with `Unknown option '--run'.` and exit 2, so every one of
 * those spellings had to go.
 */
export function buildAlRunnerArgv(
  alRunnerPath: string,
  req: Pick<AlRunnerRequest, "sourceDir" | "testDir" | "qualifiedTest" | "packagesDir">,
): string[] {
  const argv = [
    alRunnerPath,
    "--output-json",
    // v2 renamed the flag AND the mode. `test` gives every [Test] fresh state, which is what
    // AlRunnerBackend.capabilities() claims as `full-reset`. v2 still ACCEPTS `method`, but only as
    // a v1 alias for `codeunit` (state shared within a codeunit) — so the v1 argv was silently
    // buying the weaker isolation (R96).
    "--isolation",
    "test",
    "--test",
    req.qualifiedTest,
    // R125 (measured 2026-08-07 on al-runner 2.1.0.0): with no BC version given, the runner selects
    // the build it was COMPILED against — 28.1.49838.50794 for 2.1.0.0 — and refuses, because a
    // project's `.alpackages` hold SYMBOL-only Microsoft apps and the runtime (R2R) apps for that
    // build are not in its artifact cache. Every mutant then came back `error` and the whole run
    // measured nothing: `itest:alrunner` went 3/13/0 -> 0/0/0 the moment the tool auto-updated.
    //
    // `--auto-provision` is upstream's own named remedy for exactly this ("or re-run with
    // --auto-provision"), and it resolves the version from the PROJECT rather than from the binary
    // — which is the version whose symbols the project actually carries. Cheap after the first
    // run: artifacts are cached per BC version on the machine.
    //
    // Placed BEFORE the positional bundle dirs deliberately: they are positional and repeatable, so
    // every flag belongs ahead of them.
    "--auto-provision",
    // Bundle dirs are POSITIONAL and repeatable in v2; multiple dirs run sequentially and
    // aggregate into one summary envelope.
    req.sourceDir,
    req.testDir,
  ];
  if (req.packagesDir) argv.push("--package-cache", req.packagesDir);
  return argv;
}

/**
 * The env every al-runner invocation carries. v2 dropped `--test-timeout`; the per-test budget is
 * this variable, and the released build honours it (measured: `AL_RUNNER_TEST_TIMEOUT_SEC=15`
 * produced a 15.027 s test). `SpawnFn` merges this over `process.env`, so PATH survives.
 *
 * Exported alongside `buildAlRunnerArgv` and for the same reason — the contract probe must spawn
 * with the budget the transport spawns with, or its timeout measurement describes a run nobody
 * makes.
 */
export function alRunnerEnv(testTimeoutSeconds: number): Record<string, string> {
  return { AL_RUNNER_TEST_TIMEOUT_SEC: String(testTimeoutSeconds) };
}

/** One al-runner process per request. Correct, and pays full compilation each time. */
export class OneShotTransport implements AlRunnerTransport {
  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {}

  async send(req: AlRunnerRequest): Promise<AlRunnerResult> {
    const argv = buildAlRunnerArgv(this.alRunnerPath, req);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        this.spawn(argv, {
          signal: controller.signal,
          env: alRunnerEnv(req.testTimeoutSeconds),
        }),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("deadline");
          }, req.deadlineMs);
        }),
      ]);
      if (res === "deadline") return { kind: "deadline" };
      // v2 exit codes, from its own --help: 0 = all passed, 1 = at least one test FAILED or
      // ERRORED, 2 = a bundle could not EXECUTE, 3 = a bundle could not COMPILE.
      //
      // Only 0 and 1 carry per-test verdicts. R95: exit 2 used to map to `kind: "skip"`,
      // which turned a process-level failure — the runner never ran the mutant at all —
      // into a silently skipped mutant with no verdict and no error anyone would see. 2 and
      // 3 alike mean "we measured nothing", and so does any negative code (spawn failure),
      // so all of them are errors.
      if (res.exitCode === 0 || res.exitCode === 1)
        return { kind: "tests", tests: parseAlRunnerPayload(res.stdout) };
      return {
        kind: "error",
        detail: res.stderr || res.stdout || `al-runner exited ${res.exitCode} with no output`,
      };
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
 * UNREACHABLE ON v2, deliberately. `AlRunnerBackend` refuses to construct with
 * `serverMode: true` (see its constructor): v2's server protocol reads only
 * `sourcePaths[0]`, so the TEST bundle never runs and every mutant comes back
 * green and empty (R97, reported upstream as al-runner #1658). The class is kept
 * so the protocol handling survives for whenever that is fixed upstream — nothing
 * in a mutation run reaches it today.
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
