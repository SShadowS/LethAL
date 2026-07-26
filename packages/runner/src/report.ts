import type { MutantManifestEntry } from "@lethal/schemata";
import { type AlRunnerCanaryResult, alRunnerCanaryWarnings } from "./al-runner-canary";
import type { BackendCapabilities } from "./backend";
import { type PermissionCanaryResult, permissionCanaryWarnings } from "./permission-canary";
import { identityKeyOf } from "./selection";
import type { MutantVerdict } from "./store";

/**
 * Internal accumulation record produced while `runSession` walks batches and
 * mutants. `buildReport` folds a list of these into the public `SessionReport`.
 */
export interface SessionOutcome {
  readonly mutant: MutantManifestEntry;
  readonly verdict: MutantVerdict;
  readonly batchIndex: number;
  readonly killingTest?: string;
  readonly failureNote?: string;
  /**
   * Structural reason for an "error" verdict, set only at the two call
   * sites in orchestrator.ts that actually know it. Deliberately NOT
   * derived from `failureNote` text: `failureNote` also carries arbitrary
   * backend-thrown text (e.g. the batch-deploy-failure handler's
   * `String(err)`), which could otherwise collide with a prefix match.
   */
  readonly cause?: "deadline-exceeded" | "unstable";
}

/**
 * A file `generateMutationSet` (orchestrator.ts) dropped because no object it declares can carry
 * the injected `var MutationSelector: Codeunit "Mutation Selector";` guard — only a codeunit or
 * a table can (page/report/query/xmlport cannot). See `SessionReport.notInstrumented`.
 */
export interface NotInstrumentedFile {
  readonly file: string;
  /** Object kind(s) this file declares, e.g. `"page_declaration"` — from `describeObjectKinds`. */
  readonly kinds: string;
  /** Mutation sites the tier-1 operators found here, none of which could ever run. */
  readonly sites: number;
}

