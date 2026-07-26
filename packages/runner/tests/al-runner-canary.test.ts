import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  type AlRunnerCanaryResult,
  alRunnerCanaryWarnings,
  runAlRunnerCanary,
} from "../src/al-runner-canary";
import type { SpawnFn } from "../src/publisher";

/**
 * Scripts a fake al-runner process keyed by the `--run <method>` argument, mirroring
 * al-runner-transport.test.ts's/al-runner-backend.test.ts's `recording`/`okSpawn` fakes rather
 * than reinventing the shape. `exitCode`-only entries stand in for al-runner's own
 * skip(2)/error(3) exits; `status` entries stand in for a normal test-run response.
 */
function scriptedSpawn(
  responses: Record<
    string,
    { readonly status: "pass" | "fail"; readonly message?: string } | { readonly exitCode: number }
  >,
) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    const runIdx = argv.indexOf("--run");
    const method = argv[runIdx + 1];
    const scripted = method !== undefined ? responses[method] : undefined;
    if (scripted === undefined) {
      throw new Error(`scriptedSpawn: no response configured for method "${String(method)}"`);
    }
    if ("exitCode" in scripted) {
      return { exitCode: scripted.exitCode, stdout: "", stderr: "boom" };
    }
    const t: Record<string, unknown> = { name: method, status: scripted.status };
    if (scripted.message !== undefined) t.message = scripted.message;
    return {
      exitCode: scripted.status === "pass" ? 0 : 1,
      stdout: JSON.stringify({ tests: [t] }),
      stderr: "",
    };
  };
  return { calls, spawn };
}

const BOTH_CONFIRMED = {
  AsserterrorNeverRaises: { status: "pass" as const },
  GlobalVarSurvivesValidate: { status: "fail" as const, message: "canary-mismatch TouchCount=0" },
};
const BOTH_FIXED = {
  AsserterrorNeverRaises: { status: "fail" as const, message: "asserterror expected an error" },
  GlobalVarSurvivesValidate: { status: "pass" as const },
};

describe("runAlRunnerCanary", () => {
  test("asserterror pass + table-global-var fail confirms BOTH defects (R7 + R8)", async () => {
    const { spawn } = scriptedSpawn(BOTH_CONFIRMED);
    const result = await runAlRunnerCanary("al-runner", spawn);
    expect(result.asserterror).toBe("defect-confirmed");
    expect(result.tableGlobalVar).toBe("defect-confirmed");
    expect(result.tableGlobalVarDetail).toBe("canary-mismatch TouchCount=0");
    expect(result.asserterrorDetail).toBeUndefined();
  });

  test("asserterror fail + table-global-var pass means NEITHER defect reproduces", async () => {
    const { spawn } = scriptedSpawn(BOTH_FIXED);
    const result = await runAlRunnerCanary("al-runner", spawn);
    expect(result.asserterror).toBe("defect-not-reproduced");
    expect(result.tableGlobalVar).toBe("defect-not-reproduced");
  });

  test("an al-runner error exit (3) makes that probe inconclusive without crashing the other", async () => {
    const { spawn } = scriptedSpawn({
      AsserterrorNeverRaises: { exitCode: 3 },
      GlobalVarSurvivesValidate: {
        status: "fail" as const,
        message: "canary-mismatch TouchCount=0",
      },
    });
    const result = await runAlRunnerCanary("al-runner", spawn);
    expect(result.asserterror).toBe("inconclusive");
    expect(result.asserterrorDetail).toContain("boom");
    expect(result.tableGlobalVar).toBe("defect-confirmed");
  });

  test("a skip exit (2) is inconclusive, not a defect verdict either way", async () => {
    const { spawn } = scriptedSpawn({
      AsserterrorNeverRaises: { exitCode: 2 },
      GlobalVarSurvivesValidate: { status: "pass" as const },
    });
    const result = await runAlRunnerCanary("al-runner", spawn);
    expect(result.asserterror).toBe("inconclusive");
  });

  test("a payload missing the requested test name is inconclusive, not silently treated as a pass or fail", async () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push([...argv]);
      // Always answers with an unrelated test name, whichever method was requested.
      return {
        exitCode: 0,
        stdout: JSON.stringify({ tests: [{ name: "SomeoneElse", status: "pass" }] }),
        stderr: "",
      };
    };
    const result = await runAlRunnerCanary("al-runner", spawn);
    expect(result.asserterror).toBe("inconclusive");
    expect(result.tableGlobalVar).toBe("inconclusive");
  });

  test("passes two DISTINCT directories as sourceDir/testDir — al-runner double-loads a directory passed as both, producing AL0197 duplicate-declaration errors (verified against the real binary)", async () => {
    const { calls, spawn } = scriptedSpawn(BOTH_CONFIRMED);
    await runAlRunnerCanary("al-runner", spawn);
    expect(calls.length).toBe(2);
    for (const argv of calls) {
      const runIdx = argv.indexOf("--run");
      const sourceDir = argv[runIdx + 2];
      const testDir = argv[runIdx + 3];
      expect(sourceDir).toBeDefined();
      expect(testDir).toBeDefined();
      expect(sourceDir).not.toBe(testDir);
    }
  });

  test("runs both probes against the SAME scratch project (both calls share sourceDir and testDir)", async () => {
    const { calls, spawn } = scriptedSpawn(BOTH_CONFIRMED);
    await runAlRunnerCanary("al-runner", spawn);
    const dirs = calls.map((argv) => {
      const runIdx = argv.indexOf("--run");
      return [argv[runIdx + 2], argv[runIdx + 3]];
    });
    expect(dirs[0]).toEqual(dirs[1]);
  });

  test("cleans up its scratch directory after running, success or not", async () => {
    const before = new Set(await readdir(tmpdir()));
    await runAlRunnerCanary("al-runner", scriptedSpawn(BOTH_CONFIRMED).spawn);
    const after = await readdir(tmpdir());
    const leaked = after.filter((f) => f.startsWith("lethal-alrunner-canary-") && !before.has(f));
    expect(leaked).toEqual([]);
  });
});

