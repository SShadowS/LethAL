import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutantManifestEntry } from "@lethal/schemata";
import { V3_NOT_RUN_SUFFIX } from "../src/al-runner-v3-backend";
import {
  RECHECK_UNEXERCISED,
  RECHECK_WARNING,
  V3_RECHECK_BUDGET_SECONDS_DEFAULT,
  validateAlRunnerV3Config,
} from "../src/al-runner-v3-config";
import type { TestOutcome } from "../src/backend";
import { type RunCliConfig, v3RecheckOf } from "../src/cli";
import type { RunEvent, RunEventInput } from "../src/events";
import type { SessionConfig } from "../src/orchestrator";
import { buildReport, withheldKillOf } from "../src/report";
import type { SessionReport } from "../src/report";
import type { FoldStatics } from "../src/report-fold";
import { buildResumeIndex } from "../src/resume";
import type { MutantVerdictRow, ResultsStore } from "../src/store";
import {
  type NestedRecheckResult,
  type NestedRow,
  type RecheckIdentity,
  type RecheckRequest,
  type RecheckTarget,
  decideRecheck,
  ruleCKillerPassedAlone,
  ruleDSameBuild,
  ruleELosesNothing,
  runWithheldRecheck,
} from "../src/withheld-recheck";

/**
 * PR-144: the opt-in recheck of withheld-kill rows. Rules (a) to (e), the driver's ordering and skips, the
 * fold's replace-by-event, the report, and the resume exclusion. The nested session is a stateful fake.
 */

const AFTER_FAIL = `NotRun: out-of-scope: a test before this one in the codeunit did not pass (T2: failed with X) and left state; this failure is not trusted: Expected 1 got 2 ${V3_NOT_RUN_SUFFIX}`;

function manifest(id: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "x",
    mutatedText: "y",
    ...over,
  };
}

const MAIN: RecheckIdentity = {
  version: "alrunner 3.0.0 (abc)",
  binarySha256: "bin1",
  sourceSha256: "src1",
  dependencySourceSha256: "dep1",
};

function target(id: string, over: Partial<RecheckTarget> = {}): RecheckTarget {
  return {
    mutant: manifest(id),
    batchIndex: 0,
    verdict: "error",
    cause: "runner-refused",
    failureNote: AFTER_FAIL,
    coveringTests: ["T Codeunit.T1", "T Codeunit.T2"],
    ...over,
  };
}

function nestedRow(id: string, over: Partial<NestedRow> = {}): NestedRow {
  const m = manifest(id);
  return {
    file: m.file,
    startIndex: m.startIndex,
    endIndex: m.endIndex,
    operatorName: m.operatorName,
    mutatedText: m.mutatedText,
    verdict: "killed",
    killingTest: "T2",
    killReproduced: true,
    killingTestFailure: "Expected 1 got 2",
    coveringTests: ["T Codeunit.T1", "T Codeunit.T2"],
    durationMs: 5,
    ...over,
  };
}

const KILLER = "T Codeunit.T2";
const mainBase = (over: Record<string, boolean> = {}) =>
  new Map<string, boolean>(Object.entries({ "T Codeunit.T1": true, [KILLER]: true, ...over }));
const reBase = (over: Record<string, TestOutcome> = {}) =>
  new Map<string, TestOutcome>(
    Object.entries({ "T Codeunit.T1": "pass", [KILLER]: "pass", ...over }) as [
      string,
      TestOutcome,
    ][],
  );

function decide(
  over: {
    target?: RecheckTarget;
    row?: NestedRow | undefined;
    mainBaseline?: Map<string, boolean>;
    recheckBaseline?: Map<string, TestOutcome>;
    recheck?: RecheckIdentity;
  } = {},
) {
  return decideRecheck({
    target: over.target ?? target("M1"),
    row: "row" in over ? over.row : nestedRow("M1"),
    mainBaseline: over.mainBaseline ?? mainBase(),
    recheckBaseline: over.recheckBaseline ?? reBase(),
    main: MAIN,
    recheck: over.recheck ?? { ...MAIN },
  });
}

