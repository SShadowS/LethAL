import { isStatementSlot } from "@lethal/engine";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.remove-assignment";
const OPERATOR_VERSION = "1.0.0";

/**
 * `RemoveAssignment`: delete an assignment statement.
 *
 * ROADMAP R159. `assignment_statement` is the largest kind the node-kind census leaves unclaimed:
 * **6,850 occurrences** inside procedure and trigger bodies on `do-rel2/Cloud`, with **zero**
 * exact-span overlap against any shipped operator. That is 527x R13's bar of 13.
 *
 * It is the direct analogue of `void-method-call`, which deletes a statement-position CALL and has
 * shipped since Layer 2. The two are the same mutation applied to the two statement forms AL has,
 * and this one deliberately reuses that operator's emit shape rather than deriving a new one:
 * `isStatementSlot` for the predicate (R161 widened it from `isStatementPosition` so an un-braced
 * branch body counts), empty replacement text, and `parentContext: "statement-position"` so the
 * compiler resolves the site by walking to the enclosing statement.
 *
 * **What it catches.** A field set before an `Insert` that nothing asserts, a flag assigned and never
 * read, an accumulator step that no test's expected total depends on. Deleting the statement leaves
 * the target at whatever it already held — its AL type default on a fresh variable — so the mutant
 * is a real behaviour change wherever the value is read again.
 *
 * **Why it compiles.** Deleting a whole statement cannot leave an expression fragment, and the one
 * shape that could bite — a statement that is the entire un-braced body of an `if`/`while`/`for`,
 * where removal would leave a dangling `then` — is handled by the compiler's `emptiedSlotFiller`
 * (R161), which supplies the `;`. That is machinery this operator inherits rather than re-invents,
 * because `void-method-call` already needed it for exactly the same reason.
 *
 * **No `PlatformKillMechanism`.** Deleting a statement is ordinary changed behaviour, and
 * `void-method-call` — the same deletion at the same grain — declares none.
 *
 * **Documented limits:**
 *   - **Equivalence is the real cost here, more than for most operators.** An assignment whose
 *     target is never read again is an equivalent mutant, and nothing in a source-derived layer can
 *     see that without dataflow the semantic layer does not have. Expect a higher survivor rate than
 *     `void-method-call`'s, and read those survivors as leads rather than defects.
 *   - **An overlap this operator cannot measure.** Where the right-hand side is a boolean literal
 *     (904 of the 6,850) and the target is otherwise unassigned, deleting the statement and flipping
 *     the literal with `flip-boolean-literal` can reach the SAME observable state, because AL
 *     initialises a fresh `Boolean` to `false`. They are distinct mutations whenever the target
 *     already held a value, so this is a partial equivalence rather than a duplicate, and separating
 *     the two cases needs dataflow. Recorded rather than assumed away.
 *   - Compound assignment (`+=`, `-=`) is the same node kind and is claimed on the same terms.
 */
export const removeAssignment: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: [ALNodeKind.assignment_statement],
  producesNodeKinds: [ALNodeKind.assignment_statement],
  requiresSemantic: [],
  // R172: 16 survivors on `itest:tables` in one wave, and its own doc comment names an assignment whose target is never read again as the shape it cannot see.
  equivalenceRisk: "value-rewrite",

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.rawKind !== ALNodeKind.assignment_statement) return false;
    // Only in a statement SLOT, the same test `void-method-call` uses. An assignment that is not in
    // one is not a statement this compiler can remove.
    return isStatementSlot(node);
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    if (!removeAssignment.targets(node, {} as SemanticContext)) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, ""),
        parentContext: "statement-position",
      },
    ];
  },

  // `beforeText` carries no trailing `;`: the semicolon is a separate token, not part of the
  // `assignment_statement` node, exactly as `void-method-call`'s `DoThing()` carries none. Deleting
  // the node leaves a bare `;`, which is a valid empty statement in AL — established behaviour that
  // operator has relied on since Layer 2.
  conformanceTests: [
    {
      name: "deletes a plain assignment",
      sourceAL: `codeunit 51800 "A" { procedure P() var Total: Integer; begin Total := 5; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Total := 5", afterText: "" },
      ],
    },
    {
      name: "deletes an assignment to a record field",
      sourceAL: `codeunit 51801 "A" { procedure P() var Cust: Record Customer; begin Cust.Blocked := true; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Cust.Blocked := true", afterText: "" },
      ],
    },
    {
      name: "deletes a compound assignment",
      sourceAL: `codeunit 51802 "A" { procedure P() var Total: Integer; begin Total += 5; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Total += 5", afterText: "" },
      ],
    },
    {
      name: "deletes the un-braced body of an if, which the compiler then fills with a ;",
      sourceAL: `codeunit 51803 "A" { procedure P(F: Boolean) var Total: Integer; begin if F then Total := 5; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Total := 5", afterText: "" },
      ],
    },
  ],
};
