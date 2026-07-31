/**
 * R30 measurement: how many Tier-2 sites would admitting `pageextension` members into the symbol
 * table's VARIABLE SCOPE index actually gain, on a real project?
 *
 * Counts, per pageextension file, calls of the four Tier-2 method names whose receiver is a
 * variable DECLARED IN THAT pageextension (global / procedure local / parameter) and typed
 * `Record`. That is exactly the set `claimsRecordMethod` would newly admit — rule 3 (shadowing)
 * can only shrink it, so this is an upper bound.
 *
 * Does not touch src. Reports the same shape for tableextension (already supported) and for plain
 * `page` (already supported) as controls.
 *
 * CALIBRATION — read this before quoting a number. The `tableextension` column is the control: that
 * kind was already supported, and this probe counts 17 sites for it on Document Output Cloud where
 * the change that enabled it actually gained +18 mutants. So the counts predict real gains to
 * within about one, and the `pageextension` count of 18 is a like-for-like figure rather than a
 * hopeful upper bound.
 *
 * WHAT IT DOES NOT COUNT: a receiver declared in a TRIGGER's own `var` section. Neither does
 * `lookupVar`, in any object kind (R68) — so the probe and the predicate agree, and the number for
 * trigger-declared receivers is unknown rather than zero.
 *
 * Results 2026-07-31, `U:/Git/do-rel2/Cloud` (554 `.al`):
 *   pageextension, receiver declared in the same object   18  (1 file, all procedure locals)
 *   pageextension, implicit Rec/xRec                        0
 *   pageextensions extending a page THIS project declares   0 of 93   <- why implicit Rec stays refused
 *   page, implicit Rec/xRec                                66        <- R67, a different item
 *
 * Usage: bun scripts/probe-r30-pageext.ts <projectDir>
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { varDeclarations } from "../packages/engine/src/ast/tree-walks";
import {
  ALNodeKind,
  type ALSyntaxNode,
  declarationMembers,
  findEnclosingProcedure,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "../packages/engine/src/index";

const METHODS = new Set(["testfield", "setrange", "calcfields", "modify"]);

const projectDir = process.argv[2];
if (projectDir === undefined) throw new Error("usage: probe-r30-pageext.ts <projectDir>");

await initParser();

const entries = (await readdir(projectDir, { recursive: true }))
  .filter((e) => e.toLowerCase().endsWith(".al"))
  .filter((e) => !basename(e).startsWith("Mutation"));

interface Hit {
  readonly file: string;
  readonly objectKind: string;
  readonly method: string;
  readonly receiver: string;
  readonly declaredIn: "global" | "local" | "parameter";
}

const hits: Hit[] = [];
const objectKindCounts = new Map<string, number>();
/** Tier-2-shaped calls on the object's IMPLICIT record (bare call, or `Rec.`/`xRec.`-qualified). */
const implicitHits: { file: string; objectKind: string; method: string }[] = [];
/** Every `pageextension`'s `extends` target, and every project `page` name -> its `SourceTable`. */
const pageExtBases: string[] = [];
const projectPages = new Map<string, string | null>();

