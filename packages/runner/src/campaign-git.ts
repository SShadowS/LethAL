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
 * rather than this module shelling out itself — this module stays pure, fast and deterministic,
 * and is exercised without a real repo at all.
 *
 * **The real runner lives in `assertCampaignPathsCommitted` (`campaign-subcommands.ts`), and a new
 * caller wants THAT, not this.** `assertCommitted` trusts `deps.status(path)` completely: it has
 * no way to check that the answer is even about the path it asked about, and no way to notice the
 * several ways real git answers "nothing to report" for a path it never examined (a missing file,
 * a `.gitignore`d one, a whitespace-only pathspec) — each of which reads here as CLEAN.
 * `assertCampaignPathsCommitted` is what closes those: it proves the path exists and is tracked,
 * pins the pathspec literal, requires git to echo the path back, and treats a non-zero exit as a
 * refusal — and only then calls this function. Wiring a second, weaker `deps.status` is the
 * mistake to avoid; call the existing wiring.
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

/**
 * Thrown when the CALLER (or its `status` dependency) violates this module's contract, as opposed
 * to a path genuinely being uncommitted. Two cases: `assertCommitted([], ...)` — a check that
 * verifies zero paths would otherwise resolve `undefined` without ever calling `deps.status`,
 * which is this project's signature bug (an empty check mistaken for a passing one) sitting inside
 * the module whose entire purpose is closing that class of gap; and `deps.status` resolving a
 * non-string, which a real subprocess-backed implementation (a later task's wiring, across a real
 * process boundary) can do far more easily than this pure module's own callers.
 *
 * Extends `Error` directly, mirroring `LeaseCallerContractError`/`LeaseUnavailableError` in
 * `lease.ts` — NOT a subclass of `UncommittedPathError`, so a caller can `instanceof`-distinguish
 * "you called this wrong" from "a named path is genuinely dirty".
 */
export class CampaignGitContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignGitContractError";
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
 * exists, when one is not; throws `CampaignGitContractError` when the call itself is malformed
 * (`paths` empty, or `deps.status` resolves something other than a string).
 */
export async function assertCommitted(
  paths: readonly string[],
  deps: AssertCommittedDeps,
): Promise<void> {
  // A check asked to verify NOTHING must not be able to report success — see
  // `CampaignGitContractError`'s doc comment. Checked before any `deps.status` call, so an empty
  // array never even looks like it consulted git.
  if (paths.length === 0) {
    throw new CampaignGitContractError(
      "assertCommitted: called with an empty paths array. A caller asking this gate to verify " +
        "nothing is a contract violation, not a vacuous pass — pass at least one path.",
    );
  }

  const checked = await Promise.all(
    paths.map(async (path) => {
      const raw = await deps.status(path);
      if (typeof raw !== "string") {
        throw new CampaignGitContractError(
          `assertCommitted: deps.status("${path}") must resolve a string ("" for clean, the ` +
            `porcelain line otherwise) — got ${typeof raw} (${String(raw)}).`,
        );
      }
      return { path, raw };
    }),
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
