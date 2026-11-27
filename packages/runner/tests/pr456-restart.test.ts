import { describe, expect, test } from "bun:test";
import { IDENTITY_SCHEME, type MutantManifestEntry } from "@lethal/schemata";
import type { CoverageMap, TestMethodRef, TestVerdict } from "../src/backend";
import type { BaselineObservation } from "../src/baseline-snapshot";
import { restartRowAction } from "../src/orchestrator";
import { type CarriedVerdict, buildResumeIndex } from "../src/resume";
import {
  assertRestartRowBatch,
  compareRestartBaseline,
  decideRestartBatch,
  restartResumeOf,
} from "../src/resume-restart";
import { ResultsStore } from "../src/store";
import type { MutantVerdictRow } from "../src/store";
import { newKillLedger, procedureScopeOf, recordKill, seedKill } from "../src/test-order";

/**
 * PR-456 (R1229): the pure decisions of a resume across a restart that lost the database. Every name
 * here is invented; each case is one filter, in both directions where it has two.
 */

const ref = (method: string): TestMethodRef => ({
  codeunitId: 70000,
  codeunitName: "Invented Tests",
  method,
});
const cov = (over: Partial<CoverageMap> = {}): CoverageMap => ({
  granularity: "procedure",
  entries: [
    { objectType: "Codeunit", objectId: 70001, procedure: "Alpha" },
    { objectType: "Codeunit", objectId: 70001, procedure: "Beta", overloadIndex: 1 },
  ],
  ...over,
});
/** `v` may set a field to `undefined` (a missing WorkDate); `null` coverage is "no map". */
const obs = (
  method: string,
  v: { [K in keyof TestVerdict]?: TestVerdict[K] | undefined } = {},
  withCoverage: CoverageMap | null = cov(),
): BaselineObservation => ({
  ref: ref(method),
  verdict: {
    ref: ref(method),
    outcome: "pass",
    durationMs: 1,
    workDate: "2026-11-20",
    ...(withCoverage !== null ? { coverage: withCoverage } : {}),
    ...v,
  } as TestVerdict,
});
const base = (): BaselineObservation[] => [obs("T1"), obs("T2")];

describe("restartResumeOf (r5 #2: the same server, both ids, both changed)", () => {
  const row = { serverGeneration: "g1", databaseId: "d1", resourceKey: "srv" };
  const now = { serverGeneration: "g2", databaseId: "d2", resourceKey: "srv" };
  test("generation and id changed on the same server: restart mode", () => {
    expect(restartResumeOf(row, now)).toMatchObject({
      priorGeneration: "g1",
      priorDatabaseId: "d1",
      generation: "g2",
      databaseId: "d2",
      resourceKey: "srv",
    });
  });
  test("another resource key, or none on either side, refuses", () => {
    expect(restartResumeOf(row, { ...now, resourceKey: "other" })).toBeUndefined();
    expect(restartResumeOf({ ...row, resourceKey: null }, now)).toBeUndefined();
    expect(restartResumeOf(row, { ...now, resourceKey: undefined })).toBeUndefined();
  });
  test("a missing or empty id on either side refuses; the SAME id is not this branch (R969)", () => {
    expect(restartResumeOf({ ...row, databaseId: null }, now)).toBeUndefined();
    expect(restartResumeOf(row, { ...now, databaseId: undefined })).toBeUndefined();
    expect(restartResumeOf(row, { ...now, databaseId: "" })).toBeUndefined();
    expect(restartResumeOf(row, { ...now, databaseId: "d1" })).toBeUndefined();
  });
  test("a prior with no generation refuses", () => {
    expect(restartResumeOf({ ...row, serverGeneration: null }, now)).toBeUndefined();
  });
});

