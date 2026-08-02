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

/**
 * `SwapCallArguments` — rewrite `Foo(A, B)` -> `Foo(B, A)` for two same-typed arguments.
 *
 * Spec: `docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md`.
 * Footprint: `docs/measurements/README.md` §R82 — 893 candidate sites on Continia Document Output,
 * 340 of them provable under the predicate below (26x the pre-committed cost bar).
 *
 * TIER 1, and that is a judgement rather than an accident: design.md §4 defines tier 1 as the
 * generic, literature-backed set, and an argument-order swap is generic — nothing about it is
 * AL-specific, unlike `swap-modify-flag`, which knows what `Modify(true)` MEANS. It is the first
 * tier-1 operator to need the semantic layer; that is a property of the operator, not of the tier.
 *
 * THE PREDICATE, and why every clause is load-bearing:
 *
 *   1. Two arguments that are both BARE IDENTIFIERS. This is the `var`-parameter guard. AL matches
 *      a `var` parameter by EXACT type and refuses a non-lvalue, and whether a parameter is `var`
 *      is the callee's business — which this operator never resolves.
 *      THE REAL INVARIANT IS NARROWER THAN "TWO VARIABLES ARE LVALUES", and an adversarial review
 *      caught this comment overstating it. A bare identifier is not necessarily an lvalue: a
 *      parameterless procedure call is written the same way, and a `Label` is not assignable
 *      either. What actually holds is (a) the type table types ONLY declared variables, so a bare
 *      procedure call answers `null` and is refused below, and (b) for everything it DOES type,
 *      equal declared types plus "the call compiles today" is enough on its own — if either
 *      argument sat in a `var` slot, AL would already have rejected the ORIGINAL call, so the swap
 *      cannot introduce a `var` violation. Both shapes are pinned in the tests; labels are ~9.7%
 *      of the sites this operator claims on a real project, so the second half is load-bearing,
 *      not academic.
 *      A `quoted_identifier` argument is not claimed: conservative, and the census measured the
 *      shape to be rare.
 *   2. The SAME declared type, compared on the FULL declaration. `Record "Sales Header"` and
 *      `Record "Purchase Header"` are not the same type — R84 measured that the old truncated
 *      answer would have claimed 135 of 893 sites (15.1%) whose swap does not compile. This
 *      operator is `ctx.types`'s first consumer in the shipped pipeline, so that fix is its
 *      precondition, not a nicety.
 *   3. Texts that DIFFER after whitespace normalisation. `Foo(X, X)` swapped is `Foo(X, X)` — an
 *      equivalent mutant by construction, and the one class of equivalence that can be refused
 *      statically rather than measured.
 *
 * WHAT THE PREDICATE PROVES, AND WHAT IT DOES NOT. It proves COMPILE safety. It does NOT prove the
 * swap is harmless at runtime: two `Code[20]` variables passed to a callee whose second parameter
 * is `Code[10]` compile both ways, and the swapped call dies on a length overflow — a kill no
 * assertion earned. The census cannot exclude those sites because it never resolves the callee, so
 * they exist on any real project and a report must split kills by cause. Fixture arm E measures
 * exactly this shape; see the spec §2.2 and §4.
 *
 * NOT RESTRICTED TO STATEMENT POSITION. 452 of the 893 measured sites — the majority — sit in
 * expression position. `swap-modify-flag` already established that rewriting an argument is safe
 * there where DELETING a call is not: the statement keeps its shape and no control flow changes.
 *
 * COEXISTS WITH `void-method-call` AT ONE SITE. Dedup identity is
 * `kind:start:end:after.text` (`packages/schemata/src/dedup.ts`), and a swap's replacement text is
 * never the empty string a deletion emits, so a statement-position call carries BOTH mutants. That
 * is what makes R82's "marginal == gross" a fact rather than an argument.
 *
 * NO `equivalenceHint`, deliberately. Boolean/Boolean pairs are the slice most likely to be
 * equivalent (11.76% of the provable sites), but "likely" is per-callee and unmeasured per site —
 * a callee that treats its two Booleans differently is ordinary. Tagging the whole type would make
 * a claim the measurement does not support, and the hint has real teeth: a `likely-equivalent`
 * spec loses a dedup collision it would otherwise win.
 */
