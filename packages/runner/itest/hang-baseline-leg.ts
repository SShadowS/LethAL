/**
 * R-658: the pure judgements of `itest:hang`'s BASELINE leg and of its STOP rule, kept out of
 * `hang.itest.ts` so each can be unit-tested without a server (`hang-baseline-leg.test.ts`).
 * Binding spec: `docs/superpowers/specs/2026-10-22-r658-hang-baseline-leg-precommitment.md`
 * (§4's 20 assertions, §5's STOP rule, §3's D-C quarantine check).
 *
 * The only IO here is the leg marker and the evidence copy, both synchronous so the crash
 * handlers can call them, and both swallowing their own failure: neither may change an exit code.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionReport } from "../src/report";
import { HANG_FIGURES } from "./gate-expected";
import { keyOf } from "./mutant-equality";

/** The fixture codeunit (79451) and its three tests, in source order. `hang-baseline-leg.test.ts`
 *  pins these against `HangBaselineTests.Codeunit.al`. */
export const BASELINE_CODEUNIT = "Hang Z Baseline Tests";
export const SLEEPS_METHOD = "SleepsPastTheBaselineBudget";
export const Z_METHOD = "ZPassesAfterTheStoppedTest";
export const ZZ_METHOD = "ZZDrainsAfterTheStop";
export const SLEEPS = `${BASELINE_CODEUNIT}.${SLEEPS_METHOD}`;
export const Z = `${BASELINE_CODEUNIT}.${Z_METHOD}`;
export const ZZ = `${BASELINE_CODEUNIT}.${ZZ_METHOD}`;

/** §4: the line-103 `DrainQueue` mutant, matched by identity key, never by mutant code. */
export const DRAIN_KEY =
  "9223e82ad7544c25083f5b08316d3c99343c1fd6ff40da16b8d09c55a9a1a837|Hang Logic|DrainQueue|lethal.conditional-boundary|1";

/** Assertion 1: the stopped row's duration lies in [budget, budget + this). */
export const BASELINE_STOP_WINDOW_MS = 5_000;
/** Assertion 20: the leg, compile to probe release. */
export const BASELINE_LEG_WALL_BOUND_MS = 300_000;
/** Assertion 18's control-app lease owner. */
export const BASELINE_PROBE_OWNER = "hang-itest-baseline-probe";

/** Check 11's allow-list. `GATE_WARNINGS["hang/baseline"]` must equal it (R736). */
export const HANG_BASELINE_WARNING_CODES: readonly string[] = [
  "operator-narrowed-run",
  "tests-only-narrowed-baseline",
];

/** §5's leg marker. Absent is the fourth state. */
export type LegState = "armed" | "stop" | "passed";

/** A `test_results` row, as `hang.itest.ts` selects it. */
export interface HangTestRow {
  readonly op_kind: string | null;
  readonly mutant_code: string | null;
  readonly mutant_row_id: number | null;
  readonly codeunit_name: string | null;
  readonly method: string;
  readonly outcome: string;
  readonly duration_ms: number;
  readonly failure_message: string | null;
}

/** One `baseline-batch-finished` verdict (events.ts), narrowed to what assertion 1 reads. */
export interface BaselineVerdictEvent {
  readonly name: string;
  readonly outcome: string;
  readonly classification: readonly string[];
}

export interface BaselineLegInput {
  readonly report: SessionReport;
  readonly testRows: readonly HangTestRow[];
  readonly baselineVerdicts: readonly BaselineVerdictEvent[];
  readonly quarantinedEvents: number;
  readonly quarantineRecords: number;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  /** This run's `baseline_snapshots` rows. */
  readonly baselineSnapshotRows: number;
  /** `killReproductionFailures("hang/baseline", ...)`. */
  readonly repro: readonly string[];
  readonly sessionLiveness: {
    readonly missing: number;
    readonly singleRows: number;
    readonly singleDistinct: number;
  };
  /** Assertion 18: what the control app answered the probe acquire and its release. */
  readonly probe: { readonly granted: boolean; readonly released: boolean };
  /** Assertion 20: compile to probe release. */
  readonly elapsedMs: number;
}

/**
 * Assertions 1-18 and 20 (19 is `stopHungSessionsFindings`, checked before the leg's first call).
 * Each failure is prefixed `A<n>`; `[]` means the leg passed. Every failure is a STOP (D1).
 */