describe("compareRestartBaseline (r5 #6: exact equality)", () => {
  test("equal baselines compare equal, whatever the coverage entry ORDER", () => {
    const reordered = [obs("T1", {}, cov({ entries: [...cov().entries].reverse() })), obs("T2")];
    expect(compareRestartBaseline(base(), reordered)).toBeUndefined();
    expect(compareRestartBaseline(base(), base())).toBeUndefined();
  });
  test("a verdict that differs", () => {
    const fresh = [obs("T1"), obs("T2", { outcome: "fail" })];
    expect(compareRestartBaseline(base(), fresh)).toContain("outcome pass, now fail");
  });
  test("a different set of test methods", () => {
    expect(compareRestartBaseline(base(), [obs("T1"), obs("T3")])).toContain(
      "different test methods",
    );
    expect(compareRestartBaseline(base(), [obs("T1")])).toContain("different test methods");
  });
  test("a start WorkDate that differs on one test (the other agrees, so the batch date is unstable)", () => {
    const fresh = [obs("T1"), obs("T2", { workDate: "2026-11-21" })];
    expect(compareRestartBaseline(base(), fresh)).toContain("start WorkDate");
  });
  test("commonWorkDate: moved, or missing on one side, differs", () => {
    const moved = [obs("T1", { workDate: "2026-11-21" }), obs("T2", { workDate: "2026-11-21" })];
    expect(compareRestartBaseline(base(), moved)).toContain("moved");
    const none = [obs("T1", { workDate: undefined }), obs("T2", { workDate: undefined })];
    expect(compareRestartBaseline(base(), none)).toContain("missing or unstable on this session");
    expect(compareRestartBaseline(none, base())).toContain("missing or unstable on the prior run");
  });
  test("a WorkDate missing on one side only differs; missing on BOTH sides equals only for a skip", () => {
    const skipBoth = (d: string | undefined): BaselineObservation[] => [
      obs("T1"),
      obs("T2", { outcome: "skip", workDate: d }),
    ];
    // the skip carries no date on both sides: equal
    expect(compareRestartBaseline(skipBoth(undefined), skipBoth(undefined))).toBeUndefined();
    // one-sided absence on the skip: differs
    expect(compareRestartBaseline(skipBoth("2026-11-20"), skipBoth(undefined))).toContain(
      "missing",
    );
    expect(compareRestartBaseline(skipBoth(undefined), skipBoth("2026-11-20"))).toContain(
      "missing",
    );
    // both missing on a PASS is not equal (the date is part of the measurement)
    const passBoth = (): BaselineObservation[] => [obs("T1"), obs("T2", { workDate: undefined })];
    expect(compareRestartBaseline(passBoth(), passBoth())).toContain("missing");
  });
  test("coverage: a missing map on one side differs; missing on both is equal", () => {
    expect(compareRestartBaseline([obs("T1", {}, null)], [obs("T1", {}, null)])).toBeUndefined();
    expect(compareRestartBaseline([obs("T1")], [obs("T1", {}, null)])).toContain("one side only");
    expect(compareRestartBaseline([obs("T1", {}, null)], [obs("T1")])).toContain("one side only");
  });
  test("coverage: a changed entry set differs (a procedure, a line, an overloadIndex)", () => {
    const changed = (entries: CoverageMap["entries"]) => [
      obs("T1", {}, cov({ entries })),
      obs("T2"),
    ];
    const e0 = cov().entries;
    expect(compareRestartBaseline(base(), changed([...e0.slice(0, 1)]))).toContain(
      "entries differ",
    );
    expect(
      compareRestartBaseline(
        base(),
        changed([...e0, { objectType: "Codeunit", objectId: 1, procedure: "Z" }]),
      ),
    ).toContain("entries differ");
    expect(
      compareRestartBaseline(
        base(),
        changed([
          e0[0] as CoverageMap["entries"][number],
          { ...(e0[1] as CoverageMap["entries"][number]), overloadIndex: 2 },
        ]),
      ),
    ).toContain("entries differ");
    expect(compareRestartBaseline(base(), changed(e0.map((e) => ({ ...e, line: 3 }))))).toContain(
      "entries differ",
    );
  });
  test("coverage: granularity and namingGaps differ", () => {
    expect(
      compareRestartBaseline(base(), [obs("T1", {}, cov({ granularity: "line" })), obs("T2")]),
    ).toContain("granularity");
    const gap = { objectType: "Codeunit", objectId: 9 };
    expect(
      compareRestartBaseline(base(), [obs("T1", {}, cov({ namingGaps: [gap] })), obs("T2")]),
    ).toContain("namingGaps");
    // an absent namingGaps and an empty one say the same thing: none known
    expect(
      compareRestartBaseline([obs("T1", {}, cov({ namingGaps: [] }))], [obs("T1")]),
    ).toBeUndefined();
  });
});

