/**
 * The three-outcome live gate, as a pure decision procedure.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`, "The three-outcome live
 * gate". This module is the whole of that section's logic and deliberately performs no IO: it takes
 * what a leg's receipt reported, what the control run reported, and what was pre-committed, and
 * returns one decision. Everything that can go wrong here is a wrong verdict, so it is separated
 * from everything that can go wrong by touching a container.
 *
 * ## Why the control run comes before the reconciliation
 *
 * A live leg passes on per-mutant equality with a frozen baseline. But a CORRECT change is often
 * supposed to move that baseline, so "the baseline moved" cannot mean "regression" on its own. The
 * discriminator is a control run of the same legs on the BASE commit in the same containers:
 *
 * - base matches the baseline -> the movement is candidate-caused;
 * - base also differs        -> the environment moved, and nothing about the candidate is provable
 *                               in it (`al-runner` is a global dotnet tool that ships several times
 *                               a day).
 *
 * The control is checked FIRST, before the prediction is reconciled, and that ordering is
 * load-bearing rather than incidental. If it ran the other way, a prediction that happened to match
 * a drifting environment would re-record drift into the frozen baseline as though it were a
 * measured property of the code.
 *
 * ## Why an unpredicted candidate-caused movement burns the SHA
 *
 * Two rules that are each individually sensible compose into a hole big enough to void the entire
 * mechanism, and both reviewers of the design found it independently:
 *
 *   "unpredicted movement blocks" + "a failed prediction is inconclusive, write a new generation"
 *
 * gives: run the gate, observe the regression, write generation 2 predicting exactly what was just
 * observed, rerun, match, re-record, merge. A prediction authored after the observation proves
 * nothing at all, and the adversary reviewing generation 2 is no longer blind.
 *
 * So `candidate-caused-blocked` is terminal FOR THAT CANDIDATE SHA. No later generation can
 * legalize it. A retry requires a code change, therefore a new SHA, with its own pre-commitment
 * committed before that SHA's first live run. `inconclusive` is reachable only from the environment
 * row and from `killingTest` order noise, and it permits a retry of the SAME SHA because nothing
 * about the candidate was measured.
 */

/** A single per-mutant difference between a run and the frozen baseline, as the receipt reports it. */
export interface MutantDiff {
  /** The serialized identity key. Opaque here: this module never parses or constructs one. */
  readonly key: string;
  /**
   * `added`   the key is in the run and not the baseline.
   * `removed` the key is in the baseline and not the run.
   * `changed` the key is in both and at least one compared field differs.
   */
  readonly kind: "added" | "removed" | "changed";
  /**
   * The compared fields that differ, exactly as `mutant-equality` names them, e.g. `["verdict"]`
   * or `["killingTest"]`. Empty for `added` and `removed`, where the whole record is the
   * difference.
   */
  readonly fields: readonly string[];
  /** The baseline's verdict. Absent for `added`. */
  readonly baselineVerdict?: string;
  /** The run's verdict. Absent for `removed`. */
  readonly observedVerdict?: string;
}

/** One pre-commitment entry. The four operations are the spec's; nothing else is accepted. */
export type PrecommitEntry =
  | { readonly op: "add"; readonly key: string; readonly expect: string }
  | { readonly op: "remove"; readonly key: string; readonly was: string }
  | { readonly op: "change"; readonly key: string; readonly from: string; readonly to: string }
  | {
      readonly op: "rename";
      readonly from: string;
      readonly to: string;
      readonly because: string;
    };

export interface GateOutcomeInput {
  /** Differences the candidate run reported against the frozen baseline. */
  readonly candidate: readonly MutantDiff[];
  /**
   * Differences the CONTROL run reported, running the same legs on the base commit in the same
   * containers. `undefined` means it has not been run; the decision is then `control-required`
   * rather than a guess.
   */
  readonly control?: readonly MutantDiff[];
  /** The committed pre-commitment for this candidate SHA. */
  readonly precommitment: readonly PrecommitEntry[];
}

export type GateOutcome =
  /** Outcome 1. Nothing moved. */
  | { readonly outcome: "match" }
  /** Outcome 2. Everything that moved was pre-committed, and the base is stable. */
  | { readonly outcome: "predicted"; readonly reRecord: true }
  /**
   * Outcome 3. The candidate caused a movement nobody predicted. TERMINAL for this SHA: `retry`
   * is `new-sha-only`, which is the whole anti-laundering property.
   */
  | {
      readonly outcome: "candidate-caused-blocked";
      readonly retry: "new-sha-only";
      readonly unexplained: readonly string[];
      readonly unobserved: readonly string[];
    }
  /** The base moved too, or only `killingTest` moved. Nothing about the candidate was measured. */
  | {
      readonly outcome: "inconclusive";
      readonly reason: "environment-drift" | "killing-test-order";
      readonly retry: "same-sha";
      readonly detail: readonly string[];
    }
  /** The candidate disagreed and no control run was supplied. Not a verdict; run the control. */
  | { readonly outcome: "control-required" };

/**
 * A difference in `killingTest` alone is order noise, not a regression.
 *
 * R197: covering tests run killer-first, so where several tests kill one mutant the killer depends
 * on the order earlier mutants were scored in, which `--only`, `--resume` and a differing
 * per-mutant history can change. CLAUDE.md records that two gate tables may legitimately differ in
 * this field alone.
 *
 * It is `inconclusive` rather than `match` on purpose. The field moving IS a real observation, and
 * calling it a pass would let a genuine attribution change (a test that stopped covering the
 * mutant, so a different one now kills it) ride in on a rule written for scheduling noise. A retry
 * settles it, and within one leg run the same way twice it should not recur.
 */
