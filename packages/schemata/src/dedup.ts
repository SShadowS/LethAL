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

/**
 * Identity of an emitted mutation: same NODE at the same site, same replacement text.
 *
 * `before.kind` is part of the identity, not decoration. A span alone conflates a parent with a
 * same-span child — `Rec.TestField(Name)` as a `call_expression` and the statement wrapping it
 * can carry byte-identical start/end offsets, and two operators targeting those two different
 * nodes are producing two different mutations that merely happen to print the same text. Merging
 * them by span drops a real mutant (or, worse, raises a spurious same-tier collision).
 */
function identityOf(spec: MutationSpec): string {
  return `${spec.before.kind}:${spec.before.startIndex}:${spec.before.endIndex}:${spec.after.text}`;
}

function tierRank(spec: MutationSpec, tierOf: TierResolver): number {
  // Specificity, not registration order. `custom` has no defined position and an
  // unregistered operator has no tier at all; both are caller-contract
  // violations rather than precedence questions — see the throws below.
  //
  // TIER 3 IS DELIBERATELY ABSENT, and this is a decision rather than a gap (R11, closed by R13:
  // `docs/superpowers/specs/2026-08-02-r13-tier3-decision.md`). Tier 3 was measured and none of
  // its three sketched operators is built, so a third rank would be an ordering nobody has
  // reasoned about, sitting ready to resolve a collision silently. Adding one is only correct
  // together with the first tier-3 operator that ships — never before it. Pinned by
  // "refuses to order a REGISTERED tier-3 operator against a tier-1 one" in tests/dedup.test.ts.
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
 * A `likely-equivalent` mutant never suppresses a plain one. TODAY that hint changes exactly one
 * thing: which of two colliding specs wins here. It does NOT reach `MutantManifestEntry`, the
 * store, or the report — this module is `equivalenceHint`'s only consumer — so a surviving
 * `likely-equivalent` mutant is scored like any other. The rule still matters: an overbroad
 * Tier-2 predicate that tagged itself `likely-equivalent` would otherwise displace the Tier-1
 * mutant at that site, and the reason it was tagged (someone believed it unkillable) is the
 * reason it must not be the one that gets reported. Score exclusion is Tier-2 work; do not read
 * this comment as describing a scoring feature that exists.
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
    const site = `${spec.before.kind} at ${spec.before.startIndex}-${spec.before.endIndex}`;
    // ONE operator emitting the same mutation twice is a bug in that operator — there is no
    // pair to order and no precedence question, so it gets its own message. The pair message
    // ('operators "lethal.a" and "lethal.a" both claim...') reads as an interaction between two
    // operators and sends the reader to the registry instead of to the generate() that
    // double-emitted.
    if (held.operatorName === spec.operatorName) {
      throw new Error(
        `dedupeSpecs: operator "${spec.operatorName}" emitted the same mutation twice at ${site} (identical node, identical replacement text) — that is a bug in the operator's own generate(), not a precedence question between operators`,
      );
    }
    const heldTier = tierOf(held.operatorName);
    const specTier = tierOf(spec.operatorName);
    // Two operators of the SAME tier claiming one site — but only when both tiers are actually
    // orderable. `undefined === undefined` is true, so testing equality first reported two
    // UNREGISTERED operators (and two `custom`-tier ones) as a same-tier collision, blaming
    // "registration order" for what is really "neither has a tier at all" and sending the reader
    // to the wrong fix. Within a tier, operators are specified to match distinct method names, so
    // a genuine same-tier collision is a caller-contract violation however either side is tagged
    // — the equivalence hint below must not quietly promote one into the winner of a collision
    // that should never have happened.
    const orderable = (t: 1 | 2 | 3 | "custom" | undefined) => t !== undefined && t !== "custom";
    if (orderable(heldTier) && orderable(specTier) && heldTier === specTier) {
      throw new Error(
        `dedupeSpecs: operators "${held.operatorName}" and "${spec.operatorName}" both claim the same mutation at ${site}; the winner would depend on registration order`,
      );
    }
    const rank = tierRank(spec, tierOf);
    const heldRank = tierRank(held, tierOf);
    if (Number.isNaN(rank) || Number.isNaN(heldRank)) {
      throw new Error(
        `dedupeSpecs: cannot order "${held.operatorName}" (tier ${String(heldTier)}) against "${spec.operatorName}" (tier ${String(specTier)}) at ${site} — at least one is unregistered, custom-tier, or of a tier with no defined precedence against a builtin`,
      );
    }
    const heldHinted = held.equivalenceHint === "likely-equivalent";
    const specHinted = spec.equivalenceHint === "likely-equivalent";
    if (heldHinted !== specHinted) {
      winners.set(id, heldHinted ? spec : held);
      continue;
    }
    if (rank > heldRank) winners.set(id, spec);
  }
  return [...winners.values()];
}
