/**
 * Binary-search for a mutant whose presence breaks compilation.
 *
 * One artifact means one bad mutant would otherwise turn every mutant in the
 * session into an error with no indication of which one was at fault (design
 * spec §6). This narrows it to a name in O(log n) compiles.
 */

/** What bisection concluded — a culprit is only ever named after confirmation. */
export type BisectOutcome<T> =
  /** The full set compiles: the observed failure did not reproduce under bisection. */
  | { readonly kind: "no-repro" }
  /**
   * A single mutant was isolated AND confirmed: it fails to compile on its
   * own, and the complement (everything except it) compiles without it.
   */
  | { readonly kind: "culprit"; readonly culprit: T }
  /**
   * The failure is not attributable to any single mutant — it reproduces (or
   * vanishes) independently of which mutants are present. Observed live with
   * BC app-version monotonicity (see fixtures/README.md): every subset's
   * deploy fails identically, and the unconfirmed search would have converged
   * on candidates[0] and named an innocent mutant with full confidence.
   */
  | { readonly kind: "environmental"; readonly detail: string };

export async function bisectFailingMutant<T>(
  mutants: readonly T[],
  compiles: (subset: readonly T[]) => Promise<boolean>,
): Promise<BisectOutcome<T>> {
  if (await compiles(mutants)) return { kind: "no-repro" };

  let candidates = [...mutants];
  while (candidates.length > 1) {
    const mid = Math.floor(candidates.length / 2);
    const left = candidates.slice(0, mid);
    candidates = (await compiles(left)) ? candidates.slice(mid) : left;
  }
  const culprit = candidates[0];
  if (culprit === undefined) {
    // `mutants` was empty, yet its (unmutated) artifact still failed above —
    // by definition nothing mutant-related is at fault.
    return { kind: "environmental", detail: "deploy fails with no mutants present" };
  }

  // Confirm before naming — the search above assumes exactly one bad mutant
  // and converges on SOMETHING for any failure shape, so an unconfirmed
  // answer is an accusation, not a diagnosis.
  //
  // 1. The culprit must fail alone. If it compiles as a singleton, the
  //    failure did not reproduce against the narrowed candidate (transient/
  //    order-dependent failure) and no mutant can honestly be named.
  //    Skipped when the search space WAS the singleton — the top-of-function
  //    check already proved that exact subset fails.
  if (mutants.length > 1 && (await compiles([culprit]))) {
    return {
      kind: "environmental",
      detail: "narrowed candidate compiles on its own; the failure did not reproduce against it",
    };
  }
  // 2. The complement must compile without it. If the failure reproduces
  //    even with the candidate excluded, the cause is environmental (version
  //    monotonicity, transport, licence, ...) and reproduces regardless of
  //    subset — exactly the shape that funnels the search to candidates[0].
  const complement = mutants.filter((m) => m !== culprit);
  if (!(await compiles(complement))) {
    return {
      kind: "environmental",
      detail: "failure reproduces even with the candidate excluded",
    };
  }
  return { kind: "culprit", culprit };
}
