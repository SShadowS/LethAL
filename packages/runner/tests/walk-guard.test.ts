import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFilesSync } from "../src/walk";

/**
 * R631 guard: a recursive directory walk goes through `walk.ts`, never Bun's `readdir(...,
 * { recursive: true })` (which follows directory links) and never a hand walker that `stat`s
 * (which follows them too). Scope: every `packages/<pkg>/src` file and the three maintained
 * corpus scripts.
 */
const REPO = join(import.meta.dir, "..", "..", "..");
const ALLOWED = new Set(["packages/runner/src/walk.ts"]);
const SCRIPTS = [
  "scripts/lib/collect-al-files.ts",
  "scripts/corpus-fingerprint.ts",
  "scripts/corpus-snapshot.ts",
];

/** The text between the `(` at `open` and its matching `)`. */
function argsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Split `args` at top-level commas. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(args.slice(start).trim());
  return out.filter((a) => a !== "");
}

/** (a) a `readdir*` call that is or may be recursive: `recursive` anywhere in the call, or an
 *  options argument that is not an object literal (a variable could carry `recursive`). */
export function recursiveReaddirs(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\breaddir(Sync)?\s*\(/g)) {
    const args = argsAt(text, (m.index ?? 0) + m[0].length - 1);
    const parts = topLevelArgs(args);
    const opts = parts[1];
    if (args.includes("recursive") || (opts !== undefined && !opts.startsWith("{")))
      found.push(`${m[0]}${args})`);
  }
  return found;
}

/** (b) a function that calls `readdir*` and `stat`/`statSync` (not `lstat`) and calls itself. */
export function statWalkers(text: string): string[] {
  const found: string[] = [];
  const decl = /(?:function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)[^=]*=>\s*)/g;
  for (const m of text.matchAll(decl)) {
    const name = m[1] ?? m[2];
    if (name === undefined) continue;
    const brace = text.indexOf("{", (m.index ?? 0) + m[0].length - 1);
    if (brace < 0) continue;
    let depth = 0;
    let end = text.length;
    for (let i = brace; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = text.slice(brace, end);
    if (
      /\breaddir(Sync)?\s*\(/.test(body) &&
      /(?<![\w.]l|\wl)\bstat(Sync)?\s*\(/.test(body) &&
      new RegExp(`\\b${name}\\s*\\(`).test(body)
    )
      found.push(name);
  }
  return found;
}

describe("R631 walk guard: the detectors", () => {
  test("(a) flags recursive and options-variable calls; passes one-level literal calls", () => {
    expect(recursiveReaddirs("await readdir(d, { recursive: true })")).toHaveLength(1);
    expect(recursiveReaddirs("readdirSync(d, opts)")).toHaveLength(1);
    expect(recursiveReaddirs("readdirSync(d)")).toEqual([]);
    expect(recursiveReaddirs("await readdir(d, { withFileTypes: true })")).toEqual([]);
  });

  test("(b) flags a self-recursive stat walker; passes an lstat walker", () => {
    const statWalk =
      "const walk = (d: string): void => { for (const e of readdirSync(d)) { if (statSync(join(d, e)).isDirectory()) walk(join(d, e)); } };";
    const lstatWalk = statWalk.replace("statSync(", "lstatSync(");
    expect(statWalkers(statWalk)).toEqual(["walk"]);
    expect(statWalkers(lstatWalk)).toEqual([]);
  });
});

describe("R631 walk guard: the product and the maintained scripts", () => {
  test("no recursive readdir and no stat walker outside walk.ts", () => {
    const files: string[] = [...SCRIPTS];
    for (const rel of walkFilesSync(join(REPO, "packages"), { links: "skip" }).files) {
      const posix = rel.replaceAll("\\", "/");
      if (/^[^/]+\/src\/.*\.ts$/.test(posix)) files.push(`packages/${posix}`);
    }
    // Not vacuous: the scan reaches the walker itself and the three scripts.
    expect(files).toContain("packages/runner/src/walk.ts");
    const hits: string[] = [];
    for (const f of files) {
      if (ALLOWED.has(f)) continue;
      const text = readFileSync(join(REPO, f), "utf8");
      for (const h of recursiveReaddirs(text)) hits.push(`${f}: ${h}`);
      for (const h of statWalkers(text)) hits.push(`${f}: stat walker ${h}`);
    }
    expect(hits).toEqual([]);
  });
});