describe("decideRestartBatch (r5 #5: each case re-runs by name, only an equal baseline carries)", () => {
  const prior = (baseline = base()) => ({
    runId: 7,
    batchIndex: 2,
    batchHash: "h".repeat(8),
    baseline,
  });
  const input = (over: Partial<Parameters<typeof decideRestartBatch>[0]> = {}) => ({
    prior: prior(),
    fresh: base(),
    freshComplete: true,
    reused: false,
    isolationMode: false,
    isStopped: () => false,
    ...over,
  });
  test("an equal baseline carries, and names the snapshot's hash for the row gate", () => {
    expect(decideRestartBatch(input())).toEqual({
      carry: true,
      priorRunId: 7,
      priorBatchIndex: 2,
      batchHash: "hhhhhhhh",
    });
  });
  test.each([
    ["no snapshot", { prior: null }, "no usable baseline snapshot"],
    ["a fresh baseline that did not complete", { freshComplete: false }, "did not complete"],
    ["a reused snapshot", { reused: true }, "reused"],
    ["an isolation mode", { isolationMode: true }, "isolation"],
    [
      "hub mode",
      { fresh: [obs("T1", { workDate: undefined }), obs("T2", { workDate: undefined })] },
      "hub mode",
    ],
    [
      "a fresh stopped test",
      { isStopped: (v: TestVerdict) => v.ref.method === "T2" },
      "stopped test",
    ],
    ["a baseline that differs", { fresh: [obs("T1"), obs("T2", { outcome: "fail" })] }, "differs"],
  ] as const)("%s re-runs the batch", (_name, over, why) => {
    const d = decideRestartBatch(input(over as never));
    expect(d.carry).toBe(false);
    if (!d.carry) expect(d.reason).toContain(why);
  });
  test("a stored baseline with a stopped test re-runs the batch", () => {
    const d = decideRestartBatch(
      input({
        isStopped: (v: TestVerdict) => v.outcome === "skip",
        prior: prior([obs("T1"), obs("T2", { outcome: "skip" })]),
        fresh: base(),
      }),
    );
    expect(d.carry).toBe(false);
    if (!d.carry) expect(d.reason).toContain("prior baseline holds a stopped test");
  });
});

describe("assertRestartRowBatch (r5 #4: a survivor carries only against ITS batch's snapshot)", () => {
  const decision = { carry: true as const, priorRunId: 7, priorBatchIndex: 2, batchHash: "abc" };
  test("the row's batch hash equal to the compared one passes", () => {
    expect(() => assertRestartRowBatch(decision, 7, { batchIndex: 2 }, "abc")).not.toThrow();
  });
  test("another hash, no snapshot, or no batch index fails loudly", () => {
    expect(() => assertRestartRowBatch(decision, 7, { batchIndex: 3 }, "zzz")).toThrow(
      "caller-contract violation",
    );
    expect(() => assertRestartRowBatch(decision, 7, { batchIndex: 3 }, null)).toThrow(
      "no batch snapshot",
    );
    expect(() => assertRestartRowBatch(decision, 7, { batchIndex: undefined }, "abc")).toThrow(
      "no batch snapshot",
    );
  });
});