export function baselineLegFailures(i: BaselineLegInput): string[] {
  const out: string[] = [];
  const fail = (n: number, msg: string) => out.push(`A${n}: ${msg}`);
  const { report } = i;
  const budget = HANG_FIGURES.baselineBudgetMs;

  /** The one baseline row of `method`, or how many there were. */
  const baselineRow = (method: string): HangTestRow | number => {
    const rows = i.testRows.filter(
      (r) =>
        r.mutant_row_id === null &&
        r.mutant_code === null &&
        r.codeunit_name === BASELINE_CODEUNIT &&
        r.method === method,
    );
    const [only] = rows;
    return rows.length === 1 && only !== undefined ? only : rows.length;
  };
  const coveringHas = (name: string) =>
    report.mutants.filter((m) => m.coveringTests.includes(name)).map((m) => m.mutantCode);

  // 1. The stopped test, with BC's own stop words and inside its window.
  const s = baselineRow(SLEEPS_METHOD);
  if (typeof s === "number") {
    fail(1, `${SLEEPS} has ${s} baseline row(s), expected 1`);
  } else {
    const msg = s.failure_message ?? "";
    if (s.outcome !== "timeout") fail(1, `${SLEEPS}'s baseline row is ${s.outcome}, not timeout`);
    if (!/stopped the session/i.test(msg) || !/StopSession/i.test(msg)) {
      fail(
        1,
        `${SLEEPS}'s failure message lacks BC's stop words: ${JSON.stringify(msg.slice(0, 200))}`,
      );
    }
    if (!(s.duration_ms >= budget && s.duration_ms < budget + BASELINE_STOP_WINDOW_MS)) {
      fail(
        1,
        `${SLEEPS} took ${s.duration_ms} ms, outside [${budget}, ${budget + BASELINE_STOP_WINDOW_MS})`,
      );
    }
  }
  const sv = i.baselineVerdicts.filter((v) => v.name === SLEEPS);
  if (sv.length !== 1 || !sv[0]?.classification.includes("baseline-test-stopped")) {
    fail(1, `${SLEEPS} is not classified baseline-test-stopped: ${JSON.stringify(sv)}`);
  }

  // 2. Z passes and covers nothing (the leak check).
  const z = baselineRow(Z_METHOD);
  if (typeof z === "number" || z.outcome !== "pass") {
    fail(
      2,
      `${Z}'s baseline row is ${typeof z === "number" ? `${z} rows` : z.outcome}, not one pass`,
    );
  }
  const zCovers = coveringHas(Z);
  if (zCovers.length > 0) fail(2, `${Z} shows target coverage in ${zCovers.join(", ")}`);

  // 3 and 5. ZZ passes, covers exactly the DrainQueue mutant, and kills it at position 1.
  const zz = baselineRow(ZZ_METHOD);
  if (typeof zz === "number" || zz.outcome !== "pass") {
    fail(
      3,
      `${ZZ}'s baseline row is ${typeof zz === "number" ? `${zz} rows` : zz.outcome}, not one pass`,
    );
  }
  const drain = report.mutants.filter((m) => keyOf(m) === DRAIN_KEY);
  const [d] = drain;
  if (drain.length !== 1 || d === undefined) {
    fail(3, `${drain.length} mutant(s) carry the DrainQueue key, expected 1`);
    fail(5, "the DrainQueue mutant is missing");
  } else {
    if (JSON.stringify(d.coveringTests) !== JSON.stringify([ZZ])) {
      fail(
        3,
        `the DrainQueue mutant's coveringTests is ${JSON.stringify(d.coveringTests)}, expected [${ZZ}]`,
      );
    }
    if (d.verdict !== "killed") fail(5, `the DrainQueue mutant is ${d.verdict}, not killed`);
    if (d.killPosition !== 1) fail(5, `the DrainQueue mutant's killPosition is ${d.killPosition}`);
    if (d.killingTest !== ZZ_METHOD)
      fail(5, `the DrainQueue mutant's killingTest is ${d.killingTest}`);
    // 6. The first run and R582's re-run, both ZZ failing.
    const rows = i.testRows.filter(
      (r) => r.mutant_code === d.mutantCode && r.mutant_row_id !== null,
    );
    const ok = rows.every(
      (r) =>
        r.codeunit_name === BASELINE_CODEUNIT && r.method === ZZ_METHOD && r.outcome === "fail",
    );
    if (rows.length !== 2 || !ok) {
      fail(
        6,
        `the DrainQueue mutant has ${rows.length} mutated row(s) ${JSON.stringify(rows.map((r) => `${r.method}:${r.outcome}`))}, expected 2 ZZ fails`,
      );
    }
  }
  const zzElsewhere = report.mutants
    .filter((m) => keyOf(m) !== DRAIN_KEY && m.coveringTests.includes(ZZ))
    .map((m) => m.mutantCode);
  if (zzElsewhere.length > 0) fail(3, `${ZZ} also covers ${zzElsewhere.join(", ")}`);

  // 4 and 7. Exactly the pinned set: one kill, every other mutant no-coverage.
  if (report.mutants.length !== HANG_FIGURES.baselineLegMutants) {
    fail(4, `${report.mutants.length} mutants, expected ${HANG_FIGURES.baselineLegMutants}`);
  }
  const others = report.mutants.filter(
    (m) => keyOf(m) !== DRAIN_KEY && m.verdict !== "no-coverage",
  );
  if (others.length > 0) {
    fail(
      7,
      `not no-coverage: ${others.map((m) => `${m.mutantCode} line ${m.line} ${m.verdict}`).join(", ")}`,
    );
  }
  if (report.counts.killed !== HANG_FIGURES.baselineLegKilled) {
    fail(7, `counts.killed ${report.counts.killed}, expected ${HANG_FIGURES.baselineLegKilled}`);
  }

  // 8 and 9.
  if (report.baselineGreen !== false) fail(8, "baselineGreen is not false");
  const caveats = report.validity.caveats as readonly string[];
  for (const c of [
    "baseline-red",
    "baseline-test-stopped",
    "tests-narrowed",
    "operator-narrowed",
  ]) {
    if (!caveats.includes(c)) fail(9, `caveat ${c} missing from ${JSON.stringify(caveats)}`);
  }
  if (caveats.includes("stop-hung-sessions")) fail(9, "caveat stop-hung-sessions is present");

  // 10. No quarantine, by event, by report, by record.
  if (i.quarantinedEvents > 0) fail(10, `${i.quarantinedEvents} quarantined event(s)`);
  if (report.quarantined !== undefined) fail(10, "report.quarantined is set");
  if (i.quarantineRecords > 0) fail(10, `${i.quarantineRecords} quarantine record(s)`);

  // 11. The warning allow-list, each once.
  const codes = i.warnings.map((w) => w.code).sort();
  if (JSON.stringify(codes) !== JSON.stringify(HANG_BASELINE_WARNING_CODES)) {
    fail(11, `warning codes ${JSON.stringify(codes)}`);
  }
  const narrowed = i.warnings.find((w) => w.code === "tests-only-narrowed-baseline");
  if (narrowed !== undefined && !/narrowed the baseline to 3 test\(s\)/.test(narrowed.message)) {
    fail(11, `tests-only-narrowed-baseline does not name 3 tests: ${narrowed.message}`);
  }

  // 12-17.
  if (i.baselineSnapshotRows !== 0) fail(12, `${i.baselineSnapshotRows} baseline_snapshots row(s)`);
  const bs = report.baselineStopped;
  if (
    bs === undefined ||
    JSON.stringify(bs.tests) !== JSON.stringify([SLEEPS]) ||
    "reusedFromRun" in bs
  ) {
    fail(13, `baselineStopped is ${JSON.stringify(bs)}`);
  }
  if (report.unsupportedTests.length > 0)
    fail(14, `unsupportedTests ${JSON.stringify(report.unsupportedTests)}`);
  if (report.permissionsRefused !== undefined) fail(14, "permissionsRefused is set");
  if (i.repro.length > 0) fail(15, i.repro.join("; "));
  if (i.sessionLiveness.missing !== 0)
    fail(16, `${i.sessionLiveness.missing} row(s) without a session id`);
  if (i.sessionLiveness.singleRows !== i.sessionLiveness.singleDistinct) {
    fail(
      17,
      `${i.sessionLiveness.singleRows} single rows carry ${i.sessionLiveness.singleDistinct} distinct ids`,
    );
  }

  // 18 and 20.
  if (!i.probe.granted) fail(18, "the probe acquire was refused");
  if (!i.probe.released) fail(18, "the probe release was refused");
  if (!(i.elapsedMs < BASELINE_LEG_WALL_BOUND_MS)) {
    fail(20, `the leg took ${i.elapsedMs} ms, not under ${BASELINE_LEG_WALL_BOUND_MS}`);
  }
  return out;
}

