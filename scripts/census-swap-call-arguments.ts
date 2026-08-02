#!/usr/bin/env bun
/**
 * R82 general footprint census: how many CALL SITES on a real project admit a type-safe swap of
 * two same-typed arguments?
 *
 * R13 measured only the event-scoped slice (44 raise sites reaching a two-same-typed-param
 * publisher, 21 of them subscribed anywhere) and filed the general operator as R82 precisely
 * because restricting an argument swap to event raises is arbitrary. This is the general count,
 * and unlike the R13 census it uses the real `buildTypeTable` rather than a name census — a call's
 * arguments carry no declared types at the site, so nothing short of the semantic layer can say
 * whether two of them share one.
 *
 * COUNTING RULE — pre-committed in ROADMAP.md R82 (`ef28f58`) BEFORE this script was run:
 *   1. One mutant per call site. Three same-typed arguments still count 1.
 *   2. A site qualifies iff: >=2 arguments; >=2 of them resolve to the SAME non-null type;
 *      those two differ in whitespace-normalised source text (a swap of identical text is a
 *      no-op, equivalent by construction); and `isMutableSite` holds.
 *   3. Denominator 19,132 — R13's shipped-mutant count on do-rel2/Cloud.
 *   4. Bar (a): >=13 MARGINAL mutants. Overlap with a shipped operator at the same site is
 *      reported, not subtracted — see the `--- overlap ---` section for why.
 *   5. The untyped share is reported, because it bounds the qualifying count from BELOW.
 *   6. The var-safety split is reported: both arguments plain variable references (safe whatever
 *      the callee's `var` parameters are) vs at least one literal/expression (where a callee
 *      `var` parameter would make the swapped call fail to compile).
 *
 *   bun scripts/census-swap-call-arguments.ts [project-dir]
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { findEnclosingStatement, isStatementPosition } from "../packages/engine/src/ast/tree-walks";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

/** R13's shipped-mutant count on do-rel2/Cloud — the axis bar (a) and bar (b) are stated on. */
const DENOM = 19132;

const projectDir = process.argv[2] ?? "U:/Git/do-rel2/Cloud";

interface Site {
  readonly file: string;
  readonly callee: string;
  readonly argCount: number;
  /** Shared type of the chosen pair, when the site qualifies. */
  readonly sharedType: string | null;
  readonly typedArgs: number;
  readonly stmtPosition: boolean;
  readonly mutable: boolean;
  /** Both members of the chosen pair are bare identifiers — a swap cannot break a `var` param. */
  readonly bothIdentifiers: boolean;
  /** A same-typed pair existed but both members had identical text: a no-op swap. */
  readonly identicalOnly: boolean;
  /**
   * The pair's members carry the SAME FULL declared type, not just the same truncated head.
   * `null` when at least one member has no declaration to read (a literal or an expression).
   */
  readonly strictSameType: boolean | null;
  readonly text: string;
}

