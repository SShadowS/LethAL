// R618 plan r2: the history site's lend order, offline. `itest:lend` cannot reach these on bcdev:
// N1o (a run that is wrong in THREE fields) is cut from the live gate and pinned here instead, at
// `priorSurvivorKeys` (since R619 it decides through `ResultsStore.runMayLend`, with its own checks
// in the `siteChecks` slot). R654 retired the .NET al-runner: its R557 mark cases became one rule,
// a stored v2 run lends nothing, by name, at step 1.
import { describe, expect, test } from "bun:test";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { PENDING_SUFFIX, REVOKED_SUFFIX } from "../src/closed-world";
import { ResultsStore } from "../src/store";

const H = "package:aa|closed-world:public";
const D = "deps:1";
const BCDEV = { backend: "bcdev", runnerBuild: undefined } as const;
const V3 = { backend: "al-runner-v3", runnerBuild: "r618-seed" } as const;
/** R585: the seed's test scope, and the history session's (a subset of it). */
const SCOPE = ["79100::A", "79100::B"];
const SESSION_TESTS = ["79100::A"];

/** A finished run with one survivor that every check lends, unless `over` changes a field. */
function seed(
  store: ResultsStore,
  over: {
    backend?: string;
    runnerBuild?: string;
    coverageMode?: "fenced" | "al-runner";
    testAppHash?: string;
    /** R585: `null` writes NULL (a pre-R585 run). */
    testScope?: readonly string[] | null;
    buildSymbols?: readonly string[];
  } = {},
): number {
  const id = store.createRun({
    testScope: over.testScope === undefined ? SCOPE : over.testScope,
    projectPath: "P",
    backend: over.backend ?? "bcdev",
    appVersion: "1.0.0.0",
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: over.buildSymbols ?? [],
    coverageMode: over.coverageMode ?? "fenced",
    testAppHash: over.testAppHash ?? H,
    testAppProven: true,
    testAppDeps: D,
    carryHidden: { tuples: [], files: [] },
    twinTuples: [],
    ...(over.runnerBuild !== undefined ? { runnerBuild: over.runnerBuild } : {}),
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

/** Every refusal callback, recording which fired; a session (bcdev unless named) with the seed's
 *  own identity. */
function ask(store: ResultsStore, session: typeof BCDEV | typeof V3 = BCDEV) {
  const fired: string[] = [];
  const hit = (name: string) => () => fired.push(name);
  const keys = store.priorSurvivorKeys("P", "fenced", { hash: H, deps: D }, [], [], SESSION_TESTS, {
    session,
    testScopeChanged: hit("testScopeChanged"),
    backendBuildRefused: hit("backendBuildRefused"),
    schemeChanged: hit("schemeChanged"),
    coverageModeChanged: hit("coverageModeChanged"),
    testAppChanged: hit("testAppChanged"),
    symbolsChanged: hit("symbolsChanged"),
    carryUntrusted: hit("carryUntrusted"),
    hiddenFilesChanged: hit("hiddenFilesChanged"),
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

describe("R585: the test-scope check, LAST of all, after runMayLend lends (review I1)", () => {
  const one = (over: Parameters<typeof seed>[1]) => {
    const store = new ResultsStore(":memory:");
    seed(store, over);
    const got = ask(store);
    store.close();
    return got;
  };
  test("a NULL scope on a run that passes every other check lends nothing, by name", () => {
    expect(one({ testScope: null })).toEqual({ keys: 0, fired: ["testScopeChanged"] });
  });
  test("a scope missing a test this session sends lends nothing; an equal one lends", () => {
    expect(one({ testScope: ["79100::B"] })).toEqual({ keys: 0, fired: ["testScopeChanged"] });
    expect(one({ testScope: SESSION_TESTS })).toEqual({ keys: 1, fired: [] });
  });
  test("order: a NULL-scope run that also has other symbols is named history-symbols-changed", () => {
    expect(one({ testScope: null, buildSymbols: ["OTHER"] })).toEqual({
      keys: 0,
      fired: ["symbolsChanged"],
    });
  });
  test("order (R654): a NULL-scope retired al-runner run is named by step 1, not by its scope", () => {
    expect(one({ testScope: null, backend: "al-runner" })).toEqual({
      keys: 0,
      fired: ["backendBuildRefused"],
    });
  });
  test("order: a NULL-scope run under another test app is named by the test app", () => {
    expect(one({ testScope: null, testAppHash: `${H}${REVOKED_SUFFIX}` })).toEqual({
      keys: 0,
      fired: ["testAppChanged"],
    });
  });
});

describe("R654: a run of another backend lends nothing to history", () => {
  test("a retired al-runner run (every other field equal) lends nothing to bcdev or v3: step 1", () => {
    const store = new ResultsStore(":memory:");
    seed(store, { backend: "al-runner" });
    expect(ask(store)).toEqual({ keys: 0, fired: ["backendBuildRefused"] });
    expect(ask(store, V3)).toEqual({ keys: 0, fired: ["backendBuildRefused"] });
    store.close();
  });

  test("a bcdev run, a v3 session: step 1 refuses", () => {
    const store = new ResultsStore(":memory:");
    seed(store);
    expect(ask(store, V3)).toEqual({ keys: 0, fired: ["backendBuildRefused"] });
    store.close();
  });
});
