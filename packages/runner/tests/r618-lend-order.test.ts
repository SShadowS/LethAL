// R618 plan r2: the history site's lend order, offline. `itest:lend` cannot reach these on bcdev:
// N1o (a run that is wrong in THREE fields) and the R557 mark (a v2 run lent to bcdev) are cut from
// the live gate and pinned here instead, at the inline copy `priorSurvivorKeys` holds (R-I3).
import { describe, expect, test } from "bun:test";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { PENDING_SUFFIX, REVOKED_SUFFIX } from "../src/closed-world";
import { ResultsStore } from "../src/store";

const H = "package:aa|closed-world:public";
const D = "deps:1";
const BCDEV = { backend: "bcdev", runnerBuild: undefined } as const;

/** A finished run with one survivor that every check lends, unless `over` changes a field. */
function seed(
  store: ResultsStore,
  over: {
    backend?: string;
    runnerBuild?: string;
    coverageMode?: "fenced" | "al-runner";
    testAppHash?: string;
    alRunnerNames?: boolean;
  } = {},
): number {
  const id = store.createRun({
    projectPath: "P",
    backend: over.backend ?? "bcdev",
    appVersion: "1.0.0.0",
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: [],
    coverageMode: over.coverageMode ?? "fenced",
    testAppHash: over.testAppHash ?? H,
    testAppProven: true,
    testAppDeps: D,
    carryHidden: { tuples: [], files: [] },
    twinTuples: [],
    ...(over.runnerBuild !== undefined ? { runnerBuild: over.runnerBuild } : {}),
    ...(over.alRunnerNames === true ? { alRunnerNames: true } : {}),
  });
  store.recordMutant(id, {
    mutantCode: "M0004",
    astHash: "b03d",
    codeunitName: "Sandbox Logic",
    procedureName: "ClampPercent",
    operatorName: "lethal.empty-block",
    operatorMajor: 1,
    file: "src/SandboxLogic.Codeunit.al",
    line: 11,
    verdict: "survived",
    durationMs: 40,
    batchIndex: 0,
  });
  store.finishRun(id, { batchCount: 1, baselineGreen: true });
  return id;
}

/** Every refusal callback, recording which fired; a bcdev session with the seed's own identity. */
function ask(store: ResultsStore) {
  const fired: string[] = [];
  const hit = (name: string) => () => fired.push(name);
  const keys = store.priorSurvivorKeys("P", "fenced", { hash: H, deps: D }, [], [], {
    session: BCDEV,
    backendBuildRefused: hit("backendBuildRefused"),
    schemeChanged: hit("schemeChanged"),
    coverageModeChanged: hit("coverageModeChanged"),
    testAppChanged: hit("testAppChanged"),
    symbolsChanged: hit("symbolsChanged"),
    carryUntrusted: hit("carryUntrusted"),
    hiddenFilesChanged: hit("hiddenFilesChanged"),
    alRunnerUnmarked: hit("alRunnerUnmarked"),
    alRunnerTestNames: { renamed: () => [], refused: hit("alRunnerTestNames") },
  }).keys.size;
  return { keys, fired };
}

describe("R618: priorSurvivorKeys refuses in its stated order (history site)", () => {
  test("control: the unchanged seed lends its survivor and fires nothing", () => {
    const store = new ResultsStore(":memory:");
    seed(store);
    expect(ask(store)).toEqual({ keys: 1, fired: [] });
    store.close();
  });

  test("N1o: a v3 run with al-runner coverage and a pending hash names ONLY the backend step", () => {
    const store = new ResultsStore(":memory:");
    seed(store, {
      backend: "al-runner-v3",
      runnerBuild: "r618-seed",
      coverageMode: "al-runner",
      testAppHash: `${H}${PENDING_SUFFIX}`,
    });
    // Each later field alone is refused by its own step, so a reordered site names another one.
    expect(ask(store)).toEqual({ keys: 0, fired: ["backendBuildRefused"] });
    store.close();
  });

  test("each of the three fields alone is refused by its own step (the order test is not vacuous)", () => {
    const one = (over: Parameters<typeof seed>[1]) => {
      const store = new ResultsStore(":memory:");
      seed(store, over);
      const got = ask(store);
      store.close();
      return got;
    };
    expect(one({ backend: "al-runner-v3", runnerBuild: "r618-seed" })).toEqual({
      keys: 0,
      fired: ["backendBuildRefused"],
    });
    expect(one({ coverageMode: "al-runner" })).toEqual({
      keys: 0,
      fired: ["coverageModeChanged"],
    });
    expect(one({ testAppHash: `${H}${PENDING_SUFFIX}` })).toEqual({
      keys: 0,
      fired: ["testAppChanged"],
    });
  });

  test("N5: a finished run whose identity was revoked (R389) lends nothing, at the test-app step", () => {
    const store = new ResultsStore(":memory:");
    seed(store, { testAppHash: `${H}${REVOKED_SUFFIX}` });
    expect(ask(store)).toEqual({ keys: 0, fired: ["testAppChanged"] });
    store.close();
  });
});

describe("R618 RC4a: the history site's R557 mark, in a bcdev session", () => {
  test("an unmarked al-runner run (fenced, every other field equal) lends nothing, by name", () => {
    const store = new ResultsStore(":memory:");
    seed(store, { backend: "al-runner" });
    expect(ask(store)).toEqual({ keys: 0, fired: ["alRunnerUnmarked"] });
    store.close();
  });

  test("control: the same run with the mark lends (R592's known gap, not pinned as correct)", () => {
    const store = new ResultsStore(":memory:");
    seed(store, { backend: "al-runner", alRunnerNames: true });
    expect(ask(store)).toEqual({ keys: 1, fired: [] });
    store.close();
  });
});
