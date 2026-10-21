import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GATE_BASELINES, SYMBOL_BASELINES, parseGateBaseline } from "../itest/baseline-guard";
import { EXPECTED as HARDEN_EXPECTED } from "../itest/harden-expected";
import { REPRODUCTION_EXPECTED } from "../itest/kill-reproduction";
import { EXPECTED_LAYOUT, LAYOUT_MAX_GUARDS } from "../itest/layout-fixture";
import { EXPECTED_MULTIOBJECT } from "../itest/multiobject-fixture";
import { NAMES_TABLE } from "../itest/names-fixture";
import { EXPECTED_BY_SET } from "../itest/symbol-fixture";
import { EXPECTED_WRAPPED, EXPECTED_WRAPPED_BC } from "../itest/wrapped-fixture";

/**
 * R-592: the frozen figures moved out of CLAUDE.md into `docs/gates/<gate>.md`. Each page carries
 * one ```json gate-figures block; this pins it against the committed baselines and the exported
 * constants, so a re-recorded baseline cannot leave its page stale. Figures that live only in an
 * itest's unexported `EXPECTED` (importing an itest runs its gate, R186) sit under `notPinned` and
 * are not checked here.
 */
const REPO = join(import.meta.dir, "..", "..", "..");
const PAGES = join(REPO, "docs", "gates");
const ITEST = join(REPO, "packages", "runner", "itest");

/** Dotted-path roots a page's `constants` may name. */
const CONSTANTS: Record<string, unknown> = {
  REPRODUCTION_EXPECTED,
  LAYOUT_MAX_GUARDS,
  NAMES_TABLE,
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
  readonly constants?: Record<string, unknown>;
}

function histogram(rows: ReadonlyArray<{ readonly verdict: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.verdict] = (out[r.verdict] ?? 0) + 1;
  return out;
}

/** The single ```json gate-figures block of a page. Throws on none or several. */
function figureBlock(page: string, text: string): FigureBlock {
  const blocks = [...text.matchAll(/^```json gate-figures\n([\s\S]*?)^```$/gm)];
  if (blocks.length !== 1) {
    throw new Error(`${page}: expected exactly one gate-figures block, found ${blocks.length}`);
  }
  const body = blocks[0]?.[1];
  if (body === undefined) throw new Error(`${page}: empty gate-figures block`);
  return JSON.parse(body) as FigureBlock;
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

const pages = readdirSync(PAGES)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort()
  .map((f) => ({ page: f, block: figureBlock(f, readFileSync(join(PAGES, f), "utf8")) }));

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

  for (const { page, block } of pages) {
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
  }
});

describe("figureBlock", () => {
  test("refuses a page with no block, and one with two", () => {
    expect(() => figureBlock("x.md", "no block")).toThrow("found 0");
    const one = '```json gate-figures\n{"gate":"g","baselines":{}}\n```\n';
    expect(figureBlock("x.md", one).gate).toBe("g");
    expect(() => figureBlock("x.md", one + one)).toThrow("found 2");
  });
});
