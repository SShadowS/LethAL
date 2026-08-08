import { describe, expect, test } from "bun:test";
import {
  OneShotTransport,
  buildAlRunnerArgv,
  parseAlRunnerPayload,
  qualifiedTestName,
} from "../src/al-runner-transport";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";

const req = {
  sourceDir: "/instr",
  testDir: "/tests",
  qualifiedTest: "Codeunit79100.PostingUpdatesTotal",
  testTimeoutSeconds: 5,
  deadlineMs: 5000,
};

function recording(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push([...argv]);
    envs.push(opts?.env);
    return { exitCode, stdout: alRunnerStdout(payload), stderr: "" };
  };
  return { calls, envs, spawn };
}

describe("qualifiedTestName", () => {
  test("builds v2's Codeunit<id>.<method> form", () => {
    expect(qualifiedTestName(79100, "PostingUpdatesTotal")).toBe(
      "Codeunit79100.PostingUpdatesTotal",
    );
  });
});

describe("parseAlRunnerPayload", () => {
  // The reason this function exists. Real v2 stdout carries a progress banner before the
  // envelope, and one of those banner lines contains a `{` — so both `JSON.parse(stdout)` and a
  // "cut at the first brace anywhere" rule fail on it, while the correct rule (last line
  // beginning with `{` at column zero) does not.
  test("extracts the envelope from banner-polluted stdout, past a banner line containing a brace", () => {
    const stdout = alRunnerStdout({
      tests: [
        { name: "Codeunit79601.FailsLoudly", status: "fail", durationMs: 7, message: "boom" },
      ],
      passed: 0,
      failed: 1,
      errors: 0,
      total: 1,
      exitCode: 1,
    });
    // Guard on the fixture itself: if the banner ever stops containing a brace, this test
    // silently stops proving the thing it was written for.
    expect(stdout.split("\n").some((l) => !l.startsWith("{") && l.includes("{"))).toBe(true);
    expect(() => JSON.parse(stdout)).toThrow();

    const tests = parseAlRunnerPayload(stdout);
    expect(tests).toHaveLength(1);
    expect(tests[0]?.name).toBe("Codeunit79601.FailsLoudly");
    expect(tests[0]?.status).toBe("fail");
    expect(tests[0]?.message).toBe("boom");
  });

  test("a compact one-line envelope with no banner parses too", () => {
    const tests = parseAlRunnerPayload(
      JSON.stringify({
        tests: [{ name: "Codeunit1.A", status: "pass", durationMs: 3 }],
        passed: 1,
      }),
    );
    expect(tests).toEqual([{ name: "Codeunit1.A", status: "pass", durationMs: 3 }]);
  });

  // These used to return `[]`. An empty test list reads exactly like "the filter matched no
  // tests" — the caller sees no failing test and scores the mutant SURVIVED. That is the
  // silently-empty confirmation this project keeps getting bitten by (R97), so each must throw,
  // and the message must quote what the runner actually said so a human can act on it.
  test("stdout with no JSON envelope THROWS, quoting the output", () => {
    const stdout =
      "[r2r] re-execing with DOTNET_ReadyToRun=0 ...\nal-runner - running 1 bundle(s)\n";
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/no --output-json envelope/);
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/re-execing/);
  });

  test("an envelope with no tests array THROWS — a compile failure must not read as 'no test failed'", () => {
    // The measured exit-3 shape: compilationErrors[] and no tests at all.
    const stdout = alRunnerStdout({
      compilationErrors: ["error AL0111: The name 'Foo' does not exist"],
      exitCode: 3,
    });
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/no "tests" array/);
    expect(() => parseAlRunnerPayload(stdout)).toThrow(/compilationErrors/);
  });

  test("a truncated envelope THROWS instead of yielding an empty list", () => {
    expect(() => parseAlRunnerPayload('{"tests": [{"name":')).toThrow(/not valid JSON/);
  });
});

