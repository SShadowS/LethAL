import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.loop-truncate";
const OPERATOR_VERSION = "1.0.0";

/**
 * `LoopTruncate`: rewrite a `repeat` loop's exit condition to `true`, so the body runs exactly once.
 *
 * ROADMAP R164, designed in `docs/superpowers/specs/2026-08-26-r164-loop-truncate-design.md`.
 *
 * **What a survivor means, which is unusually specific.** No test drives this loop over more than one
 * row. That is the most common weakness in a BC suite, and until now nothing said it: the loop was
 * either unmutated or mutated into a mutant that never returns.
 *
 * **Why this operator exists at all is a COST argument, not a coverage one.** `negate-conditional`
 * already claims the same span, and on the canonical BC shape its mutant does not terminate:
 *
 * ```al
 * repeat BODY until Rec.Next() = 0;     // original: BODY per row
 * repeat BODY until Rec.Next() <> 0;    // >=2 rows: BODY once. <=1 row: NEVER TERMINATES
 * repeat BODY until true;               // BODY once, always
 * ```
 *
 * A one-row fixture is the common case, so a large share of those strand their tier on the default
 * path, where `--stop-hung-sessions` is off because it ends a session on the user's own server.
 * Measured on `do-rel2/Cloud`: 334 `repeat` loops, **313** comparing against `.Next(...)` and **292**
 * matching `<rec>.Next(...) = 0` exactly.
 *
 * **The cession is the load-bearing half, and it had to be coded.** §3.2 dedup keys on the
 * replacement TEXT as well as the span (`packages/schemata/src/dedup.ts`), so `Rec.Next() <> 0` and
 * `true` at one span are two identities and BOTH survive. Tier precedence cannot displace the
 * hanging mutant, whatever tier this operator is given. `negate-conditional` therefore refuses a
 * `repeat` exit condition outright, which also makes it consistent with `shift-integer` and
 * `negate-guard`, both of which already refuse loop conditions for this same reason.
 *
 * **Documented limits:**
 *   - **`repeat` only.** `while <cond>` has no "run once" rewrite (`while false` runs the body ZERO
 *     times, a different mutation with its own overlap question), and `for`/`foreach` carry no
 *     boolean exit condition. 92 loops on the corpus are deliberately left alone.
 *   - A loop whose covering test drives exactly ONE iteration yields an equivalent mutant, because
 *     truncating to one changes nothing there. That is honest signal rather than noise: it is the
 *     same fact a survivor reports, seen from the other side.
 *   - `conditional-boundary`, `remove-not` and `toggle-blank-string` also claim loop conditions (19
 *     sites at `repeat` between them) and are NOT ceded, because a boundary shift usually runs a
 *     loop one extra iteration rather than forever, and ceding would delete working, terminating,
 *     killed mutants from a gate. The residual is recorded on the roadmap rather than absorbed here.
 */
export const loopTruncate: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: [ALNodeKind.repeat_statement],
  producesNodeKinds: [ALNodeKind.boolean_literal],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return exitCondition(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const cond = exitCondition(node);
    if (cond === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${cond.startIndex}-${cond.endIndex}`,
        before: cond,
        after: synthesizeAfter(cond, "true"),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "truncates the canonical recordset walk",
      sourceAL: `codeunit 51700 "L" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then repeat Cust.Mark(true); until Cust.Next() = 0; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Cust.Next() = 0", afterText: "true" },
      ],
    },
    {
      name: "truncates a counter-driven loop too, since the shape is not restricted to recordsets",
      sourceAL: `codeunit 51701 "L" { procedure P(Limit: Integer) var N: Integer; begin repeat N += 1; until N >= Limit; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "N >= Limit", afterText: "true" },
      ],
    },
    {
      name: "REFUSES a while loop: `while false` runs the body zero times, a different mutation",
      sourceAL: `codeunit 51702 "L" { procedure P(Limit: Integer) var N: Integer; begin while N < Limit do N += 1; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a for loop, which has no boolean exit condition to rewrite",
      sourceAL: `codeunit 51703 "L" { procedure P(Limit: Integer) var N: Integer; T: Integer; begin for N := 1 to Limit do T += N; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a repeat outside an executable body",
      sourceAL: `table 51704 "T" { fields { field(1; "No."; Code[20]) { } } }`,
      expectedSpecs: [],
    },
  ],
};

/**
 * The `repeat` loop's exit condition, or `null` where this operator does not claim it.
 *
 * The condition is read through `childForFieldName`, never by position: a `repeat` body is a
 * statement list of arbitrary length, so "the last child" is the wrong way to find it and would
 * quietly claim a statement on a grammar change.
 */
function exitCondition(node: ALSyntaxNode): ALSyntaxNode | null {
  if (node.rawKind !== ALNodeKind.repeat_statement) return null;
  if (!inExecutableBody(node)) return null;
  const cond = node.childForFieldName("condition");
  if (cond === null) return null;
  // `until true` is already the mutated form, so mutating it again is a no-op that would ship an
  // unkillable mutant. Nothing in real AL writes it, but the check is free and the failure is silent.
  if (cond.text.trim().toLowerCase() === "true") return null;
  return cond;
}

/**
 * Inside a procedure or trigger body, an ALLOW-list for the reason `shift-integer`'s doc comment
 * gives: a deny-list of declarative parents is only ever as complete as the last person's memory.
 */
function inExecutableBody(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}
