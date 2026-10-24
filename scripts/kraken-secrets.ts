/**
 * Owner-run: rewrite LethAL's private configs (credentials inside) for the kraken container, and ship
 * the pinned fixture symbol tar as `fixture-symbols.tar`.
 *
 *   bun scripts/kraken-secrets.ts --repo U:/Git/LethAL --out U:/Git/kraken/secrets/lethal
 *       --symbol-tar <the pinned fixture-symbols tar>
 *
 * R670: `fixture-symbols.tar` is the `--symbol-tar` file shipped verbatim, once its sha256 equals the
 * pin (`FIXTURE_SYMBOLS_TAR_SHA256`) and no LethAL app copy in it disagrees with the repo's
 * `app.json` versions. Without `--symbol-tar` the run is refused by name: a tar packed from the
 * host's `.alpackages` could never equal the pin (GNU tar's default format, host mtimes and owners),
 * and packing stale host folders shipped stale copies before.
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
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  FIXTURE_SYMBOLS_TAR_SHA256,
  type FixtureApp,
  symbolTarDrift,
} from "../packages/runner/itest/fixture-symbols.ts";
import {
  AlRunnerV2RetiredError,
  refuseRetiredV2ConfigSection,
} from "../packages/runner/src/v2-retired.ts";
import { fixtureProjects } from "./compile-fixtures.ts";

const ALX = "/home/dev/.vscode/extensions/ms-dynamics-smb.al-current";
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

/**
 * A tar's `tar -tf` names, and its problems: a failed listing, an entry that is absolute or has
 * `..`, or one that is not a file or directory. R670: a listing with no file at all is a problem
 * too, so an empty or unreadable tar can never pass the drift check by naming nothing.
 */
