import type { MutantManifestEntry } from "@lethal/schemata";
import type { BackendCapabilities, TestOutcome } from "../../src/backend";
import type { BaselineClassification, RunEvent, RunEventInput } from "../../src/events";
import type { PermissionCanaryResult } from "../../src/permission-canary";
import { buildReport } from "../../src/report";
import type { NotInstrumentedFile, SessionOutcome, SessionReport } from "../../src/report";
import type { FoldStatics } from "../../src/report-fold";

/**
 * LEGACY TEST SHIM. Converts the OLD `BuildReportInput`-shaped literal (deleted, spec 2026-08-05
 * §A) into an equivalent event history and calls `buildReport(statics, events)`.
 *
 * This is deliberately NOT the preferred shape for new tests. An event-composing builder (small
 * functions over the real `RunEvent` union, one per event kind) would be safer in general — a bag
 * accepted here can, in principle, describe a combination `record()` never produces, which is
 * exactly the class of bug this refactor's own fixture conversion found twice (see
 * report-equality.test.ts and task-4-report.md: `resumedFrom.skippedStranded` with no backing
 * outcomes, and `guardObserved` on a carried verdict). A bag-shaped adapter was chosen anyway,
 * ONLY because mechanically converting ~12 pre-existing test call sites — each a `buildReport({...})`
 * literal already reviewed and already exercising real behaviour, not new arbitrary bag construction
 * — needed each diff to stay a one-line rename (`buildReport(` → `legacyBuildReport(`), not a
 * rewrite of every literal into a sequence of event-builder calls.
 *
 * To keep the risk bounded, this shim explicitly THROWS rather than silently accepting the two
 * impossible combinations found so far: a carried outcome that also sets `guardObserved` (the real
 * carried-verdict call site, orchestrator.ts, passes `guardObserved: undefined` unconditionally —
 * see the throw below), and more `runnerDisagreementTests` entries than outcomes with
 * `cause: "unstable"` to attach them to (the real coupling is 1:1, decided at the same call site,
 * same instant, as the cause itself). It does NOT attempt to validate every other invariant `record()`
 * upholds — this is a migration aid for fixtures that already existed, not a general-purpose
 * caller-contract checker.
 *
 * New tests should build `RunEvent[]` directly (see report-fold.test.ts for the pattern) — this
 * file exists so the pre-existing ~12 call sites did not each need a hand-written event sequence,
 * not as a template for future ones.
 */
export interface LegacyBuildReportInput {
  readonly caps: BackendCapabilities;
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly outcomes: readonly SessionOutcome[];
  readonly unsupportedTests: readonly string[];
  readonly notInstrumented: {
    readonly totalFiles: number;
    readonly files: readonly NotInstrumentedFile[];
  };
  readonly only?: {
    readonly patterns: readonly string[];
    readonly excludedFileCount: number;
  };
  readonly testsOnly?: readonly string[];
  readonly staleTestApp?: { readonly missingTests: readonly string[] };
  readonly permissionsRefusedTests?: readonly string[];
  readonly testPageUnsupportedTests?: readonly string[];
  readonly runnerDisagreementTests?: readonly string[];
  readonly stopHungSessions?: boolean;
  readonly resumedFrom?: {
    readonly runId: number;
    readonly carriedMutants: number;
    readonly skippedStranded: number;
  };
  readonly timings: {
    readonly totalMs: number;
    readonly generateMutationSetMs: number;
    readonly deployMs: number;
    readonly baselineMs: number;
  };
  readonly baselineTests: readonly { readonly codeunitName: string; readonly file?: string }[];
  readonly untargetedTriggerCount: number;
  readonly quarantined?: { readonly reason: string };
  readonly permissionCanary?: PermissionCanaryResult;
}

function syntheticMutant(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "__legacy-fixture__.al",
    startIndex: 0,
    endIndex: 0,
    startLine: 0,
    operatorName: "lethal.legacy-fixture-synthetic",
    operatorVersion: "1.0.0",
    astHash: `synthetic-${id}`,
    objectType: "codeunit",
    codeunitId: 0,
    codeunitName: "__LegacyFixtureSynthetic__",
    procedureName: "",
    originalText: "",
    mutatedText: "",
  };
}

