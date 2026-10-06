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

describe("R454: a MEMBER loop-condition write, through all four operators", () => {
  beforeAll(async () => {
    await initParser();
  });

  const TABLE = `table 50480 "Probe" { fields { field(1; Qty; Integer) { } field(2; Other; Integer) { }
    field(3; Done; Boolean) { } field(4; Flag; Boolean) { } } }`;
  const unit = (id: number, body: string) =>
    `${TABLE} codeunit ${id} "R" { procedure P() var R: Record Probe; begin ${body} end; }`;
  const MEMBER: Case[] = [
    {
      op: removeAssignment,
      src: unit(50481, "repeat R.Done := true; R.Flag := true; until R.Done;"),
      kind: "assignment_statement",
      refused: "R.Done := true",
      claimed: "R.Flag := true",
    },
    {
      op: flipBooleanLiteral,
      src: unit(50482, "repeat R.Done := true; R.Flag := true; until R.Done;"),
      kind: "boolean",
      refused: "true",
      refusedWithin: "R.Done := true",
      claimed: "true",
      claimedWithin: "R.Flag := true",
    },
    {
      op: shiftInteger,
      src: unit(50483, "while R.Qty <> 7 do begin R.Qty := 5; R.Other := 5; end;"),
      kind: "integer",
      refused: "5",
      refusedWithin: "R.Qty := 5",
      claimed: "5",
      claimedWithin: "R.Other := 5",
    },
    {
      op: swapAdditive,
      src: unit(50484, "while R.Qty > 0 do begin R.Qty := R.Qty - 1; R.Other := R.Other + 1; end;"),
      kind: "additive_expression",
      refused: "R.Qty - 1",
      claimed: "R.Other + 1",
    },
  ];

  for (const c of MEMBER) {
    it(`${c.op.name}: refused AND counted at the member the condition reads, emitted at its sibling`, () =>
      assertCounted(c));
  }
});

/** Refused, counted, no spec at or inside the refused node; the sibling claimed and emitted. */
function assertCounted(c: Case): void {
  const { root, ctx } = load(c.src);
  const refused = nodeAt(root, c.kind, c.refused, c.refusedWithin);
  const claimed = nodeAt(root, c.kind, c.claimed, c.claimedWithin);
  expect(c.op.targets(refused, ctx)).toBe(false);
  expect(c.op.refusesHangCapable?.(refused, ctx)).toBe(true);
  expect(c.op.targets(claimed, ctx)).toBe(true);
  expect(c.op.refusesHangCapable?.(claimed, ctx)).toBe(false);
  // Direct generate(): no spec at the refused node, a spec at the claimed control.
  expect(c.op.generate(refused, ctx)).toEqual([]);
  expect(c.op.generate(claimed, ctx).length).toBeGreaterThan(0);
  // No generated spec inside the refused node, over the whole file as the orchestrator walks it.
  const spans: { start: number; end: number }[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (c.op.targets(n, ctx)) {
      for (const s of c.op.generate(n, ctx)) {
        spans.push({ start: s.before.startIndex, end: s.before.endIndex });
      }
    }
    for (const ch of n.children) walk(ch);
  };
  walk(root);
  const inside = (p: ALSyntaxNode) =>
    spans.filter((s) => s.start >= p.startIndex && s.end <= p.endIndex).length;
  expect(inside(refused)).toBe(0);
  expect(inside(claimed)).toBeGreaterThan(0);
}

/** R446: a write a body-exit guard reads, in a `while true`/`until false` loop, through all four
 *  operators. Revert: `loopExitParts` returns `loopConditionParts(loop)`. */
