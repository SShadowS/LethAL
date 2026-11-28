// PR-466 part 2 (R1228): the tier-slowdown STOP. Spec: docs/superpowers/specs/2026-11-27-pr466-tier-slowdown-stop.md
// (r2 and its r2a section). Stateful fakes and call counters only: no clock, no /coord.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type { MutantManifestEntry, SelectorConfig } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { TIME_BUDGET_EXIT_CODE, exitCodeForReport } from "../src/cli";
import { clock } from "../src/clock";
import type { RunEvent, RunEventInput } from "../src/events";
import { createEmitter } from "../src/events";
import type { LeaseApi } from "../src/lease";
import { TimeBudget } from "../src/mutant-windows";
import {
  LeaseSession,
  budgetCutsWalk,
  correctStoreAtEnd,
  feedTierSlowdown,
  invalidateDegradedWindow,
  onTierSlowdownStop,
  record,
  renewWindowWriter,
  runSession,
} from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import { createProgressRenderer } from "../src/progress-renderer";
import { QuarantineStore } from "../src/quarantine-store";
import { renderConsole } from "../src/report";
import type { SessionOutcome, SessionReport } from "../src/report";
import { foldEvents } from "../src/report-fold";
import type { FoldStatics } from "../src/report-fold";
import { CARRYABLE_VERDICTS } from "../src/resume";
import { SessionSafety } from "../src/session-safety";
import { ResultsStore } from "../src/store";
import {
  TIER_SLOWDOWN_BLOCK,
  TIER_SLOWDOWN_HOLD,
  TIER_SLOWDOWN_MIN_REF_MS,
  TIER_SLOWDOWN_REASON_PREFIX,
  TIER_SLOWDOWN_STOP,
  TierSlowdownMonitor,
  type TierSlowdownStop,
  storeReference,
  tierSlowdownNote,
  tierSlowdownWarning,
} from "../src/tier-slowdown";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

beforeAll(async () => {
  await initParser();
});

// ---------------------------------------------------------------------------------------------
// The monitor alone: a stateful fake feeds it rows, a counter says where the stream stands.
// ---------------------------------------------------------------------------------------------

/** Reference 100 ms for every test, so a row's ratio is its own ms / 100. */
function monitorRig(
  reference: (cu: number, m: string, b: number) => number | undefined = () => 100,
) {
  const stops: TierSlowdownStop[] = [];
  const state = { seq: 0, snapshot: 7 };
  const mon = new TierSlowdownMonitor({
    reference,
    scoredSeq: () => state.seq,
    snapshotId: () => state.snapshot,
    onStop: (s) => stops.push(s),
  });
  /** One block of 50 rows at `ratio`; mutant row ids run from `firstId`, the scored seq is ten times the id. */
  const block = (ratio: number, firstId: number) => {
    for (let i = 0; i < TIER_SLOWDOWN_BLOCK; i++) {
      state.seq = (firstId + i) * 10;
      mon.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: ratio * 100 }, firstId + i);
    }
  };
  return { mon, stops, state, block };
}

describe("PR-466 constants", () => {
  test("the first-cut values are exported", () => {
    expect([
      TIER_SLOWDOWN_BLOCK,
      TIER_SLOWDOWN_STOP,
      TIER_SLOWDOWN_HOLD,
      TIER_SLOWDOWN_MIN_REF_MS,
    ]).toEqual([50, 4.0, 3, 50]);
  });
});

describe("PR-466 test 1: the HOLD", () => {
  test("the 3rd consecutive block at 4.0 or over stops; the 2nd does not; the stop names the first block's mark", () => {
    const r = monitorRig();
    r.block(5, 1000);
    r.block(6, 1050);
    expect(r.stops).toHaveLength(0);
    r.block(7, 1100);
    expect(r.stops).toHaveLength(1);
    const [s] = r.stops;
    expect(s?.medians).toEqual([5, 6, 7]);
    // the mark of the FIRST block's first row: row id 1000 -> 999, its scored seq 10000 -> 9999, the snapshot id then
    expect(s?.afterMutantId).toBe(999);
    expect(s?.afterSeq).toBe(9999);
    expect(s?.afterSnapshotId).toBe(7);
    expect(r.mon.stop).toBe(s);
  });

  test("a block under 4.0 resets the streak", () => {
    const r = monitorRig();
    r.block(5, 1);
    r.block(5, 51);
    r.block(1, 101); // resets
    r.block(5, 151);
    r.block(5, 201);
    expect(r.stops).toHaveLength(0);
    r.block(5, 251); // the third in a row since the reset
    expect(r.stops).toHaveLength(1);
    expect(r.stops[0]?.afterMutantId).toBe(150); // the mark of the block at 151, not of the first 5
  });

  test("exactly 4.0 counts (at or over), and once stopped the monitor feeds no more", () => {
    const r = monitorRig();
    r.block(4, 1);
    r.block(4, 51);
    r.block(4, 101);
    expect(r.stops).toHaveLength(1);
    r.block(9, 151);
    r.block(9, 201);
    r.block(9, 251);
    expect(r.stops).toHaveLength(1);
    expect(r.mon.fed).toBe(150);
  });
});