describe("alRunnerCanaryWarnings", () => {
  function result(overrides: Partial<AlRunnerCanaryResult>): AlRunnerCanaryResult {
    return {
      asserterror: "defect-not-reproduced",
      tableGlobalVar: "defect-not-reproduced",
      ...overrides,
    };
  }

  test("always emits exactly one line per probe", () => {
    expect(alRunnerCanaryWarnings(result({}))).toHaveLength(2);
  });

  test("asserterror defect-confirmed names R7 and tells the operator to distrust survivors", () => {
    const lines = alRunnerCanaryWarnings(result({ asserterror: "defect-confirmed" }));
    const line = lines.find((l) => l.includes("R7"));
    expect(line).toBeDefined();
    expect(line).toContain("CONFIRMED");
    expect(line).toContain("bcdev");
  });

  test("asserterror defect-not-reproduced says so explicitly rather than staying silent", () => {
    const lines = alRunnerCanaryWarnings(result({ asserterror: "defect-not-reproduced" }));
    const line = lines.find((l) => l.includes("R7"));
    expect(line).toBeDefined();
    expect(line).toContain("did NOT reproduce");
  });

  test("asserterror inconclusive surfaces the detail and still recommends caution", () => {
    const lines = alRunnerCanaryWarnings(
      result({ asserterror: "inconclusive", asserterrorDetail: "spawn ENOENT" }),
    );
    const line = lines.find((l) => l.includes("R7"));
    expect(line).toBeDefined();
    expect(line).toContain("spawn ENOENT");
    expect(line).toContain("could not determine");
  });

  test("tableGlobalVar defect-confirmed names R8 and the table-global-state risk", () => {
    const lines = alRunnerCanaryWarnings(result({ tableGlobalVar: "defect-confirmed" }));
    const line = lines.find((l) => l.includes("R8"));
    expect(line).toBeDefined();
    expect(line).toContain("CONFIRMED");
    expect(line).toContain("global");
  });

  test("tableGlobalVar defect-not-reproduced says so explicitly", () => {
    const lines = alRunnerCanaryWarnings(result({ tableGlobalVar: "defect-not-reproduced" }));
    const line = lines.find((l) => l.includes("R8"));
    expect(line).toBeDefined();
    expect(line).toContain("did NOT");
  });

  test("tableGlobalVar inconclusive surfaces its own detail independently of asserterror's", () => {
    const lines = alRunnerCanaryWarnings(
      result({ tableGlobalVar: "inconclusive", tableGlobalVarDetail: "deadline" }),
    );
    const line = lines.find((l) => l.includes("R8"));
    expect(line).toBeDefined();
    expect(line).toContain("deadline");
  });
});
