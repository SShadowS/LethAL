import { describe, expect, test } from "bun:test";
import {
  MIN_BODY_CHARS,
  RELEASE_BODY_LIMIT,
  RELEASE_BODY_MARGIN,
  ReleaseNotesRefusedError,
  checkReleaseBodySize,
  releaseNotes,
} from "./release-notes.ts";

const SECTION = `- ${"a changelog entry long enough to be real release notes. ".repeat(2).trim()}`;
const NOTES = `### Talk\n- ${"a demo build, with notes long enough to count as notes. ".repeat(2).trim()}`;
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n## [1.2.0] — 2026-01-02\n\n${SECTION}\n`;
const EMPTY_SECTION =
  "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] — 2026-01-02\n\n## [1.1.0]\n\nx\n";
const files =
  (m: Record<string, string>) =>
  (p: string): string | null =>
    m[p] ?? null;

describe("release-notes", () => {
  test("release-notes/<tag>.md wins over the changelog section", () => {
    const r = releaseNotes(
      "v1.2.0",
      files({ "CHANGELOG.md": CHANGELOG, "release-notes/v1.2.0.md": `\n${NOTES}\n` }),
    );
    expect(r).toEqual({ body: NOTES, source: "release-notes/v1.2.0.md" });
  });

  test("a notes file carries a release whose changelog section is empty", () => {
    const read = files({ "CHANGELOG.md": EMPTY_SECTION, "release-notes/v1.2.0.md": NOTES });
    expect(releaseNotes("v1.2.0", read).body).toBe(NOTES);
  });

  test("without a notes file, the changelog section is the body", () => {
    expect(releaseNotes("v1.2.0", files({ "CHANGELOG.md": CHANGELOG })).body).toBe(SECTION);
  });

  test("an empty notes file is refused, and does not fall back to the changelog", () => {
    const read = files({ "CHANGELOG.md": CHANGELOG, "release-notes/v1.2.0.md": " \n" });
    expect(() => releaseNotes("v1.2.0", read)).toThrow("release-notes/v1.2.0.md is empty");
  });

  test("an empty changelog section, with no notes file, is refused", () => {
    expect(() => releaseNotes("v1.2.0", files({ "CHANGELOG.md": EMPTY_SECTION }))).toThrow(
      ReleaseNotesRefusedError,
    );
  });

  test("a thin notes file is refused", () => {
    const read = files({ "release-notes/v1.2.0.md": "x".repeat(MIN_BODY_CHARS) });
    expect(() => releaseNotes("v1.2.0", read)).toThrow("too thin");
  });

  test("a thin changelog section is refused", () => {
    const thin = CHANGELOG.replace(SECTION, "- a thing");
    expect(() => releaseNotes("v1.2.0", files({ "CHANGELOG.md": thin }))).toThrow("too thin");
  });

  test("one character over the floor passes", () => {
    const read = files({ "release-notes/v1.2.0.md": "x".repeat(MIN_BODY_CHARS + 1) });
    expect(releaseNotes("v1.2.0", read).body).toHaveLength(MIN_BODY_CHARS + 1);
  });

  test("an oversize notes file is refused", () => {
    const read = files({ "release-notes/v1.2.0.md": "x".repeat(RELEASE_BODY_LIMIT) });
    expect(() => releaseNotes("v1.2.0", read)).toThrow(`over GitHub's ${RELEASE_BODY_LIMIT} limit`);
  });

  test("an oversize changelog section is refused", () => {
    const big = CHANGELOG.replace(SECTION, "x".repeat(RELEASE_BODY_LIMIT));
    expect(() => releaseNotes("v1.2.0", files({ "CHANGELOG.md": big }))).toThrow(
      "CHANGELOG.md's [1.2.0] section",
    );
  });

  test("checkReleaseBodySize: a body that fits passes, one character more is refused", () => {
    const fits = "x".repeat(RELEASE_BODY_LIMIT - RELEASE_BODY_MARGIN);
    expect(() => checkReleaseBodySize(fits, "s")).not.toThrow();
    expect(() => checkReleaseBodySize(`${fits}x`, "s")).toThrow(ReleaseNotesRefusedError);
  });
});
