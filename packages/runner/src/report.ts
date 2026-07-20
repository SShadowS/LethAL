import type { MutantManifestEntry } from "@lethal/schemata";
import type { BackendCapabilities } from "./backend";
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
  return {
    backend: input.caps.authoritative ? "bcdev" : "al-runner",
    authoritative: input.caps.authoritative,
    baselineGreen: input.baselineGreen,
    batches: input.batches,
    counts,
    mutationScore: denom === 0 ? null : (counts.killed + counts.timeoutKilled) / denom,
    mutants,
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
  return lines.join("\n");
}

export async function writeJsonReport(r: SessionReport, path: string): Promise<void> {
  await Bun.write(path, JSON.stringify(r, null, 2));
}
