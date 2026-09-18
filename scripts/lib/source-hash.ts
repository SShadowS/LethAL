/**
 * A content identity for an AL project: what `alc` would read, as one hash.
 *
 * ## Why not the version
 *
 * R56's shape is source changing WITHOUT an `app.json` version bump. The test app was never
 * rebuilt, the server kept running the previous build, and every frozen verdict matched because
 * the old build still worked. Nothing moved, so no verdict comparison could see it.
 *
 * A version comparison is blind to exactly that failure: the server reports `1.0.0.17` and the
 * source claims `1.0.0.17`, and they agree while describing different code. Measured on
 * Cronus285, where `LethAL Sandbox Data Tests` reports its `app.json` version verbatim.
 *
 * Hashing the inputs is not blind to it. The hash moves whenever the source does, bump or no bump,
 * which is the only property that makes "is the server running this source?" an answerable
 * question.
 *
 * ## What goes in
 *
 * Every `.al` file and `app.json`, by RELATIVE PATH and by bytes. Paths are included because
 * deleting one file and adding an identical one elsewhere changes what compiles, and a hash of
 * contents alone would call those two trees the same.
 *
 * `.alpackages` is excluded. Symbols are an input to the compile but not part of what this fixture
 * IS, and including them would move the hash whenever a dependency was re-downloaded. A hash that
 * changes without the source changing is a hash people learn to ignore.
 *
 * `.vscode` is excluded for the same reason: launch settings are not compiled.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Relative, forward-slash paths of everything `alc` reads, sorted. */
export function sourceFiles(project: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".alpackages" || entry.name === ".vscode") continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".al") || entry.name === "app.json") {
        found.push(relative(project, full).split(sep).join("/"));
      }
    }
  };
  walk(project);
  return found.sort();
}

/**
 * The project's content identity.
 *
 * Each entry is hashed as a JSON pair of `[path, sha256-of-bytes]`. JSON rather than a separator
 * character, because any separator is a character some path could contain, and the ambiguity there
 * is the kind that lets two different trees hash alike.
 */
export function sourceHash(project: string): string {
  const h = createHash("sha256");
  for (const rel of sourceFiles(project)) {
    const bytes = readFileSync(join(project, rel));
    const digest = createHash("sha256").update(bytes).digest("hex");
    h.update(JSON.stringify([rel, digest]));
  }
  return `sha256:${h.digest("hex")}`;
}
