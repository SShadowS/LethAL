#!/usr/bin/env bun
/**
 * R174's measurement: what a Stryker.NET-style `ignoreMethods` call-site ignore list would
 * actually remove from a real AL project, and what it would remove BY MISTAKE.
 *
 * The proposal was to drop a mutation spec when its span lies within the span of a call whose
 * callee matches a configured glob. Two questions decided it, and neither could be answered from
 * a committed report:
 *
 *   1. **How much does it save?** A report only records mutants that were DEPLOYED, so it cannot
 *      show what a filter would have removed before instrumentation.
 *   2. **What does it swallow?** This is the one that needs source. `lethal.void-method-call`
 *      claims only statement-slot calls (its `targets` gates on `isStatementSlot`), so a call in condition or
 *      argument position produces no mutant of its own and leaves NO trace in any report. On
 *      `docs/campaign/2026-08-03-do/rung2.report.json` that invisible population is not marginal:
 *      measured here, 7,609 of 17,596 calls (43%) are not in a statement slot.
 *
 * So this parses the real project instead, where every `procedure_call` node is visible whatever
 * its position. Follows `scripts/census-operator-sites.ts`: ONE semantic context over the whole
 * corpus, because Tier-2 predicates resolve receivers through the symbol table and a per-file
 * context would answer `null` for anything declared elsewhere.
 *
 *   bun scripts/r174-ignore-methods-probe.ts <project-dir> [pattern ...]
 *
 * With no patterns it prints the callee census only — the patterns fed to it were chosen FROM that
 * census rather than guessed, which is how `Session.LogMessage` was found to match nothing at all
 * in a project that unquestionably does telemetry.
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here. The measured run used `U:/Git/do-lethal/Cloud` at the pinned campaign commit
 * `5f2a71d` (`docs/campaign/2026-08-03-do/manifest.md`).
 *
 * NOTE the denominator: this counts RAW specs, before per-file dedup and before the
 * instrumentability filter, so the percentages are not deployed-mutant percentages. R174 records
 * them as raw and does not quote them as deployed.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const [projectDir, ...patterns] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/r174-ignore-methods-probe.ts <project-dir> [pattern ...]");
  process.exit(2);
}

const operators = [...tier1Operators, ...tier2Operators];

function walk(node: ALSyntaxNode, visit: (n: ALSyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

const stripQuotes = (s: string): string =>
  s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;

/**
 * The canonical string a pattern matches against: `Name` for an unqualified call, `Receiver.Name`
 * for a qualified one. The receiver is the VARIABLE NAME as written, not a resolved type — the
 * engine resolves receivers to tables only (`resolveReceiverTable`), never to codeunits.
 *
 * Returns `null` for anything that does not compose: a chained callee (`GetRec().LogMessage`) or
 * a non-identifier receiver. Those are unmatchable by ANY pattern, which is one of the limitations
 * R174 records.
 */
function canonicalCallee(node: ALSyntaxNode): string | null {
  if (node.kind !== ALNodeKind.procedure_call) return null;
  const callee = node.childForFieldName("function");
  if (callee === null) return null;
  if (callee.kind === "identifier" || callee.kind === "quoted_identifier") {
    return stripQuotes(callee.text);
  }
  if (callee.kind === "field_access" || callee.kind === "member_expression") {
    const object = callee.childForFieldName("object");
    const member = callee.childForFieldName("member");
    if (object === null || member === null) return null;
    if (object.kind !== "identifier" && object.kind !== "quoted_identifier") return null;
    return `${stripQuotes(object.text)}.${stripQuotes(member.text)}`;
  }
  return null;
}

/** Case-insensitive (AL is), and `*` does not cross a dot, so `Telemetry.*` cannot span receivers. */
function globMatch(pattern: string, subject: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .split("*")
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]*");
  return new RegExp(`^${escaped}$`).test(subject.toLowerCase());
}

interface CallRec {
  readonly file: string;
  readonly callee: string;
  readonly start: number;
  readonly end: number;
  /** Whether `void-method-call` would claim it — i.e. whether it is visible in a report at all. */
  readonly statementSlot: boolean;
}
interface SpecRec {
  readonly file: string;
  readonly operator: string;
  readonly start: number;
  readonly end: number;
}

await initParser();

const entries = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
console.log(`parsing ${entries.length} .al files under ${projectDir} ...`);
const files: SourceFile[] = [];
for (const rel of entries) {
  const source = await readFile(join(projectDir, rel), "utf8");
  files.push({ path: rel, root: wrapRoot(parseAL(source)) });
}
const ctx = buildSemanticContext(files);
console.log(`semantic context built over ${files.length} files\n`);

const calls: CallRec[] = [];
const specs: SpecRec[] = [];
const calleeCount = new Map<string, number>();
const voidMethodCall = tier1Operators.find((o) => o.name === "lethal.void-method-call");

