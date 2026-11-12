/**
 * R-935: a SHARED, read-only cache of corpus builds (sources, built packages, demo-data caches),
 * written once, read by every lane, and never deleted by task cleanup (lane.md says so).
 *
 *   bun scripts/corpus-build-cache.ts put <name> --corpus <git dir> --from <dir> [--probing <dir>[,<dir>...]] [--note <text>]
 *   bun scripts/corpus-build-cache.ts path <name> --corpus <git dir> [--probing <dir>[,<dir>...]]
 *   bun scripts/corpus-build-cache.ts check <entry dir>
 *   bun scripts/corpus-build-cache.ts list
 *
 * Root: `LETHAL_CORPUS_BUILDS`, default /coord/cache/corpus-builds. An entry is
 * `<root>/<name>@<corpus HEAD, 12 hex>+<probing key>/`: `<name>` is the app or closure (letters,
 * digits, `.`, `_`, `-`); the probing key is `none`, or the first 8 hex of sha256 over the sorted
 * absolute probing paths (the paths themselves are in the manifest).
 *
 * `put` copies `--from` (links followed, so the entry never points back into a scratch folder that
 * a cleanup may delete) into `<root>/.tmp-<entry>-<pid>`, writes `manifest.json` (every file's
 * path, size and sha256), makes the tree read-only, and renames it into place: an entry exists
 * whole or not at all. An existing entry is refused, never replaced. `path` prints an entry's
 * folder after a quick check (manifest present, every file there with its size); `check` hashes
 * every file and refuses an extra one. A folder with no manifest is refused as half-written.
 *
 * Exit codes: 0 ok, 1 an entry failed its check, 2 refused (bad arguments, entry exists or missing).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export class CacheRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheRefusedError";
  }
}
export class CacheCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheCheckError";
  }
}

export const FORMAT = 1;
const MANIFEST = "manifest.json";

export interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}
export interface Manifest {
  readonly format: number;
  readonly entry: string;
  readonly name: string;
  readonly corpusRoot: string;
  readonly corpusSha: string;
  readonly probingPaths: readonly string[];
  readonly probingKey: string;
  readonly from: string;
  readonly note: string;
  readonly created: string;
  readonly files: readonly ManifestFile[];
}

export function cacheRoot(): string {
  return process.env.LETHAL_CORPUS_BUILDS ?? "/coord/cache/corpus-builds";
}

export function probingKey(paths: readonly string[]): string {
  if (paths.length === 0) return "none";
  const abs = paths.map((p) => resolve(p)).sort();
  return createHash("sha256").update(abs.join("\n")).digest("hex").slice(0, 8);
}

export function entryName(name: string, corpusSha: string, probing: readonly string[]): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) {
    throw new CacheRefusedError(
      `name '${name}': use letters, digits, '.', '_' or '-' (not first '.')`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(corpusSha))
    throw new CacheRefusedError(`corpus sha '${corpusSha}' is not a commit`);
  return `${name}@${corpusSha.slice(0, 12)}+${probingKey(probing)}`;
}

function corpusShaOf(dir: string): string {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0)
    throw new CacheRefusedError(
      `--corpus ${dir}: not a git checkout (${r.stderr.toString().trim()})`,
    );
  return r.stdout.toString().trim();
}

/** Every regular file under `dir`, relative and sorted. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p));
      else throw new CacheRefusedError(`${p}: not a file or folder (a link left after the copy?)`);
    }
  };
  walk(dir);
  return out.sort();
}

function sha256Of(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function setWritable(dir: string, writable: boolean): void {
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isDirectory()) {
      if (writable) chmodSync(p, 0o755);
      for (const e of readdirSync(p)) walk(join(p, e));
      if (!writable) chmodSync(p, 0o555);
    } else if (!st.isSymbolicLink()) chmodSync(p, writable ? 0o644 : 0o444); // chmod would follow a link
  };
  walk(dir);
}

/** Removes an entry or temp folder this tool made read-only (tests and a failed put). */
export function removeTree(dir: string): void {
  if (!existsSync(dir)) return;
  setWritable(dir, true);
  rmSync(dir, { recursive: true, force: true });
}

