#!/usr/bin/env bun
/**
 * R196's claim-rate measurement, and the HALT it feeds (spec 3.4,
 * `docs/superpowers/specs/2026-09-06-r196-hang-capable-design.md`).
 *
 * Reports, for a corpus: how many `assignment_statement` sites `classifyHangCapable` tags, which of
 * the four operators (`remove-assignment`, `swap-additive`, `flip-boolean-literal`, `shift-integer`)
 * would actually reach each tagged site, and how many sites were DECLINED because the assignment's
 * target could not be resolved while sitting inside an enclosing loop (§3.1): the number that
 * indicts the resolver rather than the rule. A claim rate in the thousands means the rule is wrong
 * rather than broad; a high declined-unresolved rate means the resolver is.
 *
 *   bun scripts/census-hang-capable.ts <project-dir> <out.json>
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here. The output (and anything derived from it that gets written into this repo) carries
 * only counts, file paths, line numbers, operator and procedure names, never AL source text, since
 * this repo is public.
 */
import { writeFile } from "node:fs/promises";
import { flipBooleanLiteral } from "../packages/builtin-tier1/src/flip-boolean-literal";
import {
  assignmentTargetOf,
  classifyHangCapable,
  hasEnclosingLoop,
} from "../packages/builtin-tier1/src/loop-hazard";
import { removeAssignment } from "../packages/builtin-tier1/src/remove-assignment";
import { shiftInteger } from "../packages/builtin-tier1/src/shift-integer";
import { swapAdditive } from "../packages/builtin-tier1/src/swap-additive";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser } from "../packages/engine/src/ast/parser";
import type { ALSyntaxNode } from "../packages/engine/src/ast/syntax-node";
import {
  type SemanticContext,
  buildSemanticContext,
} from "../packages/engine/src/semantic/context";
import { resolveVarRef } from "../packages/engine/src/semantic/resolve-var-ref";
import { collectAlFiles } from "./lib/collect-al-files";

const [projectDir, outPath] = process.argv.slice(2);
if (projectDir === undefined || outPath === undefined) {
  console.error("usage: bun scripts/census-hang-capable.ts <project-dir> <out.json>");
  process.exit(2);
}

/** `symbol-table.ts`'s own helper, private there. Copied rather than exported for a census script. */
function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/** The nearest enclosing procedure/trigger's name, for cross-checking against the store, never the
 *  AL source itself. */
function enclosingProcedureName(node: ALSyntaxNode): string | null {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.kind === ALNodeKind.procedure || p.kind === ALNodeKind.trigger) {
      const nameNode = p.childForFieldName("name");
      return nameNode === null ? null : stripQuotes(nameNode.text);
    }
  }
  return null;
}

/**
 * The four operators §3 of the design feeds. Reuses each operator's real `targets()` predicate
 * rather than restating the shape it claims (remove-assignment on the assignment statement itself;
 * the other three on a `+`/`-`, boolean or integer literal somewhere in the assignment's subtree),
 * since two descriptions of one rule drifting apart is R80's shape.
 */
const HANG_CAPABLE_OPERATORS = [removeAssignment, swapAdditive, flipBooleanLiteral, shiftInteger];

/** `node` and every descendant, named children only (matches the walk `classifyHangCapable` itself
 *  and every operator's `targets()` are measured against). */
function subtreeOf(node: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [node];
  for (const c of node.namedChildren) out.push(...subtreeOf(c));
  return out;
}

/** Which of the four operators would reach `assignment` at all, i.e. which would emit a mutant
 *  somewhere in its subtree, tagged or not. An operator that THROWS on a node shape is swallowed as
 *  "does not claim" here (this is a measurement of reach, not a conformance check of the operator). */
function operatorsReaching(assignment: ALSyntaxNode, ctx: SemanticContext): string[] {
  const nodes = subtreeOf(assignment);
  const names: string[] = [];
  for (const op of HANG_CAPABLE_OPERATORS) {
    const claims = nodes.some((n) => {
      try {
        return op.targets(n, ctx);
      } catch {
        return false;
      }
    });
    if (claims) names.push(op.name);
  }
  return names;
}

interface TaggedRow {
  readonly file: string;
  readonly line: number;
  readonly procedureName: string | null;
  readonly operators: readonly string[];
}

await initParser();
const files = await collectAlFiles(projectDir);
// Fail loudly rather than write an empty baseline someone would later diff against and call clean:
// this project's signature bug (empty-vs-empty "matches").
if (files.length === 0) {
  throw new Error(
    `census-hang-capable: no .al files found under ${projectDir}, refusing to report`,
  );
}
// ONE semantic context over the whole corpus: identifier resolution walks every object, so a
// per-file context would answer `null` for anything declared elsewhere and inflate `declinedUnresolved`
// for a reason that has nothing to do with the resolver's real precision.
const ctx = buildSemanticContext(files);

let assignments = 0;
let tagged = 0;
let sitesInsideLoop = 0;
let declinedUnresolved = 0;
const byOperator = new Map<string, number>();
const taggedRows: TaggedRow[] = [];

for (const { path, root } of files) {
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement) {
      assignments += 1;
      const target = assignmentTargetOf(n);
      if (target !== null) {
        // Ruling R5: declinedUnresolved counts a site inside an enclosing while/repeat whose target
        // `resolveVarRef` could not resolve, not merely "no enclosing loop's condition matched",
        // which conflates a resolver failure with a rule that correctly found no match.
        if (hasEnclosingLoop(n)) {
          sitesInsideLoop += 1;
          if (resolveVarRef(target, ctx) === null) declinedUnresolved += 1;
        }
        const claim = classifyHangCapable(n, ctx);
        if (claim !== null) {
          tagged += 1;
          const operators = operatorsReaching(n, ctx);
          for (const op of operators) byOperator.set(op, (byOperator.get(op) ?? 0) + 1);
          taggedRows.push({
            file: path,
            line: n.startPosition.row + 1,
            procedureName: enclosingProcedureName(n),
            operators,
          });
        }
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
}

const summary = {
  projectDir,
  files: files.length,
  assignments,
  tagged,
  taggedRate: assignments === 0 ? 0 : tagged / assignments,
  sitesInsideLoop,
  declinedUnresolved,
  declinedUnresolvedRate: sitesInsideLoop === 0 ? 0 : declinedUnresolved / sitesInsideLoop,
  byOperator: Object.fromEntries([...byOperator].sort()),
};

console.log(JSON.stringify(summary, null, 2));
// Fail loudly rather than a silent empty write: a zero-assignment corpus is a wrong path, not a
// finding.
if (assignments === 0) {
  throw new Error("census-hang-capable: zero assignment_statement sites found, refusing to write");
}

await writeFile(outPath, JSON.stringify({ summary, taggedRows }, null, 2), "utf8");
console.log(`wrote ${outPath}`);