function stripQuotes(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function declsOf(varSection: ALSyntaxNode | undefined, out: Map<string, string>): void {
  if (varSection === undefined) return;
  for (const decl of varDeclarations(varSection)) {
    if (decl.kind !== ALNodeKind.variable_declaration) continue;
    const nameNode = decl.childForFieldName("name");
    const typeNode = decl.childForFieldName("type");
    if (nameNode === null || typeNode === null) continue;
    out.set(stripQuotes(nameNode.text).toLowerCase(), typeNode.text);
  }
}

/** An object's globals — the `var_section` among its `declarationMembers`. */
function globalsOf(objectNode: ALSyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  declsOf(
    declarationMembers(objectNode).find((c) => c.kind === ALNodeKind.var_section),
    out,
  );
  return out;
}

/** A procedure's locals — a `var_section` that is a direct namedChild of the procedure. */
function localsOf(proc: ALSyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  declsOf(
    proc.namedChildren.find((c) => c.kind === ALNodeKind.var_section),
    out,
  );
  return out;
}

function isRecordType(typeText: string): boolean {
  return /^\s*record\b/i.test(typeText);
}

for (const rel of entries.sort()) {
  const source = await readFile(join(projectDir, rel), "utf8");
  const root = wrapRoot(parseAL(source));
  for (const objectNode of root.children) {
    const kind = objectNode.kind;
    objectKindCounts.set(kind, (objectKindCounts.get(kind) ?? 0) + 1);
    const globals = globalsOf(objectNode);

    if (kind === ALNodeKind.pageextension) {
      const baseNode = objectNode.childForFieldName("base_object");
      if (baseNode !== null) pageExtBases.push(stripQuotes(baseNode.text));
    }
    if (kind === ALNodeKind.page) {
      const nameNode = objectNode.childForFieldName("object_name");
      const src = /\bSourceTable\s*=\s*([^;]+);/i.exec(objectNode.text);
      if (nameNode !== null) {
        projectPages.set(stripQuotes(nameNode.text).toLowerCase(), src?.[1]?.trim() ?? null);
      }
    }

    visit(objectNode, (node) => {
      if (node.kind !== ALNodeKind.procedure_call) return;
      const callee = node.childForFieldName("function");
      // Implicit-receiver form: a bare `SetRange(...)` acts on the object's implicit Rec.
      if (callee !== null && callee.kind !== ALNodeKind.field_access) {
        const bare = stripQuotes(callee.text).toLowerCase();
        if (METHODS.has(bare)) implicitHits.push({ file: rel, objectKind: kind, method: bare });
        return;
      }
      if (callee === null || callee.kind !== ALNodeKind.field_access) return;
      const object = callee.childForFieldName("object");
      const member = callee.childForFieldName("member");
      if (object === null || member === null) return;
      const method = stripQuotes(member.text).toLowerCase();
      if (!METHODS.has(method)) return;
      const receiver = stripQuotes(object.text).toLowerCase();
      if (receiver === "rec" || receiver === "xrec") {
        implicitHits.push({ file: rel, objectKind: kind, method });
        return;
      }

      // Where is the receiver declared?
      const proc = findEnclosingProcedure(node);
      if (proc !== null) {
        const locals = localsOf(proc);
        const localType = locals.get(receiver);
        if (localType !== undefined) {
          if (isRecordType(localType))
            hits.push({
              file: rel,
              objectKind: kind,
              method,
              receiver,
              declaredIn: "local",
            });
          return;
        }
        // parameters
        const paramList = proc.childForFieldName("parameters");
        if (paramList !== null) {
          for (const p of paramList.namedChildren) {
            const pName = p.childForFieldName("name");
            const pType = p.childForFieldName("type");
            if (pName === null || pType === null) continue;
            if (stripQuotes(pName.text).toLowerCase() !== receiver) continue;
            if (isRecordType(pType.text))
              hits.push({
                file: rel,
                objectKind: kind,
                method,
                receiver,
                declaredIn: "parameter",
              });
            return;
          }
        }
      }
      const globalType = globals.get(receiver);
      if (globalType !== undefined && isRecordType(globalType)) {
        hits.push({ file: rel, objectKind: kind, method, receiver, declaredIn: "global" });
      }
    });
  }
}

const byKind = new Map<string, Map<string, number>>();
for (const h of hits) {
  const m = byKind.get(h.objectKind) ?? new Map<string, number>();
  m.set(h.method, (m.get(h.method) ?? 0) + 1);
  byKind.set(h.objectKind, m);
}

console.log(`project: ${projectDir}`);
console.log(`.al files scanned: ${entries.length}`);
console.log("\nobject declarations by kind:");
for (const [k, n] of [...objectKindCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${n}`);
}
console.log("\nTier-2-shaped calls on a record var DECLARED IN THE SAME OBJECT, by object kind:");
for (const [k, m] of [...byKind].sort(
  (a, b) =>
    [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0),
)) {
  const total = [...m.values()].reduce((x, y) => x + y, 0);
  const detail = [...m]
    .sort()
    .map(([meth, n]) => `${meth}=${n}`)
    .join(" ");
  console.log(`  ${k.padEnd(30)} ${String(total).padStart(5)}   ${detail}`);
}

const implicitByKind = new Map<string, number>();
for (const h of implicitHits) {
  implicitByKind.set(h.objectKind, (implicitByKind.get(h.objectKind) ?? 0) + 1);
}
console.log(
  "\nTier-2-shaped calls on the object's IMPLICIT record (bare, or Rec./xRec.-qualified):",
);
for (const [k, n] of [...implicitByKind].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${String(n).padStart(5)}`);
}

const extendsProjectPage = pageExtBases.filter((b) => projectPages.has(b.toLowerCase()));
console.log(
  `\npageextensions: ${pageExtBases.length}; extending a page DECLARED IN THIS PROJECT: ${extendsProjectPage.length}`,
);
console.log(
  `  of those, base page declares a SourceTable: ${
    extendsProjectPage.filter((b) => projectPages.get(b.toLowerCase()) !== null).length
  }`,
);

const pageExtHits = hits.filter((h) => h.objectKind === ALNodeKind.pageextension);
console.log(`\npageextension hits: ${pageExtHits.length}`);
console.log(
  `  files touched: ${new Set(pageExtHits.map((h) => h.file)).size}, declaredIn: ${JSON.stringify(
    pageExtHits.reduce<Record<string, number>>((acc, h) => {
      acc[h.declaredIn] = (acc[h.declaredIn] ?? 0) + 1;
      return acc;
    }, {}),
  )}`,
);
for (const h of pageExtHits.slice(0, 15)) {
  console.log(`    ${h.file}: ${h.receiver}.${h.method} (${h.declaredIn})`);
}
