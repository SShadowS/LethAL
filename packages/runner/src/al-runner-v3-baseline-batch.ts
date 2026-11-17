/**
 * PR-115 (R1106 part b): the pure parts of baseline batching. One daemon request runs up to
 * `BASELINE_BATCH_SIZE` test codeunits; everything else is left out of it by `excludeTests`. The
 * decode splits the one answer back into per-codeunit answers, or says why it cannot (the caller
 * then discards the whole answer and re-sends each codeunit alone). No IO here.
 */
import { maskAlNonCode } from "@lethal/engine";
import type { ServerCoverageFile } from "./al-runner-server";
import type { V3CoverageRead, V3PerTestCoverage } from "./al-runner-v3-sleep";

/** Measured on DO: +103 to +129 MiB of daemon memory per batch. */
export const BASELINE_BATCH_SIZE = 8;

/** The fields `requestBase` must never be given for a batch: they would pick, order or drive tests. */
export const BATCH_FORBIDDEN_FIELDS = [
  "test",
  "runSelectedOnly",
  "strictOrder",
  "testSuites",
  "testRunner",
  "testDriver",
] as const;

/** The body of a batch request: the lane's own session settings plus the exclusions and coverage. */
export function batchBody(
  base: Record<string, unknown>,
  excludeTests: readonly string[],
): Record<string, unknown> {
  return { ...base, excludeTests, coverage: true, perTestCoverage: true };
}

/**
 * The exclusion pattern for one codeunit. v3 matches `excludeTests` as a substring of
 * `Codeunit<id>.<method>`, so the trailing dot keeps `Codeunit1.` from hiding `Codeunit11`.
 */
export const exclusionOf = (id: number): string => `Codeunit${id}.`;

// ponytail: the header regex is discovery's (line-start `codeunit <id>`). Unguarded case: a codeunit whose
// header it misses AND that is Subtype=Test with a `trigger OnRun` and no tests would not be in
// `tests`/`onRun`: it stays out of `excludeTests` and its OnRun could run inside a batch. Discovery's
// "lost [Test] procedures" guard covers a header miss only when the codeunit has tests.
const HEADER = /^\s*codeunit\s+(\d+)(?=\s|")/gim;

/**
 * Every Subtype=Test codeunit, and every codeunit with a `trigger OnRun`, in any `#if` arm of these
 * sources (preprocessor lines are not code to the masker, so every arm is read). Comments and string
 * contents are masked first. A codeunit declared in two arms is both if either arm says so.
 */
export function scanTestCodeunits(sources: readonly string[]): {
  readonly tests: ReadonlySet<number>;
  readonly onRun: ReadonlySet<number>;
} {
  const tests = new Set<number>();
  const onRun = new Set<number>();
  for (const source of sources) {
    const masked = maskAlNonCode(source, { blankStringContents: true });
    const heads = Array.from(masked.matchAll(HEADER), (m) => ({ at: m.index, id: Number(m[1]) }));
    for (const [i, h] of heads.entries()) {
      const section = masked.slice(h.at, heads[i + 1]?.at ?? masked.length);
      if (/Subtype\s*=\s*Test\s*;/i.test(section)) tests.add(h.id);
      if (/\btrigger\s+OnRun\b/i.test(section)) onRun.add(h.id);
    }
  }
  return { tests, onRun };
}

/**
 * Splits `ids` (ascending) into the requests the fill sends. A group of two or more is a batch.
 * A codeunit with an OnRun, or one the scan did not find as a test codeunit, is alone. A batch whose
 * complement (every other test codeunit) would be empty goes singly too: an empty `excludeTests`
 * would exclude nothing.
 */
export function planBaselineBatches(
  ids: readonly number[],
  size: number,
  scan: { readonly tests: ReadonlySet<number>; readonly onRun: ReadonlySet<number> },
  suiteIds: readonly number[],
): number[][] {
  const everyTest = new Set<number>([...scan.tests, ...suiteIds]);
  const out: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const hidden = [...everyTest].filter((t) => !cur.includes(t));
    if (cur.length > 1 && hidden.length > 0) out.push(cur);
    else for (const id of cur) out.push([id]);
    cur = [];
  };
  for (const id of ids) {
    if (scan.onRun.has(id) || !scan.tests.has(id) || size < 2) {
      flush();
      out.push([id]);
      continue;
    }
    cur.push(id);
    if (cur.length >= size) flush();
  }
  flush();
  return out;
}

