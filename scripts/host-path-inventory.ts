/**
 * Checks that every tracked file naming a host path is classified in
 * docs/kraken-move-inventory.md as operational, inert or historical.
 *
 *   bun scripts/host-path-inventory.ts
 *
 * Exit 0: every hit file is classified. Exit 1: some are not (listed), or the
 * inventory file is missing or has no rows (a check that reads nothing must not pass).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PathClass = "operational" | "inert" | "historical";

/** One source for `git grep -E` and for JS. Backslash and slash forms of each host root. */
// The MSYS forms (/h/, /u/Git) are anchored so a path like /x/h/y or a URL /u/ does not match.
export const HOST_PATH_SOURCE = String.raw`H:[\\/]|U:[\\/]Git|C:[\\/]Users|~/\.vscode|(^|[^A-Za-z0-9_.-])(/h/|/u/Git)`;

const norm = (p: string): string => p.replace(/\\/g, "/");

/** A file is classified by an exact row, or by a row ending in `/` that is a prefix of its path. */
function classOf(path: string, classes: Map<string, PathClass>): PathClass | undefined {
  const p = norm(path);
  const exact = classes.get(p);
  if (exact) return exact;
  for (const [row, cls] of classes) if (row.endsWith("/") && p.startsWith(row)) return cls;
  return undefined;
}

export function inventory(
  files: { path: string; text: string }[],
  classes: Map<string, PathClass>,
): { unclassified: string[]; hits: Map<string, number> } {
  const hits = new Map<string, number>();
  const unclassified: string[] = [];
  const re = new RegExp(HOST_PATH_SOURCE, "g");
  for (const f of files) {
    const n = f.text.match(re)?.length ?? 0;
    if (n === 0) continue;
    const path = norm(f.path);
    hits.set(path, n);
    if (!classOf(path, classes)) unclassified.push(path);
  }
  return { unclassified, hits };
}

/** Rows (files or directories) that no hit file matches any more. */
export function staleRows(hits: Map<string, number>, classes: Map<string, PathClass>): string[] {
  const paths = [...hits.keys()];
  return [...classes.keys()].filter((row) =>
    row.endsWith("/") ? !paths.some((p) => p.startsWith(row)) : !hits.has(row),
  );
}

/** Rows of `| path | class | note |`. Header, separator and prose lines are skipped. */
export function parseClasses(markdown: string): Map<string, PathClass> {
  const out = new Map<string, PathClass>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const path = (cells[1] ?? "").replace(/^`|`$/g, "");
    const cls = (cells[2] ?? "").replace(/^`|`$/g, "");
    if (path && (cls === "operational" || cls === "inert" || cls === "historical"))
      out.set(norm(path), cls);
  }
  return out;
}

async function main(): Promise<number> {
  const root = join(import.meta.dir, "..");
  const invPath = process.argv[2] ?? join(root, "docs", "kraken-move-inventory.md"); // argv[2]: tests only
  if (!existsSync(invPath)) {
    console.error(`host-path-inventory: ${invPath} is missing`);
    return 1;
  }
  const classes = parseClasses(readFileSync(invPath, "utf8"));
  if (classes.size === 0) {
    console.error(`host-path-inventory: ${invPath} has no classification rows`);
    return 1;
  }
  // -I skips binary files; -z gives NUL-separated paths so no quoting and no CRLF surprises.
  const proc = Bun.spawnSync(["git", "grep", "-I", "-l", "-z", "-E", "-e", HOST_PATH_SOURCE], {
    cwd: root,
  });
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    console.error(
      `host-path-inventory: git grep failed (${proc.exitCode}): ${proc.stderr.toString()}`,
    );
    return 1;
  }
  const paths = proc.stdout.toString().split("\0").filter(Boolean);
  // git grep reads the working tree, so a tracked file deleted there is never listed (pinned by test).
  const files = paths.map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const { unclassified, hits } = inventory(files, classes);
  const stale = staleRows(hits, classes);
  if (stale.length > 0) {
    console.error(`host-path-inventory: WARNING ${stale.length} stale row(s), no hits any more:`);
    for (const r of stale) console.error(`  ${r}`);
  }
  if (hits.size === 0) {
    console.error(
      "host-path-inventory: no hits at all; the grep is broken (this repo has hundreds)",
    );
    return 1;
  }
  if (unclassified.length > 0) {
    console.error(
      `host-path-inventory: ${unclassified.length} file(s) name a host path and are not classified:`,
    );
    for (const p of unclassified.sort()) console.error(`  ${p} (${hits.get(p)} hits)`);
    console.error(
      "Add a row to docs/kraken-move-inventory.md: | path | operational/inert/historical | note |",
    );
    return 1;
  }
  console.log(`host-path-inventory: ${hits.size} files with host paths, all classified`);
  return 0;
}

if (import.meta.main) process.exit(await main());
