#!/usr/bin/env bun
/**
 * R187: a corpus is identified by its CONTENT, not its path.
 *
 * `U:/Git/do-lethal/Cloud` and `U:/Git/do-rel2/Cloud` are two worktrees of one repository at one
 * commit, so they are byte-identical, and rows cited both as if they were two projects. The near
 * miss that filed R187: a rule calibrated on one was about to be "validated" against the other,
 * which would have returned the same numbers and read as corpus-independence. It is not. On a
 * corpus that genuinely differs the same rule fails its own refutation test.
 *
 * A note saying "these two are the same" would itself rot: they are worktrees on different
 * branches, and diverge the moment either moves. So the identity is COMPUTED and PRINTED by the
 * instruments instead, as the first line of their output, the way the al-runner gate prints the
 * build it ran against. Two runs that print the same fingerprint measured the same corpus, whatever
 * their paths say, and a rule that names a reference corpus names it by this hash.
 *
 * The file filter is the one `r181-effect-grain-retrodiction.ts` parses by: `.al` files, excluding
 * anything under a `.dependencies` directory. It MUST stay identical to that filter, or the
 * fingerprint describes a different corpus than the one measured. Both call `corpusEntries`, so
 * they cannot drift apart.
 *
 *   bun scripts/corpus-fingerprint.ts <corpus-dir>
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The `.al` files an instrument parses, project-relative with forward slashes, sorted. */
export async function corpusEntries(corpusDir: string): Promise<string[]> {
  const all = await readdir(corpusDir, { recursive: true });
  return all
    .filter((f) => f.toLowerCase().endsWith(".al") && !f.includes(".dependencies"))
    .map((f) => f.replaceAll("\\", "/"))
    .sort();
}

export interface CorpusFingerprint {
  /** Number of `.al` files hashed, i.e. the number an instrument on this filter parses. */
  readonly files: number;
  /** SHA-256 over every file's relative path and bytes, in sorted path order. */
  readonly sha256: string;
}

/**
 * Deterministic and path-order-insensitive: the same tree at two paths gives the same hash, and a
 * one-byte change in any parsed file changes it. Paths are hashed as well as contents, so a file
 * moved without change is a different corpus, which is the right answer for an instrument that
 * reports per-file figures.
 */
export async function fingerprintCorpus(corpusDir: string): Promise<CorpusFingerprint> {
  const entries = await corpusEntries(corpusDir);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const rel of entries) {
    hasher.update(`${rel}\n`);
    hasher.update(await readFile(join(corpusDir, rel)));
    hasher.update("\n");
  }
  return { files: entries.length, sha256: hasher.digest("hex") };
}

/** The one-line form every corpus-taking instrument prints first. */
export function describeFingerprint(corpusDir: string, fp: CorpusFingerprint): string {
  return `corpus: ${corpusDir} — ${fp.files} .al file(s), sha256 ${fp.sha256.slice(0, 16)} (R187: identity is this hash, not the path)`;
}

if (import.meta.main) {
  const [corpusDir] = process.argv.slice(2);
  if (corpusDir === undefined) {
    console.error("usage: bun scripts/corpus-fingerprint.ts <corpus-dir>");
    process.exit(2);
  }
  const fp = await fingerprintCorpus(corpusDir);
  console.log(describeFingerprint(corpusDir, fp));
  console.log(`full sha256: ${fp.sha256}`);
}