function walk(node: ALSyntaxNode, visit: (n: ALSyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

/** Last identifier of a callee: `Cust.SetRange(...)` -> SetRange, `Foo(...)` -> Foo. */
function calleeName(call: ALSyntaxNode): string {
  const head = call.namedChildren[0];
  if (head === undefined) return "?";
  if (head.kind === "identifier") return head.text;
  if (head.kind === "member_expression") {
    const ids = head.namedChildren.filter((c) => c.kind === "identifier");
    return ids[ids.length - 1]?.text ?? "?";
  }
  return "?";
}

/**
 * Type identity as DECLARED, where `buildTypeTable` answers only the truncated head.
 *
 * `types.ts`'s `extractType` keeps the first whitespace-delimited token, so `Record "Sales Header"`
 * and `Record "Purchase Header"` both answer `Record` — two DIFFERENT types the loose rule would
 * pair into a swap that does not compile. Every subtype-bearing AL type has that shape
 * (`Codeunit "X"`, `List of [Text]`, `Enum "Y"`, `Interface "Z"`), so the head alone cannot decide
 * type safety.
 *
 * `Label` is the one deliberate collapse: `Label 'Posting...'` and `Label 'Done'` are the SAME type
 * declared with different constant text, and comparing the raw declaration would reject a swap that
 * is perfectly type-safe.
 */
function normalizeDeclaredType(typeText: string): string {
  const collapsed = typeText.replace(/\s+/g, " ").trim();
  if (/^label\b/i.test(collapsed)) return "Label";
  return collapsed.toLowerCase();
}

/**
 * The declaration of `name` visible from `scope`, innermost scope first.
 *
 * Reads the AST directly rather than the symbol table: `resolveIdentifierType` iterates
 * `symbols.objects` and walks up until it meets THAT object's node, so for the wrong object it
 * still finds a `procedure` ancestor first and asks the wrong scope. Walking up from the argument
 * cannot mis-scope — every ancestor is, by construction, an enclosing scope of this identifier.
 */
function lookupDeclaredType(scope: ALSyntaxNode, name: string): string | null {
  // `"Code": Code[20]` is a legal parameter name — the declaration site is a `quoted_identifier`
  // while the USE site is a bare `identifier`, so a raw text comparison misses it.
  const unquote = (s: string): string => s.replace(/^"|"$/g, "").toLowerCase();
  const isName = (n: ALSyntaxNode): boolean =>
    n.kind === "identifier" || n.kind === "quoted_identifier";
  const wanted = unquote(name);
  for (const child of scope.namedChildren) {
    if (child.kind === "parameter_list") {
      for (const param of child.namedChildren) {
        const id = param.namedChildren.find(isName);
        if (id === undefined || unquote(id.text) !== wanted) continue;
        const type = param.namedChildren.find((c) => c.kind === "type_specification");
        if (type !== undefined) return type.text;
      }
    }
    if (child.kind !== "var_section") continue;
    const body = child.namedChildren.find((c) => c.kind === "var_body") ?? child;
    for (const decl of body.namedChildren) {
      if (decl.kind !== "variable_declaration") continue;
      const ids = decl.namedChildren.filter(isName);
      if (!ids.some((i) => unquote(i.text) === wanted)) continue;
      // A `Label` declares as `basic_type` + `string_literal`, NOT `type_specification` — reading
      // only the latter silently dropped every Label pair (50 of them on Document Output) into
      // "no declaration to read". Found by the discrepancy check below, not by inspection.
      const type =
        decl.namedChildren.find((c) => c.kind === "type_specification") ??
        decl.namedChildren.find((c) => c.kind === "basic_type");
      if (type !== undefined) return type.text;
    }
  }
  return null;
}

/** Walk out from an identifier through every enclosing scope until one declares it. */
function declaredTypeOfIdentifier(node: ALSyntaxNode): string | null {
  if (node.kind !== "identifier") return null;
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    const hit = lookupDeclaredType(current, node.text);
    if (hit !== null) return normalizeDeclaredType(hit);
    current = current.parent;
  }
  return null;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const isDep = (rel: string): boolean => rel.replace(/\\/g, "/").includes(".dependencies/");
const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(2)}%`;

await initParser();

const entries = (await readdir(projectDir, { recursive: true }))
  .filter((e) => e.toLowerCase().endsWith(".al"))
  .filter((e) => !basename(e).startsWith("Mutation"))
  .filter((e) => !isDep(e))
  .sort();

const files: SourceFile[] = [];
for (const rel of entries) {
  const source = await readFile(join(projectDir, rel), "utf8");
  files.push({ path: rel, root: wrapRoot(parseAL(source)) });
}

// ONE semantic context over the whole project: identifier resolution walks every object, so a
// per-file context would answer `null` for anything declared elsewhere.
const ctx = buildSemanticContext(files);

const sites: Site[] = [];
let callsWithArgs = 0;
let callsWithTwoPlusArgs = 0;

for (const file of files) {
  walk(file.root, (n) => {
    if (n.kind !== ALNodeKind.procedure_call) return;
    const argList = n.namedChildren.find((c) => c.kind === "argument_list");
    if (argList === undefined) return;
    const args = argList.namedChildren;
    if (args.length > 0) callsWithArgs += 1;
    if (args.length < 2) return;
    callsWithTwoPlusArgs += 1;

    const types = args.map((a) => ctx.types.typeOf(a));
    const typedArgs = types.filter((t) => t !== null).length;

    // Deterministic pair choice: the lexicographically first (i, j) that satisfies the rule.
    let chosen: readonly [number, number] | null = null;
    let identicalOnly = false;
    outer: for (let i = 0; i < args.length; i += 1) {
      for (let j = i + 1; j < args.length; j += 1) {
        const ti = types[i];
        const tj = types[j];
        if (ti === null || ti === undefined || ti !== tj) continue;
        const ai = args[i];
        const aj = args[j];
        if (ai === undefined || aj === undefined) continue;
        if (norm(ai.text) === norm(aj.text)) {
          identicalOnly = true;
          continue;
        }
        chosen = [i, j];
        break outer;
      }
    }

    const sharedType = chosen === null ? null : (types[chosen[0]] ?? null);
    const pairArgs = chosen === null ? [] : [args[chosen[0]], args[chosen[1]]];
    // Strict check, on the FULL declared type. `null` when at least one member is a literal or an
    // expression and so has no declaration to read — there the truncated head is all there is.
    const declared = pairArgs.map((a) => (a === undefined ? null : declaredTypeOfIdentifier(a)));
    const strictSameType =
      chosen === null || declared.length !== 2
        ? null
        : declared[0] === null || declared[1] === null
          ? null
          : declared[0] === declared[1];
    sites.push({
      file: file.path,
      callee: calleeName(n),
      argCount: args.length,
      sharedType,
      typedArgs,
      stmtPosition: isStatementPosition(n),
      mutable: findEnclosingStatement(n) !== null,
      bothIdentifiers: chosen !== null && pairArgs.every((a) => a?.kind === "identifier"),
      identicalOnly: chosen === null && identicalOnly,
      strictSameType,
      text: norm(n.text).slice(0, 80),
    });
  });
}

// --- report -------------------------------------------------------------------------------
console.log(`project: ${projectDir}`);
console.log(`.al files scanned: ${files.length} (dependencies and Mutation* excluded)\n`);

console.log("=== the funnel ===");
console.log(`  call sites with >=1 argument:                 ${callsWithArgs}`);
console.log(`  call sites with >=2 arguments:                ${callsWithTwoPlusArgs}`);

const twoPlusTyped = sites.filter((s) => s.typedArgs >= 2);
console.log(
  `  ...of which >=2 arguments TYPE at all:        ${twoPlusTyped.length}  (${pct(twoPlusTyped.length, callsWithTwoPlusArgs)} of the line above)`,
);
console.log(
  `  ...the rest are invisible to buildTypeTable:  ${callsWithTwoPlusArgs - twoPlusTyped.length}  — this is what bounds the count from BELOW`,
);

const sameTypePair = sites.filter((s) => s.sharedType !== null);
console.log(`  ...with a same-typed pair of DIFFERING text:  ${sameTypePair.length}`);
const identicalOnly = sites.filter((s) => s.identicalOnly);
console.log(
  `  (excluded: same-typed pair but IDENTICAL text — a no-op swap: ${identicalOnly.length})`,
);

const mutable = sameTypePair.filter((s) => s.mutable);
console.log(
  `  ...and isMutableSite (has an enclosing statement): ${mutable.length}   <-- QUALIFYING SITES`,
);
console.log(
  `  (dropped as non-executable — page/report property position: ${sameTypePair.length - mutable.length})`,
);
console.log(
  `\n  QUALIFYING = ${mutable.length} mutants = ${pct(mutable.length, DENOM)} of ${DENOM}`,
);
console.log("  bar (a) is >=13 marginal mutants.");

console.log("\n=== the kill signal: what type is being swapped ===");
const byType = new Map<string, number>();
for (const s of mutable)
  byType.set(s.sharedType ?? "?", (byType.get(s.sharedType ?? "?") ?? 0) + 1);
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${t.padEnd(14)} ${String(n).padStart(5)}  ${pct(n, mutable.length)}`);
}
const bool = byType.get("Boolean") ?? 0;
console.log(
  `\n  Boolean/Boolean share: ${bool} (${pct(bool, mutable.length)}) — swap-modify-flag's equivalence problem`,
);