describe("decideRecheck: all of (a) to (e) recover; each failing alone keeps error", () => {
  test("every rule holds: recovered, with the isolatedRecheck facts", () => {
    const d = decide();
    expect(d.kind).toBe("recovered");
    if (d.kind !== "recovered") throw new Error("unreachable");
    expect(d.isolatedRecheck).toEqual({
      withheldFailure: "Expected 1 got 2",
      afterTest: "T2",
      killerGreenInMainBaseline: true,
    });
  });

  test("killer not green in the main baseline: recovered, and the field says so", () => {
    const d = decide({ mainBaseline: mainBase({ [KILLER]: false }) });
    expect(d.kind).toBe("recovered");
    if (d.kind !== "recovered") throw new Error("unreachable");
    expect(d.isolatedRecheck.killerGreenInMainBaseline).toBe(false);
  });

  test("(a) alone: the main row is not a withheld kill", () => {
    const d = decide({ target: target("M1", { failureNote: "NotRun: out-of-scope: refused" }) });
    expect(d).toMatchObject({ kind: "kept", failed: ["a"] });
  });

  test("(b) alone: a recheck survived is not taken over", () => {
    const d = decide({ row: nestedRow("M1", { verdict: "survived" }) });
    expect(d).toMatchObject({ kind: "kept", failed: ["b"] });
  });

  test("(b) alone: a kill that did not reproduce", () => {
    const d = decide({ row: nestedRow("M1", { killReproduced: false }) });
    expect(d).toMatchObject({ kind: "kept", failed: ["b"] });
  });

  test("(c) alone: the killer did not pass alone at the recheck baseline", () => {
    // Not green in the main baseline either, so (e) has nothing to compare: only (c) fails.
    const d = decide({
      mainBaseline: mainBase({ [KILLER]: false }),
      recheckBaseline: reBase({ [KILLER]: "fail" }),
    });
    expect(d).toMatchObject({ kind: "kept", failed: ["c"] });
  });

  test("(c) alone: a killer the recheck baseline never ran (a plan that broke)", () => {
    const base = reBase();
    base.delete(KILLER);
    const d = decide({ mainBaseline: mainBase({ [KILLER]: false }), recheckBaseline: base });
    expect(d).toMatchObject({ kind: "kept", failed: ["c"] });
  });

  test("(d) alone: another al-runner binary", () => {
    const d = decide({ recheck: { ...MAIN, binarySha256: "bin2" } });
    expect(d).toMatchObject({ kind: "kept", failed: ["d"] });
  });

  test("(d) alone: another source", () => {
    expect(decide({ recheck: { ...MAIN, sourceSha256: "src2" } })).toMatchObject({
      failed: ["d"],
    });
    expect(decide({ recheck: { ...MAIN, dependencySourceSha256: "dep2" } })).toMatchObject({
      failed: ["d"],
    });
  });

  test("(d): an unknown hash never matches, not even empty against empty", () => {
    expect(ruleDSameBuild({}, {})).toContain("not known");
    const { binarySha256: _dropped, ...noBinary } = MAIN;
    expect(ruleDSameBuild(MAIN, noBinary)).toContain("not known");
  });

  test("(e) alone: a test of the killer's codeunit that passed in the main baseline is lost", () => {
    const d = decide({ recheckBaseline: reBase({ "T Codeunit.T1": "fail" }) });
    expect(d).toMatchObject({ kind: "kept", failed: ["e"] });
    expect(d.kind === "kept" && d.note).toContain("T Codeunit.T1");
  });

  test("(e) alone: a refused test counts as lost", () => {
    expect(decide({ recheckBaseline: reBase({ "T Codeunit.T1": "error" }) })).toMatchObject({
      failed: ["e"],
    });
  });

  test("(e): a test of ANOTHER codeunit that is lost does not matter", () => {
    const d = decide({
      mainBaseline: mainBase({ "Other.O1": true }),
      recheckBaseline: reBase({ "Other.O1": "fail" }),
    });
    expect(d.kind).toBe("recovered");
  });

  test("(e): a main-baseline-passing test of the codeunit with NO recheck result is lost (fail closed)", () => {
    const d = decide({ mainBaseline: mainBase({ "T Codeunit.T9": true }) });
    expect(d).toMatchObject({ kind: "kept", failed: ["e"] });
    expect(d.kind === "kept" && d.note).toContain("T Codeunit.T9");
    // A test that did NOT pass in the main baseline and has no result is not judged.
    expect(decide({ mainBaseline: mainBase({ "T Codeunit.T9": false }) }).kind).toBe("recovered");
  });

  test("(e) codeunit-wide: T0 refused, T1 the covering killer, T3 not covering, passed in main, fails alone: error", () => {
    const main = new Map<string, boolean>([
      ["T Codeunit.T0", false], // refused at the main baseline
      ["T Codeunit.T1", true],
      ["T Codeunit.T3", true],
    ]);
    const row = nestedRow("M1", { killingTest: "T1", coveringTests: ["T Codeunit.T1"] });
    const re = (t3: TestOutcome) =>
      new Map<string, TestOutcome>([
        ["T Codeunit.T1", "pass"],
        ["T Codeunit.T3", t3],
      ]);
    const bad = decide({ row, mainBaseline: main, recheckBaseline: re("fail") });
    expect(bad).toMatchObject({ kind: "kept", failed: ["e"] });
    expect(bad.kind === "kept" && bad.note).toContain("T Codeunit.T3");
    expect(decide({ row, mainBaseline: main, recheckBaseline: re("pass") }).kind).toBe("recovered");
  });

  test("(e): no main baseline row for the codeunit fails closed (a reused baseline emits none)", () => {
    expect(ruleELosesNothing(new Map(), reBase(), KILLER)).toContain("no row for codeunit");
    expect(decide({ mainBaseline: new Map() })).toMatchObject({ kind: "kept", failed: ["e"] });
  });

  test("a killer shared by two covering codeunits cannot be named: (c) and (e) fail", () => {
    const row = nestedRow("M1", { coveringTests: ["A.T2", "B.T2"] });
    expect(decide({ row })).toMatchObject({ kind: "kept", failed: ["c", "e"] });
  });

  test("the kept note must not contain the phrase withheldKillOf searches for", () => {
    const d = decide({ row: nestedRow("M1", { verdict: "survived" }) });
    expect(d.kind === "kept" && d.note).not.toContain("this failure is not trusted: ");
  });

  test("ruleC with a killer qualified by codeunit: the method name alone is not enough", () => {
    expect(ruleCKillerPassedAlone(new Map([["B.T2", "pass"]]), "A.T2")).toContain(
      "not in the recheck",
    );
  });
});

