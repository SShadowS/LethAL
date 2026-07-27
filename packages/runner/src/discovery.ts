import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestMethodRef } from "./backend";

const CODEUNIT_HEADER_GLOBAL = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/gi;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/gi;

export interface DiscoverOptions {
  /**
   * R45: glob patterns naming which test FILES may contribute tests, matched against the
   * test-dir-relative path with forward slashes. Absent (or empty) means the whole suite.
   *
   * This narrows the BASELINE, which is where a real project's run time goes: measured on
   * Continia Document Output, baseline was 744.8s of a 953.8s run (78%), executing all 1,246
   * discovered tests for a run scoped by `--only` to a single codeunit. `--only` selects mutants,
   * not tests, so it does not touch that phase at all.
   *
   * UNLIKE `--only`, this narrowing can change VERDICTS in the unsafe direction: excluding the
   * test that would have killed a mutant turns that mutant into a survivor, and a false survivor
   * is the worst output this tool produces (R29). It is a deliberate speed/accuracy trade the
   * caller opts into, so it is recorded as a report caveat rather than treated as free.
   */
  readonly only?: readonly string[];
}

/**
 * Which test files a `--tests-only` pattern set admits, with the "matches nothing" refusal.
 *
 * Refusing matters more here than for `--only`: a pattern that silently matched no test file
 * would discover zero tests, and every mutant would then land as `no-coverage` (or, on a
 * coverage-less backend, be scored against nothing at all) — a confident-looking run over an
 * empty suite.
 */
function admittedTestFiles(
  relPaths: readonly string[],
  only: readonly string[],
): ReadonlySet<string> | undefined {
  if (only.length === 0) return undefined;
  const admitted = new Set<string>();
  const unmatched: string[] = [];
  for (const pattern of only) {
    const glob = new Bun.Glob(pattern);
    let matchedAny = false;
    for (const rel of relPaths) {
      if (glob.match(rel.replaceAll("\\", "/"))) {
        admitted.add(rel);
        matchedAny = true;
      }
    }
    if (!matchedAny) unmatched.push(pattern);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `--tests-only matched no test file for ${unmatched.length === 1 ? "pattern" : "patterns"} ${unmatched.map((p) => `"${p}"`).join(", ")}. Patterns are matched against test-dir-relative paths using forward slashes (e.g. "Src/Documents/**"). Refusing rather than running with an empty test suite, which would report every mutant as no-coverage.`,
    );
  }
  return admitted;
}

export async function discoverTests(
  testDir: string,
  options: DiscoverOptions = {},
): Promise<TestMethodRef[]> {
  const refs: TestMethodRef[] = [];
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = entries.filter((e) => e.toLowerCase().endsWith(".al")).sort();
  const admitted = admittedTestFiles(alFiles, options.only ?? []);
  for (const rel of alFiles) {
    if (admitted !== undefined && !admitted.has(rel)) continue;
    const source = await readFile(join(testDir, rel), "utf8");

    // Find all codeunit headers in the file
    const codeunitMatches = Array.from(source.matchAll(CODEUNIT_HEADER_GLOBAL));

    for (let i = 0; i < codeunitMatches.length; i++) {
      const headerMatch = codeunitMatches[i];
      if (!headerMatch || headerMatch.index === undefined) continue;

      const codeunitId = Number(headerMatch[1]);
      const codeunitName = headerMatch[3] ?? headerMatch[4] ?? "";

      // Determine section boundaries: from this header to the next (or end of file)
      const sectionStart = headerMatch.index;
      const nextMatch = codeunitMatches[i + 1];
      const sectionEnd = nextMatch?.index ?? source.length;

      const section = source.substring(sectionStart, sectionEnd);

      // Check if this codeunit section has Subtype = Test
      if (!SUBTYPE_TEST.test(section)) continue;

      // Find test methods in this section only
      for (const m of section.matchAll(TEST_METHOD)) {
        refs.push({ codeunitId, codeunitName, method: m[2] ?? m[3] ?? "", file: rel });
      }
    }
  }
  return refs;
}
