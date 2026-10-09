import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { AL_RUNNER_PREDEFINED_PROBE_TEST } from "../src/al-runner-predefined-probe";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import { AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0 } from "../src/preprocessor-symbols";
import type { SpawnFn } from "../src/publisher";
import { ResultsStore } from "../src/store";
import { fakeProbeSpawn, maskFor, probeFailed } from "./helpers/al-runner-predefined";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

// R534, session level, through the REAL AlRunnerBackend (one-shot, static selector) and runSession.
// An al-runner row that is not a verdict about the mutant (an OnRun-trigger hang, an unexecuted UI
// handler, ...) used to be re-sent as `pre-dispatch-rejected`, error again, and ABORT THE WHOLE
// SESSION under spec §11 (measure.md D: Count and Ask, both transports). Harness from R518's.

const APP_JSON = JSON.stringify({
  id: "6d2e9f3b-4c5a-4b7e-8f9a-3b2c4d5e6f7a",
  name: "R534 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

const TARGET_AL = `codeunit 79000 "R534 Target"
{
    procedure Target()
    begin
        Helper();
    end;

    local procedure Helper()
    begin
    end;
}
`;

/** `Covers` covers both mutants. `Handler` (S3 only) answers the unexecuted-handler row always. */
function testsAl(withHandler: boolean): string {
  const handler = withHandler
    ? `
    [Test]
    procedure Handler()
    begin
    end;
`
    : "";
  return `codeunit 79100 "R534 Tests"
{
    Subtype = Test;

    [Test]
    procedure Covers()
    begin
    end;
${handler}}
`;
}

const COVERS = "Codeunit79100.Covers";
const HANDLER = "Codeunit79100.Handler";

/** One fake al-runner answer: exit code and the `--output-json` envelope. */
interface Answer {
  readonly exitCode: number;
  readonly envelope: unknown;
  readonly stdout?: string;
}

const pass = (name: string): Answer => ({
  exitCode: 0,
  envelope: { tests: [{ name, status: "pass", durationMs: 50 }], exitCode: 0 },
});

const row = (name: string, status: string, message: string): Answer => ({
  exitCode: 1,
  envelope: { tests: [{ name, status, durationMs: 71, message }], exitCode: 1 },
});

/** An exit 3 whose TEST-TIMEOUT-ABORT line names the row, measured shape (43f76177). */
const abortExit3 = (name: string, message: string): Answer => {
  const dot = name.lastIndexOf(".");
  return {
    exitCode: 3,
    envelope: {
      tests: [{ name, status: "error", durationMs: 20_001, message }],
      exitCode: 3,
      suiteErrors: [
        {
          file: "/tests",
          errors: [
            `tests: TEST-TIMEOUT-ABORT: R534 Tests (${name.slice(0, dot)}).${name.slice(dot + 1)}: watchdog timeout aborted the run — 0 further [Test] method(s) in this codeunit did not run (0 total)`,
          ],
        },
      ],
    },
  };
};

const HANDLER_UNUSED = "The following UI handlers were not executed: ConfirmYes";
const onRunTimeout = (sec: string) =>
  `The test codeunit's OnRun trigger exceeded the ${sec}s timeout, so none of its test methods ran.`;

/**
 * A fake one-shot al-runner. It tells mutated from unmutated by READING the active selector the
 * backend wrote (never by call order), and asks `answer` for that spawn's reply.
 */
function fakeAlRunner(
  activeDir: string,
  answer: (active: string, wanted: string, sec: string) => Answer,
) {
  const spawns: { active: string; test: string }[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    if (argv.includes("--version"))
      return { exitCode: 0, stdout: "al-runner v2.12.0.0", stderr: "" };
    const t = argv.indexOf("--test");
    const wanted = t >= 0 ? argv[t + 1] : undefined;
    if (wanted === undefined) return { exitCode: 0, stdout: "", stderr: "" }; // provisioning
    if (wanted === AL_RUNNER_PREDEFINED_PROBE_TEST) {
      return fakeProbeSpawn(
        probeFailed(maskFor(new Set(AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0))),
      ).spawn(argv);
    }
    let active = "";
    for (const f of await readdir(activeDir)) {
      const m = /exit\(MutantId = '([^']+)'\);/.exec(await readFile(join(activeDir, f), "utf8"));
      if (m?.[1] !== undefined) active = m[1];
    }
    spawns.push({ active, test: wanted });
    const sec = opts?.env?.AL_RUNNER_TEST_TIMEOUT_SEC;
    if (sec === undefined) throw new Error("fake al-runner: no AL_RUNNER_TEST_TIMEOUT_SEC");
    const a = answer(active, wanted, sec);
    return {
      exitCode: a.exitCode,
      stdout: a.stdout ?? alRunnerStdout(a.envelope),
      stderr: "stderr text",
    };
  };
  return { spawns, spawn };
}

async function session(
  answer: (active: string, wanted: string, sec: string) => Answer,
  withHandler = false,
) {
  const root = scratch("lethal-r534-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const backendDir = join(root, "backend");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(projectDir, "R534Target.Codeunit.al"), TARGET_AL);
  await Bun.write(join(testDir, "R534Tests.Codeunit.al"), testsAl(withHandler));
  const fake = fakeAlRunner(join(backendDir, "active"), answer);
  const backend = new AlRunnerBackend(
    {
      alRunnerPath: "al-runner",
      instrumentedDir: backendDir,
      testDir,
      selectorObjectId: 50000,
    },
    fake.spawn,
  );
  const events: RunEvent[] = [];
  try {
    const report = await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      projectDir,
      testDir,
      instrumentedDir: join(root, "instr"),
      selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
      mutantTimeoutMs: 20_000,
      emit: [(e) => events.push(e)],
    });
    return { report, spawns: fake.spawns, events };
  } finally {
    await backend.close();
  }
}

