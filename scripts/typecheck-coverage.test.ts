import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R625's guard: every tracked `scripts/**\/*.ts` is either type-checked (listed in
 * `scripts/tsconfig.json` `files`) or excluded BY NAME, with a reason, in
 * `scripts/typecheck-excluded.json`. A new script cannot sit silently outside the build.
 *
 * "Exists" means "git tracks it" (`git ls-files`), the same listing `importable-scripts.test.ts`
 * uses. Paths are repo-relative with forward slashes on both sides.
 */

const REPO_ROOT = join(import.meta.dir, "..");

function trackedScripts(): string[] {
  return execFileSync("git", ["ls-files", "scripts/*.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter((f) => f.length > 0);
}

const tracked = trackedScripts();
const tsconfig = Bun.JSONC.parse(
  readFileSync(join(REPO_ROOT, "scripts/tsconfig.json"), "utf8"),
) as {
  files: string[];
};
const inFiles = new Set(tsconfig.files.map((f) => `scripts/${f}`));
const excludedMap = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts/typecheck-excluded.json"), "utf8"),
) as Record<string, string>;
const excluded = new Set(Object.keys(excludedMap));

describe("R625: every tracked script is type-checked or excluded by name", () => {
  test("the listing is not empty (a floor, so an empty git call cannot pass)", () => {
    expect(tracked.length).toBeGreaterThanOrEqual(200);
    expect(tracked).toContain("scripts/verify.ts");
  });

  test("every tracked script is in `files` or in the excluded list", () => {
    const neither = tracked.filter((f) => !inFiles.has(f) && !excluded.has(f));
    expect(neither).toEqual([]);
  });

  test("no script is in both lists", () => {
    const both = [...inFiles].filter((f) => excluded.has(f));
    expect(both).toEqual([]);
  });

  test("every entry in either list is a tracked script", () => {
    const trackedSet = new Set(tracked);
    const missing = [...inFiles, ...excluded].filter((f) => !trackedSet.has(f));
    expect(missing).toEqual([]);
  });

  test("the root tsconfig.json still references ./scripts (else typecheck skips all of it)", () => {
    const root = Bun.JSONC.parse(readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8")) as {
      references: { path: string }[];
    };
    expect(root.references.map((r) => r.path)).toContain("./scripts");
  });

  test("every excluded entry has a non-empty reason", () => {
    const empty = Object.entries(excludedMap)
      .filter(([, reason]) => typeof reason !== "string" || reason.trim().length === 0)
      .map(([path]) => path);
    expect(empty).toEqual([]);
  });
});
