import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import {
  type TierResolver,
  assignMutantIds,
  buildComponents,
  compileSchemataForFile,
  dedupeSpecs,
} from "@lethal/schemata";

/**
 * R826: when one mutant's statement holds others, they share one guard chain and each branch repeats
 * the statement's text, so one emitted method grows with the square. R827 made a body's `empty-block` a
 * guard unless the body holds a directive. R828 O1: a statement with its own mutants (an `if`
 * condition, a `case` arm) now copies only itself, and what sits inside it is its own component. What
 * is left is a loop (everything inside it is one flat chain, and a body's `empty-block` makes each loop
 * in it one) and a statement holding a directive. GitHub #28's 907-guard
 * file stopped a BC service tier with a stack overflow, and a very large method is the lead suspect.
 * That is an inference: no crash has been measured here.
 *
 * R875: the warning reads the REAL emitted text, not an estimate. This figure is NOT a measured limit.
 * It was chosen to fire on the outliers of real code: 24 of 986 DC and DO files have a method this
 * large (2026-11-08, `/coord/handoff/R-826-check/`). It warns, and never refuses.
 */
export const LARGE_METHOD_BYTES = 512 * 1024;

/**
 * R875: what one guard adds to the emitted file beyond the root text it copies: its `if` and the
 * marker. Measured on the same 986 files: at most 199 bytes, file overhead included. With this, a file
 * whose bound is under `LARGE_METHOD_BYTES` holds no method that large, and is not emitted here.
 */
export const BOUND_BYTES_PER_GUARD = 512;

export interface LargeMethod {
  readonly path: string;
  /** The most mutants in one chain: for the reader, not the decision. */
  readonly chain: number;
  /** The largest procedure or trigger in the emitted text, header to next header. */
  readonly methodBytes: number;
}

/** The largest procedure or trigger in emitted AL, from one header (with its attribute lines) to the next. */
export function largestMethodBytes(text: string): number {
  const starts = [
    ...text.matchAll(
      /^(?:[ \t]*\[[^\n]*\][ \t]*\r?\n)*[ \t]*(?:local |internal |protected )?(?:procedure|trigger) /gim,
    ),
  ].map((m) => m.index ?? 0);
  starts.push(text.length);
  let max = 0;
  for (let i = 0; i + 1 < starts.length; i += 1) {
    max = Math.max(max, (starts[i + 1] ?? 0) - (starts[i] ?? 0));
  }
  return max;
}

type FileIn = {
  readonly path: string;
  readonly source: string;
  readonly root: ALSyntaxNode;
  readonly specs: readonly MutationSpec[];
};

/** The file's mutants as the batch's compile sees them, its components, and their bound and chain. */
function planOf(file: FileIn, tierOf: TierResolver) {
  const deduped = dedupeSpecs(file.specs, tierOf);
  const ided = assignMutantIds(new Map([[file.path, deduped]])).get(file.path) ?? [];
  let chain = 0;
  let bound = file.source.length;
  for (const c of buildComponents(ided)) {
    chain = Math.max(chain, c.members.length);
    // R827: a free guard copies no text.
    const copied = c.free === true ? 0 : c.root.endIndex - c.root.startIndex;
    bound += c.members.length * (copied + BOUND_BYTES_PER_GUARD);
  }
  return { deduped, ided, chain, bound };
}

/** An upper bound on the file's emitted text, without emitting it: no method is larger than this. */
export function emittedBound(file: FileIn, tierOf: TierResolver): number {
  return planOf(file, tierOf).bound;
}

/** One file's largest emitted method, or `undefined` when its bound says none can reach the figure. */
export function largeMethodOf(file: FileIn, tierOf: TierResolver): LargeMethod | undefined {
  if (file.specs.length === 0) return undefined;
  const { deduped, ided, chain, bound } = planOf(file, tierOf);
  if (bound < LARGE_METHOD_BYTES) return undefined;
  let text: string;
  try {
    text = compileSchemataForFile(file.source, file.root, deduped, ided, file.path);
  } catch {
    return undefined; // the batch's own compile refuses this file by name; a warning adds nothing
  }
  const methodBytes = largestMethodBytes(text);
  return methodBytes >= LARGE_METHOD_BYTES ? { path: file.path, chain, methodBytes } : undefined;
}

/** Every file of these whose emitted text holds a method of `LARGE_METHOD_BYTES` or more, largest first. */
export function largeMethodsOf(
  files: readonly Parameters<typeof largeMethodOf>[0][],
  tierOf: TierResolver,
): LargeMethod[] {
  return files
    .map((f) => largeMethodOf(f, tierOf))
    .filter((m): m is LargeMethod => m !== undefined)
    .sort((a, b) => b.methodBytes - a.methodBytes || a.path.localeCompare(b.path));
}

const named = (large: readonly LargeMethod[]) =>
  large
    .map(
      (f) => `${f.path} (chain ${f.chain}, ${Math.round(f.methodBytes / 1024)} KB in one method)`,
    )
    .join("; ");

/** R826: the warning for these large methods, or `undefined` when there are none. */
export function largeMethodWarning(large: readonly LargeMethod[]): string | undefined {
  if (large.length === 0) return undefined;
  return [
    `[lethal] ${large.length} file(s) emit a very large method: ${named(large)}. A method this size may stop a BC`,
    " service tier with a stack overflow (GitHub #28). That is not proven, and this size is not",
    " measured: it is a warning only. Loops and statements holding a `#if` cause the largest folds (everything",
    " inside one joins its chain). To shrink them, leave out the operators that root them, one",
    " --exclude-operator each: empty-block, negate-conditional, conditional-boundary, negate-guard,",
    " remove-not, loop-skip, loop-truncate, delete-logical-right, delete-logical-left, delete-additive-right,",
    " delete-additive-left. Or narrow the run with --only.",
    " --max-guards-per-batch will not help: it splits by file.",
  ].join("");
}

/** The warning for these files, or `undefined`. */
export function largeFoldWarning(
  files: readonly Parameters<typeof largeMethodOf>[0][],
  tierOf: TierResolver,
): string | undefined {
  return largeMethodWarning(largeMethodsOf(files, tierOf));
}

/**
 * R875: what a quarantine says when a batch that holds a large method stops its tier's runs: the
 * suspect, named as one. `undefined` when the batch holds none of them.
 */
export function largeMethodSuspect(
  large: readonly LargeMethod[],
  batchPaths: readonly string[],
): string | undefined {
  const inBatch = large.filter((m) => batchPaths.includes(m.path));
  if (inBatch.length === 0) return undefined;
  return `if the BC service tier stopped, one suspect (not proven, GitHub #28) is this batch's very large method: ${named(inBatch)}`;
}
