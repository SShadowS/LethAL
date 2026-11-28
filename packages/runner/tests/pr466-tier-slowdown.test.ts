// PR-466 part 2 (R1228): the tier-slowdown monitor. Spec: docs/superpowers/specs/2026-11-27-pr466-tier-slowdown-stop.md
// (r2, r2a, r3 and r5: a sliding 60-minute median, SHADOW by default, `--tier-slowdown-stop` opt-in).
// Stateful fakes and call counters only: every clock here is an injected one, never the wall clock; no /coord.
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
import {
  TIME_BUDGET_EXIT_CODE,
  exitCodeForReport,
  parseCliConfig,
  runFromCliWithAccept,
} from "../src/cli";
import { clock } from "../src/clock";
import type { RunEvent, RunEventInput } from "../src/events";
import { createEmitter } from "../src/events";
import type { LeaseApi } from "../src/lease";
import { TimeBudget } from "../src/mutant-windows";
import {
  LeaseSession,
  TierSlowdownFlagBackendError,
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
import type { SessionOutcome } from "../src/report";
import { foldEvents } from "../src/report-fold";
import type { FoldStatics } from "../src/report-fold";
import { CARRYABLE_VERDICTS, sessionFingerprint } from "../src/resume";
import { SessionSafety } from "../src/session-safety";
import { ResultsStore } from "../src/store";
import {
  TIER_SLOWDOWN_CHECK_EVERY,
  TIER_SLOWDOWN_MAX_PSI,
  TIER_SLOWDOWN_MIN_REF_MS,
  TIER_SLOWDOWN_MIN_ROWS,
  TIER_SLOWDOWN_REASON_PREFIX,
  TIER_SLOWDOWN_STOP,
  TIER_SLOWDOWN_WINDOW_MS,
  TierSlowdownMonitor,
  type TierSlowdownStop,
  parsePsiCpuAvg60,
  readLoad1,
  readPsiCpuAvg60,
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

const MIN = 60_000;

// ---------------------------------------------------------------------------------------------
// The monitor alone: a stateful fake feeds it rows on an injected clock.
// ---------------------------------------------------------------------------------------------

/** Reference 100 ms for every test, so a row's ratio is its own ms / 100. */
function monitorRig(
  opts: {
    reference?: (cu: number, m: string, b: number) => number | undefined;
    stopMode?: boolean;
  } = {},
) {
  const triggers: TierSlowdownStop[] = [];
  const state = {
    seq: 0,
    snapshot: 7,
    t: 0,
    psi: 5 as number | null,
    load1: 1.5 as number | null,
    fedCalls: 0,
  };
  const mon = new TierSlowdownMonitor({
    reference: opts.reference ?? (() => 100),
    scoredSeq: () => state.seq,
    snapshotId: () => state.snapshot,
    now: () => state.t,
    psi: () => state.psi,
    load1: () => state.load1,
    stopMode: opts.stopMode ?? true,
    onTrigger: (s) => triggers.push(s),
  });
  /**
   * `n` rows at `ratio`, one every `stepMs` on the injected clock (the row is fed, THEN the clock moves, so row i of a
   * call is at `t0 + i * stepMs`). Row ids run from `firstId`; the scored seq is ten times the id; the snapshot id is
   * 7 + the row's index in the whole feed, so a mark taken at another moment reads another number.
   */
  const rows = (n: number, ratio: number, firstId: number, stepMs = MIN) => {
    for (let i = 0; i < n; i++) {
      state.seq = (firstId + i) * 10;
      state.snapshot = 7 + state.fedCalls;
      state.fedCalls += 1;
      mon.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: ratio * 100 }, firstId + i);
      state.t += stepMs;
    }
  };
  return { mon, triggers, state, rows };
}

describe("PR-466 r5 constants", () => {
  test("the values are exported", () => {
    expect([
      TIER_SLOWDOWN_WINDOW_MS,
      TIER_SLOWDOWN_CHECK_EVERY,
      TIER_SLOWDOWN_MIN_ROWS,
      TIER_SLOWDOWN_STOP,
      TIER_SLOWDOWN_MAX_PSI,
      TIER_SLOWDOWN_MIN_REF_MS,
    ]).toEqual([3_600_000, 50, 50, 2.5, 20, 50]);
  });
});

// Review S2/S3: the row floor at exactly 50, and an EVEN median whose average and middle values fall on different
// sides of 2.5. Rows 1.22 min apart leave 50 rows in the 60-min window at the row-100 check; 1.24 min leaves 49.
describe("PR-466 r5 rule: |W| = 50 exactly, and the median of an even |W|", () => {
  const STEP50 = 1.22 * MIN;
  const STEP49 = 1.24 * MIN;
  // Red: `w.length <= MIN_ROWS` (50 rows no longer trigger).
  test("|W| = 50 triggers, with rows = 50", () => {
    const r = monitorRig();
    r.rows(100, 6, 1, STEP50);
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]?.rows).toBe(50);
  });
  // Red: the row floor removed (49 rows trigger).
  test("|W| = 49 does not trigger", () => {
    const r = monitorRig();
    r.rows(100, 6, 1, STEP49);
    expect(r.triggers).toHaveLength(0);
  });
  // W at the row-100 check = rows 51-100: 25 at the first ratio, 25 at the second.
  const evenMedian = (low: number, high: number) => {
    const r = monitorRig();
    r.rows(75, low, 1, STEP50);
    r.rows(25, high, 76, STEP50);
    return r;
  };
  // Red: the upper middle value instead of the average (2.6 >= 2.5 triggers).
  test("25 rows at 2.3 and 25 at 2.6: the median is 2.45, no trigger", () => {
    const r = evenMedian(2.3, 2.6);
    expect(r.triggers).toHaveLength(0);
    expect(r.mon.highestMedian).toBeCloseTo(2.45, 10);
  });
  // Red: the lower middle value instead of the average (2.4 < 2.5 does not trigger).
  test("25 rows at 2.4 and 25 at 2.7: the median is 2.55, a trigger", () => {
    const r = evenMedian(2.4, 2.7);
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]?.median).toBeCloseTo(2.55, 10);
  });
});

