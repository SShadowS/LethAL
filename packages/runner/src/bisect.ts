/**
 * Isolate the mutants whose presence breaks compilation (R734).
 *
 * One artifact means a bad mutant would otherwise turn every mutant in the session into an error
 * (design spec §6). This names each breaking mutant by compiling subsets, so the caller can score
 * the rest. A mutant is named only after it fails ALONE. A pair that fails only together is
 * reported as a group, never as two culprits. Nothing is blamed when the empty set fails too.
 */

/** What isolation concluded. Every mutant of the input is in at most one of the three lists. */
export type IsolationOutcome<T> =
  /** The full set compiles: the observed failure did not reproduce. */
  | { readonly kind: "no-repro" }
  /**
   * The failure is not attributable to any mutant: the empty set fails too (BC app-version
   * monotonicity, transport, licence, a resource limit). Nobody is blamed.
   */
  | { readonly kind: "environmental"; readonly detail: string }
  | {
      readonly kind: "isolated";
      /** Each fails to compile on its own. */
      readonly culprits: readonly T[];
      /** Fail only together (a pair), or the interaction is wider than a pair: not blamed one by one. */
      readonly groupErrors: readonly T[];
      /**
       * Not examined, or not resolved: the compile budget ran out, or an interaction wider than a
       * pair was found. Their compile state is UNKNOWN: they are never redeployed or scored.
       */
      readonly unresolved: readonly T[];
    };

/**
 * The most compiles one isolation may spend. Each culprit costs about log2(n) + 2.
 * ponytail: a fixed budget; R735 (alc's diagnostics name the suspects) is the way to isolate many
 * culprits inside it.
 */
export const MAX_ISOLATION_COMPILES = 64;

class BudgetSpent extends Error {}

/**
 * `compile(subset)` answers true when the subset compiles, false when alc rejects it, and THROWS
 * for anything that is not a compile answer (the search then aborts).
 */
export async function isolateBreakingMutants<T>(
  mutants: readonly T[],
  compile: (subset: readonly T[]) => Promise<boolean>,
  cap: number = MAX_ISOLATION_COMPILES,
): Promise<IsolationOutcome<T>> {
  let used = 0;
  const probe = async (subset: readonly T[]): Promise<boolean> => {
    if (used >= cap) throw new BudgetSpent();
    used++;
    return compile(subset);
  };
  // Smallest prefix of `pool` that, added to `base`, breaks the compile; returns that last element.
  // Needs: base + pool fails, base alone compiles.
  const lastNeeded = async (pool: readonly T[], base: readonly T[]): Promise<T | undefined> => {
    let lo = 0; // base + pool[0..lo) compiles
    let hi = pool.length; // base + pool[0..hi) fails
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await probe([...base, ...pool.slice(0, mid)])) lo = mid;
      else hi = mid;
    }
    return pool[hi - 1];
  };

  let remaining = [...mutants];
  const culprits: T[] = [];
  const groupErrors: T[] = [];
  try {
    // Before blaming anyone: does the artifact with NO mutant compile?
    if (!(await probe([]))) {
      return { kind: "environmental", detail: "deploy fails with no mutants present" };
    }
    if (remaining.length === 0 || (await probe(remaining))) return { kind: "no-repro" };
    // Invariant: `remaining` fails to compile, and the empty set compiles.
    for (;;) {
      // Early stop: a round on n mutants costs ceil(log2 n) searches, 1 confirm and 1 recompile
      // (nothing when n is 1). Do not start one the budget cannot finish: it would spend the rest
      // of the budget and name nobody.
      const roundCost = remaining.length <= 1 ? 0 : Math.ceil(Math.log2(remaining.length)) + 2;
      if (cap - used < roundCost) {
        return { kind: "isolated", culprits, groupErrors, unresolved: remaining };
      }
      const c = await lastNeeded(remaining, []);
      if (c === undefined)
        return { kind: "isolated", culprits, groupErrors, unresolved: remaining };
      if (remaining.length === 1 || !(await probe([c]))) {
        culprits.push(c);
        remaining = remaining.filter((m) => m !== c);
      } else {
        // `c` compiles alone: it breaks the compile only together with something before it.
        const before = remaining.slice(0, remaining.indexOf(c));
        const d = await lastNeeded(before, [c]);
        if (d === undefined || (await probe([c, d]))) {
          return { kind: "isolated", culprits, groupErrors, unresolved: remaining };
        }
        groupErrors.push(c, d);
        remaining = remaining.filter((m) => m !== c && m !== d);
      }
      if (remaining.length === 0 || (await probe(remaining))) {
        return { kind: "isolated", culprits, groupErrors, unresolved: [] };
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetSpent)) throw err;
    return { kind: "isolated", culprits, groupErrors, unresolved: remaining };
  }
}
