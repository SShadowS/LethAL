// R565 PROTOTYPE (uncommitted): map a report name to its one `.al` file inside a dependency package.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ALSyntaxNode,
  type SemanticContext,
  buildSemanticContext,
  normalizeAlName,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { listPackageEntries, readPackageEntry } from "./app-package";

interface Pkg {
  readonly file: string;
  readonly buf: Buffer;
  readonly entries: ReadonlyMap<string, string>; // lowercased -> exact
}

/** A ReadyToRun package (al-runner's platform apps) wraps the real .app as its one inner `.app` entry. */
function unwrap(buf: Buffer): Buffer {
  const names = listPackageEntries(buf);
  if (names.includes("SymbolReference.json")) return buf;
  const inner = names.filter((n) => n.toLowerCase().endsWith(".app"));
  if (inner.length !== 1) throw new Error(`no SymbolReference.json and ${inner.length} inner .app entries`);
  const b = readPackageEntry(buf, inner[0] as string);
  if (b === null) throw new Error("inner .app vanished");
  return b;
}

type DepReport = { roots: ALSyntaxNode[]; ctx: SemanticContext };

export async function r565Provider(
  dirs: readonly string[],
  log: (m: string) => void,
): Promise<(name: string) => DepReport | null> {
  const t0 = Date.now();
  const byName = new Map<string, { pkg: Pkg; ref: string }[]>();
  const extsOf = new Map<string, { pkg: Pkg; ref: string }[]>();
  for (const dir of dirs) {
    for (const f of (await readdir(dir)).sort()) {
      if (!f.toLowerCase().endsWith(".app")) continue;
      const buf = unwrap(await readFile(join(dir, f)));
      const entries = new Map(listPackageEntries(buf).map((e) => [e.toLowerCase(), e]));
      const pkg: Pkg = { file: f, buf, entries };
      let text = readPackageEntry(buf, "SymbolReference.json")?.toString("utf8") ?? "{}";
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const walk = (s: Record<string, unknown>): void => {
        for (const r of (s.Reports as { Name: string; ReferenceSourceFileName?: string }[]) ?? []) {
          const k = normalizeAlName(r.Name);
          const l = byName.get(k) ?? [];
          l.push({ pkg, ref: r.ReferenceSourceFileName ?? "" });
          byName.set(k, l);
        }
        // a dependency reportextension of a report opens its Integer items (R487) and adds writers
        for (const r of (s.ReportExtensions as { Target?: string; ReferenceSourceFileName?: string }[]) ??
          []) {
          const k = normalizeAlName(String(r.Target ?? ""));
          const l = extsOf.get(k) ?? [];
          l.push({ pkg, ref: r.ReferenceSourceFileName ?? "" });
          extsOf.set(k, l);
        }
        for (const c of (s.Namespaces as Record<string, unknown>[]) ?? []) walk(c);
      };
      walk(JSON.parse(text));
    }
  }
  log(`R565 index: ${byName.size} report names in ${Date.now() - t0} ms`);
  const memo = new Map<string, DepReport | null>();
  return (name) => {
    if (memo.has(name)) return memo.get(name) ?? null;
    let out: DepReport | null = null;
    const hits = byName.get(name) ?? [];
    if (hits.length === 0) log(`R565 ${name}: not-found (no package declares it)`);
    else {
      if (hits.length > 1) log(`R565 ${name}: ambiguous (${hits.map((h) => h.pkg.file).join(", ")})`);
      const h = hits[0] as { pkg: Pkg; ref: string };
      const files: { path: string; root: ALSyntaxNode }[] = [];
      for (const x of [h, ...(extsOf.get(name) ?? [])]) {
        const entry = x.pkg.entries.get(`src/${x.ref}`.toLowerCase());
        if (entry === undefined) {
          log(`R565 ${name}: no-source in ${x.pkg.file} (src/${x.ref} absent)`);
          continue;
        }
        const root = wrapRoot(parseAL(readPackageEntry(x.pkg.buf, entry)?.toString("utf8") ?? ""));
        if (root.hasError) log(`R565 ${name}: parse-damaged ${x.pkg.file}:${entry}`);
        files.push({ path: `${x.pkg.file}:${entry}`, root });
        log(`R565 ${name}: source ${x.pkg.file}:${entry}`);
      }
      // base report without source -> nothing (a no-source refusal is a plan decision)
      if (files.length > 0 && files[0]?.path === `${h.pkg.file}:${h.pkg.entries.get(`src/${h.ref}`.toLowerCase())}`)
        out = { roots: files.map((f) => f.root), ctx: buildSemanticContext(files) };
    }
    memo.set(name, out);
    return out;
  };
}
