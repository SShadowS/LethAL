import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { maskAlNonCode } from "@lethal/engine";
import type { TestMethodRef } from "./backend";

const CODEUNIT_HEADER_GLOBAL = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/gi;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/gi;

/**
 * R79: blank out everything the AL compiler does not read as code — comments AND string
 * literals — preserving every offset, so the sectioning regexes below see only code.
 *
 * Without this, PROSE of the shape `codeunit 50100 "Sales Post"` (ordinary AL commenting) opened
 * a bogus codeunit section; the rest of the file fell into it; it had no `Subtype = Test;`; and
 * every `[Test]` from that point on VANISHED. Silently: baseline green, empty `unsupportedTests`,
 * and the mutants those tests covered reported `no-coverage`. Measured on
 * `fixtures/sandbox-data-tests` — 22 `[Test]` in source, 21 discovered.
 *
 * Anchoring the header to line start would have fixed the comment case only; a string literal
 * carries the same shape mid-line. Masking fixes the class, and it fixes the other direction too:
 * a commented-out `Subtype = Test;` no longer promotes a helper codeunit into a test suite.
 *
 * R80: the state machine itself now lives in `@lethal/engine` (`maskAlNonCode`), shared with
 * schemata's `stripAlComments`, which had grown a second copy of it. Discovery keeps the
 * blank-string-contents policy — that is the half this bug turned on — while attribution keeps
 * the other; the flag records the difference instead of two lexers drifting apart.
 */
function maskNonCode(source: string): string {
  return maskAlNonCode(source, { blankStringContents: true });
}

/**
 * R79's second net. Every `[Test]` in a file must land inside some codeunit section, or a test
 * has been dropped by the parse rather than by a rule.
 *
 * The one LEGITIMATE way a discovered count comes out below the file's `[Test]` count is a
 * codeunit whose section carries no `Subtype = Test;` — a helper or handler codeunit, which BC
 * would refuse to run as a test anyway. Those `[Test]`s are still ATTRIBUTED to a section, so
 * they are counted here and the guard stays silent.
 *
 * What it catches is the other shape: a codeunit header `CODEUNIT_HEADER_GLOBAL` failed to match
 * at all, leaving its tests in no section — today that is a silent, total loss of that file's
 * suite, the same direction as the bug this guard was written alongside.
 */
function assertEveryTestAttributed(rel: string, masked: string, sections: readonly string[]): void {
  const countTests = (text: string): number => Array.from(text.matchAll(TEST_METHOD)).length;
  const inFile = countTests(masked);
  const attributed = sections.reduce((sum, section) => sum + countTests(section), 0);
  if (inFile === attributed) return;
  throw new Error(
    `Test discovery lost ${inFile - attributed} of ${inFile} [Test] procedures in "${rel}": they lie outside every codeunit section, so no codeunit id could be attributed to them. That means a codeunit header in this file did not parse. Refusing rather than reporting a smaller suite, which would silently turn the mutants those tests cover into no-coverage.`,
  );
}

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

/**
 * Every `[Test]` one AL SOURCE STRING declares, attributed to its codeunit.
 *
 * Split out of `discoverTests` for R139 check 2, which asks the same question of AL that came back
 * from the SERVER (inside the published app package) rather than off disk. Sharing this function
 * is the point: comparing a local list built by this parser against a remote list built by a second
 * one would report differences that are parser disagreements, and "your published app is missing a
 * test" is the wrong thing to say when the truth is "two regexes disagree".
 */
export function testsInAlSource(rel: string, source: string): TestMethodRef[] {
  const refs: TestMethodRef[] = [];
  // R79: section on CODE only. Prose of the shape `codeunit 50100 "Sales Post"` used to open a
  // bogus section and swallow every [Test] below it, without a word anywhere.
  const masked = maskNonCode(source);

  // Find all codeunit headers in the file
  const codeunitMatches = Array.from(masked.matchAll(CODEUNIT_HEADER_GLOBAL));
  const sections: string[] = [];

  for (let i = 0; i < codeunitMatches.length; i++) {
    const headerMatch = codeunitMatches[i];
    if (!headerMatch || headerMatch.index === undefined) continue;

    const codeunitId = Number(headerMatch[1]);
    const codeunitName = headerMatch[3] ?? headerMatch[4] ?? "";

    // Determine section boundaries: from this header to the next (or end of file)
    const sectionStart = headerMatch.index;
    const nextMatch = codeunitMatches[i + 1];
    const sectionEnd = nextMatch?.index ?? masked.length;

    const section = masked.substring(sectionStart, sectionEnd);
    sections.push(section);

    // Check if this codeunit section has Subtype = Test
    if (!SUBTYPE_TEST.test(section)) continue;

    // Find test methods in this section only
    for (const m of section.matchAll(TEST_METHOD)) {
      refs.push({ codeunitId, codeunitName, method: m[2] ?? m[3] ?? "", file: rel });
    }
  }

  assertEveryTestAttributed(rel, masked, sections);
  return refs;
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
    refs.push(...testsInAlSource(rel, source));
  }
  return refs;
}