/** The stateful fake nested session. */
function fakeRunner(result: (req: RecheckRequest) => NestedRecheckResult | Error) {
  const calls: RecheckRequest[] = [];
  const emittedAtCall: number[] = [];
  return {
    calls,
    emittedAtCall,
    run: async (req: RecheckRequest, emitted: () => number) => {
      calls.push(req);
      emittedAtCall.push(emitted());
      const r = result(req);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const seqOf = (es: readonly RunEventInput[]): RunEvent[] =>
  es.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);

function scored(id: string, over: Record<string, unknown> = {}): RunEventInput {
  return {
    type: "mutant-scored",
    mutant: manifest(id, {
      startIndex: Number(id.slice(1)) * 100,
      endIndex: Number(id.slice(1)) * 100 + 5,
    }),
    verdict: "error",
    batchIndex: 0,
    durationMs: 10,
    cause: "runner-refused",
    failureNote: AFTER_FAIL,
    coveringTests: ["T Codeunit.T1", "T Codeunit.T2"],
    ...over,
  } as RunEventInput;
}

const mainEvents = (extra: RunEventInput[]): RunEvent[] =>
  seqOf([
    {
      type: "baseline-batch-finished",
      batchIndex: 0,
      verdicts: [
        { name: "T Codeunit.T1", outcome: "pass", classification: [] },
        { name: "T Codeunit.T2", outcome: "pass", classification: [] },
      ],
    },
    ...extra,
  ]);

function nestedFor(ids: string[], over: Partial<NestedRecheckResult> = {}): NestedRecheckResult {
  return {
    rows: ids.map((id) =>
      nestedRow(id, {
        startIndex: Number(id.slice(1)) * 100,
        endIndex: Number(id.slice(1)) * 100 + 5,
      }),
    ),
    baseline: [
      { name: "T Codeunit.T1", outcome: "pass" },
      { name: "T Codeunit.T2", outcome: "pass" },
    ],
    baselineElapsedMs: 100,
    identity: { ...MAIN },
    ...over,
  };
}

async function drive(
  events: RunEvent[],
  fake: ReturnType<typeof fakeRunner>,
  backend: {
    methodIsolation?: boolean;
    serveEntries?: boolean;
    closeDaemons?: () => Promise<void>;
  } = { serveEntries: true },
) {
  const emitted: RunEventInput[] = [];
  const summary = await runWithheldRecheck({
    events,
    // PR-225: every covering test counts as a candidate here, so these driver tests keep their pre-PR-225 test set;
    // the narrowing itself is tested in pr225-recheck-set.test.ts.
    notPassOf: (t) => t.coveringTests,
    emit: (e) => emitted.push(e),
    main: MAIN,
    budgetSeconds: 77,
    runner: (req) => fake.run(req, () => emitted.length),
    backend,
  });
  return { emitted, summary };
}

describe("runWithheldRecheck: the driver", () => {
  test("sends only this session's withheld kills, once, with their covering tests and the budget", async () => {
    const fake = fakeRunner(() => nestedFor(["M1", "M2"]));
    const events = mainEvents([
      scored("M1"),
      scored("M2", { coveringTests: ["T Codeunit.T2", "Other.O1"] }),
      scored("M3", { verdict: "killed", cause: undefined, failureNote: undefined }),
      scored("M4", { failureNote: "NotRun: out-of-scope: refused" }), // an error, not a withheld kill
      scored("M5", { verdict: "survived", cause: undefined, failureNote: undefined }),
      {
        type: "mutant-carried",
        mutant: manifest("M6"),
        verdict: "error",
        fromRunId: 1,
        batchIndex: 0,
        priorDurationMs: 1,
        coveringTests: [],
        failureNote: AFTER_FAIL,
      } as RunEventInput,
    ]);
    const { summary } = await drive(events, fake);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.targets.map((t) => t.mutant.mutantId)).toEqual(["M1", "M2"]);
    expect(fake.calls[0]?.tests).toEqual(["Other.O1", "T Codeunit.T1", "T Codeunit.T2"]);
    expect(fake.calls[0]?.budgetSeconds).toBe(77);
    expect(summary).toEqual({ targets: 2, recovered: 2 });
  });

  test("ordering: the runner is called before anything is emitted; the baseline event precedes the rows", async () => {
    const fake = fakeRunner(() => nestedFor(["M1", "M2"]));
    const { emitted } = await drive(mainEvents([scored("M1"), scored("M2")]), fake);
    expect(fake.emittedAtCall).toEqual([0]);
    expect(emitted.map((e) => e.type)).toEqual([
      "recheck-baseline-finished",
      "mutant-rechecked",
      "mutant-rechecked",
    ]);
  });

  test("no withheld kill: the runner is never called and nothing is emitted", async () => {
    const fake = fakeRunner(() => nestedFor([]));
    const { emitted, summary } = await drive(
      mainEvents([scored("M3", { verdict: "killed", cause: undefined, failureNote: undefined })]),
      fake,
    );
    expect(fake.calls).toHaveLength(0);
    expect(emitted).toEqual([]);
    expect(summary).toEqual({ targets: 0, recovered: 0 });
  });

  test("isolation already method: skipped with a warning, nothing sent", async () => {
    const fake = fakeRunner(() => nestedFor(["M1"]));
    const { emitted, summary } = await drive(mainEvents([scored("M1")]), fake, {
      methodIsolation: true,
      serveEntries: true,
    });
    expect(fake.calls).toHaveLength(0);
    expect(emitted.map((e) => e.type)).toEqual(["warning"]);
    expect(summary.skipped).toContain("method");
  });

  test("one-shot transport: skipped with a warning, nothing sent", async () => {
    const fake = fakeRunner(() => nestedFor(["M1"]));
    const { emitted, summary } = await drive(mainEvents([scored("M1")]), fake, {
      serveEntries: false,
    });
    expect(fake.calls).toHaveLength(0);
    expect(emitted).toMatchObject([{ type: "warning", code: "withheld-recheck-skipped" }]);
    expect(summary.skipped).toContain("serve");
  });

  test("the budget ran out: unreached rows are absent and stay error, reached ones recover", async () => {
    const fake = fakeRunner(() => nestedFor(["M1"]));
    const { emitted, summary } = await drive(mainEvents([scored("M1"), scored("M2")]), fake);
    const rechecked = emitted.filter((e) => e.type === "mutant-rechecked");
    expect(rechecked).toHaveLength(2);
    expect(rechecked[0]).toMatchObject({ recovery: { killingTest: "T2" } });
    expect(rechecked[1]).toMatchObject({ keptNote: expect.stringContaining("rule (b)") });
    expect(summary).toEqual({ targets: 2, recovered: 1 });
  });

  test("a recheck survived keeps error", async () => {
    const fake = fakeRunner(() => ({
      ...nestedFor(["M1"]),
      rows: [nestedRow("M1", { verdict: "survived", startIndex: 100, endIndex: 105 })],
    }));
    const { emitted } = await drive(mainEvents([scored("M1")]), fake);
    expect(emitted.find((e) => e.type === "mutant-rechecked")).toMatchObject({
      keptNote: expect.stringContaining("survived"),
    });
  });

  test("(c) through the driver: a fake that breaks plan construction (the killer is not in the baseline)", async () => {
    const fake = fakeRunner(() =>
      nestedFor(["M1"], { baseline: [{ name: "T Codeunit.T1", outcome: "pass" }] }),
    );
    const { emitted } = await drive(mainEvents([scored("M1")]), fake);
    expect(emitted.find((e) => e.type === "mutant-rechecked")).toMatchObject({
      keptNote: expect.stringContaining("rule (c)"),
    });
  });

  test("(d) through the driver: the nested run used another binary", async () => {
    const fake = fakeRunner(() =>
      nestedFor(["M1"], { identity: { ...MAIN, binarySha256: "other" } }),
    );
    const { emitted } = await drive(mainEvents([scored("M1")]), fake);
    expect(emitted.find((e) => e.type === "mutant-rechecked")).toMatchObject({
      keptNote: expect.stringContaining("rule (d)"),
    });
  });

  test("two nested rows for one site: no row is guessed, the mutant stays error", async () => {
    const row = nestedRow("M1", { startIndex: 100, endIndex: 105 });
    const fake = fakeRunner(() => ({ ...nestedFor(["M1"]), rows: [row, row] }));
    const { emitted } = await drive(mainEvents([scored("M1")]), fake);
    expect(emitted.find((e) => e.type === "mutant-rechecked")).toMatchObject({
      keptNote: expect.stringContaining("rule (b)"),
    });
  });

  test("the recheck's test set: the covering tests plus every main-baseline test of a covering codeunit, nothing from other codeunits", async () => {
    const fake = fakeRunner(() => nestedFor(["M1"]));
    const events = seqOf([
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [
          { name: "T Codeunit.T1", outcome: "pass", classification: [] },
          { name: "T Codeunit.T2", outcome: "pass", classification: [] },
          { name: "T Codeunit.T3", outcome: "pass", classification: [] },
          { name: "T Codeunit.T0", outcome: "error", classification: [] },
          { name: "Zed.Z1", outcome: "pass", classification: [] },
        ],
      },
      scored("M1", { coveringTests: ["T Codeunit.T2", "T Codeunit.T2"] }),
    ]);
    await drive(events, fake);
    expect(fake.calls[0]?.tests).toEqual([
      "T Codeunit.T0",
      "T Codeunit.T1",
      "T Codeunit.T2",
      "T Codeunit.T3",
    ]);
  });

  test("closeDaemons is called once, before the runner", async () => {
    const order: string[] = [];
    const fake = fakeRunner(() => {
      order.push("runner");
      return nestedFor(["M1"]);
    });
    await drive(mainEvents([scored("M1")]), fake, {
      serveEntries: true,
      closeDaemons: async () => {
        order.push("closeDaemons");
      },
    });
    expect(order).toEqual(["closeDaemons", "runner"]);
  });

  test("a skipped recheck closes nothing", async () => {
    let closes = 0;
    const fake = fakeRunner(() => nestedFor(["M1"]));
    await drive(mainEvents([scored("M1")]), fake, {
      serveEntries: false,
      closeDaemons: async () => {
        closes += 1;
      },
    });
    expect(closes).toBe(0);
  });

  test("no baseline results at all: ONE skip warning with the reason and the row count, nothing sent", async () => {
    const fake = fakeRunner(() => nestedFor(["M1", "M2"]));
    const { emitted, summary } = await drive(seqOf([scored("M1"), scored("M2")]), fake);
    expect(fake.calls).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted).toMatchObject([{ type: "warning", code: "withheld-recheck-skipped" }]);
    const msg = emitted[0]?.type === "warning" ? emitted[0].message : "";
    expect(msg).toContain("no baseline results at all");
    expect(msg).toContain("2 withheld kill(s)");
    expect(summary.skipped).toContain("no baseline results at all");
  });

  test("the recheck baseline folds strictly: fail then pass across two batches is not passed", async () => {
    const fake = fakeRunner(() =>
      nestedFor(["M1"], {
        baseline: [
          { name: "T Codeunit.T1", outcome: "pass" },
          { name: "T Codeunit.T2", outcome: "fail" }, // the killer, first batch
          { name: "T Codeunit.T2", outcome: "pass" }, // second batch
        ],
      }),
    );
    // The killer was not green in the main baseline, so only rule (c) can object.
    const events = seqOf([
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [
          { name: "T Codeunit.T1", outcome: "pass", classification: [] },
          { name: "T Codeunit.T2", outcome: "fail", classification: [] },
        ],
      },
      scored("M1"),
    ]);
    const { emitted } = await drive(events, fake);
    expect(emitted.find((e) => e.type === "mutant-rechecked")).toMatchObject({
      keptNote: expect.stringContaining("rule (c)"),
    });
  });

  test("a nested run that throws: one warning, no row touched", async () => {
    const fake = fakeRunner(() => new Error("daemon died"));
    const { emitted, summary } = await drive(mainEvents([scored("M1")]), fake);
    expect(emitted).toMatchObject([{ type: "warning", code: "withheld-recheck-failed" }]);
    expect(summary.recovered).toBe(0);
  });
});

