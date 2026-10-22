// R618 plan r2 §2, I2: `seedRunFrom` changes only the field an override names, so a negative leg
// of `itest:lend` cannot pass because a seed was wrong in a second field. Offline, in CI.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { CARRYABLE_VERDICTS } from "../src/resume";
import { ResultsStore, backendBuildRefusal } from "../src/store";
import type { RunRow } from "../src/store";
import { parseGateBaseline } from "./baseline-guard";
import { LEND_FIGURES, LEND_MUTANTS, type LendCode } from "./gate-expected";
import { PENDING_SUFFIX, REVOKED_SUFFIX, rowKey, seedRunFrom, storedMutants } from "./lend-seed";

const H = `package:${"a".repeat(64)}|closed-world:public`;
const D = "deps:r618";
const FP = "fp:r618";
const CODES = Object.keys(LEND_MUTANTS) as LendCode[];
const keyOf = (c: LendCode): string => LEND_MUTANTS[c].key;
const keys = (cs: readonly string[]): Set<string> => new Set(cs.map((c) => keyOf(c as LendCode)));

/** A finished source run shaped like L0's: every identity field set, 19 rows, one snapshot. */
function source(): { store: ResultsStore; a: number } {
  const store = new ResultsStore(":memory:");
  const a = store.createRun({
    projectPath: "/fixtures/sandbox-app",
    backend: "bcdev",
    appVersion: "1.0.0.0",
    configFingerprint: FP,
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: ["CLEAN24"],
    coverageMode: "fenced",
    testAppHash: H,
    testAppProven: true,
    testAppDeps: D,
    carryHidden: { tuples: [], files: [] },
    generationSourceSha256: "gen",
    twinTuples: [],
    numberingDigest: "num",
    dependencySourceSha256: "dep",
    // R601: copied, so a pending clone resumes on its source's server.
    resourceKey: "http://bc1|BC",
  });
  CODES.forEach((code, i) => {
    const m = LEND_MUTANTS[code];
    const [astHash = "", codeunitName = "", procedureName = "", operatorName = ""] =
      m.key.split("|");
    store.recordMutant(a, {
      mutantCode: code,
      astHash,
      codeunitName,
      procedureName,
      operatorName,
      operatorMajor: 1,
      file: "src/X.al",
      line: i + 1,
      verdict: m.verdict,
      ...(m.killingTest !== null ? { killingTest: m.killingTest, killPosition: 1 } : {}),
      durationMs: 10 + i,
      batchIndex: 0,
      coveringTests: m.verdict === "no-coverage" ? [] : ["Sandbox Tests.ClampPercentRuns"],
      coverageAttribution: "exact",
      unplaceable: false,
      carried: false,
    });
  });
  store.recordBaselineSnapshot({
    runId: a,
    batchIndex: 0,
    batchHash: "batch0",
    testAppHash: H,
    baseline: [],
  });
  store.finishRun(a, { batchCount: 1, baselineGreen: true });
  return { store, a };
}

/** `getRun`'s fields that differ between two runs, `id` and `finished` aside. */
function changed(x: RunRow | null, y: RunRow | null): string[] {
  if (x === null || y === null) throw new Error("no run");
  const skip = new Set(["id", "finished"]);
  return Object.keys(x)
    .filter((k) => !skip.has(k))
    .filter(
      (k) =>
        JSON.stringify((x as unknown as Record<string, unknown>)[k]) !==
        JSON.stringify((y as unknown as Record<string, unknown>)[k]),
    );
}

const survivorKeys = (store: ResultsStore) => {
  const fired: string[] = [];
  const hit = (n: string) => () => fired.push(n);
  const k = store.priorSurvivorKeys(
    "/fixtures/sandbox-app",
    "fenced",
    { hash: H, deps: D },
    ["CLEAN24"],
    [],
    {
      session: { backend: "bcdev", runnerBuild: undefined },
      backendBuildRefused: hit("backendBuildRefused"),
      schemeChanged: hit("schemeChanged"),
      coverageModeChanged: hit("coverageModeChanged"),
      testAppChanged: hit("testAppChanged"),
      symbolsChanged: hit("symbolsChanged"),
      carryUntrusted: hit("carryUntrusted"),
      hiddenFilesChanged: hit("hiddenFilesChanged"),
      alRunnerUnmarked: hit("alRunnerUnmarked"),
    },
  ).keys;
  return { keys: k, fired };
};

