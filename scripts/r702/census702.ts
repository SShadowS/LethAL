// R-702 gap 1 census of ONE project, by PARSE, through a scratch tree's r702Census (callee movers one hop).
// Names, lines and counts only: no AL source text.
// usage: bun census702.ts <tree> <out.json> <project-dir>
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [root, out, proj] = process.argv.slice(2);
if (root === undefined || out === undefined || proj === undefined) throw new Error("usage");
const eng = await import(join(root, "packages/engine/src/index.ts"));
const lh = await import(join(root, "packages/builtin-tier1/src/loop-hazard.ts"));
await eng.initParser();
const files: string[] = [];
const walk = (d: string, top: boolean): void => {
  if (!top && existsSync(join(d, "app.json"))) return;
  for (const e of readdirSync(d)) {
    if (e === ".alpackages" || e === ".git" || e === "node_modules") continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, false);
    else if (e.toLowerCase().endsWith(".al")) files.push(p);
  }
};
walk(proj, true);
files.sort();
// biome-ignore lint/suspicious/noExplicitAny: scratch script
type N = any;
const visit = (n: N, f: (n: N) => void): void => {
  f(n);
  for (const c of n.namedChildren) visit(c, f);
};
const objId = (o: N): string => lh.r702ObjKey(o);
let result: unknown;
try {
  const parsed = await Promise.all(
    files.map(async (p) => ({ path: relative(proj, p), root: eng.wrapRoot(eng.parseAL(await Bun.file(p).text())) })),
  );
  const fileOf = new Map<string, string>();
  for (const f of parsed)
    visit(f.root, (n) => {
      if (n.rawKind.endsWith("_declaration") && n.rawKind !== "procedure_declaration") fileOf.set(objId(n), f.path);
    });
  const ctx = eng.buildSemanticContext(parsed);
  const rows = lh.r702Census(ctx).map((l: N) => {
    let o = l.loop;
    let proc = "?";
    for (let a = l.loop.parent; a !== null; a = a.parent) {
      if (proc === "?" && (a.rawKind.includes("procedure") || a.rawKind.includes("trigger"))) proc = (a.childForFieldName("name")?.text ?? a.rawKind).replace(/"/g, "");
      if (a.rawKind.endsWith("_declaration") && !a.rawKind.includes("procedure") && !a.rawKind.includes("trigger")) o = a;
    }
    const obj = objId(o);
    return {
      obj,
      file: fileOf.get(obj) ?? "?",
      proc,
      line: (l.loop.startPosition?.row ?? -1) + 1,
      table: l.table,
      ownMovers: l.ownMovers,
      keysAll: l.keysAll,
      calls: l.calls.map((c: N) => ({
        methods: [...new Set(c.sites.flatMap((s: N) => s.movers.map((m: N) => lh.r702Method(m.call) + (m.writes.length > 0 ? "+w" : ""))))],
        sameObject: c.callee.length > 0 && c.callee.every((x: string) => x.startsWith(`${obj}::`)),
        line: (c.node.startPosition?.row ?? -1) + 1,
        kind: c.kind,
        cls: c.cls,
        reason: c.reason,
        callee: c.callee,
        movers: c.movers,
        inserters: c.inserters,
      })),
    };
  });
  result = { files: files.length, rows };
} catch (e) {
  result = { error: (e as Error).message.slice(0, 300) };
  console.error(`ERROR ${(e as Error).message.slice(0, 200)}`);
}
await Bun.write(out, JSON.stringify(result));
