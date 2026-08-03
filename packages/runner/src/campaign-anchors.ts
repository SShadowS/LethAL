/**
 * Rung-1's regression payload for the DO live campaign (spec 2026-08-03, §"The regression payload").
 *
 * The 2026-07-28 per-mutant record does not survive on this machine, so a per-identity comparison
 * against it is impossible. These four anchors are what DOES survive — committed prose constants —
 * and each one is falsifiable. They are deliberately weaker than a per-mutant reference and the
 * spec says so.
 *
 * Pure by design: no I/O, no clock. A gate that reads the filesystem is a gate that can pass
 * because a file was missing.
 */
import type { SessionReport } from "./report";

export interface ProcedureRange {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface AnchorConfig {
  /** Procedures whose mutants are ALLOWED to be covered. Anchor 2 is location-based, not
   *  count-based, so a mutant from an operator that shipped after 2026-07-28 landing inside one
   *  of these is fine — which is the whole reason it survives roster growth. */
  readonly coveredProcedureRanges: readonly ProcedureRange[];
  readonly expectedBaselineTests: number;
}

export interface AnchorResult {
  readonly id: "baseline-green" | "coverage-location" | "killed-at-least-one";
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Pre-committed mutant count, asserted before any anchor is read.
 *
 * Without this, an empty report satisfies every "for all mutants ..." anchor vacuously — the
 * empty-vs-empty failure this repo is named for. Throws rather than returning a boolean: a
 * caller cannot accidentally ignore a throw.
 */
export function assertCardinality(report: SessionReport, expected: number, label: string): void {
  const got = report.mutants.length;
  if (got !== expected) {
    throw new Error(
      `${label}: pre-committed mutant cardinality not met — expected ${expected}, got ${got}. A gate comparing against a report of the wrong size is not measuring what it claims.`,
    );
  }
}

const COVERED_VERDICTS = new Set(["killed", "survived", "timeout-killed"]);

function inAnyRange(line: number, ranges: readonly ProcedureRange[]): boolean {
  return ranges.some((r) => line >= r.startLine && line <= r.endLine);
}

/**
 * Precondition: callers MUST call `assertCardinality` on `report` first. These anchors are a
 * payload evaluated against a report already known to be the pre-committed size — they do NOT
 * re-derive that guarantee. `coverage-location` and `killed-at-least-one` both fail explicitly
 * on a report with zero mutants, but that is a courtesy against a caller printing a single
 * anchor in isolation, not a substitute for the cardinality check: `baseline-green` is
 * cardinality-independent and would still read as a real pass on an empty report.
 */
export function checkAnchors(report: SessionReport, cfg: AnchorConfig): readonly AnchorResult[] {
  const results: AnchorResult[] = [];

  // Anchor 1 — the fenced baseline was fully green.
  const green = report.baselineGreen === true;
  results.push({
    id: "baseline-green",
    passed: green,
    detail: green
      ? `baseline green (${cfg.expectedBaselineTests} expected)`
      : `baseline NOT green; unsupportedTests=${report.unsupportedTests.length}`,
  });

  // Anchor 2 — every covered mutant is inside a covered procedure, or carries object-level
  // attribution. This is the R29/R63 false-survivor tripwire on real code. Guarded explicitly
  // against an empty report: `[].filter(...).length === 0` is vacuously true, and "every covered
  // mutant lies inside a covered procedure" is a meaningless claim over zero mutants, not a
  // satisfied one.
  let coverageLocationPassed: boolean;
  let coverageLocationDetail: string;
  if (report.mutants.length === 0) {
    coverageLocationPassed = false;
    coverageLocationDetail = "report holds no mutants — the claim is vacuous, not satisfied";
  } else {
    const offenders = report.mutants.filter(
      (m) =>
        COVERED_VERDICTS.has(m.verdict) &&
        m.coverageAttribution !== "object" &&
        !inAnyRange(m.line, cfg.coveredProcedureRanges),
    );
    coverageLocationPassed = offenders.length === 0;
    coverageLocationDetail =
      offenders.length === 0
        ? "every covered mutant is inside a covered procedure or object-attributed"
        : `covered mutants outside the covered procedures: ${offenders
            .map((m) => `${m.mutantCode}@${m.line}`)
            .join(", ")}`;
  }
  results.push({
    id: "coverage-location",
    passed: coverageLocationPassed,
    detail: coverageLocationDetail,
  });

  // Anchor 4 — something was killed. (Anchor 3, M0013's branch, is asserted by the rung-1
  // driver against the gate-0 probe result; it is not derivable from the report alone.)
  const killed = report.mutants.filter(
    (m) => m.verdict === "killed" || m.verdict === "timeout-killed",
  ).length;
  results.push({
    id: "killed-at-least-one",
    passed: killed >= 1,
    detail: `killed=${killed}`,
  });

  return results;
}

export interface OracleCount {
  readonly instrumentable: number;
  readonly notInstrumentable: number;
  readonly byKind: Record<string, number>;
}

const HEADER_RE =
  /^\s*(codeunit|table|tableextension|page|pageextension|report|query|xmlport|enum|enumextension|profile|permissionset|controladdin|interface)\b/im;

/** Only a codeunit or a table can carry the injected selector var (R5). */
const INSTRUMENTABLE = new Set(["codeunit", "table"]);

/**
 * An INDEPENDENT count of instrumentable vs not, by object-header kind.
 *
 * Deliberately not `--dry-run`: that mirrors the session's own accounting (R5, same producer), so
 * comparing the two is a producer against itself and would agree even if both were wrong.
 */
export function notInstrumentedOracle(
  files: readonly { readonly path: string; readonly source: string }[],
): OracleCount {
  const byKind: Record<string, number> = {};
  let instrumentable = 0;
  let notInstrumentable = 0;
  for (const f of files) {
    const m = HEADER_RE.exec(f.source);
    const kind = (m?.[1] ?? "unknown").toLowerCase();
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (INSTRUMENTABLE.has(kind)) instrumentable += 1;
    else notInstrumentable += 1;
  }
  return { instrumentable, notInstrumentable, byKind };
}
