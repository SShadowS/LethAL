// R586 T14 (plan r2 §10): `runMayLend`, remove-only, fixed order, and step 1 at the store sites.
import { describe, expect, test } from "bun:test";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { freezeStageTo } from "../src/campaign-freeze";
import { CARRYABLE_VERDICTS } from "../src/resume";
import { type MutantVerdict, ResultsStore, backendBuildRefusal, runMayLend } from "../src/store";

const B1 = `alrunner 3.0.0-alpha.2 (91253f2d6) ${"b".repeat(64)}`;
const B2 = `alrunner 3.0.0-alpha.3 (c893e3633) ${"c".repeat(64)}`;
const run = (backend: string, runnerBuild: string | null, alRunnerNames = true) => ({
  id: 7,
  backend,
  runnerBuild,
  alRunnerNames,
});
const ctx = { baselineErrorMethods: () => [] };

describe("T14: runMayLend", () => {
  test("v3 never lends to v2 or bcdev, and v2 / bcdev never lend to v3", () => {
    expect(runMayLend(run("al-runner-v3", B1), { backend: "al-runner", runnerBuild: undefined }, ctx)?.step).toBe("backend-build");
    expect(runMayLend(run("al-runner-v3", B1), { backend: "bcdev", runnerBuild: undefined }, ctx)?.step).toBe("backend-build");
    expect(runMayLend(run("al-runner", null), { backend: "al-runner-v3", runnerBuild: B1 }, ctx)?.step).toBe("backend-build");
    expect(runMayLend(run("bcdev", null), { backend: "al-runner-v3", runnerBuild: B1 }, ctx)?.step).toBe("backend-build");
  });
  test("v3 lends to the same build only; another build or an unrecorded one refuses", () => {
    expect(runMayLend(run("al-runner-v3", B1), { backend: "al-runner-v3", runnerBuild: B1 }, ctx)).toBeUndefined();
    expect(runMayLend(run("al-runner-v3", B2), { backend: "al-runner-v3", runnerBuild: B1 }, ctx)?.step).toBe("backend-build");
    expect(runMayLend(run("al-runner-v3", null), { backend: "al-runner-v3", runnerBuild: B1 }, ctx)?.step).toBe("backend-build");
  });
  test("v2 <-> bcdev are unchanged by step 1 (R592 is filed separately)", () => {
    expect(backendBuildRefusal(run("bcdev", null), { backend: "al-runner", runnerBuild: undefined })).toBeUndefined();
    expect(backendBuildRefusal(run("al-runner", null), { backend: "bcdev", runnerBuild: undefined })).toBeUndefined();
    expect(runMayLend(run("al-runner", null), { backend: "al-runner", runnerBuild: undefined }, ctx)).toBeUndefined();
  });
  test("no session named: a v3 run lends nothing, any other run is unchanged", () => {
    expect(backendBuildRefusal(run("al-runner-v3", B1), undefined)).toBeDefined();
    expect(backendBuildRefusal(run("al-runner", null), undefined)).toBeUndefined();
  });
  test("order: step 1 names the reason before R557's mark, and the mark before the renamed tests", () => {
    const unmarkedV3 = run("al-runner-v3", B2, false);
    expect(runMayLend(unmarkedV3, { backend: "al-runner-v3", runnerBuild: B1 }, ctx)?.step).toBe("backend-build");
    const unmarkedV2 = run("al-runner", null, false);
    const renamed = { baselineErrorMethods: () => ["X"], renamed: () => ["X"] };
    expect(runMayLend(unmarkedV2, { backend: "al-runner", runnerBuild: undefined }, renamed)?.step).toBe("al-runner-unmarked");
    expect(runMayLend(run("al-runner", null), { backend: "al-runner", runnerBuild: undefined }, renamed)).toEqual({
      step: "al-runner-renamed",
      tests: ["X"],
    });
  });
});

function mutantRow(verdict: MutantVerdict) {
  return {
    mutantCode: "M0001",
    astHash: "abc123",
    codeunitName: "Sample",
    procedureName: "Post",
    operatorName: "conditional-boundary",
    operatorMajor: 1,
    file: "Sample.Codeunit.al",
    line: 12,
    verdict,
    durationMs: 40,
    batchIndex: 0,
  };
}