describe("PR-466 r5 rule: the trigger", () => {
  test("a trigger needs the 100th row here: not at row 99, and the figures and the onset mark are the window's", () => {
    const r = monitorRig();
    r.rows(99, 6, 1000);
    expect(r.triggers).toHaveLength(0); // a check runs only after every 50th fed row
    r.rows(1, 6, 1099);
    expect(r.triggers).toHaveLength(1);
    const [s] = r.triggers;
    // row i is at i minutes; the 100th row is at 99 min; W = the rows at or after 39 min = rows 39..99 = 61 rows
    expect(s?.rows).toBe(61);
    expect(s?.median).toBe(6);
    expect(s?.spanMs).toBe(60 * MIN);
    expect(s?.atMs).toBe(99 * MIN);
    expect(s?.psi).toBe(5);
    expect(s?.load1).toBe(1.5);
    // the onset is W's FIRST row (id 1039): the mark is its id - 1, its scored seq - 1, the snapshot id when IT was fed
    expect(s?.afterMutantId).toBe(1038);
    expect(s?.afterSeq).toBe(10389);
    expect(s?.afterSnapshotId).toBe(7 + 39);
    expect(r.mon.triggered).toBe(s);
    expect(r.mon.stop).toBe(s); // stop mode
  });

  test("no trigger while the window is not full: the first fed row is under 60 min old", () => {
    const r = monitorRig();
    // 100 rows over 49.5 min: every other condition holds (50+ rows, median 6, PSI 5)
    r.rows(100, 6, 1, 30_000);
    expect(r.triggers).toHaveLength(0);
    // 50 rows later the first row is 74.5 min old: the check at row 150 fires
    r.rows(50, 6, 101, 30_000);
    expect(r.triggers).toHaveLength(1);
  });

  test("no trigger with fewer than 50 rows in W, even with the window full and a median of 6", () => {
    const r = monitorRig();
    r.rows(49, 6, 1, 1000);
    r.state.t += 61 * MIN; // the 50th row comes an hour later: only it is left in W
    r.rows(1, 6, 50, 1000);
    expect(r.mon.checks).toBe(1);
    expect(r.triggers).toHaveLength(0);
  });

  test("the median is compared with >=: 2.5 triggers, 2.49 does not", () => {
    const at = (ratio: number) => {
      const r = monitorRig();
      r.rows(120, ratio, 1);
      return r.triggers.length;
    };
    expect(at(2.49)).toBe(0);
    expect(at(2.5)).toBe(1);
  });

  test("the median decides, not the mean or the max: 30 rows at 20x and 31 at 1x in W is a median of 1", () => {
    const low = monitorRig();
    low.rows(39, 1, 1);
    low.rows(30, 20, 40);
    low.rows(31, 1, 70);
    expect(low.triggers).toHaveLength(0);
    // the other side: 31 rows at 20x and 30 at 1x
    const high = monitorRig();
    high.rows(39, 1, 1);
    high.rows(31, 20, 40);
    high.rows(30, 1, 71);
    expect(high.triggers).toHaveLength(1);
    expect(high.triggers[0]?.median).toBe(20);
  });

  test("PSI 20 or more never triggers (19.9 does); an unreadable PSI (null) never triggers and is counted", () => {
    const at = (psi: number | null) => {
      const r = monitorRig();
      r.state.psi = psi;
      r.rows(120, 6, 1);
      return r;
    };
    expect(at(20).triggers).toHaveLength(0);
    expect(at(95).triggers).toHaveLength(0);
    expect(at(19.9).triggers).toHaveLength(1);
    const unreadable = at(null);
    expect(unreadable.triggers).toHaveLength(0);
    expect(unreadable.mon.psiUnreadable).toBe(2); // the checks at rows 50 and 100
  });

  test("an unreadable load1 is null in the figures, never 0", () => {
    const r = monitorRig();
    r.state.load1 = null;
    r.rows(120, 6, 1);
    expect(r.triggers[0]?.load1).toBeNull();
  });

  test("it triggers once per session: later checks do nothing, rows are still counted", () => {
    const r = monitorRig();
    r.rows(300, 6, 1);
    expect(r.triggers).toHaveLength(1);
    expect(r.mon.fed).toBe(300);
  });

  test("the onset is the window's first row: a row exactly 60 min old is IN, one a millisecond older is OUT", () => {
    const at = (lastT: number) => {
      const r = monitorRig();
      r.rows(1, 6, 1, 0); // t = 0
      r.state.t = 1000;
      r.rows(98, 6, 2, 0);
      r.state.t = lastT;
      r.rows(1, 6, 100, 0); // the 100th row is the check
      return r.triggers[0];
    };
    // now = 60 min, cutoff = 0: the row at t = 0 is in W, so row id 1 is the onset
    expect(at(3_600_000)?.afterMutantId).toBe(0);
    expect(at(3_600_000)?.rows).toBe(100);
    // now = 60 min + 1 ms, cutoff = 1 ms: the row at t = 0 is OUT, the onset is row id 2
    expect(at(3_600_001)?.afterMutantId).toBe(1);
    expect(at(3_600_001)?.rows).toBe(99);
  });

  test("healthy-like streams never trigger: 2.4 for five hours, and short bursts that never fill a window's median", () => {
    const flat = monitorRig();
    flat.rows(300, 2.4, 1);
    expect(flat.triggers).toHaveLength(0);
    // an 11-row burst at 6x in every 60 rows
    const burst = monitorRig();
    for (let k = 0; k < 6; k++) {
      burst.rows(11, 6, 1 + k * 60);
      burst.rows(49, 1, 12 + k * 60);
    }
    expect(burst.triggers).toHaveLength(0);
  });

  test("the arming line says the mode, the counts, the highest median, the unreadable PSI count and the baseline PSI", () => {
    const r = monitorRig({
      reference: (cu) => (cu === 1 ? 100 : cu === 2 ? undefined : 10),
      stopMode: false,
    });
    r.mon.feed({ codeunitId: 2, method: "T", batchIndex: 0, ownMs: 1 }, 1);
    r.mon.feed({ codeunitId: 3, method: "T", batchIndex: 0, ownMs: 1 }, 2);
    expect(r.mon.armingLine()).toBe(
      "[lethal] tier-slowdown monitor: mode shadow; fed 0 passing rows, skipped 2 (no reference 1, under 50 ms 1); 0 check(s), highest window median none, PSI unreadable 0 time(s), baseline PSI unread; not triggered",
    );
    r.state.psi = 3.5;
    r.mon.noteBaselineEnd();
    r.state.psi = null;
    r.mon.noteBaselineEnd(); // only the first call counts
    r.rows(50, 2, 1);
    expect(r.mon.armingLine()).toBe(
      "[lethal] tier-slowdown monitor: mode shadow; fed 50 passing rows, skipped 2 (no reference 1, under 50 ms 1); 1 check(s), highest window median 2.00×, PSI unreadable 1 time(s), baseline PSI 3.5%; not triggered",
    );
    const s = monitorRig({ stopMode: true });
    s.rows(120, 6, 1);
    expect(s.mon.armingLine()).toContain("mode stop;");
    expect(s.mon.armingLine()).toContain("; TRIGGERED");
    expect(s.mon.armingLine()).toContain("highest window median 6.00×");
  });

  test("shadow mode: the trigger is recorded but `stop` stays undefined", () => {
    const r = monitorRig({ stopMode: false });
    r.rows(120, 6, 1);
    expect(r.triggers).toHaveLength(1);
    expect(r.mon.triggered).toBe(r.triggers[0]);
    expect(r.mon.stop).toBeUndefined();
  });
});

