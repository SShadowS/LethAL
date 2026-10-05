import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import type { MutationOperator } from "@lethal/operator-sdk";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";
import { hangCapableForMutatedNode } from "../src/loop-hazard";
import { removeAssignment } from "../src/remove-assignment";
import { shiftInteger } from "../src/shift-integer";
import { swapAdditive } from "../src/swap-additive";

/**
 * R447: `refusesHangCapable` is true exactly where the operator would have claimed the node but
 * R196's hang check refused it. (a) the refused loop step, the claimed sibling and a non-candidate;
 * (b) a node an EARLIER check refuses while the hang check is non-null, which must stay false, so
 * the report never counts a site the operator would have refused anyway.
 */

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

/** The first node of `kind` (whose text is exactly `text`, when given) inside a node whose text is
 *  `within`, when given. */
function nodeAt(root: ALSyntaxNode, kind: string, text?: string, within?: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode, inside: boolean): void => {
    const now = inside || within === undefined || n.text === within;
    if (now && n.rawKind === kind && (text === undefined || n.text === text)) out.push(n);
    for (const c of n.children) walk(c, now);
  };
  walk(root, false);
  const first = out[0];
  if (first === undefined) throw new Error(`no ${kind} "${text}"`);
  return first;
}

type Case = {
  op: MutationOperator;
  src: string;
  kind: string;
  refused: string;
  refusedWithin?: string;
  claimed: string;
  claimedWithin?: string;
};

const CASES: Case[] = [
  {
    op: removeAssignment,
    src: `codeunit 50470 "R" { procedure P() var Pending: Integer; Total: Integer; begin
      while Pending > 0 do begin Pending -= 1; Total += 1; end; end; }`,
    kind: "assignment_statement",
    refused: "Pending -= 1",
    claimed: "Total += 1",
  },
  {
    op: shiftInteger,
    src: `codeunit 50471 "R" { procedure P() var Pending: Integer; Total: Integer; begin
      while Pending > 0 do begin Pending -= 1; Total += 1; end; end; }`,
    kind: "integer",
    refused: "1",
    refusedWithin: "Pending -= 1",
    claimed: "1",
    claimedWithin: "Total += 1",
  },
  {
    op: swapAdditive,
    src: `codeunit 50472 "R" { procedure P() var Remaining: Integer; Total: Integer; begin
      while Remaining > 0 do begin Remaining := Remaining - 1; Total := Total + 1; end; end; }`,
    kind: "additive_expression",
    refused: "Remaining - 1",
    claimed: "Total + 1",
  },
  {
    op: flipBooleanLiteral,
    src: `codeunit 50473 "R" { procedure P() var Continue: Boolean; Flag: Boolean; begin
      while Continue do begin Continue := false; Flag := true; end; end; }`,
    kind: "boolean",
    refused: "false",
    claimed: "true",
  },
];

describe("R447: refusesHangCapable (5.1a)", () => {
  beforeAll(async () => {
    await initParser();
  });

  for (const c of CASES) {
    it(`${c.op.name}: true at the refused loop step, false at the claimed sibling and a non-candidate`, () => {
      const { root, ctx } = load(c.src);
      const refused = nodeAt(root, c.kind, c.refused, c.refusedWithin);
      const claimed = nodeAt(root, c.kind, c.claimed, c.claimedWithin);
      expect(c.op.targets(refused, ctx)).toBe(false);
      expect(c.op.refusesHangCapable?.(refused, ctx)).toBe(true);
      expect(c.op.targets(claimed, ctx)).toBe(true);
      expect(c.op.refusesHangCapable?.(claimed, ctx)).toBe(false);
      // A node of another kind: no check admits it.
      const other = nodeAt(root, "while_statement");
      expect(c.op.refusesHangCapable?.(other, ctx)).toBe(false);
    });
  }
});

describe("R447: an earlier check refuses, the hang check would not (5.1b)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const EARLIER: { op: MutationOperator; why: string; src: string; kind: string; text: string }[] =
    [
      {
        op: swapAdditive,
        why: "Text + Text is refused on type",
        src: `codeunit 50474 "R" { procedure P() var S: Text; begin while S <> '' do S := S + 'x'; end; }`,
        kind: "additive_expression",
        text: "S + 'x'",
      },
      {
        op: shiftInteger,
        why: "a literal at AL's 32-bit ceiling is refused",
        src: `codeunit 50475 "R" { procedure P() var I: Integer; begin while I <> 0 do I := 2147483647; end; }`,
        kind: "integer",
        text: "2147483647",
      },
      {
        // The un-braced body of a `while` is a single `#if` here; its arms are not statement slots.
        op: removeAssignment,
        why: "an assignment that is not in a statement slot is refused",
        src: `codeunit 50476 "R" { procedure P() var I: Integer; begin while I < 10 do
#if X
        I += 1;
#else
        I += 2;
#endif
      end; }`,
        kind: "assignment_statement",
        text: "I += 1",
      },
      {
        op: flipBooleanLiteral,
        why: "Insert(true)'s run-trigger flag is ceded to swap-modify-flag",
        src: `codeunit 50477 "R" { procedure P() var Cust: Record Customer; Done: Boolean; begin
        while not Done do Done := Cust.Insert(true); end; }`,
        kind: "boolean",
        text: "true",
      },
    ];

  for (const c of EARLIER) {
    it(`${c.op.name}: ${c.why}, so the site is not counted`, () => {
      const { root, ctx } = load(c.src);
      const node = nodeAt(root, c.kind, c.text);
      // Not vacuous: the hang check alone WOULD refuse this node.
      expect(hangCapableForMutatedNode(node, ctx)).not.toBeNull();
      expect(c.op.targets(node, ctx)).toBe(false);
      expect(c.op.refusesHangCapable?.(node, ctx)).toBe(false);
    });
  }
});
