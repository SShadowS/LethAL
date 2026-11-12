/**
 * R-936: prepare ONE worktree for the live gates, then check it, before any lease is taken.
 *
 *   bun scripts/gate-worktree-setup.ts --server bc1|bc2|bc3 --alpackages-from <checkout>
 *   bun scripts/gate-worktree-setup.ts --v3-only --alpackages-from <checkout>
 *
 * Run it from the worktree you will run the gates in. It does four things, in order:
 *  1. (server mode) `bun scripts/bc-linux-setup.ts --server <s> --write-config-only`: the configs
 *     and the per-fixture `.vscode` launch files. No server call, no lease.
 *  2. Copies every `*.app` under `<checkout>/fixtures/*\/.alpackages` into this worktree, and the
 *     checkout's `.fixture-symbols.sha256`. Existing files are only replaced when their size
 *     differs; nothing is deleted. A different marker is refused (the folders came from another tar).
 *  3. Builds the native parser (`bun scripts/build-native-parser.ts`) when the loader refuses it
 *     (missing, stale, wrong pin).
 *  4. The pre-flight: checks each item and exits 1 naming the FIRST one missing.
 *
 * It never leases, never publishes and never calls a server. `LLVM_BIN` must be set for step 3.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { checkBinding, loadBindingFor } from "../packages/engine/src/ast/native-parser.ts";
import type { GATE_FIXTURES, configFileName, launchFileName } from "./bc-linux-setup.ts";

// Only `node:` builtins above: in a fresh worktree there is no node_modules yet, and the modules
// below import packages. They are loaded by `loadLibs()` AFTER `ensureInstalled`.
// (Type-only imports are erased, so they load nothing.)
type Libs = {
  readonly checkBinding: typeof checkBinding;
  readonly loadBindingFor: typeof loadBindingFor;
  readonly FIXTURE_SYMBOLS_TAR_SHA256: string;
  readonly SYMBOLS_MARKER: string;
  readonly symlinkedAlpackages: (root: string) => string[];
  readonly GATE_FIXTURES: typeof GATE_FIXTURES;
  readonly configFileName: typeof configFileName;
  readonly launchFileName: typeof launchFileName;
};
let libs: Libs | undefined;

/** Loads the parts that need installed packages. Call once, after `ensureInstalled`. */
export async function loadLibs(): Promise<void> {
  if (libs !== undefined) return;
  const [np, fs, bc] = await Promise.all([
    import("../packages/engine/src/ast/native-parser.ts"),
    import("../packages/runner/itest/fixture-symbols.ts"),
    import("./bc-linux-setup.ts"),
  ]);
  libs = {
    checkBinding: np.checkBinding,
    loadBindingFor: np.loadBindingFor,
    FIXTURE_SYMBOLS_TAR_SHA256: fs.FIXTURE_SYMBOLS_TAR_SHA256,
    SYMBOLS_MARKER: fs.SYMBOLS_MARKER,
    symlinkedAlpackages: fs.symlinkedAlpackages,
    GATE_FIXTURES: bc.GATE_FIXTURES,
    configFileName: bc.configFileName,
    launchFileName: bc.launchFileName,
  };
}

function L(): Libs {
  if (libs === undefined) throw new Error("gate-worktree-setup: loadLibs() was not called");
  return libs;
}

/** Written after a successful install; `bun.lock` newer than it means the install is stale. */
export const INSTALL_STAMP = "node_modules/.gate-worktree-install";

/**
 * Step 0. `bun install --frozen-lockfile` in the worktree when `node_modules` is missing, or
 * `bun.lock` is newer than the stamp written by the last install here. Output streams through
 * (`run` inherits stdio). A failed install stops the setup.
 */
export function ensureInstalled(root: string, deps: Pick<SetupDeps, "run">): boolean {
  const stamp = join(root, INSTALL_STAMP);
  const lock = join(root, "bun.lock");
  const stale =
    !existsSync(join(root, "node_modules")) ||
    (existsSync(stamp) && existsSync(lock) && statSync(lock).mtimeMs > statSync(stamp).mtimeMs);
  if (!stale) return false;
  if (deps.run(["bun", "install", "--frozen-lockfile"], root) !== 0)
    throw new GateSetupError("bun install --frozen-lockfile failed: nothing else was run");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(stamp, `${new Date().toISOString()}\n`);
  return true;
}

export const SERVERS = ["bc1", "bc2", "bc3"] as const;
export type Server = (typeof SERVERS)[number];

/**
 * Tests projects whose `.alpackages` an itest or a v3 leg compiles against. From the itests' own
 * refusals ("holds no .app symbols"): verify and testapp read sandbox-tests, verify-scale
 * sandbox-data-tests, agreement sandbox-harden-tests; the v3 gate reads the first two.
 */
