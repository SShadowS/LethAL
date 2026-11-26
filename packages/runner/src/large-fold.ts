import {
  type ALSyntaxNode,
  type MutationSpec,
  isProcedureLike,
  procedureLikeNameNode,
} from "@lethal/engine";
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
  /**
   * R1118 (PR-157): the largest method with each listed root operator this file uses left out, one at a
   * time (same order as `FOLD_ROOT_OPERATORS`), from a real emit each. Absent when it was not computed.
   */
  readonly without?: readonly { readonly operator: string; readonly methodBytes?: number }[];
  /** R1118: the largest method with every listed root operator left out together. */
  readonly allOutBytes?: number;
  /** R1118: true when the all-out re-emit failed (named in the note rather than left out). */
  readonly allOutFailed?: boolean;
}

/**
 * R826/R1118: the operators whose mutants root the largest folds (the warning's list), in its order. The last
 * two are opt-in: a file uses them only when the run named them.
 */
export const FOLD_ROOT_OPERATORS = [
  "empty-block",
  "negate-conditional",
  "conditional-boundary",
  "negate-guard",
  "remove-not",
  "loop-skip",
  "loop-truncate",
  "delete-logical-right",
  "delete-logical-left",
  "delete-additive-right",
  "delete-additive-left",
  "condition-true",
  "blank-argument",
] as const;

const bare = (name: string): string => name.replace(/^lethal\./, "");

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
  if (methodBytes < LARGE_METHOD_BYTES) return undefined;
  // R1118 (PR-157): what each listed operator would save, from a real emit each; only for a file already
  // this large (24 of 986 DC and DO files), so the extra compiles are few.
  const largestWithout = (drop: ReadonlySet<string>): number | undefined => {
    const kept = file.specs.filter((s) => !drop.has(bare(s.operatorName)));
    if (kept.length === 0) return largestMethodBytes(file.source);
    const p = planOf({ ...file, specs: kept }, tierOf);
    try {
      return largestMethodBytes(
        compileSchemataForFile(file.source, file.root, p.deduped, p.ided, file.path),
      );
    } catch {
      return undefined;
    }
  };
  const used = new Set(file.specs.map((s) => bare(s.operatorName)));
  const listed = FOLD_ROOT_OPERATORS.filter((o) => used.has(o));
  // review 2: a re-emit that fails is named (methodBytes absent), never dropped: a missing operator would read
  // as "not used in this file".
  const without = listed.map((operator) => {
    const b = largestWithout(new Set([operator]));
    return b === undefined ? { operator } : { operator, methodBytes: b };
  });
  const allOutBytes = listed.length > 0 ? largestWithout(new Set(listed)) : undefined;
  return {
    path: file.path,
    chain,
    methodBytes,
    ...(without.length > 0 ? { without } : {}),
    ...(allOutBytes !== undefined ? { allOutBytes } : {}),
    ...(listed.length > 0 && allOutBytes === undefined ? { allOutFailed: true } : {}),
  };
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

const kb = (bytes: number): string => `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;

/** R1118 (PR-157): one line per file: the largest method with each listed operator left out, and with all of them. */
function savings(large: readonly LargeMethod[]): string {
  const lines = large.flatMap((f) => {
    if (f.without === undefined && f.allOutBytes === undefined && f.allOutFailed !== true)
      return [];
    const each = (f.without ?? []).map((w) =>
      w.methodBytes === undefined
        ? `without ${w.operator}: the re-emit failed`
        : `without ${w.operator} ${kb(w.methodBytes)}`,
    );
    const all =
      f.allOutBytes !== undefined
        ? [`without all of them together ${kb(f.allOutBytes)}`]
        : f.allOutFailed === true
          ? ["without all of them together: the re-emit failed"]
          : [];
    return [` ${f.path}'s largest method: ${[...each, ...all].join("; ")}.`];
  });
  return lines.length > 0
    ? ` What leaving them out would give (a real emit each):${lines.join("")}`
    : "";
}

/** R826: the warning for these large methods, or `undefined` when there are none. */
export function largeMethodWarning(large: readonly LargeMethod[]): string | undefined {
  if (large.length === 0) return undefined;
  return [
    `[lethal] ${large.length} file(s) emit a very large method: ${named(large)}. A method this size may stop a BC`,
    " service tier with a stack overflow (GitHub #28). That is not proven. One size was measured once: on BC 29 for",
    " Linux a 23.9 MB method's publish was refused (System.OutOfMemoryException) and the tier stayed up (R826). No",
    " other size or build is measured: it is a warning only. Loops and statements holding a `#if` cause the largest",
    " folds (everything inside one joins its chain). To shrink them, leave out the operators that root them, one",
    ` --exclude-operator each: ${FOLD_ROOT_OPERATORS.slice(0, -2).join(", ")}, and the opt-in`,
    ` ${FOLD_ROOT_OPERATORS.slice(-2).join(" and ")} when you named them (with --operator, drop them from its list`,
    " instead: the two flags do not combine). Or narrow the run with --only.",
    savings(large),
    " --lines narrows which mutants run, but a fold inside one procedure shrinks only guard by guard: leaving the",
    " listed operators out together is the lever. Bytes alone were not the limit in R826's ladder: one long chain",
    " passed up to 10 MB on BC 28.4 W1 Linux. What it measured is guards run per call, and a method over",
    ` ${MAX_GUARDS_PER_METHOD.toLocaleString("en-US")} guards is refused on bcdev (${PLATFORM_NOTE}).`,
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
 * R826 (PR-460 ladder, PR-461): the most guards one emitted method may hold on bcdev. A test that runs a
 * method once checks every guard in it, and one call's time grows with those checks: on BC 28.4 W1 Linux
 * one call took 60 s at 2,471 guards, 91 s at 4,811, and was cut at the 300 s request ceiling at 12,507.
 * 4,800 is at the last pass. Measured on BC 28.4 W1 Linux only: not measured on BC 29 or Windows.
 */
export const MAX_GUARDS_PER_METHOD = 4_800;

const PLATFORM_NOTE = "measured on BC 28.4 W1 Linux (R826): not measured on BC 29 or Windows";

export interface MethodGuards {
  readonly path: string;
  readonly method: string;
  /** 1-based line of the method's header in the source. */
  readonly line: number;
  /** The guards in that method: the members of every component it encloses. */
  readonly guards: number;
}

/** PR-461: the plan does not add up, so G cannot be trusted. Never read as G = 0. */
export class MethodGuardsPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MethodGuardsPlanError";
  }
}

