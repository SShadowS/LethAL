import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * PR-479 (479a, round 1): THE AUDIT. `packages/runner/docs/bcdev-client-audit.md` decides every line that names a
 * backend kind. This test fails when a site is added or removed without a row there, and it holds the experimental
 * pin: no file but `backend.ts` and the cli wiring writes the name `bcdev-client` as a quoted string.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const AUDIT = join(ROOT, "packages", "runner", "docs", "bcdev-client-audit.md");

const SITE_RE =
  /"bcdev"|"al-runner-v3"|\bisBcdev\(|\bisBcServer\(|\bisBcServerName\(|\bisBcdevClient\(|\bisLocalRunner\(|\bbackendSessionKind\b|\bBackendKind\b|\bBCDEV_CLIENT\b/;

const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "itest", "native"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
      out.push(p);
  }
}

/** Every non-test, non-comment line under `packages/*` and `scripts/` that names a backend kind. */
function scanSites(): { file: string; text: string }[] {
  const files: string[] = [];
  for (const d of readdirSync(join(ROOT, "packages"))) {
    const p = join(ROOT, "packages", d);
    if (statSync(p).isDirectory()) walk(p, files);
  }
  walk(join(ROOT, "scripts"), files);
  const sites: { file: string; text: string }[] = [];
  for (const f of files.sort()) {
    const rel = relative(ROOT, f).replaceAll("\\", "/");
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      if (SITE_RE.test(t)) sites.push({ file: rel, text: t });
    }
  }
  return sites;
}

interface Row {
  readonly file: string;
  readonly excerpt: string;
  readonly count: number;
  readonly decision: string;
}

/** The table's rows, in order. A `|` inside a cell is written `\|`. */
function parseAudit(md: string): Row[] {
  const rows: Row[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line
      .slice(1, line.lastIndexOf("|"))
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replaceAll("\\|", "|"));
    const [file, excerpt, countText, decision] = cells;
    if (file === undefined || file === "file" || file.startsWith("---")) continue;
    if (excerpt === undefined || countText === undefined || decision === undefined) {
      throw new Error(`audit row has too few cells: ${line}`);
    }
    if (!/^\d+$/.test(countText)) throw new Error(`audit row has no count: ${line}`);
    rows.push({ file, excerpt, count: Number(countText), decision });
  }
  return rows;
}

/** Match each site to the FIRST row of its file whose excerpt it contains. Returns what did not fit. */
function matchAudit(
  sites: readonly { file: string; text: string }[],
  rows: readonly Row[],
): { unclaimed: string[]; countMismatch: string[] } {
  const claimed = rows.map(() => 0);
  const unclaimed: string[] = [];
  for (const s of sites) {
    const i = rows.findIndex((r) => r.file === s.file && s.text.includes(r.excerpt));
    if (i < 0) unclaimed.push(`${s.file}: ${s.text.slice(0, 120)}`);
    else claimed[i] = (claimed[i] ?? 0) + 1;
  }
  const countMismatch: string[] = [];
  rows.forEach((r, i) => {
    if ((claimed[i] ?? 0) !== r.count)
      countMismatch.push(`${r.file} [${r.excerpt}]: table says ${r.count}, found ${claimed[i]}`);
  });
  return { unclaimed, countMismatch };
}

const DECISION_RE = /^(same-as-bcdev|new-arm|off|unreachable|refuse:[A-Za-z0-9_-]+)$/;

describe("PR-479: the bcdev-client audit table", () => {
  const rows = parseAudit(readFileSync(AUDIT, "utf8"));
  const sites = scanSites();

  test("the table is not empty and every decision is one of the named kinds", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => !DECISION_RE.test(r.decision)).map((r) => r.decision)).toEqual([]);
  });

  test("every site in the source is decided by a row, and every row's count is exact", () => {
    const { unclaimed, countMismatch } = matchAudit(sites, rows);
    expect(unclaimed).toEqual([]);
    expect(countMismatch).toEqual([]);
  });

  // The test must be able to fail: a new literal site, or a row with no site, is caught.
  test("red direction 1: an extra site the table does not list is unclaimed", () => {
    const extra = {
      file: "packages/runner/src/orchestrator.ts",
      text: 'if (kind === "bcdev") x();',
    };
    const { unclaimed } = matchAudit([...sites, extra], rows);
    expect(unclaimed).toEqual([`${extra.file}: ${extra.text}`]);
  });

  test("red direction 2: a site that vanished leaves a row with a wrong count", () => {
    const [first, ...rest] = sites;
    if (first === undefined) throw new Error("no sites found");
    const { countMismatch } = matchAudit(rest, rows);
    expect(countMismatch.length).toBeGreaterThan(0);
  });
});

describe("PR-479: no default or caller names bcdev-client", () => {
  const QUOTED = /["'`]bcdev-client["'`]/;
  // The one file that writes the name, and the cli wiring that parses `--backend`.
  const ALLOWED = new Set(["packages/runner/src/backend.ts", "packages/runner/src/cli.ts"]);

  function scanQuoted(): string[] {
    const files: string[] = [];
    for (const d of readdirSync(join(ROOT, "packages"))) {
      const p = join(ROOT, "packages", d);
      if (statSync(p).isDirectory()) walkAll(p, files);
    }
    walkAll(join(ROOT, "scripts"), files);
    const hits: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replaceAll("\\", "/");
      if (ALLOWED.has(rel)) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          if (QUOTED.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    return hits;
  }

  // Includes itest/ (the gate legs) but not test files, which may name it to test it.
  function walkAll(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "native") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkAll(p, out);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
        out.push(p);
    }
  }

  test("no non-test file but backend.ts and the cli wiring writes the quoted name", () => {
    expect(scanQuoted()).toEqual([]);
  });

  test("the cli wiring and backend.ts do write it (the scan sees something to allow)", () => {
    const backend = readFileSync(join(ROOT, "packages/runner/src/backend.ts"), "utf8");
    const cli = readFileSync(join(ROOT, "packages/runner/src/cli.ts"), "utf8");
    expect(QUOTED.test(backend)).toBe(true);
    expect(QUOTED.test(cli)).toBe(true);
  });
});
