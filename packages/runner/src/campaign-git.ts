/**
 * "Committed before the run" is the spine of the measurement discipline (design spec
 * `2026-08-05-observability-and-campaign-method-design.md` §D), and until this module existed
 * nobody checked it. `campaign-anchors-run.ts`'s own doc comment states the reason this campaign's
 * gate machinery exists at all: *"an operator running them ad hoc against a live billed
 * environment is where 'I printed the results and they looked fine' replaces a gate."* A
 * pre-commitment file that can still be edited after the fact, silently, is exactly that failure —
 * one `git add` away, and nothing before this stopped it.
 *
 * `assertCommitted` makes it mechanical: one status lookup per path, via an INJECTED `deps.status`
 * rather than this module shelling out itself — the real `git status --porcelain -- <path>` runner
 * is a later task's wiring (the CLI subcommands); this module stays pure, fast and deterministic,
 * and is exercised without a real repo at all.
 *
 * The clean/dirty boundary is deliberately narrow and FAILS CLOSED: the only status that passes is
 * the exact-clean answer git itself gives for "no differences against HEAD or the index" — an
 * empty (or all-whitespace) string. Everything else refuses, recognised or not: untracked (`??`),
 * modified-unstaged (` M`), staged (`M `/`A `), a rename (`R  old -> new`), a merge conflict
 * (`UU`), or any status code a future git prints that nobody enumerated here. Checking against a
 * fixed list of "known dirty" codes would fail OPEN the instant git returns one that list didn't
 * anticipate — deciding dirtiness by "is this NOT the clean answer" instead of "does this match a
 * dirty pattern" is what keeps that from happening.
 */

/** The one capability `assertCommitted` needs: given a path, the raw `git status --porcelain`
 *  output for exactly that path — `""` (or whitespace-only) when it is clean. */
export interface AssertCommittedDeps {
  readonly status: (path: string) => Promise<string>;
}

/**
 * Thrown by `assertCommitted`. Extends `Error` directly (CLAUDE.md's typed-error separation rule)
 * — it is not a wrapper around any other error class, just the refusal itself. `paths` carries the
 * offending paths for a caller that wants to act on them programmatically; `.message` is what a
 * human reads.
 */
export class UncommittedPathError extends Error {
  readonly paths: readonly string[];

  constructor(message: string, paths: readonly string[]) {
    super(message);
    this.name = "UncommittedPathError";
    this.paths = paths;
  }
}

/** Why the rule exists, restated in every refusal — a bare "file is dirty" invites the reader to
 *  `git add` and carry on, which is precisely what this check exists to prevent. */
const WHY =
  "A pre-commitment written or edited after the run is not a pre-commitment: it has to be " +
  "committed before the run, never staged or edited after seeing the results.";

/**
 * `??` is the one code worth naming specifically in the message — untracked is, per the brief,
 * "the commonest way to skip the discipline" (write the file, run, commit only after). Every other
 * non-clean status is described generically: this function decides WORDING, never whether to
 * refuse, so an unrecognised code still gets refused by the caller — it just reads "not committed"
 * instead of "untracked".
 */
function describeDirty(path: string, raw: string): string {
  const kind = raw.startsWith("??") ? "untracked" : "not committed";
  return `  - "${path}": ${kind} (git status: ${JSON.stringify(raw)})`;
}

/**
 * Refuses unless every path in `paths` is clean per `deps.status`. Resolves (returns `undefined`)
 * when all are clean; throws `UncommittedPathError`, naming every offending path and why the rule
 * exists, otherwise.
 */
export async function assertCommitted(
  paths: readonly string[],
  deps: AssertCommittedDeps,
): Promise<void> {
  const checked = await Promise.all(
    paths.map(async (path) => ({ path, raw: await deps.status(path) })),
  );
  // Fail CLOSED: dirty is "not the clean answer", never a match against a list of dirty patterns.
  const dirty = checked.filter(({ raw }) => raw.trim().length > 0);
  if (dirty.length === 0) return;

  const lines = dirty.map(({ path, raw }) => describeDirty(path, raw)).join("\n");
  throw new UncommittedPathError(
    `campaign: refusing — ${dirty.length} path(s) not committed:\n${lines}\n\n${WHY} Commit the file(s) above, then re-run.`,
    dirty.map(({ path }) => path),
  );
}
