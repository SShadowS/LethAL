#!/usr/bin/env bun
/**
 * R662: print the body of one release, the text release.yml's `publish` job starts the release
 * notes with.
 *
 *   bun scripts/release-notes.ts v0.1.0-alpha.4
 *
 * The source is `release-notes/<tag>.md` when that file exists on the tagged commit (talk-cut's
 * `--notes` commits it there), and otherwise the CHANGELOG's own section for the version
 * (`changelog-section.ts`). It REFUSES an empty or thin body (`MIN_BODY_CHARS`), and a body that, with what `publish` adds
 * after it, would not fit GitHub's release-body limit: that `publish` would fail only after the
 * tag is pushed, and a workflow_dispatch trial never runs `publish`, so it cannot see it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionFor } from "./changelog-section.ts";

/** GitHub's limit on a release body, in characters. */
export const RELEASE_BODY_LIMIT = 125_000;
/**
 * What `publish` adds to the body: release.yml's footer (about 1,250 characters with the longer
 * signing sentence, counted 2026-10-22), the control-app line talk-cut appends (about 130), and
 * GitHub's generated commit list (about 5,000, a guess).
 */
export const RELEASE_BODY_MARGIN = 1_500 + 200 + 5_000;

/**
 * A body this short or shorter is refused: it is a placeholder, not release notes. The same floor
 * `changelog-section.test.ts` held the changelog to, which the tag's `build` job runs.
 */
export const MIN_BODY_CHARS = 80;

export class ReleaseNotesRefusedError extends Error {}

export const notesPath = (tag: string) => `release-notes/${tag}.md`;

/** Refuses a body that, with what `publish` adds, would not fit a release body. */
export function checkReleaseBodySize(body: string, source: string): void {
  const total = body.length + RELEASE_BODY_MARGIN;
  if (total > RELEASE_BODY_LIMIT) {
    throw new ReleaseNotesRefusedError(
      `the release body from ${source} would be about ${total} characters (${body.length} + margin ${RELEASE_BODY_MARGIN}), over GitHub's ${RELEASE_BODY_LIMIT} limit`,
    );
  }
}

/**
 * The body for `tag` and where it came from. `read` returns a repo-relative file's text, or null
 * when the file does not exist.
 */
export function releaseNotes(
  tag: string,
  read: (path: string) => string | null,
): { body: string; source: string } {
  const file = notesPath(tag);
  const notes = read(file);
  let body: string;
  let source: string;
  if (notes !== null) {
    body = notes.trim();
    source = file;
    if (body === "") throw new ReleaseNotesRefusedError(`${file} is empty`);
  } else {
    const version = tag.replace(/^v/, "");
    const changelog = read("CHANGELOG.md");
    if (changelog === null) throw new ReleaseNotesRefusedError(`no ${file} and no CHANGELOG.md`);
    const section = sectionFor(changelog, version);
    source = `CHANGELOG.md's [${version}] section`;
    if (section === null) {
      throw new ReleaseNotesRefusedError(
        `no ${file}, and CHANGELOG.md has no non-empty "## [${version}]" section`,
      );
    }
    body = section;
  }
  if (body.length <= MIN_BODY_CHARS) {
    throw new ReleaseNotesRefusedError(
      `the release body from ${source} is ${body.length} characters, not more than ${MIN_BODY_CHARS}: too thin to be release notes`,
    );
  }
  checkReleaseBodySize(body, source);
  return { body, source };
}

if (import.meta.main) {
  const [tag] = process.argv.slice(2);
  if (tag === undefined) throw new Error("usage: bun scripts/release-notes.ts <tag>");
  const root = join(import.meta.dir, "..");
  try {
    const { body } = releaseNotes(tag, (p) => {
      const path = join(root, p);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    });
    console.log(body);
  } catch (e) {
    if (!(e instanceof ReleaseNotesRefusedError)) throw e;
    console.error(`release-notes: ${e.message}`);
    process.exit(1);
  }
}