export interface SessionReport {
  readonly backend: string;
  readonly authoritative: boolean;
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly counts: {
    killed: number;
    survived: number;
    noCoverage: number;
    timeoutKilled: number;
    knownSurvivors: number;
    unstable: number;
    errors: number;
    deadlineExceeded: number;
  };
  /**
   * Mutation score: (killed + timeoutKilled) / (killed + timeoutKilled + survived).
   * Null when denominator is 0.
   * Both killed and timeout-killed count as observable misbehavior (design.md §6.7:
   * "Timeout counts as killed (mutation caused observable misbehavior, including
   * potential nontermination)").
   */
  readonly mutationScore: number | null;
  readonly mutants: readonly MutantOutcome[];
  /**
   * Baseline test methods (qualified `Codeunit.method`) that did NOT pass at
   * baseline — outcome `fail`/`error` (spec §9). A web-service session cannot
   * open TestPages, and an unsupported test type surfaces exactly this way; a
   * genuinely broken test is indistinguishable by outcome, so the honest label
   * is "did not pass at baseline", not a hard "unsupported" claim. Any mutant
   * covered ONLY by one of these is recorded `error` (score-excluded) with a
   * named note rather than a silent `no-coverage` false-negative. Always
   * present; empty when the whole baseline passed. Deduped, sorted.
   */
  readonly unsupportedTests: readonly string[];
  /**
   * Files never instrumented because no object they declare can carry the selector-var guard
   * (R5 — see `NotInstrumentedFile`). `mutationScore` above is computed ONLY over instrumented
   * sites: a project whose skipped files hold a large share of its code can otherwise read as a
   * confident, near-complete score while most of the project was never measured at all. Always
   * present; `files` is empty and `fileCount`/`siteCount` are 0 when nothing was skipped.
   * `totalFiles` is every `.al` source file `generateMutationSet` scanned (the denominator for
   * judging how much of the project `files` represents) — it is NOT the same as `batches` or any
   * other count already in this report.
   */
  readonly notInstrumented: {
    readonly totalFiles: number;
    readonly fileCount: number;
    readonly siteCount: number;
    readonly files: readonly NotInstrumentedFile[];
  };
  /**
   * R41: the `--only` narrowing this run was asked for, if any. Absent means the whole project
   * was considered.
   *
   * Present for the same reason `notInstrumented` is: `mutationScore` covers what was RUN, and a
   * narrowed run's score describes the chosen slice, not the project. A report that recorded the
   * score but not the narrowing would be indistinguishable from a full run at the same number —
   * and would stay that way in the `--out` JSON, long after the console line scrolled away.
   *
   * `excludedFileCount` counts FILES, never sites: the sites in an excluded file are never
   * generated, so their number is not something this run measured (see
   * `MutationSetResult.excludedByOnly`).
   */
  readonly only?: {
    readonly patterns: readonly string[];
    readonly excludedFileCount: number;
  };
  /**
   * Table trigger mutants that took `coverageFilter`'s FALLBACK 2 — "coverage places this
   * nowhere at all, so run every green test" (`selection.ts`; summed over every batch).
   *
   * The only signal distinguishing precise trigger attribution (FALLBACK 1, object-level) from
   * giving up, and it is invisible in the verdicts: on a suite where most tests touch the table,
   * running the right tests and running all of them produce the same kills. Commit `0a463fd`
   * deliberately made this branch rare by feeding member-less coverage observations into
   * `byObject`; a regression that re-emptied `byObject` would silently restore the old behaviour
   * with every aggregate count and every per-mutant verdict unchanged. It reached only a
   * `console.warn` before, which no gate can assert — hence a report field.
   *
   * NOT a defect on its own: a genuinely unreachable-by-coverage trigger SHOULD run everything
   * rather than be dropped as `no-coverage`. It is a number to pin, and a rise in it is the thing
   * to explain.
   *
   * 0 on a backend declaring `coverage: "none"` (al-runner) — no coverage filtering happens
   * there at all, every mutant runs every green test by construction, and no mutant reaches any
   * fallback. Read it only alongside `backend`.
   */
  readonly untargetedTriggerCount: number;
  /**
   * Set only when the session latched unsafe (spec §8/§12) — a test run came back
   * in-flight-unknown (the server may still be executing it) and the session recorded a
   * durable tier quarantine and stopped scheduling further mutants. `reason` is
   * `SessionSafety.reason` verbatim: it names the stranded op (method + mutant id) that
   * tripped the latch. Absent on every ordinary session, including one with plain (non-
   * in-flight-unknown) `deadline-exceeded` errors — those stay `counts.errors`/
   * `counts.deadlineExceeded` only, no quarantine.
   */
  readonly quarantined?: {
    readonly reason: string;
  };
  /**
   * R7/R8: set only on an al-runner session that actually ran the startup canary
   * (`packages/runner/src/al-runner-canary.ts`, attached via `cli.ts`'s `withAlRunnerCanary`) —
   * absent on every bcdev session and on the al-runner no-`alRunnerPath` fallback path, where
   * nothing was measured. Persisting the measured verdict here (not just a `console.warn` at
   * session start) is what makes it survive into a `--out` JSON report or reach a CI that
   * discards stderr; `renderConsole` also repeats it at the END of the printed report for the
   * same reason — a warning seen once, before the mutant table, is easy to have already
   * scrolled past by the time a reader gets to the score.
   */
  readonly alRunnerCanary?: AlRunnerCanaryResult;
  /**
   * R26: set on every session that ran the permission canary — an authoritative (bcdev) session,
   * where the fenced `RunMutant` path is the thing being characterised. Absent on al-runner and on
   * every in-memory-backend unit test, which have no fenced path and so nothing to measure.
   *
   * Persisting it here (not just a `console.warn` after the lease is acquired) is what makes the
   * verdict survive into a `--out` JSON report or reach a CI that discards stderr — and it is what
   * lets two runs of the same project on two different servers be compared honestly, since
   * `"mocked"` and `"not-mocked"` produce legitimately different scores for the same code. As with
   * `alRunnerCanary`, `renderConsole` also repeats it AFTER the score: a warning printed before a
   * single mutant ran has scrolled well off screen by the time a reader reaches the number it
   * qualifies.
   *
   * `"inconclusive"` is a first-class value here, never collapsed into `"not-mocked"` — an older
   * control app with no such action, a transport failure, or an unparseable response must stay
   * visibly distinct from a measured clean result.
   */
  readonly permissionCanary?: PermissionCanaryResult;
}

export interface MutantOutcome {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: MutantVerdict;
  readonly batchIndex: number;
  readonly killingTest?: string;
  /**
   * Carried through verbatim from `SessionOutcome.failureNote` — for a
   * bisected compile failure (Task 6, design spec §6) this is the culprit's
   * own identity ("bisected to mutant M000x (file:line operator)"); for other
   * `error` verdicts it's whatever diagnostic `record()` was given (deadline/
   * unstable text, the raw backend error). Without this field the note was
   * computed but reached nothing outside `orchestrator.ts` — every mutant in
   * a failed batch read as a bare, indistinguishable "error".
   */
  readonly failureNote?: string;
  /**
   * Structural reason for an "error" verdict — mirrors `SessionOutcome.cause`. Present only
   * for the two call sites that actually know it (deadline/unstable); other `error` verdicts
   * (e.g. a bisected compile failure) leave this undefined.
   */
  readonly cause?: "deadline-exceeded" | "unstable";
  /**
   * Semantic mutant identity components (Layer 5A, `itest/mutant-equality.ts`) — the SAME
   * astHash/codeunitName/operatorMajor triple `identityKeyOf`/`serializeKey` (selection.ts)
   * already use for known-survivor persistence. Unlike `killingTest`/`failureNote`, these are
   * always known at `record()` time, so they're not optional: a mutant-code- or
   * file:line-keyed identity would break the moment a mutant is renumbered or a source line
   * shifts, which is exactly the fragility the per-mutant regression gate (design spec §11)
   * exists to survive.
   */
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorMajor: number;
}

