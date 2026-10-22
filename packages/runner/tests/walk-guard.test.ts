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

/** Comments out, so prose that names a hazard is not code that has it. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** (a) a `readdir*` call that is or may be recursive: `recursive` anywhere in the call, or an
 *  options argument that is not a plain object literal (a variable or a spread could carry it). */
function recursiveReaddirs(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\breaddir(Sync)?\s*\(/g)) {
    const args = argsAt(text, (m.index ?? 0) + m[0].length - 1);
    const opts = topLevelArgs(args)[1];
    if (
      args.includes("recursive") ||
      (opts !== undefined && (!opts.startsWith("{") || opts.includes("...")))
    )
      found.push(`${m[0]}${args})`);
  }
  return found;
}

/** (b) any other way to follow links: a glob or copy option that does, `node:fs`'s glob, or an
 *  aliased `readdir`/`stat`/`glob` import that the call checks above would not see by name. */
function linkFollowers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b(followSymlinks|dereference)\b/g)) found.push(m[0]);
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs(?:\/promises)?["']/g)) {
    const names = m[1] ?? "";
    if (/\bglob(Sync)?\b/.test(names)) found.push("node:fs glob");
    for (const a of names.matchAll(
      /\b(readdir|readdirSync|stat|statSync|glob|globSync)\s+as\s+\w+/g,
    ))
      found.push(`aliased ${a[0]}`);
  }
  for (const m of text.matchAll(/\bfs\w*\.glob(Sync)?\s*\(/g)) found.push(m[0]);
  return found;
}

/** (c) a file that lists folders AND decides "is this a folder" by `stat`, which follows a link:
 *  recursive, stack-based or a class method alike. `lstat` is fine. */
function statWalkers(text: string): string[] {
  const lists = /\breaddir(Sync)?\s*\(/.test(text);
  const statDir =
    /(?<![\w.]l|\wl)\bstat(Sync)?\s*\([^;]*?\)\s*\)?\s*(\?)?\.isDirectory\(\)/.test(text) ||
    [...text.matchAll(/\b(\w+)\s*=\s*(?:await\s+)?(?<![\w.]l)stat(Sync)?\s*\(/g)].some((m) =>
      new RegExp(`\\b${m[1]}\\??\\.isDirectory\\(\\)`).test(text),
    );
  return lists && statDir ? ["stat feeds isDirectory() beside a readdir"] : [];
}

/** The ONE function per file allowed to hold a stat walker pattern (review r2: not the whole
 *  file), each with why. The rest of the file is still checked. */
const PATTERN_ALLOWED: Record<string, { readonly fn: string; readonly why: string }> = {
  // readAlRunnerCache lists ONE level of build folders by name; directoryBytes walks with walk.ts.
  "packages/runner/src/al-runner-cache.ts": {
    fn: "readAlRunnerCache",
    why: "one-level stat of named build folders",
  },
};

/** `text` without the top-level function `fn` (from its declaration to the next column-0 `}`).
 *  A missing function is a stale exemption: it throws. */
function withoutFunction(text: string, fn: string): string {
  const start = text.search(new RegExp(`\\bfunction ${fn}\\s*\\(`));
  const end = start < 0 ? -1 : text.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`walk-guard exemption names a missing function ${fn}`);
  return text.slice(0, start) + text.slice(end + 3);
}

describe("R631 walk guard: the detectors", () => {
  test("(a) flags recursive, options-variable and spread calls; passes one-level literal calls", () => {
    expect(recursiveReaddirs("await readdir(d, { recursive: true })")).toHaveLength(1);
    expect(recursiveReaddirs("readdirSync(d, opts)")).toHaveLength(1);
    expect(recursiveReaddirs("readdirSync(d, { ...opts })")).toHaveLength(1);
    expect(recursiveReaddirs("readdirSync(d)")).toEqual([]);
    expect(recursiveReaddirs("await readdir(d, { withFileTypes: true })")).toEqual([]);
  });

  test("(b) flags followSymlinks, dereference, node:fs glob and aliased imports; passes plain ones", () => {
    expect(linkFollowers('new Bun.Glob("**").scanSync({ cwd: d, followSymlinks: true })')).toEqual([
      "followSymlinks",
    ]);
    expect(linkFollowers("await cp(a, b, { recursive: true, dereference: true })")).toEqual([
      "dereference",
    ]);
    expect(linkFollowers('import { globSync } from "node:fs";')).toEqual(["node:fs glob"]);
    expect(linkFollowers("for await (const f of fsp.glob(p)) {}")).toHaveLength(1);
    expect(linkFollowers('import { readdir as rd } from "node:fs/promises";')).toEqual([
      "aliased readdir as rd",
    ]);
    expect(linkFollowers('import { statSync as st } from "node:fs";')).toHaveLength(1);
    expect(linkFollowers('new Bun.Glob("**").scanSync({ cwd: d })')).toEqual([]);
    expect(linkFollowers('import { readdir, lstat } from "node:fs/promises";')).toEqual([]);
  });

  test("(c) flags recursive, stack-based and class-method stat walkers; passes lstat ones", () => {
    const recursive =
      "const walk = (d: string): void => { for (const e of readdirSync(d)) { if (statSync(join(d, e)).isDirectory()) walk(join(d, e)); } };";
    const stack =
      "const st=[root]; while(st.length){const d=st.pop(); for(const e of readdirSync(d)) if(statSync(join(d,e)).isDirectory()) st.push(join(d,e));}";
    const method =
      "class W { async walk(d) { for (const e of await readdir(d)) { const s = await stat(join(d, e)); if (s.isDirectory()) await this.walk(join(d, e)); } } }";
    for (const t of [recursive, stack, method]) {
      expect(statWalkers(t)).toHaveLength(1);
      expect(
        statWalkers(
          t.replaceAll("statSync(", "lstatSync(").replaceAll("await stat(", "await lstat("),
        ),
      ).toEqual([]);
    }
  });

  test("comments do not count", () => {
    expect(recursiveReaddirs(code("// readdir(dir, { recursive: true })"))).toEqual([]);
    expect(linkFollowers(code("/* followSymlinks */"))).toEqual([]);
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
      const text = code(readFileSync(join(REPO, f), "utf8"));
      for (const h of recursiveReaddirs(text)) hits.push(`${f}: ${h}`);
      for (const h of linkFollowers(text)) hits.push(`${f}: ${h}`);
      const allowed = PATTERN_ALLOWED[f];
      const checked = allowed === undefined ? text : withoutFunction(text, allowed.fn);
      for (const h of statWalkers(checked)) hits.push(`${f}: ${h}`);
    }
    expect(hits).toEqual([]);
  });
});
