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

declare const cardinalityChecked: unique symbol;

/**
 * A report that has passed `assertCardinality`. `checkAnchors` takes one of these instead of a
 * bare `SessionReport`, which is the whole point: the cardinality precondition used to be a
 * sentence in a doc comment, and a documented precondition is enforced by whoever remembers to
 * read it. Rung 1's operator running the anchors ad hoc against a live billed environment is
 * exactly the situation where nobody does.
 *
 * The brand is unforgeable in TypeScript (a `unique symbol` this module never exports a value
 * for), so `checkAnchors(report, cfg)` no longer typechecks; `checkAnchors` additionally
 * re-verifies the count at runtime, which catches the JS caller who casts and the caller who
 * mutates the report after verifying it. `assertCardinality` stays independently callable and
 * `campaign-freeze.ts` keeps using it that way, ignoring the return value.
 */
export type CardinalityVerifiedReport = {
  readonly report: SessionReport;
  readonly expectedCount: number;
  readonly label: string;
  readonly [cardinalityChecked]: true;
};

/**
 * Pre-committed mutant count, asserted before any anchor is read.
 *
 * Without this, an empty report satisfies every "for all mutants ..." anchor vacuously — the
 * empty-vs-empty failure this repo is named for. Throws rather than returning a boolean: a
 * caller cannot accidentally ignore a throw.
 */
export function assertCardinality(
  report: SessionReport,
  expected: number,
  label: string,
): CardinalityVerifiedReport {
  const got = report.mutants.length;
  if (got !== expected) {
    throw new Error(
      `${label}: pre-committed mutant cardinality not met — expected ${expected}, got ${got}. A gate comparing against a report of the wrong size is not measuring what it claims.`,
    );
  }
  return { report, expectedCount: expected, label } as CardinalityVerifiedReport;
}

const COVERED_VERDICTS = new Set(["killed", "survived", "timeout-killed"]);

function inAnyRange(line: number, ranges: readonly ProcedureRange[]): boolean {
  return ranges.some((r) => line >= r.startLine && line <= r.endLine);
}

/**
 * The precondition is the parameter type: only `assertCardinality` produces a
 * `CardinalityVerifiedReport`, and it throws rather than returning one when the count is wrong.
 * These anchors are a payload evaluated against a report already known to be the pre-committed
 * size — they do NOT re-derive that guarantee, and they must not be reachable without it.
 * `coverage-location` and `killed-at-least-one` both fail explicitly on a report with zero
 * mutants, but that is a courtesy against a caller printing a single anchor in isolation, not a
 * substitute: `baseline-green` is cardinality-independent and would still read as a real pass on
 * an empty report.
 *
 * The runtime re-check below is not redundant with the type. The brand is erased at runtime, so a
 * plain-JS caller, a cast, or a report mutated between verification and use would all slip
 * through the type system; a gate that can be entered with an unverified report is not a gate.
 */
