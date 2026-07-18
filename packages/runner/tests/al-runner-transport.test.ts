import { describe, expect, test } from "bun:test";
import { OneShotTransport, parseAlRunnerPayload } from "../src/al-runner-transport";

const req = {
  sourceDir: "/instr",
  testDir: "/tests",
  method: "PostingUpdatesTotal",
  testTimeoutSeconds: 5,
  deadlineMs: 5000,
};

function recording(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { exitCode, stdout: JSON.stringify(payload), stderr: "" };
  };
  return { calls, spawn };
}

describe("parseAlRunnerPayload", () => {
  test("reads the envelope's tests array", () => {
    const tests = parseAlRunnerPayload(
      JSON.stringify({ tests: [{ name: "A", status: "pass", durationMs: 3 }], passed: 1 }),
    );
    expect(tests).toEqual([{ name: "A", status: "pass", durationMs: 3 }]);
  });
  test("missing tests array yields empty, not a throw", () => {
    expect(parseAlRunnerPayload(JSON.stringify({ passed: 0 }))).toEqual([]);
  });
});

describe("OneShotTransport", () => {
  test("passes --run, --output-json, --test-isolation method and the timeout", async () => {
    const { calls, spawn } = recording({
      tests: [{ name: "PostingUpdatesTotal", status: "pass" }],
    });
    const t = new OneShotTransport("al-runner", spawn);
    const res = await t.send(req);
    expect(res.kind).toBe("tests");
    const argv = calls[0] ?? [];
    expect(argv).toContain("--run");
    expect(argv).toContain("PostingUpdatesTotal");
    expect(argv).toContain("--output-json");
    expect(argv).toContain("--test-isolation");
    expect(argv).toContain("method");
    expect(argv).toContain("--test-timeout");
    expect(argv).toContain("5");
  });

  test("exit 2 is a runner limitation (skip), exit 3 is an error", async () => {
    for (const [code, kind] of [
      [2, "skip"],
      [3, "error"],
    ] as const) {
      const { spawn } = recording({ tests: [] }, code);
      const res = await new OneShotTransport("al-runner", spawn).send(req);
      expect(res.kind).toBe(kind);
    }
  });

  test("a hung process yields kind=deadline", async () => {
    const spawn = (async () => new Promise(() => {})) as never;
    const res = await new OneShotTransport("al-runner", spawn).send({ ...req, deadlineMs: 40 });
    expect(res.kind).toBe("deadline");
  });
});
