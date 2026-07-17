import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emitStaticSelector } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "./backend";
import { defaultSpawn } from "./publisher";
import type { SpawnFn } from "./publisher";

export interface AlRunnerConfig {
  readonly alRunnerPath: string; // path to the al-runner executable
  readonly instrumentedDir: string; // schemata output (LethAL-owned scratch)
  readonly testDir: string;
  readonly packagesDir?: string; // --packages symbol resolution
  readonly stubsDir?: string; // --stubs for target-app dependencies
  readonly selectorObjectId: number; // id used when rewriting MutationSelector.Codeunit.al
}

export class AlRunnerBackend implements ExecutionBackend {
  constructor(
    private readonly cfg: AlRunnerConfig,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {}

  capabilities(): BackendCapabilities {
    return { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false };
  }

  async status(): Promise<BackendStatus> {
    const res = await this.spawn([this.cfg.alRunnerPath, "--version"]).catch((e) => ({
      exitCode: -1,
      stdout: "",
      stderr: String(e),
    }));
    return res.exitCode === 0
      ? { ok: true, details: res.stdout.trim() }
      : { ok: false, details: `al-runner not runnable: ${res.stderr}` };
  }

  async deploy(_instrumentedDir: string): Promise<void> {
    // no-op: the CLI reads the instrumented source directly
  }

  async activate(mutantId: string | null): Promise<void> {
    await writeFile(
      join(this.cfg.instrumentedDir, "MutationSelector.Codeunit.al"),
      emitStaticSelector({ objectId: this.cfg.selectorObjectId, activeId: mutantId ?? "" }),
      "utf8",
    );
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const argv = [
        this.cfg.alRunnerPath,
        "--run",
        ref.method,
        this.cfg.instrumentedDir,
        this.cfg.testDir,
        "--output-json",
      ];
      if (this.cfg.packagesDir) argv.push("--packages", this.cfg.packagesDir);
      if (this.cfg.stubsDir) argv.push("--stubs", this.cfg.stubsDir);

      const res = await Promise.race([
        this.spawn(argv),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
        }),
      ]);
      const durationMs = Date.now() - started;
      if (res === "timeout") return { ref, outcome: "timeout", durationMs };
      if (res.exitCode === 2)
        return { ref, outcome: "skip", durationMs, failureMessage: res.stdout || res.stderr };
      if (res.exitCode === 3 || res.exitCode < 0) {
        return { ref, outcome: "error", durationMs, failureMessage: res.stderr || res.stdout };
      }
      const parsed = parseAlRunnerOutput(res.stdout);
      const t = parsed.find((x) => x.method === ref.method);
      if (!t)
        return {
          ref,
          outcome: "error",
          durationMs,
          failureMessage: "al-runner output missing the requested test",
        };
      return {
        ref,
        outcome: t.result === "pass" ? "pass" : "fail",
        durationMs: t.durationMs ?? durationMs,
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

interface AlRunnerTest {
  codeunit: string;
  method: string;
  result: string;
  durationMs?: number;
  message?: string;
}

function parseAlRunnerOutput(stdout: string): AlRunnerTest[] {
  const parsed = JSON.parse(stdout) as { tests?: AlRunnerTest[] };
  return parsed.tests ?? [];
}
