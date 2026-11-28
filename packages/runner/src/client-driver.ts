import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PR-479 (479a) round 2: the TypeScript side of the bcdev-client sidecar (`packages/runner/client-driver`).
 * Spec: `docs/superpowers/specs/2026-11-28-pr479a-bcdev-client-driver.md`, amendments 1 and 2.
 *
 * Protocol. We write ONE JSON command on the driver's stdin, then one go line per hand-off:
 *   opened, readback, ready -> [go bind] -> bound, ran -> [go end] -> ended -> [go close] -> closed.
 * The read-back on page 130455 happens BEFORE the op exists (before ready), so a refusal there wedges nothing.
 * The driver answers with JSON lines `{step, ok, ms, detail}`. A failure is `{step:"error", ok:false, detail:{error, message}}`.
 * Rules this class keeps by itself, besides the driver's own:
 *   - `end()` throws `ClientDriverSequenceError` unless `ran()` returned (End only after "All tests executed.");
 *   - between `ended` and our go:close the driver must send nothing; a line there is `ClientDriverProtocolError`;
 *   - every wait has a deadline; a passed one kills the driver (closing without End) and throws.
 * Nothing here talks to a server: the driver does.
 */

export interface ClientDriverCommand {
  /** The lethal config FILE; the driver reads the login from its bcdev section. Never the login itself. */
  readonly configPath: string;
  readonly webClientBaseUrl: string;
  readonly company: string;
  readonly codeunitId: number | string;
  /** The declared method names of the codeunit, in declared order (the read-back must equal them). */
  readonly methods: readonly string[];
  readonly attemptId: string;
  readonly opSeq: number;
  readonly suiteName?: string;
  readonly tenant?: string;
  /** The driver prints the method-line repeater's state at each load strategy to stderr as JSON. */
  readonly diagnostic?: boolean;
  readonly deadlines?: {
    readonly openSeconds?: number;
    readonly stepSeconds?: number;
    readonly testSeconds?: number;
    readonly goSeconds?: number;
  };
}

export interface ClientDriverStep {
  readonly step: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: Record<string, unknown>;
}

/** The driver refused, by name (a read-back difference, a missing control, Bound not Yes, ...). */
export class ClientDriverRefusedError extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(`client-driver-refused (${refusal}): ${message}`);
    this.name = "ClientDriverRefusedError";
  }
}
/** A deadline passed, in the driver (it named it) or on our side (we killed the driver). The op did not End. */
export class ClientDriverDeadlineError extends Error {
  constructor(
    readonly where: string,
    message: string,
  ) {
    super(`client-driver-deadline (${where}): ${message}`);
    this.name = "ClientDriverDeadlineError";
  }
}
/** The driver process ended before the step we waited for. */
export class ClientDriverDiedError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly waitingFor: string,
    readonly stderrTail: string,
  ) {
    super(
      `client-driver-died: exit ${exitCode} while waiting for "${waitingFor}". stderr tail: ${stderrTail || "(empty)"}`,
    );
    this.name = "ClientDriverDiedError";
  }
}
/** The driver reported a session error (open failed, the connection broke, stdin closed early). */
export class ClientDriverSessionError extends Error {
  constructor(
    readonly errorName: string,
    message: string,
  ) {
    super(`client-driver-session (${errorName}): ${message}`);
    this.name = "ClientDriverSessionError";
  }
}
/** The driver could not read the command or the login (exit code 5). */
export class ClientDriverCommandError extends Error {
  constructor(
    readonly errorName: string,
    message: string,
  ) {
    super(`client-driver-command (${errorName}): ${message}`);
    this.name = "ClientDriverCommandError";
  }
}
/** Output we cannot read, a step out of order, or the driver speaking when it must be silent. */
export class ClientDriverProtocolError extends Error {
  constructor(message: string) {
    super(`client-driver-protocol: ${message}`);
    this.name = "ClientDriverProtocolError";
  }
}
/** A call out of order on our side: `end()` before `ran()`, or any call before its predecessor. */
export class ClientDriverSequenceError extends Error {
  constructor(message: string) {
    super(`client-driver-sequence: ${message}`);
    this.name = "ClientDriverSequenceError";
  }
}
/** The sidecar is not built (or the configured path is missing). */
export class ClientDriverNotBuiltError extends Error {
  constructor(path: string) {
    super(
      `client-driver-not-built: no driver at ${path}. Build it with "bun scripts/build-client-driver.ts --bc-client <dir> --wcf <dir>", or set bcdev.clientDriverPath.`,
    );
    this.name = "ClientDriverNotBuiltError";
  }
}

const STEP_ORDER = ["opened", "readback", "ready", "bound", "ran", "ended", "closed"] as const;
const DEFAULT_DRIVER_DLL = resolve(
  import.meta.dir,
  "..",
  "client-driver",
  "out",
  "client-driver.dll",
);
/** Our timeouts sit this far past the driver's own deadline, so the driver's named deadline arrives first. */
const MARGIN_MS = 10_000;