// --- the fold and the report -------------------------------------------------------------------

const STATICS: FoldStatics = {
  caps: {
    kind: "al-runner-v3",
    authoritative: false,
    coverage: "procedure",
    deploy: "none",
    isolation: "session",
  },
  buildSymbols: [],
} as FoldStatics;

function report(extra: RunEventInput[]): SessionReport {
  const events: RunEventInput[] = [
    {
      type: "mutation-set-generated",
      siteCount: 2,
      deployedCount: 2,
      hangCapableCount: 0,
      totalFiles: 1,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      preprocExcludedFiles: [],
      excludedByOnly: 0,
      excludedByExclude: 0,
      excludedByOperator: 0,
    },
    {
      type: "baseline-batch-finished",
      batchIndex: 0,
      verdicts: [
        { name: "T Codeunit.T1", outcome: "pass", classification: [] },
        { name: "T Codeunit.T2", outcome: "pass", classification: [] },
      ],
    },
    {
      type: "coverage-split",
      batchIndex: 0,
      untargetedTriggerCount: 0,
      coveredCount: 2,
      noCoverageCount: 0,
      unplaceableCount: 0,
      unplaceableMutants: [],
    },
    ...extra,
    { type: "session-finished", elapsedMs: 1 },
  ];
  return buildReport(STATICS, seqOf(events));
}