export function legacyBuildReport(input: LegacyBuildReportInput): SessionReport {
  const events: RunEventInput[] = [];
  const push = (e: RunEventInput): void => {
    events.push(e);
  };

  push({
    type: "mutation-set-generated",
    siteCount: 0,
    deployedCount: 0,
    totalFiles: input.notInstrumented.totalFiles,
    instrumentableFiles: 0,
    notInstrumentedFiles: input.notInstrumented.files,
    excludedByOnly: input.only?.excludedFileCount ?? 0,
  });

  push({
    type: "tests-discovered",
    tests: input.baselineTests.map((t, i) => ({
      codeunitId: i,
      codeunitName: t.codeunitName,
      method: `LegacyMethod${i}`,
      ...(t.file !== undefined ? { file: t.file } : {}),
    })),
  });

  // baseline-batch-finished: reconstruct one verdict per name across `unsupportedTests` /
  // `staleTestApp` / `permissionsRefusedTests` / `testPageUnsupportedTests` — these were
  // independent fields on the old bag (never cross-validated against each other), so this builds
  // the union, tagging classification membership per name and deriving `outcome` from whichever
  // sets actually imply "did not pass" (`didNotPassAtBaseline`: fail/error only). A name present
  // ONLY in `staleTestApp` (never in `unsupportedTests`) gets a non-failing outcome (`skip`) so it
  // does not silently also become "unsupported" — a real stale-test-app baseline verdict from
  // bcdev-backend.ts always outcome:"error", but that would force it into `unsupportedTests` too;
  // callers that want both must list the name in `unsupportedTests` themselves.
  const unsupported = new Set(input.unsupportedTests);
  const stale = new Set(input.staleTestApp?.missingTests ?? []);
  const permRefused = new Set(input.permissionsRefusedTests ?? []);
  const testPageUnsupported = new Set(input.testPageUnsupportedTests ?? []);
  const allNames = new Set([...unsupported, ...stale, ...permRefused, ...testPageUnsupported]);
  const verdicts: {
    readonly name: string;
    readonly outcome: TestOutcome;
    readonly classification: BaselineClassification[];
  }[] = [...allNames].map((name) => {
    const classification: BaselineClassification[] = [];
    if (permRefused.has(name)) classification.push("tests-permission-refused");
    if (testPageUnsupported.has(name)) classification.push("tests-testpage-unsupported");
    if (stale.has(name)) classification.push("stale-test-app");
    return { name, outcome: unsupported.has(name) ? "fail" : "skip", classification };
  });
  // `baselineGreen` is a SEPARATE flag on the old bag — a caller could set it false (e.g. a
  // deadline-exceeded/timeout baseline outcome, which is not "unsupported") with none of the sets
  // above populated. Every verdict built above is already non-"pass" (fail or skip), so ANY entry
  // already makes the fold's AND-across-verdicts derivation land on false — only force a synthetic
  // one when the array would otherwise be empty.
  if (input.baselineGreen === false && verdicts.length === 0) {
    verdicts.push({
      name: "__legacy-fixture__.SyntheticBaselineFailure",
      outcome: "timeout",
      classification: [],
    });
  }
  push({ type: "baseline-batch-finished", batchIndex: 0, verdicts });

  if (input.quarantined !== undefined) {
    push({ type: "quarantined", reason: input.quarantined.reason });
  }

  if (input.permissionCanary !== undefined) {
    push({ type: "permission-canary", result: input.permissionCanary });
  }

  if (input.resumedFrom !== undefined) {
    push({
      type: "resume-resolved",
      fromRunId: input.resumedFrom.runId,
      mode: "last",
      carryableCount: input.resumedFrom.carriedMutants,
      strandedKeyCount: input.resumedFrom.skippedStranded,
      retryStranded: false,
    });
  }

  // A runnerDisagreementTests name is claimed, in order, by each `cause: "unstable"` outcome as it
  // is encountered — mirrors the real coupling: `mutant-scored.runnerDisagreementTest` is set at
  // the SAME kill-confirmation call site that decides `cause: "unstable"` (orchestrator.ts).
  let unclaimedDisagreement = 0;
  for (const o of input.outcomes) {
    if (o.carried === true) {
      if (o.guardObserved !== undefined) {
        throw new Error(
          `legacyBuildReport: outcome ${o.mutant.mutantId} is carried AND sets guardObserved — that combination is unrepresentable: record()'s carried-verdict call site (orchestrator.ts) never sets guardObserved, and mutant-carried (events.ts) has no such field. Fix the fixture, do not add it here.`,
        );
      }
      push({
        type: "mutant-carried",
        mutant: o.mutant,
        verdict: o.verdict,
        fromRunId: input.resumedFrom?.runId ?? 0,
        batchIndex: o.batchIndex,
        priorDurationMs: o.durationMs ?? 0,
        ...(o.killingTest !== undefined ? { killingTest: o.killingTest } : {}),
        ...(o.failureNote !== undefined ? { failureNote: o.failureNote } : {}),
        coveringTests: o.coveringTests ?? [],
        ...(o.coverageAttribution !== undefined
          ? { coverageAttribution: o.coverageAttribution }
          : {}),
        ...(o.runner !== undefined ? { runner: o.runner } : {}),
      });
    } else {
      const disagreementTests = input.runnerDisagreementTests ?? [];
      const claimedName =
        o.cause === "unstable" && unclaimedDisagreement < disagreementTests.length
          ? disagreementTests[unclaimedDisagreement]
          : undefined;
      if (o.cause === "unstable" && claimedName !== undefined) unclaimedDisagreement += 1;
      push({
        type: "mutant-scored",
        mutant: o.mutant,
        verdict: o.verdict,
        batchIndex: o.batchIndex,
        durationMs: o.durationMs ?? 0,
        ...(o.killingTest !== undefined ? { killingTest: o.killingTest } : {}),
        ...(o.failureNote !== undefined ? { failureNote: o.failureNote } : {}),
        ...(o.cause !== undefined ? { cause: o.cause } : {}),
        coveringTests: o.coveringTests ?? [],
        ...(o.coverageAttribution !== undefined
          ? { coverageAttribution: o.coverageAttribution }
          : {}),
        ...(o.guardObserved !== undefined ? { guardObserved: o.guardObserved } : {}),
        ...(o.runner !== undefined ? { runner: o.runner } : {}),
        ...(claimedName !== undefined ? { runnerDisagreementTest: claimedName } : {}),
      });
    }
  }
  if (unclaimedDisagreement < (input.runnerDisagreementTests ?? []).length) {
    throw new Error(
      "legacyBuildReport: runnerDisagreementTests has more names than outcomes with " +
        "cause:'unstable' to attach them to — that combination is unrepresentable (the real " +
        "coupling is 1:1 at the kill-confirmation call site). Fix the fixture.",
    );
  }

  if (input.resumedFrom !== undefined && input.resumedFrom.skippedStranded > 0) {
    for (let i = 0; i < input.resumedFrom.skippedStranded; i++) {
      const m = syntheticMutant(`__legacy-stranded-skip-${i}__`);
      push({
        type: "mutant-skipped-stranded",
        mutant: m,
        batchIndex: 0,
        note: "legacyBuildReport: synthetic stranded-skip mutant standing in for resumedFrom.skippedStranded",
      });
    }
  }

  if (input.untargetedTriggerCount > 0) {
    push({
      type: "coverage-split",
      batchIndex: 0,
      untargetedTriggerCount: input.untargetedTriggerCount,
      coveredCount: 0,
      noCoverageCount: 0,
    });
  }

  push({ type: "phase-left", phase: "generate", elapsedMs: input.timings.generateMutationSetMs });
  for (let i = 0; i < Math.max(1, input.batches); i++) {
    push({ type: "phase-entered", phase: "deploy" });
  }
  push({ type: "phase-left", phase: "deploy", elapsedMs: input.timings.deployMs });
  push({ type: "phase-left", phase: "baseline", elapsedMs: input.timings.baselineMs });
  push({ type: "session-finished", elapsedMs: input.timings.totalMs });

  const stamped: RunEvent[] = events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);

  const statics: FoldStatics = {
    caps: input.caps,
    ...(input.only !== undefined ? { only: { patterns: input.only.patterns } } : {}),
    ...(input.testsOnly !== undefined ? { testsOnly: input.testsOnly } : {}),
    ...(input.stopHungSessions === true ? { stopHungSessions: true } : {}),
  };
  return buildReport(statics, stamped);
}
