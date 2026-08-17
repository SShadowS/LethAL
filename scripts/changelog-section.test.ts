import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionFor } from "./changelog-section";

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

  test("the real CHANGELOG has a section for the version being released", () => {
    // The check that actually fires in practice: bump package.json, forget the changelog, and this
    // reddens before a tag is pushed rather than after.
    const root = join(import.meta.dir, "..");
    const version = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    const section = sectionFor(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
    expect(section, `CHANGELOG.md has no entry for ${version}`).not.toBeNull();
    expect((section ?? "").length).toBeGreaterThan(80);
  });
});
