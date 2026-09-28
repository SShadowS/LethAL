/**
 * RUST-03: loads the native tree-sitter-al addon and checks it against the pinned grammar.
 * No WASM fallback: a missing or mismatched binary throws (design section 7).
 * Loader variant B (R314): `bun build --compile` embeds the .node only through a require whose
 * path is a template over a build-time define; source mode resolves the running platform's key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlatTree, ParsedAL } from "./syntax-node";

export interface NativeInfo {
  readonly bindingSourceSha256: string;
  readonly grammarInputs: string;
  readonly grammarVersion: string;
  readonly treeSitterVersion: string;
  readonly languageAbi: number;
  readonly kindTableSha256: string;
  readonly rustcVersion: string;
  readonly target: string;
  readonly cCompiler: string;
}

export interface NativeBinding {
  parseFlat(source: string): FlatTree;
  nativeInfo(): NativeInfo;
}

export const GRAMMAR_PIN = {
  grammarVersion: "4.4.1",
  treeSitterVersion: "0.25.10",
  languageAbi: 15,
  kindTableSha256: "65dca121ad7b431ee3427e7c0762eba34b90c4ca9dbd5d11593ea91c126f7d45",
  grammarInputs:
    "parser.c:0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22;scanner.c:346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a",
} as const;

export class NativeParserMissingError extends Error {
  constructor(
    readonly platformKey: string,
    cause: unknown,
  ) {
    super(
      `LethAL's native AL parser has no binary for ${platformKey}. Expected packages/engine/vendor/native/lethal-parser.${platformKey}.node; build it with \`bun scripts/build-native-parser.ts\` (needs Rust and LLVM clang), or use a release binary.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "NativeParserMissingError";
  }
}

/** The .node file is there but the platform refused to load it (corrupt, truncated, another
 *  platform's binary, a missing system library). Carries the loader's own error as `cause`. */
export class NativeParserLoadError extends Error {
  constructor(
    readonly platformKey: string,
    cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      `LethAL's native AL parser for ${platformKey} (packages/engine/vendor/native/lethal-parser.${platformKey}.node) exists but could not be loaded: ${why}. Rebuild it with \`bun scripts/build-native-parser.ts\`, or use a release binary.`,
      { cause },
    );
    this.name = "NativeParserLoadError";
  }
}

export class NativeParserPinError extends Error {
  constructor(field: string, expected: string, actual: string) {
    super(
      `LethAL's native AL parser reports ${field} ${actual}, but the engine is pinned to ${expected}. Rebuild it with \`bun scripts/build-native-parser.ts\`.`,
    );
    this.name = "NativeParserPinError";
  }
}

export class NativeParserStaleError extends Error {
  constructor(built: string, local: string) {
    super(
      `LethAL's native AL parser was built from sources with sha256 ${built}, but packages/engine/native now hashes to ${local}. Rebuild it with \`bun scripts/build-native-parser.ts\`.`,
    );
    this.name = "NativeParserStaleError";
  }
}

/** Platform key -> the Rust target triple the addon must report (build.rs LETHAL_TARGET). */
export const EXPECTED_TARGET: Readonly<Record<string, string>> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

/** The same hash build.rs computes over SOURCES: name, "\n", text without "\r", "\n", per file.
 *  Exported so native-binding.test.ts uses the one definition. */
export function localBindingSourceSha256(crateDir: string): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of ["Cargo.toml", "Cargo.lock", "build.rs", "src/lib.rs"]) {
    h.update(`${f}\n${readFileSync(join(crateDir, f), "utf8").replaceAll("\r", "")}\n`);
  }
  return h.digest("hex");
}

declare const __LETHAL_NATIVE_KEY__: string;

export function loadBindingFor(key: string): NativeBinding {
  // A compiled binary requires its embedded key, not `key`: name the one that was actually missing.
  const wanted = typeof __LETHAL_NATIVE_KEY__ !== "undefined" ? __LETHAL_NATIVE_KEY__ : key;
  try {
    const loaded: unknown =
      typeof __LETHAL_NATIVE_KEY__ !== "undefined"
        ? require(`../../vendor/native/lethal-parser.${__LETHAL_NATIVE_KEY__}.node`)
        : require(`../../vendor/native/lethal-parser.${key}.node`);
    if (loaded === undefined || loaded === null)
      throw new NativeParserMissingError(wanted, undefined);
    return loaded as NativeBinding;
  } catch (cause) {
    if (cause instanceof NativeParserMissingError) throw cause;
    // Only "no such module" means missing. Anything else (a dlopen failure) is a present file that
    // did not load, and saying "no binary" there would send the reader looking for the wrong thing.
    if ((cause as { code?: unknown } | null)?.code === "MODULE_NOT_FOUND")
      throw new NativeParserMissingError(wanted, cause);
    throw new NativeParserLoadError(wanted, cause);
  }
}

let binding: NativeBinding | null = null;

function checkedBinding(): NativeBinding {
  if (binding !== null) return binding;
  const key = `${process.platform}-${process.arch}`;
  const b = loadBindingFor(key);
  checkBinding(
    b,
    key,
    typeof __LETHAL_NATIVE_KEY__ === "undefined"
      ? join(import.meta.dir, "..", "..", "native")
      : null,
  );
  binding = b;
  return b;
}

/** Every init check. crateDir null = compiled mode (the release binary has no crate on disk and
 *  was checked in CI); otherwise source mode, which also refuses a stale build. */
export function checkBinding(b: NativeBinding, key: string, crateDir: string | null): void {
  const info = b.nativeInfo();
  for (const k of [
    "grammarVersion",
    "treeSitterVersion",
    "languageAbi",
    "kindTableSha256",
    "grammarInputs",
  ] as const) {
    if (info[k] !== GRAMMAR_PIN[k])
      throw new NativeParserPinError(k, String(GRAMMAR_PIN[k]), String(info[k]));
  }
  // The compiled binary embeds its own key, so loadBindingFor ignores `key` there: check that the
  // addon was built for the platform and arch this process is actually running on.
  const want = EXPECTED_TARGET[key];
  if (want === undefined || info.target !== want)
    throw new NativeParserPinError("target", want ?? `a supported target for ${key}`, info.target);
  // Source mode only: refuse an addon built from other crate sources, so a developer cannot run a
  // stale build without running the tests. A missing crate file throws from readFileSync (loud).
  if (crateDir !== null) {
    const local = localBindingSourceSha256(crateDir);
    if (info.bindingSourceSha256 !== local)
      throw new NativeParserStaleError(info.bindingSourceSha256, local);
  }
}

export function initNativeParser(): Promise<void> {
  checkedBinding();
  return Promise.resolve();
}

export function nativeInfo(): NativeInfo {
  return checkedBinding().nativeInfo();
}

// RUST-03 (S3.3): how many parse results are still reachable. A diagnostic, not a cache: the
// registry holds no reference to what it watches.
// parsesSinceStart is monotonic: it never falls, so a test can read "the scan really parsed n
// files" without racing a GC that finalizes results during the scan.
let live = 0;
let total = 0;
const released = new FinalizationRegistry<undefined>(() => {
  live--;
});

export function liveParseResults(): number {
  return live;
}

export function parsesSinceStart(): number {
  return total;
}

export function parseALNative(source: string): ParsedAL {
  if (binding === null) throw new Error("native parser not initialized, call initParser() first");
  const parsed: ParsedAL = { source, flat: binding.parseFlat(source) };
  live++;
  total++;
  released.register(parsed, undefined);
  return parsed;
}