export interface BuildReportInput {
  readonly caps: BackendCapabilities;
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly outcomes: readonly SessionOutcome[];
  /** Deduped, sorted qualified names of baseline tests that did not pass — see `SessionReport.unsupportedTests`. */
  readonly unsupportedTests: readonly string[];
  /** Threaded straight from `generateMutationSet`'s return — see `SessionReport.notInstrumented`. */
  readonly notInstrumented: {
    readonly totalFiles: number;
    readonly files: readonly NotInstrumentedFile[];
  };
  /** R41: the `--only` patterns and how many files they excluded — see `SessionReport.only`.
   *  Absent when the run was not narrowed. */
  readonly only?: {
    readonly patterns: readonly string[];
    readonly excludedFileCount: number;
  };
  /** Summed over every batch's `coverageFilter` — see `SessionReport.untargetedTriggerCount`.
   *  Required, not optional: an absent tally and a measured zero must never look alike. */
  readonly untargetedTriggerCount: number;
  /** Threaded straight through from `runSession`'s `SessionSafety` — see `SessionReport.quarantined`. */
  readonly quarantined?: {
    readonly reason: string;
  };
  /** R26: the once-per-session permission canary's measured verdict, threaded straight through
   *  from `runSession` — see `SessionReport.permissionCanary`. */
  readonly permissionCanary?: PermissionCanaryResult;
}