console.log("\n=== is the shared type REAL, or an artifact of a truncated type head? ===");
const strictYes = mutable.filter((s) => s.strictSameType === true);
const strictNo = mutable.filter((s) => s.strictSameType === false);
const strictUnknown = mutable.filter((s) => s.strictSameType === null);
console.log(
  `  both members declared, FULL declared type equal:   ${strictYes.length}  (${pct(strictYes.length, mutable.length)})`,
);
console.log(
  `  both members declared, full types DIFFER:          ${strictNo.length}  — the head matched, the type does not; this swap would NOT compile`,
);
console.log(
  `  at least one member is a literal or expression:    ${strictUnknown.length}  — no declaration to read`,
);
const strictNoByType = new Map<string, number>();
for (const s of strictNo)
  strictNoByType.set(s.sharedType ?? "?", (strictNoByType.get(s.sharedType ?? "?") ?? 0) + 1);
for (const [t, n] of [...strictNoByType].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    head "${t}" hiding differing subtypes: ${n}`);
}

console.log("\n=== type safety provable from SOURCE ALONE (the callee's var params are not) ===");
const varSafe = mutable.filter((s) => s.bothIdentifiers);
console.log(
  `  both members of the pair are bare identifiers:  ${varSafe.length}  (${pct(varSafe.length, mutable.length)})`,
);
console.log(
  `  at least one is a literal or expression:        ${mutable.length - varSafe.length}  — a callee \`var\` parameter there is a compile error`,
);
// The intersection is the only slice provable WITHOUT resolving the callee: two bare variables of
// one declared type are both lvalues and both exact-type, so the swap type-checks whatever the
// callee's parameters are — including `var` ones, which AL matches by exact type and rejects for
// non-lvalues.
const provable = mutable.filter((s) => s.bothIdentifiers && s.strictSameType === true);
console.log(
  "\n  PROVABLE WITHOUT RESOLVING THE CALLEE (both bare variables, equal full declared type):",
);
console.log(
  `    ${provable.length} sites = ${pct(provable.length, DENOM)} of ${DENOM}  — against bar (a)'s >=13`,
);
const provableBool = provable.filter((s) => s.sharedType === "Boolean").length;
console.log(
  `    of which Boolean/Boolean: ${provableBool} (${pct(provableBool, provable.length)})`,
);

