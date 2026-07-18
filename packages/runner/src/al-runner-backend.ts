import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emitStaticSelector } from "@lethal/schemata";
import { OneShotTransport, ServerTransport } from "./al-runner-transport";
import type { AlRunnerTransport } from "./al-runner-transport";
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
  // Opt-in: keep one al-runner process warm (server mode) instead of spawning one
  // per test. Off by default until proven verdict-equivalent against a real binary
  // (see the Task 4 live-gate note in the Layer 4.2 plan). Default false.
  readonly serverMode?: boolean;
}

export class AlRunnerBackend implements ExecutionBackend {
  // Set by deploy(); until then (or if deploy() is never called — existing
  // callers may drive activate()/run() directly against cfg.instrumentedDir)
  // activeDir() falls back to the statically configured instrumented dir.
  private deployedDir: string | undefined;
  private readonly transport: AlRunnerTransport;

  constructor(
    private readonly cfg: AlRunnerConfig,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {
    this.transport = cfg.serverMode
      ? new ServerTransport(cfg.alRunnerPath)
      : new OneShotTransport(cfg.alRunnerPath, spawn);
  }

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
    const res = await this.transport.send({
      sourceDir: this.activeDir(),
      testDir: this.cfg.testDir,
      method: ref.method,
      ...(this.cfg.packagesDir !== undefined ? { packagesDir: this.cfg.packagesDir } : {}),
      ...(this.cfg.stubsDir !== undefined ? { stubsDir: this.cfg.stubsDir } : {}),
      // Deliberately well below `deadlineMs`, never equal: `--test-timeout` bounds
      // only the test body inside al-runner, while `deadlineMs` bounds the WHOLE
      // invocation (al-runner recompiles the project from scratch every call, which
      // alone can take several seconds). If the two were equal or close, our client
      // AbortController would always win the race, the runner-confirmed
      // `outcome: "timeout"` path would be unreachable, and every genuine hang would
      // be misclassified as infrastructure noise (`deadline-exceeded`) instead of a
      // real mutant-induced timeout. Halving the budget (min 1s) gives the runner's
      // own timer real margin to fire first.
      testTimeoutSeconds: Math.max(1, Math.floor(opts.timeoutMs / 2000)),
      deadlineMs: opts.timeoutMs,
    });
    const durationMs = Date.now() - started;
    if (res.kind === "deadline") return { ref, outcome: "deadline-exceeded", durationMs };
    if (res.kind === "skip")
      return { ref, outcome: "skip", durationMs, failureMessage: res.detail };
    if (res.kind === "error")
      return { ref, outcome: "error", durationMs, failureMessage: res.detail };
    const t = res.tests.find((x) => x.name === ref.method);
    if (!t)
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: "al-runner output missing the requested test",
      };
    const runnerTimedOut =
      t.status === "fail" && t.message !== undefined && RUNNER_TIMEOUT_MESSAGE.test(t.message);
    const outcome: TestOutcome = t.status === "pass" ? "pass" : runnerTimedOut ? "timeout" : "fail";
    return {
      ref,
      outcome,
      // Wall-clock, NOT the runner's in-VM figure: the orchestrator derives each
      // mutant's timeout budget from this and must include round-trip cost.
      durationMs,
      ...(t.message !== undefined ? { failureMessage: t.message } : {}),
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
