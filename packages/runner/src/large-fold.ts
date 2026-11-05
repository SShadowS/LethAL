import type { MutationSpec } from "@lethal/engine";
import { type TierResolver, assignMutantIds, buildComponents, dedupeSpecs } from "@lethal/schemata";

/**
 * R826: when one mutant's statement holds others, they share one guard chain and each branch repeats
 * the statement's text, so one emitted method grows with the square (R827). GitHub #28's 907-guard
 * file stopped a BC service tier with a stack overflow, and a very large method is the lead suspect.
 * That is an inference: no crash has been measured here.
 *
 * So these two figures are NOT measured limits. They were chosen to fire on the outliers of real code:
 * 5 of 171 DO codeunits sampled (2026-11-05), where a chain of 50 fired on 32. It warns, and never refuses.
 */
export const LARGE_FOLD_CHAIN = 100;
export const LARGE_FOLD_BYTES = 512 * 1024;

export interface FoldFigures {
  /** The most mutants in one chain. */
  readonly chain: number;
  /** The largest single chain's emitted text: members x the root's length. An estimate. */
  readonly bytes: number;
}

/** The largest fold in one file's mutants. */
export function foldFiguresOf(
  path: string,
  specs: readonly MutationSpec[],
  tierOf: TierResolver,
): FoldFigures {
  const deduped = dedupeSpecs(specs, tierOf);
  const ided = assignMutantIds(new Map([[path, deduped]])).get(path) ?? [];
  let chain = 0;
  let bytes = 0;
  for (const c of buildComponents(ided)) {
    chain = Math.max(chain, c.members.length);
    bytes = Math.max(bytes, c.members.length * (c.root.endIndex - c.root.startIndex));
  }
  return { chain, bytes };
}

/** R826: the warning for these files, or `undefined` when none is over either figure. */
export function largeFoldWarning(
  files: readonly { readonly path: string; readonly specs: readonly MutationSpec[] }[],
  tierOf: TierResolver,
): string | undefined {
  const large = files
    .map((f) => ({ path: f.path, ...foldFiguresOf(f.path, f.specs, tierOf) }))
    .filter((f) => f.chain >= LARGE_FOLD_CHAIN || f.bytes >= LARGE_FOLD_BYTES)
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  if (large.length === 0) return undefined;
  const named = large
    .map(
      (f) => `${f.path} (chain ${f.chain}, about ${Math.round(f.bytes / 1024)} KB in one method)`,
    )
    .join("; ");
  return [
    `[lethal] ${large.length} file(s) emit a very large method: ${named}. A method this size may stop a BC`,
    " service tier with a stack overflow (GitHub #28). That is not proven, and these thresholds are not",
    " measured: it is a warning only. `lethal.empty-block` causes the largest folds. To shrink them, leave it out",
    " by naming the other operators with --operator, or narrow the run with --only. --max-guards-per-batch will not help: it",
    " splits by file.",
  ].join("");
}
