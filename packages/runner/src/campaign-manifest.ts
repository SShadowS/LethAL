/**
 * A campaign's committed records live wherever a small manifest names them, not wherever a
 * constant compiled into `campaign-freeze.ts` happened to point — see design spec
 * `2026-08-05-observability-and-campaign-method-design.md` §D1: *"`campaign-freeze.ts` pins
 * `RECORDS_RELATIVE = "docs/campaign/2026-08-03-do"`. The next campaign forks it or edits a
 * constant."* `readCampaignManifest` reads that naming out of a small JSON file instead, and
 * `resolveRecordsDir` resolves it against the repository root exactly the way
 * `campaign-freeze.ts` always has.
 *
 * `findRepoRoot` below is that resolution's load-bearing mechanism, moved here VERBATIM from
 * `campaign-freeze.ts` (which re-exports it, so its existing public surface is unchanged) because
 * this is now the module that owns repo-root-relative path resolution generally, not just for the
 * one campaign `campaign-freeze.ts` was originally written for. `campaign-freeze.ts`'s own
 * `defaultRecordsDir()` is now itself a caller of `resolveRecordsDir` — this campaign's directory
 * name is still a value that has to be written down SOMEWHERE, but it now flows through the exact
 * same function a future campaign's manifest-supplied value does, instead of an independently
 * hardcoded `join`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A campaign's own committed records: where they live (relative to the repository root) and
 *  which campaign they belong to. `campaignId` is not used to derive `recordsDir` — it is the
 *  manifest's own self-identification, carried through for messages that need to name which
 *  campaign a gate is running under. */
export interface CampaignManifest {
  readonly recordsDir: string;
  readonly campaignId: string;
}

/**
 * Thrown when a manifest file can't be read, isn't valid JSON, or is missing/malformed a required
 * field. Extends `Error` directly (CLAUDE.md's typed-error separation rule) — not a subclass of
 * any other local error class. Always names the offending field AND the file: a manifest that
 * silently yielded `recordsDir: ""` would resolve to the repository root itself and write a
 * records tree there and report success — the empty-vs-empty failure this project is named for.
 */
export class CampaignManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignManifestError";
  }
}

/**
 * Walks up from `startDir` looking for `.git` (a directory in an ordinary checkout, a file
 * pointing at `.git/worktrees/<name>` in a worktree — `existsSync` doesn't care which, and
 * finding the WORKTREE's own `.git` is exactly what's wanted here: a campaign's records live IN
 * the worktree, not in the main checkout).
 *
 * Throws rather than falling back to `process.cwd()` or a relative path: a marker that can't be
 * found is a reason to refuse, not a reason to guess and silently write records into whatever
 * directory happened to be current.
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `campaign-manifest: could not locate a repository root walking up from ${startDir} (no .git found). Refusing to guess a records directory — a marker that can't be found is a reason to refuse, not a reason to guess.`,
      );
    }
    dir = parent;
  }
}

/**
 * Is `candidate` (an absolute path) underneath `root`? Segment-boundary check — `rel === ".." ||
 * rel.startsWith(".." + sep)` — NOT a bare string prefix. Fix round 2, Defect 2:
 * `rel.startsWith("..")` alone also matches legitimate names that merely START with the two
 * characters `..` (`"..foo"`, `"..."`), refusing manifests that never leave the repository at
 * all. `path.relative` only ever produces a leading `..` as a full segment (`..`, `../x`,
 * `..\x`) when the path actually climbs above `root`, so anchoring on the segment boundary keeps
 * every real escape refused while no longer punishing a directory name that happens to start with
 * a dot.
 *
 * `strict`: whether `candidate === root` itself counts as "within". The two call sites in
 * `resolveRecordsDir` want opposite answers to that question — the PRIMARY check refuses a
 * `recordsDir` that resolves to the repo root itself (writing records at the top level is its own
 * failure mode, business rule rather than an escape), so it passes `strict: true`; the SYMLINK
 * ancestor check wants root itself to count as contained (reaching the repo root while walking UP
 * looking for an existing ancestor is the ordinary, non-escaping case — most `recordsDir`s name a
 * directory that doesn't exist yet), so it passes `strict: false`.
 */
function isWithin(root: string, candidate: string, strict: boolean): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return !strict;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Walks UP from `p` to the nearest ancestor that actually exists on disk, and returns THAT
 * ancestor's real path (`fs.realpathSync`, which resolves symlinks/junctions — `path.relative`
 * and `path.join` do not; they are purely lexical and never touch the filesystem). `p` itself is
 * typically the records directory `resolveRecordsDir` is about to `mkdir -p`, which usually does
 * NOT exist yet — `realpathSync` on a nonexistent path throws `ENOENT`, so the walk-up is
 * required, not optional. By the time this is called the caller has already normalised `p`
 * lexically (no `..` segments remain — see `resolveRecordsDir`), so the NON-existent tail below
 * the found ancestor is a plain subpath extension that cannot itself introduce a further escape:
 * only an EXISTING symlink/junction somewhere in the ancestor chain can, and resolving that
 * ancestor's real path is exactly what surfaces it.
 */
function realpathOfNearestExisting(p: string): string {
  let dir = p;
  for (;;) {
    if (existsSync(dir)) return realpathSync(dir);
    const parent = dirname(dir);
    if (parent === dir) return dir; // filesystem root; the lexical check above already applies
    dir = parent;
  }
}

