// R737 reach census (parse only, no build): how many member-call receivers bind to a
// declaration that sits under a preprocessor node (var-section `#if`, member-header `#if`) and
// that `resolveVarRef` cannot see. Counts, names and paths only, no source text.
// usage: bun reach.ts <set> <outdir>    set: fixtures | do | cdo | dc | baseapp
//        bun reach.ts --dir <project-dir> <outdir>      (one ad-hoc project, in-process)
//        bun reach.ts --one <project-dir> <out.json>    (child of the set driver)
// Mirrors loop-hazard.ts `declaredType` (scope order: the code scope's declarations, then the
// object's) and its loop notion (`hasEnclosingLoop`, imported: while/repeat up to the scope).
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tree = join(import.meta.dir, "../..");
const [a1, a2, a3] = process.argv.slice(2);

type Row = { file: string; recv: string; types: string[]; proc: string; loop: boolean };
type D = { live: number; inactive: number; undecided: number };
type Out = {
  files: number;
  failedFiles: number;
  D: { global: D; local: D };
  R: number;
  R_loop: number;
  R_target: number;
  R_amb: number;
  R_noparen: number;
  rows: Row[];
};

async function census(dir: string): Promise<Out> {
  const eng = await import(join(tree, "packages/engine/src/index.ts"));
  const lh = await import(join(tree, "packages/builtin-tier1/src/loop-hazard.ts"));
  const ps = await import(join(tree, "packages/runner/src/preprocessor-symbols.ts"));
  await eng.initParser();
  const symbols: string[] = [...(await ps.effectiveBuildSymbols(dir, [], undefined, { kind: "bcdev" }))];
  const rels = [...new Bun.Glob("**/*.al").scanSync({ cwd: dir, onlyFiles: true })]
    .filter((r) => !/(^|\/)\.alpackages\//.test(r))
    .sort();
  const out: Out = {
    files: 0,
    failedFiles: 0,
    D: {
      global: { live: 0, inactive: 0, undecided: 0 },
      local: { live: 0, inactive: 0, undecided: 0 },
    },
    R: 0,
    R_loop: 0,
    R_target: 0,
    R_amb: 0,
    R_noparen: 0,
    rows: [],
  };
  const parsed: { path: string; source: string; root: any }[] = [];
  for (const rel of rels) {
    try {
      const source = readFileSync(join(dir, rel), "utf8");
      parsed.push({ path: rel, source, root: eng.wrapRoot(eng.parseAL(source)) });
    } catch {
      out.failedFiles++;
    }
  }
  out.files = parsed.length;
  const arms = new Map(parsed.map((p) => [p.root, eng.evaluateArms(p.root, p.source, symbols)]));
  const ctx = eng.buildSemanticContext(
    parsed.map((p) => ({ path: p.path, root: p.root })),
    arms,
  );
  const key = (n: any): string => `${n.startIndex}-${n.endIndex}-${n.rawKind}`;
  const SCOPES = new Set([eng.ALNodeKind.procedure, eng.ALNodeKind.trigger]);
  const isScope = (n: any): boolean => SCOPES.has(n.kind) || eng.isProcedureLike(n);
  const codeScope = (n: any): any => {
    for (let s = n.parent; s !== null; s = s.parent)
      if (s.rawKind === "report_column" || isScope(s)) return s;
    return null;
  };
  const isObject = (n: any): boolean =>
    n.rawKind.endsWith("_declaration") &&
    n.rawKind !== "variable_declaration" &&
    !n.rawKind.startsWith("preproc_");
  const objectOf = (n: any): any => {
    for (let s = n.parent; s !== null; s = s.parent) if (isObject(s)) return s;
    return null;
  };
  // project object names a declared type can name
  const reportNames = new Set<string>();
  for (const p of parsed)
    for (const o of eng.objectDeclarationsOf(p.root))
      if (o.rawKind === "report_declaration")
        reportNames.add(eng.normalizeAlName(eng.lastFieldChild(o, "object_name")?.text ?? ""));
  const typeOf = (
    decl: any,
  ): { kind: string; name: string; temporary: boolean } | null => {
    const tn = decl.childForFieldName("type");
    if (tn === null) return null;
    for (const c of tn.namedChildren) {
      const ref = eng.normalizeAlName(eng.lastFieldChild(c, "reference")?.text ?? "");
      if (c.rawKind === "record_type")
        return {
          kind: "table",
          name: ref,
          temporary: c.namedChildren.some((x: any) => x.rawKind === "temporary_keyword"),
        };
      if (c.rawKind === "object_reference_type") {
        const kind = eng.normalizeAlName(c.childForFieldName("object_type")?.text ?? "");
        if (kind === "codeunit" || kind === "interface" || kind === "report")
          return { kind, name: ref, temporary: false };
        return null;
      }
    }
    return null;
  };
  type Decl = { names: Set<string>; scope: string | null; obj: string; arm: string; ty: any };
  const decls: Decl[] = [];
  for (const p of parsed) {
    const walk = (n: any): void => {
      for (const c of n.namedChildren) {
        if (c.rawKind === "variable_declaration") {
          const ty = typeOf(c);
          if (ty === null) continue;
          let wrapped = false;
          for (let s = c.parent; s !== null && !isScope(s) && !isObject(s); s = s.parent)
            if (s.rawKind.startsWith("preproc_")) wrapped = true;
          if (!wrapped) continue;
          const scope = codeScope(c);
          const arm = eng.armOfNode(ctx, c);
          const bucket = scope === null ? out.D.global : out.D.local;
          bucket[arm === "active" ? "live" : arm]++;
          const obj = objectOf(c);
          decls.push({
            names: new Set(eng.declaredNames(c).map((x: string) => eng.normalizeAlName(x))),
            scope: scope === null ? null : key(scope),
            obj: obj === null ? "" : `${p.path}:${key(obj)}`,
            arm,
            ty,
          });
        } else walk(c);
      }
    };
    walk(p.root);
  }
  if (decls.length === 0) return out;
  const nameOf = (n: any): string => eng.normalizeAlName(n.text);
  const bindable = (recv: any) => {
    // declaredType's order: the code scope's declarations, then the object's; inactive arms skipped
    const name = nameOf(recv);
    const scope = codeScope(recv);
    const obj = objectOf(recv);
    const live = decls.filter((d) => d.names.has(name) && d.arm !== "inactive");
    const inScope = scope === null ? [] : live.filter((d) => d.scope === key(scope));
    if (inScope.length > 0) return inScope;
    return live.filter((d) => d.scope === null && obj !== null && d.obj.endsWith(`:${key(obj)}`));
  };
  const note = (p: any, recv: any, node: any, noparen: boolean): void => {
    if (!lh.isIdentifierLike(recv)) return;
    if (eng.resolveVarRef(recv, ctx) !== null) return;
    const hits = bindable(recv).filter((d) => `${p.path}:` === d.obj.slice(0, p.path.length + 1));
    if (hits.length === 0) return;
    if (noparen) {
      out.R_noparen++;
      return;
    }
    const types = [...new Set(hits.map((d) => `${d.ty.kind}:${d.ty.name}${d.ty.temporary ? ":temp" : ""}`))];
    const loop = lh.hasEnclosingLoop(node);
    const targets = hits.some(
      (d) =>
        (d.ty.kind === "report" && reportNames.has(d.ty.name)) ||
        lh.objectsOfType(d.ty, ctx).length > 0,
    );
    out.R++;
    if (loop) out.R_loop++;
    if (targets) out.R_target++;
    if (types.length > 1) out.R_amb++;
    const sc = codeScope(node);
    if (targets || types.length > 1)
      out.rows.push({
        file: p.path,
        recv: nameOf(recv),
        types,
        proc: sc === null ? "" : (sc.childForFieldName("name")?.text ?? sc.rawKind),
        loop,
      });
  };
  for (const p of parsed) {
    const visit = (n: any): void => {
      for (const c of n.namedChildren) {
        if (c.rawKind === "call_expression") {
          const fn = c.childForFieldName("function");
          if (fn?.rawKind === "member_expression") {
            const recv = fn.childForFieldName("object");
            if (recv !== null && recv !== undefined) note(p, recv, c, false);
          }
        } else if (
          c.rawKind === "member_expression" &&
          n.rawKind === "statement_block"
        ) {
          const recv = c.childForFieldName("object");
          if (recv !== null && recv !== undefined) note(p, recv, c, true);
        }
        visit(c);
      }
    };
    visit(p.root);
  }
  return out;
}

const add = (t: D, s: D): void => {
  t.live += s.live;
  t.inactive += s.inactive;
  t.undecided += s.undecided;
};

if (a1 === "--one") {
  if (a2 === undefined || a3 === undefined) throw new Error("usage");
  writeFileSync(a3, JSON.stringify(await census(a2)));
  process.exit(0);
}
if (a1 === "--dir") {
  if (a2 === undefined) throw new Error("usage");
  console.log(JSON.stringify(await census(a2), null, 1));
  process.exit(0);
}
if (a1 === undefined || a2 === undefined) throw new Error("usage");
const projs: [string, string][] =
  a1 === "baseapp"
    ? [["0", "/work/src/BC.History/BaseApp/Source/Base Application"]]
    : a1 === "fixtures"
      ? readdirSync(join(tree, "fixtures"), { withFileTypes: true })
          .filter((e) => e.isDirectory() && existsSync(join(tree, "fixtures", e.name, "app.json")))
          .map((e, i) => [String(i), join(tree, "fixtures", e.name)] as [string, string])
      : readFileSync(`/coord/handoff/R-702/census/${a1}/projects.tsv`, "utf8")
          .trim()
          .split("\n")
          .map((l) => l.split("\t") as [string, string]);
mkdirSync(a2, { recursive: true });
const t0 = Date.now();
const tot = {
  set: a1,
  projects: projs.length,
  failed: 0,
  files: 0,
  failedFiles: 0,
  D: {
    global: { live: 0, inactive: 0, undecided: 0 },
    local: { live: 0, inactive: 0, undecided: 0 },
  },
  R: 0,
  R_loop: 0,
  R_target: 0,
  R_amb: 0,
  R_noparen: 0,
  perProject: [] as unknown[],
  rows: [] as unknown[],
  wallSeconds: 0,
};
for (const [i, p] of projs) {
  const out = join(a2, `${a1}-${i}.json`);
  const r = Bun.spawnSync(["bun", import.meta.path, "--one", p, out], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    tot.failed++;
    console.log(`SKIP ${i}: ${r.stderr.toString().trim().split("\n").slice(-1)[0]?.slice(0, 160)}`);
    continue;
  }
  const j = JSON.parse(readFileSync(out, "utf8")) as Out;
  tot.files += j.files;
  tot.failedFiles += j.failedFiles;
  add(tot.D.global, j.D.global);
  add(tot.D.local, j.D.local);
  for (const k of ["R", "R_loop", "R_target", "R_amb", "R_noparen"] as const) tot[k] += j[k];
  const nm = p.split("/").slice(-1)[0];
  tot.perProject.push({ i, name: nm, files: j.files, D: j.D, R: j.R, R_loop: j.R_loop, R_target: j.R_target, R_amb: j.R_amb, R_noparen: j.R_noparen });
  for (const r2 of j.rows) tot.rows.push({ project: i, ...r2 });
}
tot.wallSeconds = Math.round((Date.now() - t0) / 100) / 10;
writeFileSync(join(a2, `${a1}-total.json`), JSON.stringify(tot, null, 1));
const { perProject, rows, ...head } = tot;
console.log(JSON.stringify({ ...head, rowsListed: rows.length }));