export function tarListing(tar: Uint8Array): { names: string[]; problems: string[] } {
  const names = Bun.spawnSync(["tar", "-tf", "-"], { stdin: tar });
  const long = Bun.spawnSync(["tar", "-tvf", "-"], { stdin: tar });
  if (names.exitCode !== 0 || long.exitCode !== 0)
    return { names: [], problems: ["tar listing failed"] };
  const lines = (b: Uint8Array) => new TextDecoder().decode(b).split(/\r?\n/);
  const n = lines(names.stdout);
  const empty = !n.some((x) => x !== "" && !x.endsWith("/"));
  return {
    names: n,
    problems: [
      ...listingProblems(n, lines(long.stdout)),
      ...(empty ? ["the tar holds no file"] : []),
    ],
  };
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

/** The listing checks and R670's drift check on a finished tar; its bytes, or `undefined` with errors. */
function checkedSymbolTar(tar: Uint8Array, repo: string, errors: string[]): Uint8Array | undefined {
  const { names, problems } = tarListing(tar);
  if (problems.length > 0) {
    errors.push(`fixture-symbols.tar: ${problems.join(", ")}`);
    return undefined;
  }
  const drift = tarDrift(names, repoApps(repo));
  if (drift.length > 0) {
    errors.push(...drift);
    return undefined;
  }
  return tar;
}

/** R670: every repo AL project as `symbolTarDrift` reads it (a missing field reads as ""). */
export function repoApps(repo: string): FixtureApp[] {
  return fixtureProjects(repo).map((p) => {
    const j = JSON.parse(readFileSync(join(p, "app.json"), "utf8").replace(/^﻿/, "")) as {
      name?: unknown;
      version?: unknown;
      dependencies?: { name?: unknown; publisher?: unknown }[];
    };
    return {
      dir: relative(repo, p).replaceAll("\\", "/"),
      name: String(j.name ?? ""),
      version: String(j.version ?? ""),
      lethalDeps: (j.dependencies ?? [])
        .filter((d) => d.publisher === "LethAL")
        .map((d) => String(d.name ?? "")),
    };
  });
}

/**
 * R670: a tar's `tar -tf` names (directories and blank lines skipped) against the repo's
 * `app.json` files, so a tar made from stale `.alpackages` is refused where it is made. Each line
 * names a file and two versions, never a value.
 */
export function tarDrift(names: readonly string[], apps: readonly FixtureApp[]): string[] {
  const files = names.filter((n) => n !== "" && !n.endsWith("/"));
  return symbolTarDrift(files, apps).map((d) => `fixture-symbols.tar: drift: ${d}`);
}

/**
 * R670 `--symbol-tar <path>`: ship that tar's bytes verbatim, after its sha256 equals the pin
 * (`FIXTURE_SYMBOLS_TAR_SHA256`) and it passes the listing and drift checks. The only way the
 * symbol tar reaches the container.
 */
export function pinnedSymbolTar(
  path: string,
  repo: string,
  errors: string[],
  pin: string = FIXTURE_SYMBOLS_TAR_SHA256,
): Uint8Array | undefined {
  if (!existsSync(path)) {
    errors.push("fixture-symbols.tar: --symbol-tar: missing");
    return undefined;
  }
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== pin) {
    errors.push(`fixture-symbols.tar: --symbol-tar has sha256 ${sha}, the pin is ${pin}`);
    return undefined;
  }
  return checkedSymbolTar(bytes, repo, errors);
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

/** `<out>.<kind>-<hex>` sibling names, for each kind given. */
function swapSiblings(outDir: string, kinds: readonly ("old" | "tmp")[]): string[] {
  const parent = dirname(outDir);
  if (!existsSync(parent)) return [];
  const base = basename(outDir);
  return readdirSync(parent).filter((n) =>
    kinds.some(
      (k) => n.startsWith(`${base}.${k}-`) && /^[0-9a-f]+$/.test(n.slice(base.length + 5)),
    ),
  );
}

/** Delete `<out>.old-*` / `<out>.tmp-*` siblings: credential copies left by a crash mid-swap.
 *  Call it only after `recoverInterruptedSwap`, which may need one of them. */
export function sweepSwapFolders(outDir: string): string[] {
  const swept = swapSiblings(outDir, ["old", "tmp"]);
  for (const n of swept) removeDir(join(dirname(outDir), n));
  return swept;
}

export class SwapRecoveryError extends Error {
  constructor() {
    super("the output folder is missing and more than one <out>.old-* exists; restore one by hand");
    this.name = "SwapRecoveryError";
  }
}

/**
 * A process death between `writeOutputs` moving `<out>` aside and publishing the new folder
 * leaves no `<out>` and exactly one `<out>.old-*`: the last valid output. Put it back before
 * anything else, so a sweep or a refused run cannot lose it. Returns the restored name. More than
 * one candidate is refused: which one is newest cannot be told safely.
 */
export function recoverInterruptedSwap(outDir: string): string | undefined {
  if (existsSync(outDir)) return undefined;
  const olds = swapSiblings(outDir, ["old"]);
  const [only] = olds;
  if (only === undefined) return undefined;
  if (olds.length > 1) throw new SwapRecoveryError();
  renameSync(join(dirname(outDir), only), outDir);
  return only;
}

/** Whether `p` (which may not exist yet) lies under the OS temp dir, both compared by real path. */
export function underTempDir(p: string): boolean {
  let at = resolve(p);
  let rest = "";
  while (!existsSync(at) && dirname(at) !== at) {
    rest = rest === "" ? basename(at) : join(basename(at), rest);
    at = dirname(at);
  }
  const real = join(realpathSync(at), rest);
  const tmp = realpathSync(tmpdir());
  return real === tmp || real.startsWith(`${tmp}${sep}`);
}

function main(): number {
  const repo = arg("--repo") ?? join(import.meta.dir, "..");
  const outDir = arg("--out") ?? "U:/Git/kraken/secrets/lethal";
  const pkgPath = arg("--bcdev-package") ?? "U:/Git/bc-dev-mcp/package.json";
  // The pin seam must never reach a real secrets folder: refused before anything is touched.
  if (process.env.KRAKEN_SECRETS_TEST_PIN !== undefined && !underTempDir(outDir)) {
    console.error("kraken-secrets: KRAKEN_SECRETS_TEST_PIN is test-only: --out must be a temp dir");
    return 1;
  }
  const restored = recoverInterruptedSwap(outDir);
  if (restored !== undefined)
    console.log(`kraken-secrets: restored ${restored} (a previous run stopped mid-swap)`);
  // after recovery, every .old-*/.tmp-* left is obsolete: <out> holds the last valid output
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
      const given = arg("--symbol-tar");
      if (given === undefined) {
        errors.push(
          "fixture-symbols.tar: use --symbol-tar <pinned tar>; a tar packed from the host's .alpackages can never equal the pin (R670)",
        );
        continue;
      }
      // the unit tests' seam: their synthetic tars cannot have the real pin's sha256
      const pin = process.env.KRAKEN_SECRETS_TEST_PIN ?? FIXTURE_SYMBOLS_TAR_SHA256;
      const tar = pinnedSymbolTar(given, repo, errors, pin);
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
      refuseRetiredV2ConfigSection(json, from);
      // Claude's own settings are copied as they are, after the same checks
      const copyOnly = to === ".claude/settings.local.json";
      const { out, leftovers } = rewrite(json, copyOnly ? { fields: {}, repos: {} } : map);
      for (const l of leftovers) errors.push(`${from}: leftover host path at ${l}`);
      outputs.push({ name: from, bytes: copyOnly ? text : `${JSON.stringify(out, null, 2)}\n` });
    } catch (e) {
      errors.push(
        e instanceof UnsupportedLauncherError
          ? `${from}: UnsupportedLauncherError at ${e.jsonPath}`
          : e instanceof AlRunnerV2RetiredError
            ? `${from}: retired "alRunner" section (R654): delete it from the host template`
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

/** Class name, plus an errno-shaped `code` (EPERM) and a lower-case `syscall` (rename). Never the message. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return "error";
  const x = e as { code?: unknown; syscall?: unknown };
  const code = typeof x.code === "string" && /^E[A-Z0-9]{1,15}$/.test(x.code) ? x.code : undefined;
  const sys =
    typeof x.syscall === "string" && /^[a-z]{1,16}$/.test(x.syscall) ? x.syscall : undefined;
  return [e.constructor.name, code, sys].filter((p) => p !== undefined).join(" ");
}

if (import.meta.main) {
  let code = 1;
  try {
    code = main();
  } catch (e) {
    // sanitised: a class name plus, for a file-system error, its errno code and syscall (fixed
    // words such as EPERM / rename, never data); never a message that might quote a value
    console.error(`kraken-secrets: failed: ${describeError(e)}`);
  }
  process.exit(code);
}
