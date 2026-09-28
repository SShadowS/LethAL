#!/usr/bin/env bun
/**
 * RUST-01: check the grammar sources, build the native parser addon for THIS platform, and write
 * packages/engine/vendor/native/lethal-parser.<key>.node plus its .provenance.json (both
 * gitignored, D2). `--test` runs `cargo test` with the same checked environment instead.
 * Honours CARGO_TARGET_DIR, so worktrees can share one build cache.
 *
 *   bun scripts/build-native-parser.ts [--test]
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** RUST-03: clang on every target. clang-cl on Windows (MSVC ABI), clang elsewhere. LLVM_BIN may
 *  point at a specific install; otherwise PATH. The build refuses a compiler that is not clang. */
function clangCc(): string {
  const exe = process.platform === "win32" ? "clang-cl.exe" : "clang";
  const cc = process.env.LLVM_BIN !== undefined ? join(process.env.LLVM_BIN, exe) : exe;
  const v = Bun.spawnSync([cc, "--version"]);
  const banner = v.stdout.toString().split("\n")[0] ?? "";
  if (v.exitCode !== 0 || !/clang version/.test(banner)) {
    throw new Error(
      `build-native-parser: ${cc} is not a working clang (${banner || v.stderr.toString().trim()}). Install LLVM 23.1.2 or set LLVM_BIN.`,
    );
  }
  return cc;
}

async function main(): Promise<void> {
  const key = `${process.platform}-${process.arch}`;
  const lib = LIB[key];
  if (lib === undefined) throw new Error(`build-native-parser: no LethAL target for ${key}`);
  const env = cargoEnv(process.env, clangCc(), grammarInputs());
  const test = process.argv.includes("--test");
  const run = Bun.spawnSync(["cargo", test ? "test" : "build", "--release", "--locked"], {
    cwd: CRATE,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (run.exitCode !== 0)
    throw new Error(`build-native-parser: cargo failed with exit ${run.exitCode}`);
  if (test) return;

  const targetDir = process.env.CARGO_TARGET_DIR ?? join(CRATE, "target");
  const outDir = join(import.meta.dir, "..", "packages", "engine", "vendor", "native");
  const out = join(outDir, `lethal-parser.${key}.node`);
  await mkdir(outDir, { recursive: true });
  await copyFile(join(targetDir, "release", lib), out);

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

if (import.meta.main) await main();
