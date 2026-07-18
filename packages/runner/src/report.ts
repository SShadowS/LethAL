import type { MutantManifestEntry } from "@lethal/schemata";
import type { BackendCapabilities } from "./backend";
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
  readonly mutationScore: number | null; // killed / (killed + survived); null when denominator 0
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
    mutants.push({
      mutantCode: o.mutant.mutantId,
      file: o.mutant.file,
      line: o.mutant.startLine,
      operatorName: o.mutant.operatorName,
      verdict: o.verdict,
      batchIndex: o.batchIndex,
      ...(o.killingTest !== undefined ? { killingTest: o.killingTest } : {}),
    });
  }

  const denom = counts.killed + counts.survived;
  return {
    backend: input.caps.authoritative ? "bcdev" : "al-runner",
    authoritative: input.caps.authoritative,
    baselineGreen: input.baselineGreen,
    batches: input.batches,
    counts,
    mutationScore: denom === 0 ? null : counts.killed / denom,
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