/** The exclusions of one batch: every test codeunit (scanned or in the suite) outside it, ascending. */
export function exclusionsFor(
  batch: readonly number[],
  scan: { readonly tests: ReadonlySet<number> },
  suiteIds: readonly number[],
): string[] {
  const inBatch = new Set(batch);
  return [...new Set<number>([...scan.tests, ...suiteIds])]
    .filter((id) => !inBatch.has(id))
    .sort((a, b) => a - b)
    .map(exclusionOf);
}

/** A top-level coverage list that is the union of these per-test lists (hits add up per file and line). */
export function unionCoverage(
  lists: readonly (readonly ServerCoverageFile[])[],
): ServerCoverageFile[] {
  const files = new Map<string, Map<number | undefined, { line?: number; hits: number }>>();
  for (const list of lists) {
    for (const f of list) {
      const lines = files.get(f.file) ?? new Map();
      files.set(f.file, lines);
      for (const s of f.statements ?? []) {
        const at = lines.get(s.line) ?? {
          ...(s.line !== undefined ? { line: s.line } : {}),
          hits: 0,
        };
        at.hits += s.hits ?? 0;
        lines.set(s.line, at);
      }
    }
  }
  return [...files].map(([file, lines]) => ({ file, statements: [...lines.values()] }));
}

interface RowLike {
  readonly codeunit: number;
  readonly name: string;
}

export type BatchDecode<R extends RowLike> =
  | {
      readonly ok: true;
      readonly byId: ReadonlyMap<number, { readonly rows: R[]; readonly coverage: V3CoverageRead }>;
    }
  | { readonly ok: false; readonly why: string };

/**
 * Steps 2 to 6 of the decode, in this order; the first failed check discards the whole answer.
 * The pre-row steps (dependency skip, seed, cached:false) are the caller's and run before this.
 * `isKept` is R612's rule for one row; `hasEveryRow` and `wanted` are the per-codeunit row check.
 */
export function decodeBatchAnswer<R extends RowLike>(a: {
  readonly ids: readonly number[];
  readonly rows: readonly R[];
  readonly coverage: V3CoverageRead;
  readonly isKept: (row: R) => boolean;
  readonly hasEveryRow: (rows: readonly R[], id: number) => boolean;
}): BatchDecode<R> {
  const inBatch = new Set(a.ids);
  const bad = (why: string): BatchDecode<R> => ({ ok: false, why });
  // 2. every row's codeunit is in the batch
  for (const r of a.rows)
    if (!inBatch.has(r.codeunit)) return bad(`a row of codeunit ${r.codeunit}, outside the batch`);
  // 3. no test name twice (scanned before R612's duplicate rule can throw)
  const names = new Set<string>();
  for (const r of a.rows) {
    const k = r.name.toLowerCase();
    if (names.has(k)) return bad(`test ${r.name} appears twice`);
    names.add(k);
  }
  // 4. every row is one R612 keeps
  for (const r of a.rows) if (!a.isKept(r)) return bad(`row ${r.name} is one R612 does not keep`);
  // 5. every per-test coverage entry names a row of the batch, and no row has two entries
  if (a.coverage.kind !== "doc") return bad(`coverage unavailable: ${a.coverage.why}`);
  const rowNames = new Set(a.rows.map((r) => r.name));
  const entryOf = new Map<string, V3PerTestCoverage>();
  for (const e of a.coverage.perTestCoverage) {
    if (!rowNames.has(e.test))
      return bad(`a coverage entry for ${e.test}, which is no row of the batch`);
    if (entryOf.has(e.test)) return bad(`two coverage entries for ${e.test}`);
    entryOf.set(e.test, e);
  }
  // 6. per codeunit: rows sliced by codeunit, entries by the exact row name
  const byId = new Map<number, { rows: R[]; coverage: V3CoverageRead }>();
  for (const id of a.ids) {
    const rows = a.rows.filter((r) => r.codeunit === id);
    if (!a.hasEveryRow(rows, id)) return bad(`codeunit ${id} lacks a row for one of its tests`);
    const own = rows
      .map((r) => entryOf.get(r.name))
      .filter((e): e is V3PerTestCoverage => e !== undefined);
    byId.set(id, {
      rows,
      coverage: {
        kind: "doc",
        coverage: unionCoverage(own.map((e) => e.coverage)),
        perTestCoverage: own,
      },
    });
  }
  return { ok: true, byId };
}
