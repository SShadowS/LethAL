import { describe, expect, test } from "bun:test";
import {
  RELEASE_BODY_LIMIT,
  RELEASE_BODY_MARGIN,
  ReleaseNotesRefusedError,
  checkReleaseBodySize,
  releaseNotes,
} from "./release-notes.ts";

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] — 2026-01-02\n\n- a thing\n";
const files =
  (m: Record<string, string>) =>
  (p: string): string | null =>
    m[p] ?? null;

describe("release-notes", () => {
  test("release-notes/<tag>.md wins over the changelog section", () => {
    const r = releaseNotes(
      "v1.2.0",
      files({ "CHANGELOG.md": CHANGELOG, "release-notes/v1.2.0.md": "\n### Talk\n- demo\n" }),
    );
    expect(r).toEqual({ body: "### Talk\n- demo", source: "release-notes/v1.2.0.md" });
  });

  test("without a notes file, the changelog section is the body", () => {
    expect(releaseNotes("v1.2.0", files({ "CHANGELOG.md": CHANGELOG })).body).toBe("- a thing");
  });

  test("an empty notes file is refused, and does not fall back to the changelog", () => {
    const read = files({ "CHANGELOG.md": CHANGELOG, "release-notes/v1.2.0.md": " \n" });
    expect(() => releaseNotes("v1.2.0", read)).toThrow("release-notes/v1.2.0.md is empty");
  });

  test("an empty changelog section, with no notes file, is refused", () => {
    expect(() => releaseNotes("v1.3.0", files({ "CHANGELOG.md": CHANGELOG }))).toThrow(
      ReleaseNotesRefusedError,
    );
  });

  test("an oversize notes file is refused", () => {
    const read = files({ "release-notes/v1.2.0.md": "x".repeat(RELEASE_BODY_LIMIT) });
    expect(() => releaseNotes("v1.2.0", read)).toThrow(`over GitHub's ${RELEASE_BODY_LIMIT} limit`);
  });

  test("an oversize changelog section is refused", () => {
    const big = CHANGELOG.replace("- a thing", "x".repeat(RELEASE_BODY_LIMIT));
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
