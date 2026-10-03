/**
 * Owner-run: rewrite LethAL's private configs (credentials inside) for the kraken container, and pack
 * every fixture's `.alpackages` into `fixture-symbols.tar`.
 *
 *   bun scripts/kraken-secrets.ts --repo U:/Git/LethAL --out U:/Git/kraken/secrets/lethal
 *
 * The file list is `.kraken/project.yaml`'s `secret_files` (read from THIS script's repo): each
 * `to` is the file's path relative to `--repo` on the host too, and the output takes the `from`
 * name. Every input is read and checked in memory first; one malformed, missing or unsupported file,
 * or one string still holding a Windows path, and the script exits 1 having written NOTHING.
 * Outputs are built in a sibling temp folder (owner-only from the start) that then replaces `--out`
 * as a whole, so a run leaves either the old folder or the complete new one, never a mix.
 *
 * It never prints a value: only file names, JSON paths and fixed error kinds. A JSON parse error
 * is reported without its message (Bun's quotes the source text); any other error by class name.
 */
import { randomBytes } from "node:crypto";
import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fixtureProjects } from "./compile-fixtures.ts";

const ALX = "/home/dev/.vscode/extensions/ms-dynamics-smb.al-18.0.2732683";
const SRC = "/home/dev/src";
const MAIN = "/work/lethal";

export interface PathMap {
  /** Dotted key path -> its container value. Replaced only where the input has the key. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Host repo folder name under `U:/Git` -> container folder. A repo not listed is never guessed. */
  readonly repos: Readonly<Record<string, string>>;
}

export const CONTAINER_MAP = (bcdevEntry: string): PathMap => ({
  fields: {
    "alRunner.alRunnerPath": "/opt/al-runner/c39ad5de/al-runner",
    "bcdev.alcPath": `${ALX}/bin/linux/alc`,
    "bcdev.altoolPath": `${ALX}/bin/linux/altool`,
    "bcdev.mcpCommand": ["node", bcdevEntry],
    // fixed meaning: the compiled control app, which kraken-setup.sh builds in the main checkout
    "bcdev.controlSymbolPath": `${MAIN}/extensions/lethal-control/lethal-control.app`,
  },
  // the sibling clones kraken-setup.sh makes; the local bc-mcp clone's origin is business-central-mcp.
  // The main checkout maps to the orchestrator's; a worktree (`LethAL-wt/...`) is never guessed.
  repos: {
    LethAL: MAIN,
    "bc-dev-mcp": `${SRC}/bc-dev-mcp`,
    "bc-mcp": `${SRC}/business-central-mcp`,
    "pi-mcp": `${SRC}/pi-mcp`,
  },
});

/**
 * Leftover detector, anywhere in a string: a drive (`C:`, `C:x`, `C:/x`, `1C:\x`, but not the `p:`
 * of `http:` or `h:443`), an MSYS path (`/c/x` after start, space, `=`, `:` or a quote), a UNC path
 * either way round (`\\srv`, `//srv`, but not `https://srv/`), and `file://srv/`. Fails closed: a
 * false hit costs the owner one edit, a miss ships a host path.
 */
