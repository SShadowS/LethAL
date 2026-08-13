import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import { exactArguments, synthesizeAfter } from "./mutate-helpers";
import { calleeNameNode, claimsRecordMethod } from "./receiver";

const OPERATOR_VERSION = "1.0.0";
const METHOD_NAME = "Validate";
const VALUE_ARGUMENT_COUNT = 2;

/** The grammar's quoted-identifier kind; not declared in `ALNodeKind`, matching `receiver.ts`. */
const QUOTED_IDENTIFIER = "quoted_identifier";

/**
 * `ValidateToAssign`: rewrite `<rec>.Validate(F, V)` to `<rec>.F := V`.
 *
 * Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.3.
 *
 * The mutant deletes the `OnValidate` trigger chain while leaving the field value correct, a
 * BC-specific bug class nothing else in this product models: a test that only checks the field's
 * final value cannot see this mutant, but a test that checks a companion effect `OnValidate` runs
 * (a doubled value, a related field, a normalised spelling) can.
 *
 * Four guards, all in `targets()`:
 *
 *   1. `isStatementPosition(node)`. This is a REWRITE, not a deletion, but the guard exists for a
 *      different reason than it does for the three deletion operators. The guarded dispatch chain
 *      replaces the enclosing statement's span with a branch whose body is that statement's text
 *      with the mutant's span substituted, so an assignment can only be spliced where a STATEMENT is
 *      expected. `isStatementPosition` is the only predicate in the product that measures that, and
 *      it measures `false` for an un-braced then-branch. The cost: `if Cond then Rec.Validate(F, V);`
 *      is refused, even though `if Cond then Rec.F := V;` would be perfectly legal AL. That is the
 *      safe direction and stands for this wave; widening it later is a MINOR bump on this operator,
 *      by the same identity reasoning `swap-modify-flag`'s 1.1.0 bump used.
 *   2. `claimsRecordMethod(node, ctx, "Validate")` (`./receiver.ts`). Carries the receiver proof,
 *      case-insensitivity, and the project-declared-procedure shadowing refusal, same as the other
 *      two Tier-2 operators in this wave.
 *   3. The call carries EXACTLY two value arguments (`exactArguments`, `./mutate-helpers.ts`,
 *      amendment 1). `Validate(F)` is real, legal AL (it re-runs `OnValidate` against the field's
 *      CURRENT value) and has no assignment equivalent, so it is refused rather than approximated.
 *   4. The first argument is a plain field identifier: a bare identifier or a double-quoted
 *      identifier, with no member access, no subscript, no call and no other expression inside it
 *      (`isFieldIdentifier`, below). Anything else would make the rewrite have to reason about what
 *      the expression denotes, which it does not do.
 *
 * **Compile safety, measured rather than assumed (section 0 of the spec).** If the original
 * `Validate(F, V)` call compiles, the compiler has already checked that `V` converts to `F`'s
 * declared type and reports `AL0193` when it does not, so the assignment this operator emits
 * compiles wherever the call it replaces compiled. Eight offline `alc` compiles measured this
 * directly and REJECTED an earlier reviewer claim that `Validate`'s value parameter is untyped `Any`
 * and therefore needs a fifth type guard: the compiler DOES check argument 2 against the field's
 * type. The one measured asymmetry is an Integer value into an Enum field, which earns an `AL0603`
 * implicit-conversion WARNING on the assignment where the call form has none, and the artifact
 * compiler passes no warnings-as-errors flag and fails only on a non-zero exit code, so a warning
 * cannot fail a batch. No fifth guard is added.
 *
 * **Amendment 1, the one change to what this operator EMITS: the implicit-receiver form is
 * `Rec.`-QUALIFIED, not bare.** `Validate`'s first argument resolves in the RECORD's field scope, but
 * a bare assignment target resolves in ordinary identifier scope (trigger local, then procedure
 * local, then parameter, then object global, and only then a field). So inside a table procedure
 * that happens to declare a local of the same name as a field, a bare `Level := V` would assign the
 * LOCAL, leave the field untouched, run no `OnValidate`, and still compile and score normally,
 * meaning something entirely different from what this operator claims. Qualifying removes the
 * ambiguity at no cost: `Rec.<field> := <value>` was measured to compile clean in all four contexts
 * that carry an implicit `Rec` in this product's rules (a table's own procedure, a field
 * `OnValidate`, a `tableextension` procedure, a `page` procedure with a `SourceTable`).
 *
 * **Amendment 2: the receiver prefix comes from the shared `calleeNameNode` accessor
 * (`./receiver.ts`), not a separately derived "text up to the method name".** The same node
 * `lethal.swap-find-direction` splices its replacement over. Locating "where the method name starts"
 * twice, once per operator, is exactly the second-parser-for-one-node-shape mistake this product has
 * already been bitten by (R80); both operators read the one node instead.
 *
 * **The emit form is a REBUILD, not a splice, and that has one consequence.** The mutated text is
 * the receiver prefix, then the first argument's verbatim text, then ` := `, then the second
 * argument's verbatim text. Because the text is assembled rather than spliced, trivia BETWEEN the
 * arguments is dropped: `Validate(Level, X /* why *\/)` yields `Rec.Level := X`. That cannot change
 * behaviour, and the emitted branch is machine-generated AL nobody reads for its comments, so it is
 * accepted; it is the one respect in which this operator differs from every other rewrite in the
 * product, all of which preserve interstitial text.
 *
 * `parentContext` is the literal `"statement-position"`, because guard 1 already required it, the
 * same `remove-setrange` precedent `swap-modify-flag`/`swap-find-direction` do not get to use since
 * they claim sites outside statement position too.
 *
 * **Dedup**: the replacement text is never empty, so this mutant coexists with Tier-1
 * `void-method-call`'s deletion at the same span. Nothing is displaced.
 *
 * Documented limits:
 *   - the single-argument `Validate(F)` form and a call outside statement position are refused, both
 *     recorded above as guards rather than omissions.
 *   - a `pageextension`'s implicit `Rec` is refused, inherited from `claimsRecordMethod`; see
 *     `OBJECT_KINDS` in `./receiver.ts`.
 *   - the parenthesis-less call form never reaches this operator: it parses as a `member_expression`
 *     rather than a `call_expression`, the same grammar gap `void-method-call` and every other
 *     Tier-2 operator in this file share.
 */