describe("R446: a body-exit guard's write is refused AND counted, its sibling emitted", () => {
  beforeAll(async () => {
    await initParser();
  });

  const COUNTER = `codeunit 50485 "R" { procedure P() var Pending: Integer; Total: Integer; begin
      while true do begin Pending += 1; Total += 1; if Pending > 3 then exit; end; end; }`;
  const BODY_GUARD: Case[] = [
    {
      op: removeAssignment,
      src: COUNTER,
      kind: "assignment_statement",
      refused: "Pending += 1",
      claimed: "Total += 1",
    },
    {
      op: shiftInteger,
      src: COUNTER,
      kind: "integer",
      refused: "1",
      refusedWithin: "Pending += 1",
      claimed: "1",
      claimedWithin: "Total += 1",
    },
    {
      op: swapAdditive,
      src: `codeunit 50486 "R" { procedure P() var Remaining: Integer; Total: Integer; begin
      repeat Remaining := Remaining + 1; Total := Total + 1; if Remaining >= 5 then break; until false; end; }`,
      kind: "additive_expression",
      refused: "Remaining + 1",
      claimed: "Total + 1",
    },
    {
      op: flipBooleanLiteral,
      src: `codeunit 50487 "R" { procedure P() var Done: Boolean; Flag: Boolean; begin
      while true do begin Done := true; Flag := true; if Done then CurrReport.Quit(); end; end; }`,
      kind: "boolean",
      refused: "true",
      refusedWithin: "Done := true",
      claimed: "true",
      claimedWithin: "Flag := true",
    },
  ];

  for (const c of BODY_GUARD) {
    it(`${c.op.name}: refused AND counted where a body-exit guard reads the write`, () =>
      assertCounted(c));
  }
});

/** R480: shapes 1, 2, 3n and 4n are refused AND counted, their siblings emitted. 4n through all four
 *  operators (M1). */
describe("R480: the new shapes are refused AND counted, their siblings emitted", () => {
  beforeAll(async () => {
    await initParser();
  });

  const cu = (id: number, vars: string, body: string) =>
    `codeunit ${id} "R" { procedure P() var ${vars} begin ${body} end; }`;
  const FOR_HEAD = "for Step := 5 downto 1 do begin";
  const R480: (Case & { shape: string })[] = [
    {
      shape: "1",
      op: removeAssignment,
      src: cu(
        50490,
        "Go: Boolean; Pending: Integer; Total: Integer;",
        "while Go do begin Pending += 1; Total += 1; if Pending > 3 then exit; end;",
      ),
      kind: "assignment_statement",
      refused: "Pending += 1",
      claimed: "Total += 1",
    },
    {
      shape: "2",
      op: shiftInteger,
      src: cu(
        50491,
        "Done: Boolean; Pending: Integer; Total: Integer;",
        "while true do begin Pending += 1; Total += 1; Done := Pending >= 3; if Done then exit; end;",
      ),
      kind: "integer",
      refused: "1",
      refusedWithin: "Pending += 1",
      claimed: "1",
      claimedWithin: "Total += 1",
    },
    {
      shape: "3n",
      op: swapAdditive,
      src: cu(
        50492,
        "Pending: Integer; Total: Integer;",
        "while Ready() do begin Pending := Pending + 1; Total := Total + 1; if Pending > 3 then exit; end;",
      ),
      kind: "additive_expression",
      refused: "Pending + 1",
      claimed: "Total + 1",
    },
    {
      shape: "4n",
      op: removeAssignment,
      src: cu(50493, "Step: Integer; Total: Integer;", `${FOR_HEAD} Step += 1; Total += 1; end;`),
      kind: "assignment_statement",
      refused: "Step += 1",
      claimed: "Total += 1",
    },
    {
      shape: "4n",
      op: shiftInteger,
      src: cu(50494, "Step: Integer; Total: Integer;", `${FOR_HEAD} Step := 1; Total := 7; end;`),
      kind: "integer",
      refused: "1",
      refusedWithin: "Step := 1",
      claimed: "7",
    },
    {
      shape: "4n",
      op: swapAdditive,
      src: cu(
        50495,
        "Step: Integer; Total: Integer;",
        `${FOR_HEAD} Step := Step + 1; Total := Total + 1; end;`,
      ),
      kind: "additive_expression",
      refused: "Step + 1",
      claimed: "Total + 1",
    },
    {
      shape: "4n",
      op: flipBooleanLiteral,
      src: cu(
        50496,
        "Step: Integer; Total: Integer;",
        `${FOR_HEAD} Step := Step + Delta(true); Total := Total + Delta(true); end;`,
      ),
      kind: "boolean",
      refused: "true",
      refusedWithin: "Step := Step + Delta(true)",
      claimed: "true",
      claimedWithin: "Total := Total + Delta(true)",
    },
  ];

  for (const c of R480) {
    it(`shape ${c.shape}, ${c.op.name}: refused AND counted, the sibling emitted`, () =>
      assertCounted(c));
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