export const NEEDS_SYMBOLS = ["fixtures/sandbox-tests", "fixtures/sandbox-data-tests"] as const;
/** Only the BC gates (`itest:verify-agreement`) read this one; the v3 gate does not. */
export const NEEDS_SYMBOLS_SERVER = "fixtures/sandbox-harden-tests";
export const needsSymbols = (server: Server | undefined): readonly string[] =>
  server === undefined ? NEEDS_SYMBOLS : [...NEEDS_SYMBOLS, NEEDS_SYMBOLS_SERVER];

export interface SetupDeps {
  /** Runs a command in `cwd`; returns the exit code. */
  readonly run: (cmd: readonly string[], cwd: string) => number;
  /** Why the native parser cannot be used, or undefined when it loads and is fresh. */
  readonly parserProblem: () => string | undefined;
}

export interface SetupOpts {
  readonly root: string;
  readonly server: Server | undefined;
  readonly alpackagesFrom: string;
}

export class GateSetupError extends Error {
  override readonly name = "GateSetupError";
}

const apps = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".app")) : [];

/** Step 2. Returns the number of files copied. */
export function copyAlpackages(root: string, from: string): number {
  const { symlinkedAlpackages, SYMBOLS_MARKER } = L();
  if (resolve(root) === resolve(from))
    throw new GateSetupError("--alpackages-from is this worktree itself");
  const srcFixtures = join(from, "fixtures");
  if (!existsSync(srcFixtures))
    throw new GateSetupError(`${from} has no fixtures/ folder: not a LethAL checkout`);
  const linked = symlinkedAlpackages(root);
  if (linked.length > 0)
    throw new GateSetupError(
      `${linked[0]} is a symlink out of this worktree (R787): nothing copied`,
    );
  const srcMarker = join(from, SYMBOLS_MARKER);
  const dstMarker = join(root, SYMBOLS_MARKER);
  if (existsSync(srcMarker) && existsSync(dstMarker)) {
    const [a, b] = [readFileSync(srcMarker, "utf8").trim(), readFileSync(dstMarker, "utf8").trim()];
    if (a !== b)
      throw new GateSetupError(
        `${SYMBOLS_MARKER} differs (source ${a}, here ${b}): the folders came from another symbol tar; run bun scripts/fixture-symbols-reset.ts first`,
      );
  }
  // Plan first, copy after: a refusal leaves the worktree untouched.
  const plan: { srcDir: string; dstDir: string; names: string[] }[] = [];
  for (const fx of readdirSync(srcFixtures)) {
    const srcDir = join(srcFixtures, fx, ".alpackages");
    const names = apps(srcDir);
    if (names.length === 0) continue;
    const dstDir = join(root, "fixtures", fx, ".alpackages");
    const held = existsSync(dstDir) ? readdirSync(dstDir) : [];
    if (held.length === 0) {
      plan.push({ srcDir, dstDir, names });
      continue;
    }
    // Already filled: fine only when it is exactly the source's apps, byte for byte (a re-run).
    // Otherwise we cannot vouch for it, and stamping the marker on it would call it verified.
    const same =
      held.length === names.length &&
      names.every(
        (n) =>
          held.includes(n) && readFileSync(join(dstDir, n)).equals(readFileSync(join(srcDir, n))),
      );
    if (!same)
      throw new GateSetupError(
        `${dstDir} already holds ${held.join(", ")} and differs from the source: nothing copied. Empty it (or run bun scripts/fixture-symbols-reset.ts) and run again`,
      );
  }
  let copied = 0;
  for (const { srcDir, dstDir, names } of plan) {
    mkdirSync(dstDir, { recursive: true });
    for (const n of names) {
      cpSync(join(srcDir, n), join(dstDir, n));
      copied++;
    }
  }
  if (existsSync(srcMarker) && !existsSync(dstMarker)) cpSync(srcMarker, dstMarker);
  return copied;
}

