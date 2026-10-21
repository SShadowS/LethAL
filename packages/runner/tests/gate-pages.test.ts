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

/** One set of verdict counts a page may quote: a baseline's histogram, or a constants triple. */
type Counts = Record<string, number>;

const VERDICT_WORDS = ["killed", "survived", "no-coverage", "timeout-killed"] as const;

/** The block's count sets: one per baseline (keyed by file), plus each `<X>.killed` constants triple. */
function countSources(block: FigureBlock): Map<string, Counts> {
  const out = new Map<string, Counts>(Object.entries(block.baselines));
  const consts = block.constants ?? {};
  for (const key of Object.keys(consts)) {
    if (!key.endsWith(".killed")) continue;
    const base = key.slice(0, -".killed".length);
    out.set(base, {
      killed: Number(consts[key]),
      survived: Number(consts[`${base}.survived`] ?? 0),
      "no-coverage": Number(consts[`${base}.noCoverage`] ?? 0),
    });
  }
  return out;
}

const total = (c: Counts): number => Object.values(c).reduce((a, b) => a + b, 0);

/**
 * The page's "## Frozen figures" prose (the block removed), checked piece by piece (a bullet or a
 * paragraph). Every count it states must be one the block holds:
 *   - a `k / s / n` triple must be one source's killed / survived / no-coverage;
 *   - "over N" must be one source's total;
 *   - "N killed", "N survived", "N no-coverage", "N timeout-killed" must be that verdict's count in
 *     a source;
 *   - "`name` is N" must equal a numeric `constants` figure whose path ends in `name`.
 * On a page with several baselines, a piece that states counts must name exactly one baseline file,
 * and is checked against that baseline alone, so one leg cannot quote another leg's figures.
 */
function proseDrift(text: string, block: FigureBlock): string[] {
  const start = text.indexOf("\n## Frozen figures");
  if (start < 0) return ['no "## Frozen figures" section'];
  const next = text.indexOf("\n## ", start + 1);
  const prose = text
    .slice(start, next < 0 ? undefined : next)
    .replace(BLOCK, "")
    .replace(/\*\*/g, "");
  const all = countSources(block);
  const several = Object.keys(block.baselines).length > 1;
  const consts = block.constants ?? {};
  const out: string[] = [];
  for (const piece of prose.split(/\n(?=- )|\n\s*\n/)) {
    const flat = piece.replace(/\s+/g, " ").trim();
    const triples = [...flat.matchAll(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g)];
    const overs = [...flat.matchAll(/\bover (\d+)\b/g)];
    const words = [...flat.matchAll(/\b(\d+) (killed|survived|no-coverage|timeout-killed)\b/g)];
    let sources = [...all.values()];
    if (several && triples.length + overs.length + words.length > 0) {
      const named = Object.keys(block.baselines).filter((b) => flat.includes(b));
      const only = named.length === 1 ? named[0] : undefined;
      const counts = only === undefined ? undefined : block.baselines[only];
      if (counts === undefined) {
        out.push(`"${flat.slice(0, 60)}..." states counts but names ${named.length} baselines`);
        continue;
      }
      sources = [counts];
    }
    for (const m of triples) {
      const t = `${m[1]}/${m[2]}/${m[3]}`;
      const hit = sources.some(
        (c) => `${c.killed ?? 0}/${c.survived ?? 0}/${c["no-coverage"] ?? 0}` === t,
      );
      if (!hit) out.push(`prose states ${t}, which no baseline or figure in the block holds`);
    }
    for (const m of overs) {
      if (!sources.some((c) => total(c) === Number(m[1])))
        out.push(`prose states "over ${m[1]}", which is no block total`);
    }
    for (const m of words) {
      const verdict = m[2] as (typeof VERDICT_WORDS)[number];
      if (!sources.some((c) => (c[verdict] ?? 0) === Number(m[1])))
        out.push(
          `prose states "${m[1]} ${verdict}", which no baseline or figure in the block holds`,
        );
    }
    for (const m of flat.matchAll(/`(\w+)` is (\d+)\b/g)) {
      const keys = Object.keys(consts).filter((k) => k === m[1] || k.endsWith(`.${m[1]}`));
      const numeric = keys.filter((k) => typeof consts[k] === "number");
      if (numeric.length === 0)
        out.push(
          `prose states "\`${m[1]}\` is ${m[2]}", but the block pins no number named ${m[1]}`,
        );
      else if (!numeric.some((k) => consts[k] === Number(m[2])))
        out.push(`prose states "\`${m[1]}\` is ${m[2]}", which differs from the block`);
    }
  }
  return out;
}