/** A finished run whose one survivor every other check would lend. */
function finishedRun(store: ResultsStore, backend: string, runnerBuild?: string): number {
  const id = store.createRun({
    projectPath: "P",
    backend,
    appVersion: "1.0.0.0",
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: [],
    coverageMode: "al-runner",
    testAppHash: "T",
    testAppProven: true,
    testAppDeps: "D",
    carryHidden: { tuples: [], files: [] },
    twinTuples: [],
    ...(backend === "al-runner" ? { alRunnerNames: true } : {}),
    ...(runnerBuild !== undefined ? { runnerBuild } : {}),
  });
  store.recordMutant(id, mutantRow("survived"));
  store.finishRun(id, { batchCount: 1, baselineGreen: true });
  return id;
}

describe("T14 at the store sites", () => {
  const ask = (store: ResultsStore, backend: string, runnerBuild: string | undefined) => {
    const refused: string[] = [];
    const prior = store.priorSurvivorKeys("P", "al-runner", { hash: "T", deps: "D" }, [], [], {
      session: { backend, runnerBuild },
      backendBuildRefused: (i) => refused.push(i.why),
    });
    return { keys: prior.keys.size, refused };
  };

  test("history: a v3 survivor is not lent to a v2 session (the #5603 false survivor case), and is lent to its own build", () => {
    const store = new ResultsStore(":memory:");
    finishedRun(store, "al-runner-v3", B1);
    expect(ask(store, "al-runner", undefined)).toMatchObject({ keys: 0, refused: [expect.stringMatching(/al-runner-v3/)] });
    expect(ask(store, "al-runner-v3", B2).keys).toBe(0);
    expect(ask(store, "al-runner-v3", B1)).toEqual({ keys: 1, refused: [] });
  });

  test("history: a v2 survivor is not lent to a v3 session, and still is to v2", () => {
    const store = new ResultsStore(":memory:");
    finishedRun(store, "al-runner");
    expect(ask(store, "al-runner-v3", B1).keys).toBe(0);
    expect(ask(store, "al-runner", undefined)).toEqual({ keys: 1, refused: [] });
  });

  test("the run row records the v3 build, and NULL for any other backend", () => {
    const store = new ResultsStore(":memory:");
    const v3 = finishedRun(store, "al-runner-v3", B1);
    const v2 = finishedRun(store, "al-runner");
    expect(store.getRun(v3)?.runnerBuild).toBe(B1);
    expect(store.getRun(v2)?.runnerBuild).toBeNull();
  });

  test("resume: a v3 session finds only an unfinished run of its own build", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      projectPath: "P",
      backend: "al-runner-v3",
      appVersion: "1.0.0.0",
      configFingerprint: "F",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      coverageMode: "al-runner",
      runnerBuild: B2,
    });
    store.recordMutant(id, mutantRow("killed"));
    const q = { projectPath: "P", backend: "al-runner-v3", configFingerprint: "F", carryableVerdicts: [...CARRYABLE_VERDICTS] };
    expect(store.findResumableRun({ ...q, runnerBuild: B1 })).toBeNull();
    expect(store.findResumableRun({ ...q, runnerBuild: B2 })).toBe(id);
    expect(() => store.findResumableRun(q)).toThrow(/must name its runner build/);
  });
});

describe("campaign freeze is refused for v3 by name", () => {
  test("a v3 report is refused before any I/O; other backends reach the next check", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "lethal-r586-freeze-"));
    try {
      const path = join(dir, "r.json");
      await writeFile(path, JSON.stringify({ backend: "al-runner-v3", coverageMode: "al-runner" }));
      await expect(freezeStageTo(path, "s", 0, dir)).rejects.toThrow(/al-runner-v3-campaign-freeze-refused/);
      await writeFile(path, JSON.stringify({ backend: "al-runner", coverageMode: "al-runner" }));
      await expect(freezeStageTo(path, "s", 0, dir)).rejects.not.toThrow(/al-runner-v3-campaign-freeze-refused/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