/**
 * §3 D-C: in ON or SINGLE, a quarantine is a STOP, checked before that leg's other assertions.
 * `[]` means no STOP.
 */
export function quarantineStopReasons(
  label: string,
  i: {
    readonly report: SessionReport;
    readonly quarantinedEvents: number;
    readonly quarantineRecords: number;
  },
): string[] {
  const out: string[] = [];
  if (i.quarantinedEvents > 0) out.push(`[${label}] ${i.quarantinedEvents} quarantined event(s)`);
  if (i.quarantineRecords > 0) out.push(`[${label}] ${i.quarantineRecords} quarantine record(s)`);
  for (const m of i.report.mutants) {
    // `stranded` now also covers a lost answer after an unrefused stop (R665).
    // `stop-outcome-unconfirmed` is left only for a grouped answer that came back unusable after
    // an unrefused stop, which is still a STOP: the stopped session's end is not proven.
    if (
      m.cause === "stranded" ||
      m.cause === "confirm-stopped" ||
      m.cause === "stop-outcome-unconfirmed"
    ) {
      out.push(`[${label}] ${m.mutantCode} line ${m.line} has cause ${m.cause}`);
    }
  }
  return out;
}

/** The legs whose quarantine is a STOP (D-C). OFF quarantines by design. */
export const STOP_ON_QUARANTINE_MODES = ["on", "single"] as const;

