import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientDriverCommand,
  ClientDriverCommandError,
  ClientDriverDeadlineError,
  ClientDriverDiedError,
  ClientDriverNotBuiltError,
  ClientDriverProtocolError,
  ClientDriverRefusedError,
  ClientDriverSequenceError,
  type ClientDriverSession,
  ClientDriverSessionError,
  resolveClientDriverArgv,
  startClientDriver,
} from "../src/client-driver";

/**
 * PR-479 round 2: the TypeScript client against a FAKE driver (tests/fixtures/fake-client-driver.ts). No server, no
 * dotnet, nothing under /coord. The fake logs every stdin line, so "End was never requested" is read from its log.
 */
const FAKE = join(import.meta.dir, "fixtures", "fake-client-driver.ts");
const dirs: string[] = [];
const live: ClientDriverSession[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.abort();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CMD: ClientDriverCommand = {
  configPath: "/nonexistent/lethal.config.json",
  webClientBaseUrl: "http://web/BC",
  company: "CRONUS",
  codeunitId: 50100,
  methods: ["M1", "M2"],
  attemptId: "a1",
  opSeq: 1,
};

// Deadlines are long (a loaded machine starts the fake slowly); only the step a mode stalls is short.
function start(mode: string): { s: ClientDriverSession; log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "fake-client-driver-"));
  dirs.push(dir);
  const logFile = join(dir, "stdin.log");
  const cmd: ClientDriverCommand = {
    ...CMD,
    deadlines: {
      openSeconds: mode === "stall-open" ? 0.5 : 20,
      stepSeconds: 20,
      testSeconds: mode === "stall-before-ran" ? 0.5 : 20,
      goSeconds: 20,
    },
  };
  const s = startClientDriver(cmd, { argv: [process.execPath, FAKE, mode, logFile], marginMs: 0 });
  live.push(s);
  const log = (): string[] => {
    try {
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l !== "");
    } catch {
      return [];
    }
  };
  return { s, log };
}
const goLines = (lines: string[]): string[] => lines.slice(1);

describe("client driver (fake sidecar)", () => {
  test("happy path: opened, bind, ran, end, close, with the go lines in order", async () => {
    const { s, log } = start("ok");
    expect((await s.opened()).step).toBe("opened");
    expect((await s.bind()).step).toBe("readback");
    const ran = await s.ran();
    expect((ran.detail?.results as string[]).length).toBe(2);
    expect((await s.end()).step).toBe("ended");
    expect((await s.close()).step).toBe("closed");
    expect(goLines(log())).toEqual(['{"go":"bind"}', '{"go":"end"}', '{"go":"close"}']);
  });

  test("the command carries the config PATH and no login", async () => {
    const { s, log } = start("ok");
    await s.opened();
    await s.bind();
    const cmd = JSON.parse(log()[0] ?? "{}") as Record<string, unknown>;
    expect(cmd.configPath).toBe(CMD.configPath);
    expect(JSON.stringify(cmd)).not.toMatch(/password|username/i);
  });

  // Every misbehaviour maps to its named error.
  const cases: ReadonlyArray<{
    mode: string;
    errorClass: new (...a: never[]) => Error;
    check?: (e: Error) => void;
    step: "opened" | "bind" | "ran";
  }> = [
    {
      mode: "die-before-opened",
      errorClass: ClientDriverDiedError,
      step: "opened",
      check: (e) => {
        expect((e as ClientDriverDiedError).exitCode).toBe(9);
        expect((e as ClientDriverDiedError).stderrTail).toContain("FileNotFoundException");
      },
    },
    { mode: "bad-json", errorClass: ClientDriverProtocolError, step: "opened" },
    { mode: "bad-command", errorClass: ClientDriverCommandError, step: "opened" },
    { mode: "open-session-error", errorClass: ClientDriverSessionError, step: "opened" },
    { mode: "stall-open", errorClass: ClientDriverDeadlineError, step: "opened" },
    {
      mode: "bind-refused",
      errorClass: ClientDriverRefusedError,
      step: "bind",
      check: (e) => expect((e as ClientDriverRefusedError).refusal).toBe("bind-refused"),
    },
    {
      mode: "wrong-company",
      errorClass: ClientDriverRefusedError,
      step: "bind",
      check: (e) => expect((e as ClientDriverRefusedError).refusal).toBe("company-mismatch"),
    },
    {
      mode: "run-false",
      errorClass: ClientDriverRefusedError,
      step: "bind",
      check: (e) => expect((e as ClientDriverRefusedError).refusal).toBe("run-flag-false"),
    },
    {
      mode: "missing-row",
      errorClass: ClientDriverRefusedError,
      step: "bind",
      check: (e) => expect((e as ClientDriverRefusedError).refusal).toBe("methods-mismatch"),
    },
    {
      mode: "missing-control",
      errorClass: ClientDriverRefusedError,
      step: "bind",
      check: (e) => expect((e as ClientDriverRefusedError).refusal).toBe("control-missing"),
    },
    {
      mode: "driver-deadline",
      errorClass: ClientDriverDeadlineError,
      step: "ran",
      check: (e) => expect((e as ClientDriverDeadlineError).where).toBe("driver"),
    },
    {
      mode: "stall-before-ran",
      errorClass: ClientDriverDeadlineError,
      step: "ran",
      check: (e) => expect((e as ClientDriverDeadlineError).where).toBe("client"),
    },
  ];
  for (const c of cases) {
    test(`${c.mode} maps to ${c.errorClass.name}`, async () => {
      const { s } = start(c.mode);
      const drive = async (): Promise<void> => {
        await s.opened();
        if (c.step === "opened") return;
        await s.bind();
        if (c.step === "bind") return;
        await s.ran();
      };
      const e = await drive().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(c.errorClass);
      c.check?.(e as Error);
    });
  }

  test("End is never requested unless all tests executed", async () => {
    for (const mode of ["stall-before-ran", "driver-deadline"]) {
      const { s, log } = start(mode);
      await s.opened();
      await s.bind();
      await s.ran().then(
        () => undefined,
        () => undefined,
      );
      await expect(s.end()).rejects.toBeInstanceOf(ClientDriverSequenceError);
      await s.abort();
      expect(log().some((l) => l.includes('"end"'))).toBe(false);
      expect(log().some((l) => l.includes('"close"'))).toBe(false);
    }
  });

  test("the driver sends nothing between End and close except on go", async () => {
    const { s, log } = start("chatty-after-end");
    await s.opened();
    await s.bind();
    await s.ran();
    await s.end();
    await Bun.sleep(300);
    await expect(s.close()).rejects.toBeInstanceOf(ClientDriverProtocolError);
    expect(log().some((l) => l.includes('"close"'))).toBe(false);
  });

  test("close() before ended is a sequence error, bind() before opened too", async () => {
    const { s } = start("ok");
    await expect(s.bind()).rejects.toBeInstanceOf(ClientDriverSequenceError);
    await expect(s.close()).rejects.toBeInstanceOf(ClientDriverSequenceError);
  });

  test("a missing sidecar is ClientDriverNotBuiltError", () => {
    expect(() => resolveClientDriverArgv("/nonexistent/client-driver.dll")).toThrow(
      ClientDriverNotBuiltError,
    );
  });
});