const resumable = (store: ResultsStore) =>
  store.findResumableRun({
    projectPath: "/fixtures/sandbox-app",
    backend: "bcdev",
    configFingerprint: FP,
    carryableVerdicts: [...CARRYABLE_VERDICTS],
  });

describe("R618 seedRunFrom: a clone with no override is the source run", () => {
  test("the run row, the verdicts, history and resume read it as the source", () => {
    const { store, a } = source();
    const before = survivorKeys(store);
    expect(before.keys.size).toBe(12);
    const c = seedRunFrom(store, a, { finished: true });
    expect(changed(store.getRun(a), store.getRun(c))).toEqual([]);
    const sorted = (id: number) =>
      store
        .mutantVerdicts(id)
        .map((v) => JSON.stringify(v))
        .sort();
    expect(sorted(c)).toEqual(sorted(a));
    expect(survivorKeys(store)).toEqual(before);
    const u = seedRunFrom(store, a);
    expect(store.getRun(u)?.finished).toBe(false);
    expect(resumable(store)).toBe(u);
    store.close();
  });

  test("the source's 12 survivors are exactly LEND_MUTANTS' survived keys", () => {
    const { store } = source();
    const survived = CODES.filter((c) => LEND_MUTANTS[c].verdict === "survived");
    expect(survivorKeys(store).keys).toEqual(keys(survived));
    store.close();
  });
});

describe("R618 seedRunFrom: each override changes only its own field", () => {
  const cases: Array<[string, Parameters<typeof seedRunFrom>[2], string[]]> = [
    [
      "backend + runnerBuild",
      { backend: "al-runner-v3", runnerBuild: "r618-seed" },
      ["backend", "runnerBuild"],
    ],
    ["coverageMode", { coverageMode: "al-runner" }, ["coverageMode"]],
    ["hashSuffix pending", { hashSuffix: PENDING_SUFFIX }, ["testAppHash"]],
    ["testAppHash", { testAppHash: `${H}+internal`, hashSuffix: PENDING_SUFFIX }, ["testAppHash"]],
    ["alRunnerNames", { alRunnerNames: true }, ["alRunnerNames"]],
    ["revoke", { revoke: true }, ["testAppHash"]],
    ["rows: false", { rows: false }, []],
  ];
  for (const [name, over, fields] of cases) {
    test(name, () => {
      const { store, a } = source();
      const c = seedRunFrom(store, a, over);
      expect(changed(store.getRun(a), store.getRun(c))).toEqual(fields);
      store.close();
    });
  }

  test("pending and revoked append exactly their suffix", () => {
    const { store, a } = source();
    expect(store.getRun(seedRunFrom(store, a, { hashSuffix: PENDING_SUFFIX }))?.testAppHash).toBe(
      `${H}|pending`,
    );
    expect(store.getRun(seedRunFrom(store, a, { revoke: true }))?.testAppHash).toBe(
      `${H}|closed-world:revoked`,
    );
    expect(REVOKED_SUFFIX).toBe("|closed-world:revoked");
    // R601: RN1d's seed, the tag swapped and still pending.
    expect(
      store.getRun(
        seedRunFrom(store, a, { testAppHash: `${H}+internal`, hashSuffix: PENDING_SUFFIX }),
      )?.testAppHash,
    ).toBe(`${H}+internal|pending`);
    // R601: the clone runs on its source's server.
    expect(store.getRun(seedRunFrom(store, a))?.resourceKey).toBe("http://bc1|BC");
    store.close();
  });
});

