import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.swap-enum-member";
const OPERATOR_VERSION = "1.0.0";

/** The grammar's node for `"My Status"::Released`, not declared in `ALNodeKind`. */
const QUALIFIED_ENUM_VALUE = "qualified_enum_value";
/** One arm of a `case`; its label is the `pattern` field. */
const CASE_BRANCH = "case_branch";
const CASE_STATEMENT = "case_statement";

/**
 * `SwapEnumMember`: replace a qualified enum value with a SIBLING of the same enum.
 *
 * ```al
 * SalesLine.Status := SalesLine.Status::Released;   // before
 * SalesLine.Status := SalesLine.Status::Open;       // after
 * ```
 *
 * ROADMAP R162. Measured on `do-rel2/Cloud` (554 files): **2,355 `qualified_enum_value` nodes and
 * not one of them claimed by any operator**, the largest unclaimed BC-semantic surface in the
 * product. By context: 762 in an argument list, 619 as a `case` label, 268 as an assignment
 * right-hand side, 182 nested in an argument, 67 inside an `in` list.
 *
 * **What weak test it catches.** A state-machine test that asserts the operation ran and never
 * asserts the resulting state. The case worth the operator on its own is an INTERFACE-typed enum,
 * where the member decides which implementation codeunit dispatches: nothing else in this product
 * can model a wrong branch of a polymorphic dispatch.
 *
 * ## The four guards
 *
 * 1. **The enum must be one THIS PROJECT declares** (`ctx.symbols.enumValuesOf`, which also folds in
 *    the values an `enumextension` adds). A base-app enum resolves to nothing here, and inventing
 *    its members would emit AL that names a value that may not exist. Same safe direction as every
 *    other Tier-2 receiver proof: unresolvable means refuse.
 * 2. **At least two members**, or there is no sibling to swap to.
 * 3. **The current value must be one of them.** If the text after `::` is not a declared value the
 *    node is not what this operator thinks it is, so it refuses rather than guessing.
 * 4. **In a `case` label, the chosen sibling must not already label another arm of the SAME `case`.**
 *    This one is not caution, it is a compile constraint, MEASURED before the operator was written:
 *    `alc` 18.0 rejects a duplicated label with `error AL0402: Expression "R162 Status"::Open cannot
 *    be specified more than once in a 'case' statement`. Without the guard a single swap fails the
 *    whole project's compile, which arrives as an `AlcCompileError` after the expensive
 *    instrument-and-publish step. The operator walks the siblings in declaration order and takes the
 *    first that is free; if every one is already a label, it emits nothing.
 *
 * ## Which sibling, and why it matters
 *
 * The NEXT member in declaration order, wrapping at the end. Deterministic on purpose: the same
 * source must always yield the same mutant, or two runs of the same project are not comparable and
 * `astSubtreeHash`-keyed history compares mutants that are not the same mutation.
 *
 * ## No `PlatformKillMechanism`
 *
 * There is no mechanism by which this mutation adds an error the unmutated program cannot raise. A
 * downstream `TestField(Status, Status::Open)` raising is the production code's own guard doing its
 * job on a wrong value — an honest kill, and R121's assertion screen is what tells a reader it
 * carried no test assertion.
 *
 * ## Documented limits
 *
 * - An OPTION field's members (`OptionMembers = ' ,Open,Released'`) are a different declaration
 *   shape and are NOT claimed. They are the older form of the same idea and deserve their own
 *   measurement rather than an assumption that this code fits them.
 * - Equivalence is not detected. Swapping to a member the program treats identically (two arms with
 *   the same body) is an equivalent mutant this operator cannot see.
 * - `parentContext` is COMPUTED from `isStatementPosition`, like `swap-find-direction` and
 *   `flip-filter-literal`, because an enum value is overwhelmingly an EXPRESSION and hardcoding
 *   `"statement-position"` would state something measurably false at nearly every site.
 */
