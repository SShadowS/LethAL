import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const REC = "rec";
const XREC = "xrec";

/**
 * Trigger kinds where `xRec` carries information DIFFERENT from `Rec` when driven headlessly, and
 * therefore where swapping them is observable and killable.
 *
 * MEASURED, not assumed — this operator exists only because a blanket no-go was measured wrong.
 * `fixtures/sandbox-probes/src/Tier2Phase2Probe.Codeunit.al` on Cronus281 through the fenced path
 * (`GuiAllowed=No`/`ODataV4`, where every verdict is produced):
 *
 *   OnModify,   record-variable `Modify(true)`      rec=250  xrec=250  differ=NO
 *   OnValidate, driven by `Validate(Amount, 250)`   rec=250  xrec=100  differ=YES
 *   OnRename,   driven by `Rename('R2')`            rec.No=R2 xrec.No=R1 differ=YES
 *
 * `OnModify` is EXCLUDED on the strength of the first row, and that exclusion is the point of this
 * set existing: a mutant there is equivalent by measurement, and a survivor at an equivalent site
 * teaches nothing while costing a full mutant run. R33's first conclusion generalised the
 * `Modify(true)` result to every `xRec` site and was wrong; this operator is the corrected half, so
 * it must not quietly re-acquire the site population that measurement actually refuted.
 *
 * This makes `SwapRecXRec` the first Tier-2 operator whose targeting depends on the enclosing
 * TRIGGER KIND rather than on the receiver — every other one asks `claimsRecordMethod` about a
 * receiver and never looks up the tree.
 */
const OBSERVABLE_TRIGGERS: ReadonlySet<string> = new Set(["onvalidate", "onrename"]);

/**
 * `SwapRecXRec` — rewrite `Rec` <-> `xRec` inside a field `OnValidate` or a table `OnRename`.
 *
 * ROADMAP R71; spec `docs/superpowers/specs/2026-07-31-r33-tier2-phase2-design.md` §1.
 *
 * WHAT IT KILLS. `OnValidate` is where AL's ubiquitous `if F <> xRec.F then` change detection
 * lives, and `OnRename` compares the old key to the new one. Swapping the two records makes a
 * change-detection branch compare a value with itself — so the branch never fires — or sends a
 * rename comparison at the wrong key. Both are observable to any test that asserts on what the
 * trigger did.
 *
 * ONLY THE RECEIVER OF A MEMBER ACCESS IS CLAIMED, and only when that access is READ. Two separate
 * refusals, for two different reasons:
 *
 *   - A bare `Rec`/`xRec` (passed whole to a procedure, say) is left alone: the swap would change
 *     which record an arbitrary callee receives, and the semantic layer cannot see what that callee
 *     does with it. That is a mutation whose observability cannot be reasoned about locally.
 *   - An ASSIGNMENT TARGET is refused outright. `xRec.Amount := 5` may or may not compile on a
 *     given AL version, and this project does not need to know: a mutant that fails to compile
 *     poisons its whole batch and sends bisection after a phantom. Refusing costs a few sites;
 *     guessing costs a run.
 *
 * The replacement preserves the ORIGINAL SPELLING of the target token's case-partner in the only
 * way that matters — it emits the canonical `Rec` / `xRec`, because AL is case-insensitive and the
 * identifier's own casing carries no meaning. Only the identifier span is spliced; the member name
 * and everything around it is left exactly as written.
 */
