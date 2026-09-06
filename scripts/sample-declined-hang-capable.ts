#!/usr/bin/env bun
/**
 * R196 Task 3 follow-up round (2026-09-06): categorises `census-hang-capable.ts`'s
 * `declinedUnresolved` sites, so the team lead can rule on whether that 25-26% rate is expected
 * (record/field or array targets `assignmentTargetOf` was never going to resolve in the first
 * place) or a real resolver gap (an ordinary local/parameter/global `resolveVarRef` should have
 * found and did not).
 *
 * Never writes AL source text: only file, line, procedure name, the enclosing object's KIND
 * (`codeunit`, `tableextension`, ...), whether the site is inside a trigger, and a diagnosis string
 * built from the SAME primitives `resolveVarRef`/`lookupVar` use internally (never a restated
 * resolver: this calls `ctx.symbols.localsOf`/`globalsOf`/`resolveProcedure` and
 * `collectVarDeclarations` directly, the exact functions `lookupVar` itself calls). The bare
 * identifier's own name is included ONLY when it reads as an ordinary, non-business-specific token
 * (a short generic name); anything else is reported as `<redacted>`.
 *
 *   bun scripts/sample-declined-hang-capable.ts <project-dir> <out.json>
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assignmentTargetOf,
  hasEnclosingLoop,
  isIdentifierLike,
} from "../packages/builtin-tier1/src/loop-hazard";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { declarationMembers, findEnclosingProcedure } from "../packages/engine/src/ast/tree-walks";
import {
  type SemanticContext,
  buildSemanticContext,
} from "../packages/engine/src/semantic/context";
import { normalizeAlName, resolveVarRef } from "../packages/engine/src/semantic/resolve-var-ref";
import {
  collectVarDeclarations,
  enclosingObjectScopeKey,
} from "../packages/engine/src/semantic/symbol-table";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const [projectDir, outPath] = process.argv.slice(2);
if (projectDir === undefined || outPath === undefined) {
  console.error("usage: bun scripts/sample-declined-hang-capable.ts <project-dir> <out.json>");
  process.exit(2);
}

/** Same shape as `census-hang-capable.ts`'s own helper (copied, not imported: see that script's own
 *  comment on why importing a corpus-walking script executes a second census). */
async function collectAlFiles(dir: string): Promise<SourceFile[]> {
  const entries = (await readdir(dir, { recursive: true })).filter((f) =>
    f.toLowerCase().endsWith(".al"),
  );
  const files: SourceFile[] = [];
  for (const rel of entries) {
    const source = await readFile(join(dir, rel), "utf8");
    files.push({ path: rel, root: wrapRoot(parseAL(source)) });
  }
  return files;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function enclosingProcedureName(node: ALSyntaxNode): string | null {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.kind === ALNodeKind.procedure || p.kind === ALNodeKind.trigger) {
      const nameNode = p.childForFieldName("name");
      return nameNode === null ? null : stripQuotes(nameNode.text);
    }
  }
  return null;
}

/** Is `target` sitting directly inside a `trigger` (before hitting a `procedure` boundary)? */
function isInsideTrigger(target: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = target.parent; p !== null; p = p.parent) {
    if (p.kind === ALNodeKind.trigger) return true;
    if (p.kind === ALNodeKind.procedure) return false;
  }
  return false;
}

/**
 * Only a short, ordinary-looking token is reported by name (the team lead's own instruction: "if
 * the names would carry customer meaning" redact them, "ordinary variable names are fine"). A name
 * with digits, more than one capitalised word run together, or over 12 characters is treated as
 * possibly domain-specific and redacted; this errs toward redacting rather than toward leaking.
 */
function isOrdinaryLookingName(name: string): boolean {
  if (name.length > 12) return false;
  if (/\d/.test(name)) return false;
  const capitalRuns = name.match(/[A-Z][a-z]*/g) ?? [];
  return capitalRuns.length <= 1;
}

/**
 * The table this object's implicit `Rec` is bound to, if the object kind carries one at all: a
 * `table`'s own name, a `tableextension`'s extended table (from `ctx.symbols.tableExtensions`), or a
 * `page`'s own `SourceTable` property (read directly from its declaration, the same grammar field
 * `receiver.ts`'s private `sourceTableOf` reads).
 *
 * Mirrors those two private, per-kind helpers rather than importing them: neither is exported
 * (`receiver.ts` keeps them file-private, R30/R67's own module), and this asks the same static
 * grammar fact those helpers do, not a second RULE that could drift the way two hazard predicates
 * could (R80's concern), which is why `diagnose` below is comfortable duplicating it.
 *
 * `pageextension` is deliberately NOT resolved: its implicit `Rec` is the EXTENDED page's own
 * `SourceTable`, declared in an object this project usually cannot see (`receiver.ts` documents the
 * same gap), and neither sampled corpus produced a site that needed it.
 */