function isOrderNoise(d: MutantDiff): boolean {
  return d.kind === "changed" && d.fields.length > 0 && d.fields.every((f) => f === "killingTest");
}

/** Thrown for a caller-contract violation, never returned as a plausible empty decision. */
export class PrecommitmentShapeError extends Error {}

function assertWellFormed(entries: readonly PrecommitEntry[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    // Two entries claiming the same key make reconciliation ambiguous, and ambiguity here resolves
    // in the direction of a pass, so it is refused rather than resolved.
    const keys = e.op === "rename" ? [e.from, e.to] : [e.key];
    for (const k of keys) {
      if (k.length === 0) throw new PrecommitmentShapeError(`empty key in a "${e.op}" entry`);
      if (seen.has(k)) {
        throw new PrecommitmentShapeError(
          `key claimed by more than one pre-commitment entry: ${k}`,
        );
      }
      seen.add(k);
    }
    if (e.op === "rename" && e.from === e.to) {
      throw new PrecommitmentShapeError(`rename with identical sides: ${e.from}`);
    }
    if (e.op === "rename" && e.because.trim().length === 0) {
      throw new PrecommitmentShapeError(`rename without evidence: ${e.from} -> ${e.to}`);
    }
  }
}

/**
 * Reconcile observed differences against the pre-commitment, in BOTH directions.
 *
 * Predicted-but-not-observed is as much a failure as observed-but-not-predicted: it means the
 * causal story was wrong, and a story that is wrong about what will happen is not evidence about
 * what did.
 */
function reconcile(
  candidate: readonly MutantDiff[],
  precommitment: readonly PrecommitEntry[],
): { unexplained: string[]; unobserved: string[] } {
  const byKey = new Map<string, MutantDiff>();
  for (const d of candidate) byKey.set(d.key, d);

  const explained = new Set<string>();
  const unobserved: string[] = [];

  for (const e of precommitment) {
    if (e.op === "rename") {
      const removed = byKey.get(e.from);
      const added = byKey.get(e.to);
      // A rename must be exactly a removal of the old key and an addition of the new one. Anything
      // else is not the churn this operation exists for.
      if (removed?.kind !== "removed" || added?.kind !== "added") {
        unobserved.push(`rename ${e.from} -> ${e.to}`);
        continue;
      }
      // THE LAUNDERING CHECK. Mutant identity is not semantic identity: `selection.ts` takes the
      // ordinal from SOURCE order, so inserting a byte-identical twin above an existing pair
      // renames every later twin, and `astSubtreeHash` moves under an unrelated refactor. A rename
      // is therefore legitimate. But if the verdict is allowed to differ across it, a real flip
      // hides inside an add/remove pair that looks like ordinary churn, which is exactly the
      // channel a rename operation opens. A rename carries identity, never a verdict change; a
      // rename WITH a verdict change is two claims and must be written as two entries.
      if (removed.baselineVerdict !== added.observedVerdict) {
        unobserved.push(
          `rename ${e.from} -> ${e.to} changes the verdict (${String(removed.baselineVerdict)} -> ${String(added.observedVerdict)}); a rename may not carry a verdict change`,
        );
        continue;
      }
      explained.add(e.from);
      explained.add(e.to);
      continue;
    }

    const d = byKey.get(e.key);
    if (d === undefined) {
      unobserved.push(`${e.op} ${e.key}`);
      continue;
    }
    const matches =
      (e.op === "add" && d.kind === "added" && d.observedVerdict === e.expect) ||
      (e.op === "remove" && d.kind === "removed" && d.baselineVerdict === e.was) ||
      (e.op === "change" &&
        d.kind === "changed" &&
        d.baselineVerdict === e.from &&
        d.observedVerdict === e.to);
    if (matches) explained.add(e.key);
    else unobserved.push(`${e.op} ${e.key}`);
  }

  const unexplained = candidate.filter((d) => !explained.has(d.key)).map((d) => d.key);
  return { unexplained, unobserved };
}

/**
 * Decide one leg's outcome.
 *
 * The order of the checks is the spec's decision procedure and must not be rearranged for
 * convenience. Order noise, then the control run, then the reconciliation.
 */
export function decideGateOutcome(input: GateOutcomeInput): GateOutcome {
  assertWellFormed(input.precommitment);

  if (input.candidate.length === 0) return { outcome: "match" };

  const noise = input.candidate.filter(isOrderNoise);
  const significant = input.candidate.filter((d) => !isOrderNoise(d));

  // Every difference is a killing-test swap. Nothing about a verdict moved, so there is nothing to
  // reconcile and nothing to block on.
  if (significant.length === 0) {
    return {
      outcome: "inconclusive",
      reason: "killing-test-order",
      retry: "same-sha",
      detail: noise.map((d) => d.key),
    };
  }

  if (input.control === undefined) return { outcome: "control-required" };

  // The base disagrees with its own frozen baseline, so the containers are not measuring what they
  // measured when the baseline was recorded. The candidate is not implicated and not exonerated:
  // it is simply not measurable here. Note this is checked against the control's SIGNIFICANT
  // differences too, so killing-test noise on the base does not by itself void a candidate run.
  const controlSignificant = input.control.filter((d) => !isOrderNoise(d));
  if (controlSignificant.length > 0) {
    return {
      outcome: "inconclusive",
      reason: "environment-drift",
      retry: "same-sha",
      detail: controlSignificant.map((d) => d.key),
    };
  }

  const { unexplained, unobserved } = reconcile(significant, input.precommitment);
  if (unexplained.length === 0 && unobserved.length === 0) {
    return { outcome: "predicted", reRecord: true };
  }

  return {
    outcome: "candidate-caused-blocked",
    retry: "new-sha-only",
    unexplained,
    unobserved,
  };
}