export function checkAnchors(
  verified: CardinalityVerifiedReport,
  cfg: AnchorConfig,
): readonly AnchorResult[] {
  const { report, expectedCount, label } = verified;
  if (report.mutants.length !== expectedCount) {
    throw new Error(
      `${label}: checkAnchors received a report whose mutant count (${report.mutants.length}) no longer matches the verified cardinality (${expectedCount}). The verification token does not describe this report.`,
    );
  }
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

export interface OracleInput {
  /** Path as the report spells it — project-relative, so a caller can join it to the project dir. */
  readonly path: string;
  readonly source: string;
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
export function notInstrumentedOracle(files: readonly OracleInput[]): OracleCount {
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

export interface ReconcileResult {
  readonly passed: boolean;
  /** How many of the report's own `notInstrumented.files` were read and re-classified. */
  readonly checked: number;
  /** Report-listed files the oracle says a selector var COULD have been injected into. */
  readonly offenders: readonly string[];
  readonly byKind: Record<string, number>;
  readonly detail: string;
}

/**
 * The rung-2 `notInstrumented` reconciliation, with a stated identity — because the obvious one
 * does not exist.
 *
 * **The identity asserted here:** *every file the report calls uninstrumentable really is
 * uninstrumentable, by an independent reading of its object header* — i.e. run the oracle over the
 * report's OWN `notInstrumented.files` paths and require `instrumentable === 0`.
 *
 * **Why not count-vs-count.** The two quantities are unequal BY CONSTRUCTION and comparing them
 * would fail on a healthy project:
 *   - `SessionReport.notInstrumented.files` holds only files with **>=1 mutation spec** that
 *     cannot carry the selector var (`orchestrator.ts`, the `canCarryMutationSelectorVar` skip).
 *   - The oracle classifies **every file handed to it**, spec-bearing or not.
 *   - So a zero-spec page is `notInstrumentable` to the oracle and **absent** from the report; a
 *     zero-spec codeunit is `instrumentable` to the oracle and equally absent. Neither is a bug.
 *   - The report's candidate set also excludes any `Mutation*` basename (`orchestrator.ts`'s
 *     `.filter((e) => !basename(e).startsWith("Mutation"))`), which the oracle knows nothing about.
 * Feeding the oracle the report's own list removes every one of those asymmetries: the input set is
 * identical by definition, and what is being compared is the CLASSIFICATION, from a different
 * reading (a regex over the object header) than the one the session used (a tree-sitter parse).
 *
 * **Fails loudly on a caller-contract violation**, rather than reconciling a partial set: the
 * supplied sources must be exactly the report's listed paths. A missing source would make the
 * claim pass over fewer files than it names, and an extra one would put a file the report never
 * listed on trial. Both are the "gate that passed because a file was missing" shape.
 *
 * **A vacuous pass is a failure.** With zero listed files `instrumentable === 0` holds trivially,
 * so `checked === 0` is reported as NOT passed. A run that legitimately has nothing to reconcile
 * (a narrow `--only` over one codeunit) should not request this check at all — see the anchors
 * driver's `reconcileNotInstrumented` config flag.
 */
export function reconcileNotInstrumented(
  report: SessionReport,
  sources: readonly OracleInput[],
): ReconcileResult {
  const listed = report.notInstrumented.files.map((f) => f.file);
  const supplied = new Set(sources.map((s) => s.path));
  const missing = listed.filter((p) => !supplied.has(p));
  if (missing.length > 0) {
    throw new Error(
      `notInstrumented reconciliation: no source supplied for ${missing.length} file(s) the report lists as uninstrumentable (${missing.slice(0, 5).join(", ")}). Reconciling a subset would pass over fewer files than it names.`,
    );
  }
  const listedSet = new Set(listed);
  const extra = sources.map((s) => s.path).filter((p) => !listedSet.has(p));
  if (extra.length > 0) {
    throw new Error(
      `notInstrumented reconciliation: ${extra.length} supplied source(s) are not in the report's notInstrumented list (${extra.slice(0, 5).join(", ")}). This check classifies the report's own claims, nothing else.`,
    );
  }

  const oracle = notInstrumentedOracle(sources);
  const offenders = sources
    .filter((s) => notInstrumentedOracle([s]).instrumentable === 1)
    .map((s) => s.path);
  const checked = sources.length;
  if (checked === 0) {
    return {
      passed: false,
      checked: 0,
      offenders: [],
      byKind: oracle.byKind,
      detail:
        "the report lists no uninstrumentable files — `instrumentable === 0` is vacuous here, not satisfied. Do not request this check for a run that has nothing to reconcile.",
    };
  }
  return {
    passed: offenders.length === 0,
    checked,
    offenders,
    byKind: oracle.byKind,
    detail:
      offenders.length === 0
        ? `all ${checked} report-listed uninstrumentable file(s) confirmed uninstrumentable by object header (${JSON.stringify(oracle.byKind)})`
        : `report claims uninstrumentable, object header says otherwise: ${offenders.join(", ")}`,
  };
}
