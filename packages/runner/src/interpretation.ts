/**
 * A projection's claim about what some piece of a `SessionReport` MEANS, plus the evidence that
 * backs the claim.
 *
 * `basis` adopts both the field name and the rule from `ExecutionContext.basis` (report.ts, the
 * doc comment beginning "How that is known"): "How that is known — measured, inferred from the
 * runner's shape, or (for a carried verdict) named as coming from an earlier run. Never a bare
 * claim." Cited by NAME, not by line: this pointer read `report.ts:194-195` and was correct when
 * written, until a later commit on this same branch added 213 lines above it and moved the target
 * without touching the citation — R113(a)'s exact failure mode, reproduced inside the branch that
 * exists to prevent it. That field carries free-text provenance prose; this one is narrower by
 * construction — a POINTER at
 * evidence (a roadmap id such as `"R29"`, or a file such as `"docs/measurements/README.md"`,
 * optionally with a `#fragment`) — because a pointer, unlike prose, can be mechanically checked
 * to resolve. See `assertBasisResolves`.
 */
export interface Interpretation {
  /** What the data means, in prose a reader acts on. */
  readonly meaning: string;
  /** What this interpretation rules OUT, when that is itself worth stating — e.g. "does not mean
   *  a test executed this line" (see the CoverageAttribution cost this subsystem exists to avoid
   *  paying twice). Optional: not every interpretation has a useful negative to name. */
  readonly entailedNegative?: string;
  /** Points at the evidence for `meaning` — a roadmap id or a file, never a bare claim. Must
   *  resolve; see `assertBasisResolves`. */
  readonly basis: string;
}

/** What `assertBasisResolves` checks a `basis` against: the universe of pointers this run
 *  considers resolvable. Built by the caller (e.g. from `ROADMAP.md`'s `R<n>` ids and a scan of
 *  `docs/measurements/`) — this module has no filesystem access of its own. */
export interface BasisResolutionDeps {
  /** Every roadmap id (e.g. `"R29"`) currently present in `ROADMAP.md`. */
  readonly roadmapIds: ReadonlySet<string>;
  /** Every file path a basis may point at, exactly as it should appear before an optional
   *  `#fragment` — e.g. `"docs/measurements/README.md"`. */
  readonly files: ReadonlySet<string>;
}

/** Thrown by `assertBasisResolves` — a caller-contract violation, not a normal refusal: an
 *  `Interpretation.basis` that is either empty or does not resolve against `deps`. Extends
 *  `Error` directly, never another typed error class (CLAUDE.md's typed-error-classes
 *  convention). */
export class BasisResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BasisResolutionError";
  }
}

/**
 * Asserts that `basis` points at something real: a known roadmap id, or a known file (its
 * `#fragment`, if any, is stripped before the lookup — this check cannot confirm the fragment
 * names a real heading inside the file, only that the file itself resolves).
 *
 * This is deliberately weaker than it sounds. It CANNOT verify SEMANTICS — that the evidence a
 * resolving pointer names actually supports `meaning`. It only kills dangling-pointer rot: a
 * `basis` that names a roadmap id or file which no longer exists. Every new `Interpretation`
 * arrives with evidence that at least still resolves; whether that evidence supports the claim
 * remains a human judgment this function does not and cannot make.
 *
 * An empty basis is refused unconditionally, before either lookup — it is the bare claim
 * `ExecutionContext.basis`'s doc comment forbids, with nothing to check against.
 */
export function assertBasisResolves(basis: string, deps: BasisResolutionDeps): void {
  if (basis.trim().length === 0) {
    throw new BasisResolutionError(
      "Interpretation.basis must not be empty — a bare claim is never acceptable (see " +
        "ExecutionContext.basis's doc comment in report.ts, which this rule adopts): every " +
        'interpretation must point at a roadmap id (e.g. "R29") or a file (e.g. ' +
        '"docs/measurements/README.md") that resolves.',
    );
  }
  if (deps.roadmapIds.has(basis)) return;
  const [filePath] = basis.split("#");
  if (filePath !== undefined && deps.files.has(filePath)) return;
  throw new BasisResolutionError(
    `Interpretation.basis does not resolve: "${basis}" is neither a known roadmap id nor a known file. This checks only that the pointer resolves, not that the evidence it names actually supports the claim.`,
  );
}
