import { createHash } from "node:crypto";
import type { MutantManifestEntry } from "@lethal/schemata";
import { identityKeyOf, serializeKey } from "./selection";
import type { MutantVerdict, MutantVerdictRow, RunnerKind } from "./store";

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

/**
 * R53: prefix every `failureNote` written when a mutant's run stranded the tier carries.
 *
 * Producer and detector share this ONE constant, and a test pins it, for the reason R31 needed the
 * same treatment: a reworded literal would make the diagnosis silently stop firing, which is
 * indistinguishable from "this never happens".
 */
export const STRANDED_NOTE_PREFIX = "quarantined: ";

/**
 * Whether a prior `error` row records a mutant that STRANDED the tier rather than merely failing.
 *
 * The distinction decides whether re-running it is progress or an infinite loop. An ordinary error
 * is transient and worth retrying — that is why `error` is not carryable. A stranding error means
 * the mutant's run outlived its budget and could not be confirmed complete, and on Continia
 * Document Output the cause was measured: mutant M0013 negates `until DOCustSetup.Next() = 0;` into
 * `<> 0`, which never terminates. Re-running that reproduces the hang, re-quarantines, and blocks
 * the 125 mutants queued behind it — so a resume that retries it can never finish, no matter how
 * high `--mutant-timeout-ms` goes.
 */
export function isStrandedNote(failureNote: string | undefined): boolean {
  // `=== true`, not optional chaining alone: `failureNote?.startsWith(...)` is `boolean | undefined`
  // and an absent note must be FALSE, not undefined. A `biome --unsafe` autofix made exactly that
  // rewrite and the "an ordinary error is NOT stranded" test caught it.
  return failureNote?.startsWith(STRANDED_NOTE_PREFIX) === true;
}

/** A prior verdict this run may record without re-executing the mutant. */
export interface CarriedVerdict {
  readonly verdict: MutantVerdict;
  readonly killingTest?: string;
  readonly failureNote?: string;
  /** R86 — see `MutantRow.killingTestFailure` (store.ts). Carried for the same reason
   *  `killingTest` is: a kill carried onto a second run keeps its own account of why it died. */
  readonly killingTestFailure?: string;
  readonly durationMs: number;
  /**
   * R69 Phase 2 Task 5 — the runner that actually produced this verdict, carried through from
   * `MutantVerdictRow.runner` unchanged. THE RESUME HOLE this closes: without this field, a mutant
   * killed under `GuiAllowed=Yes` (client-services) in run 1 is re-recorded on `--resume` with no
   * runner tag at all, and a report defined as "the execution contexts used in THIS run" would
   * truthfully report fenced-only — silently telling the reader an interactive kill was fenced.
   * Absent when the source row predates this column (read as "fenced", never as unknown — see
   * `RunnerKind`).
   */
  readonly runner?: RunnerKind;
}

export interface ResumeIndex {
  /** Identity key (`serializeKey`) to the verdict that may be carried for it. */
  readonly carryable: ReadonlyMap<string, CarriedVerdict>;
  /** Keys seen more than once in the prior run, and therefore NOT carryable — see below. */
  readonly ambiguousKeys: number;
  /** Rows whose verdict is not carryable (today: `error`), and which will be re-executed. */
  readonly nonCarryableRows: number;
  /**
   * R53: identity keys whose prior run STRANDED the tier — see `isStrandedNote`. Skipped by
   * default on resume rather than retried, because retrying a non-terminating mutant re-hangs and
   * blocks every mutant behind it. `--retry-stranded` overrides.
   */
  readonly strandedKeys: ReadonlySet<string>;
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
export function buildResumeIndex(
  rows: readonly MutantVerdictRow[],
  /**
   * R53: whether THIS session may end BC sessions (`--stop-hung-sessions`).
   *
   * A `timeout-killed` verdict only exists because a prior run was allowed to stop a hung session
   * and score the result. Carrying one into a session that is NOT allowed to do that would import
   * a verdict this run could not have produced, and could not reproduce if asked — the resume
   * would silently claim a kill on the strength of a permission it does not hold.
   *
   * The fingerprint deliberately does NOT include the flag, so this is directional rather than a
   * fingerprint mismatch: turning the flag ON and resuming is the natural recovery from a stranded
   * run and must keep working. Only the OFF direction drops those verdicts, and they are re-run.
   */
  stopHungSessions = false,
): ResumeIndex {
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
  const strandedKeys = new Set<string>();
  let ambiguousKeys = 0;
  let nonCarryableRows = 0;
  for (const [key, bucket] of seen) {
    // R53: checked BEFORE the ambiguity and carryability rules, and across every row in the bucket.
    // A stranding mutant must be recognised even when its identity key collides with a sibling,
    // because the consequence of missing it is not a lost verdict — it is a resume that hangs on
    // the same mutant forever and can never reach the ones behind it.
    if (bucket.some((r) => isStrandedNote(r.failureNote))) strandedKeys.add(key);
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
    // R53: a `timeout-killed` is only obtainable by stopping a session. A run forbidden to do that
    // must re-measure rather than inherit one — counted, never silent, like every other drop here.
    if (row.verdict === "timeout-killed" && !stopHungSessions) {
      nonCarryableRows += 1;
      continue;
    }
    carryable.set(key, {
      verdict: row.verdict,
      durationMs: row.durationMs,
      ...(row.killingTest !== undefined ? { killingTest: row.killingTest } : {}),
      ...(row.failureNote !== undefined ? { failureNote: row.failureNote } : {}),
      ...(row.killingTestFailure !== undefined
        ? { killingTestFailure: row.killingTestFailure }
        : {}),
      ...(row.runner !== undefined ? { runner: row.runner } : {}),
    });
  }
  return { carryable, ambiguousKeys, nonCarryableRows, strandedKeys };
}

/** R53: whether THIS run's mutant is one a prior run stranded the tier on — see `strandedKeys`. */
export function wasStranded(index: ResumeIndex, m: MutantManifestEntry): boolean {
  return index.strandedKeys.has(serializeKey(identityKeyOf(m)));
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
