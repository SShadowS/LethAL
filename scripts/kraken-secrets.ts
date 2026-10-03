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
 *
 * It never prints a value: only file names, JSON paths and fixed error kinds. A JSON parse error
 * is reported without its message (Bun's quotes the source text); any other error by class name.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fixtureProjects } from "./compile-fixtures.ts";

const ALX = "/home/dev/.vscode/extensions/ms-dynamics-smb.al-18.0.2732683";
const SRC = "/home/dev/src";

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
  },
  // the sibling clones kraken-setup.sh makes; the local bc-mcp clone's origin is business-central-mcp
  repos: {
    "bc-dev-mcp": `${SRC}/bc-dev-mcp`,
    "bc-mcp": `${SRC}/business-central-mcp`,
    "pi-mcp": `${SRC}/pi-mcp`,
  },
});

/** Leftover detector: a drive path anywhere in the string (not `https://h:443`), or a UNC `\\`. */
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\/;
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
  const target = m?.[1] !== undefined ? repos[m[1]] : undefined;
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
      if (WINDOWS_PATH.test(v)) leftovers.push(jsonPath(segs));
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => scan(x, [...segs, i]));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (WINDOWS_PATH.test(k)) leftovers.push(`${jsonPath(segs)} (key)`);
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
    if (typeof e.from !== "string" || typeof e.to !== "string" || /[\\/]/.test(e.from)) {
      throw new Error("project.yaml: bad secret_files entry");
    }
    return { from: e.from, to: e.to };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Tar of every fixture's `.alpackages`, built in memory, entries relative to the repo root. */
function symbolTar(repo: string, errors: string[]): Uint8Array | undefined {
  const dirs = fixtureProjects(repo).map((p) => relative(repo, p).replaceAll("\\", "/"));
  const bare = dirs.filter((d) => !existsSync(join(repo, d, ".alpackages")));
  if (bare.length > 0) {
    errors.push(
      `fixture-symbols.tar: no .alpackages: ${bare.join(", ")} (stage their symbols first)`,
    );
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
  return r.stdout;
}

function main(): number {
  const repo = arg("--repo") ?? join(import.meta.dir, "..");
  const outDir = arg("--out") ?? "U:/Git/kraken/secrets/lethal";
  const pkgPath = arg("--bcdev-package") ?? "U:/Git/bc-dev-mcp/package.json";
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
  mkdirSync(outDir, { recursive: true });
  for (const { name, bytes } of outputs) {
    const tmp = join(outDir, `.${name}.tmp-${process.pid}`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(outDir, name));
    console.log(`kraken-secrets: wrote ${name}`);
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
