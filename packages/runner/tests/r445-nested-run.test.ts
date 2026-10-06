import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { type RunCliConfig, runFromCli } from "../src/cli";
import { TestProjectNestedError } from "../src/verify";
import { removeRunScratchAfterAll } from "./helpers/scratch";

// The sibling run reaches `runSession`, so runFromCli has made its scratch folder (R358).
removeRunScratchAfterAll();

/**
 * R445: `lethal run` built a test project nested inside the target as target code (the build copies
 * every .al under the target), so its tests were mutated and published in the target app. R-260's
 * rule now refuses it by name, both ways round, before anything is read or built. A sibling test
 * project still runs. Campaign stages run through `runFromCli` too; `--dry-run` takes no --tests.
 */
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const APP = (name: string) =>
  JSON.stringify({
    id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1445",
    name,
    publisher: "LethAL",
    version: "1.0.0.0",
    idRanges: [{ from: 79000, to: 79199 }],
  });

/** A target `app` with one codeunit, and a test project at `tests` (relative to the root). */
async function layout(tests: "app/test" | "tests" | "." | "app"): Promise<RunCliConfig> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r445-"));
  roots.push(root);
  const app = join(root, "app");
  await mkdir(join(app, "src"), { recursive: true });
  await writeFile(join(app, "app.json"), APP("Target"));
  await writeFile(
    join(app, "src", "A.Codeunit.al"),
    "codeunit 79000 A\n{\n    procedure P(): Integer\n    begin\n        exit(1 + 1);\n    end;\n}\n",
  );
  const testDir = tests === "." ? root : join(root, tests);
  if (tests === "app/test" || tests === "tests") {
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "app.json"), APP("Tests"));
    await writeFile(
      join(testDir, "T.Codeunit.al"),
      "codeunit 79100 T\n{\n    Subtype = Test;\n\n    [Test]\n    procedure TestP()\n    begin\n    end;\n}\n",
    );
  }
  const configPath = join(root, "lethal.config.json");
  await writeFile(configPath, "{}");
  return {
    mode: "run",
    projectDir: app,
    testDir,
    backendKind: "al-runner",
    dbPath: ":memory:",
    configPath,
    skipKnownSurvivors: false,
    workers: 1,
    keepEnv: false,
    allowExpiringEnv: false,
  };
}

/** Deps that record whether anything was built or run, and stop at `runSession`. */
function spies() {
  const calls = { buildBackend: 0, runSession: 0 };
  const stop = new Error("reached runSession");
  return {
    calls,
    stop,
    deps: {
      validateSelectorIdsForProject: async () => {},
      buildBackend: async () => {
        calls.buildBackend++;
        return new AlRunnerBackend({
          alRunnerPath: "unused",
          instrumentedDir: "unused",
          testDir: "unused",
          selectorObjectId: 1,
        });
      },
      runSession: async () => {
        calls.runSession++;
        throw stop;
      },
    },
  };
}

describe("R445: lethal run refuses a test project nested in the target, by name, before any build", () => {
  test("a test project inside the target is refused, and nothing is built", async () => {
    const parsed = await layout("app/test");
    const s = spies();
    const run = runFromCli(parsed, s.deps);
    await expect(run).rejects.toBeInstanceOf(TestProjectNestedError);
    await expect(run).rejects.toThrow(
      /test-project-nested: the test project .* lies inside the target project/,
    );
    await expect(run).rejects.toThrow(
      /Move the test project out of the target folder .* then run lethal run again\. \(R445\)/,
    );
    expect(s.calls).toEqual({ buildBackend: 0, runSession: 0 });
  });

  test("a test project that IS the target folder is refused", async () => {
    const parsed = await layout("app");
    const s = spies();
    await expect(runFromCli(parsed, s.deps)).rejects.toThrow(
      /test-project-nested: the test project .* is the target project/,
    );
    expect(s.calls).toEqual({ buildBackend: 0, runSession: 0 });
  });

  test("a test project that CONTAINS the target is refused", async () => {
    const parsed = await layout(".");
    const s = spies();
    await expect(runFromCli(parsed, s.deps)).rejects.toThrow(
      /test-project-nested: the test project .* contains the target project/,
    );
    expect(s.calls).toEqual({ buildBackend: 0, runSession: 0 });
  });

  test("control: a sibling test project runs (reaches runSession)", async () => {
    const parsed = await layout("tests");
    const s = spies();
    await expect(runFromCli(parsed, s.deps)).rejects.toBe(s.stop);
    expect(s.calls.runSession).toBe(1);
  });
});
