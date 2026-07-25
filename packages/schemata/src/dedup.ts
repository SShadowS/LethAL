import type { MutationSpec } from "@lethal/engine";

/**
 * Resolves an operator's tier by name.
 *
 * `MutationSpec` carries no tier — tier is a property of the OPERATOR
 * (`packages/engine/src/operator/interface.ts`), and a spec records only which
 * operator produced it. The caller therefore supplies the mapping rather than
 * dedup inventing one.
 */
export type TierResolver = (operatorName: string) => 1 | 2 | 3 | "custom" | undefined;

/** Identity of an emitted mutation: same site, same replacement text. */
function identityOf(spec: MutationSpec): string {
  return `${spec.before.startIndex}:${spec.before.endIndex}:${spec.after.text}`;
}

function tierRank(spec: MutationSpec, tierOf: TierResolver): number {
  // Specificity, not registration order. `custom` has no defined position and an
  // unregistered operator has no tier at all; both are caller-contract
  // violations rather than precedence questions — see the throws below.
  const tier = tierOf(spec.operatorName);
  return tier === 2 ? 2 : tier === 1 ? 1 : Number.NaN;
}

/**
 * Drop mutants that would emit byte-identical AL at the same site, keeping the
 * more specific operator.
 *
 * Runs BEFORE `assignMutantIds` and before compilation: dropping a mutant only
 * from the manifest would leave it compiled into the dispatch chain holding an
 * ID — an unreported mutation that still exists in the artifact.
 *
 * A `likely-equivalent` mutant never suppresses a scored one. Otherwise an
 * overbroad Tier-2 predicate would replace a fully scored Tier-1 mutant with one
 * excluded from the mutation score, hiding both the real mutant and the bug.
 */
export function dedupeSpecs(
  specs: readonly MutationSpec[],
  tierOf: TierResolver,
): readonly MutationSpec[] {
  const winners = new Map<string, MutationSpec>();
  for (const spec of specs) {
    const id = identityOf(spec);
    const held = winners.get(id);
    if (held === undefined) {
      winners.set(id, spec);
      continue;
    }
    if (tierOf(held.operatorName) === tierOf(spec.operatorName)) {
      throw new Error(
        `dedupeSpecs: operators "${held.operatorName}" and "${spec.operatorName}" both claim the same mutation at ${spec.before.startIndex}-${spec.before.endIndex}; the winner would depend on registration order`,
      );
    }
    const heldHinted = held.equivalenceHint === "likely-equivalent";
    const specHinted = spec.equivalenceHint === "likely-equivalent";
    if (heldHinted !== specHinted) {
      winners.set(id, heldHinted ? spec : held);
      continue;
    }
    const rank = tierRank(spec, tierOf);
    const heldRank = tierRank(held, tierOf);
    if (Number.isNaN(rank) || Number.isNaN(heldRank)) {
      throw new Error(
        `dedupeSpecs: cannot order "${held.operatorName}" against "${spec.operatorName}" at ${spec.before.startIndex}-${spec.before.endIndex} — one of them is unregistered or custom-tier, and neither has a defined precedence against a builtin`,
      );
    }
    if (rank > heldRank) winners.set(id, spec);
  }
  return [...winners.values()];
}
