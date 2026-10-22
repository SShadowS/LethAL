/**
 * The shared, write-once Microsoft symbol cache for the BC on Linux servers (bc1, bc2, bc3):
 * `/coord/cache/bc-symbols/<server>/<build>-<hash8>/`, where `<build>` is the version of the
 * `Microsoft System` package the server serves and `<hash8>` hashes the set of package names the
 * dir holds (`nameSetHash`), so a new Microsoft dependency on the same build gets a new dir. Every
 * per-server gate config's `packageCachePath` points at one, so a worktree needs only its configs.
 *
 * THE RULE: a build dir holds ONLY Microsoft-published packages (the publisher read from each
 * package's NavxManifest, not from its file name). The dir is keyed by the BC build, so a LethAL
 * Control, a fixture app or a Continia app in it would be served stale for good after that app
 * changed. LethAL Control comes from `CONTROL_APP` (R552's private package-cache copy adds it), a
 * fixture's target symbol from the reader's own private copy, Continia from cdo's own dir.
 *
 * WRITE-ONCE. A fill downloads into a temp dir beside the build dirs, writes the completion marker
 * (`MARKER`: server, build, writtenAt, fileCount and per package its file, id, name, publisher,
 * version and sha256), seals it (files 0444, dir 0555) and only then `rename`s it into place, so
 * no crash can leave a writable complete dir. A completed dir is never modified or deleted. When
 * the dir already exists and verifies, the fill uses it. Two fills racing: the second rename
 * fails, the loser removes its own temp dir and re-verifies the winner. A new BC build gets a new
 * dir; old dirs are left alone (pruning is out of scope). A leftover `.tmp-*` dir is a fill that
 * died; it is safe to delete when no setup is running.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";

export const SYMBOL_CACHE_ROOT = "/coord/cache/bc-symbols";
export const MARKER = "cache-complete.json";
/** The one name a written config points at while no build dir verifies; never a build name. */
export const UNFILLED = "unfilled-run-setup-first";
/** `<build>-<hash8>`: the BC build, and a short hash of the package-name set the dir holds. */
const DIR_NAME = /^\d+\.\d+\.\d+\.\d+-[0-9a-f]{8}$/;

/**
 * The first 8 hex of sha256 over the sorted, de-duplicated package names. A new Microsoft
 * dependency on the same BC build gets a NEW dir, instead of a sealed one that lacks it.
 */
export function nameSetHash(names: readonly string[]): string {
  return sha256(Buffer.from([...new Set(names)].sort().join("\n"), "utf8")).slice(0, 8);
}

/** The build dir's name for `build` holding exactly `names`. */
export function buildDirName(build: string, names: readonly string[]): string {
  return `${build}-${nameSetHash(names)}`;
}

export class SymbolCacheError extends Error {}

export interface CachedPackage {
  readonly file: string;
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly sha256: string;
}

export interface CacheMarker {
  readonly server: string;
  readonly build: string;
  readonly writtenAt: string;
  readonly fileCount: number;
  readonly packages: readonly CachedPackage[];
}

export type Verified =
  | { readonly ok: true; readonly marker: CacheMarker }
  | { readonly ok: false; readonly reason: string };

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** The file name a Microsoft package gets in a build dir (the name `downloadSymbols` always used). */
export function cacheFileName(name: string): string {
  return `Microsoft_${name}.app`;
}

/**
 * Whether `dir` is a complete build dir for `server`: the marker parses and names this server, the
 * dir's name is `<marker build>-<hash of its package names>`, the dir holds exactly the marker's
 * files (regular files, nothing else), every file's sha256 and manifest identity equal the
 * marker's, every package is Microsoft's, `System`'s version is the build, and every name in
 * `required` is there. It never throws: an unreadable dir is a reason, not an error.
 */
