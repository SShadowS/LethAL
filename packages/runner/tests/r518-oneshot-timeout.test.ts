import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { AL_RUNNER_PREDEFINED_PROBE_TEST } from "../src/al-runner-predefined-probe";
import { runSession } from "../src/orchestrator";
import { AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0 } from "../src/preprocessor-symbols";
import type { SpawnFn } from "../src/publisher";
import { ResultsStore } from "../src/store";
import { fakeProbeSpawn, maskFor, probeFailed } from "./helpers/al-runner-predefined";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

// R518, session level, through the REAL AlRunnerBackend (one-shot, static selector) and runSession.
// al-runner 2.12.0-main.43f76177 exits 3 when a one-shot test hits its in-run stop. Before R518 the
// transport read that as a failed run: the mutant's test was re-sent (a second full hang), errored
// again, and spec §11's two-consecutive-failures rule ABORTED THE WHOLE SESSION.

const APP_JSON = JSON.stringify({
  id: "5c1d8e2a-3b4f-4a6d-9e7f-2a1b3c4d5e6f",
  name: "R518 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

const TARGET_AL = `codeunit 79000 "R518 Target"
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

const TESTS_AL = `codeunit 79100 "R518 Tests"
{
    Subtype = Test;

    [Test]
    procedure Covers()
    begin
    end;
}
`;

const WANTED = "Codeunit79100.Covers";

/**
 * A fake one-shot al-runner. It tells mutated from unmutated by READING the active selector the
 * backend wrote (never by call order). Unmutated: exit 0, `pass` with `durationMs` = `bodyMs`.
 * Mutated: exit 3 in the shape measured on 43f76177, its message built from the spawn's own
 * `AL_RUNNER_TEST_TIMEOUT_SEC`.
 */
function fakeAlRunner(activeDir: string, bodyMs: number) {
  const spawns: { active: string; argv: string[] }[] = [];
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
    spawns.push({ active, argv: [...argv] });
    if (active === "") {
      const tests = [{ name: wanted, status: "pass", durationMs: bodyMs }];
      return { exitCode: 0, stdout: alRunnerStdout({ tests, exitCode: 0 }), stderr: "" };
    }
    const sec = opts?.env?.AL_RUNNER_TEST_TIMEOUT_SEC;
    if (sec === undefined) throw new Error("fake al-runner: no AL_RUNNER_TEST_TIMEOUT_SEC");
    const method = wanted.slice(wanted.lastIndexOf(".") + 1);
    const envelope = {
      tests: [
        {
          name: wanted,
          status: "error",
          durationMs: Number(sec) * 1000 + 72,
          message: `Test exceeded ${sec}s timeout.`,
        },
      ],
      exitCode: 3,
      suiteErrors: [
        {
          file: "/tests",
          errors: [
            `tests: TEST-TIMEOUT-ABORT: R518 Tests (Codeunit79100).${method}: watchdog timeout aborted the run — 0 further [Test] method(s) in this codeunit did not run (0 total)`,
          ],
        },
      ],
    };
    return { exitCode: 3, stdout: alRunnerStdout(envelope), stderr: "stderr text" };
  };
  return { spawns, spawn };
}

async function session(bodyMs: number) {
  const root = scratch("lethal-r518-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const backendDir = join(root, "backend");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(projectDir, "R518Target.Codeunit.al"), TARGET_AL);
  await Bun.write(join(testDir, "R518Tests.Codeunit.al"), TESTS_AL);
  const fake = fakeAlRunner(join(backendDir, "active"), bodyMs);
  const backend = new AlRunnerBackend(
    {
      alRunnerPath: "al-runner",
      instrumentedDir: backendDir,
      testDir,
      selectorObjectId: 50000,
    },
    fake.spawn,
  );
  try {
    const report = await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      projectDir,
      testDir,
      instrumentedDir: join(root, "instr"),
      selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
      mutantTimeoutMs: 20_000,
    });
    return { report, spawns: fake.spawns };
  } finally {
    await backend.close();
  }
}

describe("R518: a one-shot hang on al-runner goes through the cold confirm, not a session abort", () => {
  // `Target` yields two mutants (the `Helper()` call and the block), and the fake hangs on both.
  test("(a) a genuine hang (unmutated body 50 ms) is timeout-killed at position 1 after ONE unmutated confirm", async () => {
    const { report, spawns } = await session(50);
    expect(report.mutants.map((m) => [m.mutantCode, m.verdict, m.killPosition])).toEqual([
      ["M0001", "timeout-killed", 1],
      ["M0002", "timeout-killed", 1],
    ]);
    // The baseline, then per mutant: ONE mutated spawn and exactly one unmutated confirm.
    expect(spawns.map((s) => s.active)).toEqual(["", "M0001", "", "M0002", ""]);
    expect(spawns.every((s) => s.argv[s.argv.indexOf("--test") + 1] === WANTED)).toBe(true);
  });

  test("(b) a test that takes 15 of its 20 s unmutated is timeout-unconfirmed, never a kill, and the session completes", async () => {
    const { report } = await session(15_000);
    expect(report.mutants.map((m) => [m.mutantCode, m.verdict, m.cause])).toEqual([
      ["M0001", "error", "timeout-unconfirmed"],
      ["M0002", "error", "timeout-unconfirmed"],
    ]);
  });
});
