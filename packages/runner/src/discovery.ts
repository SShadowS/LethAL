import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestMethodRef } from "./backend";

const CODEUNIT_HEADER_GLOBAL = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/gi;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/gi;
const TEST_ISOLATION_FUNCTION = /TestIsolation\s*=\s*Function\s*;/i;

/**
 * Per-codeunit segmentation identical to `discoverTests` (split each `.al`
 * file on `codeunit N "Name"` headers, inspect only the section up to the
 * next header), reused here to find `[Test]` codeunits missing
 * `TestIsolation = Function;`. Session-isolation backends (bc-dev-mcp today)
 * activate/deactivate mutants per test method — without per-test isolation,
 * BC reuses one transaction/session across the whole codeunit run and a
 * mutant activated for test N can silently still be active for test N+1.
 */
export async function findMissingTestIsolation(testDir: string): Promise<string[]> {
  const missing: string[] = [];
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = entries.filter((e) => e.toLowerCase().endsWith(".al")).sort();
  for (const rel of alFiles) {
    const source = await readFile(join(testDir, rel), "utf8");
    const codeunitMatches = Array.from(source.matchAll(CODEUNIT_HEADER_GLOBAL));

    for (let i = 0; i < codeunitMatches.length; i++) {
      const headerMatch = codeunitMatches[i];
      if (!headerMatch || headerMatch.index === undefined) continue;

      const codeunitId = Number(headerMatch[1]);
      const codeunitName = headerMatch[3] ?? headerMatch[4] ?? "";

      const sectionStart = headerMatch.index;
      const nextMatch = codeunitMatches[i + 1];
      const sectionEnd = nextMatch?.index ?? source.length;
      const section = source.substring(sectionStart, sectionEnd);

      if (!SUBTYPE_TEST.test(section)) continue;
      if (TEST_ISOLATION_FUNCTION.test(section)) continue;
      missing.push(`${codeunitId} "${codeunitName}" (${rel})`);
    }
  }
  return missing;
}

export async function discoverTests(testDir: string): Promise<TestMethodRef[]> {
  const refs: TestMethodRef[] = [];
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = entries.filter((e) => e.toLowerCase().endsWith(".al")).sort();
  for (const rel of alFiles) {
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
        refs.push({ codeunitId, codeunitName, method: m[2] ?? m[3] ?? "" });
      }
    }
  }
  return refs;
}