describe("restartRowAction (r3 items 3-4, D6, r5 #3-#4: one row, one decision)", () => {
  const T1 = ref("T1");
  const T2 = ref("T2");
  const equal = { carry: true as const, priorRunId: 7, priorBatchIndex: 2, batchHash: "abc" };
  const differs = { carry: false as const, reason: "invented" };
  const survivor = (over: Partial<CarriedVerdict> = {}): CarriedVerdict => ({
    verdict: "survived",
    durationMs: 1,
    batchIndex: 2,
    coveringTests: ["Invented Tests.T1"],
    ...over,
  });
  const act = (
    carried: CarriedVerdict,
    over: Partial<Parameters<typeof restartRowAction>[0]> = {},
  ) =>
    restartRowAction({
      carried,
      covering: [T1],
      decision: equal,
      tests: [T1, T2],
      priorRunId: 7,
      rowBatchHash: () => "abc",
      ...over,
    });

  test("a survivor of an equal batch with a faced record carries", () => {
    expect(act(survivor())).toEqual({ kind: "carry" });
  });
  test("a survivor of a batch that did not compare equal is re-run, by name", () => {
    expect(act(survivor(), { decision: differs })).toEqual({ kind: "rerun", why: "batch" });
    expect(act(survivor(), { decision: undefined })).toEqual({ kind: "rerun", why: "batch" });
  });
  test("a kill is re-run and its single killer is seeded; no single killer: no seed", () => {
    const killed = (over: Partial<CarriedVerdict> = {}): CarriedVerdict => ({
      verdict: "killed",
      durationMs: 1,
      killingTest: "T1",
      coveringTests: ["Invented Tests.T1", "Invented Tests.T2"],
      ...over,
    });
    expect(act(killed())).toEqual({ kind: "kill", seed: T1 });
    // two covering tests with the killer's method name: no single killer
    expect(
      act(killed({ coveringTests: ["Invented Tests.T1", "Other Tests.T1"] }), {
        tests: [T1, { ...T1, codeunitName: "Other Tests" }],
      }),
    ).toEqual({ kind: "kill" });
    // a ledger-order kill is never seeded (R1179)
    expect(act(killed({ failureNote: "[ledger-order-survived] x" }))).toEqual({ kind: "kill" });
    // a timeout kill is a kill too
    expect(act(killed({ verdict: "timeout-killed" }))).toEqual({ kind: "kill", seed: T1 });
  });
  test("a known-survivor (a history lend) is never carried in restart mode", () => {
    expect(act(survivor({ verdict: "known-survivor" }))).toEqual({
      kind: "rerun",
      why: "not-carryable",
    });
  });
  test("R646 still holds: no record, or a covering test it never faced, is re-run", () => {
    expect(act(survivor({ coveringTests: [] }))).toEqual({ kind: "rerun", why: "no-record" });
    const { coveringTests: _drop, ...none } = survivor();
    expect(act(none)).toEqual({ kind: "rerun", why: "no-record" });
    expect(act(survivor(), { covering: [T1, T2] })).toEqual({ kind: "rerun", why: "not-faced" });
  });
  test("the batch gate: a row whose batch hashes to another snapshot, or none, or has no batch, throws", () => {
    expect(() => act(survivor(), { rowBatchHash: () => "zzz" })).toThrow(
      "caller-contract violation",
    );
    expect(() => act(survivor(), { rowBatchHash: () => null })).toThrow("no batch snapshot");
    expect(() => act(survivor({ batchIndex: undefined as never }))).toThrow("no batch snapshot");
  });
  test("the gate is not reached when the batch did not compare equal (nothing carries, nothing throws)", () => {
    expect(act(survivor(), { decision: differs, rowBatchHash: () => "zzz" })).toEqual({
      kind: "rerun",
      why: "batch",
    });
  });
});

describe("buildResumeIndex in restart mode (r5 #3, D1, D6)", () => {
  const row = (over: Partial<MutantVerdictRow>): MutantVerdictRow => ({
    astHash: "h",
    codeunitName: "Invented",
    procedureName: "Proc",
    operatorName: "op",
    operatorMajor: 1,
    file: "f.al",
    identityOrdinal: 0,
    batchIndex: 4,
    verdict: "survived",
    durationMs: 1,
    memberHash: null,
    ...over,
  });
  const rows = [
    row({ astHash: "s", verdict: "survived", coveringTests: ["Invented Tests.T1"] }),
    row({ astHash: "k", verdict: "killed", killingTest: "T1", killReproduced: true }),
    row({ astHash: "t", verdict: "timeout-killed", killingTest: "T1", killReproduced: true }),
    row({ astHash: "n", verdict: "known-survivor" }),
    row({ astHash: "e", verdict: "error" }),
    row({ astHash: "c", verdict: "no-coverage" }),
  ];
  test("known-survivor does not carry in restart mode, and carries as today otherwise", () => {
    const restart = buildResumeIndex(rows, true, true, true);
    const verdicts = [...restart.carryable.values()].map((v) => v.verdict).sort();
    // (a stored no-coverage stays in the index and is dropped by `carriedVerdictFor`, R621)
    expect(verdicts).toEqual(["killed", "no-coverage", "survived", "timeout-killed"]);
    const plain = buildResumeIndex(rows, true, true, false);
    expect([...plain.carryable.values()].map((v) => v.verdict)).toContain("known-survivor");
  });
  test("a carried verdict carries its batch (r5 #4)", () => {
    const restart = buildResumeIndex(rows, true, true, true);
    for (const v of restart.carryable.values()) expect(v.batchIndex).toBe(4);
  });
  test("a strand stays a stranded key in restart mode (D1)", () => {
    const strand = row({ astHash: "x", verdict: "error", failureNote: "quarantined: invented" });
    expect(buildResumeIndex([strand], true, true, true).strandedKeys.size).toBe(1);
  });
  test("an unreproduced kill is not kept even for seeding (the oracle's rule)", () => {
    const idx = buildResumeIndex(
      [row({ astHash: "k", verdict: "killed", killingTest: "T1" })],
      true,
      true,
      true,
    );
    expect(idx.carryable.size).toBe(0);
    expect(idx.unreproducedKills).toBe(1);
  });
});

