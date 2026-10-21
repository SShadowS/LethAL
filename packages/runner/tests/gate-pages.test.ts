import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GATE_BASELINES, SYMBOL_BASELINES, parseGateBaseline } from "../itest/baseline-guard";
import {
  ALRUNNER_FIGURES,
  BCDEV_FIGURES,
  CHUNKED_FIGURES,
  ENVTOOL_FIGURES,
  HANG_FIGURES,
  TABLES_FIGURES,
} from "../itest/gate-expected";
import { EXPECTED as HARDEN_EXPECTED } from "../itest/harden-expected";
import { REPRODUCTION_EXPECTED } from "../itest/kill-reproduction";
import { EXPECTED_LAYOUT, LAYOUT_MAX_GUARDS } from "../itest/layout-fixture";
import { EXPECTED_MULTIOBJECT } from "../itest/multiobject-fixture";
import { NAMES_TABLE } from "../itest/names-fixture";
import { EXPECTED_BY_SET } from "../itest/symbol-fixture";
import { EXPECTED_WRAPPED, EXPECTED_WRAPPED_BC } from "../itest/wrapped-fixture";

/**
 * R-592: the frozen figures moved out of CLAUDE.md into `docs/gates/<gate>.md`. Each page carries
 * one ```json gate-figures block. This pins the block against the committed baselines, the
 * exported pre-committed tables, and the figures the itests read from `itest/gate-expected.ts`; it
 * pins the page's "Frozen figures" prose against the block; and it checks that every
 * `docs/....md` path CLAUDE.md names exists. Figures an itest still writes as a literal inside an
 * assertion sit under `notPinned` and are not checked here.
 */
const REPO = join(import.meta.dir, "..", "..", "..");
const PAGES = join(REPO, "docs", "gates");
const ITEST = join(REPO, "packages", "runner", "itest");
/** The file whose `docs/` links are checked. An override lets a proposed CLAUDE.md be checked too. */
const CLAUDE_MD = process.env.LETHAL_CLAUDE_MD_CHECK ?? join(REPO, "CLAUDE.md");

/** Dotted-path roots a page's `constants` may name. */
const CONSTANTS: Record<string, unknown> = {
  REPRODUCTION_EXPECTED,
  LAYOUT_MAX_GUARDS,
  NAMES_TABLE,
  BCDEV_FIGURES,
  ENVTOOL_FIGURES,
  ALRUNNER_FIGURES,
  TABLES_FIGURES,
  CHUNKED_FIGURES,
  HANG_FIGURES,
};

/** Baselines with an exported pre-committed table: its verdict counts must match the page too. */
const TABLES: Record<string, ReadonlyArray<{ readonly verdict: string }>> = {
  "al-runner.layout.baseline.json": EXPECTED_LAYOUT,
  "al-runner.multiobject.baseline.json": EXPECTED_MULTIOBJECT,
  "al-runner.symbols-lethala.baseline.json": EXPECTED_BY_SET["[LETHALA]"] ?? [],
  "al-runner.symbols-lethalb.baseline.json": EXPECTED_BY_SET["[LETHALB]"] ?? [],
  "al-runner.wrapped.baseline.json": EXPECTED_WRAPPED,
  "bcdev.wrapped.baseline.json": EXPECTED_WRAPPED_BC,
  "harden.baseline.json": HARDEN_EXPECTED,
};

interface FigureBlock {
  readonly gate: string;
  readonly baselines: Record<string, Record<string, number>>;
  readonly noBaseline?: string;
  readonly constants?: Record<string, unknown>;
}

function histogram(rows: ReadonlyArray<{ readonly verdict: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.verdict] = (out[r.verdict] ?? 0) + 1;
  return out;
}

const BLOCK = /^```json gate-figures\n([\s\S]*?)^```$/gm;

/** The single gate-figures block of a page, checked for shape. Throws on anything else. */
function figureBlock(page: string, text: string): FigureBlock {
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length !== 1) {
    throw new Error(`${page}: expected exactly one gate-figures block, found ${blocks.length}`);
  }
  const block = JSON.parse(blocks[0]?.[1] ?? "") as FigureBlock;
  const heading = /^# (\S+)/m.exec(text)?.[1];
  if (block.gate !== heading) {
    throw new Error(`${page}: block names gate ${block.gate}, page heading is ${heading}`);
  }
  if (typeof block.baselines !== "object" || block.baselines === null) {
    throw new Error(`${page}: block has no "baselines" object`);
  }
  const named = Object.keys(block.baselines).length;
  if (named === 0 && (typeof block.noBaseline !== "string" || block.noBaseline === "")) {
    throw new Error(`${page}: block names no baseline and gives no "noBaseline" reason`);
  }
  if (named > 0 && block.noBaseline !== undefined) {
    throw new Error(`${page}: block names baselines AND a "noBaseline" reason`);
  }
  return block;
}

/** Resolves `ROOT.a.b` against CONSTANTS; the first segment is the root, the rest are keys. */
function resolve(path: string): unknown {
  const root = Object.keys(CONSTANTS).find((k) => path === k || path.startsWith(`${k}.`));
  if (root === undefined) throw new Error(`no exported constant registered for "${path}"`);
  let cur: unknown = CONSTANTS[root];
  const rest = path.slice(root.length + 1);
  // Keys may contain "/" or "-" but not "."; `length` reads an array's length.
  for (const key of rest === "" ? [] : rest.split(".")) {
    if (cur === null || typeof cur !== "object") throw new Error(`"${path}" walks off at "${key}"`);
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === undefined) throw new Error(`"${path}" resolves to nothing`);
  return cur;
}

