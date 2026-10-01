// R-371 r2 (C3): a test app's dependencies (app.json, plus transitive ones from the local symbol
// packages' manifests), split Microsoft / other, with the byte size of each local .app (a PROXY
// for what bcdev would download per run) and the time and peak RSS to read and SHA-256 each .app
// one at a time, dropping each before the next.
// Usage: bun scripts/r371-reach-measure/deps.ts <label> <test-dir> <symbol-packages-dir | ->
// Every app.json under <test-dir> (depth <= 2) is read; several (BaseApp's tree) are aggregated.
// Prints names, ids, versions and sizes only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPackageEntry } from "../../packages/runner/src/app-package";

const [label, dir, pkgDir] = process.argv.slice(2);
if (label === undefined || dir === undefined || pkgDir === undefined)
  throw new Error("usage: deps.ts <label> <test-dir> <symbol-packages-dir | ->");
const log = (s: string): void => console.log(s);
if (label === "--hash") {
  // Child mode: argv after the two placeholders is the file list.
  const files = process.argv.slice(5);
  const base = process.memoryUsage().rss;
  let peak = base;
  let bytes = 0;
  const t0 = performance.now();
  for (const f of files) {
    const b = readFileSync(f);
    bytes += b.byteLength;
    new Bun.CryptoHasher("sha256").update(b).digest("hex");
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  const ms = performance.now() - t0;
  console.log(
    `${files.length} packages, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${ms.toFixed(0)} ms; RSS at start ${(base / 1048576).toFixed(0)} MB, peak ${(peak / 1048576).toFixed(0)} MB`,
  );
  process.exit(0);
}
const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;

interface Dep {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
}
const readJson = (path: string): Record<string, unknown> => {
  let t = readFileSync(path, "utf8");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return JSON.parse(t) as Record<string, unknown>;
};

// app.json files, depth 0 to 2.
const appJsons: string[] = [];
const look = (d: string, depth: number): void => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isFile() && e.name.toLowerCase() === "app.json") appJsons.push(join(d, e.name));
    else if (e.isDirectory() && depth < 2 && !e.name.startsWith("."))
      look(join(d, e.name), depth + 1);
  }
};
look(dir, 0);
const inTree = new Set<string>();
const direct = new Map<string, Dep & { apps: number }>();
const implicit = new Map<string, number>();
for (const f of appJsons) {
  const j = readJson(f);
  inTree.add(String(j.id).toLowerCase());
  for (const d of (j.dependencies as Dep[] | undefined) ?? []) {
    const id = d.id.toLowerCase();
    const had = direct.get(id);
    direct.set(id, { ...d, id, apps: (had?.apps ?? 0) + 1 });
  }
  if (typeof j.application === "string")
    implicit.set(
      `application ${j.application}`,
      (implicit.get(`application ${j.application}`) ?? 0) + 1,
    );
  if (typeof j.platform === "string")
    implicit.set(`platform ${j.platform}`, (implicit.get(`platform ${j.platform}`) ?? 0) + 1);
}
const isMs = (publisher: string): boolean => publisher.toLowerCase() === "microsoft";

log(`=== ${label}: ${appJsons.length} app.json under ${dir}`);
log(
  `implicit (app.json "application"/"platform", resolved by BC to Microsoft apps): ${[...implicit].map(([k, n]) => `${k} (${n} app.json)`).join(", ") || "none"}`,
);
log("direct dependencies (publisher | name | id | version | app.json files naming it):");
for (const d of [...direct.values()].sort(
  (a, b) => Number(isMs(a.publisher)) - Number(isMs(b.publisher)) || a.name.localeCompare(b.name),
))
  log(
    `  ${isMs(d.publisher) ? "MS   " : "OTHER"} | ${d.publisher} | ${d.name} | ${d.id} | ${d.version} | ${d.apps}${inTree.has(d.id) ? " | another app in this tree" : ""}`,
  );

if (pkgDir === "-") {
  log("no local symbol packages: no transitive closure, no sizes, no hashing");
  process.exit(0);
}

// Manifests of every local package: id -> (app, deps, file, size).
interface Pkg extends Dep {
  readonly file: string;
  readonly bytes: number;
  readonly deps: readonly string[];
  readonly usesApplication: boolean;
  readonly usesPlatform: boolean;
}
const pkgs = new Map<string, Pkg>();
const attr = (tag: string, a: string): string =>
  new RegExp(`\\b${a}="([^"]*)"`).exec(tag)?.[1] ?? "";
