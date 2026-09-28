#!/usr/bin/env bun
/**
 * RUST-01: check the grammar sources, build the native parser addon for THIS platform, and write
 * packages/engine/vendor/native/lethal-parser.<key>.node plus its .provenance.json (both
 * gitignored, D2). `--test` runs `cargo test` with the same checked environment instead.
 * Honours CARGO_TARGET_DIR, so worktrees can share one build cache.
 *
 * RUST-03 S2: `--target <key>` cross-builds for another platform key with the same checked clang
 * (release CI builds darwin-x64 on the arm64 runner: LLVM 23.1.2 ships no x64 macOS build). A
 * cross-built addon cannot load here, so its provenance is written on the target machine by
 * `--provenance`, which loads the vendor addon for the running platform and records it.
 *
 *   bun scripts/build-native-parser.ts [--test] [--target <key>]
 *   bun scripts/build-native-parser.ts --provenance
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXPECTED_TARGET } from "../packages/engine/src/ast/native-parser";
import { CRATE, grammarInputs } from "./check-native-grammar";

const LIB: Readonly<Record<string, string>> = {
  "win32-x64": "lethal_parser.dll",
  "linux-x64": "liblethal_parser.so",
  "linux-arm64": "liblethal_parser.so",
  "darwin-x64": "liblethal_parser.dylib",
  "darwin-arm64": "liblethal_parser.dylib",
};
/** RUST-03: cc-rs picks `CC_<target>`, then `TARGET_CC`, then `CC` (and flags the same way), so a
 *  stray variable in the shell could build the grammar with another compiler while provenance says
 *  clang. Every compiler and C-flag override is REMOVED from the child env; CC is then set to the
 *  checked clang, and the only C flags are `.cargo/config.toml`'s. Matched case-insensitively,
 *  because Windows env names are. */
const STRIPPED = /^(?:(?:CC|CFLAGS)_.+|(?:TARGET|HOST)_(?:CC|CFLAGS)|CFLAGS)$/i;

export function cargoEnv(
  base: Readonly<Record<string, string | undefined>>,
  cc: string,
  grammar: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !STRIPPED.test(k) && k.toUpperCase() !== "CC") env[k] = v;
  }
  env.CC = cc;
  env.LETHAL_GRAMMAR_INPUTS = grammar;
  return env;
}

/** RUST-03: the one LLVM release every addon is built with. build.rs and native-binding.test.ts
 *  hold the same pin. */
export const CLANG_VERSION = "23.1.2";

/** True only for LLVM's own clang at exactly CLANG_VERSION ("Apple clang ..." and 23.1.20 fail). */
export function isPinnedClang(banner: string): boolean {
  return (
    banner === `clang version ${CLANG_VERSION}` ||
    banner.startsWith(`clang version ${CLANG_VERSION} `)
  );
}

/** One absolute target dir for both cargo (which runs in the crate dir) and the copy (which runs
 *  from here). A relative CARGO_TARGET_DIR is resolved against `cwd`, the caller's directory. */
export function cargoTargetDir(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  const dir = env.CARGO_TARGET_DIR;
  return dir !== undefined && dir !== "" ? resolve(cwd, dir) : join(CRATE, "target");
}

/** RUST-03: clang on every target. clang-cl on Windows (MSVC ABI), clang elsewhere. LLVM_BIN may
 *  point at a specific install; otherwise PATH. The build refuses anything but clang CLANG_VERSION. */
function clangCc(): string {
  const exe = process.platform === "win32" ? "clang-cl.exe" : "clang";
  const cc = process.env.LLVM_BIN !== undefined ? join(process.env.LLVM_BIN, exe) : exe;
  const v = Bun.spawnSync([cc, "--version"]);
  const banner = (v.stdout.toString().split("\n")[0] ?? "").trim();
  if (v.exitCode !== 0 || !isPinnedClang(banner)) {
    throw new Error(
      `build-native-parser: ${cc} is not clang ${CLANG_VERSION} (${banner || v.stderr.toString().trim()}). Install LLVM ${CLANG_VERSION} (bash scripts/install-llvm.sh <platform-key>) or set LLVM_BIN.`,
    );
  }
  return cc;
}

