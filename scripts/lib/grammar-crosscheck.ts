/**
 * The comparison half of the issue #6 grammar cross-check (`scripts/probe-grammar-crosscheck.ts`),
 * kept apart from the CLI so it can be unit tested. No top-level body: importing this runs nothing.
 *
 * Scope, stated so no output overstates it: agreement here means agreement on the six audited
 * families and the two context probes, on files BOTH parsers read cleanly. Nothing more.
 */
import type { parseALWasm as parseAL } from "../../packages/engine/src/ast/parser-wasm";

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
 * The dump must name exactly the files it was given: one `file` record per listed path, none
 * missing, none extra, none twice, and every parse-error file among them. A count alone cannot say
 * this (the summary's `fileCount` is the LIST's length), and a skipped file would otherwise read as
 * a file whose every tree-sitter site is an over-claim, or be dropped silently. A file the compiler
 * could not parse at all still writes its record, emits no nodes, and is named in
 * `parseErrorFiles`, so it is accounted for here and excluded as unhealthy by the caller. Paths are
 * compared as given; the caller normalises both sides the same way first.
 */
export function assertDumpCoversList(
  listed: readonly string[],
  dump: Pick<DumpSummary, "files" | "fileCount" | "parseErrorFiles">,
): void {
  const want = new Set(listed);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const f of dump.files) {
    if (seen.has(f)) problems.push(`recorded twice: ${f}`);
    else if (!want.has(f)) problems.push(`not in the list: ${f}`);
    seen.add(f);
  }
  for (const f of listed) if (!seen.has(f)) problems.push(`no file record: ${f}`);
  for (const f of dump.parseErrorFiles) {
    if (!want.has(f)) problems.push(`parse-error file not in the list: ${f}`);
  }
  if (dump.fileCount !== listed.length) {
    problems.push(`summary fileCount ${dump.fileCount}, listed ${listed.length}`);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 20).join("\n  ");
    const more = problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : "";
    throw new Error(`compiler dump does not cover the file list:\n  ${shown}${more}`);
  }
}

/** Keys that occur more than once, each named once. */
function duplicateKeys(sites: readonly Site[], key: (s: Site) => string): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const s of sites) {
    const k = key(s);
    if (seen.has(k)) dups.add(k);
    seen.add(k);
  }
  return [...dups];
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
  const [first] = duplicateKeys(sites, key);
  if (first !== undefined) throw new Error(`${side}: duplicate key ${first}`);
}

/**
 * The duplicate-key guard, applied AFTER the health filter (pre-commitment R1/R5: an unhealthy file
 * never changes the outcome). A duplicate in a comparable file throws, as `assertUniqueKeys` does;
 * one in an excluded file is error recovery's output, not evidence, and comes back as a warning.
 */
export function checkContextKeys(
  sites: readonly Site[],
  comparable: ReadonlySet<string>,
  key: (s: Site) => string,
  side: string,
): string[] {
  assertUniqueKeys(restrictToComparable(sites, comparable), key, side);
  const excluded = sites.filter((s) => !comparable.has(s.file));
  return duplicateKeys(excluded, key).map(
    (k) => `WARNING: ${side}: duplicate key ${k} in an excluded file, ignored`,
  );
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

/** One syntax node from `dump-compiler-kinds.ps1`, attributed to the `file` record before it. */
export interface DumpNode {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly parent: string;
}
/** The dump's LAST record. Its absence means the dump was cut short. */
export interface DumpSummary {
  readonly parserVersion: string;
  readonly fileCount: number;
  readonly parseErrorFiles: string[];
  /** Every `file` record's path, in dump order. Checked against the list by `assertDumpCoversList`. */
  readonly files: string[];
}

/**
 * Reads the NDJSON that `dump-compiler-kinds.ps1` writes (record shape in its header), one line at
 * a time so memory does not grow with the corpus. Calls `onNode` per node, in file order, and
 * returns the summary. Throws on a missing summary: a truncated dump must never read as a smaller
 * corpus. Also throws on a node before any file record, a record after the summary, or an unknown
 * record type.
 */
export async function readCompilerDump(
  lines: AsyncIterable<string> | Iterable<string>,
  onNode: (file: string, node: DumpNode) => void,
): Promise<DumpSummary> {
  let file: string | undefined;
  let summary: DumpSummary | undefined;
  const files: string[] = [];
  let lineNo = 0;
  const bad = (what: string): Error => new Error(`compiler dump line ${lineNo}: ${what}`);
  for await (const line of lines) {
    lineNo++;
    if (line === "") continue;
    if (summary !== undefined) throw bad("record after the summary");
    const r = JSON.parse(line) as Record<string, unknown>;
    if (r.t === "file" && typeof r.path === "string") {
      file = r.path;
      files.push(r.path);
    } else if (r.t === "node") {
      if (file === undefined) throw bad("node before any file record");
      const { kind, start, end, parent } = r;
      if (
        typeof kind !== "string" ||
        typeof start !== "number" ||
        typeof end !== "number" ||
        typeof parent !== "string"
      ) {
        throw bad("malformed node record");
      }
      onNode(file, { kind, start, end, parent });
    } else if (r.t === "summary") {
      const { parserVersion, fileCount, parseErrorFiles } = r;
      if (
        typeof parserVersion !== "string" ||
        typeof fileCount !== "number" ||
        !Array.isArray(parseErrorFiles) ||
        !parseErrorFiles.every((f) => typeof f === "string")
      ) {
        throw bad("malformed summary record");
      }
      summary = { parserVersion, fileCount, parseErrorFiles, files };
    } else {
      throw bad(`unknown record ${line.slice(0, 80)}`);
    }
  }
  if (summary === undefined) {
    throw new Error(
      `compiler dump has no summary record after ${lineNo} line(s): truncated, refusing to read it as a complete corpus`,
    );
  }
  return summary;
}
