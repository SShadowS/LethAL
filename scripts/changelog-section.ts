#!/usr/bin/env bun
/**
 * Print one version's section from `CHANGELOG.md`, so a GitHub release body is the changelog rather
 * than a second account of the same release written by hand.
 *
 *   bun scripts/changelog-section.ts 0.1.0-alpha.2
 *   bun scripts/changelog-section.ts v0.1.0-alpha.2   # a leading v is stripped
 *
 * REFUSES rather than returning something plausible. A missing section exits non-zero and says so,
 * because the alternative — an empty release body — is a release that silently ships with no notes,
 * and nobody reviewing the tag would notice. `generate_release_notes` in the workflow appends
 * commit subjects UNDER this; those were written for this repository's own record, so they are the
 * supplement, not the substance.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HEADING = /^## \[([^\]]+)\]/;

/** The lines of `changelog` under `## [version]`, up to the next `## [` heading. */
export function sectionFor(changelog: string, version: string): string | null {
  const wanted = version.replace(/^v/, "");
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.exec(l)?.[1] === wanted);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => HEADING.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

if (import.meta.main) {
  const [version, file] = process.argv.slice(2);
  if (version === undefined) {
    throw new Error("usage: bun scripts/changelog-section.ts <version> [changelog.md]");
  }
  const path = file ?? join(import.meta.dir, "..", "CHANGELOG.md");
  const section = sectionFor(readFileSync(path, "utf8"), version);
  if (section === null) {
    const wanted = version.replace(/^v/, "");
    console.error(
      `changelog-section: ${path} has no non-empty "## [${wanted}]" section. Write the release's changelog entry before tagging: a release with no notes is one nobody reviewing the tag would notice was empty.`,
    );
    process.exit(1);
  }
  console.log(section);
}
