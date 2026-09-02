import { createHash } from "node:crypto";
import type { MutantManifestEntry } from "@lethal/schemata";
import { type CoverageAttribution, identityKeyOf, serializeKey } from "./selection";
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
 * R53/R201: what a mutant skipped on `--resume` because a prior run stranded the tier on it is
 * recorded with. One constant for the two sites that write it (step 5b and R192's
 * `replayCarriedBatch`), so the tests that read the prose cannot drift from one of them.
 *
 * It lives HERE, beside the detector, because the detector must recognise it: `resolveResume`
 * reads only the latest run's rows, and the latest row for a stranded mutant is this skip, not
 * the original `quarantined: ` row. Before R201 the skip did not match `isStrandedNote`, so the
 * resume AFTER a resume re-ran the hang (measured on Document Output 2026-09-02, M0023, a
 * removed loop counter; the first field run patched its database between iterations to stay
 * skipped).
 */
export const STRANDED_SKIP_NOTE =
  "not re-run on resume: a prior run's execution of this mutant could not be confirmed complete and stranded the tier. A mutant that never terminates (e.g. a negated loop-exit condition) reproduces this every time and blocks every mutant behind it, so it is skipped rather than retried — pass --retry-stranded to attempt it anyway. It is NOT scored either way.";

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
  //
  // R201: a skip written by an earlier resume is stranded too, or the skip lasts exactly one
  // resume — see `STRANDED_SKIP_NOTE`.
  return (
    failureNote?.startsWith(STRANDED_NOTE_PREFIX) === true || failureNote === STRANDED_SKIP_NOTE
  );
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
  /**
   * R192: the coverage facts the prior run measured this verdict under, carried so that a batch
   * whose every mutant carries can be recorded WITHOUT republishing and re-baselining it (see
   * `batchCarriesEntirely`). Absent when the source row predates the columns, in which case the
   * batch is deployed and baselined as before and this run's own coverage is used.
   */
  readonly coveringTests?: readonly string[];
  readonly coverageAttribution?: CoverageAttribution;
  readonly unplaceable?: boolean;
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
    // R166: a row recorded before `procedure_name` existed reads back null. Skip it rather than
    // keying it as `""`, which is a REAL value for an object-level mutant: coercing would carry a
    // pre-R166 verdict onto a genuine object-level mutant of the same subtree. The mutant is simply
    // re-run, which is the cheap direction.
    if (r.procedureName === null) continue;
    const key = serializeKey({
      astHash: r.astHash,
      codeunitName: r.codeunitName,
      procedureName: r.procedureName,
      operatorName: r.operatorName,
      operatorMajor: r.operatorMajor,
      ordinal: r.identityOrdinal,
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
      ...(row.coveringTests !== undefined ? { coveringTests: row.coveringTests } : {}),
      ...(row.coverageAttribution !== undefined
        ? { coverageAttribution: row.coverageAttribution }
        : {}),
      ...(row.unplaceable !== undefined ? { unplaceable: row.unplaceable } : {}),
    });
  }
  return { carryable, ambiguousKeys, nonCarryableRows, strandedKeys };
}

/**
 * R192: can THIS batch be recorded from the prior run alone, with no deploy and no baseline?
 *
 * Yes only when every mutant in it either carries a prior verdict WITH its coverage facts, or is
 * one a prior run stranded the tier on and this run will skip (`--retry-stranded` off). One mutant
 * that must execute, one colliding key, or one carried row that predates the coverage columns is
 * enough to say no, and the batch takes the ordinary path: deploy, baseline, this run's coverage.
 *
 * Why the coverage facts are required and an empty list is not assumed: a carried verdict is
 * recorded with the covering tests it was measured under, and a resumed survivor has to stay
 * actionable (which tests ran it, by which attribution). A row without them would be recorded
 * either with a made-up empty list, which reads as "no test ran this", or by re-baselining, which
 * is the cost this exists to remove. Refusing is the cheap failure.
 *
 * Measured 2026-09-02 on a hosted sandbox: a fully-carried 25-mutant batch cost a 40 s deploy and
 * a 215 s baseline on every one of twelve resumes, for verdicts that were never going to change.
 */
export function batchCarriesEntirely(
  index: ResumeIndex,
  mutants: readonly MutantManifestEntry[],
  retryStranded: boolean,
): boolean {
  if (mutants.length === 0) return false;
  for (const m of mutants) {
    if (!retryStranded && wasStranded(index, m)) continue;
    const carried = carriedVerdictFor(index, m);
    if (carried === undefined || carried.coveringTests === undefined) return false;
  }
  return true;
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
  /**
   * R127: the `--operator` narrowing, if any. In for the same reason `only` is: it changes which
   * mutants the run deployed at all.
   */
  readonly operators?: readonly string[];
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
    // R127: OMITTED entirely when absent, rather than serialised as `null` the way `only` and
    // `testsOnly` are. Those two were in the canonical shape from the start; adding a third key
    // that is always present would change the digest of every run ever recorded, so a store
    // holding a half-finished 12-hour run would stop resuming the moment this build shipped. A
    // conditional key is deterministic (same position whenever present) and costs nothing.
    ...(input.operators !== undefined ? { operators: [...input.operators].sort() } : {}),
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
