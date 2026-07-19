import type { ALSyntaxNode } from "@lethal/engine";

export interface WrapInput {
  readonly mutantId: string;
  readonly original: ALSyntaxNode;
  readonly replacement: string | null;
}

/**
 * Retained but no longer routed to. Layer 4.3 (`compile.ts`) replaced the
 * per-spec statement-position/expression-position/short-circuit-operand
 * dispatch that used to call `wrapStatement` (alongside `liftExpression` in
 * `lift.ts` and `duplicateEnclosing` in `duplicate.ts`) with component-based
 * flat dispatch chains: `components.ts` groups overlapping specs and
 * `dispatch.ts`'s `emitDispatch` builds each chain's text directly, so
 * nothing in `compile.ts` calls `wrapStatement` anymore — its only
 * remaining caller is its own test (`tests/wrap.test.ts`). Kept in the
 * package for possible narrow future use.
 */
export function wrapStatement(input: WrapInput): string {
  const originalText = input.original.text;
  // Both branches are wrapped in `begin...end`, mirroring `duplicateEnclosing`
  // (packages/schemata/src/duplicate.ts) — verified necessary against a real
  // AL compiler: `original`/`replacement` can themselves be compound
  // statements whose OWN text already ends in a `;` (e.g. an `if_statement`
  // or a whole procedure-body `block` — both include their closing `;` in
  // `.text`, unlike `exit_statement`/`assignment_statement`/a bare call,
  // which don't). Emitting that text directly as a bare "then <text>" branch
  // then produces `if G then if C then S; else ...` — the inner `;` closes
  // the OUTER if too, orphaning the `else` (AL0110 "Orphaned ELSE
  // statement"). Wrapping unconditionally in `begin...end` is valid AL
  // regardless of what the branch content is (a stray extra `;` inside a
  // block, from source text whose own trailing `;` sits just outside the
  // replaced range, compiles fine as an empty statement — verified), so
  // there is no need to special-case by statement kind here.
  if (input.replacement === null) {
    return `if not MutationSelector.Active('${input.mutantId}') then begin\n  ${originalText}\nend;`;
  }
  return `if MutationSelector.Active('${input.mutantId}') then begin\n  ${input.replacement}\nend else begin\n  ${originalText}\nend;`;
}
