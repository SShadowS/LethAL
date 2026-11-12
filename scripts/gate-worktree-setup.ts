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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkBinding, loadBindingFor } from "../packages/engine/src/ast/native-parser.ts";
import { SYMBOLS_MARKER, symlinkedAlpackages } from "../packages/runner/itest/fixture-symbols.ts";
import { GATE_FIXTURES, configFileName, launchFileName } from "./bc-linux-setup.ts";

export const SERVERS = ["bc1", "bc2", "bc3"] as const;
export type Server = (typeof SERVERS)[number];

/**
 * Tests projects whose `.alpackages` an itest or a v3 leg compiles against. From the itests' own
 * refusals ("holds no .app symbols"): verify and testapp read sandbox-tests, verify-scale
 * sandbox-data-tests, agreement sandbox-harden-tests; the v3 gate reads the first two.
 */
export const NEEDS_SYMBOLS = [
  "fixtures/sandbox-tests",
  "fixtures/sandbox-data-tests",
  "fixtures/sandbox-harden-tests",
] as const;

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
  if (resolve(root) === resolve(from))
    throw new GateSetupError("--alpackages-from is this worktree itself");
  const srcFixtures = join(from, "fixtures");
  if (!existsSync(srcFixtures))
    throw new GateSetupError(`${from} has no fixtures/ folder: not a LethAL checkout`);
  const srcMarker = join(from, SYMBOLS_MARKER);
  const dstMarker = join(root, SYMBOLS_MARKER);
  if (existsSync(srcMarker) && existsSync(dstMarker)) {
    const [a, b] = [readFileSync(srcMarker, "utf8").trim(), readFileSync(dstMarker, "utf8").trim()];
    if (a !== b)
      throw new GateSetupError(
        `${SYMBOLS_MARKER} differs (source ${a}, here ${b}): the folders came from another symbol tar; run bun scripts/fixture-symbols-reset.ts first`,
      );
  }
  let copied = 0;
  for (const fx of readdirSync(srcFixtures)) {
    const srcDir = join(srcFixtures, fx, ".alpackages");
    for (const name of apps(srcDir)) {
      const dst = join(root, "fixtures", fx, ".alpackages", name);
      if (existsSync(dst) && statSync(dst).size === statSync(join(srcDir, name)).size) continue;
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(srcDir, name), dst);
      copied++;
    }
  }
  if (existsSync(srcMarker) && !existsSync(dstMarker)) cpSync(srcMarker, dstMarker);
  return copied;
}

/** Step 4: the first thing missing, or undefined. Reads no config content (they hold a login). */
export function preflight(opts: SetupOpts, deps: SetupDeps): string | undefined {
  const { root, server } = opts;
  if (server !== undefined) {
    for (const f of GATE_FIXTURES) {
      for (const p of [
        join("fixtures", f.configDir, configFileName(server)),
        join("fixtures", f.configDir, ".vscode", launchFileName(server)),
      ])
        if (!existsSync(join(root, p))) return `missing ${p} (bc-linux-setup --write-config-only)`;
    }
  }
  for (const d of NEEDS_SYMBOLS)
    if (apps(join(root, d, ".alpackages")).length === 0)
      return `${d}/.alpackages holds no .app symbols (copy them with --alpackages-from)`;
  const linked = symlinkedAlpackages(root);
  if (linked.length > 0) return `${linked[0]} is a symlink out of this worktree (R787)`;
  const parser = deps.parserProblem();
  if (parser !== undefined) return `native parser: ${parser}`;
  return undefined;
}

/** Steps 1 to 4. Throws GateSetupError naming the first failed step or missing item. */
export function setup(opts: SetupOpts, deps: SetupDeps): void {
  const { root, server } = opts;
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

export const REAL_DEPS: SetupDeps = {
  run: (cmd, cwd) => spawnSync(cmd[0] ?? "", cmd.slice(1), { cwd, stdio: "inherit" }).status ?? 1,
  parserProblem: () => {
    try {
      // Fresh module state is not needed: this process has loaded nothing yet at the first call,
      // and the second call (after a build) re-reads the .node through the same loader.
      const key = `${process.platform}-${process.arch}`;
      checkBinding(loadBindingFor(key), key, join(REPO, "packages", "engine", "native"));
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
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
  try {
    setup(parse(process.argv.slice(2)), REAL_DEPS);
    console.log("gate worktree ready: pre-flight passed. No lease taken, nothing published.");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
