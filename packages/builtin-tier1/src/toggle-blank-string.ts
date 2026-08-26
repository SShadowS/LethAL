import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.toggle-blank-string";
const OPERATOR_VERSION = "1.0.0";

/**
 * The non-blank stand-in. ONE character, deliberately.
 *
 * AL string types carry a length (`Code[10]`, `Text[1]`), and a replacement longer than the target
 * overflows at runtime — a kill that says nothing about the test, which is the false-kill shape R121
 * screens for and the one `swap-multiplicative` was refused over. A single character fits every
 * string type that can hold anything at all, so the mutation cannot overflow by construction.
 *
 * `Code` uppercases on assignment, so this becomes `X` there. That is irrelevant to the mutation's
 * purpose — the point is blank versus not-blank, never the character itself.
 */
const NON_BLANK = "'x'";
const BLANK = "''";

/**
 * Parent kinds where a string literal is a value the program BRANCHES ON or STORES.
 *
 * Measured by `scripts/census-literal-contexts.ts` on `do-rel2/Cloud`: of 12,835 literals, 54.2% are
 * declarative properties (Caption, ToolTip) that R135 already refuses, 16.7% are call arguments whose
 * meaning depends on a callee this layer cannot resolve, 2.0% are filter arguments belonging to
 * `flip-filter-literal`, and 2.0% are message text where a mutation changes what a user reads rather
 * than what the program does. What is left, and what this claims, is the comparison operand and the
 * assigned value.
 */
const BEHAVIOURAL_PARENTS: ReadonlySet<string> = new Set([
  ALNodeKind.comparison_expression,
  ALNodeKind.assignment_statement,
]);

/**
 * `ToggleBlankString`: a blank string literal becomes non-blank, and a non-blank one becomes blank.
 *
 * ROADMAP R159. `string_literal` was the largest kind the node-kind census left unclaimed, and this
 * row's first instinct — recorded there and wrong — was that it should be REFUSED because most
 * literals are labels and messages. Measuring it took three passes, each of which changed the answer:
 *
 *   1. **4,892** literals inside procedure or trigger bodies. The raw kind count, and not a
 *      candidate: it includes declarative properties, message text and filter arguments.
 *   2. **1,102** after keeping only the two contexts where a literal is a value the program branches
 *      on or stores. That is the number the row was corrected to.
 *   3. **821 of those 1,102 are ALREADY `''`.** `if X = ''` is the ordinary BC blank check, and
 *      blanking a blank is a no-op mutant — worse than useless, since it would be scored.
 *
 * A one-directional "replace with the empty string" operator therefore claims **281** sites, not
 * 1,102. Both directions claim all 1,102, and the direction the naive design would have skipped is
 * the LARGER one: 714 of the 821 blanks are comparison operands, where making the literal non-blank
 * flips a blank check that a suite may never exercise with a blank value.
 *
 * That is the whole finding. An operator scoped from a kind count would have shipped covering a
 * quarter of its own ground.
 *
 * **Why it compiles.** A string literal is legal wherever another string literal is, and the
 * non-blank form is ONE character so it cannot overflow a length-constrained target. There is no
 * type inference here to get wrong.
 *
 * **No `PlatformKillMechanism`, following `remove-assignment`'s precedent rather than re-deciding
 * it.** Blanking a value that becomes a primary key can raise a duplicate-key or blank-key error with
 * no test asserting anything. That is real, and it is exactly what `remove-assignment` does when it
 * deletes `Rec."No." := CardNo` — measured on the gift card demo the same week, where that mutant was
 * killed HONESTLY by a test that reads the record back. R138's mechanisms are for a mutation that
 * skips a TRIGGER while leaving control flow alone; changing a written value is ordinary changed
 * behaviour, and R121's screen is what tells a reader a kill carried no assertion.
 *
 * **Documented limits:**
 *   - Equivalence is not detected. `if X = 'FOO'` becoming `if X = ''` changes the branch only where
 *     a test drives `X` to one of those values; elsewhere it is an equivalent mutant.
 *   - The non-blank form is a stand-in, not a meaningful value. This operator answers "does anything
 *     depend on this being blank or not", never "does anything depend on it being this exact text".
 */
export const toggleBlankString: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  // `text_literal` is the ENUM KEY; its value is the raw `"string_literal"`. Getting that backwards
  // is R120's hazard and it bit here: the first draft wrote `ALNodeKind.string_literal`, which is
  // `undefined`, so the predicate compared against undefined and the operator claimed NOTHING while
  // type-checking cleanly. The conformance suite caught it; nothing else would have.
  targetNodeKinds: [ALNodeKind.text_literal],
  producesNodeKinds: [ALNodeKind.text_literal],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return toggled(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const after = toggled(node);
    if (after === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, after),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "blanks a non-blank comparison operand",
      sourceAL: `codeunit 51900 "S" { procedure P(C: Code[20]): Integer begin if C = 'FOO' then exit(1); exit(0); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "'FOO'", afterText: "''" },
      ],
    },
    {
      name: "UN-blanks a blank comparison operand: the larger direction, and the one a naive design skips",
      sourceAL: `codeunit 51901 "S" { procedure P(C: Code[20]): Integer begin if C = '' then exit(1); exit(0); end; }`,
      expectedSpecs: [{ parentContext: "statement-position", beforeText: "''", afterText: "'x'" }],
    },
    {
      name: "blanks an assigned value",
      sourceAL: `codeunit 51902 "S" { procedure P() var C: Code[20]; begin C := 'FOO'; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "'FOO'", afterText: "''" },
      ],
    },
    {
      name: "REFUSES a declarative property, which R135 rules out",
      sourceAL: `table 51903 "T" { Caption = 'Hello'; fields { field(1; "No."; Code[20]) { } } }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a message argument: it changes what a user reads, not what the program does",
      sourceAL: `codeunit 51904 "S" { procedure P() begin Error('something went wrong'); end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a filter argument, which flip-filter-literal owns",
      sourceAL: `codeunit 51905 "S" { procedure P() var Cust: Record Customer; begin Cust.SetFilter("No.", '<>%1', 'A'); end; }`,
      expectedSpecs: [],
    },
  ],
};

/** The toggled literal text, or `null` where this operator does not claim the site. */
function toggled(node: ALSyntaxNode): string | null {
  if (node.rawKind !== ALNodeKind.text_literal) return null;
  const parent = node.parent;
  if (parent === null || !BEHAVIOURAL_PARENTS.has(parent.rawKind)) return null;
  // Executable only. An allow-list, for the reason `flip-boolean-literal` learned the hard way: a
  // deny-list of declarative parents is only ever as complete as the last person's memory.
  if (!inExecutableBody(node)) return null;
  const inner = node.text.replace(/^'/, "").replace(/'$/, "");
  return inner.length === 0 ? NON_BLANK : BLANK;
}

function inExecutableBody(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}