/**
 * The records directory, resolved against the repository root — NEVER against `process.cwd()`.
 *
 * A relative `manifest.recordsDir` resolved against cwd would silently create a records tree
 * wherever the caller happened to be invoked FROM and still report success: a gate that passes
 * while writing its evidence into the void. `import.meta.dir` is this module's own on-disk
 * location, which is fixed by where the file lives in the repo, not by the caller's shell state —
 * so this is correct however `resolveRecordsDir` is invoked (a CLI subcommand, `bun test`, a
 * future caller importing it from elsewhere entirely).
 *
 * Two DIFFERENT escapes are checked, because they are caught by different means:
 *
 * 1. LEXICAL: `join()` collapses `..` segments (that is `path.normalize`'s job) rather than
 *    refusing them, so a `recordsDir` with enough of them (`"../../../../etc/evil"`) walks the
 *    joined path OUTSIDE the repository root entirely — silently, and `join()` itself gives no
 *    signal that it happened. Caught by `isWithin` on the plain joined path.
 * 2. SYMLINK/JUNCTION: `join()`/`path.relative` are purely lexical — they never touch the
 *    filesystem, so an EXISTING symlink or junction partway down an otherwise-innocent-looking
 *    `recordsDir` (e.g. `docs/campaign/<link>/leaked`, where `<link>` is a junction pointing
 *    outside the repo) sails through the lexical check untouched. Caught separately by
 *    resolving the nearest EXISTING ancestor's real path (`realpathOfNearestExisting`) and
 *    checking THAT for containment. Fix round 2, Defect 1: an earlier version of this function
 *    claimed the lexical check alone closed the symlink case too — it did not; that claim has
 *    been removed and this second check added.
 *
 * Both are containment checks on a RESOLVED path, never pattern-matching the literal `".."` in
 * the input — a records directory outside the repository is exactly the failure this whole
 * mechanism exists to prevent, one layer up: unreachable by `git worktree remove`'s undo, and
 * outside every git-committed guarantee this campaign gate depends on.
 */
export function resolveRecordsDir(manifest: CampaignManifest): string {
  return resolveRecordsDirIn(findRepoRoot(import.meta.dir), manifest);
}

/**
 * `resolveRecordsDir` with the repository root supplied by the caller instead of derived from this
 * module's own on-disk location — both containment checks are identical, they just anchor on the
 * given `root`.
 *
 * This is not a test seam. `lethal campaign` (cli.ts) MUST resolve against the root of the
 * repository the campaign MANIFEST lives in, which is a different question from "where was this
 * module compiled from" in the two cases that matter: a `bun build --compile` binary, where
 * `import.meta.dir` resolves against Bun's virtual root and `findRepoRoot` would walk to the
 * filesystem root and throw (R50 measured that class of failure for `package.json`), and a
 * checkout driving a campaign whose records live in another repository entirely. The manifest is
 * a real file on disk in the campaign's own repository, so walking up from IT is the resolution
 * that survives both.
 */
export function resolveRecordsDirIn(root: string, manifest: CampaignManifest): string {
  const resolved = join(root, manifest.recordsDir);

  if (!isWithin(root, resolved, true)) {
    throw new CampaignManifestError(
      `campaign manifest: recordsDir "${manifest.recordsDir}" resolves to "${resolved}", which is not inside the repository root "${root}". Refusing rather than silently writing a records tree outside the repository.`,
    );
  }

  const realRoot = realpathSync(root);
  const realAncestor = realpathOfNearestExisting(resolved);
  if (!isWithin(realRoot, realAncestor, false)) {
    throw new CampaignManifestError(
      `campaign manifest: recordsDir "${manifest.recordsDir}" passes through "${realAncestor}" (real path), which is outside the repository root "${realRoot}" even though the lexical path looked contained — a symlink or junction along the way must be redirecting it. Refusing rather than silently writing a records tree outside the repository.`,
    );
  }

  return resolved;
}

/**
 * Reads and validates a campaign manifest off disk. Synchronous — every current and anticipated
 * caller (a CLI subcommand parsing its own args, a test) reads this exactly once before doing
 * anything else, so there is no benefit to an async read here.
 *
 * Throws `CampaignManifestError`, naming the offending field and the file, rather than returning
 * a plausible empty default for a missing field — see that class's doc comment for why.
 */
export function readCampaignManifest(path: string): CampaignManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CampaignManifestError(`campaign manifest: could not read "${path}": ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CampaignManifestError(`campaign manifest "${path}": not valid JSON: ${detail}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CampaignManifestError(
      `campaign manifest "${path}": expected a JSON object with "recordsDir" and "campaignId" ` +
        `fields, got ${JSON.stringify(parsed)}.`,
    );
  }

  const { recordsDir, campaignId } = parsed as Record<string, unknown>;
  // `.trim().length === 0` rather than `.length === 0`: a whitespace-only value ("   ") is not
  // the empty string, so the plain length check let it straight through — a garbage directory
  // named "   " (or, once resolved, one indistinguishable from the repo root after path
  // normalisation eats the whitespace) is the same failure as an empty string, just spelled
  // differently.
  if (typeof recordsDir !== "string" || recordsDir.trim().length === 0) {
    throw new CampaignManifestError(
      `campaign manifest "${path}": missing or empty "recordsDir" field (got ${JSON.stringify(recordsDir)}). A manifest that silently resolved an empty records directory would write its records tree at the repository root itself.`,
    );
  }
  if (typeof campaignId !== "string" || campaignId.trim().length === 0) {
    throw new CampaignManifestError(
      `campaign manifest "${path}": missing or empty "campaignId" field (got ` +
        `${JSON.stringify(campaignId)}).`,
    );
  }

  return { recordsDir, campaignId };
}