export const swapEnumMember: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 2,
  targetNodeKinds: [ALNodeKind.identifier],
  producesNodeKinds: [ALNodeKind.identifier],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    return chooseSibling(node, ctx) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const sibling = chooseSibling(node, ctx);
    if (sibling === null) return [];
    const enumType = node.childForFieldName("enum_type");
    if (enumType === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        // The enum type is reproduced VERBATIM, quotes and casing as written; only the member moves.
        after: synthesizeAfter(node, `${enumType.text}::${sibling}`),
        parentContext: parentContextOf(node),
      },
    ];
  },

  conformanceTests: [
    {
      name: "swaps an enum member for the next one in declaration order",
      sourceAL: `enum 50300 "S" { value(0; Open) { } value(1; Released) { } }
codeunit 50301 "C" { procedure P(): Enum "S" begin exit("S"::Open); end; }`,
      expectedSpecs: [
        {
          parentContext: "expression-position",
          beforeText: '"S"::Open',
          afterText: '"S"::Released',
        },
      ],
    },
    {
      name: "wraps at the end of the declaration order",
      sourceAL: `enum 50302 "S" { value(0; Open) { } value(1; Released) { } }
codeunit 50303 "C" { procedure P(): Enum "S" begin exit("S"::Released); end; }`,
      expectedSpecs: [
        {
          parentContext: "expression-position",
          beforeText: '"S"::Released',
          afterText: '"S"::Open',
        },
      ],
    },
    {
      name: "REFUSES an enum this project does not declare",
      sourceAL: `codeunit 50304 "C" { procedure P() var Cust: Record Customer; begin Cust.Status := "Base Status"::Open; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a single-member enum, which has no sibling",
      sourceAL: `enum 50305 "S" { value(0; Only) { } }
codeunit 50306 "C" { procedure P(): Enum "S" begin exit("S"::Only); end; }`,
      expectedSpecs: [],
    },
  ],
};

/**
 * The member name to swap to, or `null` when any guard refuses.
 *
 * One function for both `targets()` and `generate()` so the two can never disagree about which
 * sites are claimed — the same single-decision shape `validate-to-assign` uses.
 */
function chooseSibling(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  if (node.rawKind !== QUALIFIED_ENUM_VALUE) return null;
  const enumType = node.childForFieldName("enum_type");
  const value = node.childForFieldName("value");
  if (enumType === null || value === null) return null;

  const members = ctx.symbols.enumValuesOf(stripQuotes(enumType.text));
  if (members.length < 2) return null;

  const currentName = stripQuotes(value.text).toLowerCase();
  const index = members.findIndex((m) => m.name.toLowerCase() === currentName);
  if (index < 0) return null;

  const taken = caseLabelsInScope(node);
  // Declaration order, starting after the current member and wrapping, so the choice is
  // deterministic and the first FREE sibling wins.
  for (let step = 1; step < members.length; step++) {
    const candidate = members[(index + step) % members.length];
    if (candidate === undefined) continue;
    if (taken.has(candidate.name.toLowerCase())) continue;
    return candidate.text;
  }
  return null;
}

/**
 * When `node` is the label of a `case` arm, the OTHER labels of that same `case`, lowercased.
 * Empty for a node that is not a case label, in which case nothing is taken.
 *
 * Guard 4's input. See the operator's doc comment for the measured `AL0402` this prevents.
 */
function caseLabelsInScope(node: ALSyntaxNode): ReadonlySet<string> {
  const branch = node.parent;
  if (branch === null || branch.rawKind !== CASE_BRANCH) return new Set();
  if (node.fieldName !== "pattern") return new Set();
  // `case_branch` -> `case_body` -> `case_statement`; walk to the statement so EVERY arm is seen,
  // not just the neighbours inside one body node.
  let current: ALSyntaxNode | null = branch;
  while (current !== null && current.rawKind !== CASE_STATEMENT) current = current.parent;
  if (current === null) return new Set();

  const labels = new Set<string>();
  collectLabels(current, node, labels);
  return labels;
}

function collectLabels(node: ALSyntaxNode, self: ALSyntaxNode, out: Set<string>): void {
  if (node.rawKind === QUALIFIED_ENUM_VALUE && node !== self && node.fieldName === "pattern") {
    const value = node.childForFieldName("value");
    if (value !== null) out.add(stripQuotes(value.text).toLowerCase());
  }
  for (const child of node.namedChildren) collectLabels(child, self, out);
}

function parentContextOf(node: ALSyntaxNode): ParentContextHint {
  return isStatementPosition(node) ? "statement-position" : "expression-position";
}

function stripQuotes(text: string): string {
  return text.startsWith('"') && text.endsWith('"') && text.length >= 2 ? text.slice(1, -1) : text;
}
