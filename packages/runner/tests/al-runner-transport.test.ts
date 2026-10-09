import { describe, expect, test } from "bun:test";
import { oneShotLimits } from "../src/al-runner-backend";
import {
  OneShotTransport,
  buildAlRunnerArgv,
  parseAlRunnerPayload,
  qualifiedTestName,
  timeoutAbortTests,
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
  // budgets, through the same `oneShotLimits` AlRunnerBackend uses (R516: in-run limit = the
  // budget rounded up to whole seconds, client deadline = twice the budget).
  test("the runner's own per-test budget always leaves real margin below the client deadline", async () => {
    for (const budgetMs of [2000, 5000, 14000, 120000]) {
      const { testTimeoutSeconds, deadlineMs } = oneShotLimits(budgetMs);
      const { envs, spawn } = recording({ tests: [] });
      await new OneShotTransport("al-runner", spawn).send({
        ...req,
        testTimeoutSeconds,
        deadlineMs,
      });
      const seconds = Number(envs[0]?.AL_RUNNER_TEST_TIMEOUT_SEC);
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

// R551: `--test-exact <name>` rides right after `--test <name>`, only when asked for.
describe("buildAlRunnerArgv — --test-exact (R551)", () => {
  const argvReq = {
    sourceDir: "C:/proj/app",
    testDir: "C:/proj/tests",
    qualifiedTest: "Codeunit78950.GrowPre",
  };

  test("A1: testExact gives --test X --test-exact X, adjacent, once, and no --exclude-test", () => {
    const argv = buildAlRunnerArgv("al-runner", { ...argvReq, testExact: true });
    const t = argv.indexOf("--test");
    expect(argv.slice(t, t + 4)).toEqual([
      "--test",
      argvReq.qualifiedTest,
      "--test-exact",
      argvReq.qualifiedTest,
    ]);
    expect(argv.filter((a) => a === "--test-exact").length).toBe(1);
    expect(argv).not.toContain("--exclude-test");
  });

  test("A2: without testExact the argv is today's, element for element", () => {
    expect(
      buildAlRunnerArgv("al-runner", {
        ...argvReq,
        excludeTests: ["Codeunit78950.GrowPreTwin"],
      }),
    ).toEqual([
      "al-runner",
      "--output-json",
      "--isolation",
      "test",
      "--test",
      "Codeunit78950.GrowPre",
      "--exclude-test",
      "Codeunit78950.GrowPreTwin",
      "--auto-provision",
      "C:/proj/app",
      "C:/proj/tests",
    ]);
  });
});

/**
 * R518. al-runner 2.12.0-main.43f76177 exits 3 on a one-shot test timeout: a bundle that RAN has a
 * TEST-TIMEOUT-ABORT suite error. Exit 3 is read as results ONLY when the envelope proves that
 * (`timeoutAbortTests`); every other exit 3 stays `kind: "error"`.
 */
describe("OneShotTransport exit 3: read only a proven test-timeout abort (R518)", () => {
  // /coord/handoff/R-518/measure.md run 1: the stdout al-runner printed, byte for byte.
  const RUN1_STDOUT = String.raw`{
  "tests": [
    {
      "name": "Codeunit79620.LongSpin",
      "status": "error",
      "durationMs": 20072,
      "message": "Test exceeded 20s timeout.",
      "stackTrace": "\u0022R517 Probe Logic\u0022(CodeUnit 79600).SpinFor line 8 - R517 Probe by LethAL version 1.0.0.0\n\u0022R517 Probe Tests\u0022(CodeUnit 79620).LongSpin line 5 - R517 Probe Tests by LethAL version 1.0.0.0"
    }
  ],
  "passed": 0,
  "failed": 0,
  "errors": 1,
  "skipped": 0,
  "total": 1,
  "exitCode": 3,
  "seed": 598161538,
  "suiteErrors": [
    {
      "file": "/work/lethal-wt/r518/scripts/r517-probe/tests",
      "errors": [
        "tests: TEST-TIMEOUT-ABORT: R517 Probe Tests (Codeunit79620).LongSpin: watchdog timeout aborted the run \u2014 0 further [Test] method(s) in this codeunit did not run (0 total)"
      ]
    }
  ],
  "wallSeconds": 21.8637794
}
`;
  // measure.md run 3: a TEST-app compile error, also exit 3 (the scratch path shortened).
  const RUN3_STDOUT = String.raw`{
  "tests": [],
  "passed": 0,
  "failed": 0,
  "errors": 0,
  "skipped": 0,
  "total": 0,
  "exitCode": 3,
  "seed": 41286883,
  "compilationErrors": [
    {
      "file": "/tmp/scratchpad/badtests",
      "errors": [
        "\u003Cbundled\u003E: EMIT-ZERO (1 AL error(s))"
      ]
    }
  ],
  "wallSeconds": 4.4625051
}
`;

  const NAME = "Codeunit79620.LongSpin";
  const ABORT_LINE =
    "tests: TEST-TIMEOUT-ABORT: R517 Probe Tests (Codeunit79620).LongSpin: watchdog timeout aborted the run — 0 further [Test] method(s) in this codeunit did not run (0 total)";
  const ROW = {
    name: NAME,
    status: "error",
    durationMs: 20072,
    message: "Test exceeded 20s timeout.",
  };
  function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tests: [ROW],
      exitCode: 3,
      suiteErrors: [{ file: "/tests", errors: [ABORT_LINE] }],
      ...over,
    };
  }
  async function sendExit3(stdout: string) {
    const spawn: SpawnFn = async () => ({ exitCode: 3, stdout, stderr: "stderr text" });
    return new OneShotTransport("al-runner", spawn).send({ ...req, qualifiedTest: NAME });
  }

  test("run 1's envelope, verbatim, on exit 3 is kind=tests with the rows unchanged", async () => {
    const res = await sendExit3(RUN1_STDOUT);
    expect(res.kind).toBe("tests");
    if (res.kind === "tests") expect(res.tests).toEqual(JSON.parse(RUN1_STDOUT).tests);
  });

  test("the same envelope behind al-runner's banner is accepted too", async () => {
    expect((await sendExit3(alRunnerStdout(envelope()))).kind).toBe("tests");
  });

  test("(a) a second suite-error line that is not a timeout abort refuses", async () => {
    // The EXEC-FAIL line names the row too, so only the marker check can refuse it.
    const errors = [ABORT_LINE, ABORT_LINE.replace("TEST-TIMEOUT-ABORT", "EXEC-FAIL")];
    const res = await sendExit3(
      alRunnerStdout(envelope({ suiteErrors: [{ file: "/t", errors }] })),
    );
    expect(res.kind).toBe("error");
  });

  test("(b) compilationErrors beside a valid abort refuses", async () => {
    const compilationErrors = [{ file: "/x", errors: ["x: COMPILE-FAIL"] }];
    expect((await sendExit3(alRunnerStdout(envelope({ compilationErrors })))).kind).toBe("error");
  });

  test("(c) executionErrors beside a valid abort refuses", async () => {
    const executionErrors = [{ file: "/x", errors: ["x: EXEC-FAIL"] }];
    expect((await sendExit3(alRunnerStdout(envelope({ executionErrors })))).kind).toBe("error");
  });

  test("null compilationErrors and executionErrors count as absent", async () => {
    const env = envelope({ compilationErrors: null, executionErrors: null });
    expect((await sendExit3(alRunnerStdout(env))).kind).toBe("tests");
  });

  test("(d) an abort naming a test with no row, or naming a row that passed, refuses", async () => {
    const other = ABORT_LINE.replace(").LongSpin:", ").Other:");
    const noRow = envelope({ suiteErrors: [{ file: "/t", errors: [other] }] });
    expect((await sendExit3(alRunnerStdout(noRow))).kind).toBe("error");
    const passed = envelope({ tests: [{ ...ROW, status: "pass" }] });
    expect((await sendExit3(alRunnerStdout(passed))).kind).toBe("error");
  });

  test("(e) no suite error refuses: absent, [], [{ errors: [] }], null", async () => {
    const { suiteErrors: _absent, ...absent } = envelope();
    for (const env of [
      absent,
      envelope({ suiteErrors: [] }),
      envelope({ suiteErrors: [{ file: "/t", errors: [] }] }),
      envelope({ suiteErrors: null }),
    ]) {
      expect((await sendExit3(alRunnerStdout(env))).kind).toBe("error");
    }
  });

  test("(f) a non-string suite-error entry refuses", async () => {
    const env = envelope({ suiteErrors: [{ file: "/t", errors: [ABORT_LINE, 42] }] });
    expect((await sendExit3(alRunnerStdout(env))).kind).toBe("error");
    // Refused, not thrown: `send` would turn a throw into an error too, hiding a missing guard.
    expect(timeoutAbortTests(alRunnerStdout(env))).toBeUndefined();
  });

  test("(f) an envelope exitCode other than 3 on a process exit 3 refuses; null is absent", async () => {
    expect((await sendExit3(alRunnerStdout(envelope({ exitCode: 1 })))).kind).toBe("error");
    expect((await sendExit3(alRunnerStdout(envelope({ exitCode: null })))).kind).toBe("tests");
  });

  test("(g) run 3's compile-error envelope, verbatim, stays kind=error", async () => {
    const res = await sendExit3(RUN3_STDOUT);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.detail).toBe("stderr text");
  });

  test("marker near-miss: TEST-TIMEOUT-ABORTED and TEST-TIMEOUT refuse (equality, not prefix)", async () => {
    for (const marker of ["TEST-TIMEOUT-ABORTED", "TEST-TIMEOUT"]) {
      const line = ABORT_LINE.replace("TEST-TIMEOUT-ABORT", marker);
      const env = envelope({ suiteErrors: [{ file: "/t", errors: [line] }] });
      expect((await sendExit3(alRunnerStdout(env))).kind).toBe("error");
    }
  });

  test("timeoutAbortTests never throws on unreadable stdout", () => {
    expect(timeoutAbortTests("")).toBeUndefined();
    expect(timeoutAbortTests("{ not json")).toBeUndefined();
    expect(timeoutAbortTests("[1,2]")).toBeUndefined();
  });

  test("an exit-3 envelope with no `tests` key is refused, not thrown", async () => {
    const { tests: _tests, ...noTests } = envelope();
    expect(() => timeoutAbortTests(alRunnerStdout(noTests))).not.toThrow();
    expect(timeoutAbortTests(alRunnerStdout(noTests))).toBeUndefined();
    expect((await sendExit3(alRunnerStdout(noTests))).kind).toBe("error");
  });

  test("a suite-error entry with no `errors` array is refused, not thrown", () => {
    const env = envelope({ suiteErrors: [{ file: "/t" }] });
    expect(() => timeoutAbortTests(alRunnerStdout(env))).not.toThrow();
    expect(timeoutAbortTests(alRunnerStdout(env))).toBeUndefined();
  });
});
