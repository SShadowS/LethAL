import { createHash } from "node:crypto";
import type { MutantManifestEntry } from "@lethal/schemata";
import { identityKeyOf, serializeKey } from "./selection";
import type { MutantVerdict, MutantVerdictRow } from "./store";

/**
 * R47 — resuming an aborted run.
 *
 * The failure this exists for was measured, not imagined: attempting an all-tests sweep on Continia
 * Document Output, one slow (mutant, test) pair exceeded the per-mutant budget at mutant 13 of 138.
 * An exceeded budget is correctly indistinguishable from "the server may still be executing this",
 * so the session latched unsafe and wrote a durable quarantine — and the twelve verdicts already
 * measured went in the bin with it. `ResultsStore` had been writing them to SQLite the whole time;
 * nothing read them back.
 *
 * Resume therefore does not reconstruct a report from the database. It re-runs the whole session —
 * re-parse, re-instrument, re-deploy, re-baseline — and skips only the EXECUTION of mutants whose
 * verdict a prior run already established. That is the expensive part and the only part that is
 * safe to reuse: coverage attribution, covering-test lists and the baseline all come fresh from
 * this run, so a resumed report is not a stitched-together artefact of two different measurements.
 */

/**
 * Prior verdicts safe to carry into a resumed run.
 *
 * `error` is deliberately absent. An `error` verdict means the mutant did not produce a measurement
 * — a bisected compile failure, a transport error, an unstable run — and carrying one would freeze
 * a transient failure into every subsequent resume. Re-running it either reproduces the error (no
 * loss) or scores it (a gain), and both beat inheriting it.
 *
 * `known-survivor` IS carryable: it is a HISTORY verdict meaning "`--skip-known-survivors` chose
 * not to test this", which is as true on the resumed run as it was on the aborted one.
 */
export const CARRYABLE_VERDICTS: ReadonlySet<MutantVerdict> = new Set<MutantVerdict>([
  "killed",
  "survived",
  "timeout-killed",
  "no-coverage",
  "known-survivor",
]);

/** A prior verdict this run may record without re-executing the mutant. */
export interface CarriedVerdict {
  readonly verdict: MutantVerdict;
  readonly killingTest?: string;
  readonly failureNote?: string;
  readonly durationMs: number;
}

export interface ResumeIndex {
  /** Identity key (`serializeKey`) to the verdict that may be carried for it. */
  readonly carryable: ReadonlyMap<string, CarriedVerdict>;
  /** Keys seen more than once in the prior run, and therefore NOT carryable — see below. */
  readonly ambiguousKeys: number;
  /** Rows whose verdict is not carryable (today: `error`), and which will be re-executed. */
  readonly nonCarryableRows: number;
}

/**
 * Builds the identity-keyed index of prior verdicts a resumed run may reuse.
 *
 * **A key seen more than once is dropped, not merged.** The identity tuple is
 * `(astHash, codeunitName, operatorName, operatorMajor)`, and two textually identical statements in
 * one codeunit mutated by one operator produce the same tuple — legal, and not rare in real AL
 * (`Rec.Modify(true);` twice in a procedure). `priorSurvivorKeys` can treat that as a set because
 * it only asks "was any such key a survivor". A resume must answer "what was THIS mutant's
 * verdict", and a colliding key cannot. Carrying either row's verdict onto both mutants would
 * fabricate a measurement — this project's signature bug — so both are re-executed instead. The
 * count is reported, never silent.
 */
export function buildResumeIndex(rows: readonly MutantVerdictRow[]): ResumeIndex {
  const seen = new Map<string, MutantVerdictRow[]>();
  for (const r of rows) {
    const key = serializeKey({
      astHash: r.astHash,
      codeunitName: r.codeunitName,
      operatorName: r.operatorName,
      operatorMajor: r.operatorMajor,
    });
    const bucket = seen.get(key);
    if (bucket === undefined) seen.set(key, [r]);
    else bucket.push(r);
  }

  const carryable = new Map<string, CarriedVerdict>();
  let ambiguousKeys = 0;
  let nonCarryableRows = 0;
  for (const [key, bucket] of seen) {
    if (bucket.length > 1) {
      ambiguousKeys += 1;
      continue;
    }
    const [row] = bucket;
    if (row === undefined) continue; // unreachable: bucket.length === 1
    if (!CARRYABLE_VERDICTS.has(row.verdict)) {
      nonCarryableRows += 1;
      continue;
    }
    carryable.set(key, {
      verdict: row.verdict,
      durationMs: row.durationMs,
      ...(row.killingTest !== undefined ? { killingTest: row.killingTest } : {}),
      ...(row.failureNote !== undefined ? { failureNote: row.failureNote } : {}),
    });
  }
  return { carryable, ambiguousKeys, nonCarryableRows };
}

/**
 * The prior verdict for one of THIS run's mutants, or `undefined` if it must be executed.
 *
 * A mutant whose source changed since the prior run has a different `astHash` and therefore a
 * different key, so it simply misses — a stale verdict can never attach to edited code. That is
 * the property that makes resume safe against a working tree that moved underneath it.
 */
export function carriedVerdictFor(
  index: ResumeIndex,
  m: MutantManifestEntry,
): CarriedVerdict | undefined {
  return index.carryable.get(serializeKey(identityKeyOf(m)));
}

/**
 * Everything about a session's configuration that changes what its verdicts MEAN.
 *
 * Two runs with the same fingerprint measured the same thing; a resume across differing
 * fingerprints would mix scopes. `only` and `testsOnly` are the sharp cases — `--tests-only`
 * narrows the baseline and can manufacture a survivor (R45), so a run narrowed one way must never
 * inherit verdicts from a run narrowed another. `skipKnownSurvivors` is in for the same reason: it
 * changes which mutants were executed at all.
 *
 * Deliberately NOT included: `maxGuardsPerBatch`. It changes how the artifact is SPLIT, never what
 * any mutant means — and since verdicts are carried by identity rather than by mutant code (see
 * `MutantVerdictRow`), re-batching is exactly the case resume is built to survive. Excluding it
 * lets a run that hit a publish ceiling be resumed with a smaller batch budget, which is a real
 * recovery path rather than a hypothetical one.
 */
export interface SessionFingerprintInput {
  readonly projectDir: string;
  readonly testDir: string;
  readonly backend: string;
  readonly only?: readonly string[];
  readonly testsOnly?: readonly string[];
  readonly skipKnownSurvivors: boolean;
  readonly selectorIds: {
    readonly selectorId: number;
    readonly controlId: number;
    readonly tableId: number;
  };
}

/** Stable hex digest of `SessionFingerprintInput`. Globs are sorted so pattern ORDER — which
 *  changes nothing about what is selected — does not defeat a resume. */
export function sessionFingerprint(input: SessionFingerprintInput): string {
  const canonical = JSON.stringify({
    projectDir: input.projectDir,
    testDir: input.testDir,
    backend: input.backend,
    only: input.only === undefined ? null : [...input.only].sort(),
    testsOnly: input.testsOnly === undefined ? null : [...input.testsOnly].sort(),
    skipKnownSurvivors: input.skipKnownSurvivors,
    selectorIds: [
      input.selectorIds.selectorId,
      input.selectorIds.controlId,
      input.selectorIds.tableId,
    ],
  });
  return createHash("sha256").update(canonical).digest("hex");
}