export function put(o: {
  root: string;
  name: string;
  corpusRoot: string;
  corpusSha: string;
  from: string;
  probing: readonly string[];
  note: string;
}): string {
  const entry = entryName(o.name, o.corpusSha, o.probing);
  const final = join(o.root, entry);
  if (existsSync(final))
    throw new CacheRefusedError(`${final} exists: an entry is never replaced (write a new name)`);
  if (!existsSync(o.from) || !statSync(o.from).isDirectory())
    throw new CacheRefusedError(`--from ${o.from}: not a folder`);
  for (const p of o.probing)
    if (!existsSync(p)) throw new CacheRefusedError(`--probing ${p}: no such folder`);
  Bun.spawnSync(["mkdir", "-p", o.root]);
  const tmp = join(o.root, `.tmp-${entry}-${process.pid}`);
  removeTree(tmp);
  try {
    // -L: links are followed, so the entry holds the files themselves.
    const cp = Bun.spawnSync(["cp", "-rL", "--preserve=timestamps", `${resolve(o.from)}/.`, tmp], {
      stderr: "pipe",
    });
    if (cp.exitCode !== 0)
      throw new CacheRefusedError(`copy of ${o.from} failed: ${cp.stderr.toString().trim()}`);
    if (existsSync(join(tmp, MANIFEST)))
      throw new CacheRefusedError(`--from holds a ${MANIFEST}; that name is the entry's own`);
    const files = filesUnder(tmp).map((path) => ({
      path,
      size: statSync(join(tmp, path)).size,
      sha256: sha256Of(join(tmp, path)),
    }));
    if (files.length === 0)
      throw new CacheRefusedError(
        `--from ${o.from} holds no file: an empty entry is never written`,
      );
    const manifest: Manifest = {
      format: FORMAT,
      entry,
      name: o.name,
      corpusRoot: resolve(o.corpusRoot),
      corpusSha: o.corpusSha,
      probingPaths: o.probing.map((p) => resolve(p)).sort(),
      probingKey: probingKey(o.probing),
      from: resolve(o.from),
      note: o.note,
      created: new Date().toISOString(),
      files,
    };
    writeFileSync(join(tmp, MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`);
    setWritable(tmp, false);
    renameSync(tmp, final);
    return final;
  } catch (e) {
    removeTree(tmp);
    throw e;
  }
}

function readManifest(dir: string): Manifest {
  if (!existsSync(join(dir, MANIFEST))) {
    throw new CacheRefusedError(
      `${dir}: no ${MANIFEST}, so it is half-written or not an entry; never read it`,
    );
  }
  return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
}

/** Quick (sizes) or full (hashes, and no extra file) check. Throws CacheCheckError on a mismatch. */
export function check(dir: string, full: boolean): Manifest {
  const m = readManifest(dir);
  const bad: string[] = [];
  for (const f of m.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) bad.push(`missing ${f.path}`);
    else if (statSync(p).size !== f.size) bad.push(`size ${f.path}`);
    else if (full && sha256Of(p) !== f.sha256) bad.push(`hash ${f.path}`);
  }
  if (full) {
    const listed = new Set([...m.files.map((f) => f.path), MANIFEST]);
    for (const f of filesUnder(dir)) if (!listed.has(f)) bad.push(`extra ${f}`);
  }
  if (bad.length > 0)
    throw new CacheCheckError(`${dir}: ${bad.length} problem(s): ${bad.slice(0, 5).join("; ")}`);
  return m;
}

export function list(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const e of readdirSync(root).sort()) {
    if (e.startsWith(".tmp-")) out.push(`unfinished (not an entry): ${e}`);
    else if (!existsSync(join(root, e, MANIFEST))) out.push(`no manifest (not an entry): ${e}`);
    else {
      const m = readManifest(join(root, e));
      out.push(`${e}\t${m.files.length} files\t${m.created}\t${m.note}`);
    }
  }
  return out;
}

function main(argv: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      corpus: { type: "string" },
      from: { type: "string" },
      probing: { type: "string" },
      note: { type: "string" },
    },
  });
  const [cmd, arg] = positionals;
  const root = cacheRoot();
  const probing = (values.probing ?? "").split(",").filter((p) => p !== "");
  if (cmd === "list") {
    for (const l of list(root)) console.log(l);
    return 0;
  }
  if (cmd === "check" && arg !== undefined) {
    const m = check(arg, true);
    console.log(`ok: ${m.entry}, ${m.files.length} files, every hash matches`);
    return 0;
  }
  if ((cmd === "put" || cmd === "path") && arg !== undefined && values.corpus !== undefined) {
    const corpusSha = corpusShaOf(values.corpus);
    if (cmd === "path") {
      const dir = join(root, entryName(arg, corpusSha, probing));
      if (!existsSync(dir)) throw new CacheRefusedError(`no entry ${dir}`);
      check(dir, false);
      console.log(dir);
      return 0;
    }
    if (values.from === undefined) throw new CacheRefusedError("put needs --from <dir>");
    const dir = put({
      root,
      name: arg,
      corpusRoot: values.corpus,
      corpusSha,
      from: values.from,
      probing,
      note: values.note ?? "",
    });
    console.log(`written: ${dir}`);
    return 0;
  }
  throw new CacheRefusedError(
    "usage: corpus-build-cache.ts put|path <name> --corpus <dir> ... | check <entry dir> | list",
  );
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof CacheCheckError ? 1 : 2);
  }
}
