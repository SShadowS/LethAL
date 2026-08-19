#!/usr/bin/env bun
/**
 * R165 probe: how many argument-less `Insert()`/`Modify()`/`Delete()` sites could a FORWARD
 * run-trigger operator actually claim, once it is scoped to receivers it can reason about?
 *
 *   bun scripts/r165-probe/census.ts <project-dir>
 *
 * R165 measured 345 argument-less sites and called them the missing direction. That count is the
 * ceiling, not the operator's footprint, and the difference is the whole decision:
 *
 *   - `Rec.Modify()` means `RunTrigger = false`, so the forward mutant is `Modify(true)`, which
 *     RUNS the table's `OnModify`.
 *   - If the receiver's table declares no such trigger, the mutant is close to equivalent and would
 *     be a near-universal survivor, which is exactly what `RemoveSetLoadFields` was refused for.
 *     "Close to" and not "provably": running triggers also raises the platform's integration events,
 *     and a subscriber elsewhere can observe that. So this is a scoping COST, not an equivalence
 *     proof, and it is recorded as one.
 *   - If the receiver is a base-app record, this project cannot see the trigger at all, so no screen
 *     can classify a kill there.
 *
 * So the operator can only be honest where the table is THIS PROJECT'S and declares the trigger.
 * This counts that, against the ceiling, so the R13 bar (>= 13 MARGINAL sites) is applied to the
 * number that would actually ship.
 *
 * Only counts and method names are printed; no source text leaves the process.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exactArguments } from "../../packages/builtin-tier2/src/mutate-helpers";
import { claimsRecordMethod } from "../../packages/builtin-tier2/src/receiver";
import { initParser, parseAL } from "../../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../../packages/engine/src/semantic/context";
import type { SourceFile } from "../../packages/engine/src/semantic/symbol-table";

const [projectDir] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/r165-probe/census.ts <project-dir>");
  process.exit(2);
}

const METHODS = ["Insert", "Modify", "Delete"] as const;
type Method = (typeof METHODS)[number];
const TRIGGER_OF: Record<Method, string> = {
  Insert: "OnInsert",
  Modify: "OnModify",
  Delete: "OnDelete",
};

await initParser();
const rel = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const files: SourceFile[] = [];
for (const r of rel) {
  files.push({ path: r, root: wrapRoot(parseAL(await readFile(join(projectDir, r), "utf8"))) });
}
const ctx = buildSemanticContext(files);

/**
 * Every table this project declares, with the set of table triggers it (or a `tableextension` on
 * it) declares. Built here rather than in the symbol table: the probe is deciding whether the
 * symbol table needs to answer this at all.
 */
const triggersByTable = new Map<string, Set<string>>();
function indexTriggers(node: ALSyntaxNode, tableName: string): void {
  const key = tableName.toLowerCase();
  const set = triggersByTable.get(key) ?? new Set<string>();
  // Table triggers are direct members; a FIELD's OnValidate sits deeper and is not one of these.
  const body = node.namedChildren.find((c) => c.rawKind === "declaration_body") ?? node;
  for (const member of body.namedChildren) {
    if (member.rawKind !== "trigger_declaration") continue;
    const name = member.namedChildren.find(
      (c) => c.rawKind === "identifier" || c.rawKind === "quoted_identifier",
    );
    if (name !== undefined) set.add(name.text.toLowerCase());
  }
  triggersByTable.set(key, set);
}
for (const f of files) {
  for (const obj of f.root.children) {
    if (obj.rawKind === "table_declaration") {
      const name = obj.namedChildren.find(
        (c) => c.rawKind === "quoted_identifier" || c.rawKind === "identifier",
      );
      if (name !== undefined) indexTriggers(obj, name.text.replace(/^"|"$/g, ""));
    }
    if (obj.rawKind === "tableextension_declaration") {
      const names = obj.namedChildren.filter(
        (c) => c.rawKind === "quoted_identifier" || c.rawKind === "identifier",
      );
      const base = names[1];
      if (base !== undefined) indexTriggers(obj, base.text.replace(/^"|"$/g, ""));
    }
  }
}

/** The receiver's table name, when it is a plain identifier declared `Record "X"`. */
function receiverTable(node: ALSyntaxNode): string | null {
  const callee = node.childForFieldName("function");
  if (callee === null || callee.rawKind !== "member_expression") return null;
  const recv = callee.childForFieldName("object");
  if (recv === null || recv.rawKind !== "identifier") return null;
  const type = ctx.types.typeOf(recv);
  const match = type === null ? null : /^\s*Record\s+(.+?)\s*$/i.exec(type);
  const raw = match?.[1];
  if (raw === undefined) return null;
  return raw.replace(/^"|"$/g, "");
}

const counts = {
  zeroArg: 0,
  implicitReceiver: 0,
  tableUnresolved: 0,
  tableResolvedNoTrigger: 0,
  claimable: 0,
};
const byMethod = new Map<string, number>();
const claimableByMethod = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function walk(node: ALSyntaxNode, inExec: boolean): void {
  if (inExec && node.rawKind === "call_expression") {
    for (const method of METHODS) {
      if (!claimsRecordMethod(node, ctx, method)) continue;
      if (exactArguments(node, 0) === null) continue;
      counts.zeroArg += 1;
      bump(byMethod, method);
      const table = receiverTable(node);
      if (table === null) {
        // Either an implicit `Rec` (no member_expression callee) or a receiver whose type this
        // project cannot resolve. Both are counted as unreasonable-about rather than merged.
        const callee = node.childForFieldName("function");
        if (callee !== null && callee.rawKind === "identifier") counts.implicitReceiver += 1;
        else counts.tableUnresolved += 1;
        break;
      }
      const triggers = triggersByTable.get(table.toLowerCase());
      if (triggers === undefined) {
        counts.tableUnresolved += 1;
        break;
      }
      if (!triggers.has(TRIGGER_OF[method].toLowerCase())) {
        counts.tableResolvedNoTrigger += 1;
        break;
      }
      counts.claimable += 1;
      bump(claimableByMethod, method);
      break;
    }
  }
  const next = inExec || node.rawKind === "procedure" || node.rawKind === "trigger_declaration";
  for (const c of node.namedChildren) walk(c, next);
}
for (const f of files) walk(f.root, false);

console.log(`files: ${files.length}, project tables indexed: ${triggersByTable.size}\n`);
console.log(`argument-less Insert/Modify/Delete calls on a proven record:  ${counts.zeroArg}`);
for (const [k, v] of [...byMethod].sort()) console.log(`    ${k.padEnd(10)} ${v}`);
console.log("");
console.log(
  `  implicit Rec receiver, no table to reason about:            ${counts.implicitReceiver}`,
);
console.log(
  `  receiver's table NOT declared by this project:              ${counts.tableUnresolved}`,
);
console.log(
  `  table declared but declares no matching trigger:            ${counts.tableResolvedNoTrigger}`,
);
console.log(`  CLAIMABLE (table declared AND declares the trigger):        ${counts.claimable}`);
for (const [k, v] of [...claimableByMethod].sort()) console.log(`    ${k.padEnd(10)} ${v}`);
console.log("");
console.log(`R13 bar for an operator on the existing emit path is >= 13 MARGINAL sites.`);
