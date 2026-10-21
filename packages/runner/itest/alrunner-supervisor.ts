/**
 * R-587: the `--parallel` supervisor's process glue. One worker process per group, at most N at
 * once, longest group first. Kept out of `al-runner.itest.ts` so it can be tested against a fake
 * worker (I4); the verdict on the results is `combineWorkers` in `alrunner-legs.ts`.
 *
 * Workers are spawned DETACHED, so each leads its own process group, and a forwarded signal goes to
 * the whole group: the worker AND its al-runner/dotnet children (I5).
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Semaphore } from "../src/pool";
import { type GroupName, type WorkerResult, scheduleOrder } from "./alrunner-legs";

export interface WorkerSpec {
  readonly group: GroupName;
  /** The full command; the gate passes `[bun, al-runner.itest.ts, --worker, ...]`. */
  readonly argv: readonly string[];
  /** M4: always the supervisor's own cwd (Cobertura labels are relative to it). */
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Where `<group>.log` and `<group>.done.json` live. */
  readonly reportsDir: string;
  /** M3: every worker line, already prefixed `[<group>] `. */
  readonly out: (line: string) => void;
}

export interface RunningWorker {
  readonly pid: number | undefined;
  /** Sends `sig` to the worker's whole process group. */
  kill(sig: NodeJS.Signals): void;
  readonly finished: Promise<WorkerResult>;
}

export function spawnWorker(spec: WorkerSpec): RunningWorker {
  const [cmd, ...args] = spec.argv;
  if (cmd === undefined) throw new Error("R-587: empty worker argv");
  const child = spawn(cmd, args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = join(spec.reportsDir, `${spec.group}.log`);
  const pump = (stream: NodeJS.ReadableStream | null) => {
    let rest = "";
    const emit = (line: string) => {
      appendFileSync(log, `${line}\n`);
      spec.out(`[${spec.group}] ${line}`);
    };
    stream?.setEncoding?.("utf8");
    stream?.on("data", (chunk: string) => {
      rest += chunk;
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) emit(l);
    });
    stream?.on("end", () => {
      if (rest !== "") emit(rest);
      rest = "";
    });
  };
  pump(child.stdout);
  pump(child.stderr);
  const finished = new Promise<WorkerResult>((resolve) => {
    const settle = (exitCode: number | null, signal: string | null) => {
      let done: unknown;
      try {
        done = JSON.parse(readFileSync(join(spec.reportsDir, `${spec.group}.done.json`), "utf8"));
      } catch {
        done = undefined;
      }
      resolve({ group: spec.group, exitCode, signal, ...(done !== undefined ? { done } : {}) });
    };
    child.on("error", () => settle(null, "spawn-error"));
    child.on("close", (code, sig) => settle(code, sig));
  });
  return {
    pid: child.pid,
    kill: (sig) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    },
    finished,
  };
}

export interface SuperviseResult {
  readonly results: WorkerResult[];
  /** The signal that stopped the run, when one did. */
  readonly interrupted?: string;
  /** Per group: seconds from spawn to exit. */
  readonly wallSeconds: Partial<Record<GroupName, number>>;
}

/**
 * Runs `groups` longest first, at most `parallel` at once, never fail-fast. When `signal` aborts,
 * every live worker gets SIGTERM (or the abort reason, when it is a signal name) and no further
 * worker starts; the result then carries `interrupted`, which `combineWorkers` fails.
 */
export async function superviseGroups(opts: {
  readonly groups: readonly GroupName[];
  readonly parallel: number;
  readonly specFor: (group: GroupName) => WorkerSpec;
  readonly signal?: AbortSignal;
}): Promise<SuperviseResult> {
  const sem = new Semaphore(opts.parallel);
  const live = new Set<RunningWorker>();
  const wallSeconds: Partial<Record<GroupName, number>> = {};
  const sigOf = (): NodeJS.Signals => {
    const r = opts.signal?.reason;
    return r === "SIGINT" || r === "SIGTERM" ? r : "SIGTERM";
  };
  opts.signal?.addEventListener("abort", () => {
    for (const w of live) w.kill(sigOf());
  });
  const results = await Promise.all(
    scheduleOrder(opts.groups).map((group) =>
      sem.run(async (): Promise<WorkerResult> => {
        if (opts.signal?.aborted === true) return { group, exitCode: null, signal: "not-started" };
        const t0 = Date.now();
        const w = spawnWorker(opts.specFor(group));
        live.add(w);
        try {
          return await w.finished;
        } finally {
          live.delete(w);
          wallSeconds[group] = (Date.now() - t0) / 1000;
        }
      }),
    ),
  );
  return {
    results,
    ...(opts.signal?.aborted === true ? { interrupted: sigOf() } : {}),
    wallSeconds,
  };
}