const WINDOWS_PATHS = [
  /(?<![A-Za-z])[A-Za-z]:(?!\d)/,
  /(?:^|[\s="':])\/[A-Za-z]\//,
  /(?:^|[\s="'])\/\/[^/\s"']+/,
  /\\\\/,
  /file:\/\/(?!\/)/i,
];
export const hasWindowsPath = (s: string): boolean => WINDOWS_PATHS.some((r) => r.test(s));
const LAUNCHER = /\.(exe|cmd|bat|ps1)$|^(cmd|powershell|pwsh)$/i;

export class UnsupportedLauncherError extends Error {
  constructor(readonly jsonPath: string) {
    super(`unsupported Windows launcher at ${jsonPath}`);
    this.name = "UnsupportedLauncherError";
  }
}

type Seg = string | number;
const jsonPath = (segs: readonly Seg[]): string =>
  `$${segs.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("")}`;

function mapRepo(s: string, repos: PathMap["repos"]): string {
  const m = /^U:[\\/]Git[\\/]([^\\/]+)([\\/].*)?$/i.exec(s);
  const name = m?.[1]?.toLowerCase();
  const key = Object.keys(repos).find((k) => k.toLowerCase() === name);
  const target = key !== undefined ? repos[key] : undefined;
  if (m === null || target === undefined) return s;
  return target + (m[2] ?? "").replaceAll("\\", "/");
}

export function rewrite(json: unknown, map: PathMap): { out: unknown; leftovers: string[] } {
  const walk = (v: unknown, segs: Seg[]): unknown => {
    const key = segs.join(".");
    if (Object.hasOwn(map.fields, key)) return structuredClone(map.fields[key]);
    if (typeof v === "string") {
      if (segs.length === 3 && segs[0] === "mcpServers" && segs[2] === "command") {
        if (LAUNCHER.test(v.split(/[\\/]/).pop() ?? v))
          throw new UnsupportedLauncherError(jsonPath(segs));
      }
      return mapRepo(v, map.repos);
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...segs, i]));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...segs, k])]));
    }
    return v;
  };
  const out = walk(json, []);
  const leftovers: string[] = [];
  const scan = (v: unknown, segs: Seg[]): void => {
    if (typeof v === "string") {
      if (hasWindowsPath(v)) leftovers.push(jsonPath(segs));
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => scan(x, [...segs, i]));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (hasWindowsPath(k)) leftovers.push(`${jsonPath(segs)} (key)`);
        scan(x, [...segs, k]);
      }
    }
  };
  scan(out, []);
  return { out, leftovers };
}

/** `.kraken/project.yaml`'s `secret_files`, from this script's own repo. */
export function secretFiles(): { from: string; to: string }[] {
  const yaml = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "..", ".kraken", "project.yaml"), "utf8"),
  ) as {
    secret_files?: unknown;
  };
  const list = yaml.secret_files;
  if (!Array.isArray(list) || list.length === 0) throw new Error("project.yaml: no secret_files");
  return list.map((e: { from?: unknown; to?: unknown }) => {
    if (!isSecretEntry(e)) throw new Error("project.yaml: bad secret_files entry");
    return { from: e.from, to: e.to };
  });
}