const RECOVERY = {
  killingTest: "T2",
  killingTestFailure: "Expected 1 got 2",
  coveringTests: ["T Codeunit.T1", "T Codeunit.T2"],
  isolatedRecheck: {
    withheldFailure: "Expected 1 got 2",
    afterTest: "T2",
    killerGreenInMainBaseline: true,
  },
};

describe("fold and report", () => {
  test("a recovered row becomes killed, with isolatedRecheck and the caveat; withheld-kills goes", () => {
    const r = report([
      scored("M1"),
      {
        type: "mutant-rechecked",
        mutant: manifest("M1", { startIndex: 100, endIndex: 105 }),
        batchIndex: 0,
        durationMs: 7,
        recovery: RECOVERY,
      },
    ]);
    const m = r.mutants[0];
    expect(m?.verdict).toBe("killed");
    expect(m?.killReproduced).toBe(true);
    expect(m?.killingTest).toBe("T2");
    expect(m?.isolatedRecheck).toEqual(RECOVERY.isolatedRecheck);
    expect(m?.withheldKill).toBeUndefined();
    expect(m?.failureNote).toBeUndefined();
    expect(m?.cause).toBeUndefined();
    expect(m?.durationMs).toBe(17);
    expect(r.counts.killed).toBe(1);
    expect(r.counts.errors).toBe(0);
    expect(r.mutationScore).toBe(1);
    expect(r.validity.caveats).toContain("isolated-recheck-kills");
    expect(r.validity.caveats).not.toContain("withheld-kills");
  });

  test("the caveat's meaning carries the warning", async () => {
    const { CAVEAT_INTERPRETATIONS } = await import("../src/report");
    expect(CAVEAT_INTERPRETATIONS["isolated-recheck-kills"].meaning).toContain(RECHECK_WARNING);
  });

  test("a kept row stays error and a withheld kill: the note is AFTER the suffix", () => {
    const note = "[recheck kept error: rule (b): the recheck verdict is survived, not killed]";
    const r = report([
      scored("M1"),
      {
        type: "mutant-rechecked",
        mutant: manifest("M1", { startIndex: 100, endIndex: 105 }),
        batchIndex: 0,
        durationMs: 3,
        keptNote: note,
      },
    ]);
    const m = r.mutants[0];
    expect(m?.verdict).toBe("error");
    expect(m?.failureNote).toBe(`${AFTER_FAIL} ${note}`);
    expect(m?.failureNote?.indexOf(V3_NOT_RUN_SUFFIX)).toBeLessThan(
      m?.failureNote?.indexOf(note) ?? 0,
    );
    expect(m?.withheldKill).toEqual({ failure: "Expected 1 got 2", afterTest: "T2" });
    expect(m?.isolatedRecheck).toBeUndefined();
    expect(r.validity.caveats).toContain("withheld-kills");
    expect(r.validity.caveats).not.toContain("isolated-recheck-kills");
  });

  test("withheldKillOf still matches a kept note (red-direction: a note BEFORE the suffix would not)", () => {
    const note = "[recheck kept error: rule (c): x]";
    expect(withheldKillOf("error", "runner-refused", `${AFTER_FAIL} ${note}`)?.failure).toBe(
      "Expected 1 got 2",
    );
    const before = AFTER_FAIL.replace(` ${V3_NOT_RUN_SUFFIX}`, ` ${note} ${V3_NOT_RUN_SUFFIX}`);
    expect(withheldKillOf("error", "runner-refused", before)?.failure).not.toBe("Expected 1 got 2");
  });

  test("only a withheld-kill row is replaced: a killed row, an error row, a missing row all throw", () => {
    const re = (id: string): RunEventInput => ({
      type: "mutant-rechecked",
      mutant: manifest(id, {
        startIndex: Number(id.slice(1)) * 100,
        endIndex: Number(id.slice(1)) * 100 + 5,
      }),
      batchIndex: 0,
      durationMs: 1,
      recovery: RECOVERY,
    });
    expect(() =>
      report([
        scored("M1", { verdict: "killed", cause: undefined, failureNote: undefined }),
        re("M1"),
      ]),
    ).toThrow(/names no withheld-kill row/);
    expect(() =>
      report([scored("M1", { failureNote: "NotRun: out-of-scope: refused" }), re("M1")]),
    ).toThrow(/names no withheld-kill row/);
    expect(() => report([scored("M1"), re("M2")])).toThrow(/names no withheld-kill row/);
  });

  test("a mutant-rechecked with neither recovery nor note is refused", () => {
    expect(() =>
      report([
        scored("M1"),
        {
          type: "mutant-rechecked",
          mutant: manifest("M1", { startIndex: 100, endIndex: 105 }),
          batchIndex: 0,
          durationMs: 1,
        },
      ]),
    ).toThrow(/neither a recovery nor a keptNote/);
  });

  test("the recheck baseline never changes the session's baseline figures", () => {
    const plain = report([scored("M1")]);
    const withRecheck = report([
      scored("M1"),
      {
        type: "recheck-baseline-finished",
        tests: 2,
        elapsedMs: 999,
        verdicts: [
          { name: "T Codeunit.T1", outcome: "fail" },
          { name: "Zed.Z1", outcome: "error" },
        ],
      },
    ]);
    expect(withRecheck.baselineGreen).toBe(plain.baselineGreen);
    expect(withRecheck.validity.baselineTests).toEqual(plain.validity.baselineTests);
    expect(withRecheck.unsupportedTests).toEqual(plain.unsupportedTests);
    expect(withRecheck.timings).toEqual(plain.timings);
  });

  test("an older report (no recheck) has no isolatedRecheck key anywhere", () => {
    const r = report([scored("M1")]);
    expect(JSON.stringify(r)).not.toContain("isolatedRecheck");
  });
});