/**
 * The page's "## Frozen figures" section without the block: every `k / s / n` triple there must be
 * a killed / survived / no-coverage triple the block holds, and every "over N" one of its totals.
 */
function proseDrift(text: string, block: FigureBlock): string[] {
  const start = text.indexOf("\n## Frozen figures");
  if (start < 0) return ['no "## Frozen figures" section'];
  const next = text.indexOf("\n## ", start + 1);
  const prose = text
    .slice(start, next < 0 ? undefined : next)
    .replace(BLOCK, "")
    .replace(/\*\*/g, "");
  const triples = new Set<string>();
  const totals = new Set<number>();
  for (const h of Object.values(block.baselines)) {
    triples.add(`${h.killed ?? 0}/${h.survived ?? 0}/${h["no-coverage"] ?? 0}`);
    totals.add(Object.values(h).reduce((a, b) => a + b, 0));
  }
  const consts = block.constants ?? {};
  for (const key of Object.keys(consts)) {
    if (!key.endsWith(".killed")) continue;
    const base = key.slice(0, -".killed".length);
    const k = Number(consts[key]);
    const s = Number(consts[`${base}.survived`] ?? 0);
    const n = Number(consts[`${base}.noCoverage`] ?? 0);
    triples.add(`${k}/${s}/${n}`);
    totals.add(k + s + n);
  }
  const out: string[] = [];
  for (const m of prose.matchAll(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g)) {
    const t = `${m[1]}/${m[2]}/${m[3]}`;
    if (!triples.has(t))
      out.push(`prose states ${t}, which no baseline or figure in the block holds`);
  }
  for (const m of prose.matchAll(/\bover (\d+)\b/g)) {
    if (!totals.has(Number(m[1]))) out.push(`prose states "over ${m[1]}", which is no block total`);
  }
  return out;
}

const pages = readdirSync(PAGES)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort()
  .map((f) => {
    const text = readFileSync(join(PAGES, f), "utf8");
    return { page: f, text, block: figureBlock(f, text) };
  });

describe("docs/gates pages pin their frozen figures (R-592)", () => {
  test("there are pages to check", () => {
    expect(pages.length).toBeGreaterThanOrEqual(9);
  });

  test("every registered gate baseline is on exactly one page", () => {
    const seen = new Map<string, string[]>();
    for (const { page, block } of pages) {
      for (const b of Object.keys(block.baselines)) seen.set(b, [...(seen.get(b) ?? []), page]);
    }
    for (const b of [...Object.keys(GATE_BASELINES), ...SYMBOL_BASELINES]) {
      expect({ baseline: b, pages: seen.get(b) ?? [] }).toEqual({
        baseline: b,
        pages: [expect.any(String)],
      });
    }
  });

  for (const { page, text, block } of pages) {
    for (const [baseline, figures] of Object.entries(block.baselines)) {
      test(`${page}: ${baseline} matches the committed baseline`, () => {
        const path = join(ITEST, baseline);
        const parsed = parseGateBaseline(readFileSync(path, "utf8"), path, "R-592 pin test");
        expect(figures).toEqual(histogram(parsed.entries));
        const table = TABLES[baseline];
        if (table !== undefined) expect(figures).toEqual(histogram(table));
      });
    }
    for (const [path, value] of Object.entries(block.constants ?? {})) {
      test(`${page}: ${path} matches the exported constant`, () => {
        expect(value).toEqual(resolve(path));
      });
    }
    test(`${page}: the "Frozen figures" prose agrees with the block`, () => {
      expect(proseDrift(text, block)).toEqual([]);
    });
  }
});

describe("CLAUDE.md links", () => {
  test("every docs/ page CLAUDE.md names exists", () => {
    const text = readFileSync(CLAUDE_MD, "utf8");
    const missing = [...text.matchAll(/\bdocs\/[\w./-]+\.md\b/g)]
      .map((m) => m[0])
      .filter((p) => !existsSync(join(REPO, p)));
    expect(missing).toEqual([]);
  });
});

describe("figureBlock and proseDrift", () => {
  const one =
    '# g\n\n## Frozen figures\n\n```json gate-figures\n{"gate":"g","baselines":{"x.json":{"killed":3,"survived":12,"no-coverage":4}}}\n```\n';
  test("refuses no block, two blocks, a wrong gate, and no baseline without a reason", () => {
    expect(() => figureBlock("x.md", "# g\nno block")).toThrow("found 0");
    expect(figureBlock("x.md", one).gate).toBe("g");
    expect(() => figureBlock("x.md", one + one.slice(4))).toThrow("found 2");
    expect(() => figureBlock("x.md", one.replace("# g", "# h"))).toThrow("page heading is h");
    const empty = '# g\n```json gate-figures\n{"gate":"g","baselines":{}}\n```\n';
    expect(() => figureBlock("x.md", empty)).toThrow('no "noBaseline" reason');
    const reasoned = empty.replace("{}}", '{},"noBaseline":"why"}');
    expect(figureBlock("x.md", reasoned).noBaseline).toBe("why");
  });
  test("flags a prose triple or total the block does not hold, and passes the ones it does", () => {
    const block = figureBlock("x.md", one);
    expect(proseDrift(`${one}\n3 / 12 / 4 over 19`, block)).toEqual([]);
    expect(proseDrift(`${one}\n**301 / 68 / 18** over 387`, block)).toEqual([
      "prose states 301/68/18, which no baseline or figure in the block holds",
      'prose states "over 387", which is no block total',
    ]);
    expect(proseDrift(`${one}\n## History\n301 / 68 / 18`, block)).toEqual([]);
  });
});