const SPEC_11 = /backend transport error: two consecutive run\(\) failures .* spec §11/;

describe("R534: an al-runner row that is an answer never aborts the session", () => {
  test("S1 (a) REPRO: an OnRun-trigger hang (exit 3) is timeout-killed at position 1 after ONE unmutated confirm", async () => {
    const { report, spawns } = await session((active, wanted, sec) =>
      active === "" ? pass(wanted) : abortExit3(wanted, onRunTimeout(sec)),
    );
    expect(report.mutants.map((m) => [m.mutantCode, m.verdict, m.killPosition])).toEqual([
      ["M0001", "timeout-killed", 1],
      ["M0002", "timeout-killed", 1],
    ]);
    // The baseline, then per mutant: ONE mutated spawn and exactly one unmutated confirm.
    expect(spawns.map((s) => s.active)).toEqual(["", "M0001", "", "M0002", ""]);
  });

  test("S1 (b) REPRO: an unexecuted UI handler is error runner-test-error from ONE spawn, and the next mutant is still scored", async () => {
    const { report, spawns } = await session((active, wanted) =>
      active === "M0001"
        ? row(wanted, "error", HANDLER_UNUSED)
        : active === "M0002"
          ? row(wanted, "fail", "Assert.AreEqual failed. Expected:<3> Actual:<2>")
          : pass(wanted),
    );
    expect(report.mutants.map((m) => [m.mutantCode, m.verdict, m.cause ?? null])).toEqual([
      ["M0001", "error", "runner-test-error"],
      ["M0002", "killed", null],
    ]);
    expect(report.mutants[0]?.failureNote).toContain(HANDLER_UNUSED);
    expect(spawns.map((s) => s.active)).toEqual(["", "M0001", "M0002", ""]);
  });

  test("S1 (c): a proven abort in an unknown wording warns ONCE per session, however many mutants hit it", async () => {
    const { report, events } = await session((active, wanted) =>
      active === "" ? pass(wanted) : abortExit3(wanted, "Watchdog stop."),
    );
    expect(report.mutants.map((m) => [m.verdict, m.cause])).toEqual([
      ["error", "runner-test-error"],
      ["error", "runner-test-error"],
    ]);
    const warned = events.flatMap((e) =>
      e.type === "warning" && e.code === "alrunner-timeout-wording-unrecognised" ? [e.message] : [],
    );
    expect(warned).toEqual([expect.stringContaining('"Watchdog stop."')]);
  });

  test("S3: an unexecuted handler at the BASELINE is sent once, left out of the green set, and the session completes", async () => {
    const { report, spawns } = await session(
      (active, wanted) =>
        wanted === HANDLER
          ? row(wanted, "error", HANDLER_UNUSED)
          : active === ""
            ? pass(wanted)
            : row(wanted, "fail", "Assert failed"),
      true,
    );
    expect(spawns.filter((s) => s.test === HANDLER).map((s) => s.active)).toEqual([""]);
    expect(report.mutants.map((m) => m.verdict)).toEqual(["killed", "killed"]);
    expect(spawns.filter((s) => s.active !== "").every((s) => s.test === COVERS)).toBe(true);
  });

  test("S4 (control): a real transport failure (exit 2, no envelope) twice still aborts under spec §11", async () => {
    await expect(
      session((active, wanted) =>
        active === "" ? pass(wanted) : { exitCode: 2, envelope: undefined, stdout: "" },
      ),
    ).rejects.toThrow(SPEC_11);
  });

  test("S5 (control): two rows for the requested name (R491) still abort under spec §11", async () => {
    await expect(
      session((active, wanted) =>
        active === ""
          ? pass(wanted)
          : {
              exitCode: 0,
              envelope: {
                tests: [
                  { name: wanted, status: "pass", durationMs: 5 },
                  { name: wanted, status: "pass", durationMs: 6 },
                ],
                exitCode: 0,
              },
            },
      ),
    ).rejects.toThrow(SPEC_11);
  });
});
