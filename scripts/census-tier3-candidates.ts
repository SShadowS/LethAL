#!/usr/bin/env bun
/**
 * R13 go/no-go census: how many candidate SITES do the three sketched Tier-3 operators have on a
 * real project, and which of them sit in EXECUTABLE position?
 *
 * Counting rule fixed in ROADMAP.md (349901a) before this ran: count SITES, one mutant per site.
 * Reproduces the figures in docs/superpowers/specs/2026-08-02-r13-tier3-decision.md §2.
 *
 *   bun scripts/census-tier3-candidates.ts <project-dir>
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { isStatementPosition } from "../packages/engine/src/ast/tree-walks";

const EVENT_ATTRS = new Set([
  "integrationevent",
  "businessevent",
  "internalevent",
  "externalbusinessevent",
]);

interface Publisher {
  readonly file: string;
  readonly owner: string;
  readonly name: string;
  readonly paramTypes: readonly string[];
  readonly paramNames: readonly string[];
}

function walk(node: ALSyntaxNode, visit: (n: ALSyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

/** Last identifier of a callee: `Cust.LockTable()` -> LockTable, `Foo()` -> Foo. */
function calleeName(call: ALSyntaxNode): string | undefined {
  const head = call.namedChildren[0];
  if (head === undefined) return undefined;
  if (head.kind === "identifier") return head.text;
  if (head.kind === "member_expression") {
    const ids = head.namedChildren.filter((c) => c.kind === "identifier");
    return ids[ids.length - 1]?.text;
  }
  return undefined;
}

const projectDir = process.argv[2];
if (!projectDir) {
  console.error("usage: bun scripts/census-tier3-candidates.ts <project-dir>");
  process.exit(2);
}

await initParser();
const entries = (await readdir(projectDir, { recursive: true }))
  .filter((e) => e.toLowerCase().endsWith(".al"))
  .filter((e) => !basename(e).startsWith("Mutation"))
  .sort();

const isDep = (rel: string): boolean => rel.replace(/\\/g, "/").includes(".dependencies/");

// --- counters -----------------------------------------------------------------------------
const permissionsProps: { file: string; owner: string; entries: number; text: string }[] = [];
const permissionSetObjects: { file: string; kind: string }[] = [];
const lockTable: { file: string; stmt: boolean }[] = [];
const readIsolationAssign: { file: string }[] = [];
const readIsolationCall: { file: string; stmt: boolean }[] = [];
const publishers: Publisher[] = [];
const raiseSites: { file: string; name: string; args: number; stmt: boolean }[] = [];

for (const rel of entries) {
  const source = await readFile(join(projectDir, rel), "utf8");
  const root = wrapRoot(parseAL(source));

  walk(root, (n) => {
    if (n.kind === "property") {
      const name = n.namedChildren.find((c) => c.kind === "property_name")?.text ?? "";
      if (name.toLowerCase() === "permissions") {
        const list = n.namedChildren.find((c) => c.kind === "tabledata_permission_list");
        const owner = n.parent?.parent?.kind ?? "?";
        permissionsProps.push({
          file: rel,
          owner,
          entries: list?.namedChildren.length ?? 0,
          text: n.text.replace(/\s+/g, " ").slice(0, 70),
        });
      }
    }
    if (n.kind.endsWith("_declaration") && n.kind.startsWith("permissionset")) {
      permissionSetObjects.push({ file: rel, kind: n.kind });
    }
    if (n.kind === "call_expression") {
      const name = calleeName(n)?.toLowerCase();
      if (name === "locktable") lockTable.push({ file: rel, stmt: isStatementPosition(n) });
      if (name === "readisolation")
        readIsolationCall.push({ file: rel, stmt: isStatementPosition(n) });
    }
    if (n.kind === "assignment_statement") {
      const lhs = n.namedChildren[0]?.text.toLowerCase() ?? "";
      if (lhs.endsWith("readisolation")) readIsolationAssign.push({ file: rel });
    }
  });

  // Event publishers: `attribute_item` is a sibling that PRECEDES the `procedure` it decorates.
  walk(root, (n) => {
    if (n.kind !== "declaration_body") return;
    const owner = n.parent?.namedChildren.find((c) => c.kind.endsWith("identifier"))?.text ?? "?";
    let pendingEvent = false;
    for (const member of n.namedChildren) {
      if (member.kind === "attribute_item") {
        const attr =
          member.namedChildren
            .find((c) => c.kind === "attribute_content")
            ?.namedChildren.find((c) => c.kind === "identifier")?.text ?? "";
        if (EVENT_ATTRS.has(attr.toLowerCase())) pendingEvent = true;
        continue;
      }
      if (member.kind !== "procedure") continue;
      if (pendingEvent) {
        const params =
          member.namedChildren.find((c) => c.kind === "parameter_list")?.namedChildren ?? [];
        publishers.push({
          file: rel,
          owner,
          name: member.namedChildren.find((c) => c.kind === "identifier")?.text ?? "?",
          paramTypes: params.map(
            (p) => p.namedChildren.find((c) => c.kind === "type_specification")?.text ?? "?",
          ),
          paramNames: params.map(
            (p) => p.namedChildren.find((c) => c.kind === "identifier")?.text ?? "?",
          ),
        });
      }
      pendingEvent = false;
    }
  });
}

