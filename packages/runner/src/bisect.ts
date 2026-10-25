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
 * The most compiles one isolation may spend. Halving costs about log2(n) + 2 per culprit; alc's
 * own diagnostics (R735) bring that to about 2 per culprit when they point at the right place.
 */
export const MAX_ISOLATION_COMPILES = 64;

/**
 * R743: how many of one round's suspects may compile fine ALONE (innocents) before that round stops
 * trying suspects and halves instead. A cascade (one culprit whose error alc reports on many later
 * branches) would otherwise spend the budget on innocents. A suspect that fails alone does not
 * count, so a round naming many real culprits is unchanged.
 */
export const MAX_CLEARED_SUSPECTS_PER_ROUND = 8;

class BudgetSpent extends Error {}

export interface AlcDiag {
  readonly code: string;
  readonly file: string;
  readonly line: number;
}

/** The `error ALnnnn` lines of alc output, as code + file name + line. Message text is dropped. */
export function parseAlcErrors(text: string): AlcDiag[] {
  const out: AlcDiag[] = [];
  const re = /^(.*?)\((\d+),\d+(?:,\d+,\d+)?\):\s*error\s+(AL\d+|[A-Z]{2,}\d+)\b/;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw.trim());
    if (m === null) continue;
    out.push({
      code: m[3] as string,
      file: (m[1] as string).replaceAll("\\", "/").split("/").pop() as string,
      line: Number(m[2]),
    });
  }
  return out;
}

const ACTIVE_GUARD = /\.Active\('(M[^']*)'\)/;

/**
 * R735: the mutant id of the dispatch branch that holds `line` (1-based) of an emitted file, or
 * `undefined` when no guard lies above it or the line is out of range. A chain is
 * `if SEL.Active('Mi') then begin <root with Mi> end else if ...`, so the branch is the nearest
 * guard line at or above. An error ON a guard line is the previous branch's: alc reports a missing
 * token at the start of the NEXT line (R734 proof, AL0111), so the scan starts one line up. The
 * `else` branch (the original text) reads as the last member: a wrong pointer that costs one
 * compile and blames nobody.
 */
export function guardGoverning(text: string, line: number): string | undefined {
  const lines = text.split(/\r?\n/);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return undefined;
  let at = line - 1;
  if (ACTIVE_GUARD.test(lines[at] ?? "")) at--;
  for (; at >= 0; at--) {
    const m = ACTIVE_GUARD.exec(lines[at] ?? "");
    if (m !== null) return m[1];
  }
  return undefined;
}

/**
 * `compile(subset)` answers true when the subset compiles, false when alc rejects it, or an array
 * when alc rejects it AND pointed at those mutants (R735; an empty array is the same as false), and
 * THROWS for anything that is not a compile answer (the search then aborts).
 * Pointed-at mutants are only suspects: each is confirmed by compiling it alone.
 */
export async function isolateBreakingMutants<T>(
  mutants: readonly T[],
  compile: (subset: readonly T[]) => Promise<boolean | readonly T[]>,
  cap: number = MAX_ISOLATION_COMPILES,
): Promise<IsolationOutcome<T>> {
  let used = 0;
  let lastSuspects: readonly T[] = [];
  const probe = async (subset: readonly T[]): Promise<boolean> => {
    if (used >= cap) throw new BudgetSpent();
    used++;
    const answer = await compile(subset);
    if (answer === true) return true;
    lastSuspects = answer === false ? [] : answer;
    return false;
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
    // `pointed`: what alc named in the last failing compile of `remaining`. `cleared`: compiled
    // alone and fine, so never tried alone again (it may still be half of a pair).
    // A diagnostic that cascades onto innocent mutants costs one compile each, up to
    // MAX_CLEARED_SUSPECTS_PER_ROUND per round (R743); then the round halves.
    let pointed = lastSuspects;
    const cleared = new Set<T>();
    for (;;) {
      // Suspects first, BEFORE the early stop below (which guards only halving).
      let found = false;
      let clearedThisRound = 0;
      for (const s of pointed) {
        if (clearedThisRound >= MAX_CLEARED_SUSPECTS_PER_ROUND) break;
        if (!remaining.includes(s) || cleared.has(s)) continue;
        if (await probe([s])) {
          cleared.add(s);
          clearedThisRound++;
        } else {
          culprits.push(s);
          remaining = remaining.filter((x) => x !== s);
          found = true;
        }
      }
      pointed = [];
      if (found) {
        if (remaining.length === 0 || (await probe(remaining))) {
          return { kind: "isolated", culprits, groupErrors, unresolved: [] };
        }
        pointed = lastSuspects;
        continue;
      }
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
      pointed = lastSuspects;
    }
  } catch (err) {
    if (!(err instanceof BudgetSpent)) throw err;
    return { kind: "isolated", culprits, groupErrors, unresolved: remaining };
  }
}
