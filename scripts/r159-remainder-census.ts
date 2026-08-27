#!/usr/bin/env bun
/**
 * R159's REMAINING candidates, sized. The row lists five built and names the rest as "unsized",
 * which is the state in which a candidate gets built on a hunch.
 *
 *   bun scripts/r159-remainder-census.ts <project-dir>
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here. Only counts and node-kind names leave the process, never source text.
 *
 * A raw kind count is NOT a candidate size, which is the lesson R159 recorded twice (`string_literal`
 * 12,835 raw -> 4,892 in bodies, `integer_literal` 5,406 -> 3,016 -> a far smaller claimable set).
 * So each candidate here is counted at three depths:
 *
 *   raw        the kind count, the number that flatters
 *   in-body    has a `procedure`/`trigger_declaration` ancestor: nothing else can be executed
 *   claimable  survives the refusals that candidate would actually have to make
 *
 * Reads RAW tree-sitter node types, never `ALNodeKind`: the curated enum can only report that the
 * kinds we chose to name are the kinds we handle, which is the blind spot R120 is about.
 *
 * ## AL's operator precedence, which is Pascal-family and NOT C-family
 *
 * The first version of this script gave `and`/`or` C-like precedence (looser than comparison) and
 * reported ZERO claimable parens out of 763, which is the kind of clean answer that should be
 * distrusted. AL binds them the other way:
 *
 *   1 (tightest)  not
 *   2             *  /  div  mod  and
 *   3             +  -  or  xor
 *   4 (loosest)   =  <>  <  >  <=  >=  in
 *
 * That is why `(A = B) and (C = D)` needs its parens: without them AL parses `B and C` first.
 * VERIFIED by compiling both forms with real `alc.exe`, not asserted, in
 * `scripts/r159-paren-probe.py`.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";

const [projectDir] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/r159-remainder-census.ts <project-dir>");
  process.exit(2);
}

async function alFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await alFiles(p)));
    else if (e.name.toLowerCase().endsWith(".al")) out.push(p);
  }
  return out;
}

function inBody(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}

function walk(node: ALSyntaxNode, fn: (n: ALSyntaxNode) => void): void {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

/** Lower binds TIGHTER. See the header: this is AL's table, not C's. */
const PRECEDENCE: Record<string, number> = {
  not: 1,
  "*": 2,
  "/": 2,
  div: 2,
  mod: 2,
  and: 2,
  "+": 3,
  "-": 3,
  or: 3,
  xor: 3,
  "=": 4,
  "<>": 4,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  in: 4,
};

/**
 * The operator token of a binary/unary expression node, or null when it has none.
 *
 * Read the `operator` FIELD first. The first version of this walked `children` looking for a
 * childless token, which silently returned null for every `comparison_expression` in the corpus:
 * the grammar wraps the operator in a `comparison_operator` node that HAS a child, so `=` was never
 * seen and 515 parens were misfiled as "redundant". Same family of mistake as R120 — a guess about
 * the grammar's shape, made once and then trusted.
 */
function opText(n: ALSyntaxNode): string | null {
  const field = n.childForFieldName("operator");
  if (field !== null) {
    const t = field.text.trim().toLowerCase();
    if (PRECEDENCE[t] !== undefined) return t;
  }
  for (const c of n.children) {
    const t = c.text.trim().toLowerCase();
    if (PRECEDENCE[t] !== undefined) return t;
  }
  return null;
}

/** Does the resulting expression mix a Boolean operator with a numeric operand? */
function mixesBooleanAndNumeric(innerOp: string, parentOp: string): boolean {
  const boolish = (o: string) => o === "and" || o === "or" || o === "xor" || o === "not";
  const compare = (o: string) => PRECEDENCE[o] === 4;
  // `(A = B) and (C = D)` -> `A = B and C = D`: `and` now takes an operand of `B`'s type.
  return boolish(parentOp) && compare(innerOp);
}