describe("OneShotTransport", () => {
  test("sends the v2 argv: --output-json, --isolation test, --test <qualified>, positional bundle dirs", async () => {
    const { calls, spawn } = recording({
      tests: [{ name: "Codeunit79100.PostingUpdatesTotal", status: "pass" }],
    });
    const t = new OneShotTransport("al-runner", spawn);
    const res = await t.send({ ...req, packagesDir: "/packages" });
    expect(res.kind).toBe("tests");
    const argv = calls[0] ?? [];
    expect(argv).toContain("--output-json");

    // `test` (fresh state per [Test]), never `method` — v2 accepts `method` only as a v1 alias
    // for `codeunit`, i.e. the WEAKER isolation this backend does not claim (R96).
    const isoIdx = argv.indexOf("--isolation");
    expect(isoIdx).toBeGreaterThanOrEqual(0);
    expect(argv[isoIdx + 1]).toBe("test");
    expect(argv).not.toContain("method");

    const testIdx = argv.indexOf("--test");
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(argv[testIdx + 1]).toBe("Codeunit79100.PostingUpdatesTotal");

    // Bundle dirs are positional and repeatable in v2, source before tests.
    expect(argv).toContain("/instr");
    expect(argv).toContain("/tests");
    expect(argv.indexOf("/instr")).toBeLessThan(argv.indexOf("/tests"));

    const cacheIdx = argv.indexOf("--package-cache");
    expect(cacheIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cacheIdx + 1]).toBe("/packages");

    // Every v1 spelling is gone. v2 answers an unknown flag with exit 2, so leaving any of
    // these in would turn every mutant into a process-level failure.
    for (const dead of ["--run", "--packages", "--stubs", "--test-timeout", "--test-isolation"]) {
      expect(argv).not.toContain(dead);
    }
  });

  test("the per-test budget travels as the AL_RUNNER_TEST_TIMEOUT_SEC env var, not a flag", async () => {
    const { envs, spawn } = recording({ tests: [] });
    await new OneShotTransport("al-runner", spawn).send({ ...req, testTimeoutSeconds: 42 });
    expect(envs[0]).toEqual({ AL_RUNNER_TEST_TIMEOUT_SEC: "42" });
  });

  // R95. Exit 2 means a bundle could not EXECUTE — the runner never ran the mutant, so there is
  // no verdict. It used to map to `kind: "skip"`, which turned that process-level failure into a
  // silently skipped mutant carrying no error anyone would look at.
  test("exit 2 (could not execute) and exit 3 (could not compile) are BOTH kind=error", async () => {
    for (const code of [2, 3, -1]) {
      const spawn: SpawnFn = async () => ({
        exitCode: code,
        stdout: "",
        stderr: `bundle blew up (exit ${code})`,
      });
      const res = await new OneShotTransport("al-runner", spawn).send(req);
      expect(res.kind).toBe("error");
      if (res.kind === "error") expect(res.detail).toContain(`exit ${code}`);
    }
  });

  test("exit 1 still carries verdicts — a failing test is a result, not an error", async () => {
    const { spawn } = recording(
      { tests: [{ name: req.qualifiedTest, status: "fail", message: "boom" }] },
      1,
    );
    const res = await new OneShotTransport("al-runner", spawn).send(req);
    expect(res.kind).toBe("tests");
    if (res.kind === "tests") expect(res.tests[0]?.status).toBe("fail");
  });

  test("a hung process yields kind=deadline", async () => {
    const spawn = (async () => new Promise(() => {})) as never;
    const res = await new OneShotTransport("al-runner", spawn).send({ ...req, deadlineMs: 40 });
    expect(res.kind).toBe("deadline");
  });

  // The two timers measure different things and must never be equal: the runner's own per-test
  // budget (v2: the AL_RUNNER_TEST_TIMEOUT_SEC env var) bounds only the test body inside
  // al-runner, while `deadlineMs` bounds the WHOLE invocation (al-runner recompiles the project
  // from scratch every call, which alone can take several seconds). If al-runner's own timeout
  // were >= our client deadline, our AbortController would always win the race and the
  // runner-confirmed `outcome: "timeout"` path would be unreachable in real execution — every
  // genuine hang would be misclassified as infrastructure noise instead of a real timeout.
  // Pinned directly from the spawned env (no real-timer race) against several representative
  // budgets — the same margin formula AlRunnerBackend uses (`Math.max(1,
  // Math.floor(deadlineMs / 2000))`).
  test("the runner's own per-test budget always leaves real margin below the client deadline", async () => {
    for (const deadlineMs of [2000, 5000, 14000, 120000]) {
      const testTimeoutSeconds = Math.max(1, Math.floor(deadlineMs / 2000));
      const { envs, spawn } = recording({ tests: [] });
      await new OneShotTransport("al-runner", spawn).send({
        ...req,
        testTimeoutSeconds,
        deadlineMs,
      });
      const seconds = Number(envs[0]?.AL_RUNNER_TEST_TIMEOUT_SEC);
      // Sub-second edge case: budgets under ~2000ms clamp to the 1s floor, at which
      // point the client may still win the race. Acceptable and honest — not
      // something to engineer around — so this isn't asserted for every budget below
      // the threshold, only for the representative set above where real margin exists.
      expect(seconds * 1000).toBeLessThan(deadlineMs);
    }
  });
});

/**
 * R125 — al-runner 2.1.0.0 shipped and `itest:alrunner` went 3/13/0 -> 0/0/0 with
 * `baselineGreen=false`. Cause, from the runner's own output: with no BC version given it selects
 * the build it was COMPILED against (28.1.49838.50794), and a project's `.alpackages` hold
 * SYMBOL-only Microsoft apps, so there is no runtime to execute against and every mutant comes back
 * `error`. Upstream names the remedy itself: "or re-run with --auto-provision".
 */
describe("buildAlRunnerArgv — --auto-provision (R125)", () => {
  const argvReq = {
    sourceDir: "C:/proj/app",
    testDir: "C:/proj/tests",
    qualifiedTest: "Suite.Test",
  };

  test("every invocation carries --auto-provision", () => {
    expect(buildAlRunnerArgv("al-runner", argvReq)).toContain("--auto-provision");
  });

  test("it precedes the POSITIONAL bundle dirs, which must stay last", () => {
    // Bundle dirs are positional and repeatable in v2, so a flag placed after them is fragile —
    // and the contract probe extracts the dirs from the end of the argv it captures.
    const argv = buildAlRunnerArgv("al-runner", argvReq);
    expect(argv.indexOf("--auto-provision")).toBeLessThan(argv.indexOf(argvReq.sourceDir));
    expect(argv.slice(-2)).toEqual([argvReq.sourceDir, argvReq.testDir]);
  });

  test("--package-cache still follows the dirs, unchanged", () => {
    const argv = buildAlRunnerArgv("al-runner", {
      ...argvReq,
      packagesDir: "C:/proj/.alpackages",
    });
    expect(argv.slice(-4)).toEqual([
      argvReq.sourceDir,
      argvReq.testDir,
      "--package-cache",
      "C:/proj/.alpackages",
    ]);
  });
});