/** The command line that starts the sidecar. A `.dll` runs under dotnet; anything else is run as is. */
export function resolveClientDriverArgv(clientDriverPath?: string): string[] {
  const path = clientDriverPath ?? DEFAULT_DRIVER_DLL;
  if (!existsSync(path)) throw new ClientDriverNotBuiltError(path);
  if (!path.endsWith(".dll")) return [path];
  const dotnet = existsSync("/opt/dotnet/dotnet") ? "/opt/dotnet/dotnet" : "dotnet";
  return [dotnet, path];
}

export interface ClientDriverOptions {
  /** Overrides the command line (tests start a fake driver this way). */
  readonly argv?: readonly string[];
  readonly clientDriverPath?: string;
  /** How far past the driver's own deadline our timeout sits (default 10 s). Tests shrink it. */
  readonly marginMs?: number;
}

/** Round 3's seam: the backend starts a driver through this. */
export type ClientDriverLauncher = (
  cmd: ClientDriverCommand,
  opts?: ClientDriverOptions,
) => ClientDriverSession;

export const startClientDriver: ClientDriverLauncher = (cmd, opts = {}) => {
  const argv = opts.argv ?? resolveClientDriverArgv(opts.clientDriverPath);
  const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return new ClientDriverSession(proc, cmd, opts.marginMs ?? MARGIN_MS);
};

export class ClientDriverSession {
  private readonly queue: string[] = [];
  private streamEnded = false;
  private wake: (() => void) | undefined;
  private stderrText = "";
  private lastStep = -1;
  private ranDone = false;
  private endedDone = false;
  private closeSent = false;
  private readonly t: { open: number; step: number; test: number; go: number };

  constructor(
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    cmd: ClientDriverCommand,
    marginMs: number = MARGIN_MS,
  ) {
    const d = cmd.deadlines ?? {};
    this.t = {
      open: (d.openSeconds ?? 30) * 1000 + marginMs,
      step: (d.stepSeconds ?? 30) * 1000 + marginMs,
      test: (d.testSeconds ?? 300) * 1000 + marginMs,
      go: (d.goSeconds ?? 120) * 1000 + marginMs,
    };
    void this.pump(proc.stdout, (l) => this.queue.push(l));
    void this.pump(proc.stderr, (l) => {
      this.stderrText = `${this.stderrText}${l}\n`.slice(-2000);
    });
    proc.stdin.write(`${JSON.stringify(cmd)}\n`);
    proc.stdin.flush();
  }