interface Bucket {
  raw: number;
  body: number;
  claimable: number;
  note: string;
}
const counts: Record<string, Bucket> = {
  parenthesized_expression: {
    raw: 0,
    body: 0,
    claimable: 0,
    note: "removal both COMPILES and changes meaning",
  },
  subscript_expression: {
    raw: 0,
    body: 0,
    claimable: 0,
    note: "index is NOT an integer literal (a literal index is `shift-integer`'s)",
  },
  date_literal: { raw: 0, body: 0, claimable: 0, note: "in body" },
  datetime_literal: { raw: 0, body: 0, claimable: 0, note: "in body" },
  time_literal: { raw: 0, body: 0, claimable: 0, note: "in body" },
  for_statement: {
    raw: 0,
    body: 0,
    claimable: 0,
    note: "bound is NOT an integer literal (a literal bound is `shift-integer`'s)",
  },
  foreach_statement: { raw: 0, body: 0, claimable: 0, note: "in body" },
};

/** Why each in-body paren is NOT a candidate, so the refusal is itemised rather than a total. */
const parenReasons: Record<string, number> = {
  "redundant (removal is a pure no-op: equivalent mutant, unkillable)": 0,
  "would not compile (AL rejects the reparse: type error)": 0,
  "CANDIDATE (compiles AND changes meaning)": 0,
};

const files = await alFiles(projectDir);
await initParser();
let parsed = 0;
for (const f of files) {
  let tree: ReturnType<typeof parseAL>;
  try {
    tree = parseAL(await readFile(f, "utf8"));
  } catch {
    continue;
  }
  parsed++;
  walk(wrapRoot(tree), (n) => {
    const k = n.rawKind;
    const c = counts[k];
    if (c === undefined) return;
    c.raw++;
    if (!inBody(n)) return;
    c.body++;

    if (k === "parenthesized_expression") {
      const inner = n.namedChildren[0] ?? null;
      const parent = n.parent;
      const io = inner === null ? null : opText(inner);
      const po = parent === null ? null : opText(parent);
      // No operator on either side means the parens carry no precedence at all.
      if (io === null || po === null) {
        parenReasons["redundant (removal is a pure no-op: equivalent mutant, unkillable)"]++;
        return;
      }
      const ip = PRECEDENCE[io];
      const pp = PRECEDENCE[po];
      if (ip === undefined || pp === undefined) return;
      if (ip <= pp) {
        // Inner already binds at least as tight: the parens are decoration.
        parenReasons["redundant (removal is a pure no-op: equivalent mutant, unkillable)"]++;
        return;
      }
      if (mixesBooleanAndNumeric(io, po)) {
        parenReasons["would not compile (AL rejects the reparse: type error)"]++;
        return;
      }
      parenReasons["CANDIDATE (compiles AND changes meaning)"]++;
      c.claimable++;
      return;
    }
    if (k === "subscript_expression" || k === "for_statement") {
      // The grammar's raw kind is `integer`, NOT `integer_literal`. `integer_literal` is the
      // CURATED `ALNodeKind` name for the same node, and testing the curated name against a raw
      // kind silently matches nothing — the exact R120 hazard, which cost three wrong counts in
      // this file's history before it was written down here.
      let hasLiteral = false;
      walk(n, (d) => {
        if (d !== n && d.rawKind === "integer") hasLiteral = true;
      });
      if (!hasLiteral) c.claimable++;
      return;
    }
    c.claimable++;
  });
}

console.log(`corpus: ${parsed}/${files.length} .al files parsed\n`);
console.log("kind                       raw   in-body  claimable  note");
for (const [k, v] of Object.entries(counts)) {
  console.log(
    `${k.padEnd(26)} ${String(v.raw).padStart(5)} ${String(v.body).padStart(8)} ${String(v.claimable).padStart(10)}  ${v.note}`,
  );
}
console.log("\nparenthesized_expression, itemised:");
for (const [why, n] of Object.entries(parenReasons)) {
  console.log(`  ${String(n).padStart(4)}  ${why}`);
}
console.log("\nR13's bar is >= 13 sites.");