describe("R618 seedRunFrom: K is permuted by code, keyed intact, with a sentinel (I2, Q3)", () => {
  test("K: KEPT plus M0003 as error; codes and lines rotate, keys and verdicts do not", () => {
    const { store, a } = source();
    const kept = keys(LEND_FIGURES.kept);
    const err = keys(LEND_FIGURES.keptAsError);
    const sentinel = keyOf(LEND_FIGURES.sentinel.code);
    const k = seedRunFrom(store, a, {
      keepKeys: new Set([...kept, ...err]),
      errorKeys: err,
      permuteCodes: true,
      sentinel: { key: sentinel, durationMs: LEND_FIGURES.sentinel.durationMs },
    });
    const src = new Map(storedMutants(store, a).map((r) => [rowKey(r), r]));
    const rows = storedMutants(store, k);
    expect(new Set(rows.map(rowKey))).toEqual(new Set([...kept, ...err]));
    for (const r of rows) {
      const s = src.get(rowKey(r));
      if (s === undefined) throw new Error("unknown key");
      // Every row moved to another row's code and line (a code-keyed carry would mis-assign).
      expect(r.mutant_code).not.toBe(s.mutant_code);
      expect(r.line).not.toBe(s.line);
      expect(r.verdict).toBe(err.has(rowKey(r)) ? "error" : s.verdict);
      expect(r.duration_ms).toBe(rowKey(r) === sentinel ? 987654 : s.duration_ms);
    }
    expect([...rows.map((r) => r.mutant_code)].sort()).toEqual(
      [...rows.map((r) => src.get(rowKey(r))?.mutant_code ?? "")].sort(),
    );
    expect(resumable(store)).toBe(k);
    store.close();
  });

  test("a key asked for that the source lacks is refused", () => {
    const { store, a } = source();
    expect(() => seedRunFrom(store, a, { keepKeys: new Set(["nope"]) })).toThrow(/1 keys asked/);
    store.close();
  });
});

describe("R618: each seed gives the refusal its leg expects", () => {
  test("N0 lends, N1 names only the backend step, N5 names only the test app", () => {
    for (const [over, keysLent, fired] of [
      [{}, 12, []],
      [{ backend: "al-runner-v3", runnerBuild: "r618-seed" }, 0, ["backendBuildRefused"]],
      [{ revoke: true }, 0, ["testAppChanged"]],
    ] as const) {
      const { store, a } = source();
      seedRunFrom(store, a, { finished: true, ...over });
      const got = survivorKeys(store);
      expect({ keys: got.keys.size, fired: got.fired }).toEqual({
        keys: keysLent,
        fired: [...fired],
      });
      store.close();
    }
  });

  test("SP1 to SP4 lend no snapshot (the source's is found); SV3's is found and refused by step 1", () => {
    const { store, a } = source();
    seedRunFrom(store, a, { rows: false, hashSuffix: PENDING_SUFFIX, snapshot: "run" });
    seedRunFrom(store, a, { rows: false, hashSuffix: PENDING_SUFFIX, snapshot: "source" });
    seedRunFrom(store, a, { rows: false, snapshot: "source", revoke: true });
    seedRunFrom(store, a, { rows: false, hashSuffix: REVOKED_SUFFIX, snapshot: "source" });
    expect(store.findBaselineSnapshot("batch0", H, D, "fenced")?.runId).toBe(a);
    const sv3 = seedRunFrom(store, a, {
      rows: false,
      backend: "al-runner-v3",
      runnerBuild: "r618-seed",
      snapshot: "source",
    });
    expect(store.findBaselineSnapshot("batch0", H, D, "fenced")?.runId).toBe(sv3);
    const row = store.getRun(sv3);
    if (row === null) throw new Error("no SV3");
    expect(backendBuildRefusal(row, { backend: "bcdev", runnerBuild: undefined })).toBe(
      `run ${sv3} ran on al-runner-v3 and this session runs bcdev; a verdict is lent only within al-runner-v3 (R586)`,
    );
    // Seeds without rows are never resumable, so they cannot shadow K.
    expect(resumable(store)).toBeNull();
    store.close();
  });
});

describe("R618: LEND_MUTANTS is bcdev.baseline.json, by key", () => {
  test("every key, verdict and killer equal", () => {
    const path = join(import.meta.dir, "bcdev.baseline.json");
    const rows = parseGateBaseline(readFileSync(path, "utf8"), path, "R618").entries;
    const want = CODES.map((c) => ({
      key: LEND_MUTANTS[c].key,
      verdict: LEND_MUTANTS[c].verdict,
      killingTest: LEND_MUTANTS[c].killingTest,
    })).sort((x, y) => x.key.localeCompare(y.key));
    const got = rows
      .map((r) => ({ key: r.key, verdict: r.verdict, killingTest: r.killingTest }))
      .sort((x, y) => x.key.localeCompare(y.key));
    expect(got).toEqual(want);
    expect(rows).toHaveLength(LEND_FIGURES.totalMutantSites);
  });
});