/** Step 4: the first thing missing, or undefined. Reads no config content (they hold a login). */
export function preflight(opts: SetupOpts, deps: SetupDeps): string | undefined {
  const { root, server } = opts;
  const {
    SYMBOLS_MARKER,
    FIXTURE_SYMBOLS_TAR_SHA256,
    GATE_FIXTURES,
    configFileName,
    launchFileName,
    symlinkedAlpackages,
  } = L();
  const marker = join(root, SYMBOLS_MARKER);
  if (existsSync(marker)) {
    const got = readFileSync(marker, "utf8").trim();
    if (got !== FIXTURE_SYMBOLS_TAR_SHA256)
      return `${SYMBOLS_MARKER} names ${got}, but the pinned symbol tar is ${FIXTURE_SYMBOLS_TAR_SHA256} (bun scripts/fixture-symbols-reset.ts)`;
  }
  if (server !== undefined) {
    for (const f of GATE_FIXTURES) {
      // Reported paths are POSIX-style on every platform (the message reads the same on Windows CI).
      for (const p of [
        `fixtures/${f.configDir}/${configFileName(server)}`,
        `fixtures/${f.configDir}/.vscode/${launchFileName(server)}`,
      ])
        if (!existsSync(join(root, p))) return `missing ${p} (bc-linux-setup --write-config-only)`;
    }
  }
  for (const d of needsSymbols(server))
    if (apps(join(root, d, ".alpackages")).length === 0)
      return `${d}/.alpackages holds no .app symbols (copy them with --alpackages-from)`;
  const linked = symlinkedAlpackages(root);
  if (linked.length > 0) return `${linked[0]} is a symlink out of this worktree (R787)`;
  const parser = deps.parserProblem();
  if (parser !== undefined) return `native parser: ${parser}`;
  return undefined;
}

/** Steps 1 to 4. Throws GateSetupError naming the first failed step or missing item. */
export async function setup(opts: SetupOpts, deps: SetupDeps): Promise<void> {
  const { root, server } = opts;
  ensureInstalled(root, deps); // first: nothing below can load without node_modules
  await loadLibs();
  if (server !== undefined) {
    const cmd = ["bun", "scripts/bc-linux-setup.ts", "--server", server, "--write-config-only"];
    if (deps.run(cmd, root) !== 0) throw new GateSetupError(`${cmd.join(" ")} failed`);
  }
  console.log(`alpackages: copied ${copyAlpackages(root, opts.alpackagesFrom)} file(s)`);
  if (deps.parserProblem() !== undefined) {
    if (deps.run(["bun", "scripts/build-native-parser.ts"], root) !== 0)
      throw new GateSetupError("bun scripts/build-native-parser.ts failed (is LLVM_BIN set?)");
  }
  const problem = preflight(opts, deps);
  if (problem !== undefined) throw new GateSetupError(`pre-flight: ${problem}`);
}

const REPO = resolve(import.meta.dir, "..");

/** In-process check. A process that has loaded the addon once keeps it, so never trust it after a rebuild. */
function parserProblemInProcess(): string | undefined {
  try {
    const { checkBinding, loadBindingFor } = L();
    const key = `${process.platform}-${process.arch}`;
    checkBinding(loadBindingFor(key), key, join(REPO, "packages", "engine", "native"));
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type Spawn = (
  cmd: string,
  args: string[],
) => { status: number | null; stderr?: Buffer | string | null };

/** Each call asks a fresh `bun` process, so a rebuilt .node is seen as rebuilt. */
export function parserProblemViaSubprocess(
  spawn: Spawn = (c, a) => spawnSync(c, a, { encoding: "utf8" }),
): string | undefined {
  const r = spawn(process.execPath, [import.meta.path, "--check-parser"]);
  if (r.status === 0) return undefined;
  return String(r.stderr ?? "").trim() || `parser check exited ${r.status}`;
}

export const REAL_DEPS: SetupDeps = {
  run: (cmd, cwd) => spawnSync(cmd[0] ?? "", cmd.slice(1), { cwd, stdio: "inherit" }).status ?? 1,
  parserProblem: () => parserProblemViaSubprocess(),
};

function parse(argv: readonly string[]): SetupOpts {
  let server: Server | undefined;
  let v3 = false;
  let from: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--v3-only") v3 = true;
    else if (a === "--server") {
      const s = argv[++i];
      if (!SERVERS.includes(s as Server)) throw new GateSetupError("--server takes bc1|bc2|bc3");
      server = s as Server;
    } else if (a === "--alpackages-from") from = argv[++i];
    else throw new GateSetupError(`unknown argument ${a}`);
  }
  if (from === undefined) throw new GateSetupError("--alpackages-from <checkout> is required");
  if (v3 === (server !== undefined))
    throw new GateSetupError("give exactly one of --server and --v3-only");
  return { root: REPO, server, alpackagesFrom: resolve(from) };
}

if (import.meta.main) {
  if (process.argv[2] === "--check-parser") {
    await loadLibs();
    const problem = parserProblemInProcess();
    if (problem !== undefined) console.error(problem);
    process.exit(problem === undefined ? 0 : 1);
  }
  try {
    await setup(parse(process.argv.slice(2)), REAL_DEPS);
    console.log("gate worktree ready: pre-flight passed. No lease taken, nothing published.");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
