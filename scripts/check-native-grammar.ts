#!/usr/bin/env bun
/**
 * RUST-01: prove the native parser's grammar sources are the ones the vendored WASM was built from
 * (upstream's tree-sitter-al.wasm.inputs.sha256 at tag v4.4.1). `grammarInputs()` is what
 * build-native-parser.ts passes to build.rs, which embeds it. Run directly, exit 1 on a difference.
 *
 *   bun scripts/check-native-grammar.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "4.4.1";
const EXPECTED: Readonly<Record<string, string>> = {
  "src/parser.c": "0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22",
  "src/scanner.c": "346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a",
};
export const CRATE = join(import.meta.dir, "..", "packages", "engine", "native");

interface CargoPackage {
  readonly name: string;
  readonly version: string;
  readonly manifest_path: string;
  readonly license: string | null;
}

export function cargoPackages(): readonly CargoPackage[] {
  const meta = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--locked"], {
    cwd: CRATE,
  });
  if (meta.exitCode !== 0) throw new Error(`cargo metadata failed: ${meta.stderr.toString()}`);
  const parsed = JSON.parse(meta.stdout.toString()) as { packages?: CargoPackage[] };
  if (parsed.packages === undefined) throw new Error("cargo metadata returned no packages");
  return parsed.packages;
}

/** Throws unless the resolved grammar sources match upstream's recorded inputs. */
export function grammarInputs(): string {
  const pkg = cargoPackages().find((p) => p.name === "tree-sitter-al");
  if (pkg === undefined) throw new Error("cargo metadata lists no tree-sitter-al package");
  if (pkg.version !== EXPECTED_VERSION)
    throw new Error(`tree-sitter-al is ${pkg.version}, expected ${EXPECTED_VERSION}`);
  const parts: string[] = [];
  for (const [rel, want] of Object.entries(EXPECTED)) {
    const got = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(dirname(pkg.manifest_path), rel)))
      .digest("hex");
    if (got !== want)
      throw new Error(`grammar source ${rel} hashes to ${got}, upstream's wasm inputs say ${want}`);
    parts.push(`${rel.replace("src/", "")}:${got}`);
  }
  return parts.join(";");
}

if (import.meta.main) {
  console.log(grammarInputs());
}
