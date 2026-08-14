/**
 * R143 census: when a table's `OnInsert` exists, HOW does it set the primary key?
 *
 * R143 asks to narrow `run-trigger-skipped-insert` — the tag every `lethal.swap-modify-flag`
 * `Insert` mutant carries today — to the sites where the mechanism can actually fire: the target
 * table's `OnInsert` assigns a field of the primary key, so skipping the trigger leaves the key
 * blank and a second insert raises a duplicate key.
 *
 * The row names one limit that must be MEASURED rather than reasoned about before a predicate is
 * chosen: an `OnInsert` may assign the key INDIRECTLY (a No. Series call, a helper procedure), and
 * a literal "assigns a primary-key field" test would miss those. This script answers "how many" on
 * the one real corpus this repo has, so the predicate is chosen against a population instead of
 * against an example.
 *
 * Read-only. Parses a directory of `.al` files and classifies every table that declares `OnInsert`:
 *
 *   direct      the trigger body assigns a primary-key field textually (`"No." := ...`,
 *               `Rec."No." := ...`, or a `Validate("No.", ...)` of one)
 *   indirect    it does not, but the body calls something that conventionally supplies a key —
 *               a No. Series (`NoSeries`/`InitSeries`/`GetNextNo`) or `TestNoSeries` — or it
 *               calls a project procedure this census does not follow
 *   none        the body touches no primary-key field and calls nothing that could
 *
 * `indirect` is deliberately the residual-with-a-reason bucket: this census does not follow calls,
 * and saying so is the point. The number it produces is an UPPER bound on what a direct-assignment
 * predicate would miss, not an exact miss count.
 *
 *   bun scripts/r143-insert-census/census.ts <project-dir> [<project-dir> ...]
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { ALNodeKind } from "../../packages/engine/src/ast/node-kinds";
import { initParser, parseAL } from "../../packages/engine/src/ast/parser";
import { type ALSyntaxNode, findAll, wrapRoot } from "../../packages/engine/src/ast/syntax-node";
import { declarationMembers } from "../../packages/engine/src/ast/tree-walks";

type Classification = "direct" | "indirect" | "none";

interface TableFinding {
  readonly file: string;
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly classification: Classification;
  readonly why: string;
}

/** Names whose appearance in an `OnInsert` conventionally means "a No. Series supplies the key". */
const NO_SERIES_MARKERS = ["noseries", "initseries", "getnextno", "testnoseries"];

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

function objectName(node: ALSyntaxNode): string {
  const n = node.childForFieldName("object_name");
  return n === null ? "<unnamed>" : stripQuotes(n.text);
}

/**
 * The FIRST key entry's field list — AL's primary key. Read off the text of the `keys` section
 * rather than off named fields: the census only needs the field NAMES, and the shape
 * `key(PK; "No.", "Line No.")` yields them from the parenthesised list directly.
 */
function primaryKeyFields(tableNode: ALSyntaxNode): readonly string[] {
  const text = tableNode.text;
  const keysAt = text.search(/\bkeys\b/i);
  if (keysAt < 0) return [];
  const keyMatch = /\bkey\s*\(([^)]*)\)/i.exec(text.slice(keysAt));
  if (keyMatch === null) return [];
  const inner = keyMatch[1] ?? "";
  const semi = inner.indexOf(";");
  if (semi < 0) return [];
  return inner
    .slice(semi + 1)
    .split(",")
    .map((f) => stripQuotes(f.trim()))
    .filter((f) => f.length > 0);
}

function onInsertTrigger(tableNode: ALSyntaxNode): ALSyntaxNode | null {
  for (const member of declarationMembers(tableNode)) {
    if (member.kind !== ALNodeKind.trigger) continue;
    const name = member.childForFieldName("name");
    if (name !== null && name.text.toLowerCase() === "oninsert") return member;
  }
  // A table's triggers may sit deeper than the immediate declaration body depending on the
  // grammar's containers — fall back to a scan, still name-matched.
  for (const t of findAll(tableNode, ALNodeKind.trigger)) {
    const name = t.childForFieldName("name");
    if (name !== null && name.text.toLowerCase() === "oninsert") return t;
  }
  return null;
}

function classify(
  trigger: ALSyntaxNode,
  primaryKey: readonly string[],
): TableFinding["classification"] {
  const body = trigger.text;
  const lower = body.toLowerCase();
  for (const field of primaryKey) {
    const f = field.toLowerCase();
    // `"No." := ...`, `Rec."No." := ...` and `Validate("No.", ...)` — the shapes a direct-assignment
    // predicate would have to recognise.
    const quoted = `"${f}"`;
    const assign = new RegExp(`(^|[^\\w"])(rec\\.)?${escapeRegex(quoted)}\\s*:=`, "i");
    const bare = new RegExp(`(^|[^\\w"])(rec\\.)?${escapeRegex(f)}\\s*:=`, "i");
    const validate = new RegExp(`validate\\s*\\(\\s*(rec\\.)?${escapeRegex(quoted)}`, "i");
    const validateBare = new RegExp(`validate\\s*\\(\\s*(rec\\.)?${escapeRegex(f)}`, "i");
    if (
      assign.test(lower) ||
      bare.test(lower) ||
      validate.test(lower) ||
      validateBare.test(lower)
    ) {
      return "direct";
    }
  }
  if (NO_SERIES_MARKERS.some((m) => lower.includes(m))) return "indirect";
  // Any call at all inside the trigger could reach the key through a procedure this census does not
  // follow. `:=` alone is not a call; a `(` after an identifier is the cheap signal.
  if (/[a-z_"\]]\s*\(/i.test(lower.replace(/^\s*trigger\s+oninsert\s*\(\s*\)/i, ""))) {
    return "indirect";
  }
  return "none";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function alFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((e) => e.toLowerCase().endsWith(".al")).map((e) => join(dir, e));
}

async function main(): Promise<void> {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: bun scripts/r143-insert-census/census.ts <project-dir> [...]");
    process.exit(2);
  }
  await initParser();
  const findings: TableFinding[] = [];
  let tablesSeen = 0;
  let filesSeen = 0;
  for (const dir of dirs) {
    for (const path of await alFiles(dir)) {
      filesSeen++;
      const source = await readFile(path, "utf8");
      const root = wrapRoot(parseAL(source));
      for (const tableNode of findAll(root, ALNodeKind.table)) {
        tablesSeen++;
        const trigger = onInsertTrigger(tableNode);
        if (trigger === null) continue;
        const primaryKey = primaryKeyFields(tableNode);
        const classification = classify(trigger, primaryKey);
        findings.push({
          file: basename(path),
          table: objectName(tableNode),
          primaryKey,
          classification,
          why: classification,
        });
      }
    }
  }
  const by = (c: Classification) => findings.filter((f) => f.classification === c);
  console.log(
    `files: ${filesSeen}  tables: ${tablesSeen}  tables with OnInsert: ${findings.length}`,
  );
  console.log(`  direct   ${by("direct").length}`);
  console.log(`  indirect ${by("indirect").length}`);
  console.log(`  none     ${by("none").length}`);
  for (const c of ["direct", "indirect", "none"] as const) {
    for (const f of by(c)) {
      console.log(`${c.padEnd(9)} ${f.table} [${f.primaryKey.join(", ")}] (${f.file})`);
    }
  }
}

await main();