/**
 * Review I1: the quarantine records left in `scratchRoot/quarantine-<mode>`, one line per leg that
 * holds any. Synchronous so the crash handlers can call it. Read on every non-STOP exit before the
 * teardown, because a throw in ON or SINGLE skips that leg's D-C check: a record found here is a
 * STOP all the same. An unreadable dir is a line too, never a silent `[]`.
 */
export function quarantineRecordsIn(
  scratchRoot: string,
  modes: readonly string[] = STOP_ON_QUARANTINE_MODES,
): string[] {
  const out: string[] = [];
  for (const mode of modes) {
    const dir = join(scratchRoot, `quarantine-${mode}`);
    if (!existsSync(dir)) continue;
    try {
      const n = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
      if (n > 0) out.push(`quarantine-${mode} holds ${n} record(s)`);
    } catch (err) {
      out.push(
        `quarantine-${mode} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** Assertion 19 (M4): `stopHungSessions` must be absent, not merely false, from both configs. */
export function stopHungSessionsFindings(backendCfg: object, sessionCfg: object): string[] {
  const out: string[] = [];
  if ("stopHungSessions" in backendCfg) out.push("A19: stopHungSessions is in the backend config");
  if ("stopHungSessions" in sessionCfg)
    out.push("A19: stopHungSessions is in the runSession config");
  return out;
}

/** §5: writes the leg marker. A failed write is logged and never changes the exit code. */
export function writeLegState(path: string | undefined, state: LegState): void {
  if (path === undefined) return;
  try {
    writeFileSync(path, `${state}\n`);
  } catch (err) {
    console.error(
      `  leg marker: could not write ${state} to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * §5 "evidence first": copy each leg's store (with its sidecars) and quarantine dir from
 * `scratchRoot` to `dir`. Returns one line per item; a failed copy is a line, never a throw.
 */
export function copyEvidence(
  scratchRoot: string,
  dir: string | undefined,
  modes: readonly string[],
): string[] {
  if (dir === undefined)
    return ["evidence: LETHAL_ITEST_HANG_EVIDENCE_DIR is unset, nothing copied"];
  const lines: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return [`evidence: cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const mode of modes) {
    const base = `hang-${mode}.sqlite`;
    for (const name of [base, `${base}-wal`, `${base}-shm`, `quarantine-${mode}`]) {
      const from = join(scratchRoot, name);
      if (!existsSync(from)) continue;
      try {
        cpSync(from, join(dir, name), { recursive: true });
        lines.push(`evidence: copied ${name}`);
      } catch (err) {
        lines.push(
          `evidence: FAILED to copy ${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return lines;
}