describe("the kill ledger seed counts once (D6, R197)", () => {
  const m = {
    mutantId: "M1",
    codeunitName: "Invented",
    procedureName: "Proc",
  } as unknown as MutantManifestEntry;
  const count = (l: ReturnType<typeof newKillLedger>) =>
    [...(l.killsByProcedure.get(procedureScopeOf(m))?.values() ?? [])].reduce((a, b) => a + b, 0);
  test("a seed then the SAME kill live counts once", () => {
    const l = newKillLedger();
    seedKill(l, m, ref("T1"));
    expect(count(l)).toBe(1);
    recordKill(l, m, ref("T1"));
    expect(count(l)).toBe(1);
  });
  test("a seed then a kill by ANOTHER test keeps both (the seed was only a hint)", () => {
    const l = newKillLedger();
    seedKill(l, m, ref("T1"));
    recordKill(l, m, ref("T2"));
    expect(count(l)).toBe(2);
  });
  test("a live kill with no seed counts as before, and twice is twice", () => {
    const l = newKillLedger();
    recordKill(l, m, ref("T1"));
    recordKill(l, m, ref("T1"));
    expect(count(l)).toBe(2);
  });
});

describe("store: priorRestartSnapshot, batchIndex, the run flag", () => {
  const newRun = (s: ResultsStore) =>
    s.createRun({
      testScope: [],
      coverageMode: "none",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "P",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
  const snap = (s: ResultsStore, runId: number, batchIndex: number, batchHash: string) =>
    s.recordBaselineSnapshot({ runId, batchIndex, batchHash, testAppHash: "t", baseline: base() });

  test("finds the run's own snapshot by hash, not by index", () => {
    const s = new ResultsStore(":memory:");
    const r = newRun(s);
    snap(s, r, 0, "hash-a");
    snap(s, r, 1, "hash-b");
    expect(s.priorRestartSnapshot(r, "hash-b")).toMatchObject({
      runId: r,
      batchIndex: 1,
      batchHash: "hash-b",
    });
    expect(s.priorRestartSnapshot(r, "hash-none")).toBeNull();
    s.close();
  });
  test("follows the PR-66 reuse row when the run stored none of its own", () => {
    const s = new ResultsStore(":memory:");
    const a = newRun(s);
    const b = newRun(s);
    snap(s, a, 3, "hash-a");
    s.recordSnapshotReuse(b, 0, a, 3);
    expect(s.priorRestartSnapshot(b, "hash-a")).toMatchObject({ runId: a, batchIndex: 3 });
    // another run with no reuse row finds nothing
    expect(s.priorRestartSnapshot(newRun(s), "hash-a")).toBeNull();
    s.close();
  });
  test("a suspect, a lost and a degraded-window snapshot are never returned", () => {
    const s = new ResultsStore(":memory:");
    const r = newRun(s);
    snap(s, r, 0, "suspect");
    snap(s, r, 1, "lost");
    snap(s, r, 2, "ok");
    snap(s, r, 3, "degraded");
    s.markSnapshotSuspect({ runId: r, batchIndex: 0 }, r);
    s.db.run("INSERT INTO lost_batches (run_id, batch_index, note) VALUES (?, 1, 'x')", [r]);
    const afterOk = (
      s.db.query("SELECT id FROM baseline_snapshots WHERE batch_hash = 'ok'").get() as {
        id: number;
      }
    ).id;
    s.markDegradedWindow(r, 0, afterOk, "the tier slowed down (invented)");
    expect(s.priorRestartSnapshot(r, "suspect")).toBeNull();
    expect(s.priorRestartSnapshot(r, "lost")).toBeNull();
    expect(s.priorRestartSnapshot(r, "degraded")).toBeNull();
    expect(s.priorRestartSnapshot(r, "ok")).not.toBeNull();
    s.close();
  });
  test("markResumedAcrossRestart sets the run flag; the others stay false", () => {
    const s = new ResultsStore(":memory:");
    const a = newRun(s);
    const b = newRun(s);
    expect(s.getRun(a)?.resumedAcrossRestart).toBe(false);
    s.markResumedAcrossRestart(a);
    s.markResumedAcrossRestart(a);
    expect(s.getRun(a)?.resumedAcrossRestart).toBe(true);
    expect(s.getRun(b)?.resumedAcrossRestart).toBe(false);
    expect(() => s.markResumedAcrossRestart(999)).toThrow("no run 999");
    s.close();
  });
});
