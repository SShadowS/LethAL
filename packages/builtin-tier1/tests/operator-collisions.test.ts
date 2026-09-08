import { beforeAll, describe, expect, it } from "bun:test";
import {
  type MutationSpec,
  buildSemanticContext,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import type { ALSyntaxNode } from "@lethal/engine";
import { type TierResolver, dedupeSpecs } from "@lethal/schemata";
import { tier1Operators } from "../src/index";

/**
 * Two operators claiming ONE mutation identity is a crash, not a warning.
 *
 * `dedupeSpecs` throws when two operators produce the same replacement at the same span, on the
 * stated principle that the winner must not depend on registration order. That is the right call,
 * and it means an operator seam that overlaps takes the whole run down at planning time, before a
 * single mutant is measured, with no partial result.
 *
 * That is what issue #7 was: `repeat ... until false;` is ordinary AL, `loop-truncate` rewrites a
 * repeat's exit condition to `true`, and `flip-boolean-literal` flipped the same `false` to the
 * same `true` at the same span. Any project containing that idiom could not be measured at all.
 *
 * Nothing was checking for it. The per-operator conformance suites each prove one operator in
 * isolation, and a collision is by definition a property of a PAIR. This file is that check.
 */
describe("operator collisions", () => {
  beforeAll(async () => {
    await initParser();
  });

  const tiers = new Map(tier1Operators.map((o) => [o.name, o.tier]));
  const tierOf: TierResolver = (name) => tiers.get(name);

  /** Every spec every Tier-1 operator emits for one source. */
  function allSpecsFor(source: string): MutationSpec[] {
    const root = wrapRoot(parseAL(source));
    const ctx = buildSemanticContext([{ path: "collision.al", root }]);
    const specs: MutationSpec[] = [];
    const walk = (n: ALSyntaxNode): void => {
      for (const op of tier1Operators) {
        if (op.targets(n, ctx)) specs.push(...op.generate(n, ctx));
      }
      for (const c of n.children) walk(c);
    };
    walk(root);
    return specs;
  }

  /**
   * The corpus is every operator's own conformance source, so it grows whenever anyone adds an
   * operator or a case, and nobody has to remember to extend a list here. Those sources are also
   * the shapes most likely to collide: each was written to sit exactly on some operator's seam.
   */
  it("no two Tier-1 operators claim the same mutation on any conformance source", () => {
    const sources = tier1Operators.flatMap((op) =>
      op.conformanceTests.map((c) => ({ op: op.name, name: c.name, sourceAL: c.sourceAL })),
    );

    // A corpus that silently emptied would make this test pass while checking nothing, which is the
    // failure mode this repository is most prone to. The floor is deliberately well under the
    // current count so adding operators never reddens it.
    expect(sources.length).toBeGreaterThanOrEqual(50);

    const collisions: string[] = [];
    for (const s of sources) {
      try {
        dedupeSpecs(allSpecsFor(s.sourceAL), tierOf);
      } catch (err) {
        collisions.push(`${s.op} / ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  /**
   * Issue #7's own reproduction, kept by name and separate from the corpus sweep above.
   *
   * The sweep would catch a regression here only for as long as the refusal's conformance case
   * lives in `flip-boolean-literal`. This one states the shape the user actually reported, so
   * deleting that case cannot quietly delete the guard with it.
   */
  it("plans `repeat ... until false;` without a collision (issue #7)", () => {
    const source = `codeunit 50000 ReproLoopTruncate
{
    procedure CountToThree(): Integer
    var
        I: Integer;
    begin
        I := 0;
        repeat
            I += 1;
            if I >= 3 then
                exit(I);
        until false;
    end;
}`;
    const specs = allSpecsFor(source);
    expect(() => dedupeSpecs(specs, tierOf)).not.toThrow();

    // `loop-truncate` must still claim the site. The fix was a cession, so if both operators went
    // quiet the crash would be gone and the coverage with it, which no "does not throw" assertion
    // would notice.
    const atUntil = specs.filter((s) => s.before.text === "false");
    expect(atUntil.map((s) => s.operatorName)).toEqual(["lethal.loop-truncate"]);
  });
});
