import { describe, expect, test } from "bun:test";
import { readdir, mkdtemp as realMkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  type AlRunnerCanaryFsOps,
  type AlRunnerCanaryResult,
  alRunnerCanaryWarnings,
  runAlRunnerCanary,
} from "../src/al-runner-canary";
import type { SpawnFn } from "../src/publisher";

/**
 * Scripts a fake al-runner process keyed by the `--test <method>` argument (v2 dialect —
 * v1's `--run <method>` is gone, see al-runner issue #1648), mirroring
 * al-runner-transport.test.ts's/al-runner-backend.test.ts's `recording`/`okSpawn` fakes rather
 * than reinventing the shape. `exitCode`-only entries stand in for al-runner's own
 * error(2)/error(3) exits; `status` entries stand in for a normal test-run response.
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
    const runIdx = argv.indexOf("--test");
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
    // v2 dialect: positional [sourceDir, testDir] precede --test <method> (v1's
    // --run <method> <sourceDir> <testDir> shape is gone, see al-runner issue #1648).
    for (const argv of calls) {
      const sourceDir = argv[0];
      const testDir = argv[1];
      expect(sourceDir).toBeDefined();
      expect(testDir).toBeDefined();
      expect(sourceDir).not.toBe(testDir);
    }
  });

  test("runs both probes against the SAME scratch project (both calls share sourceDir and testDir)", async () => {
    const { calls, spawn } = scriptedSpawn(BOTH_CONFIRMED);
    await runAlRunnerCanary("al-runner", spawn);
    const dirs = calls.map((argv) => [argv[0], argv[1]]);
    expect(dirs[0]).toEqual(dirs[1]);
  });

  test("cleans up its scratch directory after running, success or not", async () => {
    const before = new Set(await readdir(tmpdir()));
    await runAlRunnerCanary("al-runner", scriptedSpawn(BOTH_CONFIRMED).spawn);
    const after = await readdir(tmpdir());
    const leaked = after.filter((f) => f.startsWith("lethal-alrunner-canary-") && !before.has(f));
    expect(leaked).toEqual([]);
  });

  test('an unrecognized test status (neither exactly "pass" nor "fail") is inconclusive, not read as a confirmed defect either way', async () => {
    const spawn: SpawnFn = async (argv) => {
      const runIdx = argv.indexOf("--test");
      const method = argv[runIdx + 1];
      // A hypothetical future runner-internal status, distinct from both "pass" and "fail".
      return {
        exitCode: 0,
        stdout: JSON.stringify({ tests: [{ name: method, status: "error" }] }),
        stderr: "",
      };
    };
    const result = await runAlRunnerCanary("al-runner", spawn);
    expect(result.asserterror).toBe("inconclusive");
    expect(result.tableGlobalVar).toBe("inconclusive");
    expect(result.asserterrorDetail).toContain('unexpected status "error"');
  });
});

// ————————————————————————————————————————————————————————————————————————
// Important fix (review): the canary's own infrastructure failures (mkdtemp / cleanup rm) had no
// try/catch anywhere up to main() — an ENOSPC/EBUSY/EPERM there propagated all the way up
// uncaught, so main() printed a stack trace and exited 1 BEFORE A SINGLE MUTANT RAN, with no
// SessionReport at all. That is the hard-refuse-on-infra-hiccup outcome this module's own R7
// "loud-warn, not hard-refuse" decision explicitly argues against, arriving by omission. Fixed by
// wrapping the canary body in try/catch (demoting any throw to "inconclusive") and giving the
// cleanup `rm` the same maxRetries/retryDelay convention AlRunnerBackend.deploy() already uses
// for the structurally identical Windows EBUSY/EPERM hazard.
// ————————————————————————————————————————————————————————————————————————
describe("runAlRunnerCanary — infrastructure-failure safety", () => {
  test("an mkdtemp failure never throws — demotes BOTH probes to inconclusive with the real error as detail, and never spawns al-runner at all", async () => {
    let spawnCalled = false;
    const spawn: SpawnFn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: JSON.stringify({ tests: [] }), stderr: "" };
    };
    const fsOps: AlRunnerCanaryFsOps = {
      mkdtemp: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
      rm: async () => {},
    };
    const result = await runAlRunnerCanary("al-runner", spawn, fsOps);
    expect(result.asserterror).toBe("inconclusive");
    expect(result.tableGlobalVar).toBe("inconclusive");
    expect(result.asserterrorDetail).toContain("ENOSPC");
    expect(result.tableGlobalVarDetail).toContain("ENOSPC");
    expect(spawnCalled).toBe(false);
  });

  test("a cleanup (rm) failure is swallowed — the already-computed REAL result survives (not silently discarded), and a warning is printed instead of a thrown error", async () => {
    const { spawn } = scriptedSpawn(BOTH_CONFIRMED);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;
    const fsOps: AlRunnerCanaryFsOps = {
      mkdtemp: (prefix) => realMkdtemp(prefix),
      rm: async () => {
        throw new Error("EBUSY: resource busy or locked");
      },
    };
    let result: AlRunnerCanaryResult;
    try {
      result = await runAlRunnerCanary("al-runner", spawn, fsOps);
    } finally {
      console.warn = originalWarn;
    }
    // The real, correctly-computed verdicts — NOT "inconclusive" — must survive a cleanup
    // failure: a naive `finally { await rm(...) }` that rethrows would otherwise discard this
    // pending return value entirely (JS try/finally semantics), turning a harmless leaked temp
    // directory into a crashed session.
    expect(result.asserterror).toBe("defect-confirmed");
    expect(result.tableGlobalVar).toBe("defect-confirmed");
    expect(warnings.some((l) => l.includes("EBUSY"))).toBe(true);
  });

  test("cleanup uses AlRunnerBackend.deploy()'s established maxRetries/retryDelay convention for the same Windows EBUSY/EPERM hazard", async () => {
    const { spawn } = scriptedSpawn(BOTH_CONFIRMED);
    let rmOpts:
      | { recursive: boolean; force: boolean; maxRetries: number; retryDelay: number }
      | undefined;
    const fsOps: AlRunnerCanaryFsOps = {
      mkdtemp: (prefix) => realMkdtemp(prefix),
      rm: async (_path, opts) => {
        rmOpts = opts;
      },
    };
    await runAlRunnerCanary("al-runner", spawn, fsOps);
    expect(rmOpts).toEqual({ recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