describe("PR-466 r3 host readers: a read error is null, never 0", () => {
  test("/proc/pressure/cpu: some avg60 in percent", () => {
    const text =
      "some avg10=0.00 avg60=12.34 avg300=1.00 total=123456\nfull avg10=0.00 avg60=9.99 avg300=0.00 total=0\n";
    expect(parsePsiCpuAvg60(text)).toBe(12.34);
    expect(parsePsiCpuAvg60("nothing here")).toBeNull();
    expect(parsePsiCpuAvg60("")).toBeNull();
    expect(readPsiCpuAvg60(() => text)).toBe(12.34);
    expect(
      readPsiCpuAvg60(() => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
  test("/proc/loadavg: load1", () => {
    expect(readLoad1(() => "0.52 0.40 0.30 1/200 123\n")).toBe(0.52);
    expect(readLoad1(() => "")).toBeNull();
    expect(readLoad1(() => "abc 1 2")).toBeNull();
    expect(
      readLoad1(() => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The record() path: two workers, the window's first row inside one mutant's rows.
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
  const ROW_STEP_MS = 20_000; // one row every 20 s: a mutant is 60 s

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
    let nowMs = 0;
    const monitor = new TierSlowdownMonitor({
      reference: () => 100,
      scoredSeq: () => lastScoredSeq,
      snapshotId: () => store.windowMark(runId).snapshotId,
      now: () => nowMs,
      psi: () => 4,
      load1: () => 1,
      stopMode: true,
      onTrigger: (s) => onTierSlowdownStop({ store, runId, timeBudget, emit }, s),
    });
    const outcomes: SessionOutcome[] = [];
    let ordinal = 0; // the recording order, across both workers
    let rowNo = 0;
    const SLOW_FROM = 18; // from row 52 on
    const worker = async () => {
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
          rowNo += 1;
          nowMs = rowNo * ROW_STEP_MS;
          feedTierSlowdown(monitor, row, 0, id);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    emit({ type: "session-finished", elapsedMs: 1 });
    return { store, runId, events, outcomes, monitor, timeBudget };
  }

  test("the store's in-window mutants equal the fold's dropped ones, and both start at the onset mutant", async () => {
    const { store, runId, events, monitor, timeBudget } = await twoWorkerRun();
    // The check is at row 200 (the 2nd row of mutant 67, at 66.7 min): the window is full (first row at 20 s). The cutoff
    // is 6.7 min = 400 s = row 20, the 2nd row of mutant 7 (rows 19-21): the onset SPLITS mutant 7's rows.
    expect(monitor.stop?.rows).toBe(181);
    expect(monitor.stop?.median).toBe(6);
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
    expect(inStore[0]).toBe("M0007"); // the onset mutant is INSIDE the window
    expect(inStore.at(-1)).toBe("M0067"); // the mutant whose 2nd row made the check
    expect(inStore).toHaveLength(61);
    expect(inFold).toEqual(inStore);
    // before the onset nothing is dropped, in either place
    const kept = (
      store.db
        .query(
          "SELECT mutant_code AS c FROM mutants WHERE run_id = ? AND verdict = 'survived' ORDER BY id",
        )
        .all(runId) as Array<{ c: string }>
    ).map((r) => r.c);
    expect(kept).toHaveLength(6);
    expect(kept.at(-1)).toBe("M0006");
    // the dropped rows carry the slowdown note
    expect(folded.outcomes.find((o) => o.mutant.mutantId === "M0007")?.failureNote).toBe(
      monitor.stop === undefined ? "" : tierSlowdownNote(monitor.stop),
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
  /** 120 rows a minute apart, so the window is full and a median over the threshold triggers. */
  const feedRows = (ref: ReturnType<typeof storeReference>, ownMs: number, rows = 120) => {
    const triggers: TierSlowdownStop[] = [];
    let t = 0;
    const mon = new TierSlowdownMonitor({
      reference: ref,
      scoredSeq: () => 1,
      snapshotId: () => 0,
      now: () => t,
      psi: () => 1,
      load1: () => 1,
      stopMode: true,
      onTrigger: (s) => triggers.push(s),
    });
    for (let i = 0; i < rows; i++) {
      mon.feed({ codeunitId: T_REF.codeunitId, method: "T1", batchIndex: 0, ownMs }, i + 1);
      t += MIN;
    }
    return triggers;
  };

  test("a resume with a slow own baseline triggers against the prior's faster one", () => {
    const { store, prior, own } = resumePair({ ownBaseline: 400 });
    // 450 ms is 1.1x the own baseline (no trigger) and 4.5x the prior's
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

  test("failed rows, rows without a mutant code, and rows without an own time never feed", () => {
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

  // Review S1. Red: drop the try/catch in feedTierSlowdown (the shadow error escapes), or catch in stop mode too.
  test("SHADOW: an error in the monitor is caught, counted and named on the arming line; STOP mode rethrows it", () => {
    const boom = () => {
      throw new Error("store read failed");
    };
    const shadow = monitorRig({ reference: boom, stopMode: false });
    expect(() => feedTierSlowdown(shadow.mon, row(), 0, 1)).not.toThrow();
    expect(() => feedTierSlowdown(shadow.mon, row(), 0, 2)).not.toThrow();
    expect(shadow.mon.shadowErrors).toBe(2);
    expect(shadow.mon.armingLine()).toContain(
      "2 monitor error(s) caught in shadow mode (first: Error: store read failed)",
    );
    const stop = monitorRig({ reference: boom, stopMode: true });
    expect(() => feedTierSlowdown(stop.mon, row(), 0, 1)).toThrow("store read failed");
    expect(stop.mon.shadowErrors).toBe(0);
    // no error: the arming line names none
    expect(monitorRig({ stopMode: false }).mon.armingLine()).not.toContain("monitor error");
  });

  test("a missing reference and a reference under 50 ms are skipped and counted apart", () => {
    const r = monitorRig({ reference: (cu) => (cu === 1 ? undefined : cu === 2 ? 49 : 50) });
    r.mon.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: 9999 }, 1);
    r.mon.feed({ codeunitId: 2, method: "T", batchIndex: 0, ownMs: 9999 }, 2);
    r.mon.feed({ codeunitId: 3, method: "T", batchIndex: 0, ownMs: 9999 }, 3);
    expect([r.mon.skippedNoReference, r.mon.skippedUnderMin, r.mon.fed]).toEqual([1, 1, 1]);
  });

  test("skipped rows never move a window: 100 skipped rows at 6x trigger nothing", () => {
    const r = monitorRig({ reference: () => 49 });
    r.rows(200, 600, 1);
    expect(r.mon.fed).toBe(0);
    expect(r.triggers).toHaveLength(0);
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

/** A trigger with figures and a window mark after `afterMutantId` / `afterSeq`. */
const stopAt = (
  afterMutantId: number,
  afterSeq: number,
  afterSnapshotId = 0,
): TierSlowdownStop => ({
  median: 5,
  rows: 120,
  spanMs: 3_700_000,
  psi: 4,
  atMs: 3_700_000,
  load1: 1,
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
  const sloNote = tierSlowdownNote(stopAt(0, 0));
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

/**
 * A store with one early row, then 150 passing rows at 6x a minute apart fed through a real monitor in STOP mode: its
 * trigger fires at the 100th row (the onset is the 40th of them, row id 41), and has been written.
 */
function firedMonitor(stopMode = true) {
  const store = new ResultsStore(":memory:");
  const runId = newRun(store);
  addRow(store, runId, "M1");
  let seq = 0;
  let t = 0;
  const timeBudget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
  const monitor = new TierSlowdownMonitor({
    reference: () => 100,
    scoredSeq: () => seq,
    snapshotId: () => 0,
    now: () => t,
    psi: () => 3,
    load1: () => 1,
    stopMode,
    onTrigger: (s) => onTierSlowdownStop({ store, runId, timeBudget, emit: () => {} }, s),
  });
  for (let i = 0; i < 150; i++) {
    const id = addRow(store, runId, `R${i}`);
    seq = id;
    monitor.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: 600 }, id);
    t += MIN;
  }
  return { store, runId, monitor, timeBudget };
}

describe("PR-466 test 7: the teardown writes the slowdown window again", () => {
  test("a row an in-flight worker records after the stop reads error in the raw mutants table", () => {
    const { store, runId, monitor } = firedMonitor();
    expect(monitor.stop?.afterMutantId).toBe(40); // rows 1..40 are before the onset (row id 41)
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
    expect(
      verdictsOf(store, runId)
        .slice(0, 40)
        .every((v) => v === "survived"),
    ).toBe(true);
    expect(verdictsOf(store, runId)[40]).toBe("error"); // the onset row
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

  test("in SHADOW mode the teardown writes nothing: the monitor's `stop` is undefined", () => {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    for (let i = 0; i < 3; i++) addRow(store, runId, `R${i}`);
    let t = 0;
    const monitor = new TierSlowdownMonitor({
      reference: () => 100,
      scoredSeq: () => 1,
      snapshotId: () => 0,
      now: () => t,
      psi: () => 3,
      load1: () => 1,
      stopMode: false,
      onTrigger: () => {},
    });
    for (let i = 0; i < 120; i++) {
      monitor.feed({ codeunitId: 1, method: "T", batchIndex: 0, ownMs: 600 }, 1);
      t += MIN;
    }
    expect(monitor.triggered).toBeDefined();
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
    expect(verdictsOf(store, runId)).toEqual(["survived", "survived", "survived"]);
    expect(store.degradedWindowOf(runId)).toBeNull();
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
  test("the warning names the figures, the window and FIRST CUT, and gives no restart instruction", () => {
    const text = tierSlowdownWarning(
      { median: 4.9, rows: 140, spanMs: 3_600_000, psi: 7.5, afterMutantId: 12 },
      { afterMutantId: 12, afterSeq: 40 },
    );
    expect(text).toContain("tier-slowdown-stop");
    expect(text).toContain("4.9×");
    expect(text).toContain("the median of the last 140 passing rows over 60 min");
    expect(text).toContain("threshold 2.5");
    expect(text).toContain("host CPU pressure 7.5%");
    expect(text).toContain("FIRST CUT");
    expect(text).toContain("after row 12 (events after 40)");
    expect(text).toContain("Whether the tier needs a restart is not measured");
    expect(text).not.toMatch(/[Rr]estart the (service )?tier/);
    expect(text).not.toContain("EARLIER");
  });

  test("the warning says when an earlier window stands", () => {
    const text = tierSlowdownWarning(
      { median: 4, rows: 100, spanMs: 3_600_000, psi: 1, afterMutantId: 20 },
      { afterMutantId: 7, afterSeq: 30 },
    );
    expect(text).toContain("after row 7 (events after 30)");
    expect(text).toContain("EARLIER");
  });

  test("the note carries the median, the rows, the minutes and the PSI", () => {
    const note = tierSlowdownNote({ median: 3.2, rows: 77, spanMs: 90 * MIN, psi: 12 });
    expect(note.startsWith(TIER_SLOWDOWN_REASON_PREFIX)).toBe(true);
    expect(note).toContain("3.2×");
    expect(note).toContain("last 77 passing rows over 90 min");
    expect(note).toContain("12.0%");
    expect(note).toContain("re-run it with --resume");
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
 * answers `ownMs(n, k)` for the n-th activated mutant's k-th call (undefined: no own time at all). `onActivate(n)` moves
 * the injected clock when the n-th mutant is activated.
 */
function slowBackend(
  ownMs: (mutant: number, call: number) => number | undefined,
  kind: "bcdev" | "al-runner-v3" = "bcdev",
  onActivate: (mutant: number) => void = () => {},
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
        onActivate(mutants);
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

/** The injected monotonic clock of a session test: it moves only when a backend's `onActivate` moves it. */
function injectedClock() {
  const c = { t: 1_000_000 };
  clock.mono = () => c.t;
  return c;
}

const HOST_QUIET = { psi: () => 5 as number | null, load1: () => 2 as number | null };

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
    tierSlowdownHost: HOST_QUIET,
    ...over,
  });
  return { report, events, lines, store, dirs: project };
}

const warningsOf = (events: readonly RunEvent[], code: string): string[] =>
  events.flatMap((e) => (e.type === "warning" && e.code === code ? [e.message] : []));

const wouldStopOf = (events: readonly RunEvent[]) =>
  events.filter((e) => e.type === "tier-slowdown-would-stop");

/** From the 18th mutant on, every call runs at 6x its baseline; a mutant takes 2 minutes of the injected clock. */
const slowFrom18 = () => {
  const c = injectedClock();
  return slowBackend(
    (n) => (n >= 18 ? 600 : 100),
    "bcdev",
    () => {
      c.t += 2 * MIN;
    },
  );
};

describe("PR-466 r5: a whole bcdev session, SHADOW (the default)", () => {
  test("a healthy run builds a monitor, never triggers, and prints the arming line once", async () => {
    const c = injectedClock();
    const { report, events, lines } = await session(
      slowBackend(
        () => 100,
        "bcdev",
        () => {
          c.t += 2 * MIN;
        },
      ),
    );
    expect(report.timeBudget).toBeUndefined();
    expect(report.tierSlowdownWouldStop).toBeUndefined();
    expect("tierSlowdownWouldStop" in report).toBe(false);
    expect(wouldStopOf(events)).toHaveLength(0);
    expect(warningsOf(events, "tier-slowdown-stop")).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[lethal\] tier-slowdown monitor: mode shadow; fed \d+ passing rows, skipped 0 \(no reference 0, under 50 ms 0\); \d+ check\(s\), highest window median 1\.00×, PSI unreadable 0 time\(s\), baseline PSI 5\.0%; not triggered$/,
    );
    expect(report.mutants.length).toBeGreaterThanOrEqual(60);
  });

  test("a trigger records the event, the report field and one console line, and nothing else", async () => {
    const { report, events, lines, store } = await session(slowFrom18());
    const [ev] = wouldStopOf(events);
    expect(wouldStopOf(events)).toHaveLength(1);
    expect(ev?.type).toBe("tier-slowdown-would-stop");
    const w = report.tierSlowdownWouldStop;
    expect(w).toBeDefined();
    expect(w?.median).toBe(6);
    expect(w?.psi).toBe(5);
    expect(w?.load1).toBe(2);
    expect(w?.rows).toBeGreaterThanOrEqual(TIER_SLOWDOWN_MIN_ROWS);
    // the window of 60 min ending at the 100th fed row (mutant 34, at 68 min): the onset is mutant 4 (at 8 min)
    expect(w?.onsetMutantId).toBe(4);
    expect(w?.spanMs).toBe(60 * MIN);
    // the event and the report agree
    if (ev?.type === "tier-slowdown-would-stop") {
      expect({ ...w }).toEqual({
        atMs: ev.atMs,
        median: ev.median,
        rows: ev.rows,
        spanMs: ev.spanMs,
        psi: ev.psi,
        load1: ev.load1,
        onsetMutantId: ev.onsetMutantId,
        onsetSeq: ev.onsetSeq,
      });
    }
    // NOT a warning, no stop, no window, no quarantine, no change of exit code or finish
    expect(warningsOf(events, "tier-slowdown-stop")).toHaveLength(0);
    expect(events.some((e) => e.type === "warning" && e.code.includes("slowdown"))).toBe(false);
    expect(events.filter((e) => e.type === "degraded-window")).toHaveLength(0);
    expect(events.some((e) => e.type === "time-budget-reached" || e.type === "quarantined")).toBe(
      false,
    );
    expect(report.timeBudget).toBeUndefined();
    expect(exitCodeForReport(report)).not.toBe(TIME_BUDGET_EXIT_CODE);
    expect(store.getRun(1)?.finished).toBe(true);
    expect(store.degradedWindowOf(1)).toBeNull();
    expect(report.mutants.some((m) => m.verdict === "error")).toBe(false);
    // one console line for the trigger, then the arming line
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tier-slowdown-would-stop (shadow: nothing was stopped");
    expect(lines[1]).toContain("mode shadow;");
    expect(lines[1]).toContain("; TRIGGERED");
    // the banner says it, and says every verdict stands
    const banner = renderConsole(report);
    expect(banner).toContain("TIER-SLOWDOWN (shadow");
    expect(banner).toContain("NOTHING was stopped or dropped");
    expect(banner).not.toContain("STOPPED BY");
    // the progress line
    const out: string[] = [];
    const render = createProgressRenderer((l) => out.push(l), { heartbeatMs: 30_000 });
    for (const e of events) render(e);
    expect(out.some((l) => l.includes("TIER SLOWDOWN (shadow, nothing stopped)"))).toBe(true);
  });

  test("a session that triggers equals the same session with no trigger: verdicts, notes, exit code, store rows, event types", async () => {
    // the control: the same stream with an unreadable PSI, which never triggers
    const trig = await session(slowFrom18());
    const ctl = await session(slowFrom18(), { tierSlowdownHost: { psi: () => null } });
    expect(wouldStopOf(trig.events)).toHaveLength(1);
    expect(wouldStopOf(ctl.events)).toHaveLength(0);
    expect(trig.report.tierSlowdownWouldStop).toBeDefined();
    expect(ctl.report.tierSlowdownWouldStop).toBeUndefined();
    const shape = (r: typeof trig.report) =>
      r.mutants.map((m) => [m.mutantCode, m.verdict, m.failureNote, m.killingTest ?? null]);
    expect(shape(trig.report)).toEqual(shape(ctl.report));
    expect(trig.report.validity.caveats).toEqual(ctl.report.validity.caveats);
    expect(exitCodeForReport(trig.report)).toBe(exitCodeForReport(ctl.report));
    expect(trig.report.timeBudget).toEqual(ctl.report.timeBudget);
    expect(verdictsOf(trig.store, 1)).toEqual(verdictsOf(ctl.store, 1));
    const count = (s: ResultsStore, table: string) =>
      (s.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count(trig.store, "test_results")).toBe(count(ctl.store, "test_results"));
    expect(trig.store.getRun(1)?.finished).toBe(ctl.store.getRun(1)?.finished);
    const types = (es: readonly RunEvent[]) =>
      es.filter((e) => e.type !== "tier-slowdown-would-stop").map((e) => e.type);
    expect(types(trig.events)).toEqual(types(ctl.events));
    // the unreadable PSI is counted in the control's arming line
    expect(ctl.lines.at(-1)).toMatch(/PSI unreadable [1-9]\d* time\(s\)/);
  });

  test("a high PSI keeps a slow session quiet too", async () => {
    const { events, report } = await session(slowFrom18(), { tierSlowdownHost: { psi: () => 40 } });
    expect(wouldStopOf(events)).toHaveLength(0);
    expect(report.tierSlowdownWouldStop).toBeUndefined();
  });
});

describe("PR-466 r5: a whole bcdev session, --tier-slowdown-stop", () => {
  const STOP = { tierSlowdownStop: true as const };

  test("a sustained slowdown stops the run: a spent budget, the window as error, never finished, resumable, exit 7, no TIME BUDGET text", async () => {
    const { report, events, store, lines } = await session(slowFrom18(), STOP);
    const stop = report.timeBudget?.stoppedByTierSlowdown;
    expect(stop?.median).toBe(6);
    expect(stop?.psi).toBe(5);
    expect(stop?.spanMs).toBe(60 * MIN);
    expect(stop?.afterMutantId).toBe(3); // the window's first row is mutant 4's
    expect(warningsOf(events, "tier-slowdown-stop")).toHaveLength(1);
    expect(events.filter((e) => e.type === "degraded-window")).toHaveLength(1);
    expect(wouldStopOf(events)).toHaveLength(0); // the stop mode says it with the stop's own events
    expect(report.tierSlowdownWouldStop).toBeUndefined();
    expect(lines.at(-1)).toContain("mode stop;");
    // no quarantine, no signal, a time-budget exit code
    expect(report.quarantined).toBeUndefined();
    expect(events.some((e) => e.type === "quarantined")).toBe(false);
    expect(report.timeBudget?.stoppedBySignal).toBeUndefined();
    expect(exitCodeForReport(report)).toBe(TIME_BUDGET_EXIT_CODE);
    const banner = renderConsole(report);
    expect(banner).toContain("STOPPED BY THE TIER-SLOWDOWN STOP");
    expect(banner).toContain("first cut");
    expect(banner).toContain("host CPU pressure 5.0%");
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
    expect(report.mutants.filter((m) => m.verdict === "survived").length).toBe(3);
    // more mutants than the stop scheduled were left for the resume
    expect(report.timeBudget?.unscheduledCount ?? 0).toBeGreaterThan(0);
  });

  test("r2a-1: the stop on the FINAL row of the last batch still leaves the run unfinished, resumable, and exits as a time-budget stop", async () => {
    // only the last 50 mutants (3 calls each: 150 rows) carry an own time, all at 6x. A mutant takes 75 s, so the first
    // fed row is 49 mutants = 61.25 min old at the 150th and last row, and only there is the window full.
    const base = await session(slowBackend(() => 100));
    const total = base.report.mutants.length;
    expect(total).toBeGreaterThan(60);
    const c = injectedClock();
    const { report, events, store } = await session(
      slowBackend(
        (n) => (n > total - 50 ? 600 : undefined),
        "bcdev",
        () => {
          c.t += 75_000;
        },
      ),
      STOP,
    );
    expect(report.timeBudget?.stoppedByTierSlowdown?.median).toBe(6);
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
    const first = await session(slowFrom18(), STOP);
    const store = first.store;
    const second = await session(
      slowBackend(() => 100),
      { resume: "last", ...STOP },
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
    // the first fed row is exactly 60 min old at the 100th (mutant 34's first call): the window starts at the first mutant
    const c = injectedClock();
    const { report } = await session(
      slowBackend(
        () => 600,
        "bcdev",
        (n) => {
          c.t = 1_000_000 + (n < 34 ? n * 1000 : 3_600_000 + 1000);
        },
      ),
      STOP,
    );
    expect(report.timeBudget?.stoppedByTierSlowdown).toBeDefined();
    expect(report.mutants.length).toBeGreaterThan(0);
    expect(report.mutants.every((m) => m.verdict === "error")).toBe(true);
    expect(report.validity.caveats).toContain("all-errors");
    expect(exitCodeForReport(report)).toBe(4); // NOTHING_SCORED_EXIT_CODE, ahead of the time-budget code
    const banner = renderConsole(report);
    expect(banner).toContain("NOTHING SCORED");
    expect(banner).not.toContain("TIME BUDGET");
  });
});

describe("PR-466 r5: al-runner sessions and the flag's backend", () => {
  test("an al-runner session constructs no monitor: no arming line, no trigger", async () => {
    const { lines, report, events } = await session(slowBackend(() => 100, "al-runner-v3"));
    expect(lines).toEqual([]);
    expect(wouldStopOf(events)).toHaveLength(0);
    expect(report.timeBudget).toBeUndefined();
  });

  test("--tier-slowdown-stop on a backend that is not bcdev is refused by name, before any run", async () => {
    const backend = slowBackend(() => 100, "al-runner-v3");
    const store = new ResultsStore(":memory:");
    let err: unknown;
    try {
      await runSession({
        backend,
        store,
        ...(await makeProject()),
        selectorIds,
        tierSlowdownStop: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TierSlowdownFlagBackendError);
    expect((err as Error).message).toContain("--tier-slowdown-stop");
    expect((err as Error).message).toContain("al-runner-v3");
    store.close();
  });
});

describe("PR-466 r5: the flag is in the run's identity", () => {
  test("a --resume across the flag is refused by name, both ways, by id and as last; the same mode resumes", async () => {
    for (const [first, second] of [
      [undefined, true],
      [true, undefined],
    ] as const) {
      const store = new ResultsStore(":memory:");
      const project = await makeProject();
      const extraOf = (k: true | undefined, resume?: number | "last") => ({
        ...(k === true ? { tierSlowdownStop: true as const } : {}),
        ...(resume !== undefined ? { resume } : {}),
      });
      const healthy = () => slowBackend(() => 100);
      await session(healthy(), extraOf(first), store, project);
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      await expect(session(healthy(), extraOf(second, 1), store, project)).rejects.toThrow(
        /tier-slowdown-resume-refused/,
      );
      await expect(session(healthy(), extraOf(second, "last"), store, project)).rejects.toThrow(
        /tier-slowdown-resume-refused/,
      );
      const resumed = await session(healthy(), extraOf(first, 1), store, project);
      expect(resumed.report.resumedFrom?.runId).toBe(1);
      store.close();
    }
  });

  test("the flag changes the stored digest, and flag-off digests are the ones recorded before it existed", () => {
    const f = {
      projectDir: "/p",
      testDir: "/t",
      backend: "al-runner-v3",
      skipKnownSurvivors: false,
      identityScheme: 1,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const none = sessionFingerprint(f);
    expect(sessionFingerprint({ ...f, tierSlowdownStop: true })).not.toBe(none);
    // the digest of these inputs before PR-297 and before PR-466 (pinned in pr297-refused-cut-tail.test.ts too)
    expect(none).toBe("9349b4c9edc905ff2627fabf927415d531d474d105727b56247fe761be5d5154");
  });

  test("a default session's stored digest equals the flag-off digest, and a flag-on session's differs", async () => {
    const project = await makeProject(); // the same project: the digest may differ by the flag alone
    const off = await session(
      slowBackend(() => 100),
      {},
      new ResultsStore(":memory:"),
      project,
    );
    const off2 = await session(
      slowBackend(() => 100),
      {},
      new ResultsStore(":memory:"),
      project,
    );
    const on = await session(
      slowBackend(() => 100),
      { tierSlowdownStop: true },
      new ResultsStore(":memory:"),
      project,
    );
    const fp = (s: ResultsStore) => s.getRun(1)?.configFingerprint;
    expect(fp(off.store)).toBeDefined();
    expect(fp(off2.store)).toBe(fp(off.store));
    expect(fp(on.store)).not.toBe(fp(off.store));
  });

  test("the CLI flag sets tierSlowdownStop; absent leaves it out", () => {
    const base = ["run", "--project", "P", "--tests", "T", "--backend", "bcdev"];
    const on = parseCliConfig([...base, "--tier-slowdown-stop"]);
    expect(on.mode === "run" ? on.tierSlowdownStop : "wrong mode").toBe(true);
    const off = parseCliConfig(base);
    expect(off.mode === "run" ? "tierSlowdownStop" in off : "wrong mode").toBe(false);
  });

  test("runFromCliWithAccept hands tierSlowdownStop: true to the session only when the flag is on", async () => {
    const root = scratch("lethal-pr466-cli-");
    const projectDir = join(root, "app");
    const testDir = join(root, "tests");
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    await Bun.write(join(testDir, "app.json"), "{}");
    await Bun.write(join(root, "lethal.config.json"), "{}");
    const seen = async (stop: true | undefined) => {
      let got: Parameters<typeof runSession>[0] | undefined;
      // A canned report, not a throw: a failed run keeps its scratch folder (R358).
      const canned = { validity: { caveats: [] }, buildSymbols: [], mutants: [] } as never;
      await runFromCliWithAccept(
        {
          mode: "run",
          projectDir,
          testDir,
          // runSession is stubbed, so its bcdev-only refusal is not reached; this backend needs no config section.
          backendKind: "al-runner-v3",
          dbPath: ":memory:",
          configPath: join(root, "lethal.config.json"),
          skipKnownSurvivors: false,
          workers: 1,
          keepEnv: false,
          allowExpiringEnv: false,
          ...(stop === true ? { tierSlowdownStop: true as const } : {}),
        },
        {
          validateSelectorIdsForProject: async () => {},
          buildBackend: async () => ({}) as never,
          runSession: async (cfg) => {
            got = cfg;
            return canned;
          },
        },
      );
      return got;
    };
    const on = await seen(true);
    expect(on?.tierSlowdownStop).toBe(true);
    const off = await seen(undefined);
    expect(off !== undefined && "tierSlowdownStop" in off).toBe(false);
  });
});
