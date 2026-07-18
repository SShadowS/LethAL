import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emitStaticSelector } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestOutcome,
  TestVerdict,
} from "./backend";
import { defaultSpawn } from "./publisher";
import type { SpawnFn } from "./publisher";

/** al-runner's own per-test timeout message (verified against v1.0.31). */
const RUNNER_TIMEOUT_MESSAGE = /Test exceeded \d+s timeout/;

export interface AlRunnerConfig {
  readonly alRunnerPath: string; // path to the al-runner executable
  readonly instrumentedDir: string; // schemata output (LethAL-owned scratch)
  readonly testDir: string;
  readonly packagesDir?: string; // --packages symbol resolution
  readonly stubsDir?: string; // --stubs for target-app dependencies
  readonly selectorObjectId: number; // id used when rewriting MutationSelector.Codeunit.al
}

export class AlRunnerBackend implements ExecutionBackend {
  // Set by deploy(); until then (or if deploy() is never called — existing
  // callers may drive activate()/run() directly against cfg.instrumentedDir)
  // activeDir() falls back to the statically configured instrumented dir.
  private deployedDir: string | undefined;

  constructor(
    private readonly cfg: AlRunnerConfig,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {}

  capabilities(): BackendCapabilities {
    return { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false };
  }

  async status(): Promise<BackendStatus> {
    // al-runner has no --version flag (it errors out); --help is the
    // verified reachability probe (exits 0).
    const res = await this.spawn([this.cfg.alRunnerPath, "--help"]).catch((e) => ({
      exitCode: -1,
      stdout: "",
      stderr: String(e),
    }));
    return res.exitCode === 0
      ? { ok: true, details: res.stdout.trim() }
      : { ok: false, details: `al-runner not runnable: ${res.stderr}` };
  }

  async deploy(instrumentedDir: string): Promise<void> {
    // In-memory backends have no publish step, but they still need to know
    // which per-batch instrumented dir activate()/run() should target.
    this.deployedDir = instrumentedDir;
  }

  private activeDir(): string {
    return this.deployedDir ?? this.cfg.instrumentedDir;
  }

  async activate(mutantId: string | null): Promise<void> {
    await writeFile(
      join(this.activeDir(), "MutationSelector.Codeunit.al"),
      emitStaticSelector({ objectId: this.cfg.selectorObjectId, activeId: mutantId ?? "" }),
      "utf8",
    );
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Aborted on timeout so the losing side of the race below doesn't leak
    // a still-running al-runner child process (see I8).
    const controller = new AbortController();
    try {
      const argv = [
        this.cfg.alRunnerPath,
        "--run",
        ref.method,
        this.activeDir(),
        this.cfg.testDir,
        "--output-json",
        // al-runner defaults to `codeunit` isolation (state shared within a
        // codeunit across its test methods); force `method` so the actual
        // behavior matches the `isolation: "full-reset"` capability this
        // backend advertises below.
        "--test-isolation",
        "method",
      ];
      if (this.cfg.packagesDir) argv.push("--packages", this.cfg.packagesDir);
      if (this.cfg.stubsDir) argv.push("--stubs", this.cfg.stubsDir);

      const res = await Promise.race([
        this.spawn(argv, { signal: controller.signal }),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("timeout");
          }, opts.timeoutMs);
        }),
      ]);
      const durationMs = Date.now() - started;
      if (res === "timeout") return { ref, outcome: "deadline-exceeded", durationMs };
      if (res.exitCode === 2)
        return { ref, outcome: "skip", durationMs, failureMessage: res.stdout || res.stderr };
      if (res.exitCode === 3 || res.exitCode < 0) {
        return { ref, outcome: "error", durationMs, failureMessage: res.stderr || res.stdout };
      }
      const parsed = parseAlRunnerOutput(res.stdout);
      const t = parsed.find((x) => x.name === ref.method);
      if (!t)
        return {
          ref,
          outcome: "error",
          durationMs,
          failureMessage: "al-runner output missing the requested test",
        };
      const runnerTimedOut =
        t.status === "fail" && t.message !== undefined && RUNNER_TIMEOUT_MESSAGE.test(t.message);
      const outcome: TestOutcome =
        t.status === "pass" ? "pass" : runnerTimedOut ? "timeout" : "fail";
      return {
        ref,
        outcome,
        // Wall-clock `durationMs` (process spawn -> exit), NOT `t.durationMs`
        // (al-runner's in-VM test-body timing, e.g. ~30ms). Verified against
        // a real install: al-runner re-transpiles + recompiles the WHOLE
        // instrumented project from scratch on every invocation (~1.2s even
        // for this tiny fixture), so the orchestrator's per-mutant timeout
        // budget (`2 * this test's baseline durationMs`, see orchestrator.ts)
        // must reflect that full round-trip cost. Using the in-VM figure
        // instead produced a ~50ms budget against a ~1.2s real call — every
        // mutant run then hit the Promise.race timeout before al-runner's
        // process could even finish compiling, so nothing was ever actually
        // killed.
        durationMs,
        ...(t.message !== undefined ? { failureMessage: t.message } : {}),
      };
    } catch (err) {
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Verified against a real al-runner install (2026-07-18): stdout with
// --output-json is this envelope; there is no `codeunit` field on an entry,
// and field names are `name`/`status` (not `method`/`result`).
interface AlRunnerEnvelope {
  tests?: AlRunnerTest[];
  passed?: number;
  failed?: number;
  errors?: number;
  total?: number;
  exitCode?: number;
}

interface AlRunnerTest {
  name: string;
  status: string;
  durationMs?: number;
  message?: string;
  stackTrace?: string;
  alSourceLine?: number;
  alSourceColumn?: number;
}

function parseAlRunnerOutput(stdout: string): AlRunnerTest[] {
  const parsed = JSON.parse(stdout) as AlRunnerEnvelope;
  return parsed.tests ?? [];
}