export function verifyBuildDir(
  dir: string,
  server: string,
  required: readonly string[] = [],
): Verified {
  try {
    return verifyOrThrow(dir, server, required);
  } catch (err) {
    return { ok: false, reason: `${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function verifyOrThrow(dir: string, server: string, required: readonly string[]): Verified {
  const bad = (reason: string): Verified => ({ ok: false, reason: `${dir}: ${reason}` });
  if (!existsSync(join(dir, MARKER))) return bad(`no ${MARKER} (not a completed build dir)`);
  if (!lstatSync(join(dir, MARKER)).isFile()) return bad(`${MARKER} is not a regular file`);
  let m: CacheMarker;
  try {
    m = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as CacheMarker;
  } catch (err) {
    return bad(`${MARKER} does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (m.server !== server) return bad(`marker names server ${m.server}, not ${server}`);
  if (!Array.isArray(m.packages) || m.fileCount !== m.packages.length)
    return bad(`marker fileCount ${m.fileCount} does not match its package list`);
  const expectName = buildDirName(
    m.build,
    m.packages.map((p) => p.name),
  );
  if (expectName !== basename(dir))
    return bad(`its name is not ${expectName} (marker build ${m.build})`);
  const files = readdirSync(dir)
    .filter((f) => f !== MARKER)
    .sort();
  const listed = m.packages.map((p) => p.file).sort();
  if (JSON.stringify(files) !== JSON.stringify(listed))
    return bad(`holds ${files.join(", ") || "nothing"}; the marker lists ${listed.join(", ")}`);
  for (const p of m.packages) {
    if (p.publisher !== "Microsoft") return bad(`${p.file} is published by ${p.publisher}`);
    if (!lstatSync(join(dir, p.file)).isFile()) return bad(`${p.file} is not a regular file`);
    const bytes = readFileSync(join(dir, p.file));
    if (sha256(bytes) !== p.sha256) return bad(`${p.file}: sha256 differs from the marker`);
    let id: ReturnType<typeof readAppIdentity>;
    try {
      id = readAppIdentity(bytes);
    } catch (err) {
      return bad(`${p.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (id.publisher !== "Microsoft") return bad(`${p.file} is published by ${id.publisher}`);
    if (id.id !== p.id || id.name !== p.name || id.version !== p.version)
      return bad(`${p.file}: its manifest is ${id.name} ${id.version}, the marker says otherwise`);
    if (id.name === "System" && id.version !== m.build)
      return bad(`System is ${id.version}, the marker's build is ${m.build}`);
  }
  if (!m.packages.some((p) => p.name === "System")) return bad("holds no System package");
  const names = new Set(m.packages.map((p) => p.name));
  const missing = required.filter((n) => !names.has(n));
  if (missing.length > 0) return bad(`lacks ${missing.join(", ")}`);
  return { ok: true, marker: m };
}

export interface FillOptions {
  readonly root: string;
  readonly server: string;
  /** Microsoft package names, `System` first: `System`'s version is the build. */
  readonly names: readonly string[];
  /** Fetches one Microsoft package from the server (`null`: the server holds none). */
  readonly download: (name: string) => Promise<Buffer | null>;
  readonly now?: () => Date;
  /** The atomic move into place (`renameSync`); a seam for the crash test. */
  readonly rename?: (from: string, to: string) => void;
}

export interface FillResult {
  readonly dir: string;
  readonly build: string;
  readonly outcome: "filled" | "existing" | "lost-race";
  /** Packages downloaded by this call. */
  readonly downloads: number;
}

/** Downloads (or reuses) the build dir for `server`. See the module header. */
export async function fillSymbolCache(o: FillOptions): Promise<FillResult> {
  if (o.names[0] !== "System") throw new SymbolCacheError("names must start with System");
  const serverDir = join(o.root, o.server);
  mkdirSync(serverDir, { recursive: true });
  const temp = mkdtempSync(join(serverDir, ".tmp-"));
  let downloads = 0;
  try {
    const packages: CachedPackage[] = [];
    let build: string | undefined;
    for (const name of [...new Set(o.names)]) {
      const pkg = await o.download(name);
      downloads++;
      if (pkg === null)
        throw new SymbolCacheError(`${o.server}: the server holds no Microsoft "${name}" package`);
      const id = readAppIdentity(pkg);
      if (id.publisher !== "Microsoft" || id.name !== name) {
        throw new SymbolCacheError(
          `${o.server}: asked for Microsoft ${name}, got ${id.publisher} ${id.name}; only Microsoft packages enter the shared cache`,
        );
      }
      const file = cacheFileName(name);
      writeFileSync(join(temp, file), pkg, { mode: 0o444 });
      packages.push({ file, ...id, sha256: sha256(pkg) });
      if (build === undefined) {
        build = id.version;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(build))
          throw new SymbolCacheError(`${o.server}: System version ${build} is not a build`);
        const existing = join(serverDir, buildDirName(build, o.names));
        if (existsSync(existing)) {
          // The rest is not downloaded: the completed dir is used as it is, or refused by name.
          return { ...useExisting(existing, o, build), outcome: "existing", downloads };
        }
      }
    }
    if (build === undefined) throw new SymbolCacheError("unreachable: no System package");
    const marker: CacheMarker = {
      server: o.server,
      build,
      writtenAt: (o.now?.() ?? new Date()).toISOString(),
      fileCount: packages.length,
      packages,
    };
    writeFileSync(join(temp, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o444 });
    // Sealed BEFORE the move, so a crash after it can never leave a writable complete dir.
    chmodSync(temp, 0o555);
    const final = join(serverDir, buildDirName(build, o.names));
    try {
      (o.rename ?? renameSync)(temp, final);
    } catch {
      // Another fill won the rename (or a dir appeared): never touch it, verify it.
      return { ...useExisting(final, o, build), outcome: "lost-race", downloads };
    }
    return { dir: final, build, outcome: "filled", downloads };
  } finally {
    if (existsSync(temp)) {
      chmodSync(temp, 0o755);
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

function useExisting(dir: string, o: FillOptions, build: string): { dir: string; build: string } {
  const v = verifyBuildDir(dir, o.server, o.names);
  if (!v.ok) {
    throw new SymbolCacheError(
      `${v.reason}. A build dir is never modified or deleted by a fill; the owner decides what to do with it`,
    );
  }
  return { dir, build };
}

export interface CacheLookup {
  /** The newest verified build dir (by marker `writtenAt`), when any verifies. */
  readonly chosen?: { readonly dir: string; readonly marker: CacheMarker };
  readonly verified: readonly string[];
  /** Build-named dirs that do not verify, with the reason. */
  readonly unverified: readonly string[];
}

/**
 * What the cache holds for `server`, with NO server call: every build-named dir, verified. The
 * server's current build is not known here, so the newest verified dir is the one offered.
 */
export function lookupSymbolCache(
  root: string,
  server: string,
  required: readonly string[] = [],
): CacheLookup {
  const serverDir = join(root, server);
  const verified: { dir: string; marker: CacheMarker }[] = [];
  const unverified: string[] = [];
  if (existsSync(serverDir)) {
    for (const e of readdirSync(serverDir).sort()) {
      const dir = join(serverDir, e);
      if (!DIR_NAME.test(e)) continue;
      if (!lstatSync(dir).isDirectory()) {
        unverified.push(`${dir}: not a directory`);
        continue;
      }
      const v = verifyBuildDir(dir, server, required);
      if (v.ok) verified.push({ dir, marker: v.marker });
      else unverified.push(v.reason);
    }
  }
  verified.sort((a, b) => a.marker.writtenAt.localeCompare(b.marker.writtenAt));
  const chosen = verified.at(-1);
  return {
    ...(chosen !== undefined ? { chosen } : {}),
    verified: verified.map((v) => v.dir),
    unverified,
  };
}
