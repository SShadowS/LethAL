/**
 * Sets one roadmap row's status and regenerates ROADMAP.md.
 *
 *   bun scripts/roadmap-set.ts R214 --status "done (abc1234): measured live"
 *
 * Rewrites ONLY the `status:` frontmatter line of `docs/roadmap/R<nnn>.md`, JSON-encoded (a valid
 * YAML double-quoted scalar, the form `roadmap-index.ts` reads back). Refuses when the file or its
 * status line is missing, and refuses a placeholder sha (`done (pending)`, `done (<sha>)`): the placeholder
 * people write before the commit sha exists, and a row closed as `done (pending)` names nothing.
 * Commit first, then set the status with the real sha.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INDEX_FILE,
  ROW_DIR,
  RoadmapFormatError,
  buildIndex,
  parseRowFile,
  rowFileName,
} from "./roadmap-index.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/** `done (pending)`, ``done (`pending`)`` or `done (<sha>)`, any case. Other uses of the word pass. */
const PLACEHOLDER_SHA = /done \((?:pending|`pending`|<sha>)\)/i;

/** Returns `text` with its frontmatter `status:` line replaced. Throws when there is none. */
export function setStatusLine(text: string, status: string, sourceName: string): string {
  if (status.trim() === "") throw new RoadmapFormatError(`${sourceName}: refusing an empty status`);
  if (PLACEHOLDER_SHA.test(status)) {
    throw new RoadmapFormatError(
      `refusing a placeholder sha in ${JSON.stringify(status)}. Commit first, then set the real sha.`,
    );
  }
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
  if (end < 0) throw new RoadmapFormatError(`${sourceName}: no '---' frontmatter block`);
  const lines = text.slice(0, end).split("\n");
  const at = lines.findIndex((l) => l.startsWith("status: "));
  if (at < 0) throw new RoadmapFormatError(`${sourceName}: frontmatter has no 'status:' line`);
  lines[at] = `status: ${JSON.stringify(status)}`;
  const out = `${lines.join("\n")}${text.slice(end)}`;
  // Read it back with the index's own parser: what we wrote must be what it reads.
  const parsed = parseRowFile(out, sourceName);
  if (parsed.status !== status) {
    throw new RoadmapFormatError(`${sourceName}: status did not round-trip`);
  }
  return out;
}

/** Updates one row under `repoRoot` and rewrites the index. Returns the row file's path. */
export function setStatus(repoRoot: string, id: string, status: string): string {
  const m = /^R(\d+)$/.exec(id);
  if (m?.[1] === undefined) throw new RoadmapFormatError(`'${id}' is not an id of the form R<n>`);
  const rel = `${ROW_DIR}/${rowFileName(Number(m[1]))}`;
  const path = join(repoRoot, rel);
  if (!existsSync(path)) throw new RoadmapFormatError(`${rel} does not exist`);
  writeFileSync(path, setStatusLine(readFileSync(path, "utf8"), status, rel));
  writeFileSync(join(repoRoot, INDEX_FILE), buildIndex(repoRoot));
  return rel;
}

if (import.meta.main) {
  const [id, flag, status, ...extra] = process.argv.slice(2);
  if (id === undefined || flag !== "--status" || status === undefined || extra.length > 0) {
    console.error('usage: bun scripts/roadmap-set.ts R<n> --status "<text>"');
    process.exit(2);
  }
  try {
    const rel = setStatus(REPO_ROOT, id, status);
    console.log(`${rel}: status set; ${INDEX_FILE} regenerated`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