/** Every leaf path of an object: `a.b.c` for each non-object value (arrays count as leaves). */
function leaves(value: unknown, prefix: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, `${prefix}.${k}`),
  );
}

/** gate-expected.ts export -> the baseline whose verdict counts it restates. */
const FIGURES_BASELINE: Record<string, readonly [string, Readonly<Record<string, unknown>>]> = {
  BCDEV_FIGURES: ["bcdev.baseline.json", BCDEV_FIGURES],
  ENVTOOL_FIGURES: ["envtool.baseline.json", ENVTOOL_FIGURES],
  ALRUNNER_FIGURES: ["al-runner.baseline.json", ALRUNNER_FIGURES],
  TABLES_FIGURES: ["tables.baseline.json", TABLES_FIGURES],
};

/** Each itest gate-expected.ts serves, and the export it must read. */
const ITEST_FIGURES: Record<string, string> = {
  "bcdev.itest.ts": "BCDEV_FIGURES",
  "envtool.itest.ts": "ENVTOOL_FIGURES",
  "al-runner.itest.ts": "ALRUNNER_FIGURES",
  "tables.itest.ts": "TABLES_FIGURES",
  "chunked.itest.ts": "CHUNKED_FIGURES",
  "hang.itest.ts": "HANG_FIGURES",
};

