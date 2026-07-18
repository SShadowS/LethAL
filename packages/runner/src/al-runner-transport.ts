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