for (const f of readdirSync(pkgDir).filter((x) => x.toLowerCase().endsWith(".app"))) {
  const path = join(pkgDir, f);
  const xml = readPackageEntry(readFileSync(path), "NavxManifest.xml")?.toString("utf8") ?? "";
  const app = /<App\b[^>]*>/.exec(xml)?.[0] ?? "";
  const ds = [...xml.matchAll(/<Dependency\b[^>]*>/g)].map((m) => attr(m[0], "Id").toLowerCase());
  const id = attr(app, "Id").toLowerCase();
  pkgs.set(id, {
    id,
    name: attr(app, "Name"),
    publisher: attr(app, "Publisher"),
    version: attr(app, "Version"),
    file: f,
    bytes: statSync(path).size,
    deps: ds,
    usesApplication: attr(app, "Application") !== "",
    usesPlatform: attr(app, "Platform") !== "",
  });
}
// Closure from the direct deps. An app.json or manifest that names an "application"/"platform"
// version depends on Microsoft's Application family / System too, without a Dependency element.
const family = (names: readonly string[]): string[] =>
  [...pkgs.values()]
    .filter((p) => isMs(p.publisher) && names.includes(p.name.toLowerCase()))
    .map((p) => p.id);
const APPLICATION = family([
  "application",
  "base application",
  "system application",
  "business foundation",
]);
const PLATFORM = family(["system"]);
const seeds = [...direct.keys()];
if ([...implicit.keys()].some((k) => k.startsWith("application"))) seeds.push(...APPLICATION);
if ([...implicit.keys()].some((k) => k.startsWith("platform"))) seeds.push(...PLATFORM);
const closure = new Map<string, "direct" | "transitive">();
const stack: string[] = [];
const add = (id: string): void => {
  if (closure.has(id)) return;
  closure.set(id, direct.has(id) ? "direct" : "transitive");
  stack.push(id);
};
for (const s of seeds) add(s);
while (stack.length > 0) {
  const p = pkgs.get(stack.pop() ?? "");
  if (p === undefined) continue;
  for (const d of p.deps) add(d);
  if (p.usesApplication) for (const d of APPLICATION) add(d);
  if (p.usesPlatform) for (const d of PLATFORM) add(d);
}
log(
  `\nclosure over ${pkgs.size} local packages in ${pkgDir} (publisher | name | version | direct/transitive | .app bytes):`,
);
let msBytes = 0;
let otherBytes = 0;
const missing: string[] = [];
const rows = [...closure].map(([id, how]) => ({ id, how, p: pkgs.get(id) }));
for (const { id, how, p } of rows.sort((a, b) =>
  (a.p?.name ?? "").localeCompare(b.p?.name ?? ""),
)) {
  if (p === undefined) {
    missing.push(`${direct.get(id)?.name ?? id} (${how})`);
    continue;
  }
  if (isMs(p.publisher)) msBytes += p.bytes;
  else otherBytes += p.bytes;
  log(
    `  ${isMs(p.publisher) ? "MS   " : "OTHER"} | ${p.publisher} | ${p.name} | ${p.version} | ${how} | ${p.bytes}`,
  );
}
if (missing.length > 0) log(`  not present locally: ${missing.join(", ")}`);
log(
  `total bytes: Microsoft ${msBytes} (${mb(msBytes)}), non-Microsoft ${otherBytes} (${mb(otherBytes)})`,
);
const unused = [...pkgs.values()]
  .filter((p) => !closure.has(p.id))
  .map((p) => p.name || "(no manifest)");
if (unused.length > 0) log(`local packages outside the closure: ${unused.join(", ")}`);

// Read + SHA-256 one at a time, in a FRESH process per group, so earlier reads here do not hide
// the cost. Non-Microsoft is what C3 hashes; all is shown for scale.
if (label !== "--hash") {
  for (const group of ["non-Microsoft", "all"] as const) {
    const list = rows.flatMap(({ p }) =>
      p !== undefined && (group === "all" || !isMs(p.publisher)) ? [join(pkgDir, p.file)] : [],
    );
    const r = Bun.spawnSync([process.execPath, import.meta.path, "--hash", "-", "-", ...list]);
    log(`read+SHA-256, ${group}: ${r.stdout.toString().trim()}`);
  }
}