export const swapCallArguments: MutationOperator = {
  name: "lethal.swap-call-arguments",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table", "type-info"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    return swappablePair(node, ctx) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const pair = swappablePair(node, ctx);
    if (pair === null) return [];
    const mutatedText = swapSpans(node, pair[0], pair[1]);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: "lethal.swap-call-arguments",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: parentContextOf(node),
      },
    ];
  },

  conformanceTests: [
    {
      name: "swaps two same-typed locals in statement position",
      sourceAL: `codeunit 50150 "C" { procedure P() var A: Integer; B: Integer; begin Foo(A, B); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Foo(A, B)",
          afterText: "Foo(B, A)",
        },
      ],
    },
    {
      name: "swaps in expression position, where the majority of real sites live",
      sourceAL: `codeunit 50151 "C" { procedure P() var A: Integer; B: Integer; begin if InRange(A, B) then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "expression-position",
          beforeText: "InRange(A, B)",
          afterText: "InRange(B, A)",
        },
      ],
    },
    {
      name: "swaps the FIRST qualifying pair and carries the untouched middle argument through",
      sourceAL: `codeunit 50152 "C" { procedure P() var A: Integer; B: Integer; C: Text; begin Foo(A, C, B); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Foo(A, C, B)",
          afterText: "Foo(B, C, A)",
        },
      ],
    },
    {
      name: "carries a comment between the arguments through untouched",
      sourceAL: `codeunit 50153 "C" { procedure P() var A: Integer; B: Integer; begin Foo(A, /* order matters */ B); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Foo(A, /* order matters */ B)",
          afterText: "Foo(B, /* order matters */ A)",
        },
      ],
    },
  ],
};

/**
 * The honest `parentContext`. Copied in spirit from `swap-modify-flag`: this operator genuinely
 * claims sites outside statement position, so hardcoding the hint would state something
 * `isStatementPosition` measures as false.
 */
function parentContextOf(node: ALSyntaxNode): ParentContextHint {
  return isStatementPosition(node) ? "statement-position" : "expression-position";
}

/**
 * The first (i, j), i < j, whose arguments satisfy every clause of the predicate — or `null`.
 *
 * "First" is lexicographic on (i, j) and is the pre-committed counting rule: ONE mutant per site.
 * A call with three same-typed arguments admits more swaps than are emitted, and that under-count
 * is deliberate — every shipped operator emits one mutant per site, and a rule that varied per
 * site would make a footprint census meaningless.
 */
function swappablePair(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): readonly [ALSyntaxNode, ALSyntaxNode] | null {
  if (node.kind !== ALNodeKind.procedure_call) return null;
  // `argument_list` is not an `ALNodeKind` — that enum lists the kinds the pipeline TARGETS — so
  // the comparison goes through `rawKind`, the same route `receiver.ts` uses for
  // `quoted_identifier` and `symbol-table.ts` for `tableextension_declaration`.
  const argList = node.namedChildren.find((c) => c.rawKind === ARGUMENT_LIST);
  if (argList === undefined) return null;
  // A comment inside the parentheses is a NAMED child of the argument list, so arguments are
  // filtered by kind rather than counted — the same grammar fact `soleArgument` exists for in
  // @lethal/builtin-tier2, where missing it once produced an inverted mutation.
  const args = argList.namedChildren.filter((c) => c.kind === ALNodeKind.identifier);
  if (args.length < 2) return null;

  for (let i = 0; i < args.length; i += 1) {
    for (let j = i + 1; j < args.length; j += 1) {
      const left = args[i];
      const right = args[j];
      if (left === undefined || right === undefined) continue;
      if (normalize(left.text) === normalize(right.text)) continue;
      const leftType = ctx.types.typeOf(left);
      if (leftType === null) continue;
      if (leftType !== ctx.types.typeOf(right)) continue;
      return [left, right];
    }
  }
  return null;
}

/**
 * `node`'s text with the two argument spans exchanged.
 *
 * This is the product's first TWO-POINT edit — every other operator replaces or deletes one
 * contiguous span. It has to collapse into one, because a spec carries a single `before` node and
 * dedup identity is that node's span plus the replacement text. So the span is the whole call and
 * the text BETWEEN the arguments (commas, comments, line breaks) is carried through byte-for-byte.
 *
 * The later span is spliced first so the earlier span's offsets stay valid — writing it the other
 * way round silently corrupts the output whenever the two arguments differ in length.
 */
function swapSpans(node: ALSyntaxNode, left: ALSyntaxNode, right: ALSyntaxNode): string | null {
  const text = node.text;
  const base = node.startIndex;
  const ls = left.startIndex - base;
  const le = left.endIndex - base;
  const rs = right.startIndex - base;
  const re = right.endIndex - base;
  // Guarded rather than assumed: a caller-contract violation here would emit AL that compiles and
  // means something else, which is worse than throwing.
  if (ls < 0 || le > rs || re > text.length) return null;
  return text.slice(0, ls) + right.text + text.slice(le, rs) + left.text + text.slice(re);
}

const ARGUMENT_LIST = "argument_list";

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