export const swapRecXRec: MutationOperator = {
  name: "lethal.swap-rec-xrec",
  version: "1.0.0",
  tier: 2,
  targetNodeKinds: [ALNodeKind.field_access],
  producesNodeKinds: [ALNodeKind.field_access],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return plan(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const swapped = plan(node);
    if (swapped === null) return [];
    return [
      {
        operatorName: "lethal.swap-rec-xrec",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, swapped),
        parentContext: "expression-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "swaps xRec for Rec in a field OnValidate",
      sourceAL: `table 50150 "T" { fields { field(1; Amount; Decimal) { trigger OnValidate() begin if Amount <> xRec.Amount then Error('changed'); end; } } }`,
      expectedSpecs: [
        {
          parentContext: "expression-position",
          beforeText: "xRec.Amount",
          afterText: "Rec.Amount",
        },
      ],
    },
    {
      name: "swaps Rec for xRec in an OnRename",
      sourceAL: `table 50151 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnRename() begin if Rec."No." = '' then Error('empty'); end; }`,
      expectedSpecs: [
        {
          parentContext: "expression-position",
          beforeText: `Rec."No."`,
          afterText: `xRec."No."`,
        },
      ],
    },
    {
      name: "refuses an OnModify site — measured equivalent, so a survivor there means nothing",
      sourceAL: `table 50152 "T" { fields { field(1; Amount; Decimal) { } } trigger OnModify() begin if Amount <> xRec.Amount then Error('changed'); end; }`,
      expectedSpecs: [],
    },
    {
      name: "refuses an assignment target — a non-compiling mutant would poison its batch",
      sourceAL: `table 50153 "T" { fields { field(1; Amount; Decimal) { trigger OnValidate() begin xRec.Amount := 5; end; } } }`,
      expectedSpecs: [],
    },
    {
      name: "refuses a bare Rec passed whole — the callee's use of it is not locally visible",
      sourceAL: `table 50154 "T" { fields { field(1; Amount; Decimal) { trigger OnValidate() begin Handle(Rec); end; } } procedure Handle(R: Record "T") begin end; }`,
      expectedSpecs: [],
    },
    {
      name: "refuses a member access outside any trigger",
      sourceAL: `codeunit 50155 "C" { procedure P() var Rec: Record Customer; begin if Rec.Name = '' then Error('x'); end; }`,
      expectedSpecs: [],
    },
  ],
};

/** The swapped source text for `node`, or `null` when this site is refused. */
function plan(node: ALSyntaxNode): string | null {
  if (node.kind !== ALNodeKind.field_access) return null;

  const receiver = node.namedChildren[0];
  if (receiver === undefined || receiver.kind !== ALNodeKind.identifier) return null;

  const lower = receiver.text.toLowerCase();
  const replacement = lower === REC ? "xRec" : lower === XREC ? "Rec" : null;
  if (replacement === null) return null;

  if (!inObservableTrigger(node)) return null;
  if (isAssignmentTarget(node)) return null;

  // Splice ONLY the receiver's span, so the member name keeps its own spelling — `xRec."No."`
  // becomes `Rec."No."`, quotes and all.
  const start = receiver.startIndex - node.startIndex;
  const end = receiver.endIndex - node.startIndex;
  const text = node.text;
  if (start < 0 || end > text.length || start >= end) return null;
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

/**
 * Is `node` inside a trigger whose `xRec` was MEASURED to differ from `Rec`?
 *
 * Walks to the nearest enclosing trigger and asks its name. A node in no trigger at all is refused
 * — `Rec` in an ordinary procedure is a local record variable with no `xRec` partner, and swapping
 * it would emit an identifier that does not resolve.
 */
function inObservableTrigger(node: ALSyntaxNode): boolean {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.trigger) {
      const name = current.childForFieldName("name");
      return name !== null && OBSERVABLE_TRIGGERS.has(name.text.toLowerCase());
    }
    current = current.parent;
  }
  return false;
}

/**
 * Is `node` the left-hand side of an assignment?
 *
 * Structural rather than positional: an `assignment_statement`'s first named child is its target.
 * Anything at or under that child is refused, so `xRec.Amount := 5` and `xRec.Name[1] := 'A'` are
 * both out.
 *
 * Compared by SPAN, not by object identity. `namedChildren` builds a fresh wrapper object on every
 * access, so `namedChildren[0] === child` was false even when they were the same syntax node, and
 * this refusal never once fired (R137). A span pair identifies a node uniquely inside one tree.
 */
function isAssignmentTarget(node: ALSyntaxNode): boolean {
  let child: ALSyntaxNode = node;
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.assignment_statement) {
      const target = current.namedChildren[0];
      return (
        target !== undefined &&
        target.startIndex === child.startIndex &&
        target.endIndex === child.endIndex
      );
    }
    child = current;
    current = current.parent;
  }
  return false;
}
