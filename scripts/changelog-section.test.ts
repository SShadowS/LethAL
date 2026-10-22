import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionFor } from "./changelog-section";
import { releaseNotes } from "./release-notes.ts";

/**
 * The release body comes from `CHANGELOG.md`, so an extractor that quietly returns nothing ships a
 * release with no notes — and the tag looks identical either way. These pin the refusals as much as
 * the extraction.
 */
const SAMPLE = `# Changelog

intro prose

## [Unreleased]

## [1.2.0] — 2026-01-02

### Added
- a thing

## [1.1.0] — 2025-12-01

### Fixed
- an older thing
`;

describe("changelog section extraction", () => {
  test("returns the section body, stopping at the next version heading", () => {
    expect(sectionFor(SAMPLE, "1.2.0")).toBe("### Added\n- a thing");
  });

  test("strips a leading v, because the caller usually holds a tag", () => {
    expect(sectionFor(SAMPLE, "v1.2.0")).toBe(sectionFor(SAMPLE, "1.2.0"));
  });

  test("an EMPTY section is null, not an empty string", () => {
    // `## [Unreleased]` with nothing under it is the shape that would otherwise produce a release
    // with a blank body.
    expect(sectionFor(SAMPLE, "Unreleased")).toBeNull();
  });

  test("a missing version is null rather than the nearest match", () => {
    expect(sectionFor(SAMPLE, "9.9.9")).toBeNull();
    expect(sectionFor(SAMPLE, "1.2")).toBeNull();
  });

  test("the real tree has a release body for the version being released", () => {
    // The check that actually fires in practice: bump package.json, forget the notes, and this
    // reddens before a tag is pushed rather than after. R662: it checks the body the release will
    // actually use, `release-notes/v<version>.md` when it exists, else the CHANGELOG section, by
    // the same rules (non-empty, over 80 characters, under the size limit) release.yml applies.
    const root = join(import.meta.dir, "..");
    const version = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    expect(() =>
      releaseNotes(`v${version}`, (p) => {
        const path = join(root, p);
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      }),
    ).not.toThrow();
  });
});