function boundTableNameOf(scopeKey: string, ctx: SemanticContext): string | null {
  const sep = scopeKey.indexOf(":");
  if (sep === -1) return null;
  const kind = scopeKey.slice(0, sep);
  const objectName = scopeKey.slice(sep + 1);

  if (kind === "table") return objectName;

  if (kind === "tableextension") {
    const ext = ctx.symbols.tableExtensions.find(
      (e) => normalizeAlName(e.name) === normalizeAlName(objectName),
    );
    return ext?.baseObject ?? null;
  }

  if (kind === "page") {
    const obj = ctx.symbols.objects.find(
      (o) => o.kind === "page" && normalizeAlName(o.name) === normalizeAlName(objectName),
    );
    if (obj === undefined) return null;
    for (const member of declarationMembers(obj.node)) {
      if (member.kind !== ALNodeKind.property) continue;
      const propName = member.childForFieldName("name");
      if (propName === null || normalizeAlName(propName.text) !== "sourcetable") continue;
      const value = member.childForFieldName("value");
      return value === null ? null : stripQuotes(value.text);
    }
    return null;
  }

  return null;
}

/**
 * Which scope, if any, actually carries this name, checked directly against the same primitives
 * `lookupVar` itself calls (`ctx.symbols.localsOf`/`globalsOf`/`resolveProcedure`,
 * `collectVarDeclarations`), a cross-check against `resolveVarRef`'s own answer, not a second
 * resolver: it does not decide anything, it only reports where (if anywhere) the name already sits.
 *
 * Distinguishes [[R210]]'s cause from AL's two undeclared-symbol shapes, rather than reporting every
 * decline as one bucket: an earlier version of this script re-ran the SAME name-keyed lookup
 * `resolveVarRef` itself uses (`localsOf`/`resolveProcedure`, both keyed by name alone) and so, for
 * exactly the sites [[R210]] describes, always disagreed with itself in the same way `resolveVarRef`
 * did: the cross-check could never separate "resolved to the wrong overload" from "not declared
 * anywhere", because it asked the identical question. The overload check below asks a DIFFERENT
 * question instead: does the symbol table's name-keyed answer for this procedure name point at the
 * SAME physical declaration `target` sits inside? If not, the object declares this name more than
 * once and resolution grabbed the wrong (earlier-indexed) one, proven by node position, not by
 * counting textual occurrences of the name.
 */
function diagnose(target: ALSyntaxNode, ctx: SemanticContext): string {
  const scopeKey = enclosingObjectScopeKey(target);
  if (scopeKey === null) return "no enclosing object/extension scope found for this node";

  const name = normalizeAlName(target.text);
  const nameMatches = (declaredName: string): boolean => normalizeAlName(declaredName) === name;

  if (isInsideTrigger(target)) {
    for (let p: ALSyntaxNode | null = target.parent; p !== null; p = p.parent) {
      if (p.kind === ALNodeKind.trigger) {
        const varSection = declarationMembers(p).find((c) => c.kind === ALNodeKind.var_section);
        const declaredInTrigger =
          varSection !== undefined &&
          collectVarDeclarations(varSection).some((v) => nameMatches(v.name));
        if (declaredInTrigger) {
          return "found in the enclosing trigger's OWN var section (resolveVarRef missed it: cross-check disagrees)";
        }
        // Not a trigger-local: fall through to the procedure/global checks below, matching
        // `lookupVar`'s own order exactly (trigger scope is checked FIRST, not EXCLUSIVELY: a
        // trigger body reads object globals too).
        break;
      }
      if (p.kind === ALNodeKind.procedure) break;
    }
  }

  const procedure = findEnclosingProcedure(target);
  if (procedure !== null) {
    const nameNode = procedure.childForFieldName("name");
    if (nameNode !== null) {
      const procName = stripQuotes(nameNode.text);

      // Checked BEFORE the overload test: even a hypothetically non-overloaded, correctly-keyed
      // `resolveProcedure` would still never capture this as an assignable symbol, since
      // `parseProcedure` (symbol-table.ts) reads the grammar's `return_value` field only as part of
      // `returnType`'s text, never as a `VarSymbol`. This cause holds independent of overloading, so
      // it must be asked first or an overloaded procedure with a named return value would be
      // misattributed to the overload collision instead.
      const returnValueNode = procedure.childForFieldName("return_value");
      if (returnValueNode !== null && nameMatches(returnValueNode.text)) {
        return "matches the procedure's own AL named return value, never captured as an assignable symbol";
      }

      const resolved = ctx.symbols.resolveProcedure(scopeKey, procName);

      // R210: the object declares `procName` more than once (AL permits overloading by parameter
      // list), and `resolveProcedure` is keyed by NAME ALONE (`.find(p => p.name === procName)`), so
      // it answers with whichever overload it indexed FIRST rather than the one `target` actually
      // sits inside. Proven by position, not inferred from a text count: two distinct declarations
      // can never start at the same byte offset in one file (the same positional argument
      // `loop-hazard.ts`'s own `sameDeclaration` relies on for the identical reason), so a mismatch
      // here is conclusive, not a guess.
      if (resolved !== null && resolved.node.startIndex !== procedure.startIndex) {
        return "procedure name declared more than once in its object (AL overload); resolveVarRef resolved against the WRONG overload's locals/parameters";
      }

      if (ctx.symbols.localsOf(scopeKey, procName).some((v) => nameMatches(v.name))) {
        return "found in the enclosing procedure's OWN locals (resolveVarRef missed it: cross-check disagrees)";
      }
      const params = resolved?.parameters ?? [];
      if (params.some((v) => nameMatches(v.name))) {
        return "found in the enclosing procedure's OWN parameters (resolveVarRef missed it: cross-check disagrees)";
      }
    }
  }

  if (ctx.symbols.globalsOf(scopeKey).some((v) => nameMatches(v.name))) {
    return "found in the enclosing object's OWN globals (resolveVarRef missed it: cross-check disagrees)";
  }

  if (name === "rec" || name === "xrec") {
    return "matches AL's implicit bound record ('Rec'/'xRec'), never declared as a symbol";
  }
  const boundTable = boundTableNameOf(scopeKey, ctx);
  if (boundTable !== null && ctx.symbols.fieldsOf(boundTable).some((f) => nameMatches(f.name))) {
    return "matches a bare, unqualified field of the object's own bound record, never declared as a variable symbol";
  }

  return "not declared in any scope this resolver checks, and not one of the two known undeclared-symbol shapes either (a genuinely unexplained decline)";
}