// Both members are bare identifiers, `buildTypeTable` gave them a type, and yet no declaration is
// visible from the identifier's own scope. That combination should be empty: if the type table can
// see a declaration, walking out from the node must reach it too.
const scopeDiscrepancy = mutable.filter((s) => s.bothIdentifiers && s.strictSameType === null);
if (scopeDiscrepancy.length > 0) {
  console.log("\n=== DISCREPANCY: typed by buildTypeTable, undeclared in the node's own scope ===");
  console.log(`  ${scopeDiscrepancy.length} sites`);
  for (const s of scopeDiscrepancy.slice(0, 6)) {
    console.log(`  [${s.sharedType}] ${s.text}`);
    console.log(`      ${s.file}`);
  }
}

console.log("\n=== overlap with a shipped operator at the SAME call site ===");
const stmt = mutable.filter((s) => s.stmtPosition);
console.log(
  `  qualifying sites also in statement position (lethal.void-method-call claims them): ${stmt.length}`,
);
console.log(
  "  NOT subtracted: dedup identity is kind:start:end:after.text (schemata/src/dedup.ts:23) and",
);
console.log(
  `  emitDispatch chains multiple mutants per component, so a swap's replacement text never`,
);
console.log(`  collides with a deletion's empty one. Marginal == gross.`);

console.log("\n=== a sample of qualifying sites ===");
for (const s of mutable.slice(0, 12)) {
  console.log(`  [${s.sharedType}] ${s.text}`);
  console.log(`      ${s.file}`);
}