export function buildReport(input: BuildReportInput): SessionReport {
  const counts = {
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeoutKilled: 0,
    knownSurvivors: 0,
    unstable: 0,
    errors: 0,
    deadlineExceeded: 0,
  };
  const mutants: MutantOutcome[] = [];

  for (const o of input.outcomes) {
    switch (o.verdict) {
      case "killed":
        counts.killed++;
        break;
      case "survived":
        counts.survived++;
        break;
      case "no-coverage":
        counts.noCoverage++;
        break;
      case "timeout-killed":
        counts.timeoutKilled++;
        break;
      case "known-survivor":
        counts.knownSurvivors++;
        break;
      case "error":
        counts.errors++;
        if (o.cause === "unstable") counts.unstable++;
        if (o.cause === "deadline-exceeded") counts.deadlineExceeded++;
        break;
    }
    const identity = identityKeyOf(o.mutant);
    mutants.push({
      mutantCode: o.mutant.mutantId,
      file: o.mutant.file,
      line: o.mutant.startLine,
      operatorName: o.mutant.operatorName,
      verdict: o.verdict,
      batchIndex: o.batchIndex,
      astHash: identity.astHash,
      codeunitName: identity.codeunitName,
      operatorMajor: identity.operatorMajor,
      ...(o.killingTest !== undefined ? { killingTest: o.killingTest } : {}),
      ...(o.failureNote !== undefined ? { failureNote: o.failureNote } : {}),
      ...(o.cause !== undefined ? { cause: o.cause } : {}),
    });
  }

  const denom = counts.killed + counts.timeoutKilled + counts.survived;
  const notInstrumentedSites = input.notInstrumented.files.reduce((n, f) => n + f.sites, 0);
  return {
    backend: input.caps.authoritative ? "bcdev" : "al-runner",
    authoritative: input.caps.authoritative,
    baselineGreen: input.baselineGreen,
    batches: input.batches,
    counts,
    mutationScore: denom === 0 ? null : (counts.killed + counts.timeoutKilled) / denom,
    mutants,
    unsupportedTests: input.unsupportedTests,
    notInstrumented: {
      totalFiles: input.notInstrumented.totalFiles,
      fileCount: input.notInstrumented.files.length,
      siteCount: notInstrumentedSites,
      files: input.notInstrumented.files,
    },
    untargetedTriggerCount: input.untargetedTriggerCount,
    ...(input.only !== undefined ? { only: input.only } : {}),
    ...(input.quarantined !== undefined ? { quarantined: input.quarantined } : {}),
    ...(input.permissionCanary !== undefined ? { permissionCanary: input.permissionCanary } : {}),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderConsole(r: SessionReport): string {
  const lines: string[] = [];
  if (!r.authoritative) {
    lines.push(`[backend: ${r.backend} — mock runtime, indicative]`);
  }
  lines.push(
    `${pad("mutant", 8)} ${pad("file:line", 34)} ${pad("operator", 28)} ${pad("verdict", 16)} killing test`,
  );
  for (const m of r.mutants) {
    lines.push(
      `${pad(m.mutantCode, 8)} ${pad(`${m.file}:${m.line}`, 34)} ${pad(m.operatorName, 28)} ${pad(m.verdict, 16)} ${m.killingTest ?? ""}`,
    );
    // A short indented line beneath the row rather than a suffix on it: the
    // note (a bisected culprit's identity, a deadline/unstable diagnostic, or
    // a raw backend error) is often much longer than the fixed-width columns
    // above and would blow out the table's alignment if appended inline.
    if (m.verdict === "error" && m.failureNote !== undefined) {
      lines.push(`         ${m.failureNote}`);
    }
  }
  const scoreText = r.mutationScore === null ? "n/a" : `${(r.mutationScore * 100).toFixed(1)}%`;
  lines.push(
    `score: ${scoreText}  ` +
      `(killed ${r.counts.killed}, survived ${r.counts.survived}, no-coverage ${r.counts.noCoverage}, ` +
      `deadline-exceeded ${r.counts.deadlineExceeded}, ` +
      `timeout-killed ${r.counts.timeoutKilled}, known-survivor ${r.counts.knownSurvivors}, ` +
      `error ${r.counts.errors} [unstable ${r.counts.unstable}])`,
  );
  // R5: the score above is computed ONLY over instrumented sites — say so explicitly, right next
  // to it, whenever any file was dropped. A page-heavy project could otherwise read a confident
  // "100%" as full coverage when most of its code was never instrumented at all.
  if (r.notInstrumented.fileCount > 0) {
    const pct =
      r.notInstrumented.totalFiles > 0
        ? `${((r.notInstrumented.fileCount / r.notInstrumented.totalFiles) * 100).toFixed(1)}%`
        : "?";
    lines.push(
      `NOT INSTRUMENTED: ${r.notInstrumented.fileCount}/${r.notInstrumented.totalFiles} .al file(s) (${pct}), ${r.notInstrumented.siteCount} mutation site(s) never measured — the score above excludes them entirely, it is not a full-project score. Only a codeunit or a table can carry the injected selector var; page/report/query/xmlport objects are published unchanged.`,
    );
    for (const f of r.notInstrumented.files) {
      lines.push(`  ${f.file} (${f.kinds}, ${f.sites} site(s))`);
    }
  }
  // R41: a narrowed run's score describes the slice that was asked for, not the project. Same
  // placement rule as NOT INSTRUMENTED — a qualifier on the score belongs next to the score.
  if (r.only !== undefined) {
    lines.push(
      `NARROWED (--only): ${r.only.patterns.map((p) => `"${p}"`).join(", ")} — ${r.only.excludedFileCount} .al file(s) contributed no mutants. The score above covers the narrowed set ONLY, it is not a project score.`,
    );
  }
  // Same reasoning as NOT INSTRUMENTED above: a qualifier on the score belongs next to the score.
  // These mutants were scored against EVERY green test rather than against tests coverage placed
  // in their table — honest (better than dropping them as no-coverage) but slower and coarser, and
  // a rise here is the visible symptom of coverage attribution regressing.
  if (r.untargetedTriggerCount > 0) {
    lines.push(
      `COVERAGE FALLBACK: ${r.untargetedTriggerCount} table trigger mutant(s) coverage could place nowhere — each was run against every green test rather than against an attributed set.`,
    );
  }
  // R7/R8: repeat the al-runner canary's measured verdict at the END too — `announceAlRunnerCanary`
  // (cli.ts) already prints it once via console.warn at the very start of the session, before a
  // single mutant has run, which is exactly the "warning that scrolls past on a long run" pattern
  // that let the original static claim go unnoticed for a session's whole duration. The end of a
  // long run — right after the score — is where a reader actually is.
  if (!r.authoritative && r.alRunnerCanary !== undefined) {
    lines.push("");
    lines.push(...alRunnerCanaryWarnings(r.alRunnerCanary));
  }
  // R26: same reasoning, same lesson — the permission canary is announced once, right after the
  // lease is acquired and before the first mutant runs, which on a real session is many minutes
  // and a full mutant table before the score a reader is actually looking at. Repeat it here.
  // Unlike the al-runner canary above this is NOT gated on `authoritative`: the permission mock is
  // a property of the FENCED (bcdev) path, so an authoritative report is exactly where it belongs
  // — presence of the field alone decides, and nothing else ever sets it.
  if (r.permissionCanary !== undefined) {
    lines.push("");
    lines.push(...permissionCanaryWarnings(r.permissionCanary));
  }
  return lines.join("\n");
}

export async function writeJsonReport(r: SessionReport, path: string): Promise<void> {
  await Bun.write(path, JSON.stringify(r, null, 2));
}
