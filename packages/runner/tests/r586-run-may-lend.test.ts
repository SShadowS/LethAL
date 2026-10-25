// R586 T14 (plan r2 §10): `runMayLend`, remove-only, fixed order, and step 1 at the store sites.
// R619: on the method every lend site calls; `r619-one-lend.test.ts` pins the sites' calls.
import { describe, expect, test } from "bun:test";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { freezeStageTo } from "../src/campaign-freeze";
import { CARRYABLE_VERDICTS } from "../src/resume";
import { type MutantVerdict, ResultsStore, backendBuildRefusal } from "../src/store";

/** The decision reads no row: one empty store serves every bare case. */
const lender = new ResultsStore(":memory:");

const B1 = `alrunner 3.0.0-alpha.2 (91253f2d6) ${"b".repeat(64)}`;
const B2 = `alrunner 3.0.0-alpha.3 (c893e3633) ${"c".repeat(64)}`;
const run = (backend: string, runnerBuild: string | null) => ({ id: 7, backend, runnerBuild });
const ctx = { site: "history" } as const;
const BCDEV = { backend: "bcdev", runnerBuild: undefined } as const;
const V3_B1 = { backend: "al-runner-v3", runnerBuild: B1 } as const;
const RETIRED =
  "al-runner-v2-retired: run 7 ran on the retired .NET al-runner (R654); nothing of it is lent";