export const validateToAssign: MutationOperator = {
  name: "lethal.validate-to-assign",
  version: OPERATOR_VERSION,
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    if (!isStatementPosition(node)) return false;
    if (!claimsRecordMethod(node, ctx, METHOD_NAME)) return false;
    const args = validateArguments(node);
    if (args === null) return false;
    return isFieldIdentifier(args.fieldArg);
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const args = validateArguments(node);
    if (args === null) return [];
    if (!isFieldIdentifier(args.fieldArg)) return [];

    const nameNode = calleeNameNode(node);
    if (nameNode === null) return [];
    const prefix = receiverPrefix(node, nameNode);
    if (prefix === null) return [];

    const mutatedText = `${prefix}${args.fieldArg.text} := ${args.valueArg.text}`;

    return [
      {
        operatorName: "lethal.validate-to-assign",
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "rewrites a qualified two-argument Validate into an assignment, bare field",
      sourceAL: `codeunit 50190 "C" { procedure P(NewName: Text) var Rec: Record Customer; begin Rec.Validate(Name, NewName); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Rec.Validate(Name, NewName)",
          afterText: "Rec.Name := NewName",
        },
      ],
    },
    {
      name: "keeps a quoted field identifier quoted",
      sourceAL: `codeunit 50191 "C" { procedure P(NewNo: Code[20]) var Rec: Record Customer; begin Rec.Validate("No.", NewNo); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: 'Rec.Validate("No.", NewNo)',
          afterText: 'Rec."No." := NewNo',
        },
      ],
    },
  ],
};

/**
 * The call's field argument and value argument, or `null` unless it carries exactly two
 * (`exactArguments`, `./mutate-helpers.ts`). The single point where the two-argument guard is
 * enforced; both `targets()` and `generate()` call this rather than each re-deriving the count.
 */
function validateArguments(
  node: ALSyntaxNode,
): { fieldArg: ALSyntaxNode; valueArg: ALSyntaxNode } | null {
  const args = exactArguments(node, VALUE_ARGUMENT_COUNT);
  if (args === null) return null;
  const fieldArg = args[0];
  const valueArg = args[1];
  if (fieldArg === undefined || valueArg === undefined) return null;
  return { fieldArg, valueArg };
}

/**
 * Is `node` a plain field identifier: a bare identifier or a double-quoted identifier, with no
 * named children of its own? Anything else (a member access, a subscript, a call, a literal, an
 * arbitrary expression) refuses, because the rewrite would then have to reason about what the
 * expression denotes, which it does not do.
 *
 * The kind checks below are written against the actual grammar shapes, not the field-name regex an
 * earlier sketch of this operator proposed: a grammar probe (`Validate("No.", X)` and
 * `Validate(Name, X)` parsed under the vendored 4.0.1 grammar) confirmed a bare identifier reports
 * `kind`/`rawKind` both `"identifier"` with zero named children, a quoted identifier reports both
 * `"quoted_identifier"` with zero named children (the same shape `receiver.ts`'s own
 * `isIdentifierLike` checks for), and a member access, a call, or a literal never matches either.
 */
function isFieldIdentifier(node: ALSyntaxNode): boolean {
  if (node.namedChildren.length > 0) return false;
  return node.kind === ALNodeKind.identifier || node.rawKind === QUOTED_IDENTIFIER;
}

/**
 * The text to place before the field name in the emitted assignment.
 *
 * For a qualified call (`Rec.Validate(F, V)`), that is the call's own text up to where `nameNode`
 * (the method-name span, from the shared `calleeNameNode` accessor in `./receiver.ts`) starts:
 * `nameNode.startIndex` is strictly after `node.startIndex` whenever a receiver sits in front of the
 * method name, so slicing `node.text` up to that offset reproduces the receiver and its `.` exactly
 * as written, whatever casing or spelling it used.
 *
 * For the implicit-receiver form, `nameNode` IS the callee itself, so its start coincides with the
 * call node's own start. There is no receiver text to slice out, and per amendment 1 above, none is
 * substituted: the literal `Rec.` is SYNTHESISED instead of leaving the assignment bare, because
 * `Validate`'s first argument resolves in the record's field scope while a bare assignment target
 * does not, and the qualification is correct under either binding rule for a hypothetically shadowed
 * name.
 *
 * `null` when `nameNode`'s span does not fall inside `node`'s own text, which should be impossible
 * for a genuine descendant; guarded rather than assumed, mirroring `swap-find-direction.ts`'s
 * `replaceNameSpan`.
 */
function receiverPrefix(node: ALSyntaxNode, nameNode: ALSyntaxNode): string | null {
  if (nameNode.startIndex === node.startIndex) return "Rec.";
  const offset = nameNode.startIndex - node.startIndex;
  if (offset < 0 || offset > node.text.length) return null;
  return node.text.slice(0, offset);
}
