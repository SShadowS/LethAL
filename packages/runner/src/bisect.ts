/**
 * Binary-search for a mutant whose presence breaks compilation.
 *
 * One artifact means one bad mutant would otherwise turn every mutant in the
 * session into an error with no indication of which one was at fault (design
 * spec §6). This narrows it to a name in O(log n) compiles.
 */
export async function bisectFailingMutant<T>(
  mutants: readonly T[],
  compiles: (subset: readonly T[]) => Promise<boolean>,
): Promise<T | null> {
  if (await compiles(mutants)) return null;

  let candidates = [...mutants];
  while (candidates.length > 1) {
    const mid = Math.floor(candidates.length / 2);
    const left = candidates.slice(0, mid);
    candidates = (await compiles(left)) ? candidates.slice(mid) : left;
  }
  return candidates[0] ?? null;
}