// --- resume -------------------------------------------------------------------------------------

describe("--resume does not carry a recovered kill", () => {
  const row = (
    verdict: MutantVerdictRow["verdict"],
    over: Partial<MutantVerdictRow> = {},
  ): MutantVerdictRow =>
    ({
      astHash: "h",
      codeunitName: "A",
      procedureName: "P",
      operatorName: "lethal.empty-block",
      operatorMajor: 1,
      file: "src/A.al",
      identityOrdinal: 0,
      verdict,
      durationMs: 1,
      memberHash: "m",
      ...over,
    }) as MutantVerdictRow;

  test("the stored row stays the main pass's error (non-carryable); a reproduced kill row would carry", () => {
    const stored = buildResumeIndex([row("error", { failureNote: AFTER_FAIL })], false, true);
    expect(stored.carryable.size).toBe(0);
    expect(stored.nonCarryableRows).toBe(1);
    // Control: the same site stored as a reproduced kill IS carried, so the test above can fail.
    const control = buildResumeIndex([row("killed", { killReproduced: true })], false, true);
    expect(control.carryable.size).toBe(1);
  });
});

// --- config, docs, cli wiring -------------------------------------------------------------------

describe("config and docs", () => {
  const base = { packagesDir: "/p", bcVersion: "28.0.1.1", path: "/x/al-runner" };

  test("defaults: on (PR-182), 3600 s; false opts out", () => {
    const c = validateAlRunnerV3Config(base);
    expect(c.recheckWithheldKills).toBe(true);
    expect(
      validateAlRunnerV3Config({ ...base, recheckWithheldKills: false }).recheckWithheldKills,
    ).toBe(false);
    expect(c.recheckBudgetSeconds).toBe(V3_RECHECK_BUDGET_SECONDS_DEFAULT);
    expect(V3_RECHECK_BUDGET_SECONDS_DEFAULT).toBe(3600);
  });

  test("validation refuses a non-boolean switch and a bad budget by name", () => {
    expect(() => validateAlRunnerV3Config({ ...base, recheckWithheldKills: "yes" })).toThrow(
      /recheckWithheldKills.*boolean/,
    );
    for (const bad of [0, -1, 1.5, "60", Number.NaN])
      expect(() => validateAlRunnerV3Config({ ...base, recheckBudgetSeconds: bad })).toThrow(
        /recheckBudgetSeconds/,
      );
    const c = validateAlRunnerV3Config({
      ...base,
      recheckWithheldKills: true,
      recheckBudgetSeconds: 90,
    });
    expect([c.recheckWithheldKills, c.recheckBudgetSeconds]).toEqual([true, 90]);
  });

  test("the warning sentence is verbatim in the spec, the README, the config doc and the caveat", () => {
    expect(RECHECK_WARNING).toBe(
      "kills recovered this way are not measured against BC; they may be false where an earlier test that al-runner refused would have set state on BC.",
    );
    const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
    expect(read("README.md")).toContain(`Warning: ${RECHECK_WARNING}`);
    expect(read("packages/runner/src/al-runner-v3-config.ts")).toContain(RECHECK_WARNING);
  });

  test("the not-yet-exercised-live sentence is pinned beside the warning, in the README and the caveat", async () => {
    expect(RECHECK_UNEXERCISED).toBe(
      "The recheck is exercised live by the al-runner-v3 gate's leg RC (PR-162) on a fixture built to withhold a kill, and measured against BC on a DO sample (PR-170: 42 of 58 recovered kills confirmed, 0 false).",
    );
    const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
    expect(read("README.md")).toContain(`${RECHECK_WARNING} ${RECHECK_UNEXERCISED}`);
    const { CAVEAT_INTERPRETATIONS } = await import("../src/report");
    expect(CAVEAT_INTERPRETATIONS["isolated-recheck-kills"].meaning).toContain(
      `${RECHECK_WARNING} ${RECHECK_UNEXERCISED}`,
    );
  });
});

