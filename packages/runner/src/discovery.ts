import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestMethodRef } from "./backend";

const CODEUNIT_HEADER = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/i;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/gi;

export async function discoverTests(testDir: string): Promise<TestMethodRef[]> {
  const refs: TestMethodRef[] = [];
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = entries.filter((e) => e.toLowerCase().endsWith(".al")).sort();
  for (const rel of alFiles) {
    const source = await readFile(join(testDir, rel), "utf8");
    const header = CODEUNIT_HEADER.exec(source);
    if (!header || !SUBTYPE_TEST.test(source)) continue;
    const codeunitId = Number(header[1]);
    const codeunitName = header[3] ?? header[4] ?? "";
    for (const m of source.matchAll(TEST_METHOD)) {
      refs.push({ codeunitId, codeunitName, method: m[2] ?? m[3] ?? "" });
    }
  }
  return refs;
}