/** PR-461: a file's largest method holds more guards than one BC call is measured to bear. */
export class MethodGuardsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MethodGuardsRefusedError";
  }
}

const isMember = (n: ALSyntaxNode): boolean =>
  n.rawKind === "procedure" ||
  n.rawKind === "trigger_declaration" ||
  n.rawKind === "preproc_split_trigger_preamble" ||
  isProcedureLike(n);

const nameOf = (n: ALSyntaxNode): string => {
  const name = n.childForFieldName("name") ?? procedureLikeNameNode(n);
  return name === null ? "(unnamed)" : name.text.replace(/^"|"$/g, "");
};

/**
 * PR-461: the file's method with the most guards, from the generator's plan (the batch compile's
 * components), or `undefined` when the file's deduped count cannot pass `limit` (G is at most that).
 */
export function largestMethodGuards(
  file: FileIn,
  tierOf: TierResolver,
  limit: number = MAX_GUARDS_PER_METHOD,
): MethodGuards | undefined {
  if (dedupeSpecs(file.specs, tierOf).length <= limit) return undefined;
  const { ided } = planOf(file, tierOf);
  return largestOfComponents(file.path, buildComponents(ided), ided.length);
}

/**
 * PR-461: each component's guards (its members) summed per enclosing method; the largest. Throws when
 * a component sits in no method, or when the components' members do not add up to `deployed` (a
 * self-check of this plan: it does not compare with the batch compile). G is never guessed.
 */
export function largestOfComponents(
  path: string,
  components: readonly { readonly root: ALSyntaxNode; readonly members: readonly unknown[] }[],
  deployed: number,
): MethodGuards | undefined {
  // Keyed by the method's start, not the node object: a wrapper is made fresh on each read (FlatNode).
  const per = new Map<number, { node: ALSyntaxNode; guards: number }>();
  let total = 0;
  for (const c of components) {
    let m: ALSyntaxNode | null = c.root;
    while (m !== null && !isMember(m)) m = m.parent;
    if (m === null) {
      throw new MethodGuardsPlanError(
        `${path}: a component at line ${c.root.startPosition.row + 1} sits in no procedure or trigger, so its guards cannot be counted per method (R826)`,
      );
    }
    const at = per.get(m.startIndex);
    per.set(m.startIndex, { node: at?.node ?? m, guards: (at?.guards ?? 0) + c.members.length });
    total += c.members.length;
  }
  if (total !== deployed) {
    throw new MethodGuardsPlanError(
      `${path}: the plan's components hold ${total} guards, but the file deploys ${deployed} (R826)`,
    );
  }
  let best: MethodGuards | undefined;
  for (const { node, guards } of per.values()) {
    if (best !== undefined && guards <= best.guards) continue;
    best = { path, method: nameOf(node), line: node.startPosition.row + 1, guards };
  }
  return best;
}

/** PR-461: the files whose largest method is over `limit`, largest first. */
export function methodsOverGuardLimit(
  files: readonly FileIn[],
  tierOf: TierResolver,
  limit: number = MAX_GUARDS_PER_METHOD,
): MethodGuards[] {
  return files
    .map((f) => largestMethodGuards(f, tierOf, limit))
    .filter((m): m is MethodGuards => m !== undefined && m.guards > limit)
    .sort((a, b) => b.guards - a.guards || a.path.localeCompare(b.path));
}

/** PR-461: the refusal's (and the dry run's note's) text, or `undefined` when no method is over. */
export function methodGuardsRefusal(
  over: readonly MethodGuards[],
  limit: number = MAX_GUARDS_PER_METHOD,
): string | undefined {
  if (over.length === 0) return undefined;
  const n = (x: number) => x.toLocaleString("en-US");
  const list = over
    .map((m) => `${m.path}: ${m.method} (line ${m.line}) holds ${n(m.guards)} guards`)
    .join("; ");
  return [
    `[lethal] ${over.length} file(s) hold a method over ${n(limit)} guards, the most one BC call is measured to bear`,
    ` (${PLATFORM_NOTE}): ${list}. A test that runs such a method checks every guard in one call, and at 12,507`,
    " guards that call was cut at the 300 s request ceiling and the run quarantined. Refused before any publish, on",
    ` bcdev; --allow-large-run does not lift it. To run it, narrow until that method holds ${n(limit)} guards or`,
    " fewer: --lines or --only, or fewer operators with --exclude-operator or --operator. Splitting the file across",
    " batches is not built (R1231).",
  ].join("");
}

/** PR-461: refuses by name when a file's largest method is over `limit`. The caller checks bcdev. */
export function assertMethodGuards(
  files: readonly FileIn[],
  tierOf: TierResolver,
  limit: number = MAX_GUARDS_PER_METHOD,
): void {
  const why = methodGuardsRefusal(methodsOverGuardLimit(files, tierOf, limit), limit);
  if (why !== undefined) throw new MethodGuardsRefusedError(why);
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
