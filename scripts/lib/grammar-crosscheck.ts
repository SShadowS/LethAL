/**
 * The comparison half of the issue #6 grammar cross-check (`scripts/probe-grammar-crosscheck.ts`),
 * kept apart from the CLI so it can be unit tested. No top-level body: importing this runs nothing.
 *
 * Scope, stated so no output overstates it: agreement here means agreement on the six audited
 * families and the two context probes, on files BOTH parsers read cleanly. Nothing more.
 */
import type { parseAL } from "../../packages/engine/src/ast/parser";

export interface Site {
  readonly file: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}
export type Span = readonly [start: number, end: number];
export interface Delta {
  readonly site: Site;
  readonly treeSitter: number;
  readonly compiler: number;
}
export interface Split {
  readonly guarded: Delta[];
  readonly explained: Delta[];
  readonly unexplained: Delta[];
}
export interface SiteDiff {
  readonly onlyCompiler: Split;
  readonly onlyTreeSitter: Split;
}
export interface DiffOptions {
  readonly guardedSpans: ReadonlyMap<string, readonly Span[]>;
  readonly explained?: ReadonlySet<string>;
  readonly key?: (s: Site) => string;
}

/** Includes `end`: `A + B + C` nests two same-kind nodes that share a start (see 7c7d7a3). */
export const siteKey = (s: Site): string => `${s.file}|${s.kind}|${s.start}|${s.end}`;

/**
 * For context probes. No `end`: the compiler's statement span includes the trailing `;` and
 * tree-sitter's does not (measured). Two statement-position sites of one probe never share a start.
 */
export const contextKey = (s: Site): string => `${s.file}|${s.kind}|${s.start}`;

/** Drop every site in a file either parser could not read cleanly, on BOTH sides, before diffing. */
export function restrictToComparable(
  sites: readonly Site[],
  comparable: ReadonlySet<string>,
): Site[] {
  return sites.filter((s) => comparable.has(s.file));
}

/**
 * Multiset difference by key, split by direction. A delta inside a tree-sitter directive span is
 * `guarded` (R214), in either direction; else one whose key is in `explained` is `explained`; else
 * `unexplained`. A directive guards its span only, never the rest of its file.
 */
export function diffSites(ts: readonly Site[], cc: readonly Site[], opts: DiffOptions): SiteDiff {
  const keyOf = opts.key ?? siteKey;
  const counts = new Map<string, { site: Site; ts: number; cc: number }>();
  const bump = (s: Site, side: "ts" | "cc"): void => {
    const k = keyOf(s);
    const row = counts.get(k) ?? { site: s, ts: 0, cc: 0 };
    row[side]++;
    counts.set(k, row);
  };
  for (const s of ts) bump(s, "ts");
  for (const s of cc) bump(s, "cc");
  const inSpan = (s: Site): boolean =>
    (opts.guardedSpans.get(s.file) ?? []).some(([a, b]) => a <= s.start && s.end <= b);
  const out: SiteDiff = {
    onlyCompiler: { guarded: [], explained: [], unexplained: [] },
    onlyTreeSitter: { guarded: [], explained: [], unexplained: [] },
  };
  for (const [k, { site, ts: a, cc: b }] of counts) {
    if (a === b) continue;
    const split = b > a ? out.onlyCompiler : out.onlyTreeSitter;
    const bucket = inSpan(site)
      ? split.guarded
      : opts.explained?.has(k) === true
        ? split.explained
        : split.unexplained;
    bucket.push({ site, treeSitter: a, compiler: b });
  }
  return out;
}

/**
 * Throws when one side has two sites with the same key. Guards `contextKey`'s assumption that two
 * statement-position sites of one probe never share a start. If it ever fails, stop and look.
 */
export function assertUniqueKeys(
  sites: readonly Site[],
  key: (s: Site) => string,
  side: string,
): void {
  const seen = new Set<string>();
  for (const s of sites) {
    const k = key(s);
    if (seen.has(k)) throw new Error(`${side}: duplicate key ${k}`);
    seen.add(k);
  }
}

export type Verdict = "agree" | "disagree" | "unruled-mapping" | "inconclusive";
export const EXIT_CODE: Readonly<Record<Verdict, number>> = {
  agree: 0,
  disagree: 1,
  inconclusive: 2,
  "unruled-mapping": 3,
};

/**
 * The ONE verdict rule. Order matters: no comparable file, then an unruled mapping, then any delta.
 * Parse health is deliberately not an input: it is a warning, reported beside the verdict.
 */
export function verdict(input: {
  readonly comparableFiles: number;
  readonly diffs: readonly SiteDiff[];
  readonly unruledKinds: number;
}): Verdict {
  if (input.comparableFiles === 0) return "inconclusive";
  if (input.unruledKinds > 0) return "unruled-mapping";
  const any = input.diffs.some((d) =>
    [d.onlyCompiler, d.onlyTreeSitter].some(
      (s) => s.guarded.length + s.explained.length + s.unexplained.length > 0,
    ),
  );
  return any ? "disagree" : "agree";
}

/**
 * `--json <out>` may sit anywhere. Without it the args come back UNCHANGED: filtering on index
 * `jsonAt` when it is -1 would drop argument 0, the target (review r2).
 */
export function splitArgs(args: readonly string[]): {
  positional: string[];
  jsonOut: string | undefined;
} {
  const jsonAt = args.indexOf("--json");
  if (jsonAt < 0) return { positional: [...args], jsonOut: undefined };
  const jsonOut = args[jsonAt + 1];
  if (jsonOut === undefined || jsonOut === "") throw new Error("--json needs a path");
  return { positional: args.filter((_, i) => i !== jsonAt && i !== jsonAt + 1), jsonOut };
}

export type TsNode = ReturnType<typeof parseAL>["rootNode"];
export interface ParseHealth {
  readonly errorNodes: number;
  readonly missingNodes: number;
}

/**
 * ERROR and MISSING node counts. A MISSING node is NOT named "MISSING": it carries the type of the
 * token it stands in for (`)`, `}`), so only `isMissing` finds it.
 */
export function parseHealth(root: TsNode): ParseHealth {
  if (!root.hasError) return { errorNodes: 0, missingNodes: 0 };
  let errorNodes = 0;
  let missingNodes = 0;
  const walk = (n: TsNode): void => {
    if (n.type === "ERROR") errorNodes++;
    if (n.isMissing) missingNodes++;
    for (const c of n.children) if (c !== null) walk(c);
  };
  walk(root);
  return { errorNodes, missingNodes };
}