// Raise sites: a call to a name a publisher declares (integration events can only be raised
// inside their declaring object, so a global name map is a generous upper bound).
const publisherByName = new Map<string, Publisher>();
for (const p of publishers) publisherByName.set(p.name.toLowerCase(), p);
for (const rel of entries) {
  const source = await readFile(join(projectDir, rel), "utf8");
  const root = wrapRoot(parseAL(source));
  walk(root, (n) => {
    if (n.kind !== "call_expression") return;
    const name = calleeName(n)?.toLowerCase();
    if (name === undefined || !publisherByName.has(name)) return;
    const args = n.namedChildren.find((c) => c.kind === "argument_list")?.namedChildren.length ?? 0;
    raiseSites.push({ file: rel, name, args, stmt: isStatementPosition(n) });
  });
}

// --- report -------------------------------------------------------------------------------
const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(2)}%`;
const nondep = <T extends { file: string }>(xs: readonly T[]): number =>
  xs.filter((x) => !isDep(x.file)).length;

console.log(`project: ${projectDir}`);
console.log(
  `.al files scanned: ${entries.length} (of which .dependencies: ${entries.filter(isDep).length})\n`,
);

console.log("=== PermissionReduce ===");
console.log(
  `  Permissions properties:        ${permissionsProps.length}  (non-dependency: ${nondep(permissionsProps)})`,
);
const byOwner = new Map<string, number>();
for (const p of permissionsProps) byOwner.set(p.owner, (byOwner.get(p.owner) ?? 0) + 1);
for (const [k, v] of [...byOwner].sort((a, b) => b[1] - a[1]))
  console.log(`    ${k.padEnd(34)} ${v}`);
const totalEntries = permissionsProps.reduce((n, p) => n + p.entries, 0);
console.log(`  TableData entries inside them: ${totalEntries}`);
console.log(`  permissionset objects:         ${permissionSetObjects.length}`);
for (const p of permissionsProps.slice(0, 8)) console.log(`    e.g. ${p.file}: ${p.text}`);

console.log("\n=== IsolationLevelSwap ===");
console.log(
  `  LockTable() calls:             ${lockTable.length}  (statement position: ${lockTable.filter((l) => l.stmt).length}, non-dependency: ${nondep(lockTable)})`,
);
console.log(
  `  ReadIsolation := assignments:  ${readIsolationAssign.length}  (non-dependency: ${nondep(readIsolationAssign)})`,
);
console.log(`  ReadIsolation(...) calls:      ${readIsolationCall.length}`);

console.log("\n=== EventPublisherSignature ===");
console.log(
  `  event publishers declared:     ${publishers.length}  (non-dependency: ${nondep(publishers)})`,
);
const swappable = publishers.filter((p) => {
  const seen = new Map<string, number>();
  for (const t of p.paramTypes) seen.set(t, (seen.get(t) ?? 0) + 1);
  return [...seen.values()].some((n) => n >= 2);
});
const adjacent = publishers.filter((p) =>
  p.paramTypes.some((t, i) => i > 0 && p.paramTypes[i - 1] === t),
);
console.log(
  `  ...with >=2 params of ONE type: ${swappable.length} (a type-safe swap exists)  (non-dependency: ${nondep(swappable)})`,
);
console.log(`  ...with an ADJACENT same-type pair: ${adjacent.length}`);
console.log(
  `  raise sites (call to a publisher name): ${raiseSites.length}  (statement position: ${raiseSites.filter((r) => r.stmt).length})`,
);
const swappableNames = new Set(swappable.map((p) => p.name.toLowerCase()));
const raiseSwappable = raiseSites.filter((r) => swappableNames.has(r.name));
console.log(
  `  raise sites whose publisher has a type-safe swap: ${raiseSwappable.length}  (non-dependency: ${nondep(raiseSwappable)})`,
);
for (const p of swappable.slice(0, 6))
  console.log(`    e.g. ${p.owner}.${p.name}(${p.paramTypes.join("; ")})`);

// A swapped argument at a raise site is observable only if something SUBSCRIBES to that event.
// Subscribers live anywhere — including the Test app — so scan the whole checkout, not just Cloud.
const subscriberRoots = [
  projectDir,
  join(projectDir, "..", "Test"),
  join(projectDir, "..", "OnPrem"),
];
const subscribedNames = new Set<string>();
let subscriberAttrs = 0;
for (const rootDir of subscriberRoots) {
  let subEntries: string[];
  try {
    subEntries = (await readdir(rootDir, { recursive: true }))
      .filter((e) => e.toLowerCase().endsWith(".al"))
      .filter((e) => !basename(e).startsWith("Mutation"));
  } catch {
    continue;
  }
  for (const rel of subEntries) {
    const source = await readFile(join(rootDir, rel), "utf8");
    const root = wrapRoot(parseAL(source));
    walk(root, (n) => {
      if (n.kind !== "attribute_content") return;
      const id = n.namedChildren.find((c) => c.kind === "identifier")?.text ?? "";
      if (id.toLowerCase() !== "eventsubscriber") return;
      subscriberAttrs += 1;
      // 3rd argument of [EventSubscriber(ObjectType::Codeunit, Codeunit::"X", 'OnBeforeThing', ...)]
      const args =
        n.namedChildren.find((c) => c.kind === "attribute_arguments")?.namedChildren[0]
          ?.namedChildren ?? [];
      const third = args[2]?.text.replace(/^'|'$/g, "").trim();
      if (third) subscribedNames.add(third.toLowerCase());
    });
  }
}
const raiseSwappableSubscribed = raiseSites.filter(
  (r) => swappableNames.has(r.name) && subscribedNames.has(r.name),
);
console.log(
  `\n  [EventSubscriber] attributes across the checkout: ${subscriberAttrs}, naming ${subscribedNames.size} distinct events`,
);
console.log(
  `  raise sites: type-safe swap AND >=1 subscriber anywhere: ${raiseSwappableSubscribed.length}`,
);

const DENOM = 19132;
console.log("\n=== against the 19,132-mutant denominator ===");
console.log(
  `  PermissionReduce (per property):      ${permissionsProps.length}  ${pct(permissionsProps.length, DENOM)}`,
);
console.log(
  `  IsolationLevelSwap (LockTable+ReadIsolation): ${lockTable.length + readIsolationAssign.length + readIsolationCall.length}  ${pct(lockTable.length + readIsolationAssign.length + readIsolationCall.length, DENOM)}`,
);
console.log(
  `  EventPublisherSignature (raise sites, type-safe): ${raiseSwappable.length}  ${pct(raiseSwappable.length, DENOM)}`,
);