for (const file of files) {
  walk(file.root, (node) => {
    const callee = canonicalCallee(node);
    if (callee !== null) {
      calleeCount.set(callee, (calleeCount.get(callee) ?? 0) + 1);
      let statementSlot = false;
      try {
        statementSlot = voidMethodCall?.targets(node, ctx) ?? false;
      } catch {
        statementSlot = false;
      }
      calls.push({
        file: file.path,
        callee,
        start: node.startIndex,
        end: node.endIndex,
        statementSlot,
      });
    }
    for (const op of operators) {
      let claims = false;
      try {
        claims = op.targets(node, ctx);
      } catch {
        continue;
      }
      if (!claims) continue;
      try {
        for (const spec of op.generate(node, ctx)) {
          specs.push({
            file: file.path,
            operator: op.name,
            start: spec.before.startIndex,
            end: spec.before.endIndex,
          });
        }
      } catch {
        // An operator that throws on a node shape is a grammar signal, not this probe's subject.
      }
    }
  });
}

const statementSlotCalls = calls.filter((c) => c.statementSlot).length;
console.log(`procedure_call nodes with a composable callee: ${calls.length}`);
console.log(
  `  statement-slot (void-method-call claims, so VISIBLE in a report): ${statementSlotCalls}`,
);
console.log(`  not statement-slot (INVISIBLE in any report): ${calls.length - statementSlotCalls}`);
console.log(`raw mutation specs (pre-dedup, pre-instrumentability): ${specs.length}\n`);

if (patterns.length === 0) {
  console.log(
    "=== top 40 canonical callees by call count — pick patterns from this, do not guess ===",
  );
  for (const [name, n] of [...calleeCount].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(String(n).padStart(5), name);
  }
  process.exit(0);
}

const matched = calls.filter((c) => patterns.some((p) => globMatch(p, c.callee)));
console.log(`=== patterns: ${patterns.join(" ")} ===`);
console.log(
  `matched calls: ${matched.length} (statement-slot ${matched.filter((c) => c.statementSlot).length}, other ${matched.filter((c) => !c.statementSlot).length})`,
);

// The over-match check: distinct callee STRINGS, never a bare count. A count cannot tell a pattern
// that matched the intended telemetry wrapper from one that also matched a Record variable of the
// same name, and the second silently deletes mutants on real data operations.
const perPattern = new Map<string, Set<string>>();
for (const c of matched) {
  for (const p of patterns) {
    if (!globMatch(p, c.callee)) continue;
    const seen = perPattern.get(p) ?? new Set<string>();
    seen.add(c.callee);
    perPattern.set(p, seen);
  }
}
console.log("\n=== distinct callee strings each pattern matched ===");
for (const p of patterns) {
  const hit = [...(perPattern.get(p) ?? [])].sort();
  console.log(`  ${p} -> ${hit.length === 0 ? "(NOTHING — a silent no-op)" : hit.join(", ")}`);
}

const byFile = new Map<string, CallRec[]>();
for (const c of matched) {
  const list = byFile.get(c.file) ?? [];
  list.push(c);
  byFile.set(c.file, list);
}

const droppedByOp = new Map<string, number>();
const exactSpanByOp = new Map<string, number>();
let dropped = 0;
let droppedInStatementSlot = 0;
for (const s of specs) {
  const cs = byFile.get(s.file);
  if (cs === undefined) continue;
  for (const c of cs) {
    if (s.start < c.start || s.end > c.end) continue;
    dropped++;
    if (c.statementSlot) droppedInStatementSlot++;
    droppedByOp.set(s.operator, (droppedByOp.get(s.operator) ?? 0) + 1);
    if (s.start === c.start && s.end === c.end) {
      exactSpanByOp.set(s.operator, (exactSpanByOp.get(s.operator) ?? 0) + 1);
    }
    break;
  }
}

console.log("\n=== INCLUSIVE containment drop ===");
console.log(
  `specs dropped: ${dropped} of ${specs.length} (${((dropped / specs.length) * 100).toFixed(2)}% raw)`,
);
console.log(`  inside a statement-slot call: ${droppedInStatementSlot}`);
console.log(
  `  inside a NON-statement-slot call: ${dropped - droppedInStatementSlot}  <-- invisible to any report-based measurement`,
);
console.log("\nby operator:");
for (const [op, n] of [...droppedByOp].sort((a, b) => b[1] - a[1])) {
  console.log(
    "   ",
    String(n).padStart(5),
    op.padEnd(34),
    `(exact-span: ${exactSpanByOp.get(op) ?? 0})`,
  );
}

const exactTotal = [...exactSpanByOp.values()].reduce((a, b) => a + b, 0);
console.log(`\nSTRICT containment would drop only ${dropped - exactTotal}.`);
console.log(
  "Every call-claiming operator sets `before` to the procedure_call node itself, so exact-span",
);
console.log(
  "mutants survive strict containment and the filter removes almost nothing. Inclusive containment",
);
console.log("is therefore forced, and inclusive is what reaches the guard mutants above.");
