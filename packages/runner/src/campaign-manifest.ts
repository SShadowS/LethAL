/**
 * A campaign's committed records live wherever a small manifest names them, not wherever a
 * constant compiled into `campaign-freeze.ts` happened to point — see design spec
 * `2026-08-05-observability-and-campaign-method-design.md` §D1: *"`campaign-freeze.ts:37` pins
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
 * The records directory, resolved against the repository root — NEVER against `process.cwd()`.
 *
 * A relative `manifest.recordsDir` resolved against cwd would silently create a records tree
 * wherever the caller happened to be invoked FROM and still report success: a gate that passes
 * while writing its evidence into the void. `import.meta.dir` is this module's own on-disk
 * location, which is fixed by where the file lives in the repo, not by the caller's shell state —
 * so this is correct however `resolveRecordsDir` is invoked (a CLI subcommand, `bun test`, a
 * future caller importing it from elsewhere entirely).
 */
export function resolveRecordsDir(manifest: CampaignManifest): string {
  return join(findRepoRoot(import.meta.dir), manifest.recordsDir);
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
  if (typeof recordsDir !== "string" || recordsDir.length === 0) {
    throw new CampaignManifestError(
      `campaign manifest "${path}": missing or empty "recordsDir" field (got ${JSON.stringify(recordsDir)}). A manifest that silently resolved an empty records directory would write its records tree at the repository root itself.`,
    );
  }
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    throw new CampaignManifestError(
      `campaign manifest "${path}": missing or empty "campaignId" field (got ` +
        `${JSON.stringify(campaignId)}).`,
    );
  }

  return { recordsDir, campaignId };
}