describe("T14: runMayLend", () => {
  test("v3 never lends to bcdev, and bcdev never lends to v3", () => {
    expect(lender.runMayLend(run("al-runner-v3", B1), BCDEV, ctx)?.step).toBe("backend-build");
    expect(lender.runMayLend(run("bcdev", null), V3_B1, ctx)?.step).toBe("backend-build");
  });
  test("v3 lends to the same build only; another build or an unrecorded one refuses", () => {
    expect(
      lender.runMayLend(run("al-runner-v3", B1), { backend: "al-runner-v3", runnerBuild: B1 }, ctx),
    ).toBeUndefined();
    expect(
      lender.runMayLend(run("al-runner-v3", B2), { backend: "al-runner-v3", runnerBuild: B1 }, ctx)
        ?.step,
    ).toBe("backend-build");
    expect(
      lender.runMayLend(
        run("al-runner-v3", null),
        { backend: "al-runner-v3", runnerBuild: B1 },
        ctx,
      )?.step,
    ).toBe("backend-build");
  });
  // R654 F3 (D-m3): R592's v2 <-> bcdev arm is gone with v2; a stored v2 run is refused by name,
  // for every session and for none, ahead of every other rule. bcdev still lends to bcdev.
  test("R654: a retired .NET al-runner run is refused by name; bcdev lends to bcdev", () => {
    expect(backendBuildRefusal(run("al-runner", null), BCDEV)).toBe(RETIRED);
    expect(backendBuildRefusal(run("al-runner", null), V3_B1)).toBe(RETIRED);
    expect(backendBuildRefusal(run("al-runner", null), undefined)).toBe(RETIRED);
    expect(lender.runMayLend(run("al-runner", null), BCDEV, ctx)).toEqual({
      step: "backend-build",
      why: RETIRED,
    });
    expect(backendBuildRefusal(run("bcdev", null), BCDEV)).toBeUndefined();
    expect(lender.runMayLend(run("bcdev", null), BCDEV, ctx)).toBeUndefined();
  });
  test("no session named: a v3 run lends nothing, a bcdev run is unchanged", () => {
    expect(backendBuildRefusal(run("al-runner-v3", B1), undefined)).toBeDefined();
    expect(backendBuildRefusal(run("bcdev", null), undefined)).toBeUndefined();
  });
  test("R619 order: the site's checks run after step 1, and decide when step 1 lends", () => {
    const calls: string[] = [];
    const refuse = { ...ctx, siteChecks: () => calls.push("site") > 0 };
    // Step 1 refuses first: the site checks never run.
    expect(lender.runMayLend(run("al-runner-v3", B1), BCDEV, refuse)?.step).toBe("backend-build");
    expect(lender.runMayLend(run("al-runner", null), BCDEV, refuse)?.step).toBe("backend-build");
    expect(calls).toEqual([]);
    // Step 1 lends: the site's refusal is named by the site.
    expect(lender.runMayLend(run("bcdev", null), BCDEV, refuse)).toEqual({ step: "site" });
    expect(calls).toEqual(["site"]);
    // The site lends: so does the run.
    const lendSite = { ...ctx, siteChecks: () => false };
    expect(lender.runMayLend(run("bcdev", null), BCDEV, lendSite)).toBeUndefined();
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
    testScope: [],
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
    ...(runnerBuild !== undefined ? { runnerBuild } : {}),
  });
  store.recordMutant(id, mutantRow("survived"));
  store.finishRun(id, { batchCount: 1, baselineGreen: true });
  return id;
}

describe("T14 at the store sites", () => {
  const ask = (store: ResultsStore, backend: string, runnerBuild: string | undefined) => {
    const refused: string[] = [];
    const prior = store.priorSurvivorKeys("P", "al-runner", { hash: "T", deps: "D" }, [], [], [], {
      session: { backend, runnerBuild },
      backendBuildRefused: (i) => refused.push(i.why),
    });
    return { keys: prior.keys.size, refused };
  };

  test("history: a v3 survivor is not lent to a bcdev session, and is lent to its own build", () => {
    const store = new ResultsStore(":memory:");
    finishedRun(store, "al-runner-v3", B1);
    expect(ask(store, "bcdev", undefined)).toMatchObject({
      keys: 0,
      refused: [expect.stringMatching(/al-runner-v3/)],
    });
    expect(ask(store, "al-runner-v3", B2).keys).toBe(0);
    expect(ask(store, "al-runner-v3", B1)).toEqual({ keys: 1, refused: [] });
  });

  test("history (R654): a stored v2 survivor is lent to no session, by name; a bcdev one is", () => {
    const store = new ResultsStore(":memory:");
    finishedRun(store, "al-runner");
    const why =
      "al-runner-v2-retired: run 1 ran on the retired .NET al-runner (R654); nothing of it is lent";
    expect(ask(store, "al-runner-v3", B1)).toEqual({ keys: 0, refused: [why] });
    expect(ask(store, "bcdev", undefined)).toEqual({ keys: 0, refused: [why] });
    const other = new ResultsStore(":memory:");
    finishedRun(other, "bcdev");
    expect(ask(other, "bcdev", undefined)).toEqual({ keys: 1, refused: [] });
  });

  test("the run row records the v3 build, and NULL for any other backend", () => {
    const store = new ResultsStore(":memory:");
    const v3 = finishedRun(store, "al-runner-v3", B1);
    const bc = finishedRun(store, "bcdev");
    expect(store.getRun(v3)?.runnerBuild).toBe(B1);
    expect(store.getRun(bc)?.runnerBuild).toBeNull();
  });

  test("resume: a v3 session finds only an unfinished run of its own build", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      testScope: [],
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
    const q = {
      projectPath: "P",
      backend: "al-runner-v3",
      configFingerprint: "F",
      carryableVerdicts: [...CARRYABLE_VERDICTS],
    };
    expect(store.findResumableRun({ ...q, runnerBuild: B1 })).toBeNull();
    expect(store.findResumableRun({ ...q, runnerBuild: B2 })).toBe(id);
    expect(() => store.findResumableRun(q)).toThrow(/must name its runner build/);
  });

  test("R786: an abandoned serve attempt (abandonRun) is never resumed; a finished or other run is untouched", () => {
    const store = new ResultsStore(":memory:");
    const make = () =>
      store.createRun({
        testScope: [],
        projectPath: "P",
        backend: "al-runner-v3",
        appVersion: "1.0.0.0",
        configFingerprint: "F",
        identityScheme: IDENTITY_SCHEME,
        buildSymbols: [],
        coverageMode: "al-runner",
        runnerBuild: B2,
      });
    const q = {
      projectPath: "P",
      backend: "al-runner-v3",
      configFingerprint: "F",
      carryableVerdicts: [...CARRYABLE_VERDICTS],
      runnerBuild: B2,
    };
    const older = make();
    store.recordMutant(older, mutantRow("killed"));
    const abandoned = make();
    store.recordMutant(abandoned, mutantRow("killed"));
    // Control: before the mark, the newer run is the one a resume finds.
    expect(store.findResumableRun(q)).toBe(abandoned);
    store.abandonRun(abandoned);
    store.abandonRun(abandoned); // idempotent: no second suffix
    expect(store.findResumableRun(q)).toBe(older);
    expect(store.getRun(abandoned)?.configFingerprint).toBe("F|abandoned");
    expect(store.getRun(abandoned)?.finished).toBe(false);
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
      await expect(freezeStageTo(path, "s", 0, dir)).rejects.toThrow(
        /al-runner-v3-campaign-freeze-refused/,
      );
      await writeFile(path, JSON.stringify({ backend: "bcdev", coverageMode: "procedure" }));
      await expect(freezeStageTo(path, "s", 0, dir)).rejects.not.toThrow(
        /al-runner-v3-campaign-freeze-refused/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
