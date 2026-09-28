#!/usr/bin/env bun
/**
 * RUST-01: the license and notice inventory for the native parser addon. Lists every crate cargo
 * resolves, evaluates each FULL SPDX expression (OR needs one allowed side, AND needs both, WITH
 * needs an allowed exception), and writes packages/engine/native/THIRD-PARTY-NOTICES.md: the
 * table, then every crate's license and copyright text verbatim, which MIT and Apache-2.0 require
 * in a shipped binary (RUST-03 S2: the file is attached to every release).
 * `--check` exits 1 if the committed file differs.
 *
 *   bun scripts/native-notices.ts [--check]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CRATE, cargoPackages } from "./check-native-grammar";

const ALLOWED = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "0BSD",
];
const ALLOWED_EXCEPTIONS = ["LLVM-exception"];
const OUT = join(CRATE, "THIRD-PARTY-NOTICES.md");
const LICENSE_FILE = /^(?:licen[cs]e|copying|copyright|notice)/i;

const napiRs = (tag: string) => ({
  file: "napi-rs.LICENSE",
  source: `https://github.com/napi-rs/napi-rs/blob/${tag}/LICENSE`,
});
/** Crates whose published package carries no license file, keyed by `name@version` so a version
 *  bump fails until someone re-copies the text from the new release. The text is committed under
 *  packages/engine/native/licenses/, copied from the named file at that release's tag (the five
 *  napi-rs tags hold byte-identical LICENSE files, so they share one copy). */
export const UPSTREAM_LICENSES: Readonly<Record<string, { file: string; source: string }>> = {
  "napi@3.13.0": napiRs("napi-v3.13.0"),
  "napi-build@2.5.0": napiRs("napi-build-v2.5.0"),
  "napi-derive@3.6.9": napiRs("napi-derive-v3.6.9"),
  "napi-derive-backend@6.1.4": napiRs("napi-derive-backend-v6.1.4"),
  "napi-sys@3.3.2": napiRs("napi-sys-v3.3.2"),
  "tree-sitter@0.25.10": {
    file: "tree-sitter.LICENSE",
    source: "https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/LICENSE",
  },
  "tree-sitter-al@4.4.1": {
    file: "tree-sitter-al.LICENSE",
    source: "https://github.com/sshadows/tree-sitter-al/blob/v4.4.1/LICENSE",
  },
};

export interface LicenseText {
  readonly origin: string;
  readonly text: string;
}

/** Every license, copyright and notice file of one crate: the packaged ones, else the committed
 *  upstream copy. Throws when there is neither, so a new crate cannot ship without its text. */
export function licenseTexts(
  name: string,
  version: string,
  pkgDir: string,
  licensesDir: string = join(CRATE, "licenses"),
): LicenseText[] {
  const read = (f: string) => readFileSync(f, "utf8").replaceAll("\r", "").trimEnd();
  const packaged = readdirSync(pkgDir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => ({ origin: f, text: read(join(pkgDir, f)) }));
  if (packaged.length > 0) return packaged;
  const up = UPSTREAM_LICENSES[`${name}@${version}`];
  if (up === undefined || !existsSync(join(licensesDir, up.file)))
    throw new Error(
      `crate ${name} ${version} packages no license file and has no committed upstream copy for that version: copy it from the release tag into packages/engine/native/licenses/ and add ${name}@${version} to UPSTREAM_LICENSES`,
    );
  return [{ origin: `upstream ${up.source}`, text: read(join(licensesDir, up.file)) }];
}

export function spdxAllowed(expr: string): boolean {
  const tokens = expr
    .replaceAll("/", " OR ")
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  let pos = 0;
  const atom = (): boolean => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`truncated SPDX expression: ${expr}`);
    if (t === "(") {
      const v = orExpr();
      if (tokens[pos++] !== ")") throw new Error(`unbalanced SPDX expression: ${expr}`);
      return v;
    }
    return ALLOWED.includes(t);
  };
  const withExpr = (): boolean => {
    const v = atom();
    if (tokens[pos] !== "WITH") return v;
    pos++;
    const exception = tokens[pos++];
    return v && exception !== undefined && ALLOWED_EXCEPTIONS.includes(exception);
  };
  const andExpr = (): boolean => {
    let v = withExpr();
    while (tokens[pos] === "AND") {
      pos++;
      const r = withExpr();
      v = v && r;
    }
    return v;
  };
  const orExpr = (): boolean => {
    let v = andExpr();
    while (tokens[pos] === "OR") {
      pos++;
      const r = andExpr();
      v = v || r;
    }
    return v;
  };
  const v = orExpr();
  if (pos !== tokens.length) throw new Error(`unparsed tail in SPDX expression: ${expr}`);
  return v;
}

if (import.meta.main) {
  const rows = cargoPackages()
    .filter((p) => p.name !== "lethal-parser")
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? "",
      dir: dirname(p.manifest_path),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const bad = rows.filter((r) => !spdxAllowed(r.license));
  if (bad.length > 0)
    throw new Error(
      `licenses outside the allowlist: ${bad.map((r) => `${r.name} ${r.version} (${r.license || "none"})`).join(", ")}`,
    );
  const lines = [
    "# Third-party notices: LethAL native parser addon",
    "",
    "Generated by `bun scripts/native-notices.ts` from `cargo metadata`. Do not edit by hand.",
    "The grammar (tree-sitter-al, MIT) and the tree-sitter runtime (MIT) are compiled into the addon.",
    "",
    "| crate | version | license |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} |`),
    "",
    "## License and copyright texts",
    "",
    "Reproduced verbatim from each crate's packaged license files or, where a crate packages none,",
    "from the upstream file committed under `packages/engine/native/licenses/`.",
    "",
  ];
  // Identical texts (most Apache-2.0 copies) are printed once, under every crate that carries one.
  const byText = new Map<string, string[]>();
  for (const r of rows) {
    for (const t of licenseTexts(r.name, r.version, r.dir)) {
      const users = byText.get(t.text) ?? [];
      users.push(`${r.name} ${r.version} (${t.origin})`);
      byText.set(t.text, users);
    }
  }
  for (const [t, users] of byText)
    lines.push(`### ${users.join(", ")}`, "", "````text", t, "````", "");
  const text = lines.join("\n");
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT, "utf8").replaceAll("\r", "") !== text) {
      console.error("THIRD-PARTY-NOTICES.md is out of date: run bun scripts/native-notices.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