  private async pump(
    stream: ReadableStream<Uint8Array>,
    onLine: (l: string) => void,
  ): Promise<void> {
    const dec = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of stream) {
        rest += dec.decode(chunk, { stream: true });
        let i = rest.indexOf("\n");
        while (i >= 0) {
          const line = rest.slice(0, i).trim();
          rest = rest.slice(i + 1);
          if (line !== "") onLine(line);
          this.wake?.();
          i = rest.indexOf("\n");
        }
      }
    } catch {
      // a killed process ends its streams; the exit code tells the story
    }
    if (rest.trim() !== "") onLine(rest.trim());
    if (stream === this.proc.stdout) this.streamEnded = true;
    this.wake?.();
  }

  private kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  private async nextLine(waitingFor: string, ms: number): Promise<string> {
    const until = Date.now() + ms;
    for (;;) {
      const line = this.queue.shift();
      if (line !== undefined) return line;
      if (this.streamEnded) {
        const code = await Promise.race([this.proc.exited, Bun.sleep(2000).then(() => null)]);
        throw new ClientDriverDiedError(code, waitingFor, this.stderrText.trim());
      }
      const left = until - Date.now();
      if (left <= 0) {
        this.kill();
        throw new ClientDriverDeadlineError(
          "client",
          `no "${waitingFor}" within ${ms} ms; the driver was killed without End`,
        );
      }
      await new Promise<void>((resolveWake) => {
        const timer = setTimeout(resolveWake, left);
        this.wake = () => {
          clearTimeout(timer);
          resolveWake();
        };
      });
      this.wake = undefined;
    }
  }

  private parse(line: string): ClientDriverStep {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      throw new ClientDriverProtocolError(`not JSON: ${line.slice(0, 200)}`);
    }
    if (typeof o !== "object" || o === null)
      throw new ClientDriverProtocolError(`not an object: ${line.slice(0, 200)}`);
    const r = o as Record<string, unknown>;
    if (typeof r.step !== "string" || typeof r.ok !== "boolean") {
      throw new ClientDriverProtocolError(`no step/ok: ${line.slice(0, 200)}`);
    }
    return {
      step: r.step,
      ok: r.ok,
      ms: typeof r.ms === "number" ? r.ms : 0,
      ...(typeof r.detail === "object" && r.detail !== null
        ? { detail: r.detail as Record<string, unknown> }
        : {}),
    };
  }

  /** The named error for a driver `error` step. */
  private mapError(s: ClientDriverStep): Error {
    const name = typeof s.detail?.error === "string" ? s.detail.error : "unknown";
    const message = typeof s.detail?.message === "string" ? s.detail.message : "";
    this.kill();
    if (name === "deadline") return new ClientDriverDeadlineError("driver", message);
    if (name === "bad-command" || name === "config-login-missing")
      return new ClientDriverCommandError(name, message);
    if (name === "session-error" || name === "stdin-closed")
      return new ClientDriverSessionError(name, message);
    return new ClientDriverRefusedError(name, message);
  }

  private async expect(step: (typeof STEP_ORDER)[number], ms: number): Promise<ClientDriverStep> {
    const want = STEP_ORDER.indexOf(step);
    for (;;) {
      const s = this.parse(await this.nextLine(step, ms));
      if (s.step === "error") throw this.mapError(s);
      const got = STEP_ORDER.indexOf(s.step as (typeof STEP_ORDER)[number]);
      if (got < 0) throw new ClientDriverProtocolError(`unknown step "${s.step}"`);
      if (got <= this.lastStep || got > want) {
        throw new ClientDriverProtocolError(
          `step "${s.step}" out of order while waiting for "${step}"`,
        );
      }
      this.lastStep = got;
      if (!s.ok)
        throw new ClientDriverProtocolError(
          `step "${s.step}" reported ok=false without an error step`,
        );
      if (got === want) return s;
    }
  }

  private send(go: "bind" | "end" | "close"): void {
    this.proc.stdin.write(`${JSON.stringify({ go })}\n`);
    this.proc.stdin.flush();
  }

  /** The session is open (the driver reported its company-parameter finding in `detail`). */
  opened(): Promise<ClientDriverStep> {
    return this.expect("opened", this.t.open);
  }

  /** Page 130455's read-back (codeunit, methods, Run flags, runner, company) matched; no op exists yet. */
  readback(): Promise<ClientDriverStep> {
    if (this.lastStep < 0) throw new ClientDriverSequenceError("readback() before opened()");
    return this.expect("readback", this.t.step * 4);
  }

  /**
   * The page 130455 set-up and every read-back passed, with no op bound yet (a refusal there throws here and wedges nothing).
   * The caller Activates next, then calls bind().
   */
  ready(): Promise<ClientDriverStep> {
    if (this.lastStep < 0) throw new ClientDriverSequenceError("ready() before opened()");
    return this.expect("ready", this.t.step * 4 + this.t.go);
  }

  /** Go to bind (the caller ran ActivateForClient first). Resolves when page 91015 answered Bound = Yes. */
  async bind(): Promise<ClientDriverStep> {
    if (this.lastStep < STEP_ORDER.indexOf("ready"))
      throw new ClientDriverSequenceError("bind() before ready()");
    this.send("bind");
    return this.expect("bound", this.t.step * 2 + this.t.go);
  }

  /** The codeunit's tests ran to "All tests executed."; `detail.results` has each TestResultJson. */
  async ran(): Promise<ClientDriverStep> {
    const s = await this.expect("ran", this.t.test);
    this.ranDone = true;
    return s;
  }

  /** Go to End (the caller Deactivates the bound id first). Only after `ran()`. */
  async end(): Promise<ClientDriverStep> {
    if (!this.ranDone) {
      throw new ClientDriverSequenceError(
        'end() before all tests executed: End is never sent unless "All tests executed." was seen',
      );
    }
    this.send("end");
    const s = await this.expect("ended", this.t.step * 2);
    this.endedDone = true;
    return s;
  }

  /** Go to close (the caller Deactivates in between). The driver must have been silent since `ended`. */
  async close(): Promise<ClientDriverStep> {
    if (!this.endedDone)
      throw new ClientDriverSequenceError("close() before ended: use abort() to close without End");
    if (this.queue.length > 0 || this.streamEnded) {
      this.kill();
      throw new ClientDriverProtocolError(
        `the driver sent ${this.queue.length === 0 ? "its exit" : JSON.stringify(this.queue[0]).slice(0, 200)} between End and close, without our go`,
      );
    }
    this.closeSent = true;
    this.send("close");
    const s = await this.expect("closed", this.t.step * 2);
    const code = await Promise.race([this.proc.exited, Bun.sleep(this.t.step).then(() => null)]);
    if (code !== 0) throw new ClientDriverDiedError(code, "exit", this.stderrText.trim());
    return s;
  }

  /**
   * Closes WITHOUT End (the op stays in flight): any failure path, and a run that did not finish. Kills our own child.
   * Returns the exit code, or null if it had to be killed.
   */
  async abort(): Promise<number | null> {
    this.kill();
    return await Promise.race([this.proc.exited, Bun.sleep(5000).then(() => null)]);
  }

  /** The driver's stderr tail (first-chance exceptions, library events; never the login). */
  get stderrTail(): string {
    return this.stderrText.trim();
  }
}