describe("PR-466 test 2: healthy-like streams never stop", () => {
  test("3.9 throughout, 20 blocks", () => {
    const r = monitorRig();
    for (let i = 0; i < 20; i++) r.block(3.9, 1 + i * 50);
    expect(r.stops).toHaveLength(0);
  });

  test("alternating blocks of 3.6 and 1.0", () => {
    const r = monitorRig();
    for (let i = 0; i < 20; i++) r.block(i % 2 === 0 ? 3.6 : 1.0, 1 + i * 50);
    expect(r.stops).toHaveLength(0);
  });

  test("the block's MEDIAN decides, not its mean or max: 24 rows at 20x and 26 at 1x is a median of 1", () => {
    const r = monitorRig();
    for (let b = 0; b < 6; b++) {
      for (let i = 0; i < TIER_SLOWDOWN_BLOCK; i++) {
        r.state.seq = b * 50 + i + 1;
        r.mon.feed(
          { codeunitId: 1, method: "T", batchIndex: 0, ownMs: i < 24 ? 2000 : 100 },
          b * 50 + i + 1,
        );
      }
    }
    expect(r.stops).toHaveLength(0);
    // the other side: 26 rows at 20x is a median of 20
    const q = monitorRig();
    for (let b = 0; b < 3; b++) {
      for (let i = 0; i < TIER_SLOWDOWN_BLOCK; i++) {
        q.state.seq = b * 50 + i + 1;
        q.mon.feed(
          { codeunitId: 1, method: "T", batchIndex: 0, ownMs: i < 26 ? 2000 : 100 },
          b * 50 + i + 1,
        );
      }
    }
    expect(q.stops).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The record() path: two workers, a block boundary inside one mutant's rows.
// ---------------------------------------------------------------------------------------------

const STATICS: FoldStatics = {
  caps: {
    kind: "bcdev",
    authoritative: true,
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
  },
  buildSymbols: [],
};

function manifestEntry(n: number): MutantManifestEntry {
  const id = `M${String(n).padStart(4, "0")}`;
  return {
    mutantId: id,
    file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
    startIndex: 100 + n * 10,
    endIndex: 140 + n * 10,
    startLine: 10 + n,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Sales Helper",
    procedureName: "ComputeTotal",
    procedureScope: "public",
    originalText: "TotalAmount := Quantity * UnitPrice;",
    mutatedText: "",
  };
}

const HEAD_EVENTS: RunEventInput[] = [
  {
    type: "mutation-set-generated",
    siteCount: 100,
    deployedCount: 100,
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
  { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
];

function newRun(store: ResultsStore, over: { testAppHash?: string } = {}): number {
  return store.createRun({
    testScope: [],
    coverageMode: "procedure",
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: [],
    projectPath: "/p",
    backend: "bcdev",
    appVersion: "1",
    configFingerprint: "fp",
    ...(over.testAppHash !== undefined
      ? { testAppHash: over.testAppHash, testAppProven: true, testAppDeps: "D" }
      : {}),
  });
}

const T_REF: TestMethodRef = { codeunitId: 50200, codeunitName: "Tests", method: "T1" };

/** One baseline row (no mutant row, no mutant code) with an own duration. */
function baselineRow(store: ResultsStore, runId: number, method: string, ownMs: number) {
  store.recordTestResult(
    runId,
    null,
    null,
    { codeunitId: 50200, codeunitName: "Tests", method },
    "pass",
    1,
    undefined,
    undefined,
    undefined,
    ownMs,
  );
}

describe("PR-466 test 3: the window boundary through the real record() path, 2 workers", () => {
  const ROWS_PER_MUTANT = 3;

  async function twoWorkerRun() {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    const events: RunEvent[] = [];
    let lastScoredSeq = 0;
    const emit = createEmitter([
      (e) => events.push(e),
      (e) => {
        if (e.type === "mutant-scored") lastScoredSeq = e.seq;
      },
    ]);
    for (const h of HEAD_EVENTS) emit(h);
    const timeBudget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
    const monitor = new TierSlowdownMonitor({
      reference: () => 100,
      scoredSeq: () => lastScoredSeq,
      snapshotId: () => store.windowMark(runId).snapshotId,
      onStop: (s) => onTierSlowdownStop({ store, runId, timeBudget, emit }, s),
    });
    const outcomes: SessionOutcome[] = [];
    let ordinal = 0; // the recording order, across both workers
    const SLOW_FROM = 18; // row 52: the 2nd block's first row is row 51, the 3rd row of mutant 17
    const worker = async (name: string) => {
      for (;;) {
        await Promise.resolve(); // the other worker records in between; nothing awaits inside one record
        if (timeBudget.exhausted || ordinal >= 90) return;
        ordinal += 1;
        const n = ordinal;
        const id = record(store, runId, manifestEntry(n), "survived", outcomes, 0, emit);
        for (let k = 0; k < ROWS_PER_MUTANT; k++) {
          const row = {
            mutantCode: `M${String(n).padStart(4, "0")}`,
            ref: { ...T_REF, method: `T${k}` },
            outcome: "pass" as const,
            ownDurationMs: n >= SLOW_FROM ? 600 : 100,
          };
          store.recordTestResult(
            runId,
            id,
            row.mutantCode,
            row.ref,
            "pass",
            1,
            undefined,
            undefined,
            undefined,
            row.ownDurationMs,
          );
          feedTierSlowdown(monitor, row, 0, id);
        }
        void name;
      }
    };
    await Promise.all([worker("a"), worker("b")]);
    emit({ type: "session-finished", elapsedMs: 1 });
    return { store, runId, events, outcomes, monitor, timeBudget };
  }

  test("the store's in-window mutants equal the fold's dropped ones, and both start at the onset mutant", async () => {
    const { store, runId, events, monitor, timeBudget } = await twoWorkerRun();
    // the stop: rows 51-200 are 3 blocks at 6x (row 51 is mutant 17's 3rd row: the boundary splits that mutant)
    expect(monitor.stop?.medians).toEqual([6, 6, 6]);
    expect(timeBudget.slowdown).toBe(monitor.stop);
    const inStore = (
      store.db
        .query(
          "SELECT mutant_code AS c FROM mutants WHERE run_id = ? AND verdict = 'error' ORDER BY id",
        )
        .all(runId) as Array<{ c: string }>
    ).map((r) => r.c);
    const folded = foldEvents(STATICS, events);
    const inFold = folded.outcomes
      .filter((o) => o.verdict === "error")
      .map((o) => o.mutant.mutantId)
      .sort();
    expect(inStore.length).toBeGreaterThan(40);
    expect(inStore[0]).toBe("M0017"); // the onset mutant is INSIDE the window
    expect(inStore.at(-1)).toBe("M0067"); // the mutant whose 2nd row completed the 3rd block
    expect(inFold).toEqual(inStore);
    // before the onset nothing is dropped, in either place
    const kept = (
      store.db
        .query(
          "SELECT mutant_code AS c FROM mutants WHERE run_id = ? AND verdict = 'survived' ORDER BY id",
        )
        .all(runId) as Array<{ c: string }>
    ).map((r) => r.c);
    expect(kept).toHaveLength(16);
    expect(kept.at(-1)).toBe("M0016");
    // the dropped rows carry the slowdown note
    expect(folded.outcomes.find((o) => o.mutant.mutantId === "M0017")?.failureNote).toBe(
      tierSlowdownNote([6, 6, 6]),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Test 4: the reference.
// ---------------------------------------------------------------------------------------------

describe("PR-466 test 4: the reference", () => {
  /** A prior run (baseline own 100 ms) and a resume of it (baseline own `ownBaseline`). */
  function resumePair(opts: { ownBaseline: number; priorHash?: string; ownHash?: string }) {
    const store = new ResultsStore(":memory:");
    const prior = newRun(store, { testAppHash: opts.priorHash ?? "package:t" });
    baselineRow(store, prior, "T1", 100);
    const own = newRun(store, { testAppHash: opts.ownHash ?? "package:t" });
    baselineRow(store, own, "T1", opts.ownBaseline);
    return { store, prior, own };
  }
  const feedRows = (ref: ReturnType<typeof storeReference>, ownMs: number, rows = 150) => {
    const stops: TierSlowdownStop[] = [];
    const mon = new TierSlowdownMonitor({
      reference: ref,
      scoredSeq: () => 1,
      snapshotId: () => 0,
      onStop: (s) => stops.push(s),
    });
    for (let i = 0; i < rows; i++) {
      mon.feed({ codeunitId: T_REF.codeunitId, method: "T1", batchIndex: 0, ownMs }, i + 1);
    }
    return stops;
  };

  test("a resume with a slow own baseline stops against the prior's faster one", () => {
    const { store, prior, own } = resumePair({ ownBaseline: 400 });
    // 450 ms is 1.1x the own baseline (no stop) and 4.5x the prior's
    expect(feedRows(storeReference(store, own, undefined), 450)).toHaveLength(0);
    expect(feedRows(storeReference(store, own, prior), 450)).toHaveLength(1);
  });

  test("the SMALLER of the two is the reference, not the larger", () => {
    const { store, prior, own } = resumePair({ ownBaseline: 60 }); // own faster than the prior's 100
    expect(storeReference(store, own, prior)(T_REF.codeunitId, "t1", 0)).toBe(60);
    const slow = resumePair({ ownBaseline: 400 });
    expect(storeReference(slow.store, slow.own, slow.prior)(T_REF.codeunitId, "T1", 0)).toBe(100);
  });

  test("a prior run with a different test-app hash is ignored", () => {
    const { store, prior, own } = resumePair({ ownBaseline: 400, priorHash: "package:other" });
    expect(storeReference(store, own, prior)(T_REF.codeunitId, "T1", 0)).toBe(400);
    expect(feedRows(storeReference(store, own, prior), 450)).toHaveLength(0);
  });

  test("a run whose test-app hash is unknown (null) uses no prior either", () => {
    const store = new ResultsStore(":memory:");
    const prior = newRun(store);
    baselineRow(store, prior, "T1", 100);
    const own = newRun(store);
    baselineRow(store, own, "T1", 400);
    expect(storeReference(store, own, prior)(T_REF.codeunitId, "T1", 0)).toBe(400);
  });

  test("the prior's baseline rows recorded inside its own degraded window are left out", () => {
    const { store, prior, own } = resumePair({ ownBaseline: 400 });
    // the prior: a mutant row with a test row, then the window opens just before it, then a baseline row (a snapshot
    // inside the window) at 20 ms
    const mutantId = store.recordMutant(prior, {
      mutantCode: "M1",
      astHash: "h",
      codeunitName: "C",
      procedureName: "P",
      operatorName: "o",
      operatorMajor: 1,
      file: "f",
      line: 1,
      verdict: "survived",
      durationMs: 1,
      batchIndex: 0,
    });
    store.recordTestResult(
      prior,
      mutantId,
      "M1",
      T_REF,
      "pass",
      1,
      undefined,
      undefined,
      undefined,
      500,
    );
    store.markDegradedWindow(prior, mutantId - 1, 0, `${TIER_SLOWDOWN_REASON_PREFIX} x`);
    baselineRow(store, prior, "T1", 20);
    // with the in-window 20 ms row the prior's median would be 60
    expect(storeReference(store, own, prior)(T_REF.codeunitId, "T1", 0)).toBe(100);
  });

  test("the reference is the median of several baseline rows", () => {
    const store = new ResultsStore(":memory:");
    const run = newRun(store);
    for (const ms of [100, 900, 120]) baselineRow(store, run, "T1", ms);
    expect(storeReference(store, run, undefined)(T_REF.codeunitId, "T1", 0)).toBe(120);
  });
});

// ---------------------------------------------------------------------------------------------
// Test 5: rows that never feed.
// ---------------------------------------------------------------------------------------------

describe("PR-466 test 5: non-feeding rows", () => {
  const row = (over: Partial<Parameters<typeof feedTierSlowdown>[1]> = {}) => ({
    mutantCode: "M0001",
    outcome: "pass",
    ownDurationMs: 100,
    ref: T_REF,
    ...over,
  });

  test("failed rows, rows without a mutant code, and rows without an own time never move a block", () => {
    const r = monitorRig();
    feedTierSlowdown(r.mon, row({ outcome: "fail" }), 0, 1);
    feedTierSlowdown(r.mon, row({ outcome: "timeout" }), 0, 1);
    feedTierSlowdown(r.mon, row({ outcome: "skip" }), 0, 1);
    feedTierSlowdown(r.mon, row({ mutantCode: null }), 0, 1); // an unmutated confirmation row
    const noOwn = { mutantCode: "M0001", outcome: "pass", ref: T_REF };
    feedTierSlowdown(r.mon, noOwn, 0, 1);
    expect(r.mon.fed).toBe(0);
    feedTierSlowdown(r.mon, row(), 0, 1);
    expect(r.mon.fed).toBe(1);
    // and no monitor at all is no error (an al-runner session, a probe)
    feedTierSlowdown(undefined, row(), 0, 1);
  });

  test("a missing reference and a reference under 50 ms are skipped and counted apart", () => {
    const r = monitorRig((cu) => (cu === 1 ? undefined : cu === 2 ? 49 : 50));
    r.mon.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: 9999 }, 1);
    r.mon.feed({ codeunitId: 2, method: "T", batchIndex: 0, ownMs: 9999 }, 2);
    r.mon.feed({ codeunitId: 3, method: "T", batchIndex: 0, ownMs: 9999 }, 3);
    expect([r.mon.skippedNoReference, r.mon.skippedUnderMin, r.mon.fed]).toEqual([1, 1, 1]);
  });

  test("the probes of runNamedMutants are given no monitor", () => {
    // A source-shape guard: runNamedMutants' scope and its runMutantsOnBackend call never name the monitor, and a
    // BatchScope without one reaches runMutantsOnBackend without one (the spread is `scope.slowdown`, absent there).
    const src = readFileSync(join(import.meta.dir, "../src/orchestrator.ts"), "utf8");
    const from = src.indexOf("async function runNamedMutantsBody(");
    const to = src.indexOf("\nasync function ", from + 10);
    expect(from).toBeGreaterThan(0);
    const body = src.slice(from, to > from ? to : undefined);
    expect(body).not.toContain("slowdown");
    expect(body).not.toContain("TierSlowdown");
  });
});

// ---------------------------------------------------------------------------------------------
// Tests 6, 7, r2a-4: the store, the lease session and the teardown.
// ---------------------------------------------------------------------------------------------

const realMono = clock.mono;
afterEach(() => {
  clock.mono = realMono;
});

function addRow(store: ResultsStore, runId: number, code: string): number {
  return store.recordMutant(runId, {
    mutantCode: code,
    astHash: `h-${code}`,
    codeunitName: "Sandbox Logic",
    procedureName: "Post",
    operatorName: "lethal.negate-conditional",
    operatorMajor: 1,
    file: "src/SandboxLogic.Codeunit.al",
    line: 1,
    verdict: "survived",
    durationMs: 1,
    batchIndex: 0,
  });
}

const verdictsOf = (store: ResultsStore, runId: number): string[] =>
  (
    store.db
      .query("SELECT verdict AS v FROM mutants WHERE run_id = ? ORDER BY id")
      .all(runId) as Array<{ v: string }>
  ).map((r) => r.v);

const stopAt = (
  afterMutantId: number,
  afterSeq: number,
  afterSnapshotId = 0,
): TierSlowdownStop => ({
  medians: [5, 6, 7],
  afterMutantId,
  afterSeq,
  afterSnapshotId,
});

/** A lease session whose renews all fail, on a stepped monotonic clock: 3 ticks stop it (blip, unanswered, stop). */
function renewRig(
  store: ResultsStore,
  runId: number,
  slowdown: () => TierSlowdownStop | undefined,
) {
  let mono = 1_000_000;
  clock.mono = () => mono;
  const events: RunEventInput[] = [];
  let seq = 0;
  const client = {
    renew: async () => {
      mono += 30_000;
      throw new Error("503");
    },
  } as unknown as LeaseApi;
  let tickFn: (() => unknown) | undefined;
  const session = new LeaseSession({
    client,
    lease: {
      epoch: 1,
      token: "t",
      serverGeneration: "g",
      lastCompletedOpSeq: 0,
      expiresAt: "2026-11-26T12:00:00.000Z",
    },
    safety: new SessionSafety(),
    ttlSeconds: 15,
    timers: {
      setInterval: (fn) => {
        tickFn = fn;
        return 1;
      },
      clearInterval: () => {},
    },
    sleep: async () => {},
    quarantineStore: new QuarantineStore(scratch("pr466-quarantine-")),
    resourceKey: "tier",
    nowIso: () => "2026-11-26T10:00:00.000Z",
    runId,
    emit: (e) => events.push(e),
    onLost: () => {},
    windowMark: () => ({ ...store.windowMark(runId), scoredSeq: seq }),
    onDegraded: renewWindowWriter({
      store,
      runId,
      emit: (e) => events.push(e),
      slowdownWindow: slowdown,
    }),
  });
  session.start();
  return {
    session,
    events,
    tick: async () => {
      await tickFn?.();
    },
    setSeq: (n: number) => {
      seq = n;
    },
  };
}

describe("PR-466 test 6 (B1): the earlier window wins, in either order", () => {
  const sloNote = tierSlowdownNote([5, 6, 7]);
  const scoredEvents = (n: number): RunEventInput[] =>
    Array.from({ length: n }, (_, i) => ({
      type: "mutant-scored" as const,
      mutant: manifestEntry(i + 1),
      verdict: "survived" as const,
      batchIndex: 0,
      durationMs: 1,
      coveringTests: [],
    }));

  test("a renew tick fails (mark M0), then the slowdown stops later (O > M0), then the renew stop fires: both places drop from M0", () => {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    for (let i = 1; i <= 3; i++) addRow(store, runId, `M${i}`);
    return (async () => {
      const held: { slow?: TierSlowdownStop } = {};
      const r = renewRig(store, runId, () => held.slow);
      r.setSeq(3);
      await r.tick(); // the first failed tick: the mark M0 = 3 (rows 1-3 are before it)
      for (let i = 4; i <= 6; i++) addRow(store, runId, `M${i}`);
      const slow = stopAt(5, 5); // the onset: rows after 5
      held.slow = slow;
      const timeBudget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
      const out: RunEventInput[] = [];
      onTierSlowdownStop(
        {
          store,
          runId,
          timeBudget,
          emit: (e) => out.push(e),
          renewWindow: () => r.session.degradedWindow,
        },
        slow,
      );
      expect(verdictsOf(store, runId)).toEqual([
        "survived",
        "survived",
        "survived",
        "survived",
        "survived",
        "error",
      ]);
      await r.tick();
      await r.tick(); // the renew stop
      expect(verdictsOf(store, runId)).toEqual([
        "survived",
        "survived",
        "survived",
        "error",
        "error",
        "error",
      ]);
      expect(store.degradedWindowOf(runId)?.afterMutantId).toBe(3);
      const stop = r.events.find(
        (e) => e.type === "warning" && e.code === "lease-renew-unanswered-stop",
      );
      expect(stop?.type === "warning" ? stop.message : "").toContain("after row 3 (after event 3)");
      expect(stop?.type === "warning" ? stop.message : "").not.toContain("EARLIER");
      // the fold: the two window events in either order, the smaller afterSeq
      for (const order of [
        [5, 3],
        [3, 5],
      ]) {
        const events = [
          ...HEAD_EVENTS,
          ...scoredEvents(6),
          ...order.map((s) => ({
            type: "degraded-window" as const,
            afterSeq: s + 2, // seq of M_s: the head has 2 events
            reason: s === 3 ? "lease-renew-unanswered: renew" : sloNote,
          })),
          { type: "session-finished" as const, elapsedMs: 1 },
        ].map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
        const f = foldEvents(STATICS, events);
        expect(
          f.outcomes.filter((o) => o.verdict === "error").map((o) => o.mutant.mutantId),
        ).toEqual(["M0004", "M0005", "M0006"]);
      }
    })();
  });

  test("the reverse order: the slowdown window first (earlier), the renew stop later: both drop from the earlier, and the renew warning says so", async () => {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    for (let i = 1; i <= 3; i++) addRow(store, runId, `M${i}`);
    const slow = stopAt(1, 41); // rows after 1
    const r = renewRig(store, runId, () => slow);
    const timeBudget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
    onTierSlowdownStop({ store, runId, timeBudget, emit: () => {} }, slow);
    for (let i = 4; i <= 6; i++) addRow(store, runId, `M${i}`);
    r.setSeq(9);
    await r.tick(); // the renew mark is M0 = 6 (later than the slowdown)
    await r.tick();
    await r.tick();
    expect(verdictsOf(store, runId)).toEqual([
      "survived",
      "error",
      "error",
      "error",
      "error",
      "error",
    ]);
    expect(store.degradedWindowOf(runId)?.afterMutantId).toBe(1);
    const stop = r.events.find(
      (e) => e.type === "warning" && e.code === "lease-renew-unanswered-stop",
    );
    const text = stop?.type === "warning" ? stop.message : "";
    expect(text).toContain("after row 1 (after event 41)"); // the STORED window, not the renew's own (row 6)
    expect(text).toContain("EARLIER");
  });
});

describe("PR-466 r2a-4: markDegradedWindow keeps the earlier window per column", () => {
  test("mutant id and snapshot id each keep their smaller value, independently", () => {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    for (let i = 1; i <= 4; i++) addRow(store, runId, `M${i}`);
    store.markDegradedWindow(runId, 2, 9, "lease-renew-unanswered: a"); // earlier row, later snapshot
    const w = store.markDegradedWindow(runId, 3, 5, `${TIER_SLOWDOWN_REASON_PREFIX} b`); // later row, earlier snapshot
    expect(w).toEqual({ afterMutantId: 2, afterSnapshotId: 5, note: "lease-renew-unanswered: a" });
    expect(store.degradedWindowOf(runId)).toEqual(w);
    // the note goes with the smaller mutant id
    const w2 = store.markDegradedWindow(runId, 1, 7, `${TIER_SLOWDOWN_REASON_PREFIX} c`);
    expect(w2).toEqual({
      afterMutantId: 1,
      afterSnapshotId: 5,
      note: `${TIER_SLOWDOWN_REASON_PREFIX} c`,
    });
  });

  test("the tie: renew (M0, S0) against slowdown (M0, S0+1), the slowdown written first: the stored window is (M0, S0) with the renew note", () => {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    addRow(store, runId, "M1");
    store.markDegradedWindow(runId, 4, 11, `${TIER_SLOWDOWN_REASON_PREFIX} slow`);
    const w = store.markDegradedWindow(runId, 4, 10, "lease-renew-unanswered: renew");
    expect(w).toEqual({
      afterMutantId: 4,
      afterSnapshotId: 10,
      note: "lease-renew-unanswered: renew",
    });
    // and the other order gives the same window
    const other = new ResultsStore(":memory:");
    const run2 = newRun(other);
    other.markDegradedWindow(run2, 4, 10, "lease-renew-unanswered: renew");
    expect(other.markDegradedWindow(run2, 4, 11, `${TIER_SLOWDOWN_REASON_PREFIX} slow`)).toEqual(w);
  });

  test("the fold picks the same note on an equal afterSeq", () => {
    const mk = (reasons: string[]) =>
      foldEvents(
        STATICS,
        [
          ...HEAD_EVENTS,
          {
            type: "mutant-scored" as const,
            mutant: manifestEntry(1),
            verdict: "survived" as const,
            batchIndex: 0,
            durationMs: 1,
            coveringTests: [],
          },
          ...reasons.map((reason) => ({ type: "degraded-window" as const, afterSeq: 2, reason })),
          { type: "session-finished" as const, elapsedMs: 1 },
        ].map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent),
      ).outcomes[0]?.failureNote;
    expect(mk([`${TIER_SLOWDOWN_REASON_PREFIX} s`, "lease-renew-unanswered: r"])).toBe(
      "lease-renew-unanswered: r",
    );
    expect(mk(["lease-renew-unanswered: r", `${TIER_SLOWDOWN_REASON_PREFIX} s`])).toBe(
      "lease-renew-unanswered: r",
    );
  });
});

/** A store with one early row, then 150 passing rows at 6x fed through a real monitor: its stop has fired and been written. */
function firedMonitor() {
  const store = new ResultsStore(":memory:");
  const runId = newRun(store);
  addRow(store, runId, "M1");
  let seq = 0;
  const timeBudget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
  const monitor = new TierSlowdownMonitor({
    reference: () => 100,
    scoredSeq: () => seq,
    snapshotId: () => 0,
    onStop: (s) => onTierSlowdownStop({ store, runId, timeBudget, emit: () => {} }, s),
  });
  for (let i = 0; i < 150; i++) {
    const id = addRow(store, runId, `R${i}`);
    seq = id;
    monitor.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: 600 }, id);
  }
  expect(monitor.stop?.afterMutantId).toBe(1);
  return { store, runId, monitor, timeBudget };
}

describe("PR-466 test 7: the teardown writes the slowdown window again", () => {
  test("a row an in-flight worker records after the stop reads error in the raw mutants table", () => {
    const { store, runId, monitor } = firedMonitor();
    const late = addRow(store, runId, "LATE"); // recorded by a worker still in flight after the stop
    expect(verdictsOf(store, runId).at(-1)).toBe("survived");
    // without the monitor the teardown writes nothing (no renew window either)
    correctStoreAtEnd(store, runId, undefined, new SessionSafety(), () => {}, undefined, undefined);
    expect(verdictsOf(store, runId).at(-1)).toBe("survived");
    correctStoreAtEnd(
      store,
      runId,
      undefined,
      new SessionSafety(),
      () => {},
      undefined,
      undefined,
      monitor,
    );
    expect(verdictsOf(store, runId).at(-1)).toBe("error");
    expect(verdictsOf(store, runId)[0]).toBe("survived"); // M1, before the onset
    expect(late).toBeGreaterThan(150);
  });

  test("a failing second write is a DegradedWindowNotStoredError that names the run and the note", () => {
    const { store, runId, monitor } = firedMonitor();
    store.markDegradedWindow = () => {
      throw new Error("disk full");
    };
    let err: unknown;
    try {
      invalidateDegradedWindow(store, runId, undefined, () => {}, undefined, undefined, monitor);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain(`run ${runId}`);
    expect((err as Error).message).toContain("do not --resume");
    expect((err as Error).message).toContain(TIER_SLOWDOWN_REASON_PREFIX);
  });
});

describe("PR-466 r2a-3: the clock cut", () => {
  const fresh = () => new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
  test("a slowdown stop spends the budget for every scheduler but does not cut a walk in flight", () => {
    const b = fresh();
    expect(budgetCutsWalk(b)).toBe(false); // nothing spent
    b.stopForTierSlowdown(stopAt(0, 1));
    expect(b.exhausted).toBe(true);
    expect(budgetCutsWalk(b)).toBe(false);
  });
  test("a real signal after it still cuts the walk", () => {
    const b = fresh();
    b.stopForTierSlowdown(stopAt(0, 1));
    b.stop();
    expect(budgetCutsWalk(b)).toBe(true);
  });
  test("an ordinary spent budget cuts, as before", () => {
    const b = new TimeBudget(1, 0, () => 5000);
    expect(budgetCutsWalk(b)).toBe(true);
    expect(budgetCutsWalk(undefined)).toBe(false);
  });
});

describe("PR-466 test 8 (unit): the stop spends the budget and is not a signal or a quarantine", () => {
  test("stopForTierSlowdown exhausts the budget, is not signalled and latches nothing; a later quarantine keeps its own reason", () => {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    const budget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
    const safety = new SessionSafety();
    const out: RunEventInput[] = [];
    expect(budget.exhausted).toBe(false);
    onTierSlowdownStop(
      { store, runId, timeBudget: budget, emit: (e) => out.push(e) },
      stopAt(0, 1),
    );
    expect(budget.exhausted).toBe(true);
    expect(budget.remainingMs()).toBe(0);
    expect(budget.signalled).toBe(false);
    expect(safety.isUnsafe).toBe(false);
    expect(out.some((e) => e.type === "quarantined")).toBe(false);
    safety.latchUnsafe("in-flight-unknown: a mutant call has no answer");
    expect(safety.reason).toBe("in-flight-unknown: a mutant call has no answer");
  });
});

// ---------------------------------------------------------------------------------------------
// The texts.
// ---------------------------------------------------------------------------------------------

describe("PR-466 test 9: the texts", () => {
  test("the warning names the ratios, the window and FIRST CUT, and gives no restart instruction", () => {
    const text = tierSlowdownWarning(
      { medians: [4.9, 7.1, 4.5], afterMutantId: 12, afterSeq: 40, afterSnapshotId: 0 },
      { afterMutantId: 12, afterSeq: 40 },
    );
    expect(text).toContain("tier-slowdown-stop");
    expect(text).toContain("4.9×, 7.1× and 4.5×");
    expect(text).toContain("last 150 passing rows");
    expect(text).toContain("FIRST CUT");
    expect(text).toContain("after row 12 (events after 40)");
    expect(text).toContain("Whether the tier needs a restart is not measured");
    expect(text).not.toMatch(/[Rr]estart the (service )?tier/);
    expect(text).not.toContain("EARLIER");
  });

  test("the warning says when an earlier window stands", () => {
    const text = tierSlowdownWarning(
      { medians: [4, 4, 4], afterMutantId: 20, afterSeq: 90, afterSnapshotId: 0 },
      { afterMutantId: 7, afterSeq: 30 },
    );
    expect(text).toContain("after row 7 (events after 30)");
    expect(text).toContain("EARLIER");
  });

  test("the arming line: not armed under 150 fed rows, armed from 150, skips counted by reason", () => {
    const r = monitorRig((cu) => (cu === 1 ? undefined : cu === 2 ? 10 : 100));
    r.mon.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: 1 }, 1);
    r.mon.feed({ codeunitId: 2, method: "T", batchIndex: 0, ownMs: 1 }, 2);
    r.mon.feed({ codeunitId: 3, method: "T", batchIndex: 0, ownMs: 1 }, 3);
    expect(r.mon.armingLine()).toBe(
      "[lethal] tier-slowdown monitor: fed 1 passing rows, skipped 2 (no reference 1, under 50 ms 1); not armed (< 150 fed)",
    );
    for (let i = 0; i < 149; i++)
      r.mon.feed({ codeunitId: 3, method: "T", batchIndex: 0, ownMs: 1 }, 10 + i);
    expect(r.mon.armingLine()).toContain("fed 150 passing rows");
    expect(r.mon.armingLine()).toContain("; armed");
    expect(r.mon.armingLine()).not.toContain("not armed");
  });
});

// ---------------------------------------------------------------------------------------------
// The whole session, sequential bcdev (the one kind that builds the monitor).
// ---------------------------------------------------------------------------------------------

const PROCS = 60;
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
${Array.from(
  { length: PROCS },
  (_, i) => `    procedure Cmp${i}(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
`,
).join("\n")}}
`;
const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure T1()
    begin
    end;

    [Test]
    procedure T2()
    begin
    end;

    [Test]
    procedure T3()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "22222222-2222-2222-2222-222222222222",
  name: "Slowdown Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const selectorIds: SelectorConfig = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject() {
  const root = scratch("lethal-pr466-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

/**
 * A bcdev-shaped fake: every test passes. A baseline call (no mutant active) answers 100 ms of own time; a mutant call
 * answers `ownMs(n, k)` for the n-th activated mutant's k-th call (undefined: no own time at all).
 */
function slowBackend(
  ownMs: (mutant: number, call: number) => number | undefined,
  kind: "bcdev" | "al-runner-v3" = "bcdev",
) {
  let active: string | null = null;
  let mutants = 0;
  let calls = 0;
  const caps: BackendCapabilities =
    kind === "bcdev"
      ? {
          coverage: "none",
          deploy: "publish",
          isolation: "session",
          kind: "bcdev",
          authoritative: true,
        }
      : {
          coverage: "none",
          deploy: "none",
          isolation: "session",
          kind: "al-runner-v3",
          authoritative: false,
        };
  const backend: ExecutionBackend = {
    capabilities: () => caps,
    status: async (): Promise<BackendStatus> => ({ ok: true, details: "fake" }),
    deploy: async () => null,
    compileCheck: async () => {},
    activate: async (id) => {
      active = id ?? null;
      if (active !== null) {
        mutants += 1;
        calls = 0;
      }
    },
    run: async (ref, opts): Promise<TestVerdict> => {
      calls += 1;
      const own = active === null ? 100 : ownMs(mutants, calls);
      return {
        ref,
        outcome: "pass",
        durationMs: 1,
        ...(own !== undefined ? { measuredDurationMs: own } : {}),
        ...(opts.coverage === "none"
          ? { attestation: { observedAny: true, identityMismatch: false } }
          : {}),
      };
    },
  };
  // the served test app, installed at its own version: the run's test-app identity is proven, so --resume may carry
  return Object.assign(backend, servesTestApp(), {
    runnerBuild: async () => ({ version: "alrunner 3.0.0", binarySha256: "b".repeat(64) }),
  });
}

async function session(
  backend: ExecutionBackend,
  over: Partial<SessionConfig> = {},
  store = new ResultsStore(":memory:"),
  dirs?: Awaited<ReturnType<typeof makeProject>>,
) {
  const project = dirs ?? (await makeProject());
  const events: RunEvent[] = [];
  const lines: string[] = [];
  const report = await runSession({
    backend,
    store,
    ...project,
    selectorIds,
    resourceServer: "http://cronus281",
    resourceServerInstance: "BC",
    quarantineDir: scratch("pr466-q-"),
    emit: [(e) => events.push(e)],
    tierSlowdownLine: (l) => lines.push(l),
    ...over,
  });
  return { report, events, lines, store, dirs: project };
}

const warningsOf = (events: readonly RunEvent[], code: string): string[] =>
  events.flatMap((e) => (e.type === "warning" && e.code === code ? [e.message] : []));

describe("PR-466: a whole bcdev session", () => {
  test("a healthy run builds a monitor, never stops, and prints the arming line once", async () => {
    const { report, events, lines } = await session(slowBackend(() => 100));
    expect(report.timeBudget).toBeUndefined();
    expect(warningsOf(events, "tier-slowdown-stop")).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[lethal\] tier-slowdown monitor: fed \d+ passing rows, skipped 0 \(no reference 0, under 50 ms 0\); (armed|not armed)/,
    );
    expect(report.mutants.length).toBeGreaterThanOrEqual(60);
  });

  test("a sustained slowdown stops the run: a spent budget, the window as error, never finished, resumable, exit 7, no TIME BUDGET text", async () => {
    // from the 18th mutant on, every call runs at 6x its baseline
    const { report, events, store } = await session(slowBackend((n) => (n >= 18 ? 600 : 100)));
    const stop = report.timeBudget?.stoppedByTierSlowdown;
    expect(stop?.medians).toEqual([6, 6, 6]);
    expect(warningsOf(events, "tier-slowdown-stop")).toHaveLength(1);
    expect(events.filter((e) => e.type === "degraded-window")).toHaveLength(1);
    // no quarantine, no signal, a time-budget exit code
    expect(report.quarantined).toBeUndefined();
    expect(events.some((e) => e.type === "quarantined")).toBe(false);
    expect(report.timeBudget?.stoppedBySignal).toBeUndefined();
    expect(exitCodeForReport(report)).toBe(TIME_BUDGET_EXIT_CODE);
    const banner = renderConsole(report);
    expect(banner).toContain("STOPPED BY THE TIER-SLOWDOWN STOP");
    expect(banner).toContain("first cut");
    expect(banner).toMatch(/\d+ row\(s\) in the window/);
    expect(banner).not.toContain("TIME BUDGET");
    expect(banner).not.toContain("--time-budget");
    expect(banner).not.toContain("clear-quarantine");
    expect(banner).not.toContain("force-reset-lease");
    // the progress line says it the same way
    const out: string[] = [];
    const render = createProgressRenderer((l) => out.push(l), { heartbeatMs: 30_000 });
    for (const e of events) render(e);
    const progress = out.filter((l) => l.includes("TIER-SLOWDOWN")).join("\n");
    expect(progress).toContain("STOPPED BY THE TIER-SLOWDOWN STOP");
    expect(progress).not.toContain("TIME BUDGET");
    expect(progress).not.toContain("--time-budget");
    // the run is not finished, and the stored window equals the report's
    const run = store.getRun(1);
    expect(run?.finished).toBe(false);
    const w = store.degradedWindowOf(1);
    expect(w?.afterMutantId).toBe(stop?.afterMutantId);
    const errors = report.mutants.filter((m) => m.verdict === "error");
    expect(errors.length).toBeGreaterThan(30);
    expect(errors.every((m) => m.failureNote?.startsWith(TIER_SLOWDOWN_REASON_PREFIX))).toBe(true);
    // the first mutants (before the onset) keep their verdicts
    expect(report.mutants.filter((m) => m.verdict === "survived").length).toBe(16);
    // more mutants than the stop scheduled were left for the resume
    expect(report.timeBudget?.unscheduledCount ?? 0).toBeGreaterThan(0);
  });

  test("r2a-1: the stop on the FINAL row of the last batch still leaves the run unfinished, resumable, and exits as a time-budget stop", async () => {
    // only the last 50 mutants (3 calls each: 150 rows) carry an own time, all at 6x: the stop is the very last row
    const base = await session(slowBackend(() => 100));
    const total = base.report.mutants.length;
    expect(total).toBeGreaterThan(60);
    const { report, events, store } = await session(
      slowBackend((n) => (n > total - 50 ? 600 : undefined)),
    );
    expect(report.timeBudget?.stoppedByTierSlowdown?.medians).toEqual([6, 6, 6]);
    expect(warningsOf(events, "tier-slowdown-stop")).toHaveLength(1);
    expect(report.timeBudget?.afterMainPass).toBeUndefined(); // never "every mutant was scored, nothing to resume"
    expect(report.timeBudget?.unscheduledCount).toBe(0);
    expect(store.getRun(1)?.finished).toBe(false);
    const row = store.getRun(1);
    expect(
      store.findResumableRun({
        projectPath: row?.projectPath ?? "",
        backend: "bcdev",
        configFingerprint: row?.configFingerprint ?? "",
        carryableVerdicts: [...CARRYABLE_VERDICTS],
      }),
    ).toBe(1);
    expect(exitCodeForReport(report)).toBe(TIME_BUDGET_EXIT_CODE);
    expect(renderConsole(report)).not.toContain("nothing to resume");
    expect(renderConsole(report)).not.toContain("STOPPED BY SIGNAL");
  });

  test("the resume message quotes the stored note, and the resumed run re-runs the window", async () => {
    const first = await session(slowBackend((n) => (n >= 18 ? 600 : 100)));
    const store = first.store;
    const second = await session(
      slowBackend(() => 100),
      { resume: "last" },
      store,
      first.dirs,
    );
    const said = warningsOf(second.events, "resume-degraded-window");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(TIER_SLOWDOWN_REASON_PREFIX);
    expect(said[0]).not.toContain("stopped answering lease renews");
    expect(second.report.timeBudget).toBeUndefined();
    expect(second.report.mutants.filter((m) => m.verdict === "error")).toHaveLength(0);
  });

  test("NIT 5: a resume whose every scored row lands in a prior window exits as nothing scored", async () => {
    // the slowdown starts at the first mutant: the window is every row the report has
    const { report } = await session(slowBackend(() => 600));
    expect(report.timeBudget?.stoppedByTierSlowdown).toBeDefined();
    expect(report.mutants.length).toBeGreaterThan(0);
    expect(report.mutants.every((m) => m.verdict === "error")).toBe(true);
    expect(report.validity.caveats).toContain("all-errors");
    expect(exitCodeForReport(report)).toBe(4); // NOTHING_SCORED_EXIT_CODE, ahead of the time-budget code
    const banner = renderConsole(report);
    expect(banner).toContain("NOTHING SCORED");
    expect(banner).not.toContain("TIME BUDGET");
  });

  test("an al-runner session constructs no monitor: no arming line, no stop", async () => {
    const { lines, report } = await session(slowBackend(() => 100, "al-runner-v3")).catch(
      (e: unknown) => {
        throw e;
      },
    );
    expect(lines).toEqual([]);
    expect(report.timeBudget).toBeUndefined();
  });
});