describe("v3RecheckOf (cli wiring)", () => {
  const parsed = { backendKind: "al-runner-v3" } as RunCliConfig;
  const section = { packagesDir: "/p", bcVersion: "28.0.1.1", path: "/pinned/al-runner" };
  const mainConfig = {
    backend: {},
    store: {},
    projectDir: "/proj",
    testDir: "/tests",
    instrumentedDir: "/scratch/instrumented",
    selectorIds: {},
    workers: 2,
    only: ["src/**"],
    resume: undefined,
    lines: [{ file: "x.al", start: 1, end: 2 }],
    excludeTests: ["A.B"],
    skipKnownSurvivors: true,
  } as unknown as SessionConfig;

  function wire(
    alRunnerV3: Record<string, unknown>,
    kind: "al-runner-v3" | "bcdev" = "al-runner-v3",
  ) {
    const built: { config: unknown; dir: string }[] = [];
    const ran: SessionConfig[] = [];
    let closed = 0;
    let storeClosed = 0;
    const recheck = v3RecheckOf({
      parsed: { ...parsed, backendKind: kind },
      effectiveConfig: { alRunnerV3 } as never,
      mainConfig,
      build: async (config, dir) => {
        built.push({ config, dir });
        return {
          close: async () => {
            closed += 1;
          },
        } as never;
      },
      runSession: async (cfg) => {
        ran.push(cfg);
        return {
          mutants: [],
          sourceSha256: "s",
          dependencySourceSha256: "d",
          validity: { executionContexts: [{ runnerBuild: "v", binarySha256: "b" }] },
        } as never;
      },
      newStore: () =>
        ({
          close: () => {
            storeClosed += 1;
          },
        }) as unknown as ResultsStore,
      scratchRoot: "/scratch",
    });
    return { recheck, built, ran, closed: () => closed, storeClosed: () => storeClosed };
  }

  test("key absent: the recheck is built (default on, PR-182)", () => {
    expect(wire(section).recheck?.budgetSeconds).toBe(3600);
  });

  test("option off, or another backend: no recheck is built", () => {
    expect(wire({ ...section, recheckWithheldKills: false }).recheck).toBeUndefined();
    expect(wire({ ...section, recheckWithheldKills: true }, "bcdev").recheck).toBeUndefined();
  });

  test("option on: the nested session is the pinned config under method isolation, narrowed, with no recheck or resume", async () => {
    const w = wire({ ...section, recheckWithheldKills: true, recheckBudgetSeconds: 120 });
    expect(w.recheck?.budgetSeconds).toBe(120);
    const t = target("M1");
    const res = await w.recheck?.runner({
      targets: [t],
      tests: ["T Codeunit.T1"],
      budgetSeconds: 120,
    });
    expect(w.built).toHaveLength(1);
    // cli.ts builds both folders with path.join: backslashes on Windows (CI check 44344348571)
    expect(w.built[0]?.dir).toBe(join("/scratch", "recheck"));
    expect(
      (w.built[0]?.config as { alRunnerV3: Record<string, unknown> }).alRunnerV3,
    ).toMatchObject({
      path: "/pinned/al-runner",
      isolation: "method",
    });
    const nested = w.ran[0];
    expect(nested?.keepOnlyTests).toEqual(["T Codeunit.T1"]);
    expect(nested?.timeBudgetSeconds).toBe(120);
    expect(nested?.lines).toEqual([{ file: "src/A.al", start: 3, end: 3 }]);
    expect(nested?.exactSites?.size).toBe(1);
    expect(nested?.instrumentedDir).toBe(join("/scratch", "recheck-instrumented"));
    expect(nested?.projectDir).toBe("/proj");
    expect(nested?.only).toEqual(["src/**"]);
    expect(nested?.excludeTests).toEqual(["A.B"]); // R488: kept
    for (const k of ["recheck", "resume", "skipKnownSurvivors", "changedSince"] as const)
      expect(nested?.[k]).toBeUndefined();
    expect(nested?.emit).toHaveLength(1); // its own collector, never the main run's subscribers
    expect(res?.identity).toEqual({
      version: "v",
      binarySha256: "b",
      sourceSha256: "s",
      dependencySourceSha256: "d",
    });
    expect([w.closed(), w.storeClosed()]).toEqual([1, 1]);
  });
});