interface DeclinedRow {
  readonly file: string;
  readonly line: number;
  readonly procedureName: string | null;
  readonly objectScopeKind: string;
  readonly insideTrigger: boolean;
  readonly targetKind: string;
  readonly nameSample: string | "<redacted>";
  readonly diagnosis: string;
}

await initParser();
const files = await collectAlFiles(projectDir);
if (files.length === 0) {
  throw new Error(`sample-declined-hang-capable: no .al files found under ${projectDir}, refusing`);
}
const ctx = buildSemanticContext(files);

const declined: DeclinedRow[] = [];
// Every declined site's target MUST be an identifier read, bare or quoted (`isIdentifierLike`):
// `assignmentTargetOf` only ever returns non-null for one of those two kinds, so a member
// (`Rec.Field`) or array (`Arr[i]`) target is filtered out before "unresolved" is even asked.
// Asserted, not assumed: checked against the real node, not against a stored kind string.
let nonIdentifierTargetCount = 0;

for (const { path, root } of files) {
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement) {
      const target = assignmentTargetOf(n);
      if (target !== null && hasEnclosingLoop(n) && resolveVarRef(target, ctx) === null) {
        if (!isIdentifierLike(target)) nonIdentifierTargetCount += 1;
        const scopeKey = enclosingObjectScopeKey(target);
        const objectScopeKind = scopeKey === null ? "<none>" : (scopeKey.split(":")[0] ?? "<none>");
        const rawName = target.text;
        declined.push({
          file: path,
          line: n.startPosition.row + 1,
          procedureName: enclosingProcedureName(n),
          objectScopeKind,
          insideTrigger: isInsideTrigger(target),
          targetKind: target.kind,
          nameSample: isOrdinaryLookingName(rawName) ? rawName : "<redacted>",
          diagnosis: diagnose(target, ctx),
        });
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
}

if (nonIdentifierTargetCount > 0) {
  throw new Error(
    `sample-declined-hang-capable: ${nonIdentifierTargetCount} declined site(s) had a non-identifier target, which assignmentTargetOf should never produce, refusing to report a broken invariant silently`,
  );
}

// Even sample across the WHOLE corpus (stride sampling over the file-then-line-ordered list), not
// the first N in walk order, which would cluster in whichever file sorts/walks first.
const SAMPLE_SIZE = 30;
const stride = declined.length <= SAMPLE_SIZE ? 1 : Math.floor(declined.length / SAMPLE_SIZE);
const sample: DeclinedRow[] = [];
for (let i = 0; i < declined.length && sample.length < SAMPLE_SIZE; i += stride) {
  const row = declined[i];
  if (row !== undefined) sample.push(row);
}

const byDiagnosis = new Map<string, number>();
for (const row of sample) byDiagnosis.set(row.diagnosis, (byDiagnosis.get(row.diagnosis) ?? 0) + 1);
const byObjectKind = new Map<string, number>();
for (const row of sample) {
  byObjectKind.set(row.objectScopeKind, (byObjectKind.get(row.objectScopeKind) ?? 0) + 1);
}

const summary = {
  projectDir,
  totalDeclined: declined.length,
  sampleSize: sample.length,
  stride,
  nonIdentifierTargetsFound: nonIdentifierTargetCount,
  sampleByDiagnosis: Object.fromEntries(byDiagnosis),
  sampleByObjectKind: Object.fromEntries(byObjectKind),
};

console.log(JSON.stringify(summary, null, 2));
await writeFile(
  outPath,
  JSON.stringify({ summary, sample, allDeclined: declined }, null, 2),
  "utf8",
);
console.log(`wrote ${outPath}`);