export interface CargoPlan {
  /** The addon's platform key, which names the .node file. */
  readonly key: string;
  readonly args: readonly string[];
  /** The built library, relative to the cargo target dir. */
  readonly libPath: readonly string[];
  /** True when the addon is for another platform than this process, so it cannot be loaded here. */
  readonly cross: boolean;
}

/** What cargo runs for `host` building `target` (a platform key; default: the host). A cross build
 *  passes the target triple, so cargo writes under <triple>/release; the compiler is the same
 *  checked clang either way, since cc-rs gives clang the triple itself. */
export function cargoPlan(host: string, target: string | undefined, test: boolean): CargoPlan {
  const key = target ?? host;
  const lib = LIB[key];
  const triple = EXPECTED_TARGET[key];
  if (lib === undefined || triple === undefined)
    throw new Error(`build-native-parser: no LethAL target for ${key}`);
  const cross = key !== host;
  if (cross && test)
    throw new Error(
      `build-native-parser: --test runs the tests, which a ${host} machine cannot do for ${key}`,
    );
  return {
    key,
    args: [
      test ? "test" : "build",
      "--release",
      "--locked",
      ...(cross ? ["--target", triple] : []),
    ],
    libPath: cross ? [triple, "release", lib] : ["release", lib],
    cross,
  };
}

const VENDOR = join(import.meta.dir, "..", "packages", "engine", "vendor", "native");

/** Writes <addon>.provenance.json from the addon's own nativeInfo, so it must run where the addon
 *  loads: after a native build, or with --provenance on the target machine after a cross build. */
async function writeProvenance(key: string): Promise<void> {
  const out = join(VENDOR, `lethal-parser.${key}.node`);
  const bytes = await readFile(out);
  const binding = require(out) as { nativeInfo(): unknown };
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  const provenance = {
    file: `lethal-parser.${key}.node`,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    nativeInfo: binding.nativeInfo(),
    cargoLockSha256: new Bun.CryptoHasher("sha256")
      .update(await readFile(join(CRATE, "Cargo.lock")))
      .digest("hex"),
    commit,
  };
  await writeFile(
    `${out.slice(0, -".node".length)}.provenance.json`,
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  console.log(`build-native-parser: wrote ${out} (${provenance.sha256})`);
}

export interface BuildArgs {
  readonly test: boolean;
  readonly target: string | undefined;
  readonly provenance: boolean;
}

/** --provenance records the addon of the platform it runs on, so it takes no other flag: a
 *  --target beside it would be silently ignored, and --test would not run. */
export function buildArgs(argv: readonly string[]): BuildArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      test: { type: "boolean", default: false },
      target: { type: "string" },
      provenance: { type: "boolean", default: false },
    },
  });
  const provenance = values.provenance === true;
  const test = values.test === true;
  if (provenance && (values.target !== undefined || test))
    throw new Error(
      "build-native-parser: --provenance records the addon for the platform it runs on and takes no --target or --test",
    );
  return { test, target: values.target, provenance };
}

async function main(): Promise<void> {
  const host = `${process.platform}-${process.arch}`;
  const values = buildArgs(process.argv.slice(2));
  if (values.provenance) {
    await writeProvenance(host);
    return;
  }
  const plan = cargoPlan(host, values.target, values.test);
  const env = cargoEnv(process.env, clangCc(), grammarInputs());
  const targetDir = cargoTargetDir(process.env, process.cwd());
  env.CARGO_TARGET_DIR = targetDir;
  const run = Bun.spawnSync(["cargo", ...plan.args], {
    cwd: CRATE,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (run.exitCode !== 0)
    throw new Error(`build-native-parser: cargo failed with exit ${run.exitCode}`);
  if (values.test) return;

  const out = join(VENDOR, `lethal-parser.${plan.key}.node`);
  await mkdir(VENDOR, { recursive: true });
  await copyFile(join(targetDir, ...plan.libPath), out);
  if (plan.cross) {
    console.log(
      `build-native-parser: wrote ${out} (cross-built on ${host}; run \`bun scripts/build-native-parser.ts --provenance\` on ${plan.key} to check it loads and record its provenance)`,
    );
    return;
  }
  await writeProvenance(plan.key);
}

if (import.meta.main) await main();