/** `from` is a bare file name; `to` is relative, with no `..` segment. */
export function isSecretEntry(e: {
  from?: unknown;
  to?: unknown;
}): e is { from: string; to: string } {
  const { from, to } = e;
  if (typeof from !== "string" || typeof to !== "string") return false;
  if (from === "" || from === "." || from === ".." || /[\\/]/.test(from)) return false;
  if (to === "" || /^([\\/]|[A-Za-z]:)/.test(to)) return false;
  return !to.split(/[\\/]/).some((s) => s === ".." || s === "");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Lstat = (p: string) => Pick<Stats, "isFile" | "isDirectory">;

/** A fixture has symbols only if `.alpackages` is a real directory holding at least one `*.app`. */
export function hasSymbols(dir: string, lstat: Lstat = lstatSync): boolean {
  try {
    if (!lstat(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return readdirSync(dir).some((n) => /\.app$/i.test(n));
}

/** Every entry under `root` (relative, `/`-separated) that is not a regular file or directory:
 *  a symlink or junction would make tar pack something from outside the folder. */
export function nonRegularEntries(root: string, lstat: Lstat = lstatSync): string[] {
  const bad: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const s = lstat(join(root, r));
      if (s.isDirectory()) walk(r);
      else if (!s.isFile()) bad.push(r);
    }
  };
  walk("");
  return bad;
}

/** Problems with a finished tar: an entry that is absolute or has `..`, or is not a file or dir. */
export function tarProblems(tar: Uint8Array): string[] {
  const names = Bun.spawnSync(["tar", "-tf", "-"], { stdin: tar });
  const long = Bun.spawnSync(["tar", "-tvf", "-"], { stdin: tar });
  if (names.exitCode !== 0 || long.exitCode !== 0) return ["tar listing failed"];
  const lines = (b: Uint8Array) => new TextDecoder().decode(b).split(/\r?\n/);
  return listingProblems(lines(names.stdout), lines(long.stdout));
}

/** The pure half of `tarProblems`: `tar -tf` names and `tar -tvf` lines in, problems out. */
export function listingProblems(names: readonly string[], long: readonly string[]): string[] {
  const bad = names.filter(
    (n) => n !== "" && (/^([\\/]|[A-Za-z]:)/.test(n) || n.split(/[\\/]/).includes("..")),
  );
  const odd = long.filter((l) => l !== "" && l[0] !== "-" && l[0] !== "d");
  return [
    ...bad.map((n) => `unsafe entry ${n}`),
    ...(odd.length > 0 ? [`${odd.length} entry(ies) not a regular file or directory`] : []),
  ];
}

/** Tar of every fixture's `.alpackages`, built in memory, entries relative to the repo root. */
function symbolTar(repo: string, errors: string[]): Uint8Array | undefined {
  // plus the control app's symbols: kraken-setup.sh compiles it in the container
  const dirs = [
    ...fixtureProjects(repo).map((p) => relative(repo, p).replaceAll("\\", "/")),
    "extensions/lethal-control",
  ];
  const bare = dirs.filter((d) => !hasSymbols(join(repo, d, ".alpackages")));
  if (bare.length > 0) {
    errors.push(
      `fixture-symbols.tar: no .alpackages: ${bare.join(", ")} (stage their symbols first)`,
    );
    return undefined;
  }
  const odd = dirs.flatMap((d) =>
    nonRegularEntries(join(repo, d, ".alpackages")).map((e) => `${d}/.alpackages/${e}`),
  );
  if (odd.length > 0) {
    errors.push(`fixture-symbols.tar: not a regular file or directory: ${odd.join(", ")}`);
    return undefined;
  }
  // cwd + relative paths + stdout: no absolute entry, and GNU tar never reads `U:` as a remote host
  const r = Bun.spawnSync(["tar", "-cf", "-", ...dirs.map((d) => `${d}/.alpackages`)], {
    cwd: repo,
  });
  if (r.exitCode !== 0) {
    errors.push(`fixture-symbols.tar: tar failed (exit ${r.exitCode})`);
    return undefined;
  }
  const problems = tarProblems(r.stdout);
  if (problems.length > 0) {
    errors.push(`fixture-symbols.tar: ${problems.join(", ")}`);
    return undefined;
  }
  return r.stdout;
}

export class OwnerOnlyError extends Error {
  constructor() {
    super("could not restrict the output folder to its owner");
    this.name = "OwnerOnlyError";
  }
}

export const icaclsArgv = (dir: string, user: string): string[] => [
  "icacls",
  dir,
  "/inheritance:r",
  "/grant:r",
  `${user}:(OI)(CI)F`,
];

/** Owner-only before any file lands in it. Off Windows, `mkdirSync`'s mode 0o700 already did it. */
function restrictToOwner(dir: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (user === undefined || user === "") throw new OwnerOnlyError();
  const r = Bun.spawnSync(icaclsArgv(dir, user), { stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) throw new OwnerOnlyError();
}

/**
 * Build every output in a fresh sibling `<out>.tmp-<random>`, then swap it in for `<out>` as a
 * whole. On ANY error the temp folder is deleted and the previous `<out>` is left as it was.
 */
export function writeOutputs(
  outDir: string,
  outputs: readonly { name: string; bytes: string | Uint8Array }[],
  deps: {
    write: (p: string, b: string | Uint8Array) => void;
    restrict: (dir: string) => void;
    remove?: (dir: string) => void;
  } = { write: writeFileSync, restrict: restrictToOwner },
): string | undefined {
  const id = randomBytes(8).toString("hex");
  const tmp = `${outDir}.tmp-${id}`;
  const old = `${outDir}.old-${id}`;
  let movedAside = false;
  try {
    mkdirSync(dirname(outDir), { recursive: true });
    mkdirSync(tmp, { mode: 0o700 });
    deps.restrict(tmp);
    for (const { name, bytes } of outputs) deps.write(join(tmp, name), bytes);
    if (existsSync(outDir)) {
      renameSync(outDir, old);
      movedAside = true;
    }
    renameSync(tmp, outDir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (movedAside && !existsSync(outDir)) renameSync(old, outDir);
    throw e;
  }
  if (!movedAside) return undefined;
  // the new outputs are in place; an old copy that will not delete is left for the next sweep
  try {
    (deps.remove ?? removeDir)(old);
    return undefined;
  } catch {
    return old;
  }
}

const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

/** Delete `<out>.old-*` / `<out>.tmp-*` siblings: credential copies left by a crash mid-swap. */
export function sweepSwapFolders(outDir: string): string[] {
  const parent = dirname(outDir);
  if (!existsSync(parent)) return [];
  const base = basename(outDir);
  const swept = readdirSync(parent).filter((n) => {
    const rest =
      n.startsWith(`${base}.old-`) || n.startsWith(`${base}.tmp-`) ? n.slice(base.length + 5) : "";
    return /^[0-9a-f]+$/.test(rest);
  });
  for (const n of swept) removeDir(join(parent, n));
  return swept;
}

function main(): number {
  const repo = arg("--repo") ?? join(import.meta.dir, "..");
  const outDir = arg("--out") ?? "U:/Git/kraken/secrets/lethal";
  const pkgPath = arg("--bcdev-package") ?? "U:/Git/bc-dev-mcp/package.json";
  for (const n of sweepSwapFolders(outDir)) console.log(`kraken-secrets: removed leftover ${n}`);
  const errors: string[] = [];
  const outputs: { name: string; bytes: string | Uint8Array }[] = [];

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: Record<string, string>;
    main?: string;
  };
  const entry = pkg.bin?.["bc-dev-mcp"] ?? pkg.main;
  if (entry === undefined) throw new Error("bc-dev-mcp package.json: no bin or main");
  const map = CONTAINER_MAP(`${SRC}/bc-dev-mcp/${entry.replace(/^\.\//, "")}`);

  for (const { from, to } of secretFiles()) {
    if (from === "fixture-symbols.tar") {
      const tar = symbolTar(repo, errors);
      if (tar !== undefined) outputs.push({ name: from, bytes: tar });
      continue;
    }
    const path = join(repo, to);
    if (!existsSync(path)) {
      errors.push(`${from}: missing`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      errors.push(`${from}: malformed JSON`);
      continue;
    }
    try {
      // Claude's own settings are copied as they are, after the same checks
      const copyOnly = to === ".claude/settings.local.json";
      const { out, leftovers } = rewrite(json, copyOnly ? { fields: {}, repos: {} } : map);
      for (const l of leftovers) errors.push(`${from}: leftover host path at ${l}`);
      outputs.push({ name: from, bytes: copyOnly ? text : `${JSON.stringify(out, null, 2)}\n` });
    } catch (e) {
      errors.push(
        e instanceof UnsupportedLauncherError
          ? `${from}: UnsupportedLauncherError at ${e.jsonPath}`
          : `${from}: ${e instanceof Error ? e.constructor.name : "error"}`,
      );
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`kraken-secrets: ${e}`);
    console.error("kraken-secrets: nothing written");
    return 1;
  }
  const stuck = writeOutputs(outDir, outputs);
  for (const { name } of outputs) console.log(`kraken-secrets: wrote ${name}`);
  if (stuck !== undefined) {
    console.error(`kraken-secrets: warning: could not delete ${stuck}; the next run removes it`);
  }
  return 0;
}

if (import.meta.main) {
  let code = 1;
  try {
    code = main();
  } catch (e) {
    // sanitised: a class name only, never a message that might quote a value
    console.error(`kraken-secrets: failed: ${e instanceof Error ? e.constructor.name : "error"}`);
  }
  process.exit(code);
}
