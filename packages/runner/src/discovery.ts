import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestMethodRef } from "./backend";

const CODEUNIT_HEADER_GLOBAL = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/gi;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/gi;

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