/** A figure an itest restates as a literal instead of reading it from gate-expected.ts. */
const RESTATED =
  /^\s+(killed|survived|noCoverage|timeoutKilled|groupedCalls|warmKills|totalMutantSites|platformArtifactKills|untargetedTriggerCount|assertionScreenDiscrimination):\s*[\d"]|^const (BUDGET_MS|EXPECTED_WARM_KILLS|EXPECTED_COLD_CONFIRMS_\w+|EXPECTED_NO_COVERAGE_FILE|CONTROL)\s*=\s*[\d"{]/gm;

/** The literal restatements in an itest's source, `[]` when it reads every figure from the module. */
function restatedFigures(source: string, exportName: string): string[] {
  const out = [...source.matchAll(RESTATED)].map((m) => m[0].trim());
  if (!/from "\.\/gate-expected"/.test(source) || !source.includes(`${exportName}.`))
    out.push(`does not read ${exportName} from ./gate-expected`);
  return out;
}

/** Pages under docs/gates that describe no single gate, so carry no figure block. */
const NOT_GATE_PAGES = new Set(["README.md", "servers.md"]);

const pages = readdirSync(PAGES)
  .filter((f) => f.endsWith(".md") && !NOT_GATE_PAGES.has(f))
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

describe("itest/gate-expected.ts (R-592)", () => {
  for (const [name, [baseline, figures]] of Object.entries(FIGURES_BASELINE)) {
    test(`${name}'s counts equal ${baseline}`, () => {
      const path = join(ITEST, baseline);
      const rows = parseGateBaseline(readFileSync(path, "utf8"), path, "R-592 pin test").entries;
      const h = histogram(rows);
      expect({
        killed: figures.killed,
        survived: figures.survived,
        noCoverage: figures.noCoverage,
        total: Number(figures.killed) + Number(figures.survived) + Number(figures.noCoverage),
      }).toEqual({
        killed: h.killed ?? 0,
        survived: h.survived ?? 0,
        noCoverage: h["no-coverage"] ?? 0,
        total: rows.length,
      });
    });
  }

  test("every figure in it is named by some page's block", () => {
    const named = pages.flatMap(({ block }) => Object.keys(block.constants ?? {}));
    const exports: Record<string, unknown> = {
      BCDEV_FIGURES,
      ENVTOOL_FIGURES,
      ALRUNNER_FIGURES,
      TABLES_FIGURES,
      CHUNKED_FIGURES,
      HANG_FIGURES,
    };
    const unnamed = Object.entries(exports)
      .flatMap(([name, value]) => leaves(value, name))
      .filter((leaf) => !named.some((n) => leaf === n || leaf.startsWith(`${n}.`)));
    expect(unnamed).toEqual([]);
  });

  for (const [file, exportName] of Object.entries(ITEST_FIGURES)) {
    test(`${file} reads ${exportName} and restates no figure as a literal`, () => {
      expect(restatedFigures(readFileSync(join(ITEST, file), "utf8"), exportName)).toEqual([]);
    });
  }

  test("restatedFigures flags a literal and a missing import, and passes a reference", () => {
    const ok =
      'import { X_FIGURES } from "./gate-expected";\nconst E = {\n  killed: X_FIGURES.killed,\n  survived: X_FIGURES.survived,\n};';
    expect(restatedFigures(ok, "X_FIGURES")).toEqual([]);
    expect(restatedFigures(ok.replace("X_FIGURES.killed", "3"), "X_FIGURES")).toEqual([
      "killed: 3",
    ]);
    expect(restatedFigures("const BUDGET_MS = 20_000;", "X_FIGURES")).toEqual([
      "const BUDGET_MS = 2",
      "does not read X_FIGURES from ./gate-expected",
    ]);
  });
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
  test("checks counts written in words, both ways", () => {
    const block = figureBlock("x.md", one);
    expect(proseDrift(`${one}\n3 killed, 12 survived and 4 no-coverage.`, block)).toEqual([]);
    expect(proseDrift(`${one}\n16 killed and 5 survived.`, block)).toEqual([
      'prose states "16 killed", which no baseline or figure in the block holds',
      'prose states "5 survived", which no baseline or figure in the block holds',
    ]);
  });
  test("checks a named single figure against the block's constants, both ways", () => {
    const withConst = one.replace(
      "}}}\n```",
      '}},"constants":{"T_FIGURES.groupedCalls":399}}\n```',
    );
    const block = figureBlock("x.md", withConst);
    expect(proseDrift(`${withConst}\n\`groupedCalls\` is 399.`, block)).toEqual([]);
    expect(proseDrift(`${withConst}\n\`groupedCalls\` is 382.`, block)).toEqual([
      'prose states "`groupedCalls` is 382", which differs from the block',
    ]);
    expect(proseDrift(`${withConst}\n\`warmKills\` is 13.`, block)).toEqual([
      'prose states "`warmKills` is 13", but the block pins no number named warmKills',
    ]);
  });
  test("on a page with several baselines, checks each piece against the baseline it names", () => {
    const two =
      '# g\n\n## Frozen figures\n\n```json gate-figures\n{"gate":"g","baselines":{"a.json":{"killed":3,"survived":12,"no-coverage":4},"b.json":{"killed":5,"survived":4}}}\n```\n';
    const block = figureBlock("x.md", two);
    expect(
      proseDrift(
        `${two}\n- Leg A (\`a.json\`): 3 / 12 / 4.\n- Leg B (\`b.json\`): 5 / 4 / 0.`,
        block,
      ),
    ).toEqual([]);
    expect(proseDrift(`${two}\n- Leg A (\`a.json\`): 5 / 4 / 0.`, block)).toEqual([
      "prose states 5/4/0, which no baseline or figure in the block holds",
    ]);
    expect(proseDrift(`${two}\n- Leg A: 3 / 12 / 4.`, block)).toEqual([
      '"- Leg A: 3 / 12 / 4...." states counts but names 0 baselines',
    ]);
  });
});
